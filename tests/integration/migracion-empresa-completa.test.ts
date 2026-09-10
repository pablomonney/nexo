/**
 * Una empresa entera, de otro sistema a NEXO.
 *
 * Es la prueba que decide si el motor sirve. Las otras miran una entidad por
 * vez; esta sube el ZIP que subiría alguien —diez archivos, diez entidades que
 * se citan entre sí— y comprueba las cinco cosas que hacen creíble una
 * migración:
 *
 *   1. que los datos entren y **queden relacionados** entre sí;
 *   2. que los números **cuadren** contra lo que el origen declaraba;
 *   3. que repetirla **no duplique** nada;
 *   4. que se pueda **deshacer**, y que lo que no se puede lo diga;
 *   5. que la empresa de al lado **no vea nada** de todo esto.
 *
 * Una migración que importa filas sin que ninguna de esas cinco se cumpla no es
 * una migración: es un `INSERT` masivo con buena prensa.
 */

import { closePool, initPool, withCompany } from '@aai/db';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  cargarOrigen,
  crearMigracion,
  declararMapeo,
  importar,
  reconciliarContabilidad,
  reconciliarStock,
  revertir,
  validarMigracion,
} from '@aai/api/migracion/ciclo';
import type { Entidad } from '@aai/migration-engine';
import { asCompany, connect, hasDatabase, seed, type Client, type Fixture } from './helpers/db.js';
import { armarZip } from './helpers/zip.js';
import { ARCHIVOS, ENTIDAD_DE, FECHA_ISO, MAPEO_DE } from './helpers/empresa-migrada.js';

const suite = hasDatabase ? describe : describe.skip;
const actor = 'user:migrador';

