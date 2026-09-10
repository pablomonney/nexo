/**
 * Lo que se comprueba **antes** de aceptar la primera petición.
 *
 * ## Por qué existe
 *
 * `PROJECT_STATUS.md` marcaba «sin `npm start`» como deuda IMPORTANTE: había un
 * `index.ts` correcto que nadie podía ejecutar porque no leía `.env` y no tenía
 * comando. Al escribir el arranque aparecieron dos agujeros que no eran de
 * comodidad, y son lo que este módulo cubre.
 *
 * ### 1. Un servidor contra un esquema viejo miente en silencio
 *
 * El código de la API asume las tablas de la última migración. Si la base quedó
 * atrás, las rutas nuevas fallan con errores de SQL que parecen bugs, y —peor—
 * las viejas siguen andando: el sistema queda **parcialmente** funcional, que es
 * el estado más difícil de diagnosticar. Se comparan las migraciones del disco
 * contra `schema_migrations` y **no se arranca** si falta alguna.
 *
 * Es la misma decisión que toma `migrate.mjs` con los checksums, aplicada al
 * otro extremo del ciclo: el que corre, no el que migra.
 *
 * ### 2. Los modos degradados son invisibles
 *
 * `config.ts` está lleno de valores por defecto deliberadamente inertes: el OCR
 * es `none`, ARCA es `mock`, la IA es `none`. Cada uno de esos defaults es una
 * decisión correcta —el sistema prefiere declararse incompleto antes que
 * inventar (§30)— pero **ninguno se ve desde afuera**. Alguien puede levantar
 * NEXO, constatar un comprobante y creer que habló con ARCA.
 *
 * Por eso el arranque imprime en qué modo corre cada integración, y marca con
 * `·` lo que está simulado o apagado. No cambia ningún comportamiento: hace
 * visible el que ya había.
 *
 * ## Lo que este módulo NO hace
 *
 * No migra. Un servidor que corrige la base al levantarse aplica DDL sin que
 * nadie lo haya pedido, y en producción eso es un cambio de esquema disparado
 * por un reinicio. Dice qué falta y con qué comando se arregla.
 */

import {
  estadoDelProveedor,
  faltantesDeHttp,
  type ConfiguracionDeIa,
} from './ai/proveedor.js';
import { modoDeCorreo, type ConfiguracionDeCorreo } from './correo/fabrica.js';
import { modoDeSecretos } from './secrets/fabrica.js';
import { existsSync } from 'node:fs';
import { readdir } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { withoutCompany } from '@aai/db';

/** Un problema que impide arrancar, con la forma de arreglarlo. */
export interface ProblemaDeArranque {
  readonly que: string;
  readonly comoSeArregla: string;
}

/**
 * Dónde están los `.sql`, subiendo desde `apps/api/dist` (o `src`) hasta la raíz.
 *
 * Se busca hacia arriba en vez de fijar `../../../..`: el mismo archivo corre
 * compilado y bajo `--watch` desde profundidades distintas, y una ruta relativa
 * fija anda en uno de los dos casos y falla callada en el otro.
 */
function directorioDeMigraciones(): string | null {
  let actual = dirname(fileURLToPath(import.meta.url));
  for (let i = 0; i < 8; i += 1) {
    const candidato = join(actual, 'infrastructure', 'db', 'migrations');
    if (existsSync(candidato)) return candidato;
    const padre = dirname(actual);
    if (padre === actual) break;
    actual = padre;
  }
  return null;
}

/**
 * ¿La base está al día con las migraciones del repositorio?
 *
 * Devuelve la lista de problemas: vacía significa que se puede arrancar.
 */
export async function verificarEsquema(): Promise<ProblemaDeArranque[]> {
  const carpeta = directorioDeMigraciones();
  if (carpeta === null) {
    // No es un falso verde: si no se encuentran las migraciones no se puede
    // afirmar que la base esté al día, y eso se informa como problema.
    return [
      {
        que: 'no se encontró infrastructure/db/migrations, así que no se pudo comprobar el esquema',
        comoSeArregla: 'ejecutar el servidor desde el repositorio, o definir el directorio de trabajo',
      },
    ];
  }

  const enDisco = (await readdir(carpeta)).filter((n) => n.endsWith('.sql')).sort();

  // Se consulta por el mismo camino que todo lo demás —como `aai_app`, sin
  // empresa en contexto— y no con una conexión privilegiada aparte. Un arranque
  // que necesitara más permisos que la aplicación estaría comprobando una base
  // distinta de la que después va a usar.
  const ya = await withoutCompany('system:arranque', async (tx) => {
    const tabla = await tx.query<{ existe: boolean }>(
      `SELECT to_regclass('public.schema_migrations') IS NOT NULL AS existe`,
    );
    if (tabla.rows[0]?.existe !== true) return null;

    const aplicadas = await tx.query<{ name: string }>('SELECT name FROM schema_migrations');
    return new Set(aplicadas.rows.map((f) => f.name));
  });

  if (ya === null) {
    return [
      { que: 'la base no tiene ni una migración aplicada', comoSeArregla: 'npm run db:setup' },
    ];
  }

  return migracionesFaltantes(enDisco, ya);
}

