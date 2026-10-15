/**
 * Transiciones de estado de caja y stock BAJO CONCURRENCIA.
 *
 * Una transición («cerrar», «confirmar») no crea una fila nueva sino que cambia el estado de una existente, y el
 * código que la hace lee el estado con un `SELECT` suelto y después escribe. Entre las dos cosas puede entrar otra
 * petición. La auditoría del 2026-10-15 (`docs/DISENO_IDEMPOTENCIA.md` §6) encontró que en caja y stock eso no
 * estaba cubierto por la base, y este archivo es la prueba de cada defecto y de su corrección.
 *
 * ## Invariantes que se defienden
 *
 *   I1. **Un arqueo de caja ocurre una vez.** Una sesión cerrada no vuelve a cambiar: ni su saldo contado, ni quién
 *       la cerró, ni cuándo. Dos cierres simultáneos no pueden dar dos arqueos ni pisarse.
 *   I2. **Una sesión cerrada no recibe movimientos, aunque el movimiento y el cierre se crucen.** El saldo
 *       teórico contra el que se contó no puede cambiar después de contar.
 *   I3. **Un recuento de stock se cierra una vez**, y sus diferencias se ajustan una vez. Dos cierres simultáneos no
 *       pueden duplicar los ajustes del libro (que es append-only: un ajuste duplicado no se deshace, se compensa).
 *   I4. **La salida de un comprobante de venta se registra una vez**, también bajo concurrencia.
 *
 * Los casos de interleaving determinístico (I2) usan dos conexiones SQL con transacciones abiertas y `lock_timeout`:
 * el comportamiento correcto es que la segunda ESPERE a la primera (55P03 a los 800 ms), y el defectuoso es que
 * entre sin esperar y deje un movimiento dentro de una sesión ya cerrada.
 */

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import pg from 'pg';
import { hasDatabase } from './helpers/db.js';
import { crearEntorno, type EntornoApi } from './helpers/entorno-api.js';

const suite = hasDatabase ? describe : describe.skip;
const PARALELO = 6;

