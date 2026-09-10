/**
 * El ciclo de una migración, del archivo a la empresa.
 *
 *     crear → cargar → analizar → mapear → validar → previsualizar
 *           → importar → reconciliar → (revertir)
 *
 * Cada función recibe la transacción y **no la crea**: quien decide el alcance
 * de la transacción es la ruta, porque es la que sabe si esto es un pedido
 * suelto o un paso dentro de algo más grande. Es el mismo criterio que sigue el
 * ciclo de facturación.
 *
 * ## Lo que hace idempotente a una migración
 *
 * `migration_links` guarda, por empresa, la identidad externa de cada registro
 * importado, con un UNIQUE encima. Correr la misma fuente dos veces choca
 * contra esa restricción y la segunda corrida no escribe nada nuevo — la
 * garantía está en la base, no en un `if` que se saltea llamando a otra ruta.
 *
 * ## Lo que hace reversible una migración
 *
 * Esa misma tabla dice qué fila de NEXO nació de qué fila del origen. Sin ella
 * no habría forma de saber cuáles de los trescientos clientes vinieron de acá.
 */

import { recordAudit, withCompany, type Tx } from '@aai/db';
import {
  comoTermina,
  normalizarFila,
  puedeTransicionar,
  reconciliar,
  registroPorDefecto,
  validar,
  type Conteo,
  type Entidad,
  type Estado,
  type Hallazgo,
  type RegistroCanonico,
  type TablaCruda,
} from '@aai/migration-engine';
import { sha256 } from '@aai/document-engine';
import { conflict, notFound, unprocessable } from '../http/errors.js';
import { escritorDe, MOTIVO_SIN_ESCRITOR, ORDEN_DE_IMPORTACION } from './escritores.js';
import {
  agrupar,
  correrTanda,
  ordenarCuentas,
  ordenarTablas,
  planificarTandas,
  seCancelo,
  type ConteoPorEntidad,
  type FilaParaImportar,
  type Grupo,
} from './importador.js';

const REGISTRO = registroPorDefecto();

export interface Migracion {
  readonly id: string;
  readonly estado: Estado;
  readonly adaptador: string;
  readonly titulo: string;
}

async function leerMigracion(tx: Tx, id: string): Promise<Migracion> {
  const { rows } = await tx.query<Migracion>(
    'SELECT id, estado, adaptador, titulo FROM migrations WHERE id = $1',
    [id],
  );
  const m = rows[0];
  if (m === undefined) throw notFound('La migración no existe');
  return m;
}

/**
 * Mueve la migración de estado, o explica por qué no se puede.
 *
 * El CHECK de la base impide guardar un estado inventado; esta función impide
 * un salto inválido entre dos estados que existen. Son dos preguntas distintas
 * y hacen falta las dos.
 */
async function transicionar(tx: Tx, id: string, desde: Estado, hasta: Estado): Promise<void> {
  if (!puedeTransicionar(desde, hasta)) {
    throw conflict(
      `Una migración en ${desde} no puede pasar a ${hasta}. ` +
        'Los pasos van en orden porque importar sin validar deja la empresa a medio cargar.',
    );
  }

  // El estado y su fecha se escriben **en la misma sentencia**.
  //
  // La 0111 exige con un CHECK que una migración terminada diga cuándo terminó.
  // Un CHECK se evalúa al cerrar cada sentencia, no al cerrar la transacción:
  // poner el estado en un `UPDATE` y la fecha en el siguiente aborta el primero.
  // Fechar acá y no en cada llamador es además lo que impide que un estado
  // nuevo se mueva sin su fecha.
  const columna = SELLO[hasta];
  await tx.query(
    columna === undefined
      ? 'UPDATE migrations SET estado = $2 WHERE id = $1'
      : // El nombre de columna sale del mapa literal de abajo, nunca de un dato.
        `UPDATE migrations SET estado = $2, ${columna} = now() WHERE id = $1`,
    [id, hasta],
  );
}

/** Qué fecha exige cada estado terminal. Los que no están acá no llevan. */
const SELLO: Readonly<Partial<Record<Estado, string>>> = {
  COMPLETADA: 'importada_el',
  COMPLETADA_CON_ADVERTENCIAS: 'importada_el',
  REVERTIDA: 'revertida_el',
  CANCELADA: 'cancelada_el',
};

// ---------------------------------------------------------------------------
// Crear y cargar
// ---------------------------------------------------------------------------

export async function crearMigracion(
  tx: Tx,
  companyId: string,
  actor: string,
  datos: {
    readonly adaptador: string;
    readonly titulo: string;
    readonly fechaCorte?: string | null;
    readonly estrategia?: string;
  },
): Promise<string> {
  const adaptador = REGISTRO.obtener(datos.adaptador);
  if (adaptador === null) throw notFound(`No hay un adaptador con el código ${datos.adaptador}`);
  if (adaptador.descripcion.estado !== 'IMPLEMENTADO') {
    // Código propio y no el genérico: la consola distingue «este adaptador
    // todavía no trae datos» de cualquier otro 422 y muestra qué le falta.
    throw unprocessable(
      'ADAPTADOR_NO_IMPLEMENTADO',
      `El adaptador ${datos.adaptador} está en estado ${adaptador.descripcion.estado} y no ` +
        `puede traer datos. ${adaptador.descripcion.queFalta ?? ''}`.trim(),
    );
  }

  const { rows } = await tx.query<{ id: string }>(
    `INSERT INTO migrations (company_id, adaptador, titulo, fecha_corte, estrategia, creada_por)
     VALUES ($1, $2, $3, $4, coalesce($5, 'HISTORICO_COMPLETO'), $6)
     RETURNING id`,
    [companyId, datos.adaptador, datos.titulo, datos.fechaCorte ?? null, datos.estrategia ?? null, actor],
  );
  const id = rows[0]!.id;

  await recordAudit(tx, companyId, {
    actorType: 'USER',
    actorId: actor,
    action: 'CREAR_MIGRACION',
    objectType: 'migration',
    objectId: id,
    newValue: { adaptador: datos.adaptador, titulo: datos.titulo, estrategia: datos.estrategia },
  });
  return id;
}

/**
 * Carga el origen y guarda las filas crudas.
 *
 * Guarda **todo lo que vino**, incluidas las tablas que después nadie va a
 * importar. Es lo que permite volver sobre el archivo sin pedirlo de nuevo, y
 * lo que hace que la respuesta a «¿de dónde salió este dato?» no dependa de que
 * alguien conserve el archivo original.
 */
