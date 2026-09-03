/**
 * S-20 — la bitácora es un vocabulario, no una lista de textos sueltos.
 *
 * Cada escritura productiva deja una fila en `audit_logs` con un `action`. Ese
 * campo es la única forma que tiene el sistema de contestar «qué pasó en esta
 * empresa», y es la materia prima de todo lo que se construya encima: métricas,
 * detección, agentes. Un vocabulario que deriva convierte esa pregunta en una
 * búsqueda de texto.
 *
 * Y derivaba. Al medirlo había **106 acciones** en `VERBO_EN_MAYUSCULAS` y
 * **ocho** en `objeto.verbo` —`bank_account.create`, `vat_book.generate`,
 * `book.emit`…—, todas de un puñado de archivos donde cada uno copió el estilo
 * de su vecino. Ninguna estaba mal escrita; el conjunto sí.
 *
 * ## El caso que este barrido existe para atajar
 *
 * `audit_logs` tiene un CHECK que exige motivo para cinco acciones
 * excepcionales, y las compara **por texto**. Renombrar cualquiera de las cinco
 * en el código no rompe nada: la aplicación sigue andando, los tests siguen
 * verdes, y el candado deja de aplicarse en silencio. Desde ese día se podría
 * anular un asiento sin explicar por qué.
 *
 * Hay tres copias de esa lista —el CHECK de la 0008, `ACTIONS_REQUIRING_REASON`
 * en `@aai/db` y la del propio candado— y acá se comprueba que digan lo mismo.
 */

import { readdir, readFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { ACTIONS_REQUIRING_REASON } from '@aai/db';
import { beforeAll, describe, expect, it } from 'vitest';

const RAIZ = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const API = join(RAIZ, 'apps', 'api', 'src');

/**
 * Las excepcionales que **nadie escribe todavía**, con el motivo.
 *
 * No son un olvido: son nombres reservados en el CHECK para actos que el
 * producto todavía no tiene. Declararlas acá es lo que hace que el barrido
 * pueda distinguir «nunca existió» de «alguien la renombró y el candado dejó de
 * aplicarse», que es lo único que importa de esta lista.
 */
const SIN_ESCRITOR = new Map<string, string>([
  [
    'ACTIVAR_REGLA',
    'Activar una regla no ocurre dentro de una empresa: va a `normative_audit_logs` con la ' +
      'acción `RULE_APPROVED` (0041). El nombre quedó en el CHECK de `audit_logs`, donde no ' +
      'puede dispararse nunca.',
  ],
  [
    'RECLASIFICAR_APROBADO',
    'Reclasificar un asiento ya aprobado no existe como operación: lo que hay es anular y ' +
      'volver a asentar, que deja los dos asientos. El nombre está reservado en el CHECK para ' +
      'el día que exista.',
  ],
]);

describe('S-20 — el vocabulario de la bitácora', () => {
  let acciones: string[] = [];
  let porAccionConMotivo = new Map<string, boolean>();
  let migracion = '';

  beforeAll(async () => {
    const archivos = await archivosDe(API);
    const encontradas = new Set<string>();
    const conMotivo = new Map<string, boolean>();

    for (const archivo of archivos) {
      const texto = await readFile(archivo, 'utf8');
      const lineas = texto.split('\n');

      for (const [i, linea] of lineas.entries()) {
        const m = /action:\s*'([^']+)'/u.exec(linea);
        if (m === null) continue;
        const accion = m[1]!;
        encontradas.add(accion);

        // El `motivo` viaja en el mismo objeto que la acción. Se mira una
        // ventana en vez de parsear TypeScript: alcanza para lo que se
        // defiende y no trae un parser al barrido.
        const ventana = lineas.slice(Math.max(0, i - 12), i + 14).join('\n');
        conMotivo.set(accion, (conMotivo.get(accion) ?? false) || /motivo:/u.test(ventana));
      }
    }

    acciones = [...encontradas].sort();
    porAccionConMotivo = conMotivo;

    migracion = await readFile(
      join(RAIZ, 'infrastructure', 'db', 'migrations', '0008_audit_lineage.sql'),
      'utf8',
    );
  });

  it('el barrido encuentra el vocabulario: no está pasando por vacío', () => {
    expect(acciones.length, 'la API tiene que registrar muchas acciones').toBeGreaterThan(100);
    expect(acciones).toContain('APROBAR_ASIENTO');
  });

  it('todas las acciones son un verbo en mayúsculas', () => {
    // Un vocabulario con dos formas obliga a cada consulta a conocer las dos, y
    // la tercera que aparezca no la va a conocer nadie.
    const fuera = acciones.filter((accion) => !/^[A-Z][A-Z_]*[A-Z]$/u.test(accion));

    expect(
      fuera,
      'Estas acciones no siguen la forma del resto del vocabulario (VERBO_EN_MAYUSCULAS):\n  ' +
        fuera.join('\n  '),
    ).toEqual([]);
  });

  it('el CHECK de la base y la lista del código nombran las mismas acciones', () => {
    const enLaMigracion = [
      ...(/CHECK \(action NOT IN \(([^)]+)\)/u.exec(migracion)?.[1] ?? '').matchAll(/'([^']+)'/gu),
    ]
      .map((m) => m[1]!)
      .sort();

    expect(enLaMigracion.length, 'el CHECK tiene que nombrar acciones').toBeGreaterThan(0);
    expect(enLaMigracion, 'la 0008 y `ACTIONS_REQUIRING_REASON` tienen que decir lo mismo').toEqual(
      [...ACTIONS_REQUIRING_REASON].sort(),
    );
  });

  it('cada acción excepcional que alguien escribe viaja con su motivo', () => {
    // La base lo exige y rechaza la fila. Comprobarlo acá cambia el momento en
    // que se descubre: al correr los tests, no cuando alguien intenta anular un
    // asiento en producción.
    const sinMotivo = ACTIONS_REQUIRING_REASON.filter(
      (accion) => porAccionConMotivo.get(accion) === false,
    );

    expect(
      sinMotivo,
      'Estas acciones exigen motivo y el código las escribe sin uno cerca. La base va a ' +
        'rechazar la fila:\n  ' + sinMotivo.join('\n  '),
    ).toEqual([]);
  });

  it('las excepcionales que nadie escribe son exactamente las declaradas', () => {
    // Si una de las escritas desaparece del código, aparece acá: o la
    // renombraron —y el candado dejó de aplicarse— o se fue la funcionalidad.
    const fantasmas = ACTIONS_REQUIRING_REASON.filter((accion) => !acciones.includes(accion));
    expect(
      [...fantasmas].sort(),
      'Cambió qué acciones excepcionales escribe el código. Si es un renombre, el CHECK de la ' +
        '0008 quedó apuntando a un nombre que ya no existe y el motivo dejó de ser obligatorio.',
    ).toEqual([...SIN_ESCRITOR.keys()].sort());
  });
});

/** Todos los `.ts` de la API, sin tests. */
async function archivosDe(directorio: string, salida: string[] = []): Promise<string[]> {
  for (const entrada of await readdir(directorio, { withFileTypes: true })) {
    const completo = join(directorio, entrada.name);
    if (entrada.isDirectory()) {
      if (entrada.name === 'node_modules' || entrada.name === 'dist') continue;
      await archivosDe(completo, salida);
      continue;
    }
    if (entrada.name.endsWith('.ts') && !entrada.name.includes('.test.')) salida.push(completo);
  }
  return salida;
}
