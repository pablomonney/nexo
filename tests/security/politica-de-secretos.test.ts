/**
 * S-40 — La política de secretos dice la verdad sobre el comportamiento.
 *
 * `apps/api/src/secrets/inventario.ts` clasifica cada variable que la aplicación
 * lee: qué tan sensible es, si su ausencia impide arrancar, y dónde va a vivir
 * el día que haya un gestor de secretos.
 *
 * Una clasificación así **se pudre sola** si nadie la contrasta. Este archivo la
 * contrasta contra tres cosas distintas, y las tres importan por separado:
 *
 *   1. **Contra el código.** Toda variable que alguien lee está clasificada, y
 *      ninguna clasificada dejó de leerse. Es la lección de la auditoría B-2:
 *      `.env.example` y el código habían dejado de coincidir en los dos
 *      sentidos y nadie lo vio hasta compararlos.
 *   2. **Contra el comportamiento.** Lo que se declara imprescindible **de
 *      verdad impide arrancar**, y lo que se declara opcional **de verdad deja
 *      arrancar**. Sin esto, «opcional» sería una opinión escrita al lado de la
 *      variable.
 *   3. **Contra sí misma.** Que la clasificación sea coherente: nada crítico
 *      puede quedar declarado como que va al entorno del despliegue.
 *
 * ## Por qué el punto 2 se prueba importando `config.ts` en un proceso aparte
 *
 * Porque `config` se evalúa **al importarse** y queda en la caché de módulos:
 * una vez cargado, cambiar `process.env` no lo altera. Y es correcto que sea
 * así —la configuración de un proceso no cambia a mitad de camino—, así que
 * para preguntar «¿arranca sin esta variable?» hay que arrancar de verdad. Se
 * hace con un `node -e` corto, sin base de datos y sin red.
 */

import { execFileSync } from 'node:child_process';
import { readFile, readdir } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import {
  AL_GESTOR,
  IMPRESCINDIBLES,
  INVENTARIO_DE_SECRETOS,
} from '@aai/api/secrets/inventario';

const RAIZ = join(dirname(fileURLToPath(import.meta.url)), '..', '..');

/** Dónde vive el código que corre dentro del servidor. */
const DEL_SERVIDOR = ['apps', 'packages'] as const;

/**
 * Variables que el proceso del servidor lee y que **no** son suyas.
 *
 * Las pone el sistema operativo o quien ejecuta, no el despliegue. Clasificar
 * `USER` como un secreto de NEXO sería ruido.
 */
const AJENAS: Readonly<Record<string, string>> = {
  USER: 'la del sistema operativo, para saber quién corrió algo',
  USERNAME: 'la misma, en Windows',
  PG_BIN: 'dónde están psql y pg_dump en la máquina de quien desarrolla',
  NEXO_BACKUP_DIR: 'dónde deja las copias el script de backup',
  ARCA_TA_CACHE: 'dónde guarda los tickets un script que se corre a mano',
  SANDBOX_DATABASE_URL: 'la lee `scripts/sandbox.mjs`; está en DE_LOS_COMANDOS',
};

async function fuentesDelServidor(): Promise<string[]> {
  const encontrados: string[] = [];

  async function recorrer(carpeta: string): Promise<void> {
    for (const entrada of await readdir(carpeta, { withFileTypes: true })) {
      const ruta = join(carpeta, entrada.name);
      if (entrada.isDirectory()) {
        if (entrada.name === 'node_modules' || entrada.name === 'dist') continue;
        await recorrer(ruta);
        continue;
      }
      // Los tests declaran variables para sus propios fixtures; no son
      // configuración del servidor.
      if (entrada.name.endsWith('.test.ts')) continue;
      if (/\.(ts|mjs|js)$/u.test(entrada.name)) encontrados.push(ruta);
    }
  }

  for (const c of DEL_SERVIDOR) await recorrer(join(RAIZ, c));
  return encontrados;
}

