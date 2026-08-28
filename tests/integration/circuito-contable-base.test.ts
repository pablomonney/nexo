/**
 * El circuito contable base, de punta a punta y por HTTP.
 *
 *   VARIOS ASIENTOS → LIBRO DIARIO → MAYOR → BALANCE DE COMPROBACIÓN
 *
 * Los tres libros ya existían y el motor puro los tiene bien cubiertos
 * (`libros.test.ts`, 60 tests). Lo que **no** tenía una sola prueba era el
 * cableado: las 743 líneas de `routes/books.ts` que leen PostgreSQL y arman lo
 * que el motor espera. Todo lo que este archivo encontró estaba ahí, en la
 * juntura, y no en ninguno de los dos lados.
 *
 * El criterio que ordena las afirmaciones: **el Diario, el Mayor y el balance
 * son la misma fuente leída tres veces**. No alcanza con que cada uno cuadre por
 * separado —los tres cuadraban— sino que tienen que coincidir entre sí. Un
 * balance que cierra sus tres igualdades y aun así contradice al Mayor es el
 * modo de fallo peligroso, porque se ve sano.
 */

import { closePool, initPool } from '@aai/db';
import { buildServer } from '@aai/api/server';
import { totp, withCheckDigit } from '@aai/shared';
import type { FastifyInstance } from 'fastify';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { connect, hasDatabase, type Client } from './helpers/db.js';
import { sufijoUnico } from './helpers/identificadores.js';

const suite = hasDatabase ? describe : describe.skip;

const PASSWORD = 'una-contrasena-suficientemente-larga';

/** Enero completo. Todo el circuito vive acá salvo lo que mira a febrero. */
const ENERO = { desde: '2026-01-01', hasta: '2026-01-31' };

interface CuentaDelMayorHttp {
  codigo: string;
  nombre: string;
  naturaleza: string;
  saldoInicial: string;
  totalDebe: string;
  totalHaber: string;
  saldoFinal: string;
  movimientos: { asientoId: string; debe: string; haber: string; saldo: string }[];
}

interface RespuestaMayor {
  totales: { debe: string; haber: string };
  balance: { cuadra: boolean; verificaciones: { codigo: string; cumple: boolean }[] };
  cuentas: CuentaDelMayorHttp[];
}

interface RespuestaDiario {
  asientos: number;
  cumpleFormalidades: boolean;
  controles: { codigo: string; cumple: boolean; incumplen: string[] }[];
  excluidos: { id: string; motivo: string }[];
  totales: { debe: string; haber: string };
  folios: {
    numero: number;
    asientos: {
      id: string;
      numero: number;
      fecha: string;
      estado: string;
      tipo: string;
      anulaA: string | null;
      decisionId?: string | null;
      lineas: { cuenta: string; debe: string; haber: string }[];
    }[];
  }[];
}

interface RespuestaBalance {
  cuadra: boolean;
  totales: { debitos: string; creditos: string };
  lineas: {
    codigo: string;
    naturaleza: string;
    saldoInicial: string;
    debitos: string;
    creditos: string;
    saldoFinal: string;
  }[];
}