export async function cargarOrigen(
  tx: Tx,
  companyId: string,
  actor: string,
  migrationId: string,
  archivo: { readonly nombre: string; readonly bytes: Buffer },
): Promise<{ readonly tablas: number; readonly filas: number; readonly avisos: readonly string[] }> {
  const m = await leerMigracion(tx, migrationId);
  const adaptador = REGISTRO.obtener(m.adaptador);
  if (adaptador === null) throw notFound(`El adaptador ${m.adaptador} ya no existe`);

  // Un archivo por migración, y no se reemplaza.
  //
  // La versión anterior borraba lo cargado antes para dejar subir otro archivo.
  // Eso arrastraba por cascada las filas crudas, que es justamente lo que la
  // 0111 protege: si la aplicación puede hacerlas desaparecer, dejan de ser
  // prueba de lo que el sistema anterior tenía. Una migración nueva no cuesta
  // nada; una fila cruda perdida no se recupera.
  const { rows: yaCargadas } = await tx.query<{ n: string }>(
    'SELECT count(*)::text n FROM migration_tables WHERE migration_id = $1',
    [migrationId],
  );
  if (yaCargadas[0]!.n !== '0') {
    throw conflict(
      'Esta migración ya tiene un archivo cargado y no se reemplaza. Si el archivo no era el ' +
        'que querías, empezá una migración nueva: lo que ya se cargó queda como estaba, sin ' +
        'importar, y sirve de constancia de lo que el sistema anterior devolvió.',
    );
  }

  const extraccion = await adaptador.extraer({
    bytes: archivo.bytes,
    nombreArchivo: archivo.nombre,
  });

  let filasTotales = 0;
  for (const tabla of extraccion.tablas) {
    const entidad = adaptador.entidadSugerida?.(tabla) ?? null;
    const mapeo = adaptador.mapeoSugerido?.(tabla) ?? {};

    const { rows } = await tx.query<{ id: string }>(
      `INSERT INTO migration_tables
         (company_id, migration_id, nombre, columnas, entidad, mapeo, filas)
       VALUES ($1, $2, $3, $4::jsonb, $5, $6::jsonb, $7)
       RETURNING id`,
      [
        companyId, migrationId, tabla.nombre,
        JSON.stringify(tabla.columnas), entidad, JSON.stringify(mapeo), tabla.filas.length,
      ],
    );
    await insertarFilas(tx, companyId, migrationId, rows[0]!.id, tabla);
    filasTotales += tabla.filas.length;
  }

  await tx.query(
    `UPDATE migrations
        SET archivo_nombre = $2, archivo_hash = $3, archivo_bytes = $4
      WHERE id = $1`,
    [migrationId, archivo.nombre, sha256(archivo.bytes), archivo.bytes.length],
  );

  // Solo de CREADA a CARGADA. Una migración que ya cargó no vuelve a cargar:
  // lo corta el guard de arriba, y el autómata tampoco lo admite.
  await transicionar(tx, migrationId, m.estado, 'CARGADA');

  // El momento en que un archivo ajeno entra a la empresa, en la cadena. La
  // fila de `migrations` dice cuál es el archivo; esto dice qué pasó y cuándo,
  // y no se puede editar sin romper el encadenado por hash.
  await recordAudit(tx, companyId, {
    actorType: 'USER',
    actorId: actor,
    action: 'CARGAR_ORIGEN',
    objectType: 'migration',
    objectId: migrationId,
    newValue: {
      archivo: archivo.nombre,
      hash: sha256(archivo.bytes),
      bytes: archivo.bytes.length,
      tablas: extraccion.tablas.length,
      filas: filasTotales,
    },
  });
  return { tablas: extraccion.tablas.length, filas: filasTotales, avisos: extraccion.avisos };
}

/** Las filas van de a tandas: un INSERT por fila con 50.000 filas no termina nunca. */
const TANDA = 500;

async function insertarFilas(
  tx: Tx,
  companyId: string,
  migrationId: string,
  tableId: string,
  tabla: TablaCruda,
): Promise<void> {
  for (let desde = 0; desde < tabla.filas.length; desde += TANDA) {
    const tanda = tabla.filas.slice(desde, desde + TANDA);
    const valores: unknown[] = [];
    const marcas: string[] = [];

    for (const [i, fila] of tanda.entries()) {
      const base = valores.length;
      const crudo = JSON.stringify(fila);
      marcas.push(
        `($${base + 1}, $${base + 2}, $${base + 3}, $${base + 4}, $${base + 5}::jsonb, $${base + 6})`,
      );
      valores.push(companyId, migrationId, tableId, desde + i + 1, crudo, sha256(Buffer.from(crudo)));
    }

    await tx.query(
      `INSERT INTO migration_rows (company_id, migration_id, table_id, numero, crudo, hash)
       VALUES ${marcas.join(', ')}`,
      valores,
    );
  }
}

// ---------------------------------------------------------------------------
// Mapear y validar
// ---------------------------------------------------------------------------

export async function declararMapeo(
  tx: Tx,
  companyId: string,
  actor: string,
  migrationId: string,
  tablas: readonly {
    readonly id: string;
    readonly entidad: Entidad | null;
    readonly mapeo: Readonly<Record<string, string>>;
    readonly incluida: boolean;
  }[],
): Promise<void> {
  const m = await leerMigracion(tx, migrationId);

  for (const t of tablas) {
    const { rowCount } = await tx.query(
      `UPDATE migration_tables
          SET entidad = $3, mapeo = $4::jsonb, incluida = $5
        WHERE id = $2 AND migration_id = $1`,
      [migrationId, t.id, t.entidad, JSON.stringify(t.mapeo), t.incluida],
    );
    if (rowCount === 0) throw notFound(`La tabla ${t.id} no pertenece a esta migración`);
  }

  await transicionar(tx, migrationId, m.estado, 'MAPEADA');
  await recordAudit(tx, companyId, {
    actorType: 'USER',
    actorId: actor,
    action: 'MAPEAR_MIGRACION',
    objectType: 'migration',
    objectId: migrationId,
    newValue: { tablas: tablas.map((t) => ({ id: t.id, entidad: t.entidad, incluida: t.incluida })) },
  });
}

interface FilaCruda {
  readonly id: string;
  readonly numero: number;
  readonly crudo: string[];
  readonly table_id: string;
}

interface TablaMapeada {
  readonly id: string;
  readonly nombre: string;
  readonly columnas: string[];
  readonly entidad: Entidad | null;
  readonly mapeo: Record<string, string>;
  readonly incluida: boolean;
}

async function tablasDe(tx: Tx, migrationId: string): Promise<readonly TablaMapeada[]> {
  const { rows } = await tx.query<TablaMapeada>(
    `SELECT id, nombre, columnas, entidad, mapeo, incluida
       FROM migration_tables WHERE migration_id = $1 ORDER BY nombre`,
    [migrationId],
  );
  return rows;
}

/** Arma los registros canónicos de una tabla, leyendo las filas crudas. */
async function registrosDe(
  tx: Tx,
  migrationId: string,
  tabla: TablaMapeada,
  archivo: string,
): Promise<readonly { readonly rowId: string; readonly registro: RegistroCanonico }[]> {
  if (tabla.entidad === null || !tabla.incluida) return [];

  const { rows } = await tx.query<FilaCruda>(
    `SELECT id, numero, crudo, table_id FROM migration_rows
      WHERE migration_id = $1 AND table_id = $2 ORDER BY numero`,
    [migrationId, tabla.id],
  );

  return rows.map((f) => {
    const campos = normalizarFila(tabla.columnas, f.crudo, tabla.mapeo);
    const idExterno = campos.codigoExterno?.valor;
    return {
      rowId: f.id,
      registro: {
        entidad: tabla.entidad!,
        procedencia: {
          origen: `${archivo}:${tabla.nombre}`,
          fila: String(f.numero),
          idExterno: idExterno === null || idExterno === undefined ? null : String(idExterno),
          hash: '',
        },
        campos,
      },
    };
  });
}