/**
 * Con qué rol de PostgreSQL está corriendo la aplicación.
 *
 * Dos roles, y son distintos a propósito:
 *
 *     session_user  con el que conecta `DATABASE_URL`.
 *     current_user  el que queda adentro de `withCompany`/`withoutCompany`,
 *                   después del `SET LOCAL ROLE aai_app` de `tenancy.ts`.
 */
export interface RolesDeLaBase {
  readonly sesion: string;
  readonly efectivo: string;
  readonly sesionEsSuperusuario: boolean;
  readonly efectivoSalteaRls: boolean;
}

export async function rolesDeLaBase(): Promise<RolesDeLaBase> {
  return withoutCompany('system:arranque', async (tx) => {
    // `session_user` sigue siendo el de la conexión aunque este bloque ya haya
    // hecho `SET LOCAL ROLE`: es justamente lo que se quiere saber.
    const { rows } = await tx.query<{
      sesion: string;
      efectivo: string;
      sesion_super: boolean | null;
      efectivo_bypass: boolean | null;
    }>(
      `SELECT session_user::text                       AS sesion,
              current_user::text                       AS efectivo,
              (SELECT rolsuper     FROM pg_roles WHERE rolname = session_user) AS sesion_super,
              (SELECT rolbypassrls FROM pg_roles WHERE rolname = current_user) AS efectivo_bypass`,
    );
    const f = rows[0]!;
    return {
      sesion: f.sesion,
      efectivo: f.efectivo,
      // `null` sería no haber podido afirmar que NO es superusuario, y en una
      // comprobación de seguridad eso se trata como el caso peligroso.
      sesionEsSuperusuario: f.sesion_super !== false,
      efectivoSalteaRls: f.efectivo_bypass !== false,
    };
  });
}

/**
 * El aislamiento entre empresas no puede depender de dónde se despliegue.
 *
 * ## Lo que este control existe para impedir
 *
 * Todo el aislamiento de NEXO se apoya en RLS, y RLS **se evalúa contra el rol
 * que ejecuta la consulta**. Un rol con `BYPASSRLS` —o un superusuario— no ve
 * las políticas: las atraviesa. No falla nada, no hay error, no hay log: una
 * empresa ve los datos de otra y el sistema se comporta como si estuviera bien.
 *
 * `tenancy.ts` hace `SET LOCAL ROLE aai_app` en cada transacción, así que el rol
 * **efectivo** es el correcto aunque se conecte con otro. Eso es lo que hace que
 * la base de desarrollo pueda conectar como superusuario sin romper los tests.
 *
 * Pero en producción no alcanza, y por un motivo concreto: si el rol de la
 * conexión es superusuario, **cualquier consulta que se escriba fuera de esos
 * dos envoltorios corre sin ninguna política**. Hoy no hay ninguna; el control
 * está para el día que alguien agregue una sin darse cuenta.
 *
 * Por eso en producción se exige que la conexión **no sea superusuario** y que
 * el rol efectivo **no pueda saltear RLS**. Fuera de producción se informa y se
 * deja pasar: obligar a un rol dedicado para levantar el proyecto en una
 * máquina de desarrollo sería costo sin beneficio.
 */
export function problemasDelRol(
  roles: RolesDeLaBase,
  esProduccion: boolean,
): ProblemaDeArranque[] {
  if (!esProduccion) return [];
  const problemas: ProblemaDeArranque[] = [];

  if (roles.sesionEsSuperusuario) {
    problemas.push({
      que:
        `DATABASE_URL conecta como "${roles.sesion}", que es superusuario. En producción el ` +
        'aislamiento entre empresas quedaría a merced de que ninguna consulta se escriba ' +
        'fuera de withCompany/withoutCompany',
      // `aai_app` es NOLOGIN a propósito —es el rol al que se baja cada
      // transacción, no uno con el que se conecta—, así que decir «apuntá
      // DATABASE_URL a aai_app» sería mandar a hacer algo imposible. Hace falta
      // un rol de conexión que sea **miembro** suyo.
      comoSeArregla:
        'crear un rol de conexión sin SUPERUSER y miembro de aai_app, y apuntar DATABASE_URL ' +
        'ahí: CREATE ROLE nexo_app LOGIN PASSWORD \'…\' NOSUPERUSER NOBYPASSRLS NOCREATEDB; ' +
        'GRANT aai_app TO nexo_app;  (ver docs/DESPLIEGUE.md §6.1)',
    });
  }

  if (roles.efectivoSalteaRls) {
    problemas.push({
      que:
        `el rol efectivo "${roles.efectivo}" puede saltear RLS (BYPASSRLS). Las políticas por ` +
        'empresa no se le aplican: una empresa vería los datos de otra, sin error y sin rastro',
      comoSeArregla: 'ALTER ROLE ' + roles.efectivo + ' NOBYPASSRLS',
    });
  }

  return problemas;
}

