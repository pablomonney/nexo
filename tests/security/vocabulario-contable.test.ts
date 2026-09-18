/**
 * El vocabulario de una cuenta no puede estar escrito dos veces.
 *
 * Los siete tipos de `accounts.type` estaban en seis archivos de TypeScript
 * —alta de cuentas, cierre de ejercicio, contexto del Mayor, estados contables,
 * catálogo, importación— más el `CHECK` de la migración 0003. Las seis copias
 * decían lo mismo el día que se escribieron, que es exactamente el estado en el
 * que este repositorio se equivocó dos veces antes: el organismo de contralor y
 * el tipo de entidad estaban duplicados, se desincronizaron, y el defecto
 * apareció recién en producción porque las dos copias seguían contestando.
 *
 * Ahora la definición vive en `@aai/shared/tipos-contables`. Este archivo
 * controla las dos formas en que eso se puede deshacer:
 *
 *   1. que la base y el runtime dejen de decir lo mismo;
 *   2. que alguien vuelva a escribir la lista a mano en otro archivo.
 *
 * El punto 2 es el que importa. El defecto nunca fue que las listas difirieran
 * —eso es la consecuencia—: fue que existieran.
 *
 * ## Lo que este control NO persigue
 *
 * Hay tres lugares que enumeran valores del vocabulario y están bien así:
 *
 *   `TIPOS_PATRIMONIALES`   cierre-de-ejercicio.ts. Un subconjunto con
 *                           significado propio: qué sobrevive a la refundición.
 *   `TEXTO_A_TIPO`          escritores.ts. Traduce texto ajeno al vocabulario.
 *   `TIPO_POR_DIGITO`       escritores.ts. La convención del primer dígito.
 *
 * Los tres están **tipados contra** `TipoDeCuenta`, así que no pueden producir
 * un valor que la base rechace. Por eso el control no busca la forma de una
 * enumeración sino la del conjunto **completo**: `TIPOS_PATRIMONIALES` enumera
 * cuatro tipos y eso es su significado; una redefinición enumera los siete.
 *
 * Es un control por forma del texto, no una prueba: alguien decidido a escribir
 * la lista de nuevo —partida en dos constantes, con comentarios en el medio—
 * puede pasarlo. Sirve para el caso real, que es copiar y pegar.
 */

