/**
 * S-38 — `.env.example` dice la verdad sobre lo que el sistema lee.
 *
 * ## El hallazgo que este control existe para que no vuelva
 *
 * La auditoría B-2 comparó, por primera vez, las variables que `.env.example`
 * declara contra las que el código realmente lee. **No coincidían en ninguno de
 * los dos sentidos.**
 *
 * Declaradas y que nadie leía —siete—:
 *
 *     REDIS_URL                 no hay colas: nada las usa
 *     S3_ENDPOINT / S3_BUCKET
 *     S3_ACCESS_KEY / S3_SECRET_KEY
 *                               los documentos van al disco local, por
 *                               DOCUMENT_STORAGE_PATH. Quien levantara un MinIO
 *                               y llenara estas cuatro habría creído que los
 *                               comprobantes de sus clientes viajaban ahí
 *     OCR_PROVIDER=local        el código lee OCR_ENGINE. El nombre no existía,
 *                               y el comentario prometía Tesseract, que no está
 *     ARCA_KMS_KEY_ID           el código lee ARCA_LOCAL_KEK
 *
 * Leídas y no declaradas —dieciséis—, entre ellas tres que deciden si el
 * despliegue arranca o si queda a oscuras: `MFA_ENCRYPTION_KEY` (obligatoria en
 * producción: sin ella el servidor **no arranca**), `ARCA_LOCAL_KEK` y
 * `METRICS_TOKEN` (sin ella `GET /metrics` no existe, así que un despliegue
 * hecho desde la plantilla queda sin observabilidad y nadie se entera).
 *
 * `docs/DESPLIEGUE.md` §2 las tenía todas y bien. El que estaba desactualizado
 * era el archivo que alguien copia, que es el que se usa: **la plantilla es
 * documentación ejecutable, y una documentación ejecutable equivocada no se lee
 * como un error sino como una instrucción.**
 *
 * ## Por qué el control mira el repositorio y no un despliegue
 *
 * No se puede comprobar contra un `.env` real: no está en el repositorio, y no
 * tiene que estar. Lo que sí se puede comprobar es que las dos listas que el
 * repositorio sí tiene —la plantilla y `process.env.X` en el código— digan lo
 * mismo. Es el mismo criterio que S-37: mirar lo que no depende de dónde corra.
 */

import { readFile, readdir } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const RAIZ = join(dirname(fileURLToPath(import.meta.url)), '..', '..');

/** Dónde se busca `process.env`. Es donde vive todo el código que corre. */
const CARPETAS = ['apps', 'packages', 'scripts'] as const;

/**
 * Lo que el código lee y la plantilla NO declara, con el motivo.
 *
 * Cada excepción tiene que ser una variable que **no se configura en un
 * despliegue**: la pone el entorno, el sistema operativo o quien corre una
 * herramienta a mano. Una variable de despliegue no entra acá: entra en la
 * plantilla.
 */
const NO_VA_EN_LA_PLANTILLA: Readonly<Record<string, string>> = {
  NODE_ENV:
    'La pone el proceso o el orquestador, no el archivo de configuración. ' +
    'docs/DESPLIEGUE.md §2 la documenta como obligatoria en producción.',
  USER: 'La del sistema operativo. Se usa para saber quién corrió un script.',
  USERNAME: 'La misma, en Windows.',
  PG_BIN:
    'Dónde están psql y pg_dump cuando no están en el PATH. Es una comodidad ' +
    'de la máquina de quien desarrolla, no un ajuste del servicio.',
  ARCA_TA_CACHE:
    'Dónde guarda los tickets de WSAA un script que se corre a mano. El ' +
    'servidor no la lee.',
  NEXO_BACKUP_DIR:
    'Dónde deja las copias el script de backup. Es de la máquina que las ' +
    'corre —que no es la que sirve la API—.',
};

/** Las variables que declara la plantilla, en orden de aparición. */
async function declaradas(): Promise<string[]> {
  const texto = await readFile(join(RAIZ, '.env.example'), 'utf8');
  const nombres: string[] = [];
  for (const linea of texto.split('\n')) {
    const m = /^([A-Z][A-Z0-9_]*)=/u.exec(linea.trim());
    if (m?.[1] !== undefined) nombres.push(m[1]);
  }
  return nombres;
}