suite('Transiciones de caja y stock bajo concurrencia', () => {
  let e: EntornoApi;
  let cajaId: string;
  let depositoId: string;
  let productoId: string;
  let numeroVenta = 0;

  const clave = (): Record<string, string> => ({ 'idempotency-key': crypto.randomUUID() });

  beforeAll(async () => {
    e = await crearEntorno('conc');
    const ok = (r: { statusCode: number; body: string }, esperado = 201) => expect(r.statusCode, r.body).toBe(esperado);

    ok(await e.pedir('POST', '/fiscal-years', { code: `EJ2026-${e.stamp}`, startDate: '2026-01-01', endDate: '2026-12-31' }));
    ok(await e.pedir('POST', '/accounts', { code: '1.1.01', name: 'Caja', type: 'ACTIVO' }));
    ok(await e.pedir('POST', '/accounts', { code: '5.1.01', name: 'Compras', type: 'COSTO' }));

    const caja = await e.pedir('POST', '/cash-boxes', { codigo: `CAJA-${e.stamp}`, nombre: 'Caja', cuenta: '1.1.01' });
    ok(caja);
    cajaId = caja.json<{ id: string }>().id;

    const dep = await e.pedir('POST', '/warehouses', { codigo: `DEP-${e.stamp}`, nombre: 'Depósito' });
    ok(dep);
    depositoId = dep.json<{ id: string }>().id;

    const prod = await e.pedir('POST', '/products', {
      codigo: `P-${e.stamp}`,
      nombre: 'Producto de concurrencia',
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

  /** Una conexión SQL aparte, con el timeout de bloqueo corto, para armar un cruce a mano. */
  async function conexion(): Promise<pg.Client> {
    const c = new pg.Client({ connectionString: process.env['DATABASE_URL'] });
    await c.connect();
    await c.query("SET lock_timeout = '800ms'");
    return c;
  }

  async function abrirSesion(saldoInicial = '1000.00'): Promise<string> {
    const r = await e.pedir('POST', '/cash-sessions', { cajaId, fecha: e.hoy, saldoInicial }, clave());
    expect(r.statusCode, r.body).toBe(201);
    return r.json<{ id: string }>().id;
  }

  /** Cierra la sesión que haya abierta de la caja, para poder abrir otra. */
  async function cerrarSesion(id: string): Promise<void> {
    const r = await e.pedir('POST', `/cash-sessions/${id}/close`, { fecha: e.hoy, saldoContado: '1000.00' });
    expect([200, 409]).toContain(r.statusCode);
  }

  describe('I1 · un arqueo de caja ocurre una vez', () => {
    it(`${PARALELO} cierres simultáneos: uno gana, los demás reciben 409 y el arqueo no se pisa`, async () => {
      const id = await abrirSesion();
      const respuestas = await Promise.all(
        Array.from({ length: PARALELO }, (_, i) =>
          e.pedir('POST', `/cash-sessions/${id}/close`, { fecha: e.hoy, saldoContado: `${1000 + i}.00` }),
        ),
      );

      const codigos = respuestas.map((r) => r.statusCode).sort();
      expect(codigos.filter((c) => c === 200), `respuestas: ${codigos.join(',')}`).toHaveLength(1);
      expect(codigos.filter((c) => c === 409)).toHaveLength(PARALELO - 1);

      // El arqueo que quedó es el del que ganó y nada más: no hubo una segunda escritura encima.
      const ganadora = respuestas.find((r) => r.statusCode === 200)!;
      const contado = ganadora.json<{ saldoContado: string }>().saldoContado;
      const fila = await e.db.query<{ saldo_contado: string; status: string }>(
        'SELECT saldo_contado::text, status FROM cash_sessions WHERE id = $1',
        [id],
      );
      expect(fila.rows[0]!.status).toBe('CERRADA');
      expect(fila.rows[0]!.saldo_contado).toBe(contado);

      // Y la bitácora cuenta un solo arqueo, no uno por cada petición que llegó.
      const auditoria = await e.db.query<{ n: string }>(
        "SELECT count(*)::text AS n FROM audit_logs WHERE company_id = $1 AND action = 'ARQUEAR_CAJA' AND object_id = $2",
        [e.empresa, id],
      );
      expect(auditoria.rows[0]!.n).toBe('1');
    });

    it('una sesión cerrada no se puede volver a modificar ni por SQL directo', async () => {
      const id = await abrirSesion();
      await cerrarSesion(id);
      await expect(
        e.db.query("UPDATE cash_sessions SET saldo_contado = 1, closed_by = 'otro' WHERE id = $1", [id]),
      ).rejects.toThrow(/E_CAJA_YA_ARQUEADA/u);
      await expect(
        e.db.query("UPDATE cash_sessions SET status = 'ABIERTA', cerrada_el = NULL WHERE id = $1", [id]),
      ).rejects.toThrow(/E_CAJA_YA_ARQUEADA/u);
    });
  });

  describe('I2 · una sesión cerrada no recibe movimientos, aunque se crucen', () => {
    const insertarMovimiento = (c: pg.Client, sesion: string) =>
      c.query(
        `INSERT INTO cash_movements (company_id, session_id, tipo, importe, fecha, concepto, created_by)
         VALUES ($1, $2, 'INGRESO', 10, $3, 'Cruce con el cierre', 'prueba')`,
        [e.empresa, sesion, e.hoy],
      );
    const cerrarPorSql = (c: pg.Client, sesion: string) =>
      c.query(
        `UPDATE cash_sessions SET status = 'CERRADA', cerrada_el = $2, saldo_contado = 0, closed_by = 'prueba' WHERE id = $1`,
        [sesion, e.hoy],
      );

    it('movimiento primero, cierre después: el cierre ESPERA a que el movimiento termine', async () => {
      const id = await abrirSesion();
      const a = await conexion();
      const b = await conexion();
      try {
        await a.query('BEGIN');
        await insertarMovimiento(a, id); // todavía sin confirmar
        await b.query('BEGIN');
        // Sin el candado, esto pasa sin esperar y la sesión queda cerrada con un movimiento que el arqueo no vio.
        await expect(cerrarPorSql(b, id)).rejects.toMatchObject({ code: '55P03' });
      } finally {
        await a.query('ROLLBACK').catch(() => undefined);
        await b.query('ROLLBACK').catch(() => undefined);
        await a.end();
        await b.end();
        await cerrarSesion(id);
      }
    });

    it('cierre primero, movimiento después: el movimiento ESPERA y después se rechaza', async () => {
      const id = await abrirSesion();
      const a = await conexion();
      const b = await conexion();
      try {
        await b.query('BEGIN');
        await cerrarPorSql(b, id); // cierre sin confirmar
        await a.query('BEGIN');
        // Sin el candado, el movimiento no ve el cierre (todavía no se confirmó) y entra a una sesión que va a quedar cerrada.
        await expect(insertarMovimiento(a, id)).rejects.toMatchObject({ code: '55P03' });
      } finally {
        await a.query('ROLLBACK').catch(() => undefined);
        await b.query('ROLLBACK').catch(() => undefined);
        await a.end();
        await b.end();
        await cerrarSesion(id);
      }
    });

    it('el caso secuencial sigue funcionando: sesión cerrada, movimiento rechazado con E_CAJA_CERRADA', async () => {
      const id = await abrirSesion();
      await cerrarSesion(id);
      await expect(insertarMovimiento(e.db, id)).rejects.toThrow(/E_CAJA_CERRADA/u);
    });
  });

  describe('I3 · un recuento de stock se cierra una vez', () => {
    async function recuentoConDiferencia(): Promise<string> {
      // Existencia 10, se cuentan 7: diferencia −3, un ajuste negativo.
      const ajuste = await e.pedir(
        'POST',
        '/stock-movements/ajuste',
        { productoId, depositoId, cantidad: '10', fecha: e.hoy, sentido: 'POSITIVO', motivo: 'Existencia inicial de la prueba' },
        clave(),
      );
      expect(ajuste.statusCode, ajuste.body).toBe(201);
      const alta = await e.pedir('POST', '/stock-counts', { depositoId, fecha: e.hoy });
      expect(alta.statusCode, alta.body).toBe(201);
      const id = alta.json<{ id: string }>().id;
      const lineas = await e.pedir('PUT', `/stock-counts/${id}/lines`, { renglones: [{ productoId, cantidad: '7' }] });
      expect(lineas.statusCode, lineas.body).toBe(200);
      return id;
    }

    it(`${PARALELO} cierres simultáneos: un solo cierre y los ajustes se aplican UNA vez`, async () => {
      const id = await recuentoConDiferencia();
      const respuestas = await Promise.all(
        Array.from({ length: PARALELO }, () => e.pedir('POST', `/stock-counts/${id}/close`, {})),
      );
      const codigos = respuestas.map((r) => r.statusCode).sort();
      expect(codigos.filter((c) => c === 200), `respuestas: ${codigos.join(',')}`).toHaveLength(1);
      expect(codigos.filter((c) => c === 409)).toHaveLength(PARALELO - 1);

      const ajustes = await e.db.query<{ n: string }>(
        "SELECT count(*)::text AS n FROM stock_movements WHERE company_id = $1 AND motivo LIKE $2",
        [e.empresa, `%${id}%`],
      );
      expect(ajustes.rows[0]!.n, 'el ajuste del recuento se duplicó').toBe('1');
    });

    it('un recuento cerrado no vuelve a cambiar de estado ni por SQL directo', async () => {
      const id = await recuentoConDiferencia();
      expect((await e.pedir('POST', `/stock-counts/${id}/close`, {})).statusCode).toBe(200);
      await expect(
        e.db.query("UPDATE stock_counts SET closed_by = 'otro' WHERE id = $1", [id]),
      ).rejects.toThrow(/E_RECUENTO_CERRADO/u);
    });
  });

  describe('I4 · la salida de un comprobante de venta se registra una vez', () => {
    async function ventaConProducto(): Promise<string> {
      numeroVenta += 1;
      const forma =
        `--X\r\nContent-Disposition: form-data; name="file"; filename="v-${e.stamp}-${numeroVenta}.xml"\r\n` +
        `Content-Type: application/xml\r\n\r\n<c><n>${numeroVenta}</n></c>\r\n--X--\r\n`;
      const subida = await e.pedir('POST', '/documents', forma, { 'content-type': 'multipart/form-data; boundary=X' });
      expect(subida.statusCode, subida.body).toBe(201);

      const op = await e.pedir('POST', `/documents/${subida.json<{ id: string }>().id}/tax-transaction`, {
        direction: 'VENTAS',
        cbteTipo: 1,
        puntoVenta: 3,
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

    it(`${PARALELO} registros simultáneos de la misma salida: uno gana y no queda stock descontado de más`, async () => {
      const venta = await ventaConProducto();
      const cuerpo = { depositoId, lineas: [{ productoId, cantidad: '2' }] };
      const respuestas = await Promise.all(
        Array.from({ length: PARALELO }, () => e.pedir('POST', `/tax-transactions/${venta}/salida`, cuerpo, clave())),
      );
      const codigos = respuestas.map((r) => r.statusCode).sort();
      expect(codigos.filter((c) => c === 201), `respuestas: ${codigos.join(',')}`).toHaveLength(1);

      const filas = await e.db.query<{ n: string }>(
        "SELECT count(*)::text AS n FROM stock_movements WHERE company_id = $1 AND origen_tipo = 'VENTA' AND origen_id = $2",
        [e.empresa, venta],
      );
      expect(filas.rows[0]!.n, 'la salida del comprobante se duplicó').toBe('1');
    });
  });
});