export interface ResultadoDeValidacion {
  readonly errores: number;
  readonly advertencias: number;
  readonly informativos: number;
  readonly sePuedeImportar: boolean;
  readonly sinEscritor: readonly { readonly entidad: Entidad; readonly motivo: string }[];
}

export async function validarMigracion(
  tx: Tx,
  companyId: string,
  actor: string,
  migrationId: string,
): Promise<ResultadoDeValidacion> {
  const m = await leerMigracion(tx, migrationId);
  const tablas = await tablasDe(tx, migrationId);
  const archivo = await nombreDeArchivo(tx, migrationId);

  await tx.query('DELETE FROM migration_findings WHERE migration_id = $1', [migrationId]);

  let errores = 0;
  let advertencias = 0;
  let informativos = 0;

  for (const tabla of tablas) {
    const registros = await registrosDe(tx, migrationId, tabla, archivo);
    if (registros.length === 0) continue;

    const veredicto = validar(registros.map((r) => r.registro));
    errores += veredicto.errores;
    advertencias += veredicto.advertencias;
    informativos += veredicto.informativos;

    await guardarHallazgos(tx, companyId, migrationId, tabla.id, registros, veredicto.hallazgos);
  }

  await transicionar(tx, migrationId, m.estado, 'VALIDADA');
  if (errores === 0) await transicionar(tx, migrationId, 'VALIDADA', 'LISTA');

  await recordAudit(tx, companyId, {
    actorType: 'USER',
    actorId: actor,
    action: 'VALIDAR_MIGRACION',
    objectType: 'migration',
    objectId: migrationId,
    newValue: { errores, advertencias, informativos },
  });

  // Las entidades mapeadas que el importador todavía no sabe escribir. Se
  // informan acá y no al importar: enterarse en la vista previa deja cambiar el
  // mapeo; enterarse después de confirmar, no.
  const sinEscritor = [...new Set(tablas.filter((t) => t.incluida && t.entidad !== null).map((t) => t.entidad!))]
    .filter((e) => escritorDe(e) === null)
    .map((e) => ({ entidad: e, motivo: MOTIVO_SIN_ESCRITOR[e] ?? 'Todavía no tiene escritor.' }));

  return { errores, advertencias, informativos, sePuedeImportar: errores === 0, sinEscritor };
}

async function guardarHallazgos(
  tx: Tx,
  companyId: string,
  migrationId: string,
  tableId: string,
  registros: readonly { readonly rowId: string; readonly registro: RegistroCanonico }[],
  hallazgos: readonly Hallazgo[],
): Promise<void> {
  const porFila = new Map(registros.map((r) => [r.registro.procedencia.fila, r.rowId]));

  // Todo en tandas y no fila por fila.
  //
  // La versión anterior hacía un `INSERT` por hallazgo y un `UPDATE` por fila.
  // Medido: validar 5.000 terceros tardaba **once segundos**, y no por la
  // validación —que es aritmética en memoria— sino por diez mil viajes de ida y
  // vuelta a la base. Con las mismas sentencias agrupadas de a quinientas,
  // tarda menos de uno. No cambia ninguna garantía: es la misma escritura.
  await enTandas(hallazgos, 500, async (grupo) => {
    const valores: unknown[] = [];
    const marcas: string[] = [];
    for (const h of grupo) {
      const base = valores.length;
      marcas.push(
        `($${base + 1}, $${base + 2}, $${base + 3}, $${base + 4}, $${base + 5}, ` +
          `$${base + 6}, $${base + 7}, $${base + 8})`,
      );
      valores.push(
        companyId,
        migrationId,
        porFila.get(h.fila) ?? null,
        h.nivel,
        h.codigo,
        h.mensaje,
        h.campo ?? null,
        h.fila,
      );
    }
    await tx.query(
      `INSERT INTO migration_findings
         (company_id, migration_id, row_id, nivel, codigo, mensaje, campo, fila)
       VALUES ${marcas.join(', ')}`,
      valores,
    );
  });

  // El estado de cada fila sale de sus hallazgos: con un error se rechaza, con
  // una advertencia entra marcada, y sin nada es válida.
  const conError = new Set(hallazgos.filter((h) => h.nivel === 'ERROR').map((h) => h.fila));
  const conAviso = new Set(hallazgos.filter((h) => h.nivel === 'ADVERTENCIA').map((h) => h.fila));

  const cambios = registros.map(({ rowId, registro }) => {
    const fila = registro.procedencia.fila;
    return {
      rowId,
      estado: conError.has(fila) ? 'RECHAZADA' : conAviso.has(fila) ? 'CON_ADVERTENCIA' : 'VALIDA',
      normalizado: JSON.stringify(registro.campos),
    };
  });

  await enTandas(cambios, 500, async (grupo) => {
    // `unnest` de tres arreglos paralelos: una sola sentencia actualiza todo el
    // grupo, y los valores siguen viajando como parámetros.
    await tx.query(
      `UPDATE migration_rows r
          SET estado = d.estado, normalizado = d.normalizado::jsonb
         FROM (SELECT unnest($1::uuid[]) AS id,
                      unnest($2::text[]) AS estado,
                      unnest($3::text[]) AS normalizado) d
        WHERE r.id = d.id AND r.table_id = $4`,
      [
        grupo.map((c) => c.rowId),
        grupo.map((c) => c.estado),
        grupo.map((c) => c.normalizado),
        tableId,
      ],
    );
  });
}

/** Recorre una lista de a `tamano` elementos. Vacía, no hace nada. */
async function enTandas<T>(
  lista: readonly T[],
  tamano: number,
  fn: (grupo: readonly T[]) => Promise<void>,
): Promise<void> {
  for (let i = 0; i < lista.length; i += tamano) {
    await fn(lista.slice(i, i + tamano));
  }
}

const nombreDeArchivo = async (tx: Tx, migrationId: string): Promise<string> => {
  const { rows } = await tx.query<{ archivo_nombre: string | null }>(
    'SELECT archivo_nombre FROM migrations WHERE id = $1',
    [migrationId],
  );
  return rows[0]?.archivo_nombre ?? 'origen';
};

const contar = async (tx: Tx, migrationId: string, nivel: string): Promise<number> => {
  const { rows } = await tx.query<{ n: string }>(
    'SELECT count(*)::text n FROM migration_findings WHERE migration_id = $1 AND nivel = $2',
    [migrationId, nivel],
  );
  return Number(rows[0]?.n ?? '0');
};

// ---------------------------------------------------------------------------
// Importar
// ---------------------------------------------------------------------------

export interface Progreso {
  readonly total: number;
  readonly procesadas: number;
  readonly tandas: number;
  readonly tandasCompletadas: number;
}

export interface ResultadoDeImportacion {
  readonly estado: Estado;
  readonly conteos: readonly Conteo[];
  readonly cierra: boolean;
  readonly cancelada: boolean;
  readonly progreso: Progreso;
}

