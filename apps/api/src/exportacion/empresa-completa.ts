/**
 * La exportación completa de una empresa: todo lo suyo, en un ZIP que se puede verificar afuera.
 *
 * ## Para quién y para qué
 *
 * Una empresa tiene derecho a llevarse sus datos, y NEXO a poder decir «esto es todo y no falta nada». Sirve igual para
 * una empresa que empezó de cero que para una que **entró con información anterior** (migrada): se exporta lo que hay en
 * la base, sin distinguir de dónde vino, incluidas las tablas de la migración (qué se importó y de qué archivo).
 *
 * ## Qué contiene el ZIP
 *
 *     LEEME.txt                  qué es cada cosa y cómo comprobarla
 *     manifiesto.json            por archivo: filas, bytes y sha256; qué quedó afuera y por qué
 *     esquema.json               columnas y tipos de cada tabla exportada
 *     empresa.ndjson             la fila de la empresa
 *     usuarios.ndjson            quiénes tienen acceso y con qué rol (sin contraseñas ni segundo factor)
 *     datos/<tabla>.ndjson       una línea JSON por fila, de cada tabla con `company_id`
 *     catalogos/<tabla>.ndjson   los catálogos globales a los que apuntan esas tablas (impuestos, tipos de comprobante…)
 *     archivos/<ruta>            los documentos subidos (PDF, imágenes, planillas), tal como se guardaron
 *
 * Las **vistas no se exportan**: son derivadas y se recalculan desde las tablas (un total exportado que pudiera
 * contradecir a los asientos es justo lo que no queremos).
 *
 * ## Cómo se garantiza que no falta nada
 *
 * Las tablas se **descubren del esquema** (`company_id`), no de una lista; si una tabla de la empresa no se puede leer, no
 * se omite en silencio: sale en `manifiesto.noLegibles` y `tests/integration/exportacion-completa.test.ts` exige que esa
 * lista esté vacía. Los archivos que la base nombra y el almacén no tiene salen en `manifiesto.archivos.faltantes`.
 *
 * ## Qué NO sale (y por qué), ver `politica.ts`
 *
 * Material de credenciales (claves privadas, tokens de integraciones, referencias a secretos) y la identidad de los
 * usuarios (contraseñas, segundo factor, sesiones). Todo lo que se saca figura en el manifiesto con su motivo.
 *
 * ## Cómo se lee la base
 *
 * Con un cursor y por lotes, dentro de la transacción de la empresa (RLS incluido): el uso de memoria no depende del
 * tamaño de la empresa. Los números salen como los guarda PostgreSQL (`numeric` exacto, sin pasar por punto flotante).
 */

import type { Tx } from '@aai/db';
import type { DocumentStore } from '@aai/document-engine';
import type { EscritorZip, EntradaEscrita } from './zip-streaming.js';
import {
  COLUMNAS_EXCLUIDAS,
  MAX_FILAS_DE_CATALOGO,
  NO_ES_CATALOGO,
  TABLAS_EXCLUIDAS,
} from './politica.js';

export const FORMATO_DE_EXPORTACION = 'nexo-exportacion-completa/1';

const IDENT = /^[a-z_][a-z0-9_]*$/u;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/iu;
const LOTE = 500;

export interface ParametrosDeExportacion {
  readonly companyId: string;
  readonly exportadoPor: string;
  readonly motivo: string;
  readonly incluirArchivos: boolean;
  readonly almacen: DocumentStore | null;
}

export interface TablaExportada {
  readonly tabla: string;
  readonly archivo: string;
  readonly filas: number;
  readonly bytes: number;
  readonly sha256: string;
  readonly columnasExcluidas: readonly string[];
}

export interface ResumenDeExportacion {
  readonly tablas: readonly TablaExportada[];
  readonly catalogos: readonly TablaExportada[];
  readonly noLegibles: readonly string[];
  readonly tablasExcluidas: readonly { tabla: string; motivo: string }[];
  readonly catalogosOmitidos: readonly { tabla: string; motivo: string }[];
  readonly archivos: { incluidos: number; bytes: number; faltantes: readonly string[] };
  readonly filasTotales: number;
}

interface TablaDelEsquema {
  readonly tabla: string;
  readonly legible: boolean;
  readonly columnas: readonly { columna: string; tipo: string }[];
}

const ident = (nombre: string): string => {
  if (!IDENT.test(nombre)) throw new Error(`Nombre de tabla o columna no permitido: "${nombre}"`);
  return `"${nombre}"`;
};