async function leidasPorElServidor(): Promise<Map<string, string[]>> {
  const mapa = new Map<string, string[]>();
  for (const archivo of await fuentesDelServidor()) {
    const texto = await readFile(archivo, 'utf8');

    // Dos formas de leer una variable, y hacen falta las dos.
    //
    // La segunda —`required('DATABASE_URL')`— la descubrió este control al
    // correrse por primera vez: buscando solo `process.env.X` daba por no
    // leídas las dos variables **más** críticas del sistema, porque `config.ts`
    // las pide por el ayudante que además falla si no están.
    for (const patron of [
      /process\.env\.([A-Z][A-Z0-9_]*)/gu,
      /\brequired\(\s*['"]([A-Z][A-Z0-9_]*)['"]\s*\)/gu,
    ]) {
      for (const m of texto.matchAll(patron)) {
        const donde = mapa.get(m[1]!) ?? [];
        donde.push(archivo.slice(RAIZ.length + 1).replace(/\\/gu, '/'));
        mapa.set(m[1]!, donde);
      }
    }
  }
  return mapa;
}

/**
 * Arranca un proceso que solo importa `config.ts`, con el entorno que se le dé.
 *
 * Devuelve `null` si cargó, o el mensaje del error si se negó. No toca la base:
 * `config` no conecta, solo lee variables.
 */
function cargaConfig(entorno: Record<string, string | undefined>): string | null {
  const guion =
    "import('./apps/api/dist/config.js')" +
    ".then(() => { console.log('CARGO'); })" +
    '.catch((e) => { console.log(\'FALLO:\' + e.message); });';

  const limpio: Record<string, string> = {};
  for (const [k, v] of Object.entries({ ...process.env, ...entorno })) {
    if (v !== undefined) limpio[k] = v;
  }
  for (const [k, v] of Object.entries(entorno)) {
    if (v === undefined) delete limpio[k];
  }

  const salida = execFileSync(process.execPath, ['--input-type=module', '-e', guion], {
    cwd: RAIZ,
    env: limpio,
    encoding: 'utf8',
  }).trim();

  return salida.startsWith('FALLO:') ? salida.slice('FALLO:'.length) : null;
}

/** Un entorno de producción mínimo y **completamente sintético**. */
const PRODUCCION_MINIMA = {
  NODE_ENV: 'production',
  DATABASE_URL: 'postgres://usuario:TEST_SECRET_ONLY@localhost:5432/nada',
  MFA_ENCRYPTION_KEY: Buffer.alloc(32, 7).toString('base64'),
};

describe('S-40 — el inventario cubre lo que la aplicación lee', () => {
  it('toda variable que el servidor lee está clasificada', async () => {
    const declaradas = new Set(INVENTARIO_DE_SECRETOS.map((s) => s.variable));
    const faltan: string[] = [];

    for (const [nombre, donde] of await leidasPorElServidor()) {
      if (declaradas.has(nombre) || nombre in AJENAS) continue;
      faltan.push(`${nombre} — se lee en ${donde.slice(0, 2).join(', ')}`);
    }

    expect(
      faltan.sort(),
      'Estas variables las lee el servidor y nadie dijo si son secretas. Clasificalas en ' +
        '`apps/api/src/secrets/inventario.ts`: hay que decidir si su ausencia impide arrancar ' +
        'y si van a un gestor de secretos, y esa decisión no se puede posponer hasta que ' +
        'alguien filtre una:\n  ' +
        faltan.join('\n  '),
    ).toEqual([]);
  });

  it('ninguna clasificada dejó de leerse', async () => {
    // El otro lado: una entrada que sobra es una variable que alguien va a
    // configurar en producción creyendo que hace algo.
    const lee = await leidasPorElServidor();
    const sobran = INVENTARIO_DE_SECRETOS.filter((s) => !lee.has(s.variable)).map(
      (s) => s.variable,
    );

    expect(sobran, `Sacá estas del inventario, ya no las lee nadie:\n  ${sobran.join('\n  ')}`).toEqual(
      [],
    );
  });

  it('la clasificación es coherente consigo misma', () => {
    const incoherentes: string[] = [];

    for (const s of INVENTARIO_DE_SECRETOS) {
      // Algo crítico guardado en el entorno del despliegue es exactamente lo
      // que un gestor de secretos existe para evitar.
      if (s.sensibilidad === 'CRITICO' && s.destino !== 'GESTOR') {
        incoherentes.push(`${s.variable}: es CRITICO y su destino es ${s.destino}`);
      }
      // Y al revés: si impide arrancar, no puede ser mera configuración.
      if (s.impideArrancar && s.sensibilidad === 'CONFIGURACION') {
        incoherentes.push(`${s.variable}: impide arrancar y está declarada CONFIGURACION`);
      }
      if (s.uso.trim().length < 10) {
        incoherentes.push(`${s.variable}: el uso no dice nada`);
      }
    }

    expect(incoherentes, incoherentes.join('\n  ')).toEqual([]);
  });
});

describe('S-40 — lo declarado imprescindible impide arrancar de verdad', () => {
  it('el entorno de producción mínimo carga', () => {
    // El control positivo, y va primero: sin él, un `config.ts` que fallara
    // siempre haría pasar todos los casos de abajo.
    expect(cargaConfig(PRODUCCION_MINIMA)).toBeNull();
  });

  it.each(IMPRESCINDIBLES)('sin %s, producción no arranca', (variable) => {
    const error = cargaConfig({ ...PRODUCCION_MINIMA, [variable]: undefined });

    expect(
      error,
      `«${variable}» está declarada como que impide arrancar y el proceso cargó igual. ` +
        'O falta la comprobación en config.ts, o la declaración del inventario es falsa.',
    ).not.toBeNull();
    expect(error).toContain(variable);
  });

  it('una clave de MFA con el largo equivocado tampoco pasa', () => {
    // No alcanza con que esté: 16 bytes en base64 es una variable presente y
    // una clave inservible, y el error aparecería recién al cifrar un TOTP.
    const error = cargaConfig({
      ...PRODUCCION_MINIMA,
      MFA_ENCRYPTION_KEY: Buffer.alloc(16, 1).toString('base64'),
    });
    expect(error).toContain('32 bytes');
  });
});

describe('S-40 — lo declarado opcional deja arrancar de verdad', () => {
  /**
   * Las credenciales de las integraciones, una por una.
   *
   * Que NEXO arranque sin ellas no es una comodidad: es lo que hace que `none`
   * sea un **modo de operación** y no una avería. Un sistema contable completo
   * tiene que poder correr sin proveedor de correo, sin modelo y sin OCR, y
   * decir en qué modo está.
   */
  const OPCIONALES = INVENTARIO_DE_SECRETOS.filter(
    (s) => s.sensibilidad === 'CRITICO' && !s.impideArrancar,
  ).map((s) => s.variable);

  it('hay integraciones opcionales declaradas', () => {
    // Si esta lista quedara vacía, los casos de abajo no probarían nada.
    expect(OPCIONALES.length).toBeGreaterThan(0);
  });

  it.each(OPCIONALES)('sin %s, el servidor arranca igual', (variable) => {
    expect(
      cargaConfig({ ...PRODUCCION_MINIMA, [variable]: undefined }),
      `«${variable}» está declarada opcional y su ausencia impidió cargar la configuración. ` +
        'Una integración sin credencial tiene que degradar a un modo declarado, no romper.',
    ).toBeNull();
  });

  it('sin ninguna credencial de integración, la configuración carga', () => {
    // Todas juntas: es el despliegue del día uno, antes de contratar nada.
    const sinNinguna: Record<string, undefined> = {};
    for (const v of OPCIONALES) sinNinguna[v] = undefined;

    expect(cargaConfig({ ...PRODUCCION_MINIMA, ...sinNinguna })).toBeNull();
  });
});

describe('S-40 — qué va a un gestor de secretos', () => {
  it('lo que va al gestor son credenciales y material, no configuración', () => {
    // La lista se usa para saber qué hay que cargar el día que se conecte uno.
    // Si se colara un timeout, alguien iría a buscarlo al gestor.
    expect(AL_GESTOR).toContain('DATABASE_URL');
    expect(AL_GESTOR).toContain('MFA_ENCRYPTION_KEY');
    expect(AL_GESTOR).toContain('EMAIL_API_KEY');
    expect(AL_GESTOR).toContain('AI_API_KEY');
    expect(AL_GESTOR).toContain('ARCA_LOCAL_KEK');

    for (const suelto of ['PORT', 'AI_TIMEOUT_MS', 'EMAIL_FROM', 'AI_API_KEY_REF']) {
      expect(AL_GESTOR, `${suelto} no es material: no va a un gestor de secretos`).not.toContain(
        suelto,
      );
    }
  });

  it('una referencia nunca es un secreto', () => {
    // Es la distinción sobre la que se apoya `secret_refs`, que no tiene
    // columna donde poner material. Si `AI_API_KEY_REF` se clasificara como
    // crítica, la tabla de referencias pasaría a ser una tabla de secretos.
    for (const ref of ['AI_API_KEY_REF', 'EMAIL_API_KEY_REF']) {
      const declarada = INVENTARIO_DE_SECRETOS.find((s) => s.variable === ref);
      expect(declarada?.sensibilidad, `${ref} dice dónde está el secreto, no cuál es`).toBe(
        'CONFIGURACION',
      );
    }
  });
});
