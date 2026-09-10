/**
 * S-41 — Lo que separa consultar de emitir, y homologación de producción.
 *
 * Los cuatro riesgos de esta fase tienen la misma forma: **el sistema hace algo
 * ante el organismo, a nombre de un contribuyente, y eso no se deshace.**
 *
 *   1. **Emitir sin querer.** `@aai/arca-emision` pide CAE. Con un certificado
 *      de producción emite facturas reales. Tiene que ser inalcanzable desde la
 *      aplicación, y no por disciplina.
 *   2. **Importar un histórico y que pida CAE.** Traer las facturas del sistema
 *      anterior es copiar hechos que ya ocurrieron. Si el importador pidiera
 *      autorización, cada factura vieja de la empresa se emitiría de nuevo.
 *   3. **Que un test hable con producción.** Una suite que corriera contra el
 *      ambiente de producción consultaría —o peor— con datos inventados.
 *   4. **Confundir ambientes.** Un endpoint de homologación en producción, o al
 *      revés.
 *
 * Ninguno de los cuatro se detecta leyendo: los cuatro se ven en el grafo de
 * módulos, en la configuración efectiva o en el SQL que corre.
 */

import { readFile, readdir } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { endpointsFor, parseEnvironment } from '@aai/arca';
import { describe, expect, it } from 'vitest';

const RAIZ = join(dirname(fileURLToPath(import.meta.url)), '..', '..');

/** Todo archivo de código bajo una carpeta, sin `dist` ni `node_modules`. */
async function fuentes(carpeta: string): Promise<string[]> {
  const salida: string[] = [];
  async function recorrer(actual: string): Promise<void> {
    for (const e of await readdir(actual, { withFileTypes: true })) {
      const ruta = join(actual, e.name);
      if (e.isDirectory()) {
        if (e.name === 'node_modules' || e.name === 'dist') continue;
        await recorrer(ruta);
        continue;
      }
      if (/\.(ts|mjs)$/u.test(e.name)) salida.push(ruta);
    }
  }
  await recorrer(join(RAIZ, carpeta));
  return salida;
}