/** Las tablas del esquema `public` con la columna indicada, leídas del catálogo de PostgreSQL (no de information_schema). */
async function tablasConColumna(tx: Tx, columna: string): Promise<TablaDelEsquema[]> {
  // `pg_catalog` y no `information_schema`: este último **oculta** lo que el rol no puede leer, y una tabla de la empresa
  // que desapareciera de la exportación por un permiso mal dado sería una omisión silenciosa.
  const r = await tx.query<{ tabla: string; legible: boolean; columnas: { columna: string; tipo: string }[] }>(
    `SELECT c.relname AS tabla,
            has_table_privilege(current_user, c.oid, 'SELECT') AS legible,
            jsonb_agg(jsonb_build_object('columna', a.attname, 'tipo', format_type(a.atttypid, a.atttypmod))
                      ORDER BY a.attnum) AS columnas
       FROM pg_class c
       JOIN pg_namespace n ON n.oid = c.relnamespace AND n.nspname = 'public'
       JOIN pg_attribute a ON a.attrelid = c.oid AND a.attnum > 0 AND NOT a.attisdropped
      WHERE c.relkind IN ('r', 'p')
      GROUP BY c.oid, c.relname
     HAVING bool_or(a.attname = $1)
      ORDER BY c.relname`,
    [columna],
  );
  return r.rows;
}

/** Filas de una consulta, en pedazos de líneas JSON. La consulta devuelve una sola columna `l` (texto JSON). */
async function* lineas(tx: Tx, consulta: string, contador: { filas: number }, nombre: string): AsyncGenerator<Buffer> {
  const cursor = `exp_${nombre.replace(/[^a-z0-9_]/gu, '_').slice(0, 40)}`;
  await tx.query(`DECLARE ${cursor} NO SCROLL CURSOR FOR ${consulta}`);
  try {
    for (;;) {
      const r = await tx.query<{ l: string }>(`FETCH FORWARD ${String(LOTE)} FROM ${cursor}`);
      if (r.rows.length === 0) break;
      contador.filas += r.rows.length;
      yield Buffer.from(`${r.rows.map((x) => x.l).join('\n')}\n`, 'utf8');
    }
  } finally {
    await tx.query(`CLOSE ${cursor}`).catch(() => undefined);
  }
}

const aTabla = (e: EntradaEscrita, tabla: string, filas: number, excluidas: readonly string[]): TablaExportada => ({
  tabla,
  archivo: e.nombre,
  filas,
  bytes: e.bytes,
  sha256: e.sha256,
  columnasExcluidas: excluidas,
});