import { readdir, readFile } from 'node:fs/promises';
import { dirname, join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import {
  NATURALEZAS,
  NATURALEZA_POR_TIPO,
  TAX_ROLES,
  TIPOS_DE_CUENTA,
} from '@aai/shared';

const RAIZ = join(dirname(fileURLToPath(import.meta.url)), '..', '..');

const migracion = async (archivo: string): Promise<string> =>
  readFile(join(RAIZ, 'infrastructure', 'db', 'migrations', archivo), 'utf8');

/** Los literales de un `CHECK (columna IN ('A', 'B', …))`, en orden alfabético. */
function valoresDelCheck(sql: string, columna: string): string[] {
  const patron = new RegExp(`${columna}\\s+IN\\s*\\(([^)]+)\\)`, 'u');
  const encontrado = patron.exec(sql);
  expect(encontrado, `no se encontró el CHECK de ${columna}`).not.toBeNull();
  return [...encontrado![1]!.matchAll(/'([A-Z_]+)'/gu)].map((m) => m[1]!).sort();
}

/** Todos los `.ts` de código fuente. Sin `dist`, sin `node_modules`, sin tests. */
async function fuentes(): Promise<string[]> {
  const encontrados: string[] = [];
  const recorrer = async (directorio: string): Promise<void> => {
    for (const entrada of await readdir(directorio, { withFileTypes: true })) {
      const ruta = join(directorio, entrada.name);
      if (entrada.isDirectory()) {
        if (entrada.name === 'node_modules' || entrada.name === 'dist') continue;
        await recorrer(ruta);
      } else if (entrada.name.endsWith('.ts') && !entrada.name.endsWith('.test.ts')) {
        encontrados.push(ruta);
      }
    }
  };
  await recorrer(join(RAIZ, 'apps'));
  await recorrer(join(RAIZ, 'packages'));
  return encontrados;
}

/** Dónde vive cada lista. Es el único archivo al que se le permite escribirla. */
const CANONICO = join('packages', 'shared', 'src', 'tipos-contables.ts');

/**
 * Cada concepto se busca en dos pasos.
 *
 * `inicio` reconoce la forma —dos valores contiguos separados por `|` o por `,`,
 * que es como se escribe una unión de tipos o un arreglo— y a partir de ahí se
 * exige que en la misma ventana estén **todos** los valores. Un mapa que los use
 * como valores, `{'1': 'ACTIVO', '2': 'PASIVO'}`, no reconoce la forma; un
 * subconjunto deliberado la reconoce pero no completa el conjunto.
 */
const REDEFINICIONES: readonly { concepto: string; inicio: RegExp; valores: readonly string[] }[] = [
  { concepto: 'los tipos de cuenta', inicio: /'ACTIVO'\s*[|,]\s*'PASIVO'/gu, valores: TIPOS_DE_CUENTA },
  { concepto: 'las naturalezas', inicio: /'DEUDORA'\s*[|,]\s*'ACREEDORA'/gu, valores: NATURALEZAS },
  { concepto: 'los roles fiscales', inicio: /'IVA_CF'\s*[|,]\s*'IVA_DF'/gu, valores: TAX_ROLES },
];

/** Cuánto texto después del inicio se considera parte de la misma enumeración. */
const VENTANA = 240;

describe('El vocabulario contable y la base no pueden divergir', () => {
  it('los siete tipos son los del CHECK de la 0003', async () => {
    const sql = await migracion('0003_accounts.sql');
    expect(valoresDelCheck(sql, 'type')).toEqual([...TIPOS_DE_CUENTA].sort());
  });

  it('las dos naturalezas son las del CHECK de la 0003', async () => {
    const sql = await migracion('0003_accounts.sql');
    expect(valoresDelCheck(sql, 'nature')).toEqual([...NATURALEZAS].sort());
  });

  it('los cinco roles fiscales son los del CHECK de la 0003', async () => {
    const sql = await migracion('0003_accounts.sql');
    expect(valoresDelCheck(sql, 'tax_role')).toEqual([...TAX_ROLES].sort());
  });

  it('el CHECK de la 0003 sigue existiendo', async () => {
    // La centralización en TypeScript no reemplaza la defensa de integridad: la
    // base tiene que rechazar un tipo inventado aunque quien escriba no pase por
    // este código. Si alguien borra el CHECK «porque ya está en shared», esto lo
    // dice.
    const sql = await migracion('0003_accounts.sql');
    expect(sql).toMatch(/type\s+text NOT NULL CHECK \(type IN/u);
    expect(sql).toMatch(/nature\s+text NOT NULL CHECK \(nature IN/u);
    expect(sql).toMatch(/tax_role\s+text CHECK \(tax_role IN/u);
  });

  it('cada tipo tiene su naturaleza habitual, sin huecos ni sobrantes', () => {
    expect(Object.keys(NATURALEZA_POR_TIPO).sort()).toEqual([...TIPOS_DE_CUENTA].sort());
    for (const tipo of TIPOS_DE_CUENTA) {
      expect(NATURALEZAS, tipo).toContain(NATURALEZA_POR_TIPO[tipo]);
    }
  });
});

describe('Ningún archivo del runtime vuelve a escribir el vocabulario', () => {
  for (const { concepto, inicio, valores } of REDEFINICIONES) {
    it(`nadie redefine ${concepto}`, async () => {
      const reincidentes: string[] = [];
      for (const ruta of await fuentes()) {
        const relativa = relative(RAIZ, ruta);
        if (relativa === CANONICO) continue;
        const texto = await readFile(ruta, 'utf8');
        for (const encontrado of texto.matchAll(inicio)) {
          const ventana = texto.slice(encontrado.index, encontrado.index + VENTANA);
          if (valores.every((v) => ventana.includes(`'${v}'`))) reincidentes.push(relativa);
        }
      }
      expect(
        reincidentes,
        `estos archivos volvieron a escribir ${concepto} a mano en vez de importarlos de @aai/shared`,
      ).toEqual([]);
    });
  }
});