/**
 * Escribe en la empresa, por tandas.
 *
 * ## Por qué esta función abre sus propias transacciones
 *
 * Es la única del módulo que lo hace, y va contra la costumbre del repositorio
 * —«quien decide el alcance de la transacción es la ruta»— por un motivo que no
 * es de estilo: **una tanda que no se confirma no es un punto de control**. Si
 * las cincuenta tandas de una importación corrieran dentro de una transacción
 * de la ruta, al cortarse no quedaría escrita ninguna y no habría nada que
 * reanudar ni progreso que mostrar mientras corre.
 *
 * La contrapartida, dicha sin disimulo: **una importación cortada a la mitad
 * deja la mitad escrita**. Lo escrito está identificado en `migration_links`,
 * así que se puede reanudar —lo que falta— o revertir —lo que entró—. Es la
 * elección entre «todo o nada, sin saber cuánto faltaba» y «lo que entró, dicho».
 *
 * ## Reanudar es volver a llamarla
 *
 * No hay una función aparte. Las tandas ya completadas se saltean por su punto
 * de control, y las filas que igual se repitieran chocarían contra el `UNIQUE`
 * de `migration_links`. Dos candados para lo mismo, como en el resto de NEXO.
 */
export async function importar(
  companyId: string,
  actor: string,
  migrationId: string,
  opciones: { readonly topeDeTandas?: number } = {},
): Promise<ResultadoDeImportacion> {
  const contexto = { companyId, actorId: actor };

  // ── Fase 0 · el candado ───────────────────────────────────────────────
  //
  // Sin él, dos corridas simultáneas de la misma migración planifican las dos,
  // ven las mismas tandas y las corren las dos. Los datos no se duplican —los
  // frena el `UNIQUE` de `migration_links`— pero la segunda muere con un 23505
  // que aborta su tanda y le devuelve al usuario un error sobre la máquina de
  // estados que no describe lo que pasó.
  const plan = await withCompany(contexto, async (tx) => {
    await tomarElCandado(tx, migrationId);

    const m = await leerMigracion(tx, migrationId);

    // Pedir importar algo que ya terminó no es un error del sistema de estados:
    // es alguien que apretó dos veces, o que volvió a una pestaña vieja. Se lo
    // dice con esas palabras. Antes contestaba «una migración en COMPLETADA no
    // puede pasar a IMPORTANDO», que describe la máquina y no la situación.
    if (YA_TERMINO.has(m.estado)) {
      await soltarElCandado(tx, migrationId);
      throw conflict(
        `Esta migración ya terminó en ${m.estado} y no se vuelve a importar. Si querés traer los ` +
          'datos otra vez, empezá una migración nueva: la anterior queda como está, con su ' +
          'reporte y su reversión.',
      );
    }

    // ── Fase 1 · el plan ────────────────────────────────────────────────
    //
    // Se escribe entero antes de importar nada: es lo que permite decir «12.400
    // de 50.000» desde la primera tanda en vez de descubrir el total al final.
    if (m.estado !== 'IMPORTANDO' && m.estado !== 'CANCELACION_PEDIDA') {
      await transicionar(tx, migrationId, m.estado, 'IMPORTANDO');
    }
    return planificar(tx, companyId, migrationId);
  });

  // ── Fase 2 · las tandas ───────────────────────────────────────────────
  const conteos = new Map<Entidad, ConteoPorEntidad>();
  let cancelada = false;
  let corridas = 0;
  const tope = opciones.topeDeTandas ?? Number.POSITIVE_INFINITY;

  try {
  for (const tanda of plan.pendientes) {
    if (corridas >= tope) break;

    // El fallo de una tanda se registra **en otra transacción**.
    //
    // Antes no se registraba en ninguna: el `UPDATE` que ponía la tanda en
    // FALLIDA con su motivo vivía dentro de la misma transacción que se estaba
    // abortando, así que se iba con ella. Medido sobre 750 tandas reales:
    // ninguna con error guardado, ninguna con más de un intento, y el estado
    // FALLIDA —con su CHECK que exige motivo— no lo podía escribir nadie.
    //
    // Ahora una tanda que falla deja dicho qué le pasó y cuántas veces se
    // intentó, que es lo único que convierte «la migración se cortó» en algo
    // que alguien puede diagnosticar.
    let paso: ConteoPorEntidad | null;
    try {
      paso = await withCompany(contexto, async (tx) => {
        if (await seCancelo(tx, migrationId)) return null;
        const grupos = await gruposDeLaTanda(tx, migrationId, tanda);
        return correrTanda(tx, {
          companyId,
          actor,
          migracionId: migrationId,
          sistema: plan.adaptador,
          fechaCorte: plan.fechaCorte,
          batchId: tanda.id,
          entidad: tanda.entidad,
          grupos,
        });
      });
    } catch (error) {
      await withCompany(contexto, (tx) => anotarTandaFallida(tx, tanda.id, error));
      throw error;
    }

    if (paso === null) {
      cancelada = true;
      break;
    }
    acumular(conteos, paso);
    corridas += 1;
  }
  } catch (error) {
    // El candado se suelta aunque la corrida se caiga. Si no, la migración
    // queda trabada hasta que venza el plazo, y el plazo existe para el caso
    // en que el proceso se muere entero — no para un error que sí se pudo ver.
    await withCompany(contexto, (tx) => soltarElCandado(tx, migrationId));
    throw error;
  }

  // ── Fase 3 · el cierre ────────────────────────────────────────────────
  return withCompany(contexto, async (tx) => {
    await soltarElCandado(tx, migrationId);
    const restantes = await tandasPendientes(tx, migrationId);
    const progreso = await leerProgreso(tx, migrationId);

    let estado: Estado;
    if (cancelada) {
      await transicionar(tx, migrationId, 'CANCELACION_PEDIDA', 'CANCELADA');
      estado = 'CANCELADA';
    } else if (restantes.length > 0) {
      // Quedaron tandas: la migración sigue IMPORTANDO y se reanuda llamando
      // de nuevo. No es un fallo y no se dice que lo sea.
      estado = 'IMPORTANDO';
    } else {
      const advertencias = await contar(tx, migrationId, 'ADVERTENCIA');
      estado = comoTermina(advertencias);
      await transicionar(tx, migrationId, 'IMPORTANDO', estado);
    }

    const lista = [...conteos.values()].map(
      (c): Conteo => ({
        entidad: c.entidad,
        enOrigen: c.enOrigen,
        importados: c.importados,
        yaEstaban: c.yaEstaban,
        // Las omitidas se cuentan aparte de las rechazadas y la reconciliación
        // necesita que todo cierre, así que van sumadas para el cuadre.
        rechazados: c.rechazados + c.omitidos,
      }),
    );

    await recordAudit(tx, companyId, {
      actorType: 'USER',
      actorId: actor,
      action: 'IMPORTAR_MIGRACION',
      objectType: 'migration',
      objectId: migrationId,
      newValue: { estado, tandas: corridas, conteos: lista, progreso },
    });

    const rec = reconciliar(lista, []);
    return { estado, conteos: rec.conteos, cierra: rec.cierra, cancelada, progreso };
  });
}