/** Todo archivo de código bajo las carpetas que corren. */
async function fuentes(): Promise<string[]> {
  const encontrados: string[] = [];

  async function recorrer(carpeta: string): Promise<void> {
    for (const entrada of await readdir(carpeta, { withFileTypes: true })) {
      const ruta = join(carpeta, entrada.name);
      if (entrada.isDirectory()) {
        // `dist` es la copia compilada: contarla duplicaría cada hallazgo y
        // haría que una variable borrada del fuente siguiera apareciendo hasta
        // la próxima compilación.
        if (entrada.name === 'node_modules' || entrada.name === 'dist') continue;
        await recorrer(ruta);
        continue;
      }
      if (/\.(ts|mjs|js)$/u.test(entrada.name)) encontrados.push(ruta);
    }
  }

  for (const c of CARPETAS) await recorrer(join(RAIZ, c));
  return encontrados;
}

/** Nombre de variable → los archivos donde se lee. */
async function leidas(): Promise<Map<string, string[]>> {
  const mapa = new Map<string, string[]>();
  for (const archivo of await fuentes()) {
    const texto = await readFile(archivo, 'utf8');
    for (const m of texto.matchAll(/process\.env\.([A-Z][A-Z0-9_]*)/gu)) {
      const nombre = m[1]!;
      const donde = mapa.get(nombre) ?? [];
      donde.push(archivo.slice(RAIZ.length + 1).replace(/\\/gu, '/'));
      mapa.set(nombre, donde);
    }
  }
  return mapa;
}

describe('S-38 — la plantilla de configuración y el código dicen lo mismo', () => {
  it('toda variable que la plantilla declara la lee alguien', async () => {
    const lee = await leidas();
    const fantasmas = (await declaradas()).filter((v) => !lee.has(v));

    expect(
      fantasmas,
      'La plantilla declara estas variables y ningún archivo las lee. Quien despliegue ' +
        'siguiendo el ejemplo va a configurar algo que no hace nada —y, peor, va a creer ' +
        'que el sistema usa una pieza de infraestructura que no usa—. Sacalas de ' +
        '.env.example, o conectá lo que prometen:\n  ' +
        fantasmas.join('\n  '),
    ).toEqual([]);
  });

  it('toda variable que el código lee está declarada o tiene motivo para no estarlo', async () => {
    const declaradasAhora = new Set(await declaradas());
    const faltantes: string[] = [];

    for (const [nombre, donde] of await leidas()) {
      if (declaradasAhora.has(nombre)) continue;
      if (nombre in NO_VA_EN_LA_PLANTILLA) continue;
      faltantes.push(`${nombre} — se lee en ${donde.slice(0, 3).join(', ')}`);
    }

    expect(
      faltantes.sort(),
      'El código lee estas variables y la plantilla no las nombra. Quien despliegue copiando ' +
        '.env.example no las va a poner, y va a descubrir cuáles eran importantes cuando algo ' +
        'no arranque o quede apagado en silencio. Agregalas con su consecuencia, o poné el ' +
        'motivo en NO_VA_EN_LA_PLANTILLA:\n  ' +
        faltantes.join('\n  '),
    ).toEqual([]);
  });

  it('la lista de excepciones no acumula variables que ya nadie lee', async () => {
    // El otro lado del control: una excepción que sobra es un permiso que
    // nadie recuerda haber dado.
    const lee = await leidas();
    const sobran = Object.keys(NO_VA_EN_LA_PLANTILLA).filter((v) => !lee.has(v));
    expect(sobran, `Sacá estas de NO_VA_EN_LA_PLANTILLA:\n  ${sobran.join('\n  ')}`).toEqual([]);
  });

  it('las tres que deciden el arranque en producción están nombradas', async () => {
    // El caso concreto que motivó el control, fijado aparte de la regla
    // general: si alguien relajara la comparación, esto lo sigue viendo.
    const texto = await readFile(join(RAIZ, '.env.example'), 'utf8');
    for (const critica of ['MFA_ENCRYPTION_KEY', 'METRICS_TOKEN', 'ARCA_LOCAL_KEK']) {
      expect(texto, `${critica} no figura en la plantilla`).toContain(critica);
    }
  });
});
