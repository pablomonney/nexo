/**
 * S-45 — Toda conexión que decide o escribe una fecha de negocio la cuenta en hora argentina.
 *
 * ## El defecto que este control existe para que no vuelva
 *
 * Los arreglos de los defectos de fechas #3, #4 y #5 (2026-10-01) le preguntaban
 * `CURRENT_DATE` a la base y daban por hecho que la base estaba en hora
 * argentina. La de producción está en UTC (confirmado el 2026-10-05), así que
 * entre las 21:00 y las 24:00 ART seguía devolviendo la fecha de mañana. Los
 * tests pasaban porque la base de desarrollo está en `America/Buenos_Aires`.
 *
 * La base **no** se cambia —el hash de la cadena de auditoría dependía de la zona
 * de la sesión; ver las migraciones 0131 y 0132—. En su lugar cada conexión de la
 * aplicación pide su zona al abrirse (`initPool`). Este control comprueba, mirando
 * el código y no el reloj, que nadie abra una conexión sin hacerlo.
 *
 * ## Por qué mira el código y no el resultado
 *
 * Mismo argumento que S-37: un control que solo falla entre las 21:00 y las 24:00
 * es el que no estaba. El comportamiento real —que el pool *entregue* la zona— lo
 * prueba `tests/integration/zona-horaria-y-cadena.test.ts` con el entorno hostil.
 *
 * ## Lo que se endureció el 2026-10-07
 *
 * - El detector de conexiones ya no se conforma con que el archivo **mencione**
 *   `ZONA_DE_NEGOCIO` (un `import` sin uso alcanzaba, y el compilador solo avisa):
 *   mira los argumentos de cada `new Pool(` / `new Client(`.
 * - Se probó **al detector mismo** con casos que debe y no debe aceptar.
 * - Un script que **escribe** roles o cuentas (`valid_from DEFAULT CURRENT_DATE`)
 *   desde un cliente crudo en UTC deja la fila con la fecha de mañana, y la API
 *   —en hora argentina— le niega el acceso a quien acaba de recibirlo. No lo
 *   atrapaba la regla de «usa CURRENT_DATE» porque la dependencia es un DEFAULT
 *   de la tabla.
 */

import { readFile, readdir } from 'node:fs/promises';
import { dirname, join, relative, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { ZONA_DE_NEGOCIO } from '@aai/shared';
import { describe, expect, it } from 'vitest';
// @ts-expect-error — módulo .mjs sin tipos, a propósito: es JavaScript plano.
import * as zonaDeScripts from '../../scripts/lib/zona.mjs';

const RAIZ = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const SCRIPTS = join(RAIZ, 'scripts');

const soloCodigo = (fuente: string): string =>
  fuente.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:])\/\/.*$/gm, '$1');

/**
 * Cuántas conexiones (`new Pool(` / `new pg.Client(` …) de `fuente` no piden la
 * zona de negocio en sus **propios argumentos**.
 *
 * Una conexión pide la zona si sus argumentos llevan `timezone=${ZONA_DE_NEGOCIO}`
 * o `...opcionesDeConexion()`. Los argumentos se leen con paréntesis balanceados
 * (pueden ocupar varias líneas), y una conexión sin objeto de opciones —
 * `new pg.Client(URL)`— no la pide.
 */