/**
 * Cuánto puede estar tomado el candado sin que nadie lo renueve.
 *
 * Se renueva al cerrar cada tanda, así que una corrida viva nunca lo pierde: el
 * plazo solo corre para una que se murió. Quince minutos es más que cualquier
 * tanda —la más lenta medida tardó menos de un segundo— y menos que la
 * paciencia de quien quiere volver a intentar.
 */
const MINUTOS_DE_CANDADO = 15;

/**
 * Los estados desde los que no se vuelve a importar.
 *
 * `CANCELADA` no está: cancelar es frenar, y lo que quedó pendiente se puede
 * retomar. `FALLIDA` tampoco: se cortó y reanudar es exactamente lo que hay que
 * poder hacer.
 */
const YA_TERMINO = new Set<Estado>([
  'COMPLETADA',
  'COMPLETADA_CON_ADVERTENCIAS',
  'REVERTIDA',
]);

/**
 * Toma el candado de la migración, o dice quién lo tiene.
 *
 * Es un `UPDATE` condicional y no un `SELECT` seguido de un `UPDATE`: entre
 * mirar y escribir hay una ventana, y esta función existe justamente porque dos
 * corridas pueden atravesarla a la vez. Con una sola sentencia, la que pierde
 * recibe `rowCount = 0`.
 */
async function tomarElCandado(tx: Tx, migrationId: string): Promise<void> {
  const { rowCount } = await tx.query(
    `UPDATE migrations
        SET importando_desde = now()
      WHERE id = $1
        AND (importando_desde IS NULL
             OR importando_desde < now() - ($2 || ' minutes')::interval)`,
    [migrationId, String(MINUTOS_DE_CANDADO)],
  );
  if (rowCount === 0) {
    const { rows } = await tx.query<{ desde: string }>(
      `SELECT to_char(importando_desde, 'HH24:MI:SS') AS desde FROM migrations WHERE id = $1`,
      [migrationId],
    );
    if (rows[0] === undefined) throw notFound('La migración no existe');
    throw conflict(
      `Esta migración ya se está importando desde las ${rows[0].desde}. Esperá a que termine: ` +
        'los datos no corren peligro —una fila no entra dos veces— pero dos corridas a la vez ' +
        `se estorban. Si el proceso quedó colgado, en ${MINUTOS_DE_CANDADO} minutos se libera solo.`,
    );
  }
}

/**
 * Deja escrito que una tanda falló, y por qué.
 *
 * Corre en su propia transacción porque la de la tanda ya está abortada. La
 * tanda queda en `FALLIDA`, que `tandasPendientes` sigue considerando pendiente:
 * reanudar la vuelve a intentar, y `intentos` cuenta cuántas veces se probó.
 */
async function anotarTandaFallida(tx: Tx, batchId: string, error: unknown): Promise<void> {
  const motivo = error instanceof Error ? error.message : String(error);
  await tx.query(
    `UPDATE migration_batches
        SET estado = 'FALLIDA', error = $2, intentos = intentos + 1, terminada_el = NULL
      WHERE id = $1`,
    // El CHECK `mb_fallida_con_motivo` exige que el motivo no venga vacío, y un
    // error sin mensaje existe: por eso el texto de reemplazo, que dice
    // exactamente eso en vez de dejar la fila sin poder escribirse.
    [batchId, motivo.trim() === '' ? 'Falló sin dejar mensaje' : motivo.slice(0, 2000)],
  );
}

/** Suelta el candado. Idempotente: soltarlo dos veces no es un error. */
async function soltarElCandado(tx: Tx, migrationId: string): Promise<void> {
  await tx.query('UPDATE migrations SET importando_desde = NULL WHERE id = $1', [migrationId]);
}

interface TandaPendiente {
  readonly id: string;
  readonly tableId: string;
  readonly entidad: Entidad;
  readonly desde: number;
  readonly hasta: number;
}

/** Escribe las tandas de cada tabla incluida, en el orden de dependencia. */
async function planificar(
  tx: Tx,
  companyId: string,
  migrationId: string,
): Promise<{
  readonly pendientes: readonly TandaPendiente[];
  readonly adaptador: string;
  readonly fechaCorte: string | null;
}> {
  const m = await leerMigracion(tx, migrationId);
  const cabecera = await tx.query<{ fecha_corte: string | null }>(
    'SELECT fecha_corte::text FROM migrations WHERE id = $1',
    [migrationId],
  );
  const archivo = await nombreDeArchivo(tx, migrationId);

  let total = 0;
  for (const tabla of ordenarTablas(await tablasDe(tx, migrationId))) {
    if (tabla.entidad === null || !tabla.incluida) continue;
    const filas = await filasDe(tx, migrationId, tabla, archivo);
    const grupos = ordenarGrupos(tabla.entidad, agrupar(filas, escritorDe(tabla.entidad)));
    await planificarTandas(tx, companyId, migrationId, { id: tabla.id, entidad: tabla.entidad }, grupos);
    total += filas.length;
  }

  await tx.query('UPDATE migrations SET filas_totales = $2 WHERE id = $1', [migrationId, total]);

  return {
    pendientes: await tandasPendientes(tx, migrationId),
    adaptador: m.adaptador,
    fechaCorte: cabecera.rows[0]?.fecha_corte ?? null,
  };
}

/** Las cuentas van de padres a hijos; el resto, en el orden en que quedaron. */
const ordenarGrupos = (entidad: Entidad, grupos: readonly Grupo[]): readonly Grupo[] =>
  entidad === 'ACCOUNT' ? ordenarCuentas(grupos) : grupos;

async function tandasPendientes(tx: Tx, migrationId: string): Promise<readonly TandaPendiente[]> {
  const { rows } = await tx.query<{
    id: string;
    table_id: string;
    entidad: Entidad;
    desde: number;
    hasta: number;
  }>(
    `SELECT b.id, b.table_id, t.entidad, b.desde, b.hasta
       FROM migration_batches b
       JOIN migration_tables t ON t.id = b.table_id
      WHERE b.migration_id = $1 AND b.estado <> 'COMPLETADA'
      ORDER BY t.entidad, b.numero`,
    [migrationId],
  );

  // El orden de dependencia se aplica acá y no en el SQL: la lista vive en el
  // código de los escritores, que es donde se sabe qué necesita qué.
  const posicion = (e: Entidad): number => {
    const i = ORDEN_DE_IMPORTACION.indexOf(e);
    return i === -1 ? ORDEN_DE_IMPORTACION.length : i;
  };
  return rows
    .map((r) => ({ id: r.id, tableId: r.table_id, entidad: r.entidad, desde: r.desde, hasta: r.hasta }))
    .sort((a, b) => posicion(a.entidad) - posicion(b.entidad));
}

