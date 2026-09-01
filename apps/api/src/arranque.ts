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
}

/**
 * En qué modo corre cada integración.
 *
 * `real: false` no es un error: son modos previstos (§8). Lo que sería un error
 * es que no se vieran.
 */
export function modosDeOperacion(config: {
  readonly arca: { readonly environment: string };
  readonly ai: { readonly provider: string };
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
    { nombre: 'IA', valor: config.ai.provider, real: config.ai.provider !== 'none' && config.ai.provider !== 'mock' },
    { nombre: 'entorno', valor: config.isProduction ? 'production' : 'development', real: true },
  ];
}