export async function exportarEmpresaCompleta(
  tx: Tx,
  zip: EscritorZip,
  p: ParametrosDeExportacion,
): Promise<ResumenDeExportacion> {
  if (!UUID.test(p.companyId)) throw new Error('companyId inválido');
  const empresaId = p.companyId.toLowerCase();

  const empresa = await tx.query<{ id: string; legal_name: string; cuit: string }>(
    `SELECT id, legal_name, cuit FROM companies WHERE id = $1`,
    [empresaId],
  );
  if (empresa.rows[0] === undefined) throw new Error('La empresa no existe o no es visible.');
  const generadoEn = (await tx.query<{ ahora: string }>(`SELECT now()::text AS ahora`)).rows[0]!.ahora;

  // ── Descubrir ──────────────────────────────────────────────────────────────────────────────────────────────────────
  const todas = await tablasConColumna(tx, 'company_id');
  const noLegibles = todas.filter((t) => !t.legible).map((t) => t.tabla);
  const tablasExcluidas = todas
    .filter((t) => t.tabla in TABLAS_EXCLUIDAS)
    .map((t) => ({ tabla: t.tabla, motivo: TABLAS_EXCLUIDAS[t.tabla]! }));
  const aExportar = todas.filter((t) => t.legible && !(t.tabla in TABLAS_EXCLUIDAS));

  // Un `SELECT` que falla dentro de la transacción la aborta entera, así que se pregunta el permiso antes en vez de capturar.
  const puedeLeerMigraciones = (
    await tx.query<{ ok: boolean }>(`SELECT has_table_privilege(current_user, 'schema_migrations', 'SELECT') AS ok`)
  ).rows[0]!.ok;
  const migraciones = puedeLeerMigraciones
    ? await tx
        .query<{ n: string; ultima: string | null }>(`SELECT count(*)::text AS n, max(name) AS ultima FROM schema_migrations`)
        .then((r) => ({ aplicadas: Number(r.rows[0]!.n) as number | null, ultima: r.rows[0]!.ultima }))
    : { aplicadas: null as number | null, ultima: null as string | null };

  // ── Qué se lleva el ZIP ────────────────────────────────────────────────────────────────────────────────────────────
  const esquema: Record<string, readonly { columna: string; tipo: string }[]> = {};

  const empresaE = await zip.agregar(
    'empresa.ndjson',
    lineas(tx, `SELECT to_jsonb(c)::text AS l FROM companies c WHERE c.id = '${empresaId}'::uuid`, { filas: 0 }, 'empresa'),
  );

  const usuariosContador = { filas: 0 };
  const usuariosE = await zip.agregar(
    'usuarios.ndjson',
    lineas(
      tx,
      `SELECT jsonb_build_object(
                'user_id', u.id, 'email', u.email, 'full_name', u.full_name, 'status', u.status,
                'roles', (SELECT jsonb_agg(jsonb_build_object('role', r.code, 'valid_from', x.valid_from, 'valid_to', x.valid_to)
                                           ORDER BY x.valid_from)
                            FROM user_company_roles x JOIN roles r ON r.id = x.role_id
                           WHERE x.user_id = u.id AND x.company_id = '${empresaId}'::uuid))::text AS l
         FROM users u
        WHERE u.id IN (SELECT user_id FROM user_company_roles WHERE company_id = '${empresaId}'::uuid)`,
      usuariosContador,
      'usuarios',
    ),
  );

  const tablas: TablaExportada[] = [];
  for (const t of aExportar) {
    const excluidas = Object.keys(COLUMNAS_EXCLUIDAS[t.tabla] ?? {});
    const quitar = excluidas.length === 0 ? `ARRAY[]::text[]` : `ARRAY[${excluidas.map((c) => `'${ident(c).slice(1, -1)}'`).join(',')}]::text[]`;
    const contador = { filas: 0 };
    const entrada = await zip.agregar(
      `datos/${t.tabla}.ndjson`,
      lineas(
        tx,
        `SELECT (to_jsonb(t) - ${quitar})::text AS l FROM ${ident(t.tabla)} t WHERE t.company_id = '${empresaId}'::uuid`,
        contador,
        t.tabla,
      ),
    );
    esquema[t.tabla] = t.columnas.filter((c) => !excluidas.includes(c.columna));
    tablas.push(aTabla(entrada, t.tabla, contador.filas, excluidas));
  }

  // ── Los catálogos globales a los que apuntan las tablas exportadas ────────────────────────────────────────────────
  const propias = new Set(todas.map((t) => t.tabla));
  const apuntadas = await tx.query<{ tabla: string; legible: boolean }>(
    `SELECT DISTINCT cl.relname AS tabla, has_table_privilege(current_user, cl.oid, 'SELECT') AS legible
       FROM pg_constraint k
       JOIN pg_class cl ON cl.oid = k.confrelid
       JOIN pg_class origen ON origen.oid = k.conrelid
       JOIN pg_namespace n ON n.oid = cl.relnamespace AND n.nspname = 'public'
      WHERE k.contype = 'f' AND origen.relname = ANY($1::text[])
      ORDER BY 1`,
    [aExportar.map((t) => t.tabla)],
  );
  const catalogos: TablaExportada[] = [];
  const catalogosOmitidos: { tabla: string; motivo: string }[] = [];
  for (const c of apuntadas.rows) {
    if (propias.has(c.tabla) || NO_ES_CATALOGO.has(c.tabla)) continue;
    if (!c.legible) {
      catalogosOmitidos.push({ tabla: c.tabla, motivo: 'La aplicación no puede leerla.' });
      continue;
    }
    const n = Number((await tx.query<{ n: string }>(`SELECT count(*)::text AS n FROM ${ident(c.tabla)}`)).rows[0]!.n);
    if (n > MAX_FILAS_DE_CATALOGO) {
      catalogosOmitidos.push({ tabla: c.tabla, motivo: `Tiene ${String(n)} filas (más de ${String(MAX_FILAS_DE_CATALOGO)}): se identifica por código.` });
      continue;
    }
    const contador = { filas: 0 };
    const entrada = await zip.agregar(
      `catalogos/${c.tabla}.ndjson`,
      lineas(tx, `SELECT to_jsonb(t)::text AS l FROM ${ident(c.tabla)} t`, contador, `cat_${c.tabla}`),
    );
    catalogos.push(aTabla(entrada, c.tabla, contador.filas, []));
    const def = (await tablasConColumna(tx, 'id')).find((x) => x.tabla === c.tabla);
    if (def !== undefined) esquema[`catalogos/${c.tabla}`] = def.columnas;
  }

  // ── Los archivos adjuntos ─────────────────────────────────────────────────────────────────────────────────────────
  const archivos = { incluidos: 0, bytes: 0, faltantes: [] as string[] };
  if (p.incluirArchivos && p.almacen !== null) {
    const claves = await tx.query<{ k: string }>(
      `SELECT storage_key AS k FROM documents WHERE company_id = $1 AND storage_key IS NOT NULL
       UNION
       SELECT storage_key FROM document_versions WHERE company_id = $1 AND storage_key IS NOT NULL
       ORDER BY 1`,
      [empresaId],
    );
    for (const { k } of claves.rows) {
      let bytes: Buffer;
      try {
        bytes = await p.almacen.get(empresaId, k);
      } catch {
        archivos.faltantes.push(k);
        continue;
      }
      await zip.agregar(`archivos/${k}`, bytes);
      archivos.incluidos += 1;
      archivos.bytes += bytes.length;
    }
  }

  // ── El esquema, el manifiesto y el LEEME (al final: llevan los hashes de todo lo anterior) ───────────────────────────
  const filasTotales = tablas.reduce((s, t) => s + t.filas, 0);
  const resumen: ResumenDeExportacion = {
    tablas,
    catalogos,
    noLegibles,
    tablasExcluidas,
    catalogosOmitidos,
    archivos,
    filasTotales,
  };

  await zip.agregar('esquema.json', Buffer.from(`${JSON.stringify(esquema, null, 2)}\n`, 'utf8'));

  const manifiesto = {
    formato: FORMATO_DE_EXPORTACION,
    generadoEn,
    empresa: { id: empresa.rows[0].id, razonSocial: empresa.rows[0].legal_name, cuit: empresa.rows[0].cuit },
    exportadoPor: p.exportadoPor,
    motivo: p.motivo,
    esquemaDeLaBase: migraciones,
    archivosFijos: [empresaE, usuariosE].map((e, i) => ({
      archivo: e.nombre,
      filas: i === 0 ? 1 : usuariosContador.filas,
      bytes: e.bytes,
      sha256: e.sha256,
    })),
    tablas,
    catalogos,
    noLegibles,
    tablasExcluidas,
    columnasExcluidas: Object.entries(COLUMNAS_EXCLUIDAS).flatMap(([tabla, cols]) =>
      Object.entries(cols).map(([columna, motivo]) => ({ tabla, columna, motivo })),
    ),
    catalogosOmitidos,
    archivos: { ...archivos, incluidos: archivos.incluidos },
    totales: { tablas: tablas.length, filas: filasTotales },
    nota:
      'Las vistas no se exportan: son derivadas y se recalculan desde las tablas. Cada línea de datos/*.ndjson es un objeto JSON ' +
      'con las columnas de la tabla; los importes salen como números exactos de PostgreSQL.',
  };
  await zip.agregar('manifiesto.json', Buffer.from(`${JSON.stringify(manifiesto, null, 2)}\n`, 'utf8'));

  await zip.agregar('LEEME.txt', Buffer.from(leeme(empresa.rows[0].legal_name, generadoEn), 'utf8'));
  await zip.cerrar();

  return resumen;
}