/** Rearma los grupos de una tanda a partir de su rango de posiciones. */
async function gruposDeLaTanda(
  tx: Tx,
  migrationId: string,
  tanda: TandaPendiente,
): Promise<readonly Grupo[]> {
  const archivo = await nombreDeArchivo(tx, migrationId);
  const tabla = (await tablasDe(tx, migrationId)).find((t) => t.id === tanda.tableId);
  if (tabla === undefined || tabla.entidad === null) return [];

  const filas = await filasDe(tx, migrationId, tabla, archivo);
  const grupos = ordenarGrupos(tabla.entidad, agrupar(filas, escritorDe(tabla.entidad)));

  // El rango de la tanda son posiciones en el orden determinista de arriba, no
  // números de fila: una entidad que agrupa cambia el orden, y guardar números
  // de fila haría que la tanda describiera otro conjunto al reanudar.
  const salida: Grupo[] = [];
  let posicion = 1;
  for (const g of grupos) {
    const fin = posicion + g.filas.length - 1;
    if (posicion >= tanda.desde && fin <= tanda.hasta) salida.push(g);
    posicion = fin + 1;
  }
  return salida;
}

async function filasDe(
  tx: Tx,
  migrationId: string,
  tabla: TablaMapeada,
  archivo: string,
): Promise<readonly FilaParaImportar[]> {
  const registros = await registrosDe(tx, migrationId, tabla, archivo);
  return registros.map((r) => ({
    rowId: r.rowId,
    numero: Number(r.registro.procedencia.fila),
    registro: r.registro,
  }));
}

function acumular(conteos: Map<Entidad, ConteoPorEntidad>, paso: ConteoPorEntidad): void {
  const previo = conteos.get(paso.entidad);
  if (previo === undefined) {
    conteos.set(paso.entidad, { ...paso });
    return;
  }
  previo.enOrigen += paso.enOrigen;
  previo.importados += paso.importados;
  previo.yaEstaban += paso.yaEstaban;
  previo.rechazados += paso.rechazados;
  previo.omitidos += paso.omitidos;
}

export async function leerProgreso(tx: Tx, migrationId: string): Promise<Progreso> {
  const { rows } = await tx.query<{
    total: number;
    procesadas: number;
    tandas: number;
    completadas: number;
  }>(
    `SELECT m.filas_totales AS total, m.filas_procesadas AS procesadas,
            (SELECT count(*)::int FROM migration_batches b WHERE b.migration_id = m.id) AS tandas,
            (SELECT count(*)::int FROM migration_batches b
              WHERE b.migration_id = m.id AND b.estado = 'COMPLETADA') AS completadas
       FROM migrations m WHERE m.id = $1`,
    [migrationId],
  );
  const f = rows[0];
  return {
    total: f?.total ?? 0,
    procesadas: f?.procesadas ?? 0,
    tandas: f?.tandas ?? 0,
    tandasCompletadas: f?.completadas ?? 0,
  };
}

// ---------------------------------------------------------------------------
// Cancelar
// ---------------------------------------------------------------------------

/**
 * Pide la cancelación.
 *
 * No corta nada de inmediato: escribe el pedido y el importador lo ve al
 * terminar la tanda en curso. Matar el proceso a mitad de una tanda es
 * exactamente lo que las tandas existen para evitar.
 *
 * Lo ya importado **queda**. Cancelar no es revertir: son dos botones distintos
 * porque son dos decisiones distintas, y juntarlas haría que quien solo quería
 * frenar perdiera lo que ya había entrado bien.
 */
export async function cancelar(
  tx: Tx,
  companyId: string,
  actor: string,
  migrationId: string,
  motivo: string,
): Promise<{ readonly estado: Estado; readonly progreso: Progreso }> {
  const m = await leerMigracion(tx, migrationId);
  if (m.estado !== 'IMPORTANDO') {
    throw conflict(
      `Solo se puede cancelar una migración que está importando, y esta está en ${m.estado}.`,
    );
  }

  await tx.query(
    `UPDATE migrations SET estado = 'CANCELACION_PEDIDA', cancelada_motivo = $2 WHERE id = $1`,
    [migrationId, motivo],
  );
  await recordAudit(tx, companyId, {
    actorType: 'USER',
    actorId: actor,
    action: 'CANCELAR_MIGRACION',
    objectType: 'migration',
    objectId: migrationId,
    motivo,
  });

  return { estado: 'CANCELACION_PEDIDA', progreso: await leerProgreso(tx, migrationId) };
}

// ---------------------------------------------------------------------------
// Revertir
// ---------------------------------------------------------------------------

export interface ResultadoDeReversion {
  /** Lo que se archivó o anuló, por tabla. */
  readonly deshecho: readonly { readonly tabla: string; readonly cantidad: number }[];
  /** Lo que no se pudo deshacer, con el motivo. */
  readonly noReversible: readonly {
    readonly tabla: string;
    readonly cantidad: number;
    readonly motivo: string;
  }[];
  readonly archivados: number;
}

/**
 * Deshace lo que la migración escribió.
 *
 * Solo lo que **creó**: los vínculos con `creado = false` apuntan a filas que
 * ya estaban antes, y tocarlas sería llevarse por delante datos que no eran de
 * la migración.
 *
 * ## Cada tabla se deshace como esa tabla se deshace
 *
 * No hay un borrado general, y no lo hay porque NEXO no borra:
 *
 *   · **Terceros, productos y depósitos** se archivan. Pueden tener movimientos
 *     colgando y el borrado fallaría por la clave foránea, dejando la reversión
 *     a medias.
 *   · **Cuentas** se archivan. Una cuenta con movimientos en el Mayor no se va
 *     a ninguna parte.
 *   · **Asientos** se anulan. Entraron PROPUESTOS, así que nunca llegaron al
 *     Mayor: anularlos no mueve un solo saldo.
 *   · **Órdenes de pago** se anulan con motivo.
 *   · **Movimientos de stock** se compensan con el movimiento inverso. El libro
 *     solo crece —igual que el Mayor—, y una existencia que desaparece del
 *     libro es una existencia que nadie puede auditar. La existencia final
 *     vuelve a ser la que era; el rastro de que hubo una migración, queda.
 *   · **Comprobantes fiscales NO se deshacen.** Es lo único que esta función no
 *     puede hacer y hay que decirlo antes de importar, no después: un
 *     comprobante registrado es parte del registro fiscal de la empresa, la
 *     tabla no tiene estado de anulación y `forbid_delete` lo protege. Lo que
 *     hace la reversión es contarlos y decir cuáles son.
 */
