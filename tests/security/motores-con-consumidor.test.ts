/**
 * S-16 — un motor sin consumidor es un motor que no existe.
 *
 * ## El defecto que este barrido persigue
 *
 * Es el que este repositorio encontró **cinco veces**, siempre con la misma
 * forma: una pieza construida, probada, con su tabla esperándola, y nadie
 * recorriendo el camino entre las dos.
 *
 *   - `@aai/audit-engine` con cero consumidores.
 *   - `armarLineas` inyectado como `() => []`.
 *   - `bank_reconciliations` sin ningún INSERT.
 *   - El signo de la nota de crédito archivado y sin usar por veinte migraciones.
 *   - El **respondedor** de `@aai/ai-engine`: 281 líneas, con tests, con su
 *     tabla `ai_answers` desde la migración 0027, y ningún endpoint que lo
 *     llamara.
 *
 * Las cinco veces lo encontró una persona leyendo, no un control. Este es el
 * control: cada función exportada por un paquete tiene que ser usada por algo
 * que no sea el propio paquete ni sus tests.
 *
 * ## Qué cuenta como consumidor
 *
 * Cualquier archivo que **no sea un test** y que no sea el que la define: la
 * API, la consola, un script, otro paquete, u otra función del mismo paquete.
 *
 * Que los tests no cuenten es toda la regla. Un motor probado y no usado es
 * exactamente el defecto que se busca; si sus tests contaran, el barrido lo
 * daría por bueno — que es lo que pasó cinco veces.
 *
 * Que una función del mismo paquete sí cuente no debilita el control: si nadie
 * usa a la que la usa, esa otra aparece en la lista. El barrido nombra la punta
 * de la cadena muerta, que es donde hay que mirar.
 *
 * ## Qué no mira
 *
 * Tipos e interfaces: existen para describir, y una que solo usa el paquete que
 * la define no es un motor muerto. Y las funciones que un test declara como
 * excepción, cada una con su motivo escrito.
 */

