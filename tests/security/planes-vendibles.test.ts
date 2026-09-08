/**
 * S-31 — Un plan que se puede contratar incluye lo que hace falta para trabajar.
 *
 * Sin contabilidad, sin fiscal, sin terceros, sin documentos y sin auditoría no
 * hay producto: hay una pantalla de login. Un plan `DISPONIBLE` al que le falte
 * alguna de esas cinco se puede contratar y no se puede usar, y el que lo
 * contrató lo descubre el primer día.
 *
 * ## Por qué es un test y no un `CHECK`
 *
 * La regla estuvo en la 0105 como un `DO` al final de la migración, y se cayó en
 * la primera base donde corrió después de la de desarrollo: la de pruebas tenía
 * treinta y cinco planes con nombres como `TEST-10009016`, restos de corridas
 * viejas de los tests de facturación.
 *
 * Ninguno era un plan. Pero **la migración no podía saberlo**, y una migración
 * que se cae por datos que no creó bloquea un despliegue por algo que pasó meses
 * antes. La 0107 la sacó de ahí.
 *
 * Acá sí se puede distinguir: el control mira los planes comerciales y **dice
 * cuáles son restos**, que es información que un `RAISE EXCEPTION` en medio de
 * una migración no puede dar.
 */

import { describe, expect, it } from 'vitest';
import { connect, hasDatabase } from '../integration/helpers/db.js';

const suite = hasDatabase ? describe : describe.skip;

/**
 * Los planes que este producto vende.
 *
 * La lista está escrita: cualquier otro plano `DISPONIBLE` es una decisión
 * comercial que alguien tomó sin pasar por acá, o un resto de test. Las dos
 * cosas hay que verlas.
 */
const COMERCIALES = ['CONTABLE', 'GESTION', 'ESTUDIO', 'EMPRESA_B1', 'COMPLETO'];

/** Restos que dejaron corridas viejas, por su forma. Ver 0107. */
const RESTO_DE_TEST = /^(TEST|COBROS|DUNN|ISO|VIS|PLAN)-\d+$/u;

suite('S-31 — los planes que se pueden contratar sirven para trabajar', () => {
  it('todo plan comercial incluye las funcionalidades esenciales', async () => {
    const db = await connect();
    try {
      const { rows } = await db.query<{ code: string; faltan: string }>(
        `SELECT p.code,
                string_agg(f.code, ', ' ORDER BY f.orden) AS faltan
           FROM subscription_plans p
           CROSS JOIN product_features f
           LEFT JOIN plan_features pf ON pf.plan_id = p.id AND pf.feature_code = f.code
          WHERE p.code = ANY($1::text[]) AND f.esencial AND pf.plan_id IS NULL
          GROUP BY p.code
          ORDER BY p.code`,
        [COMERCIALES],
      );
      expect(
        rows.map((r) => `${r.code}: le falta ${r.faltan}`),
        'un plan que se puede contratar y no se puede usar. El que lo contrate lo ' +
          'descubre el primer día',
      ).toEqual([]);
    } finally {
      await db.end();
    }
  });

  it('los cinco planes comerciales existen y están disponibles', async () => {
    // El control positivo: sin esto, el test anterior daría verde si alguien
    // borrara los cinco planes — cero planes incompletos sobre cero planes.
    const db = await connect();
    try {
      const { rows } = await db.query<{ code: string }>(
        `SELECT code FROM subscription_plans WHERE code = ANY($1::text[]) AND status = 'DISPONIBLE'`,
        [COMERCIALES],
      );
      expect(new Set(rows.map((r) => r.code))).toEqual(new Set(COMERCIALES));
    } finally {
      await db.end();
    }
  });

  it('ningún plan disponible quedó sin declarar como comercial', async () => {
    // Un plan DISPONIBLE que nadie declaró acá es una de dos cosas, y las dos
    // hay que verlas: una decisión comercial que no pasó por este archivo, o un
    // resto de test que se puede contratar.
    const db = await connect();
    try {
      const { rows } = await db.query<{ code: string }>(
        `SELECT code FROM subscription_plans WHERE status = 'DISPONIBLE' ORDER BY code`,
      );
      const inesperados = rows
        .map((r) => r.code)
        .filter((c) => !COMERCIALES.includes(c))
        .map((c) => (RESTO_DE_TEST.test(c) ? `${c} (parece resto de test)` : c));

      expect(
        inesperados,
        'planes contratables que no están en la lista comercial. Si es un plan nuevo, ' +
          'agregalo a COMERCIALES; si es un resto de test, discontinualo',
      ).toEqual([]);
    } finally {
      await db.end();
    }
  });

  it('el catálogo comercial no toca ninguna tabla de una empresa', async () => {
    // `GET /planes` se sirve **sin sesión**: es la página de precios. Está
    // declarada como excepción en el barrido de aislamiento, y lo que paga esa
    // excepción es esto — ninguna de las tablas que lee tiene `company_id`, así
    // que no hay nada de nadie que pueda salir por ahí.
    const db = await connect();
    try {
      const { rows } = await db.query<{ table_name: string }>(
        `SELECT DISTINCT table_name FROM information_schema.columns
          WHERE table_schema = 'public' AND column_name = 'company_id'
            AND table_name = ANY($1::text[])`,
        [
          [
            'subscription_plans',
            'plan_prices',
            'plan_features',
            'product_features',
            'plan_limits',
          ],
        ],
      );
      expect(
        rows.map((r) => r.table_name),
        'una tabla del catálogo comercial tiene company_id, y `GET /planes` se sirve sin ' +
          'sesión: eso sería una fuga',
      ).toEqual([]);
    } finally {
      await db.end();
    }
  });

  it('cada funcionalidad del catálogo existe en el producto', async () => {
    // Una funcionalidad en la matriz que ninguna ruta sirve es una promesa de
    // venta que el producto no puede cumplir. Se comprueba contra los dominios
    // declarados: los que gobiernan rutas tienen que nombrar algo.
    const db = await connect();
    try {
      const { rows } = await db.query<{ code: string; dominios: string[] }>(
        'SELECT code, dominios FROM product_features ORDER BY orden',
      );
      expect(rows.length).toBeGreaterThan(0);
      const sinDominio = rows.filter((r) => r.dominios.length === 0).map((r) => r.code);
      expect(
        sinDominio,
        'una funcionalidad sin dominios no gobierna nada: o le faltan, o no debería ' +
          'estar en la matriz comercial',
      ).toEqual([]);
    } finally {
      await db.end();
    }
  });
});