export async function revertir(
  tx: Tx,
  companyId: string,
  actor: string,
  migrationId: string,
  motivo: string,
): Promise<ResultadoDeReversion> {
  const m = await leerMigracion(tx, migrationId);
  await transicionar(tx, migrationId, m.estado, 'REVERTIDA');

  // El orden importa, y al revés que en la importación.
  //
  // Compensar un movimiento de stock escribe en el libro, y el libro exige que
  // el producto esté activo (`assert_producto_con_stock`). Si los maestros se
  // archivaran primero, la compensación fallaría con un error de la base sobre
  // un producto que la propia reversión acababa de archivar. Se deshace de la
  // hoja a la raíz: primero lo que depende, después aquello de lo que depende.
  const { rows } = await tx.query<{ tabla_destino: string; id_destino: string }>(
    `SELECT tabla_destino, id_destino FROM migration_links
      WHERE migration_id = $1 AND creado = true
      ORDER BY array_position($2::text[], tabla_destino), id_destino`,
    [migrationId, ORDEN_DE_REVERSION],
  );

  const deshecho = new Map<string, number>();
  const noReversible = new Map<string, number>();
  const sumar = (mapa: Map<string, number>, tabla: string, n = 1): void => {
    mapa.set(tabla, (mapa.get(tabla) ?? 0) + n);
  };

  for (const v of rows) {
    // La tabla sale de la lista blanca del código, no del texto de la fila: un
    // nombre de tabla que venga de la base y se concatene en el SQL es una
    // inyección esperando a que alguien escriba en `migration_links`.
    const forma = COMO_SE_DESHACE.get(v.tabla_destino);
    if (forma === undefined) {
      sumar(noReversible, v.tabla_destino, 1);
      continue;
    }

    const hechos = await forma(tx, companyId, actor, v.id_destino, motivo, migrationId);
    if (hechos > 0) sumar(deshecho, v.tabla_destino, hechos);
    else sumar(noReversible, v.tabla_destino, 1);
  }

  const resultado: ResultadoDeReversion = {
    deshecho: [...deshecho.entries()].map(([tabla, cantidad]) => ({ tabla, cantidad })),
    noReversible: [...noReversible.entries()].map(([tabla, cantidad]) => ({
      tabla,
      cantidad,
      motivo: MOTIVO_NO_REVERSIBLE[tabla] ?? 'Esta tabla no tiene forma declarada de deshacerse.',
    })),
    archivados: [...deshecho.values()].reduce((a, b) => a + b, 0),
  };

  await recordAudit(tx, companyId, {
    actorType: 'USER',
    actorId: actor,
    action: 'REVERTIR_MIGRACION',
    objectType: 'migration',
    objectId: migrationId,
    motivo,
    newValue: resultado,
  });

  return resultado;
}

/**
 * De la hoja a la raíz. Es el orden de importación dado vuelta.
 *
 * Lo que no está en la lista va al final: `array_position` devuelve `NULL` y
 * PostgreSQL ordena los nulos últimos.
 */
const ORDEN_DE_REVERSION: readonly string[] = [
  'payment_orders',
  'journal_entries',
  'stock_movements',
  'tax_transactions',
  'products',
  'parties',
  'warehouses',
  'accounts',
];

/** Cuántas filas deshizo cada forma. Cero significa «no se pudo». */
type FormaDeDeshacer = (
  tx: Tx,
  companyId: string,
  actor: string,
  id: string,
  motivo: string,
  migrationId: string,
) => Promise<number>;

const archivarCon =
  (tabla: 'parties' | 'products' | 'warehouses', valor: string): FormaDeDeshacer =>
  async (tx, companyId, _actor, id) => {
    // El nombre de la tabla es una constante de este módulo, nunca un dato.
    const sentencia =
      tabla === 'parties'
        ? `UPDATE parties SET status = $3 WHERE company_id = $1 AND id = $2`
        : tabla === 'products'
          ? `UPDATE products SET status = $3 WHERE company_id = $1 AND id = $2`
          : `UPDATE warehouses SET status = $3 WHERE company_id = $1 AND id = $2`;
    const { rowCount } = await tx.query(sentencia, [companyId, id, valor]);
    return rowCount ?? 0;
  };

const COMO_SE_DESHACE = new Map<string, FormaDeDeshacer>([
  ['parties', archivarCon('parties', 'ARCHIVADO')],
  ['products', archivarCon('products', 'ARCHIVADO')],
  ['warehouses', archivarCon('warehouses', 'ARCHIVADO')],

  [
    'accounts',
    async (tx, companyId, _actor, id) => {
      const { rowCount } = await tx.query(
        `UPDATE accounts SET status = 'ARCHIVED' WHERE company_id = $1 AND id = $2`,
        [companyId, id],
      );
      return rowCount ?? 0;
    },
  ],

  [
    'journal_entries',
    async (tx, companyId, _actor, id, motivo) => {
      // Solo los que siguen propuestos. Uno aprobado ya proyectó movimientos en
      // el Mayor y se deshace con un contraasiento, que es una operación
      // contable y no un efecto secundario de revertir una migración.
      const { rowCount } = await tx.query(
        `UPDATE journal_entries
            SET status = 'ANULADO',
                manual_justification = coalesce(manual_justification, '') ||
                                       ' · Revertido con la migración: ' || $3
          WHERE company_id = $1 AND id = $2 AND status = 'PROPUESTO'`,
        [companyId, id, motivo],
      );
      return rowCount ?? 0;
    },
  ],

  [
    'payment_orders',
    async (tx, companyId, _actor, id, motivo) => {
      const { rowCount } = await tx.query(
        `UPDATE payment_orders
            SET status = 'ANULADA', motivo_anulacion = $3
          WHERE company_id = $1 AND id = $2 AND status = 'BORRADOR'`,
        [companyId, id, `Revertido con la migración: ${motivo}`],
      );
      return rowCount ?? 0;
    },
  ],

  [
    'stock_movements',
    async (tx, companyId, actor, id, _motivo, migrationId) => {
      // El movimiento inverso, no el borrado. El libro solo crece.
      const { rows } = await tx.query<{
        product_id: string;
        warehouse_id: string;
        tipo: string;
        cantidad: string;
        lote: string | null;
        fecha: string;
      }>(
        `SELECT product_id, warehouse_id, tipo, cantidad::text, lote, fecha::text
           FROM stock_movements WHERE company_id = $1 AND id = $2`,
        [companyId, id],
      );
      const original = rows[0];
      if (original === undefined) return 0;

      // Ya compensado: revertir dos veces no duplica el movimiento inverso.
      const yaCompensado = await tx.query<{ n: string }>(
        `SELECT count(*)::text n FROM stock_movements
          WHERE company_id = $1 AND origen_tipo = 'MIGRACION' AND origen_id = $2
            AND motivo = $3`,
        [companyId, migrationId, `Reversión del movimiento ${id}`],
      );
      if (Number(yaCompensado.rows[0]!.n) > 0) return 0;

      await tx.query(
        `INSERT INTO stock_movements
           (company_id, product_id, warehouse_id, tipo, cantidad, fecha,
            origen_tipo, origen_id, motivo, lote, created_by)
         VALUES ($1, $2, $3, $4, $5, $6, 'MIGRACION', $7, $8, $9, $10)`,
        [
          companyId,
          original.product_id,
          original.warehouse_id,
          INVERSO[original.tipo] ?? 'AJUSTE_NEGATIVO',
          original.cantidad,
          original.fecha,
          migrationId,
          `Reversión del movimiento ${id}`,
          original.lote,
          actor,
        ],
      );
      return 1;
    },
  ],
]);

/** Qué movimiento deshace a cuál. La existencia vuelve a ser la que era. */
const INVERSO: Readonly<Record<string, string>> = {
  ENTRADA: 'SALIDA',
  SALIDA: 'ENTRADA',
  AJUSTE_POSITIVO: 'AJUSTE_NEGATIVO',
  AJUSTE_NEGATIVO: 'AJUSTE_POSITIVO',
};