suite('Circuito contable base: Diario → Mayor → Balance', () => {
  let app: FastifyInstance;
  let db: Client;
  let token: string;
  let empresaA: string;
  let empresaB: string;
  let periodoEnero: string;

  /** Los asientos de la empresa A, para poder afirmar sobre cada uno. */
  const asientos: Record<string, string> = {};

  const cab = (empresa: string) => ({
    authorization: `Bearer ${token}`,
    'x-company-id': empresa,
  });

  // -------------------------------------------------------------------------
  // Utilidades de armado
  // -------------------------------------------------------------------------

  async function postear(
    empresa: string,
    cuerpo: Record<string, unknown>,
  ): Promise<{ status: number; id: string; body: string }> {
    const r = await app.inject({
      method: 'POST',
      url: '/journal-entries',
      headers: cab(empresa),
      payload: cuerpo,
    });
    return {
      status: r.statusCode,
      id: r.statusCode === 201 ? r.json<{ id: string }>().id : '',
      body: r.body,
    };
  }

  async function aprobar(empresa: string, entryId: string): Promise<number> {
    const r = await app.inject({
      method: 'POST',
      url: `/journal-entries/${entryId}/approve`,
      headers: cab(empresa),
    });
    if (r.statusCode !== 200) throw new Error(`approve ${r.statusCode}: ${r.body}`);
    return r.statusCode;
  }

  /** Venta de contado: Caja al Debe, Ventas al Haber. */
  const venta = (fecha: string, importe: string, extra: Record<string, unknown> = {}) => ({
    journalCode: 'GENERAL',
    entryDate: fecha,
    description: `Venta de contado por ${importe}`,
    currency: 'ARS',
    lines: [
      { accountCode: '1.1.01', debit: importe, credit: '0' },
      { accountCode: '4.1.01', debit: '0', credit: importe },
    ],
    source: { type: 'MANUAL', id: null },
    manualJustification: 'Venta de contado registrada por la contadora',
    ...extra,
  });

  async function diario(empresa: string, rango = ENERO): Promise<RespuestaDiario> {
    const r = await app.inject({
      method: 'GET',
      url: `/books/diario?desde=${rango.desde}&hasta=${rango.hasta}`,
      headers: cab(empresa),
    });
    expect(r.statusCode, r.body).toBe(200);
    return r.json<RespuestaDiario>();
  }

  async function mayor(empresa: string, rango = ENERO, cuenta?: string): Promise<RespuestaMayor> {
    const filtro = cuenta === undefined ? '' : `&cuenta=${cuenta}`;
    const r = await app.inject({
      method: 'GET',
      url: `/books/mayor?desde=${rango.desde}&hasta=${rango.hasta}${filtro}`,
      headers: cab(empresa),
    });
    expect(r.statusCode, r.body).toBe(200);
    return r.json<RespuestaMayor>();
  }

  async function balance(empresa: string, rango = ENERO): Promise<RespuestaBalance> {
    const r = await app.inject({
      method: 'GET',
      url: `/reports/trial-balance?desde=${rango.desde}&hasta=${rango.hasta}`,
      headers: cab(empresa),
    });
    expect(r.statusCode, r.body).toBe(200);
    return r.json<RespuestaBalance>();
  }

  function cuentaDelMayor(m: RespuestaMayor, codigo: string): CuentaDelMayorHttp {
    const encontrada = m.cuentas.find((c) => c.codigo === codigo);
    if (encontrada === undefined) {
      throw new Error(`El Mayor no trae la cuenta ${codigo}: ${m.cuentas.map((c) => c.codigo).join(', ')}`);
    }
    return encontrada;
  }

  function lineaDelBalance(b: RespuestaBalance, codigo: string): RespuestaBalance['lineas'][number] {
    const encontrada = b.lineas.find((l) => l.codigo === codigo);
    if (encontrada === undefined) {
      throw new Error(`El balance no trae la cuenta ${codigo}`);
    }
    return encontrada;
  }

  // -------------------------------------------------------------------------
  // Montaje
  // -------------------------------------------------------------------------

  beforeAll(async () => {
    initPool(process.env.DATABASE_URL!);
    app = await buildServer();
    await app.ready();
    db = await connect();

    const stamp = await sufijoUnico(db);
    const email = `contadora-circuito-${stamp}@estudio.test`;
    const { hash: argonHash } = await import('@node-rs/argon2');
    const hash = await argonHash(PASSWORD, {
      algorithm: 2,
      memoryCost: 19_456,
      timeCost: 2,
      parallelism: 1,
    });
    const usuario = await db.query<{ id: string }>(
      'INSERT INTO users (email, full_name, password_hash) VALUES ($1,$2,$3) RETURNING id',
      [email, 'Contadora', hash],
    );
    const userId = usuario.rows[0]!.id;

    const org = await db.query<{ create_organization: string }>(
      'SELECT create_organization($1,$2,$3)',
      [`Estudio circuito ${stamp}`, withCheckDigit(`30${stamp}`), userId],
    );
    const organizationId = org.rows[0]!.create_organization;

    const crearEmpresa = async (nombre: string, prefijo: string): Promise<string> => {
      const c = await db.query<{ create_company: string }>(
        'SELECT create_company($1,$2,$3,$4,$5,$6,$7,$8)',
        [
          userId,
          organizationId,
          nombre,
          withCheckDigit(`${prefijo}${stamp}`),
          'SRL',
          'AR-C',
          'IGJ',
          '12-31',
        ],
      );
      const id = c.rows[0]!.create_company;
      await db.query('SELECT grant_company_role($1,$2,$3,$4)', [userId, id, userId, 'CONTADOR']);
      return id;
    };

    empresaA = await crearEmpresa('Empresa A circuito', '33');
    empresaB = await crearEmpresa('Empresa B circuito', '27');

    // MFA: sin segundo factor el rol CONTADOR no llega a ninguna de las dos.
    const inicial = (
      await app.inject({ method: 'POST', url: '/auth/login', payload: { email, password: PASSWORD } })
    ).json<{ token: string }>().token;
    const secret = (
      await app.inject({
        method: 'POST',
        url: '/auth/mfa/setup',
        headers: { authorization: `Bearer ${inicial}` },
      })
    ).json<{ secret: string }>().secret;
    await app.inject({
      method: 'POST',
      url: '/auth/mfa/confirm',
      payload: { code: totp(secret, Date.now()) },
      headers: { authorization: `Bearer ${inicial}` },
    });
    token = (
      await app.inject({ method: 'POST', url: '/auth/login', payload: { email, password: PASSWORD } })
    ).json<{ token: string }>().token;
    await app.inject({
      method: 'POST',
      url: '/auth/mfa/verify',
      payload: { code: totp(secret, Date.now()) },
      headers: { authorization: `Bearer ${token}` },
    });

    // Plan de cuentas de cada empresa. Los mismos códigos en las dos: si hubiera
    // fuga entre empresas, códigos distintos la esconderían.
    for (const empresa of [empresaA, empresaB]) {
      // `1.1` es agrupadora por tener hijos — el trigger de la 0003 le quita
      // `is_postable` sola cuando nace `1.1.01`.
      const padre = await app.inject({
        method: 'POST',
        url: '/accounts',
        headers: cab(empresa),
        payload: { code: '1.1', name: 'Disponibilidades', type: 'ACTIVO' },
      });
      const padreId = padre.json<{ id: string }>().id;

      for (const cuenta of [
        { code: '1.1.01', name: 'Caja', type: 'ACTIVO', parentId: padreId },
        { code: '4.1.01', name: 'Ventas', type: 'INGRESO' },
        { code: '5.1.01', name: 'Gastos generales', type: 'GASTO' },
      ]) {
        const r = await app.inject({
          method: 'POST',
          url: '/accounts',
          headers: cab(empresa),
          payload: cuenta,
        });
        expect(r.statusCode, r.body).toBe(201);
      }

      const ejercicio = await app.inject({
        method: 'POST',
        url: '/fiscal-years',
        headers: cab(empresa),
        payload: { code: `EJ2026-${stamp}`, startDate: '2026-01-01', endDate: '2026-12-31' },
      });
      expect(ejercicio.statusCode, ejercicio.body).toBe(201);
    }

    const periodos = (
      await app.inject({ method: 'GET', url: '/periods', headers: cab(empresaA) })
    ).json<{ periods: { id: string; number: number }[] }>().periods;
    periodoEnero = periodos.find((p) => p.number === 1)!.id;

    // ---- Los asientos de la empresa A -------------------------------------
    // A1, A4 y A2 aprobados; A3 queda PROPUESTO a propósito. A4 se anula con su
    // contraasiento. Es el mínimo que ejercita las cuatro situaciones que el
    // Mayor tiene que distinguir.
    //
    // Se postean en orden de fecha y el PROPUESTO va último a propósito: el
    // número correlativo se consume aunque el asiento no llegue al libro, así
    // que un PROPUESTO en el medio dejaría un hueco de numeración y una
    // inversión cronológica reales —los controles del art. 324 los denunciarían
    // con razón— y este archivo estaría midiendo eso en vez del circuito.
    const a1 = await postear(empresaA, venta('2026-01-10', '1210.00'));
    expect(a1.status, a1.body).toBe(201);
    asientos.a1 = a1.id;
    expect(await aprobar(empresaA, a1.id)).toBe(200);

    const a4 = await postear(empresaA, venta('2026-01-15', '300.00'));
    asientos.a4 = a4.id;
    expect(await aprobar(empresaA, a4.id)).toBe(200);
    const reversa = await app.inject({
      method: 'POST',
      url: `/journal-entries/${a4.id}/reverse`,
      headers: cab(empresaA),
      payload: { motivo: 'Se registró dos veces la misma venta' },
    });
    expect(reversa.statusCode, reversa.body).toBe(201);
    asientos.contra = reversa.json<{ contraasientoId: string }>().contraasientoId;

    const a2 = await postear(empresaA, venta('2026-01-20', '500.00'));
    asientos.a2 = a2.id;
    expect(await aprobar(empresaA, a2.id)).toBe(200);

    const a3 = await postear(empresaA, venta('2026-01-25', '777.00'));
    expect(a3.status, a3.body).toBe(201);
    asientos.a3 = a3.id; // se queda en PROPUESTO

    // ---- La empresa B, con un importe imposible de confundir --------------
    const b1 = await postear(empresaB, venta('2026-01-10', '999999.00'));
    expect(b1.status, b1.body).toBe(201);
    asientos.b1 = b1.id;
    expect(await aprobar(empresaB, b1.id)).toBe(200);
  });

  afterAll(async () => {
    await app?.close();
    await db?.end();
    await closePool();
  });

  // -------------------------------------------------------------------------
  // 1 · Libro Diario
  // -------------------------------------------------------------------------

  describe('1 · Libro Diario', () => {
    it('trae los asientos registrables con fecha, cuentas, Debe y Haber', async () => {
      const libro = await diario(empresaA);
      const todos = libro.folios.flatMap((f) => f.asientos);

      // A1, A2, A4 (anulado) y el contraasiento. A3 no: está PROPUESTO.
      expect(libro.asientos).toBe(4);
      expect(todos.map((a) => a.id).sort()).toEqual(
        [asientos.a1, asientos.a2, asientos.a4, asientos.contra].sort(),
      );

      const primero = todos.find((a) => a.id === asientos.a1)!;
      expect(primero.fecha).toBe('2026-01-10');
      expect(primero.estado).toBe('APROBADO');
      expect(primero.lineas.map((l) => [l.cuenta, l.debe, l.haber])).toEqual([
        ['1.1.01', '1210.00', '0.00'],
        ['4.1.01', '0.00', '1210.00'],
      ]);
    });

    it('un asiento no aprobado no aparece como definitivo, y se dice por qué', async () => {
      const libro = await diario(empresaA);
      expect(libro.folios.flatMap((f) => f.asientos).map((a) => a.id)).not.toContain(asientos.a3);
      expect(libro.excluidos.find((e) => e.id === asientos.a3)?.motivo).toMatch(/PROPUESTO/);
    });

    it('no duplica asientos: cada uno aparece una sola vez', async () => {
      const ids = (await diario(empresaA)).folios.flatMap((f) => f.asientos).map((a) => a.id);
      expect(new Set(ids).size).toBe(ids.length);
    });

    it('Debe = Haber en el total del libro', async () => {
      const libro = await diario(empresaA);
      // 1210 + 500 + 300 + 300 del contraasiento.
      expect(libro.totales.debe).toBe('2310.00');
      expect(libro.totales.debe).toBe(libro.totales.haber);
    });

    it('cumple las formalidades del CCyC con los asientos de este circuito', async () => {
      const libro = await diario(empresaA);
      const fallando = libro.controles.filter((c) => !c.cumple);
      expect(fallando.map((c) => `${c.codigo}: ${c.incumplen.join(',')}`)).toEqual([]);
      expect(libro.cumpleFormalidades).toBe(true);
    });
  });

  // -------------------------------------------------------------------------
  // 2 · Libro Mayor
  // -------------------------------------------------------------------------

  describe('2 · Libro Mayor', () => {
    it('da saldo inicial, Debe, Haber y saldo final de una cuenta', async () => {
      const caja = cuentaDelMayor(await mayor(empresaA, ENERO, '1.1.01'), '1.1.01');

      expect(caja.nombre).toBe('Caja');
      expect(caja.naturaleza).toBe('DEUDORA');
      // Primer mes de vida de la empresa: no hay nada antes.
      expect(caja.saldoInicial).toBe('0.00');
      expect(caja.totalDebe).toBe('2010.00'); // 1210 + 500 + 300
      expect(caja.totalHaber).toBe('300.00'); // el contraasiento
      expect(caja.saldoFinal).toBe('1710.00');
    });

    it('el saldo de cada movimiento es el acumulado, no el importe suelto', async () => {
      const caja = cuentaDelMayor(await mayor(empresaA, ENERO, '1.1.01'), '1.1.01');
      expect(caja.movimientos.map((m) => m.saldo)).toEqual([
        '1210.00', // A1 el día 10
        '1510.00', // A4 el día 15
        '1210.00', // contraasiento, mismo día 15
        '1710.00', // A2 el día 20
      ]);
    });

    it('el asiento PROPUESTO no llega al Mayor: todavía no es contabilidad', async () => {
      // Es el mismo universo que el Diario, o el Mayor deja de ser su proyección.
      // El importe 777 solo existe en A3; si aparece, el Mayor se armó sobre
      // otra cosa.
      const caja = cuentaDelMayor(await mayor(empresaA, ENERO, '1.1.01'), '1.1.01');
      expect(caja.movimientos.map((m) => m.asientoId)).not.toContain(asientos.a3);
      expect(caja.totalDebe).not.toBe('2787.00');
    });

    it('el anulado se queda y lo compensa el contraasiento', async () => {
      const caja = cuentaDelMayor(await mayor(empresaA, ENERO, '1.1.01'), '1.1.01');
      const ids = caja.movimientos.map((m) => m.asientoId);
      expect(ids).toContain(asientos.a4);
      expect(ids).toContain(asientos.contra);
    });

    it('Debe = Haber en el total del Mayor, y coincide con el del Diario', async () => {
      const m = await mayor(empresaA);
      const d = await diario(empresaA);
      expect(m.totales.debe).toBe(m.totales.haber);
      expect(m.totales.debe).toBe(d.totales.debe);
    });

    it('arrastra el saldo de enero como saldo inicial de febrero', async () => {
      const febrero = await mayor(empresaA, { desde: '2026-02-01', hasta: '2026-02-28' });
      const caja = cuentaDelMayor(febrero, '1.1.01');
      expect(caja.saldoInicial).toBe('1710.00');
      expect(caja.totalDebe).toBe('0.00');
      expect(caja.saldoFinal).toBe('1710.00');
    });

    it('la verificación contra el Mayor materializado coincide', async () => {
      // `ledger_movements` solo recibe asientos aprobados. Si el Mayor
      // reconstruido metiera de más, esta verificación tendría que discrepar —y
      // discrepar acá significa que uno de los dos está mal, no que el control
      // sea ruidoso.
      const r = await app.inject({
        method: 'POST',
        url: '/books/ledger-verification',
        headers: cab(empresaA),
        payload: ENERO,
      });
      expect(r.statusCode, r.body).toBe(200);
      const cuerpo = r.json<{ coincide: boolean; discrepancias: unknown[] }>();
      expect(cuerpo.discrepancias).toEqual([]);
      expect(cuerpo.coincide).toBe(true);
    });
  });

  // -------------------------------------------------------------------------
  // 3 · Balance de comprobación
  // -------------------------------------------------------------------------

  describe('3 · Balance de comprobación', () => {
    it('muestra código, nombre y saldo por cuenta, y cierra sus igualdades', async () => {
      const b = await balance(empresaA);
      expect(b.cuadra).toBe(true);
      expect(b.totales.debitos).toBe(b.totales.creditos);

      const caja = lineaDelBalance(b, '1.1.01');
      expect(caja.naturaleza).toBe('DEUDORA');
      const ventas = lineaDelBalance(b, '4.1.01');
      expect(ventas.naturaleza).toBe('ACREEDORA');
      // Positivo = deudor. Una cuenta de ingresos queda acreedora.
      expect(ventas.saldoFinal.startsWith('-')).toBe(true);
    });

    it('coincide con el Mayor cuenta por cuenta', async () => {
      // La afirmación central de este archivo. Los dos cuadran por separado; lo
      // que hay que probar es que dicen lo mismo, porque salen del mismo Diario.
      const b = await balance(empresaA);
      const m = await mayor(empresaA);

      for (const cuenta of m.cuentas) {
        const linea = lineaDelBalance(b, cuenta.codigo);
        expect(
          [cuenta.codigo, linea.debitos, linea.creditos, linea.saldoFinal],
          `la cuenta ${cuenta.codigo} no coincide entre Mayor y balance`,
        ).toEqual([cuenta.codigo, cuenta.totalDebe, cuenta.totalHaber, cuenta.saldoFinal]);
      }
    });

    it('el asiento anulado y su contraasiento se neutralizan, no se pierde uno solo', async () => {
      // Si el balance dejara afuera el ANULADO pero conservara su contraasiento,
      // seguiría cuadrando —el contraasiento está balanceado— y mostraría un
      // saldo menor sin decir nada. Ese es el fallo silencioso que se busca.
      const caja = lineaDelBalance(await balance(empresaA), '1.1.01');
      expect(caja.debitos).toBe('2010.00');
      expect(caja.creditos).toBe('300.00');
      expect(caja.saldoFinal).toBe('1710.00');
    });

    it('el balance de febrero arranca del saldo final de enero', async () => {
      const b = await balance(empresaA, { desde: '2026-02-01', hasta: '2026-02-28' });
      expect(lineaDelBalance(b, '1.1.01').saldoInicial).toBe('1710.00');
    });
  });

  // -------------------------------------------------------------------------
  // 4 · Aislamiento entre empresas
  // -------------------------------------------------------------------------

  describe('4 · Multiempresa', () => {
    it('el Diario de A no trae nada de B, ni al revés', async () => {
      const a = await diario(empresaA);
      const b = await diario(empresaB);

      expect(a.folios.flatMap((f) => f.asientos).map((x) => x.id)).not.toContain(asientos.b1);
      expect(b.folios.flatMap((f) => f.asientos).map((x) => x.id)).not.toContain(asientos.a1);
      expect(b.asientos).toBe(1);
      expect(b.totales.debe).toBe('999999.00');
    });

    it('el Mayor de A no cuenta los movimientos de B', async () => {
      const caja = cuentaDelMayor(await mayor(empresaA, ENERO, '1.1.01'), '1.1.01');
      expect(caja.saldoFinal).toBe('1710.00');

      const cajaB = cuentaDelMayor(await mayor(empresaB, ENERO, '1.1.01'), '1.1.01');
      expect(cajaB.saldoFinal).toBe('999999.00');
    });

    it('el balance de A no incluye ningún importe de B', async () => {
      const b = await balance(empresaA);
      expect(b.totales.debitos).toBe('2310.00');
      expect(b.lineas.map((l) => l.debitos)).not.toContain('999999.00');
    });

    it('sin rol en la empresa, ningún libro contesta 2xx', async () => {
      const ajena = await db.query<{ id: string }>(
        'SELECT id FROM companies WHERE id <> $1 AND id <> $2 LIMIT 1',
        [empresaA, empresaB],
      );
      const otra = ajena.rows[0];
      if (otra === undefined) return; // base recién creada: no hay tercera empresa

      for (const url of [
        `/books/diario?desde=${ENERO.desde}&hasta=${ENERO.hasta}`,
        `/books/mayor?desde=${ENERO.desde}&hasta=${ENERO.hasta}`,
        `/reports/trial-balance?desde=${ENERO.desde}&hasta=${ENERO.hasta}`,
      ]) {
        const r = await app.inject({ method: 'GET', url, headers: cab(otra.id) });
        expect(r.statusCode, `${url} contestó ${r.statusCode}`).toBeGreaterThanOrEqual(400);
      }
    });
  });

  // -------------------------------------------------------------------------
  // 5 · Períodos
  // -------------------------------------------------------------------------

  describe('5 · Períodos', () => {
    it('una fecha fuera de todo período no entra', async () => {
      const r = await postear(empresaA, venta('2025-12-15', '100.00'));
      expect(r.status).toBe(422);
      expect(r.body).toMatch(/E_NO_PERIOD|E_DATE_OUT_OF_PERIOD/);
    });

    it('un período cerrado no admite asientos nuevos', async () => {
      // Se cierra marzo, que está vacío: cerrar enero rompería el resto del
      // archivo, y el candado es el mismo.
      const periodos = (
        await app.inject({ method: 'GET', url: '/periods', headers: cab(empresaA) })
      ).json<{ periods: { id: string; number: number }[] }>().periods;
      const marzo = periodos.find((p) => p.number === 3)!.id;

      const cierre = await app.inject({
        method: 'POST',
        url: `/periods/${marzo}/close`,
        headers: cab(empresaA),
      });
      expect(cierre.statusCode, cierre.body).toBe(200);

      const r = await postear(empresaA, venta('2026-03-10', '100.00'));
      expect(r.status).toBe(422);
      expect(r.body).toMatch(/E_PERIOD_CLOSED/);
    });

    it('el libro de un rango sin ejercicio se niega en vez de devolver vacío', async () => {
      const r = await app.inject({
        method: 'GET',
        url: '/books/diario?desde=2019-01-01&hasta=2019-12-31',
        headers: cab(empresaA),
      });
      expect(r.statusCode).toBe(400);
      expect(r.body).toMatch(/ejercicio/i);
    });
  });

  // -------------------------------------------------------------------------
  // 6 · Trazabilidad
  // -------------------------------------------------------------------------

  describe('6 · Trazabilidad', () => {
    it('del movimiento del Mayor al asiento y a su origen', async () => {
      const movimiento = await db.query<{ id: string }>(
        `SELECT m.id
           FROM ledger_movements m
           JOIN journal_entry_lines l ON l.id = m.entry_line_id
          WHERE l.entry_id = $1 LIMIT 1`,
        [asientos.a1],
      );

      const r = await app.inject({
        method: 'GET',
        url: `/books/trace/${movimiento.rows[0]!.id}`,
        headers: cab(empresaA),
      });
      expect(r.statusCode, r.body).toBe(200);
      const traza = r.json<{ entry_id: string; account_code: string; status: string }>();
      expect(traza.entry_id).toBe(asientos.a1);
      expect(traza.account_code).toBe('1.1.01');
      expect(traza.status).toBe('APROBADO');
    });

    it('el contraasiento conserva a quién anula, en el Diario y en la traza', async () => {
      const libro = await diario(empresaA);
      const contra = libro.folios
        .flatMap((f) => f.asientos)
        .find((a) => a.id === asientos.contra)!;
      expect(contra.tipo).toBe('REVERSION');
      expect(contra.anulaA).toBe(asientos.a4);

      const movimiento = await db.query<{ id: string }>(
        `SELECT m.id FROM ledger_movements m
           JOIN journal_entry_lines l ON l.id = m.entry_line_id
          WHERE l.entry_id = $1 LIMIT 1`,
        [asientos.contra],
      );
      const traza = (
        await app.inject({
          method: 'GET',
          url: `/books/trace/${movimiento.rows[0]!.id}`,
          headers: cab(empresaA),
        })
      ).json<{ reverses_entry_id: string; kind: string }>();
      expect(traza.kind).toBe('REVERSION');
      expect(traza.reverses_entry_id).toBe(asientos.a4);
    });

    it('un asiento fundado en una decisión la conserva hasta el Diario y la traza', async () => {
      // Desde `d350405` la decisión es una vía de trazabilidad por sí sola. Si
      // el Diario no la muestra, el recorrido BALANCE → MAYOR → ASIENTO →
      // DECISIÓN se corta justo en el último salto, y el asiento se ve sin
      // fundamento cuando lo tiene.
      const iva = await db.query<{ id: string }>("SELECT id FROM taxes WHERE code = 'IVA' LIMIT 1");
      const operacion = await db.query<{ id: string }>(
        `INSERT INTO tax_transactions
           (company_id, tax_id, period_id, direction, cbte_tipo, punto_venta, cbte_numero,
            cbte_fecha, condicion_iva, neto, iva, no_gravado, exento, percepciones, total, created_by)
         VALUES ($1,$2,$3,'VENTAS',11,1,940011,'2026-01-28','CONSUMIDOR_FINAL',
                 1000,0,0,0,0,1000,'circuito')
         RETURNING id`,
        [empresaA, iva.rows[0]!.id, periodoEnero],
      );
      const decision = await db.query<{ id: string }>(
        `INSERT INTO accounting_decisions
           (company_id, tax_transaction_id, origen, resultado, motivos, hechos, evidencia,
            ambiente, decidida_por, justificacion)
         VALUES ($1,$2,'MANUAL','PROPUESTA_DE_ASIENTO','[]'::jsonb,'[]'::jsonb,'[]'::jsonb,
                 'PRODUCTIVO','user:contadora','Decidido a mano con justificación suficiente')
         RETURNING id`,
        [empresaA, operacion.rows[0]!.id],
      );
      const decisionId = decision.rows[0]!.id;

      const r = await postear(empresaA, {
        journalCode: 'VENTAS',
        entryDate: '2026-01-28',
        description: 'Venta con decisión contable',
        currency: 'ARS',
        lines: [
          { accountCode: '1.1.01', debit: '1000.00', credit: '0' },
          { accountCode: '4.1.01', debit: '0', credit: '1000.00' },
        ],
        source: { type: 'INVOICE', id: operacion.rows[0]!.id },
        decisionId,
      });
      expect(r.status, r.body).toBe(201);
      expect(await aprobar(empresaA, r.id)).toBe(200);

      const libro = await diario(empresaA);
      const asiento = libro.folios.flatMap((f) => f.asientos).find((a) => a.id === r.id)!;
      expect(asiento.decisionId).toBe(decisionId);

      const movimiento = await db.query<{ id: string }>(
        `SELECT m.id FROM ledger_movements m
           JOIN journal_entry_lines l ON l.id = m.entry_line_id
          WHERE l.entry_id = $1 LIMIT 1`,
        [r.id],
      );
      const traza = (
        await app.inject({
          method: 'GET',
          url: `/books/trace/${movimiento.rows[0]!.id}`,
          headers: cab(empresaA),
        })
      ).json<{ decision_id: string | null }>();
      expect(traza.decision_id).toBe(decisionId);
    });

    it('un asiento sin comprobante fundado solo en una decisión tiene respaldo (art. 321)', async () => {
      // Un ajuste de cierre no nace de un papel de un tercero: su respaldo es la
      // decisión. El control del art. 321 miraba documento o justificación
      // manual, las dos vías viejas, y no la tercera.
      const decision = await db.query<{ id: string }>(
        `INSERT INTO accounting_decisions
           (company_id, origen, resultado, motivos, hechos, evidencia,
            ambiente, decidida_por, justificacion)
         VALUES ($1,'MANUAL','PROPUESTA_DE_ASIENTO','[]'::jsonb,'[]'::jsonb,'[]'::jsonb,
                 'PRODUCTIVO','user:contadora','Ajuste resuelto por la contadora, sin comprobante')
         RETURNING id`,
        [empresaA],
      );

      const r = await postear(empresaA, {
        journalCode: 'AJUSTES',
        entryDate: '2026-01-30',
        description: 'Ajuste sin comprobante',
        kind: 'AJUSTE',
        currency: 'ARS',
        lines: [
          { accountCode: '5.1.01', debit: '50.00', credit: '0' },
          { accountCode: '1.1.01', debit: '0', credit: '50.00' },
        ],
        source: { type: 'CLOSING', id: null },
        decisionId: decision.rows[0]!.id,
      });
      expect(r.status, r.body).toBe(201);
      expect(await aprobar(empresaA, r.id)).toBe(200);

      const libro = await diario(empresaA);
      const respaldo = libro.controles.find((c) => c.codigo === 'RESPALDO_DOCUMENTAL')!;
      expect(respaldo.incumplen).not.toContain(r.id);
      expect(respaldo.cumple).toBe(true);
    });
  });

  // -------------------------------------------------------------------------
  // 7 · Integridad del plan de cuentas
  // -------------------------------------------------------------------------

  describe('7 · Plan de cuentas', () => {
    it('una cuenta agrupadora no admite imputación', async () => {
      const r = await postear(
        empresaA,
        venta('2026-01-12', '10.00', {
          lines: [
            { accountCode: '1.1', debit: '10.00', credit: '0' },
            { accountCode: '4.1.01', debit: '0', credit: '10.00' },
          ],
        }),
      );
      expect(r.status).toBe(422);
      expect(r.body).toMatch(/E_ACCOUNT_NOT_POSTABLE/);
    });

    it('un mismo comprobante no genera dos asientos vigentes', async () => {
      const iva = await db.query<{ id: string }>("SELECT id FROM taxes WHERE code = 'IVA' LIMIT 1");
      const operacion = await db.query<{ id: string }>(
        `INSERT INTO tax_transactions
           (company_id, tax_id, period_id, direction, cbte_tipo, punto_venta, cbte_numero,
            cbte_fecha, condicion_iva, neto, iva, no_gravado, exento, percepciones, total, created_by)
         VALUES ($1,$2,$3,'VENTAS',11,1,940022,'2026-01-29','CONSUMIDOR_FINAL',
                 200,0,0,0,0,200,'circuito')
         RETURNING id`,
        [empresaA, iva.rows[0]!.id, periodoEnero],
      );
      const cuerpo = venta('2026-01-29', '200.00', {
        source: { type: 'INVOICE', id: operacion.rows[0]!.id },
      });

      const primero = await postear(empresaA, cuerpo);
      expect(primero.status, primero.body).toBe(201);

      const segundo = await postear(empresaA, cuerpo);
      expect(segundo.status).toBe(422);
      expect(segundo.body).toMatch(/E_DUPLICATE_SOURCE/);
    });
  });
});