describe('S-41 — la emisión no llega a la aplicación', () => {
  it('ningún archivo de apps/ importa el paquete que pide CAE', async () => {
    // El lint de arquitectura ya lo prohíbe y corre en `verify`. Esto lo mira
    // desde el otro lado: si alguien relajara la regla del dependency-cruiser,
    // el lint pasaría y este control seguiría viendo el import.
    const culpables: string[] = [];

    for (const archivo of await fuentes('apps')) {
      const texto = await readFile(archivo, 'utf8');
      if (/from\s+['"]@aai\/arca-emision|require\(\s*['"]@aai\/arca-emision/u.test(texto)) {
        culpables.push(archivo.slice(RAIZ.length + 1).replace(/\\/gu, '/'));
      }
    }

    expect(
      culpables,
      'Estos archivos de la aplicación alcanzan el paquete de emisión. Con un certificado de ' +
        'producción, pedir CAE emite una factura real a nombre del contribuyente y no se ' +
        'deshace. La emisión está declarada fuera del MVP:\n  ' +
        culpables.join('\n  '),
    ).toEqual([]);
  });

  it('la aplicación no nombra la operación que solicita autorización', async () => {
    // `FECAESolicitar` es la llamada que emite. Que no aparezca en `apps/` es
    // la comprobación por el nombre, independiente de cómo se importe.
    const culpables: string[] = [];
    for (const archivo of await fuentes('apps')) {
      const texto = await readFile(archivo, 'utf8');
      if (/FECAESolicitar/u.test(texto)) {
        culpables.push(archivo.slice(RAIZ.length + 1).replace(/\\/gu, '/'));
      }
    }
    expect(culpables, culpables.join('\n  ')).toEqual([]);
  });

  it('el paquete de emisión existe: el control no pasa por estar vacío', async () => {
    // El control positivo. Sin él, borrar `arca-emision` haría pasar los dos
    // casos de arriba y nadie notaría que se perdió la capacidad.
    const wsfe = await readFile(
      join(RAIZ, 'packages', 'arca-emision', 'src', 'wsfev1.ts'),
      'utf8',
    );
    expect(wsfe).toContain('FECAESolicitar');
  });
});

describe('S-41 — importar un histórico no es emitir', () => {
  it('el motor de migración no alcanza el paquete de emisión', async () => {
    // Traer las facturas del sistema anterior es copiar hechos que ya
    // ocurrieron ante el organismo. Si el importador pidiera CAE, cada factura
    // vieja de la empresa se volvería a emitir —con número nuevo, fecha de hoy
    // y consecuencias fiscales reales—.
    const culpables: string[] = [];
    for (const carpeta of ['packages/migration-engine', 'apps/api/src/migracion']) {
      for (const archivo of await fuentes(carpeta)) {
        const texto = await readFile(archivo, 'utf8');
        if (/arca-emision|FECAESolicitar|solicitarCae/iu.test(texto)) {
          culpables.push(archivo.slice(RAIZ.length + 1).replace(/\\/gu, '/'));
        }
      }
    }
    expect(
      culpables,
      'El importador de migraciones toca la emisión fiscal. Un comprobante histórico se copia, ' +
        'no se emite:\n  ' + culpables.join('\n  '),
    ).toEqual([]);
  });

  it('el comprobante migrado queda NO_CONSULTADO, y su CAE es un dato del origen', async () => {
    // La otra mitad, y la que se ve en el dato: un comprobante que entra por
    // migración queda `NO_CONSULTADO`. No es «constatado y correcto» ni
    // «rechazado»: es que nadie le preguntó nada a ARCA, que es la verdad.
    //
    // El CAE que traiga el archivo **se guarda** —es lo que el sistema anterior
    // obtuvo— y no se verifica ni se reemplaza. Guardarlo no es emitir: emitir
    // es pedirle uno nuevo al organismo.
    const escritores = await readFile(
      join(RAIZ, 'apps', 'api', 'src', 'migracion', 'escritores.ts'),
      'utf8',
    );
    expect(escritores).toContain('NO_CONSULTADO');
    // Dos trozos cortos y no una frase larga: el texto está partido en una
    // concatenación, y una expresión que cruce el corte se rompe con el primer
    // reformateo sin que nada haya cambiado de sentido.
    expect(escritores).toContain('Queda como dato del origen');
    expect(escritores).toContain('no le pide a ARCA');
  });
});

describe('S-41 — los ambientes no se mezclan', () => {
  it('cada ambiente resuelve a su propio extremo', () => {
    const homo = endpointsFor('homologacion');
    const prod = endpointsFor('produccion');

    // Ni un solo extremo compartido: si alguno coincidiera, una configuración
    // de homologación estaría hablando con producción.
    for (const servicio of ['wsaa', 'wscdc', 'wsfev1', 'padronA13', 'padronA100'] as const) {
      expect(homo[servicio], `${servicio} comparte extremo entre ambientes`).not.toBe(
        prod[servicio],
      );
    }

    expect(homo.wsaa).toContain('wsaahomo');
    expect(prod.wsaa).toContain('wsaa.afip');
  });

  it('el mock apunta a homologación, nunca a producción', () => {
    // El mock no abre red. Devolver los de homologación hace que cualquier log
    // muestre a qué apuntaría; devolver los de producción sería una URL de
    // producción escrita en un log de desarrollo.
    expect(endpointsFor('mock')).toEqual(endpointsFor('homologacion'));
  });

  it('un ambiente inexistente no cae a ninguno: tira', () => {
    // Fail fast. Si `ARCA_ENVIRONMENT=produccíon` —con tilde— cayera a `mock`,
    // el sistema informaría constataciones simuladas como reales.
    for (const invalido of ['produccion ', 'PRODUCCION', 'prod', 'homologación', 'test']) {
      expect(() => parseEnvironment(invalido), `«${invalido}» debería tirar`).toThrow(
        /ARCA_ENVIRONMENT inválido/u,
      );
    }
  });

  it('sin declarar, el ambiente es mock: nunca producción por omisión', () => {
    expect(parseEnvironment(undefined)).toBe('mock');
    expect(parseEnvironment('')).toBe('mock');
  });

  it('la suite corre siempre contra el simulado', async () => {
    // `tests/setup-env.ts` lo fuerza antes de importar una sola suite. Sin
    // esto, quien tuviera `ARCA_ENVIRONMENT=homologacion` en su `.env` haría
    // que los tests hablaran con el organismo.
    expect(process.env['ARCA_ENVIRONMENT']).toBe('mock');

    const setup = await readFile(join(RAIZ, 'tests', 'setup-env.ts'), 'utf8');
    expect(setup).toContain("process.env.ARCA_ENVIRONMENT = 'mock'");
  });
});

describe('S-41 — el candado de emisión prueba el destino', () => {
  it('solo acepta el extremo exacto de homologación', async () => {
    const { verificarDestinoDeEmision } = await import('@aai/arca-emision');
    const homo = endpointsFor('homologacion');
    const prod = endpointsFor('produccion');

    // El destino legítimo, y va primero: sin él, una guarda que rechazara todo
    // haría pasar los casos de abajo y la emisión no funcionaría nunca.
    expect(
      verificarDestinoDeEmision({
        ambiente: 'homologacion',
        endpointWsfev1: homo.wsfev1,
        endpointWsaa: homo.wsaa,
      }).permitido,
    ).toBe(true);

    // Pregunta al revés que un chequeo ingenuo: no comprueba que NO sea
    // producción —eso falla abierto ante un endpoint nuevo—, comprueba que SEA
    // exactamente el declarado.
    const rechazables: { ambiente: 'produccion' | 'mock' | 'homologacion'; wsfev1: string; wsaa: string }[] = [
      { ambiente: 'produccion', wsfev1: prod.wsfev1, wsaa: prod.wsaa },
      { ambiente: 'mock', wsfev1: homo.wsfev1, wsaa: homo.wsaa },
      // Homologación de nombre, con una barra de más en el extremo.
      { ambiente: 'homologacion', wsfev1: `${homo.wsfev1}/`, wsaa: homo.wsaa },
      // Y el peor: ambiente de homologación apuntando al WSAA de producción.
      { ambiente: 'homologacion', wsfev1: homo.wsfev1, wsaa: prod.wsaa },
    ];

    for (const caso of rechazables) {
      const permiso = verificarDestinoDeEmision({
        ambiente: caso.ambiente,
        endpointWsfev1: caso.wsfev1,
        endpointWsaa: caso.wsaa,
      });
      expect(
        permiso.permitido,
        `debería rechazar ${caso.ambiente} → ${caso.wsfev1} / ${caso.wsaa}`,
      ).toBe(false);
    }
  });
});