const MOTIVO_NO_REVERSIBLE: Readonly<Record<string, string>> = {
  tax_transactions:
    'Un comprobante fiscal registrado es parte del registro de la empresa: la tabla no tiene ' +
    'estado de anulación y un trigger impide borrarla. Quedan cargados. Si el archivo era el ' +
    'equivocado, se corrigen con notas de crédito o de débito, que es como se corrige un ' +
    'comprobante en la vida real.',
  journal_entries:
    'El asiento ya no estaba PROPUESTO: alguien lo aprobó y proyectó sus movimientos en el ' +
    'Mayor. Se deshace con un contraasiento desde «Asientos», que es una operación contable y ' +
    'no un efecto secundario de revertir una migración.',
  payment_orders:
    'La orden de pago ya no estaba en BORRADOR: fue aprobada o pagada. Anularla es una ' +
    'decisión de tesorería y se hace desde su propia pantalla.',
};

// ---------------------------------------------------------------------------
// Reconciliación
// ---------------------------------------------------------------------------

export interface DiferenciaDeStock {
  readonly sku: string;
  readonly deposito: string;
  readonly enOrigen: string;
  readonly enNexo: string;
  readonly diferencia: string;
  readonly cuadra: boolean;
}

/**
 * Compara la existencia que declaraba el origen con la que quedó en NEXO.
 *
 * Es la comprobación que hace útil a una migración de stock: importar
 * movimientos sin verificar que la existencia resultante coincida con la del
 * sistema anterior es mover mercadería a ciegas.
 *
 * ## Se compara a la fecha de corte, no a hoy
 *
 * Es la parte que se puede hacer mal sin que se note. El archivo declara «había
 * 100 al 15 de enero»; si además trae los movimientos posteriores, la existencia
 * de hoy **no tiene por qué ser 100** y compararla contra 100 marcaría una
 * diferencia donde no la hay. Se suman entonces los movimientos hasta la fecha
 * que el propio archivo declaró para esa existencia.
 *
 * Solo compara lo que el archivo declaró. Un producto del que el origen no dijo
 * cuánto había no aparece: **no se puede afirmar** que sobre ni que falte.
 */
export async function reconciliarStock(
  tx: Tx,
  companyId: string,
  migrationId: string,
): Promise<readonly DiferenciaDeStock[]> {
  const { rows } = await tx.query<{
    sku: string;
    deposito: string;
    declarado: string;
    real: string;
  }>(
    `WITH declarado AS (
       SELECT r.normalizado->'sku'->>'valor'      AS sku,
              coalesce(r.normalizado->'deposito'->>'valor', '') AS deposito,
              sum((r.normalizado->'cantidad'->>'valor')::numeric) AS cantidad,
              -- La fecha a la que el origen afirma esa existencia. La suya, o
              -- la de la migración si la fila no trajo ninguna.
              coalesce(
                max((r.normalizado->'fechaCorte'->>'valor')::date),
                (SELECT m.fecha_corte FROM migrations m WHERE m.id = $1)
              ) AS corte
         FROM migration_rows r
         JOIN migration_tables t ON t.id = r.table_id
        WHERE r.migration_id = $1
          AND t.entidad = 'STOCK_BALANCE'
          AND r.estado IN ('IMPORTADA','YA_EXISTIA')
          AND r.normalizado->'cantidad'->>'valor' IS NOT NULL
        GROUP BY 1, 2
     )
     SELECT d.sku,
            d.deposito,
            d.cantidad::text AS declarado,
            coalesce((
              SELECT sum(CASE WHEN sm.tipo IN ('ENTRADA','AJUSTE_POSITIVO','TRANSFERENCIA_ENTRADA')
                              THEN sm.cantidad ELSE -sm.cantidad END)
                FROM stock_movements sm
                JOIN products p ON p.id = sm.product_id AND p.company_id = sm.company_id
                JOIN warehouses w ON w.id = sm.warehouse_id AND w.company_id = sm.company_id
               WHERE sm.company_id = $2 AND p.code = d.sku
                 AND (d.deposito = '' OR w.code = d.deposito)
                 AND (d.corte IS NULL OR sm.fecha <= d.corte)
            ), 0)::text AS real
       FROM declarado d
      ORDER BY d.sku, d.deposito`,
    [migrationId, companyId],
  );

  return rows.map((f) => {
    const diferencia = Number(f.real) - Number(f.declarado);
    return {
      sku: f.sku,
      deposito: f.deposito === '' ? '(sin declarar)' : f.deposito,
      enOrigen: f.declarado,
      enNexo: f.real,
      diferencia: String(diferencia),
      cuadra: diferencia === 0,
    };
  });
}

export interface DiferenciaContable {
  readonly concepto: string;
  readonly enOrigen: string;
  readonly enNexo: string;
  readonly cuadra: boolean;
}

/**
 * Compara el debe y el haber que traía el archivo con lo que quedó asentado.
 *
 * Suma los importes **de las filas que se importaron**, no de todas: una fila
 * rechazada no está en NEXO y contarla como diferencia diría que se perdió algo
 * cuando lo que pasó es que no entró, y eso ya está informado.
 */
export async function reconciliarContabilidad(
  tx: Tx,
  companyId: string,
  migrationId: string,
): Promise<readonly DiferenciaContable[]> {
  const origen = await tx.query<{ debe: string; haber: string; asientos: string }>(
    `SELECT coalesce(sum((r.normalizado->'debe'->>'valor')::numeric), 0)::text  AS debe,
            coalesce(sum((r.normalizado->'haber'->>'valor')::numeric), 0)::text AS haber,
            count(DISTINCT l.id_destino)::text AS asientos
       FROM migration_rows r
       JOIN migration_tables t ON t.id = r.table_id
       LEFT JOIN migration_links l ON l.row_id = r.id
      WHERE r.migration_id = $1 AND t.entidad = 'JOURNAL_ENTRY'
        AND r.estado = 'IMPORTADA'`,
    [migrationId],
  );

  const nexo = await tx.query<{ debe: string; haber: string; asientos: string }>(
    `SELECT coalesce(sum(e.total_debit), 0)::text  AS debe,
            coalesce(sum(e.total_credit), 0)::text AS haber,
            count(*)::text AS asientos
       FROM journal_entries e
      WHERE e.company_id = $2
        AND e.id IN (SELECT id_destino FROM migration_links
                      WHERE migration_id = $1 AND tabla_destino = 'journal_entries'
                        AND creado = true)`,
    [migrationId, companyId],
  );

  // Los importes del origen vienen en centavos —así los guarda el normalizador—
  // y los de NEXO en pesos. La comparación se hace en centavos, con enteros.
  const enCentavosDeNexo = (t: string): string => String(Math.round(Number(t) * 100));
  const o = origen.rows[0]!;
  const n = nexo.rows[0]!;

  return [
    {
      concepto: 'Asientos',
      enOrigen: o.asientos,
      enNexo: n.asientos,
      cuadra: o.asientos === n.asientos,
    },
    {
      concepto: 'Debe',
      enOrigen: o.debe,
      enNexo: enCentavosDeNexo(n.debe),
      cuadra: String(Math.round(Number(o.debe))) === enCentavosDeNexo(n.debe),
    },
    {
      concepto: 'Haber',
      enOrigen: o.haber,
      enNexo: enCentavosDeNexo(n.haber),
      cuadra: String(Math.round(Number(o.haber))) === enCentavosDeNexo(n.haber),
    },
  ];
}