function leeme(razonSocial: string, generadoEn: string): string {
  return [
    `EXPORTACIÓN COMPLETA DE ${razonSocial}`,
    `Generada por NEXO el ${generadoEn}`,
    '',
    'Qué hay en este archivo',
    '  manifiesto.json   por cada archivo: cantidad de filas, bytes y huella sha256. Es el índice.',
    '  esquema.json      las columnas y tipos de cada tabla.',
    '  empresa.ndjson    la fila de la empresa.',
    '  usuarios.ndjson   quiénes tienen acceso y con qué rol (sin contraseñas ni segundo factor).',
    '  datos/            una tabla por archivo, una fila por línea (formato NDJSON: un objeto JSON por línea).',
    '  catalogos/        tablas de referencia globales a las que apuntan los datos (impuestos, tipos de comprobante…).',
    '  archivos/         los documentos subidos, tal como se guardaron.',
    '',
    'Cómo comprobar que está completo',
    '  1. Para cada archivo del manifiesto, calcule su sha256 y compárelo con el que figura.',
    '  2. Cuente las líneas de cada datos/<tabla>.ndjson: tiene que coincidir con "filas".',
    '  3. "noLegibles" tiene que estar vacío; si no lo está, faltan tablas y el manifiesto dice cuáles.',
    '',
    'Qué NO está, y por qué',
    '  Las claves privadas y los tokens de integraciones, las referencias a secretos y las contraseñas de los usuarios no se',
    '  entregan (figuran en el manifiesto con su motivo). Las vistas tampoco: se recalculan desde las tablas.',
    '',
    'Una fila de datos/ conserva los identificadores originales (uuid), así que las relaciones entre tablas se pueden',
    'reconstruir. Los importes son números exactos: léalos como decimales, no como punto flotante.',
    '',
  ].join('\n');
}