import { readdir, readFile } from 'node:fs/promises';
import { dirname, join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const RAIZ = join(dirname(fileURLToPath(import.meta.url)), '..', '..');

/**
 * Lo exportado que todavía no tiene consumidor, con el motivo.
 *
 * Una excepción que se queda es un permiso permanente para no terminar el
 * trabajo. Cada una dice **qué la destraba**, y ninguna dice "todavía no".
 *
 * Las cuatro que quedan tienen la misma forma: la función está bien y el que
 * falta es el otro lado. Tres esperan una decisión que no es técnica y una
 * espera una funcionalidad que no está construida. Ninguna espera que alguien
 * "se acuerde de llamarla".
 */
const SIN_CONSUMIDOR = new Map<string, string>([
  [
    'InMemorySecretProvider',
    'Es un **doble de test**, y este barrido no cuenta los tests como consumidores — con ' +
      'razón, porque un motor probado y no usado es justamente el defecto que persigue. Pero ' +
      'esta clase no tiene otro consumidor posible: se niega a construirse en producción, y ' +
      'existe para que los tests de secretos no necesiten una base ni una nube. La ' +
      'alternativa sería que cada test escribiera su propio falso, y el cuarto quedaría ' +
      'distinto sin que nadie lo note. Se va el día que haya un gestor de secretos real: ahí ' +
      'el doble de test pasa a ser el de ese gestor.',
  ],
  [
    'permiteIntentar',
    'Dice que un relevamiento VENCIDO o NO_RELEVADO no frena el intento; ' +
      '`DbCapabilityStore` de la API falla cerrado. Las dos políticas están escritas y son ' +
      'opuestas, y elegir es del contribuyente: insistir contra un servicio no delegado es ' +
      'cómo un CUIT termina bloqueado por ARCA. Alternativas en NEXO_ROADMAP.md ' +
      '§«Intentar la consulta con el relevamiento vencido».',
  ],
  [
    'allocate',
    'El reparto sin crear ni destruir centavos (P-7). Su caso es el prorrateo del art. 13 de ' +
      'la Ley de IVA, que **no está relevado** —lo dice `credito-fiscal.ts`— y por eso el ' +
      'motor contesta REQUIERE_REVISION en vez de repartir. Lo destraba archivar el ' +
      'articulado del prorrateo, no escribir código.',
  ],
  [
    'leerCsv',
    'Lector de planillas para la importación por lotes, que no existe: `extraer()` rechaza ' +
      'los tabulares con TIPO_NO_SOPORTADO —«se procesan por importación, no por extracción ' +
      'de comprobante»— y la única importación construida, la de extractos bancarios, trae su ' +
      'propio mapeo declarado por el banco. Lo destraba el alta de la importación de lotes.',
  ],
  [
    'leerXlsx',
    'Igual que `leerCsv`, y con el mismo destino: la importación por lotes que todavía no ' +
      'existe.',
  ],
]);

/** Carpetas donde se busca a los consumidores. */
const CONSUMIDORES = ['apps', 'packages', 'scripts', 'tests'];

interface Exportada {
  readonly nombre: string;
  readonly paquete: string;
  readonly archivo: string;
}

describe('S-16 — cada motor tiene quién lo use', () => {
  it('ninguna función exportada por un paquete quedó sin consumidor', async () => {
    const exportadas = await exportacionesDePaquetes();

    // Que el barrido esté mirando algo: si la lectura fallara, cero huérfanas
    // no probaría nada.
    expect(exportadas.length, 'el barrido tiene que encontrar exportaciones').toBeGreaterThan(80);

    const fuentes = await archivosDe(CONSUMIDORES);
    const contenidos = new Map<string, string>();
    for (const archivo of fuentes) {
      contenidos.set(archivo, soloCodigo(await readFile(archivo, 'utf8')));
    }

    const huerfanas: string[] = [];
    for (const exportada of exportadas) {
      if (SIN_CONSUMIDOR.has(exportada.nombre)) continue;

      const usada = [...contenidos].some(([archivo, texto]) => {
        // Los tests no cuentan: un motor probado y no usado es el defecto que
        // se busca.
        if (archivo.endsWith('.test.ts')) return false;

        const veces = (texto.match(new RegExp(`\\b${exportada.nombre}\\b`, 'gu')) ?? []).length;
        // En el archivo que la define, la primera aparición es la declaración:
        // declararla no es usarla. Una segunda sí — es una función que compone
        // a otra, y si esa otra tampoco tiene consumidor, aparecerá acá.
        return archivo.endsWith(exportada.archivo) ? veces > 1 : veces > 0;
      });

      if (!usada) huerfanas.push(`${exportada.nombre} (${exportada.archivo})`);
    }

    expect(
      huerfanas,
      'Estas funciones las exporta un paquete y no las usa nadie fuera de él. Es el defecto ' +
        'que este repositorio ya encontró cinco veces:\n  ' +
        huerfanas.join('\n  '),
    ).toEqual([]);
  });

  it('la lista de excepciones no acumula funciones que ya tienen consumidor', async () => {
    // Una excepción que sobrevive a su motivo convierte la lista en decoración.
    const exportadas = await exportacionesDePaquetes();
    const nombres = new Set(exportadas.map((e) => e.nombre));
    const fantasmas = [...SIN_CONSUMIDOR.keys()].filter((n) => !nombres.has(n));
    expect(fantasmas, 'Estas excepciones ya no corresponden a ninguna exportación').toEqual([]);
  });
});

/**
 * El texto sin comentarios ni literales de texto.
 *
 * El barrido contaba como consumidor una mención en un comentario. Así se le
 * escapó `resumirPorMes`: la única aparición fuera de su archivo estaba en el
 * encabezado de otro paquete, explicando para qué servía la función que nadie
 * llamaba. Un control que se conforma con que alguien la nombre no controla
 * nada — nombrarla es exactamente lo que hace un comentario.
 *
 * Las plantillas (backticks) se dejan enteras a propósito: pueden llevar una
 * llamada real adentro de `${...}`, y perderla haría al barrido gritar de más.
 */
function soloCodigo(texto: string): string {
  return texto
    .replaceAll(/\/\*[\s\S]*?\*\//gu, ' ')
    .replaceAll(/\/\/[^\n]*/gu, ' ')
    .replaceAll(/'(?:[^'\\\n]|\\.)*'/gu, "''")
    .replaceAll(/"(?:[^"\\\n]|\\.)*"/gu, '""');
}

/** Las funciones y clases que exporta cada paquete, sin sus tests. */
async function exportacionesDePaquetes(): Promise<Exportada[]> {
  const archivos = await archivosDe(['packages']);
  const salida: Exportada[] = [];

  for (const archivo of archivos) {
    if (archivo.endsWith('.test.ts')) continue;
    const relativo = relative(RAIZ, archivo);
    const paquete = relativo.split(/[/\\]/u)[1] ?? '';
    const texto = await readFile(archivo, 'utf8');

    for (const m of texto.matchAll(
      /^export\s+(?:async\s+)?(?:function|class)\s+([A-Za-z0-9_]+)/gmu,
    )) {
      salida.push({ nombre: m[1]!, paquete, archivo: relativo });
    }
  }
  return salida;
}

/** Todos los `.ts` bajo esas carpetas, sin `dist` ni `node_modules`. */
async function archivosDe(carpetas: readonly string[]): Promise<string[]> {
  const salida: string[] = [];

  async function recorrer(directorio: string): Promise<void> {
    const entradas = await readdir(directorio, { withFileTypes: true });
    for (const entrada of entradas) {
      const completo = join(directorio, entrada.name);
      if (entrada.isDirectory()) {
        if (entrada.name === 'node_modules' || entrada.name === 'dist') continue;
        await recorrer(completo);
        continue;
      }
      if (entrada.name.endsWith('.ts') || entrada.name.endsWith('.mjs')) salida.push(completo);
    }
  }

  for (const carpeta of carpetas) await recorrer(join(RAIZ, carpeta));
  return salida;
}