export function conexionesSinZona(fuenteConComentarios: string): number {
  const fuente = soloCodigo(fuenteConComentarios);
  const abre = /new\s+(?:pg\.)?(?:Pool|Client)\s*\(/g;
  let sinZona = 0;
  for (let m = abre.exec(fuente); m !== null; m = abre.exec(fuente)) {
    let profundidad = 1;
    let i = m.index + m[0].length;
    const inicio = i;
    for (; i < fuente.length && profundidad > 0; i += 1) {
      if (fuente[i] === '(') profundidad += 1;
      if (fuente[i] === ')') profundidad -= 1;
    }
    const argumentos = fuente.slice(inicio, i - 1);
    const conLaConstante = /timezone=\$\{ZONA_DE_NEGOCIO\}/.test(argumentos);
    const conElHelper = /\.\.\.\s*opcionesDeConexion\(\)/.test(argumentos);
    // Una zona escrita a mano que no sea la constante («-c timezone=UTC») es peor que
    // no pedir ninguna: parece cuidada. Y el helper devuelve `options`: una clave
    // `options:` propia la pisa.
    const zonaAjena = /timezone\s*=\s*(?!\$\{ZONA_DE_NEGOCIO\})/i.test(argumentos);
    const pisaElHelper = conElHelper && /\boptions\s*:/.test(argumentos);
    if (!(conLaConstante || conElHelper) || zonaAjena || pisaElHelper) sinZona += 1;
  }
  return sinZona;
}

async function fuentesTs(carpeta: string): Promise<string[]> {
  const salida: string[] = [];
  async function recorrer(directorio: string): Promise<void> {
    for (const entrada of await readdir(directorio, { withFileTypes: true })) {
      const completo = join(directorio, entrada.name);
      if (entrada.isDirectory()) {
        if (entrada.name === 'node_modules' || entrada.name === 'dist') continue;
        await recorrer(completo);
      } else if (entrada.name.endsWith('.ts') && !entrada.name.endsWith('.test.ts')) {
        salida.push(completo);
      }
    }
  }
  await recorrer(join(RAIZ, carpeta));
  return salida;
}

/** Los scripts que deciden, comparan o escriben fechas de negocio y por eso piden la zona. */
const CON_ZONA = [
  'facturacion-ciclo.mjs',
  'sembrar-comercial-b1.mjs',
  'declarar-plan-de-pasarela.mjs',
  'ensayo-de-pagos.mjs',
  'metricas-saas.mjs',
  'factura-demo.mjs',
  'fixtures-invariantes.mjs',
] as const;

/**
 * Scripts que mencionan la fecha de la base, o escriben roles o cuentas, y
 * **no** necesitan la zona, con el motivo. Una excepción sin motivo es una puerta abierta.
 */
const SIN_ZONA_CON_MOTIVO: Readonly<Record<string, string>> = {
  'bench-vistas.mjs':
    'Genera datos sintéticos para medir el rendimiento de las vistas: las fechas son relativas a ' +
    '`current_date` y nadie las compara contra una fecha del negocio.',
  'verificar-zona-de-negocio.mjs':
    'Es la comprobación de la zona: abre una conexión con `initPool` (que pide la zona) y, ' +
    'a propósito, otra conexión cruda sin ella, como control. Es de solo lectura.',
};

/** Escribir roles o cuentas deja `valid_from DEFAULT CURRENT_DATE` en la zona de quien escribe. */
const ESCRIBE_FECHAS_POR_DEFECTO =
  /grant_company_role\(|create_company\(|INSERT\s+INTO\s+(?:user_company_roles|accounts)\b/i;

describe('S-45 — el detector de conexiones sin zona (se prueba a sí mismo)', () => {
  it.each([
    ['pool con la zona', 'new pg.Pool({ connectionString, options: `-c timezone=${ZONA_DE_NEGOCIO}` })', 0],
    ['pool sin la zona', 'new pg.Pool({ connectionString })', 1],
    [
      'import de la constante SIN usarla',
      "import { ZONA_DE_NEGOCIO } from '@aai/shared';\nconst p = new pg.Pool({ connectionString });",
      1,
    ],
    ['la constante solo en un comentario', '// ZONA_DE_NEGOCIO\nnew pg.Pool({ connectionString })', 1],
    ['cliente de script con el helper', 'new pg.Client({ connectionString: u, ...opcionesDeConexion() })', 0],
    ['cliente de script sin opciones', 'new pg.Client(URL_BASE)', 1],
    ['cliente de script con opciones propias', 'new pg.Client({ connectionString: u })', 1],
    [
      'varias líneas, con la zona',
      'new pg.Pool({\n  connectionString,\n  max: 10,\n  options: `-c timezone=${ZONA_DE_NEGOCIO}`,\n})',
      0,
    ],
    [
      'una con zona y una sin ella en el mismo archivo',
      'new pg.Pool({ options: `-c timezone=${ZONA_DE_NEGOCIO}` });\nnew Client({ connectionString })',
      1,
    ],
    ['sin conexiones', 'const x = 1;', 0],
    ['una zona equivocada (UTC)', "new pg.Pool({ connectionString, options: '-c timezone=UTC' })", 1],
    ['otra zona de Argentina escrita a mano', "new pg.Client({ options: '-c timezone=America/Buenos_Aires' })", 1],
    [
      'la zona correcta y otra equivocada en la misma conexión',
      'new pg.Pool({ options: `-c timezone=${ZONA_DE_NEGOCIO} -c timezone=UTC` })',
      1,
    ],
    ['el helper pisado por otra `options`', "new pg.Client({ ...opcionesDeConexion(), options: '-c timezone=UTC' })", 1],
    [
      'una segunda conexión (réplica) sin zona',
      'const a = new pg.Pool({ options: `-c timezone=${ZONA_DE_NEGOCIO}` });\nconst b = new pg.Pool({ connectionString: replica });',
      1,
    ],
    ['cliente crudo sin argumentos (toma PGOPTIONS del entorno)', 'const c = new Client();', 1],
    ['configuración en una variable', 'new pg.Pool(config)', 1],
    [
      'dos conexiones, las dos con zona',
      'new pg.Pool({ options: `-c timezone=${ZONA_DE_NEGOCIO}` });\nnew pg.Client({ ...opcionesDeConexion() });',
      0,
    ],
  ])('%s', (_nombre, fuente, esperadas) => {
    expect(conexionesSinZona(fuente)).toBe(esperadas);
  });
});

describe('S-45 — la zona de negocio en las conexiones', () => {
  it('la constante de los scripts es la misma que la de la aplicación', () => {
    // Está repetida a propósito (los scripts son JavaScript plano); esto es lo
    // que impide que las dos copias se separen.
    expect(zonaDeScripts.ZONA_DE_NEGOCIO).toBe(ZONA_DE_NEGOCIO);
    expect(zonaDeScripts.opcionesDeConexion()).toEqual({
      options: `-c timezone=${ZONA_DE_NEGOCIO}`,
    });
  });

  it('todo `new pg.Pool/Client` del código de la aplicación fija la zona de negocio', async () => {
    const archivos = [
      ...(await fuentesTs('apps/api/src')),
      ...(await fuentesTs('packages')).filter((f) => f.includes(`${sep}src${sep}`)),
    ];
    expect(archivos.length).toBeGreaterThan(50);

    const sinZona: string[] = [];
    let conConexion = 0;
    for (const archivo of archivos) {
      const fuente = await readFile(archivo, 'utf8');
      if (!/new\s+(?:pg\.)?(?:Pool|Client)\s*\(/.test(soloCodigo(fuente))) continue;
      conConexion += 1;
      if (conexionesSinZona(fuente) > 0) sinZona.push(relative(RAIZ, archivo).split(sep).join('/'));
    }

    // Que el barrido vea al menos el pool de `@aai/db`: si no lo ve, no prueba nada.
    expect(conConexion).toBeGreaterThanOrEqual(1);
    expect(
      sinZona,
      'Estos archivos abren una conexión a PostgreSQL sin la zona de negocio, así que ' +
        '`CURRENT_DATE` vuelve la fecha de UTC. Pasá `options: `-c timezone=${ZONA_DE_NEGOCIO}``:\n  ' +
        sinZona.join('\n  '),
    ).toEqual([]);
  });

  it('`initPool` pasa la zona como parámetro de arranque de la conexión', async () => {
    const fuente = soloCodigo(await readFile(join(RAIZ, 'packages/db/src/tenancy.ts'), 'utf8'));
    expect(fuente).toMatch(/options:\s*`-c timezone=\$\{ZONA_DE_NEGOCIO\}`/);
  });

  it.each(CON_ZONA)('%s abre TODAS sus conexiones con la zona de negocio', async (archivo) => {
    const fuente = await readFile(join(SCRIPTS, archivo), 'utf8');
    const codigo = soloCodigo(fuente);
    expect(codigo, `${archivo} no importa lib/zona.mjs`).toMatch(/lib\/zona\.mjs/);
    expect(codigo, `${archivo} no abre ninguna conexión con pg.Client`).toMatch(/new pg\.Client\(/);
    expect(conexionesSinZona(fuente), `${archivo} tiene un pg.Client sin la zona`).toBe(0);
  });

  it('todo script que usa la fecha de la base o escribe roles/cuentas pide la zona o está justificado', async () => {
    const archivos = (await readdir(SCRIPTS)).filter((f) => f.endsWith('.mjs'));
    const sinResolver: string[] = [];

    for (const archivo of archivos) {
      const fuente = soloCodigo(await readFile(join(SCRIPTS, archivo), 'utf8'));
      if (!/current_date/i.test(fuente) && !ESCRIBE_FECHAS_POR_DEFECTO.test(fuente)) continue;
      if ((CON_ZONA as readonly string[]).includes(archivo)) continue;
      if (archivo in SIN_ZONA_CON_MOTIVO) continue;
      sinResolver.push(archivo);
    }

    expect(
      sinResolver,
      'Estos scripts usan `CURRENT_DATE` o escriben roles o cuentas (`valid_from DEFAULT ' +
        'CURRENT_DATE`) y no piden la zona de negocio: en producción (UTC) darían la fecha de ' +
        'mañana entre las 21:00 y las 24:00 ART. Agregalos a CON_ZONA (y usá ' +
        '`opcionesDeConexion()`) o a SIN_ZONA_CON_MOTIVO con el motivo:\n  ' +
        sinResolver.join('\n  '),
    ).toEqual([]);
  });

  it('la lista de excepciones no acumula scripts que ya no la necesitan', async () => {
    const sobran: string[] = [];
    for (const archivo of Object.keys(SIN_ZONA_CON_MOTIVO)) {
      let fuente: string;
      try {
        fuente = soloCodigo(await readFile(join(SCRIPTS, archivo), 'utf8'));
      } catch {
        sobran.push(`${archivo}: ya no existe`);
        continue;
      }
      if (!/current_date/i.test(fuente) && !ESCRIBE_FECHAS_POR_DEFECTO.test(fuente)) {
        sobran.push(`${archivo}: ya no usa la fecha de la base ni escribe roles o cuentas`);
      }
    }
    expect(sobran, `Sacalos de SIN_ZONA_CON_MOTIVO:\n  ${sobran.join('\n  ')}`).toEqual([]);
  });

  it('`backup-db.mjs` sigue en UTC a propósito', async () => {
    // Sus archivos se nombran con el sello UTC (`…T023159Z`), igual que los del
    // servidor. Si alguien le pone la zona de negocio "por consistencia", los
    // nombres dejan de ordenarse junto a los automáticos.
    const fuente = soloCodigo(await readFile(join(SCRIPTS, 'backup-db.mjs'), 'utf8'));
    expect(fuente).not.toContain('opcionesDeConexion');
  });

  it('los clientes crudos de los tests escriben en la zona del negocio (setup-env)', () => {
    // Si `tests/setup-env.ts` deja de fijar PGOPTIONS, los fixtures vuelven a
    // crear roles con `valid_from` de mañana entre las 21:00 y las 24:00 ART y
    // la suite se pone roja solo a esa hora.
    expect(process.env['PGOPTIONS']).toBe(`-c timezone=${ZONA_DE_NEGOCIO}`);
  });
});
