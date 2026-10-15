/**
 * Idempotencia de caja y stock: una misma operación no puede generar dos movimientos.
 *
 * Diseño: `docs/DISENO_IDEMPOTENCIA.md`. La garantía vive en la base (índices únicos parciales sobre la clave que
 * viaja en la propia fila del movimiento); esta suite la ejercita en tres capas:
 *
 *   1. LA BASE sola, por SQL directo: las restricciones existen y rechazan lo que tienen que rechazar, aunque
 *      alguien se salte la API.
 *   2. LA API, secuencial: el contrato (201 la primera vez, 200 con el mismo cuerpo después, 422 si cambian los
 *      datos, 400 si falta la clave), y que una repetición no escribe nada.
 *   3. LA API, en paralelo y con fallas: N pedidos idénticos a la vez, la auditoría que falla a mitad de camino, la
 *      sesión que se cierra entre el original y el reintento.
 */

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { hasDatabase } from './helpers/db.js';
import { crearEntorno, type EntornoApi } from './helpers/entorno-api.js';

const suite = hasDatabase ? describe : describe.skip;
const PARALELO = 8;

suite('Idempotencia de caja y stock', () => {
  let e: EntornoApi;
  let cajaId: string;
  let depositoId: string;
  let otroDepositoId: string;
  let productoId: string;
  let numeroVenta = 0;

  const clave = (): string => crypto.randomUUID();
  const con = (k: string): Record<string, string> => ({ 'idempotency-key': k });

  beforeAll(async () => {
    e = await crearEntorno('idem');
    const ok = (r: { statusCode: number; body: string }) => expect(r.statusCode, r.body).toBe(201);

    ok(await e.pedir('POST', '/fiscal-years', { code: `EJ2026-${e.stamp}`, startDate: '2026-01-01', endDate: '2026-12-31' }));
    ok(await e.pedir('POST', '/accounts', { code: '1.1.01', name: 'Caja', type: 'ACTIVO' }));
    ok(await e.pedir('POST', '/accounts', { code: '5.1.01', name: 'Compras', type: 'COSTO' }));

    const caja = await e.pedir('POST', '/cash-boxes', { codigo: `CAJA-${e.stamp}`, nombre: 'Caja', cuenta: '1.1.01' });
    ok(caja);
    cajaId = caja.json<{ id: string }>().id;

    const dep = await e.pedir('POST', '/warehouses', { codigo: `DEP-${e.stamp}`, nombre: 'Depósito' });
    ok(dep);
    depositoId = dep.json<{ id: string }>().id;
    const dep2 = await e.pedir('POST', '/warehouses', { codigo: `DEQ-${e.stamp}`, nombre: 'Otro depósito' });
    ok(dep2);
    otroDepositoId = dep2.json<{ id: string }>().id;

    const prod = await e.pedir('POST', '/products', {
      codigo: `P-${e.stamp}`,
      nombre: 'Producto de idempotencia',
      impuesto: 'IVA',
      cuentaCompra: '5.1.01',
      llevaStock: true,
    });
    ok(prod);
    productoId = prod.json<{ id: string }>().id;
  }, 120_000);

  afterAll(async () => {
    await e?.cerrar();
  });

  /** Abre una sesión (con una clave nueva) y la devuelve. La caja admite una abierta a la vez: cierra la anterior. */
  async function sesionAbierta(): Promise<string> {
    const previa = await e.db.query<{ id: string }>(
      "SELECT id FROM cash_sessions WHERE company_id = $1 AND cash_box_id = $2 AND status = 'ABIERTA'",
      [e.empresa, cajaId],
    );
    for (const { id } of previa.rows) {
      const c = await e.pedir('POST', `/cash-sessions/${id}/close`, { fecha: e.hoy, saldoContado: '0.00' });
      expect([200, 409]).toContain(c.statusCode);
    }
    const r = await e.pedir('POST', '/cash-sessions', { cajaId, fecha: e.hoy, saldoInicial: '100.00' }, con(clave()));
    expect(r.statusCode, r.body).toBe(201);
    return r.json<{ id: string }>().id;
  }

  const filas = async (tabla: string, k: string): Promise<number> =>
    Number(
      (
        await e.db.query<{ n: string }>(`SELECT count(*)::text AS n FROM ${tabla} WHERE company_id = $1 AND idempotency_key = $2`, [
          e.empresa,
          k,
        ])
      ).rows[0]!.n,
    );

  const auditorias = async (accion: string): Promise<number> =>
    Number(
      (
        await e.db.query<{ n: string }>("SELECT count(*)::text AS n FROM audit_logs WHERE company_id = $1 AND action = $2", [
          e.empresa,
          accion,
        ])
      ).rows[0]!.n,
    );

  const movimiento = (sesion: string, importe = '25.00', extra: Record<string, unknown> = {}) =>
    e.pedir('POST', `/cash-sessions/${sesion}/movimientos`, { tipo: 'INGRESO', importe, fecha: e.hoy, concepto: 'Cobro de prueba', ...extra }, undefined);

  // ── 1 · La base sola ────────────────────────────────────────────────────────────────────────────────────────
  describe('la base rechaza lo que tiene que rechazar, aunque se salteen la API', () => {
    const HASH = 'a'.repeat(64);

    const insertarMovimiento = (k: string | null, parte: number, huella: string | null, empresa = e?.empresa) =>
      e.db.query(
        `INSERT INTO cash_movements (company_id, session_id, tipo, importe, fecha, concepto, created_by,
                                     idempotency_key, idempotency_part, request_hash)
         SELECT $1, s.id, 'INGRESO', 1, $2, 'Directo', 'prueba', $3, $4, $5
           FROM cash_sessions s WHERE s.company_id = $1 AND s.status = 'ABIERTA' LIMIT 1`,
        [empresa, e.hoy, k, parte, huella],
      );

    it('la misma clave y la misma parte no entran dos veces', async () => {
      await sesionAbierta();
      const k = clave();
      await insertarMovimiento(k, 0, HASH);
      await expect(insertarMovimiento(k, 0, HASH)).rejects.toMatchObject({ code: '23505', constraint: 'cmv_clave_unica' });
    });

    it('la misma clave con OTRA parte sí entra (una operación de varias filas)', async () => {
      await sesionAbierta();
      const k = clave();
      await insertarMovimiento(k, 0, HASH);
      await insertarMovimiento(k, 1, HASH);
      expect(await filas('cash_movements', k)).toBe(2);
    });

    it('sin clave, no hay restricción: los movimientos viejos y los del sistema no chocan entre sí', async () => {
      await sesionAbierta();
      await insertarMovimiento(null, 0, null);
      await insertarMovimiento(null, 0, null);
    });

    it('una clave sin huella, o una huella sin clave, se rechaza', async () => {
      await sesionAbierta();
      await expect(insertarMovimiento(clave(), 0, null)).rejects.toMatchObject({ constraint: 'cmv_clave_con_huella' });
      await expect(insertarMovimiento(null, 0, HASH)).rejects.toMatchObject({ constraint: 'cmv_clave_con_huella' });
    });

    it('una clave con la forma equivocada se rechaza', async () => {
      await sesionAbierta();
      await expect(insertarMovimiento('corta', 0, HASH)).rejects.toMatchObject({ constraint: 'cmv_clave_valida' });
      await expect(insertarMovimiento(`${clave()}!`, 0, HASH)).rejects.toMatchObject({ constraint: 'cmv_clave_valida' });
      await expect(insertarMovimiento('x'.repeat(129), 0, HASH)).rejects.toMatchObject({ constraint: 'cmv_clave_valida' });
    });

    it('50 inserciones simultáneas con la misma clave desde conexiones distintas: exactamente UNA fila', async () => {
      await sesionAbierta();
      const { default: pg } = await import('pg');
      const k = clave();
      const conexiones = await Promise.all(
        Array.from({ length: 50 }, async () => {
          const c = new pg.Client({ connectionString: process.env['DATABASE_URL'] });
          await c.connect();
          return c;
        }),
      );
      try {
        const resultados = await Promise.allSettled(
          conexiones.map((c) =>
            c.query(
              `INSERT INTO cash_movements (company_id, session_id, tipo, importe, fecha, concepto, created_by,
                                           idempotency_key, idempotency_part, request_hash)
               SELECT $1, s.id, 'INGRESO', 1, $2, 'Simultáneo', 'prueba', $3, 0, $4
                 FROM cash_sessions s WHERE s.company_id = $1 AND s.status = 'ABIERTA' LIMIT 1`,
              [e.empresa, e.hoy, k, HASH],
            ),
          ),
        );
        expect(resultados.filter((r) => r.status === 'fulfilled')).toHaveLength(1);
        for (const r of resultados.filter((x) => x.status === 'rejected')) {
          expect((r as PromiseRejectedResult).reason).toMatchObject({ code: '23505' });
        }
        expect(await filas('cash_movements', k)).toBe(1);
      } finally {
        await Promise.all(conexiones.map((c) => c.end()));
      }
    });

    it('el mismo índice protege el stock y la apertura de sesión', async () => {
      const k = clave();
      const stock = (parte: number) =>
        e.db.query(
          `INSERT INTO stock_movements (company_id, product_id, warehouse_id, tipo, cantidad, fecha, origen_tipo,
                                        motivo, created_by, idempotency_key, idempotency_part, request_hash)
           VALUES ($1, $2, $3, 'AJUSTE_POSITIVO', 1, $4, 'AJUSTE', 'Directo', 'prueba', $5, $6, $7)`,
          [e.empresa, productoId, depositoId, e.hoy, k, parte, HASH],
        );
      await stock(0);
      await expect(stock(0)).rejects.toMatchObject({ constraint: 'sm_clave_unica' });
      await stock(1);
    });
  });

  // ── 2 · La API, secuencial ──────────────────────────────────────────────────────────────────────────────────
  describe('el contrato de la API', () => {
    it('sin Idempotency-Key, o con una que no tiene la forma, es 400 y no escribe nada', async () => {
      const sesion = await sesionAbierta();
      const antes = (await e.db.query<{ n: string }>('SELECT count(*)::text AS n FROM cash_movements WHERE company_id = $1', [e.empresa])).rows[0]!.n;

      const sinClave = await movimiento(sesion);
      expect(sinClave.statusCode, sinClave.body).toBe(400);
      expect(sinClave.json<{ message: string }>().message).toMatch(/Idempotency-Key/u);

      const corta = await e.pedir('POST', `/cash-sessions/${sesion}/movimientos`, { tipo: 'INGRESO', importe: '1.00', fecha: e.hoy, concepto: 'abc' }, con('corta'));
      expect(corta.statusCode, corta.body).toBe(400);

      const despues = (await e.db.query<{ n: string }>('SELECT count(*)::text AS n FROM cash_movements WHERE company_id = $1', [e.empresa])).rows[0]!.n;
      expect(despues).toBe(antes);
    });

    it('las seis operaciones que crean un movimiento exigen la clave', async () => {
      const sesion = await sesionAbierta();
      const sin = [
        movimiento(sesion),
        e.pedir('POST', '/cash-sessions', { cajaId, fecha: e.hoy, saldoInicial: '1.00' }),
        e.pedir('POST', '/stock-movements/salida', { productoId, depositoId, cantidad: '1', fecha: e.hoy, taxTransactionId: crypto.randomUUID() }),
        e.pedir('POST', '/stock-movements/ajuste', { productoId, depositoId, cantidad: '1', fecha: e.hoy, sentido: 'POSITIVO', motivo: 'prueba' }),
        e.pedir('POST', '/stock-movements/transferencia', { productoId, origenDepositoId: depositoId, destinoDepositoId: otroDepositoId, cantidad: '1', fecha: e.hoy }),
        e.pedir('POST', `/tax-transactions/${crypto.randomUUID()}/salida`, { depositoId, lineas: [{ productoId, cantidad: '1' }] }),
      ];
      for (const r of await Promise.all(sin)) expect(r.statusCode, r.body).toBe(400);
    });

    it('movimiento de caja: 201 la primera vez, 200 con el MISMO cuerpo después, y una sola fila', async () => {
      const sesion = await sesionAbierta();
      const k = clave();
      const cuerpo = { tipo: 'INGRESO', importe: '25.00', fecha: e.hoy, concepto: 'Cobro de prueba' };

      const primera = await e.pedir('POST', `/cash-sessions/${sesion}/movimientos`, cuerpo, con(k));
      expect(primera.statusCode, primera.body).toBe(201);
      expect(primera.headers['idempotent-replayed']).toBeUndefined();

      const segunda = await e.pedir('POST', `/cash-sessions/${sesion}/movimientos`, cuerpo, con(k));
      expect(segunda.statusCode, segunda.body).toBe(200);
      expect(segunda.headers['idempotent-replayed']).toBe('true');
      expect(segunda.json()).toEqual(primera.json());

      expect(await filas('cash_movements', k)).toBe(1);
    });

    it('el orden de los campos del cuerpo no cambia la operación: un reintento con otro orden sigue siendo el mismo', async () => {
      const sesion = await sesionAbierta();
      const k = clave();
      const primera = await e.pedir('POST', `/cash-sessions/${sesion}/movimientos`, { tipo: 'INGRESO', importe: '12.00', fecha: e.hoy, concepto: 'Cobro de prueba' }, con(k));
      expect(primera.statusCode, primera.body).toBe(201);
      // Otro cliente (u otra versión del mismo) serializa los campos en otro orden.
      const reordenado = await e.pedir('POST', `/cash-sessions/${sesion}/movimientos`, { concepto: 'Cobro de prueba', fecha: e.hoy, importe: '12.00', tipo: 'INGRESO' }, con(k));
      expect(reordenado.statusCode, reordenado.body).toBe(200);
      expect(reordenado.json()).toEqual(primera.json());
    });

    it('la misma clave con OTROS datos es 422 IDEMPOTENCIA_CONFLICTO y no escribe nada', async () => {
      const sesion = await sesionAbierta();
      const k = clave();
      const base = { tipo: 'INGRESO', importe: '25.00', fecha: e.hoy, concepto: 'Cobro de prueba' };
      expect((await e.pedir('POST', `/cash-sessions/${sesion}/movimientos`, base, con(k))).statusCode).toBe(201);

      for (const distinto of [{ importe: '26.00' }, { tipo: 'EGRESO' }, { concepto: 'Otro concepto' }, { fecha: '2026-01-02' }]) {
        const r = await e.pedir('POST', `/cash-sessions/${sesion}/movimientos`, { ...base, ...distinto }, con(k));
        expect(r.statusCode, r.body).toBe(422);
        expect(r.json<{ error: string }>().error).toBe('IDEMPOTENCIA_CONFLICTO');
      }
      expect(await filas('cash_movements', k)).toBe(1);
    });

    it('la misma clave en OTRA sesión es otra operación: 422, no un reintento', async () => {
      const primera = await sesionAbierta();
      const k = clave();
      const cuerpo = { tipo: 'INGRESO', importe: '5.00', fecha: e.hoy, concepto: 'Cobro de prueba' };
      expect((await e.pedir('POST', `/cash-sessions/${primera}/movimientos`, cuerpo, con(k))).statusCode).toBe(201);
      const segunda = await sesionAbierta();
      const r = await e.pedir('POST', `/cash-sessions/${segunda}/movimientos`, cuerpo, con(k));
      expect(r.statusCode, r.body).toBe(422);
      expect(r.json<{ error: string }>().error).toBe('IDEMPOTENCIA_CONFLICTO');
    });

    it('dos movimientos reales iguales con claves distintas son dos movimientos', async () => {
      const sesion = await sesionAbierta();
      const cuerpo = { tipo: 'INGRESO', importe: '7.00', fecha: e.hoy, concepto: 'Cobro de prueba' };
      const a = await e.pedir('POST', `/cash-sessions/${sesion}/movimientos`, cuerpo, con(clave()));
      const b = await e.pedir('POST', `/cash-sessions/${sesion}/movimientos`, cuerpo, con(clave()));
      expect([a.statusCode, b.statusCode]).toEqual([201, 201]);
      expect(a.json<{ id: string }>().id).not.toBe(b.json<{ id: string }>().id);
    });

    it('la respuesta se pierde después de cerrar la sesión: el reintento devuelve lo mismo, no «sesión cerrada»', async () => {
      const sesion = await sesionAbierta();
      const k = clave();
      const cuerpo = { tipo: 'INGRESO', importe: '9.00', fecha: e.hoy, concepto: 'Cobro de prueba' };
      const primera = await e.pedir('POST', `/cash-sessions/${sesion}/movimientos`, cuerpo, con(k));
      expect(primera.statusCode).toBe(201);
      expect((await e.pedir('POST', `/cash-sessions/${sesion}/close`, { fecha: e.hoy, saldoContado: '109.00' })).statusCode).toBe(200);

      const reintento = await e.pedir('POST', `/cash-sessions/${sesion}/movimientos`, cuerpo, con(k));
      expect(reintento.statusCode, reintento.body).toBe(200);
      expect(reintento.json()).toEqual(primera.json());

      // Y una operación NUEVA sobre la sesión cerrada sigue rechazada.
      const nueva = await e.pedir('POST', `/cash-sessions/${sesion}/movimientos`, cuerpo, con(clave()));
      expect(nueva.statusCode, nueva.body).toBe(409);
    });

    it('abrir sesión: el reintento devuelve la misma sesión, escribe UNA auditoría y no choca con «ya hay una abierta»', async () => {
      await sesionAbierta(); // cierra las anteriores
      const previa = await e.db.query<{ id: string }>("SELECT id FROM cash_sessions WHERE company_id = $1 AND status = 'ABIERTA'", [e.empresa]);
      await e.pedir('POST', `/cash-sessions/${previa.rows[0]!.id}/close`, { fecha: e.hoy, saldoContado: '100.00' });

      const antes = await auditorias('ABRIR_CAJA');
      const k = clave();
      const cuerpo = { cajaId, fecha: e.hoy, saldoInicial: '300.00' };
      const primera = await e.pedir('POST', '/cash-sessions', cuerpo, con(k));
      expect(primera.statusCode, primera.body).toBe(201);
      const segunda = await e.pedir('POST', '/cash-sessions', cuerpo, con(k));
      expect(segunda.statusCode, segunda.body).toBe(200);
      expect(segunda.json()).toEqual(primera.json());
      expect(await filas('cash_sessions', k)).toBe(1);
      expect(await auditorias('ABRIR_CAJA')).toBe(antes + 1);

      // Con OTRA clave, la regla de siempre: una sola sesión abierta por caja.
      const otra = await e.pedir('POST', '/cash-sessions', cuerpo, con(clave()));
      expect(otra.statusCode, otra.body).toBe(409);
    });

    it('ajuste de stock: una sola fila, una sola auditoría, y la existencia cambia una vez', async () => {
      const k = clave();
      const cuerpo = { productoId, depositoId, cantidad: '4', fecha: e.hoy, sentido: 'POSITIVO', motivo: 'Existencia inicial de la prueba' };
      const antes = await auditorias('AJUSTAR_STOCK');
      const primera = await e.pedir('POST', '/stock-movements/ajuste', cuerpo, con(k));
      expect(primera.statusCode, primera.body).toBe(201);
      const segunda = await e.pedir('POST', '/stock-movements/ajuste', cuerpo, con(k));
      expect(segunda.statusCode, segunda.body).toBe(200);
      expect(segunda.json()).toEqual(primera.json());
      expect(await filas('stock_movements', k)).toBe(1);
      expect(await auditorias('AJUSTAR_STOCK')).toBe(antes + 1);

      const distinto = await e.pedir('POST', '/stock-movements/ajuste', { ...cuerpo, cantidad: '5' }, con(k));
      expect(distinto.statusCode).toBe(422);
    });

    it('transferencia: las DOS filas se crean juntas y el reintento devuelve las dos', async () => {
      const k = clave();
      const cuerpo = { productoId, origenDepositoId: depositoId, destinoDepositoId: otroDepositoId, cantidad: '2', fecha: e.hoy };
      const primera = await e.pedir('POST', '/stock-movements/transferencia', cuerpo, con(k));
      expect(primera.statusCode, primera.body).toBe(201);
      const segunda = await e.pedir('POST', '/stock-movements/transferencia', cuerpo, con(k));
      expect(segunda.statusCode, segunda.body).toBe(200);
      expect(segunda.json()).toEqual(primera.json());
      expect(await filas('stock_movements', k)).toBe(2);

      const partes = await e.db.query<{ idempotency_part: number; tipo: string }>(
        'SELECT idempotency_part, tipo FROM stock_movements WHERE company_id = $1 AND idempotency_key = $2 ORDER BY idempotency_part',
        [e.empresa, k],
      );
      expect(partes.rows.map((p) => [p.idempotency_part, p.tipo])).toEqual([
        [0, 'TRANSFERENCIA_SALIDA'],
        [1, 'TRANSFERENCIA_ENTRADA'],
      ]);
    });

    it('una transferencia que falla no deja una mitad ni consume la clave', async () => {
      const k = clave();
      // El destino no existe: la salida se inserta y la entrada falla por la clave foránea → todo se revierte.
      const mala = { productoId, origenDepositoId: depositoId, destinoDepositoId: crypto.randomUUID(), cantidad: '1', fecha: e.hoy };
      const r = await e.pedir('POST', '/stock-movements/transferencia', mala, con(k));
      expect(r.statusCode, r.body).toBeGreaterThanOrEqual(400);
      expect(await filas('stock_movements', k)).toBe(0);

      // La clave no quedó consumida: el mismo pedido corregido, con la misma clave, es una operación nueva… con OTROS
      // datos, y como no hay nada registrado con esa clave, entra normalmente.
      const buena = { ...mala, destinoDepositoId: otroDepositoId };
      const ok = await e.pedir('POST', '/stock-movements/transferencia', buena, con(k));
      expect(ok.statusCode, ok.body).toBe(201);
      expect(await filas('stock_movements', k)).toBe(2);
    });

    it('la misma clave en dos empresas es dos operaciones independientes', async () => {
      const otra = await crearEntorno('idem2');
      try {
        const k = clave();
        const caja2 = await otra.pedir('POST', '/cash-boxes', { codigo: `C2-${otra.stamp}`, nombre: 'Caja 2' });
        expect(caja2.statusCode, caja2.body).toBe(201);
        await sesionAbierta();
        const previa = await e.db.query<{ id: string }>("SELECT id FROM cash_sessions WHERE company_id = $1 AND status = 'ABIERTA'", [e.empresa]);
        await e.pedir('POST', `/cash-sessions/${previa.rows[0]!.id}/close`, { fecha: e.hoy, saldoContado: '100.00' });

        const a = await e.pedir('POST', '/cash-sessions', { cajaId, fecha: e.hoy, saldoInicial: '1.00' }, con(k));
        const b = await otra.pedir('POST', '/cash-sessions', { cajaId: caja2.json<{ id: string }>().id, fecha: otra.hoy, saldoInicial: '1.00' }, con(k));
        expect([a.statusCode, b.statusCode], `${a.body} / ${b.body}`).toEqual([201, 201]);
        expect(a.json<{ id: string }>().id).not.toBe(b.json<{ id: string }>().id);
      } finally {
        // `otra.cerrar()` cerraría también el pool, que es uno por proceso y lo comparte el entorno principal.
        await otra.db.end();
      }
    });
  });

  // ── 3 · Salida de un comprobante ────────────────────────────────────────────────────────────────────────────
  describe('salida de un comprobante de venta', () => {
    async function venta(): Promise<string> {
      numeroVenta += 1;
      const forma =
        `--X\r\nContent-Disposition: form-data; name="file"; filename="i-${e.stamp}-${numeroVenta}.xml"\r\n` +
        `Content-Type: application/xml\r\n\r\n<c><n>${numeroVenta}</n></c>\r\n--X--\r\n`;
      const subida = await e.pedir('POST', '/documents', forma, { 'content-type': 'multipart/form-data; boundary=X' });
      expect(subida.statusCode, subida.body).toBe(201);
      const op = await e.pedir('POST', `/documents/${subida.json<{ id: string }>().id}/tax-transaction`, {
        direction: 'VENTAS',
        cbteTipo: 1,
        puntoVenta: 4,
        numero: numeroVenta,
        fecha: e.hoy,
        cuitContraparte: '30500000006',
        razonSocial: 'Cliente',
        condicionIva: 'RESPONSABLE_INSCRIPTO',
        neto: '100.00',
        iva: '21.00',
        noGravado: '0',
        exento: '0',
        percepciones: '0',
        total: '121.00',
      });
      expect(op.statusCode, op.body).toBe(201);
      return op.json<{ taxTransactionId: string }>().taxTransactionId;
    }

    it('el reintento devuelve los mismos ids, en el mismo orden, y no registra otra salida', async () => {
      const v = await venta();
      const k = clave();
      const cuerpo = { depositoId, lineas: [{ productoId, cantidad: '1' }, { productoId, cantidad: '2' }, { productoId, cantidad: '3' }] };
      const primera = await e.pedir('POST', `/tax-transactions/${v}/salida`, cuerpo, con(k));
      expect(primera.statusCode, primera.body).toBe(201);
      expect(primera.json<{ ids: string[] }>().ids).toHaveLength(3);

      const segunda = await e.pedir('POST', `/tax-transactions/${v}/salida`, cuerpo, con(k));
      expect(segunda.statusCode, segunda.body).toBe(200);
      expect(segunda.json()).toEqual(primera.json());
      expect(await filas('stock_movements', k)).toBe(3);
    });

    it('otra clave sobre el mismo comprobante NO es un reintento: sigue siendo 409 «ya tiene salida»', async () => {
      const v = await venta();
      const cuerpo = { depositoId, lineas: [{ productoId, cantidad: '1' }] };
      expect((await e.pedir('POST', `/tax-transactions/${v}/salida`, cuerpo, con(clave()))).statusCode).toBe(201);
      const otra = await e.pedir('POST', `/tax-transactions/${v}/salida`, cuerpo, con(clave()));
      expect(otra.statusCode, otra.body).toBe(409);
    });

    it('la misma clave con otras líneas es 422', async () => {
      const v = await venta();
      const k = clave();
      expect((await e.pedir('POST', `/tax-transactions/${v}/salida`, { depositoId, lineas: [{ productoId, cantidad: '1' }] }, con(k))).statusCode).toBe(201);
      const r = await e.pedir('POST', `/tax-transactions/${v}/salida`, { depositoId, lineas: [{ productoId, cantidad: '2' }] }, con(k));
      expect(r.statusCode, r.body).toBe(422);
      expect(r.json<{ error: string }>().error).toBe('IDEMPOTENCIA_CONFLICTO');
    });

    it(`${PARALELO} claves DISTINTAS a la vez sobre el mismo comprobante: una sola salida (I4)`, async () => {
      const v = await venta();
      const cuerpo = { depositoId, lineas: [{ productoId, cantidad: '2' }] };
      const respuestas = await Promise.all(
        Array.from({ length: PARALELO }, () => e.pedir('POST', `/tax-transactions/${v}/salida`, cuerpo, con(clave()))),
      );
      const codigos = respuestas.map((r) => r.statusCode).sort();
      expect(codigos.filter((c) => c === 201), codigos.join(',')).toHaveLength(1);
      expect(codigos.filter((c) => c === 409)).toHaveLength(PARALELO - 1);
      const n = await e.db.query<{ n: string }>("SELECT count(*)::text AS n FROM stock_movements WHERE company_id = $1 AND origen_tipo = 'VENTA' AND origen_id = $2", [e.empresa, v]);
      expect(n.rows[0]!.n).toBe('1');
    });

    it('la salida de un comprobante ESPERA el candado del comprobante (determinístico, sin depender de la suerte)', async () => {
      const v = await venta();
      const cuerpo = { depositoId, lineas: [{ productoId, cantidad: '1' }] };
      const { default: pg } = await import('pg');
      const c = new pg.Client({ connectionString: process.env['DATABASE_URL'] });
      await c.connect();
      try {
        await c.query('BEGIN');
        await c.query('SELECT 1 FROM tax_transactions WHERE id = $1 FOR UPDATE', [v]);

        let termino = false;
        const pedido = e.pedir('POST', `/tax-transactions/${v}/salida`, cuerpo, con(clave())).then((r) => {
          termino = true;
          return r;
        });
        await new Promise((r) => setTimeout(r, 700));
        expect(termino, 'la salida no esperó el candado del comprobante: dos salidas pueden cruzarse').toBe(false);

        await c.query('COMMIT');
        const r = await pedido;
        expect(r.statusCode, r.body).toBe(201);
      } finally {
        await c.query('ROLLBACK').catch(() => undefined);
        await c.end();
      }
    });
  });

  // ── 4 · Concurrencia ────────────────────────────────────────────────────────────────────────────────────────
  describe('pedidos idénticos a la vez', () => {
    it(`${PARALELO} movimientos de caja idénticos: un 201, el resto 200, MISMO id, una fila`, async () => {
      const sesion = await sesionAbierta();
      const k = clave();
      const cuerpo = { tipo: 'EGRESO', importe: '3.00', fecha: e.hoy, concepto: 'Pago de prueba' };
      const rs = await Promise.all(Array.from({ length: PARALELO }, () => e.pedir('POST', `/cash-sessions/${sesion}/movimientos`, cuerpo, con(k))));
      const codigos = rs.map((r) => r.statusCode).sort();
      expect(codigos.filter((c) => c === 201), codigos.join(',')).toHaveLength(1);
      expect(codigos.filter((c) => c === 200)).toHaveLength(PARALELO - 1);
      expect(new Set(rs.map((r) => r.json<{ id: string }>().id)).size).toBe(1);
      expect(await filas('cash_movements', k)).toBe(1);
    });

    it(`${PARALELO} aperturas de sesión idénticas, 15 rondas: una sesión por ronda, nunca un 409 en un reintento`, async () => {
      // Hay DOS índices únicos en juego (la clave y «una abierta por caja»); sin el candado por clave, 2 de cada 320
      // reintentos simultáneos recibían 409 «ya hay una sesión abierta» en lugar de la repetición. Una ronda no lo
      // muestra de forma confiable: por eso son 15 (120 pedidos).
      for (let ronda = 0; ronda < 15; ronda++) {
        const previa = await e.db.query<{ id: string }>("SELECT id FROM cash_sessions WHERE company_id = $1 AND status = 'ABIERTA'", [e.empresa]);
        for (const { id } of previa.rows) await e.pedir('POST', `/cash-sessions/${id}/close`, { fecha: e.hoy, saldoContado: '0.00' });

        const k = clave();
        const antes = await auditorias('ABRIR_CAJA');
        const cuerpo = { cajaId, fecha: e.hoy, saldoInicial: '50.00' };
        const rs = await Promise.all(Array.from({ length: PARALELO }, () => e.pedir('POST', '/cash-sessions', cuerpo, con(k))));
        const detalle = rs.map((r) => `${r.statusCode}`).sort().join(',') + ' ' + (rs.find((r) => r.statusCode >= 400)?.body ?? '');
        expect(rs.filter((r) => r.statusCode === 201), `ronda ${ronda}: ${detalle}`).toHaveLength(1);
        expect(rs.filter((r) => r.statusCode === 200), `ronda ${ronda}: ${detalle}`).toHaveLength(PARALELO - 1);
        expect(new Set(rs.map((r) => r.json<{ id: string }>().id)).size).toBe(1);
        expect(await auditorias('ABRIR_CAJA')).toBe(antes + 1);
      }
    }, 120_000);

    it('abrir sesión ESPERA el candado de su clave (determinístico: no depende de que el cruce ocurra)', async () => {
      const previa = await e.db.query<{ id: string }>("SELECT id FROM cash_sessions WHERE company_id = $1 AND status = 'ABIERTA'", [e.empresa]);
      for (const { id } of previa.rows) await e.pedir('POST', `/cash-sessions/${id}/close`, { fecha: e.hoy, saldoContado: '0.00' });

      const k = clave();
      const { default: pg } = await import('pg');
      const c = new pg.Client({ connectionString: process.env['DATABASE_URL'] });
      await c.connect();
      try {
        await c.query('BEGIN');
        await c.query('SELECT pg_advisory_xact_lock(hashtextextended($1, 0))', [`idempotencia:${e.empresa}:${k}`]);

        let termino = false;
        const pedido = e.pedir('POST', '/cash-sessions', { cajaId, fecha: e.hoy, saldoInicial: '10.00' }, con(k)).then((r) => {
          termino = true;
          return r;
        });
        await new Promise((r) => setTimeout(r, 700));
        expect(termino, 'la apertura no esperó el candado de su clave: dos aperturas idénticas pueden cruzarse').toBe(false);

        await c.query('COMMIT');
        const r = await pedido;
        expect(r.statusCode, r.body).toBe(201);
      } finally {
        await c.query('ROLLBACK').catch(() => undefined);
        await c.end();
      }
    });

    it(`${PARALELO} transferencias idénticas: dos filas en total, no ${PARALELO * 2}`, async () => {
      const k = clave();
      const cuerpo = { productoId, origenDepositoId: depositoId, destinoDepositoId: otroDepositoId, cantidad: '1', fecha: e.hoy };
      const rs = await Promise.all(Array.from({ length: PARALELO }, () => e.pedir('POST', '/stock-movements/transferencia', cuerpo, con(k))));
      const codigos = rs.map((r) => r.statusCode).sort();
      expect(codigos.filter((c) => c === 201), codigos.join(',')).toHaveLength(1);
      expect(codigos.filter((c) => c === 200)).toHaveLength(PARALELO - 1);
      expect(await filas('stock_movements', k)).toBe(2);
      expect(new Set(rs.map((r) => JSON.stringify(r.json()))).size).toBe(1);
    });

    it(`${PARALELO} ajustes idénticos: una fila y una auditoría`, async () => {
      const k = clave();
      const antes = await auditorias('AJUSTAR_STOCK');
      const cuerpo = { productoId, depositoId, cantidad: '1', fecha: e.hoy, sentido: 'POSITIVO', motivo: 'Ajuste concurrente de la prueba' };
      const rs = await Promise.all(Array.from({ length: PARALELO }, () => e.pedir('POST', '/stock-movements/ajuste', cuerpo, con(k))));
      expect(rs.map((r) => r.statusCode).filter((c) => c === 201)).toHaveLength(1);
      expect(await filas('stock_movements', k)).toBe(1);
      expect(await auditorias('AJUSTAR_STOCK')).toBe(antes + 1);
    });

    it('misma clave con datos DISTINTOS a la vez: gana uno, los demás son 422 y no queda mezcla', async () => {
      const sesion = await sesionAbierta();
      const k = clave();
      const rs = await Promise.all(
        Array.from({ length: PARALELO }, (_, i) =>
          e.pedir('POST', `/cash-sessions/${sesion}/movimientos`, { tipo: 'INGRESO', importe: `${i + 1}.00`, fecha: e.hoy, concepto: 'Distinto' }, con(k)),
        ),
      );
      const codigos = rs.map((r) => r.statusCode).sort();
      expect(codigos.filter((c) => c === 201), codigos.join(',')).toHaveLength(1);
      expect(codigos.filter((c) => c === 422)).toHaveLength(PARALELO - 1);
      expect(await filas('cash_movements', k)).toBe(1);
    });
  });

  // ── 5 · Fallas a mitad de camino ────────────────────────────────────────────────────────────────────────────
  describe('fallas a mitad de camino', () => {
    it('si la auditoría falla DESPUÉS del insert, no queda nada y la clave no se consume', async () => {
      const previa = await e.db.query<{ id: string }>("SELECT id FROM cash_sessions WHERE company_id = $1 AND status = 'ABIERTA'", [e.empresa]);
      for (const { id } of previa.rows) await e.pedir('POST', `/cash-sessions/${id}/close`, { fecha: e.hoy, saldoContado: '0.00' });

      // Un candado de prueba SOLO para esta empresa (las demás suites corren en paralelo contra la misma base).
      await e.db.query(
        `CREATE FUNCTION prueba_falla_la_auditoria() RETURNS trigger LANGUAGE plpgsql AS $$
         BEGIN RAISE EXCEPTION 'falla simulada de la auditoría'; END; $$`,
      );
      await e.db.query(
        `CREATE TRIGGER prueba_falla_la_auditoria BEFORE INSERT ON audit_logs
           FOR EACH ROW WHEN (NEW.company_id = '${e.empresa}' AND NEW.action = 'ABRIR_CAJA')
           EXECUTE FUNCTION prueba_falla_la_auditoria()`,
      );
      const k = clave();
      const cuerpo = { cajaId, fecha: e.hoy, saldoInicial: '75.00' };
      try {
        const falla = await e.pedir('POST', '/cash-sessions', cuerpo, con(k));
        expect(falla.statusCode, falla.body).toBe(500);
        expect(await filas('cash_sessions', k), 'el insert sobrevivió a la falla de la auditoría').toBe(0);
      } finally {
        await e.db.query('DROP TRIGGER prueba_falla_la_auditoria ON audit_logs');
        await e.db.query('DROP FUNCTION prueba_falla_la_auditoria()');
      }

      // El reintento con la MISMA clave ejecuta la operación completa.
      const ok = await e.pedir('POST', '/cash-sessions', cuerpo, con(k));
      expect(ok.statusCode, ok.body).toBe(201);
      expect(await filas('cash_sessions', k)).toBe(1);
    });
  });

  // ── 6 · Cierre de caja: la transición también es idempotente ───────────────────────────────────────────────
  describe('cierre de caja', () => {
    it('el mismo cierre repetido devuelve el MISMO cuerpo (200) y no escribe otra auditoría', async () => {
      const sesion = await sesionAbierta();
      const antes = await auditorias('ARQUEAR_CAJA');
      const cuerpo = { fecha: e.hoy, saldoContado: '99.00', motivo: 'Faltó un vuelto' };
      const primera = await e.pedir('POST', `/cash-sessions/${sesion}/close`, cuerpo);
      expect(primera.statusCode, primera.body).toBe(200);
      expect(primera.headers['idempotent-replayed']).toBeUndefined();

      const segunda = await e.pedir('POST', `/cash-sessions/${sesion}/close`, cuerpo);
      expect(segunda.statusCode, segunda.body).toBe(200);
      expect(segunda.headers['idempotent-replayed']).toBe('true');
      expect(segunda.json()).toEqual(primera.json());
      expect(await auditorias('ARQUEAR_CAJA')).toBe(antes + 1);
    });

    it('un cierre con OTRO arqueo sobre una sesión ya cerrada es 409 y el arqueo no cambia', async () => {
      const sesion = await sesionAbierta();
      expect((await e.pedir('POST', `/cash-sessions/${sesion}/close`, { fecha: e.hoy, saldoContado: '100.00' })).statusCode).toBe(200);
      const otro = await e.pedir('POST', `/cash-sessions/${sesion}/close`, { fecha: e.hoy, saldoContado: '1.00' });
      expect(otro.statusCode, otro.body).toBe(409);
      const fila = await e.db.query<{ saldo_contado: string }>('SELECT saldo_contado::text FROM cash_sessions WHERE id = $1', [sesion]);
      expect(fila.rows[0]!.saldo_contado).toBe('100.00');
    });

    it('un arqueo igual pero de OTRA persona no es un reintento: 409 (quién cerró es parte de lo firmado)', async () => {
      const sesion = await sesionAbierta();
      // La cierra «otra persona» por el camino de la base, con los mismos datos que después se piden por la API.
      await e.db.query(
        `UPDATE cash_sessions SET status = 'CERRADA', cerrada_el = $2, saldo_contado = 100.00, closed_by = 'user:otra-persona' WHERE id = $1`,
        [sesion, e.hoy],
      );
      const r = await e.pedir('POST', `/cash-sessions/${sesion}/close`, { fecha: e.hoy, saldoContado: '100.00' });
      expect(r.statusCode, r.body).toBe(409);
    });

    it(`${PARALELO} cierres IDÉNTICOS a la vez: todos 200 con el mismo cuerpo y un solo arqueo`, async () => {
      const sesion = await sesionAbierta();
      const antes = await auditorias('ARQUEAR_CAJA');
      const cuerpo = { fecha: e.hoy, saldoContado: '100.00' };
      const rs = await Promise.all(Array.from({ length: PARALELO }, () => e.pedir('POST', `/cash-sessions/${sesion}/close`, cuerpo)));
      expect(rs.map((r) => r.statusCode), rs.map((r) => r.body).join('\n')).toEqual(Array(PARALELO).fill(200));
      expect(new Set(rs.map((r) => JSON.stringify(r.json()))).size).toBe(1);
      expect(rs.filter((r) => r.headers['idempotent-replayed'] === 'true')).toHaveLength(PARALELO - 1);
      expect(await auditorias('ARQUEAR_CAJA')).toBe(antes + 1);
    });
  });

  // ── 7 · Propiedad: cualquier secuencia de reintentos deja un movimiento por clave ──────────────────────────
  describe('propiedad', () => {
    it('en cualquier orden y con cualquier cantidad de reintentos, hay exactamente una fila por clave', async () => {
      const sesion = await sesionAbierta();
      // Generador determinístico (para que una falla se pueda reproducir).
      let semilla = 20261014;
      const azar = (n: number): number => {
        semilla = (semilla * 1664525 + 1013904223) % 4294967296;
        return semilla % n;
      };

      const pool = Array.from({ length: 6 }, () => clave());
      const importeDe = (i: number): string => `${i + 1}.00`;
      const idPorClave = new Map<string, string>();

      for (let paso = 0; paso < 60; paso++) {
        const i = azar(pool.length);
        const k = pool[i]!;
        const r = await e.pedir('POST', `/cash-sessions/${sesion}/movimientos`, { tipo: 'INGRESO', importe: importeDe(i), fecha: e.hoy, concepto: `Clave ${i}` }, con(k));
        expect([200, 201], r.body).toContain(r.statusCode);
        const id = r.json<{ id: string }>().id;
        if (idPorClave.has(k)) {
          expect(r.statusCode).toBe(200);
          expect(id, 'un reintento devolvió otro movimiento').toBe(idPorClave.get(k));
        } else {
          expect(r.statusCode).toBe(201);
          idPorClave.set(k, id);
        }
      }

      for (const k of idPorClave.keys()) expect(await filas('cash_movements', k)).toBe(1);
      const total = await e.db.query<{ n: string }>('SELECT count(*)::text AS n FROM cash_movements WHERE session_id = $1', [sesion]);
      expect(Number(total.rows[0]!.n)).toBe(idPorClave.size);
    });

    it('200 operaciones EN PARALELO con claves repetidas a propósito: filas == claves distintas, y el saldo es la suma de las únicas', async () => {
      const sesion = await sesionAbierta();
      let semilla = 8675309;
      const azar = (n: number): number => {
        semilla = (semilla * 1664525 + 1013904223) % 4294967296;
        return semilla % n;
      };
      const pool = Array.from({ length: 25 }, () => clave());
      const eleccion = Array.from({ length: 200 }, () => azar(pool.length));

      const rs = await Promise.all(
        eleccion.map((i) =>
          e.pedir('POST', `/cash-sessions/${sesion}/movimientos`, { tipo: 'INGRESO', importe: `${i + 1}.00`, fecha: e.hoy, concepto: `Clave ${i}` }, con(pool[i]!)),
        ),
      );
      expect(rs.map((r) => r.statusCode).filter((c) => c !== 200 && c !== 201), rs.find((r) => r.statusCode >= 400)?.body).toEqual([]);

      const distintas = new Set(eleccion);
      expect(rs.filter((r) => r.statusCode === 201)).toHaveLength(distintas.size);
      const filasEnLaBase = await e.db.query<{ n: string; suma: string }>(
        "SELECT count(*)::text AS n, coalesce(sum(importe), 0)::text AS suma FROM cash_movements WHERE session_id = $1",
        [sesion],
      );
      expect(Number(filasEnLaBase.rows[0]!.n)).toBe(distintas.size);
      const esperado = [...distintas].reduce((acc, i) => acc + (i + 1), 0);
      expect(Number(filasEnLaBase.rows[0]!.suma)).toBe(esperado);
    });
  });
});