suite('una empresa entera, de otro sistema a NEXO', () => {
  let raw: Client;
  let fx: Fixture;
  let migracion = '';

  beforeAll(async () => {
    initPool(process.env.DATABASE_URL!);
    raw = await connect();
    fx = await seed(raw, 'empresa-completa');
    migracion = await migrarLaEmpresa(fx.companyA);
  }, 120_000);

  afterAll(async () => {
    await raw?.end();
    await closePool();
  });

  /** Sube el ZIP, declara el mapeo, valida e importa. El camino completo. */
  async function migrarLaEmpresa(companyId: string): Promise<string> {
    const id = await withCompany({ companyId, actorId: actor }, async (tx) => {
      const id = await crearMigracion(tx, companyId, actor, {
        adaptador: 'ARCHIVO_GENERICO',
        titulo: 'Empresa completa del sistema anterior',
        fechaCorte: FECHA_ISO,
      });

      await cargarOrigen(tx, companyId, actor, id, {
        nombre: 'empresa.zip',
        bytes: armarZip(ARCHIVOS),
      });

      const { rows } = await tx.query<{ id: string; nombre: string }>(
        'SELECT id, nombre FROM migration_tables WHERE migration_id = $1',
        [id],
      );
      expect(rows).toHaveLength(Object.keys(ARCHIVOS).length);

      await declararMapeo(
        tx,
        companyId,
        actor,
        id,
        rows.map((t) => ({
          id: t.id,
          entidad: ENTIDAD_DE[t.nombre] as Entidad,
          mapeo: MAPEO_DE[t.nombre]!,
          incluida: true,
        })),
      );

      const veredicto = await validarMigracion(tx, companyId, actor, id);
      expect(veredicto.sePuedeImportar, JSON.stringify(veredicto)).toBe(true);
      return id;
    });

    const r = await importar(companyId, actor, id);
    expect(r.estado, JSON.stringify(r.conteos)).toMatch(/^COMPLETADA/);
    return id;
  }

  const enA = <T>(fn: () => Promise<T>): Promise<T> => asCompany(raw, fx.companyA, fn);

  // ── 1 · Los datos entraron y quedaron relacionados ─────────────────────

  it('los depósitos y el plan de cuentas entraron con su jerarquía', async () => {
    const depositos = await enA(() =>
      raw.query<{ code: string }>(
        'SELECT code FROM warehouses WHERE company_id = $1 ORDER BY code',
        [fx.companyA],
      ),
    );
    expect(depositos.rows.map((d) => d.code)).toEqual(['CENTRAL', 'SUCURSAL']);

    const cuentas = await enA(() =>
      raw.query<{ code: string; is_postable: boolean; padre: string | null }>(
        `SELECT a.code, a.is_postable, p.code AS padre
           FROM accounts a LEFT JOIN accounts p ON p.id = a.parent_id
          WHERE a.company_id = $1 AND a.code LIKE '2%' ORDER BY a.code`,
        [fx.companyA],
      ),
    );
    // La jerarquía se armó aunque el archivo viniera desordenado.
    expect(cuentas.rows).toEqual([
      { code: '2', is_postable: false, padre: null },
      { code: '2.1', is_postable: false, padre: '2' },
      { code: '2.1.01', is_postable: true, padre: '2.1' },
    ]);
  });

  it('los productos entraron con su impuesto, que es lo que rompía antes', async () => {
    // El escritor de productos no mandaba `tax_id` y un CHECK lo rechazaba:
    // ningún producto se podía importar y ninguna prueba lo ejercitaba.
    const { rows } = await enA(() =>
      raw.query<{ code: string; tax_treatment: string; tiene_impuesto: boolean; unit: string }>(
        `SELECT code, tax_treatment, tax_id IS NOT NULL AS tiene_impuesto, unit
           FROM products WHERE company_id = $1 ORDER BY code`,
        [fx.companyA],
      ),
    );
    expect(rows).toHaveLength(2);
    expect(rows[0]).toEqual({
      code: 'ART-001',
      tax_treatment: 'GRAVADO',
      tiene_impuesto: true,
      unit: 'UNIDAD',
    });
  });

  it('la venta quedó vinculada al cliente y sus renglones al producto', async () => {
    const { rows } = await enA(() =>
      raw.query<{ numero: string; razon: string; total: string; renglones: number }>(
        `SELECT t.cbte_numero AS numero, p.razon_social AS razon, t.total::text AS total,
                (SELECT count(*)::int FROM tax_transaction_lines l
                  WHERE l.tax_transaction_id = t.id) AS renglones
           FROM tax_transactions t
           JOIN parties p ON p.id = t.party_id
          WHERE t.company_id = $1 AND t.direction = 'VENTAS'
          ORDER BY t.cbte_numero`,
        [fx.companyA],
      ),
    );

    expect(rows).toEqual([
      { numero: '101', razon: 'Acme SA', total: '12100.00', renglones: 1 },
      // Las dos filas del 102 se agruparon en un comprobante de dos renglones.
      { numero: '102', razon: 'Beta SRL', total: '3630.00', renglones: 2 },
    ]);

    const productos = await enA(() =>
      raw.query<{ n: string }>(
        `SELECT count(*)::text n FROM tax_transaction_lines l
           JOIN tax_transactions t ON t.id = l.tax_transaction_id
          WHERE t.company_id = $1 AND t.direction = 'VENTAS' AND l.product_id IS NOT NULL`,
        [fx.companyA],
      ),
    );
    // Los tres renglones resolvieron su producto por SKU.
    expect(productos.rows[0]!.n).toBe('3');
  });

  it('el comprobante migrado no dice que ARCA lo verificó', async () => {
    // Es la afirmación más fácil de hacer sin querer. Nadie le preguntó a ARCA
    // por un comprobante de otro sistema, y la fila tiene que decir eso.
    const { rows } = await enA(() =>
      raw.query<{ constatacion: string; origen: string; documento: string | null }>(
        `SELECT constatacion, constatacion_origen AS origen, document_id::text AS documento
           FROM tax_transactions WHERE company_id = $1`,
        [fx.companyA],
      ),
    );
    expect(rows.length).toBeGreaterThan(0);
    for (const r of rows) {
      expect(r).toEqual({
        constatacion: 'NO_CONSULTADO',
        origen: 'NO_CONSULTADO',
        documento: null,
      });
    }
  });

  it('la orden de pago quedó imputada contra la factura de compra', async () => {
    const { rows } = await enA(() =>
      raw.query<{ status: string; importe: string; comprobante: string }>(
        `SELECT o.status, l.importe::text, t.cbte_numero AS comprobante
           FROM payment_orders o
           JOIN payment_order_lines l ON l.payment_order_id = o.id
           JOIN tax_transactions t ON t.id = l.tax_transaction_id
          WHERE o.company_id = $1`,
        [fx.companyA],
      ),
    );
    expect(rows).toEqual([{ status: 'BORRADOR', importe: '18150.00', comprobante: '900' }]);
  });

  it('los asientos entraron PROPUESTOS y con sus renglones juntos', async () => {
    const { rows } = await enA(() =>
      raw.query<{ status: string; debe: string; renglones: number; descripcion: string }>(
        `SELECT e.status, e.total_debit::text AS debe, e.description AS descripcion,
                (SELECT count(*)::int FROM journal_entry_lines l WHERE l.entry_id = e.id) AS renglones
           FROM journal_entries e
          WHERE e.company_id = $1 AND e.description LIKE '%[origen%'
          ORDER BY e.total_debit`,
        [fx.companyA],
      ),
    );

    expect(rows).toHaveLength(2);
    // El asiento 2 tenía sus renglones salteados en el archivo y se juntaron.
    expect(rows[0]!.renglones).toBe(3);
    expect(rows[1]!.renglones).toBe(2);
    // PROPUESTOS y no aprobados: nadie de esta empresa los revisó.
    for (const r of rows) expect(r.status).toBe('PROPUESTO');
  });

  it('ningún asiento migrado llegó al Mayor', async () => {
    // La consecuencia de entrar PROPUESTO, y la que hace segura la reversión.
    const { rows } = await enA(() =>
      raw.query<{ n: string }>(
        `SELECT count(*)::text n FROM ledger_movements m
          WHERE m.company_id = $1
            AND m.entry_line_id IN (SELECT l.id FROM journal_entry_lines l
                                     WHERE l.entry_id IN (SELECT id_destino FROM migration_links
                                                          WHERE migration_id = $2
                                                            AND tabla_destino = 'journal_entries'))`,
        [fx.companyA, migracion],
      ),
    );
    expect(rows[0]!.n).toBe('0');
  });

  // ── 2 · Los números cuadran ────────────────────────────────────────────

  it('la existencia a la fecha de corte coincide con la que declaraba el origen', async () => {
    const diferencias = await withCompany({ companyId: fx.companyA, actorId: actor }, (tx) =>
      reconciliarStock(tx, fx.companyA, migracion),
    );

    expect(diferencias).toHaveLength(3);
    for (const d of diferencias) {
      expect(
        d.cuadra,
        `${d.sku} en ${d.deposito}: el origen decía ${d.enOrigen} y NEXO tiene ${d.enNexo}`,
      ).toBe(true);
    }
  });

  it('la existencia de hoy incluye los movimientos posteriores al corte', async () => {
    // El complemento del control anterior: si la reconciliación diera cero
    // porque nada se movió, no estaría midiendo nada. ART-001 tenía 100 al
    // corte y salieron 30 después.
    const { rows } = await enA(() =>
      raw.query<{ existencia: string }>(
        `SELECT sum(CASE WHEN sm.tipo IN ('ENTRADA','AJUSTE_POSITIVO') THEN sm.cantidad
                         ELSE -sm.cantidad END)::text AS existencia
           FROM stock_movements sm
           JOIN products p ON p.id = sm.product_id
           JOIN warehouses w ON w.id = sm.warehouse_id
          WHERE sm.company_id = $1 AND p.code = 'ART-001' AND w.code = 'CENTRAL'`,
        [fx.companyA],
      ),
    );
    expect(Number(rows[0]!.existencia)).toBe(70);
  });

  it('el debe y el haber asentados coinciden con los del archivo', async () => {
    const diferencias = await withCompany({ companyId: fx.companyA, actorId: actor }, (tx) =>
      reconciliarContabilidad(tx, fx.companyA, migracion),
    );
    for (const d of diferencias) {
      expect(d.cuadra, `${d.concepto}: origen ${d.enOrigen}, NEXO ${d.enNexo}`).toBe(true);
    }
    expect(diferencias.find((d) => d.concepto === 'Asientos')!.enNexo).toBe('2');
  });

  it('cada fila del origen terminó en alguna parte', async () => {
    const { rows } = await enA(() =>
      raw.query<{ estado: string; n: string }>(
        `SELECT estado, count(*)::text n FROM migration_rows
          WHERE migration_id = $1 GROUP BY estado ORDER BY estado`,
        [migracion],
      ),
    );
    const porEstado = Object.fromEntries(rows.map((r) => [r.estado, Number(r.n)]));
    // Ninguna quedó PENDIENTE: eso sería una fila que el importador no miró.
    expect(porEstado.PENDIENTE ?? 0).toBe(0);
    expect(porEstado.IMPORTADA).toBeGreaterThan(0);
  });

  it('el movimiento de stock dice de qué migración vino', async () => {
    const { rows } = await enA(() =>
      raw.query<{ origen_tipo: string; iguales: boolean }>(
        `SELECT DISTINCT origen_tipo, origen_id = $2 AS iguales
           FROM stock_movements WHERE company_id = $1`,
        [fx.companyA, migracion],
      ),
    );
    // Un solo origen y apuntando a esta migración: no se disfrazó de AJUSTE,
    // que diría que alguien contó y encontró otra cantidad.
    expect(rows).toEqual([{ origen_tipo: 'MIGRACION', iguales: true }]);
  });

  // ── 3 · Repetirla no duplica ───────────────────────────────────────────

  it('migrar la misma empresa otra vez no duplica nada', async () => {
    const antes = await censo(fx.companyA);
    const segunda = await migrarLaEmpresa(fx.companyA);
    const despues = await censo(fx.companyA);

    expect(despues).toEqual(antes);

    const conteos = await enA(() =>
      raw.query<{ estado: string; n: string }>(
        `SELECT estado, count(*)::text n FROM migration_rows
          WHERE migration_id = $1 GROUP BY estado`,
        [segunda],
      ),
    );
    const porEstado = Object.fromEntries(conteos.rows.map((r) => [r.estado, Number(r.n)]));
    // Todo reconocido: nada importado de nuevo.
    expect(porEstado.IMPORTADA ?? 0).toBe(0);
    expect(porEstado.YA_EXISTIA).toBeGreaterThan(0);
  }, 120_000);

  // ── 4 · Se puede deshacer, y lo que no, lo dice ────────────────────────

  it('revertir deshace lo que se puede y nombra lo que no', async () => {
    const r = await withCompany({ companyId: fx.companyA, actorId: actor }, (tx) =>
      revertir(tx, fx.companyA, actor, migracion, 'El archivo era el del ejercicio anterior'),
    );

    const porTabla = Object.fromEntries(r.deshecho.map((d) => [d.tabla, d.cantidad]));
    expect(porTabla.parties).toBe(3);
    expect(porTabla.products).toBe(2);
    expect(porTabla.warehouses).toBe(2);
    expect(porTabla.accounts).toBe(6);
    expect(porTabla.journal_entries).toBe(2);
    expect(porTabla.payment_orders).toBe(1);
    // Cinco movimientos de stock compensados con su inverso.
    expect(porTabla.stock_movements).toBe(5);

    // Y lo único que no se puede deshacer, con su motivo.
    expect(r.noReversible.map((n) => n.tabla)).toEqual(['tax_transactions']);
    expect(r.noReversible[0]!.motivo).toContain('registro de la empresa');
  });

  it('después de revertir, la existencia vuelve a cero y el libro conserva el rastro', async () => {
    const { rows } = await enA(() =>
      raw.query<{ existencia: string; movimientos: string }>(
        `SELECT coalesce(sum(CASE WHEN sm.tipo IN ('ENTRADA','AJUSTE_POSITIVO') THEN sm.cantidad
                                 ELSE -sm.cantidad END), 0)::text AS existencia,
                count(*)::text AS movimientos
           FROM stock_movements sm
           JOIN products p ON p.id = sm.product_id
          WHERE sm.company_id = $1 AND p.code = 'ART-001'`,
        [fx.companyA],
      ),
    );
    // La existencia volvió a cero...
    expect(Number(rows[0]!.existencia)).toBe(0);
    // ...y el libro tiene el doble de movimientos, no la mitad: nada se borró.
    expect(Number(rows[0]!.movimientos)).toBe(6);
  });

  it('los asientos quedaron anulados y los comprobantes siguen ahí', async () => {
    const asientos = await enA(() =>
      raw.query<{ status: string }>(
        `SELECT DISTINCT status FROM journal_entries
          WHERE company_id = $1 AND description LIKE '%[origen%'`,
        [fx.companyA],
      ),
    );
    expect(asientos.rows).toEqual([{ status: 'ANULADO' }]);

    const comprobantes = await enA(() =>
      raw.query<{ n: string }>(
        'SELECT count(*)::text n FROM tax_transactions WHERE company_id = $1',
        [fx.companyA],
      ),
    );
    // Tres: dos ventas y una compra. Siguen siendo parte del registro fiscal.
    expect(comprobantes.rows[0]!.n).toBe('3');
  });

  // ── 5 · La empresa de al lado no ve nada ───────────────────────────────

  it('la empresa B no ve ni un dato de la migración de A', async () => {
    const desdeB = await asCompany(raw, fx.companyB, async () => {
      const consultar = async (sql: string): Promise<number> =>
        Number((await raw.query<{ n: string }>(sql)).rows[0]!.n);
      return {
        migraciones: await consultar('SELECT count(*)::text n FROM migrations'),
        tandas: await consultar('SELECT count(*)::text n FROM migration_batches'),
        terceros: await consultar('SELECT count(*)::text n FROM parties'),
        productos: await consultar('SELECT count(*)::text n FROM products'),
        depositos: await consultar('SELECT count(*)::text n FROM warehouses'),
        stock: await consultar('SELECT count(*)::text n FROM stock_movements'),
        comprobantes: await consultar('SELECT count(*)::text n FROM tax_transactions'),
        asientos: await consultar('SELECT count(*)::text n FROM journal_entries'),
        pagos: await consultar('SELECT count(*)::text n FROM payment_orders'),
      };
    });

    expect(desdeB).toEqual({
      migraciones: 0,
      tandas: 0,
      terceros: 0,
      productos: 0,
      depositos: 0,
      stock: 0,
      comprobantes: 0,
      asientos: 0,
      pagos: 0,
    });
  });

  /** Cuántas filas hay de cada cosa. Sirve para afirmar que nada se duplicó. */
  async function censo(companyId: string): Promise<Record<string, number>> {
    return asCompany(raw, companyId, async () => {
      const salida: Record<string, number> = {};
      for (const tabla of [
        'parties',
        'products',
        'warehouses',
        'accounts',
        'stock_movements',
        'tax_transactions',
        'tax_transaction_lines',
        'journal_entries',
        'journal_entry_lines',
        'payment_orders',
      ]) {
        // El nombre viene de esta lista literal, nunca de un dato.
        const { rows } = await raw.query<{ n: string }>(
          `SELECT count(*)::text n FROM ${tabla} WHERE company_id = $1`,
          [companyId],
        );
        salida[tabla] = Number(rows[0]!.n);
      }
      return salida;
    });
  }
});