/**
 * La comparación sola, sin base ni disco.
 *
 * Está separada para poder ejercitar **la rama roja**: contra una base migrada
 * al día, `verificarEsquema()` siempre devuelve la lista vacía, y un candado que
 * nunca se vio frenar no está probado. Acá se puede pasar el caso que en la vida
 * real solo aparece cuando ya es tarde.
 */
export function migracionesFaltantes(
  enDisco: readonly string[],
  aplicadas: ReadonlySet<string>,
): ProblemaDeArranque[] {
  const faltan = enDisco.filter((n) => !aplicadas.has(n));
  if (faltan.length === 0) return [];

  // Se nombran las primeras y se cuenta el resto: una lista de treinta archivos
  // en un mensaje de error es tan ilegible como no decir ninguno.
  const lista =
    faltan.length <= 3
      ? faltan.join(', ')
      : `${faltan.slice(0, 3).join(', ')} y ${faltan.length - 3} más`;

  return [
    {
      que: `faltan ${faltan.length} migración(es) en la base: ${lista}`,
      comoSeArregla: 'npm run db:migrate',
    },
  ];
}

/** Un modo de operación y si está realmente conectado a algo. */
export interface ModoDeOperacion {
  readonly nombre: string;
  readonly valor: string;
  readonly real: boolean;
  /** Qué falta para que `real` sea cierto, cuando falta algo. */
  readonly detalle?: string;
}

/**
 * El modo de la IA, que es el que más fácil miente.
 *
 * La versión anterior calculaba `real: config.ai.provider !== 'none' && !== 'mock'`,
 * y con eso `AI_PROVIDER=openai` informaba **IA: openai, real** mientras la
 * fábrica devolvía el proveedor deshabilitado. El sistema decía tener una
 * capacidad que no tenía, que es la peor clase de error que puede dar un
 * arranque: no falla, y nadie va a buscar por qué no aparecen las sugerencias.
 *
 * Ahora `real` significa una sola cosa: **hay transporte y hay con qué llamar**.
 * Ni siquiera eso es «conectado» —que la credencial exista no prueba que sirva,
 * y lo único que lo prueba es una llamada que volvió—, y por eso el detalle lo
 * dice con esas palabras.
 */
export function modoDeIa(ia: ConfiguracionDeIa): ModoDeOperacion {
  const estado = estadoDelProveedor(ia);

  if (estado === 'CONFIGURADO') {
    return {
      nombre: 'IA',
      valor: `${ia.provider} (${ia.modelId})`,
      real: true,
      detalle: 'configurado, sin verificar: una credencial cargada no prueba una conexión',
    };
  }

  if (estado === 'PREPARADO') {
    return {
      nombre: 'IA',
      valor: ia.provider,
      real: false,
      detalle: `preparado, no conectado: falta ${faltantesDeHttp(ia).join(', ')}`,
    };
  }

  return {
    nombre: 'IA',
    valor: ia.provider,
    real: false,
    detalle:
      estado === 'SIMULADO'
        ? 'el simulado se abstiene siempre: no proviene de ningún modelo'
        : 'sin IA externa; las sugerencias salen de la historia de la empresa',
  };
}

/**
 * En qué modo corre cada integración.
 *
 * `real: false` no es un error: son modos previstos (§8). Lo que sería un error
 * es que no se vieran.
 */
export function modosDeOperacion(config: {
  readonly arca: { readonly environment: string };
  readonly ai: ConfiguracionDeIa;
  readonly correo: ConfiguracionDeCorreo;
  readonly secrets: { readonly provider: string };
  readonly documents: { readonly ocrEngine: string };
  readonly isProduction: boolean;
}): ModoDeOperacion[] {
  return [
    {
      nombre: 'ARCA',
      valor: config.arca.environment,
      real: config.arca.environment === 'homologacion' || config.arca.environment === 'produccion',
    },
    { nombre: 'OCR', valor: config.documents.ocrEngine, real: config.documents.ocrEngine !== 'none' && config.documents.ocrEngine !== 'mock' },
    modoDeIa(config.ai),
    modoDeSecretos(config.secrets.provider),
    // El correo y el cobro faltaban en este banner hasta la auditoría B-2: se
    // recorrían las variables de entorno, y lo que no tenía variable no
    // aparecía. Eran justo los dos modos apagados del sistema entero, así que
    // el único lugar que existe para hacer visible un modo degradado callaba
    // los dos más degradados de todos.
    //
    // El correo dejó de ser fijo en B2.5.1, que es lo que aquella nota decía
    // que iba a pasar: ahora sale de la configuración, y conectar un proveedor
    // y decir que está conectado son el mismo cambio. El cobro sigue fijo
    // porque sigue sin haber pasarela.
    modoDeCorreo(config.correo),
    {
      nombre: 'cobro',
      valor: 'manual',
      real: false,
      detalle:
        'no hay pasarela: se emite y se lleva la cobranza, pero un cobro con tarjeta no se ' +
        'puede ejecutar. Una transferencia se registra a mano',
    },
    { nombre: 'entorno', valor: config.isProduction ? 'production' : 'development', real: true },
  ];
}
