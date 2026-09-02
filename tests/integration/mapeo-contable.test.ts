/**
 * El mapeo contable declarado y el asiento que se propone con él.
 *
 * ## Qué defiende este archivo
 *
 * La auditoría integral encontró que el Mayor se escribía a mano: ningún hecho
 * de negocio producía asientos salvo el cierre de ejercicio. El motor de
 * propuesta existía y salía vacío porque nadie le había dicho a qué cuenta va
 * cada cosa.
 *
 *   1. **Que sin mapeo no se proponga nada**, y que se diga cuál rol falta.
 *   2. **Que la cuenta declarada sirva para el rol**: deudores es del activo,
 *      ventas es un ingreso. Una cuenta del tipo equivocado descuadra el
 *      balance en silencio.
 *   3. **Que la propuesta cuadre y llegue al Mayor** por el camino de siempre:
 *      se carga en borrador y la aprueba una persona.
 *   4. **Que no se proponga lo que el mapeo no cubre.** Un asiento cuadrado y
 *      equivocado es peor que ninguno: pasa todos los controles.
 */

import { closePool, initPool } from '@aai/db';
import { buildServer } from '@aai/api/server';
import { cuitCheckDigit, totp, withCheckDigit } from '@aai/shared';
import type { FastifyInstance } from 'fastify';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { connect, hasDatabase, type Client } from './helpers/db.js';
import { sufijoUnico } from './helpers/identificadores.js';

const suite = hasDatabase ? describe : describe.skip;
const PASSWORD = 'una-contrasena-suficientemente-larga';

interface Propuesta {
  readonly fecha: string;
  readonly descripcion: string;
  readonly renglones: { accountCode: string; debit: string; credit: string }[];
  readonly motivoSinRenglones: string | null;
  readonly rolesFaltantes: string[];
  readonly asientoExistente: string | null;
  readonly justificacionSugerida: string | null;
}

suite('Mapeo contable y propuesta de asiento', () => {
  let app: FastifyInstance;
  let db: Client;
  let stamp: string;
  let token: string;
  let empresa: string;
  let cuitCliente: string;
  let clienteId: string;
  let ventaSimple: string;
  let ventaConPercepcion: string;
  let numeroCbte = 11_000;

  const pedir = (method: 'GET' | 'POST' | 'PUT', url: string, payload?: unknown) =>
    app.inject({
      method,
      url,
      headers: { authorization: `Bearer ${token}`, 'x-company-id': empresa },
      ...(payload === undefined ? {} : { payload }),
    });

  const hoy = new Date().toISOString().slice(0, 10);

  const venta = async (
    neto: string,
    iva: string,
    total: string,
    percepciones = '0',
  ): Promise<string> => {
    numeroCbte += 1;
    const forma =
      `--X\r\nContent-Disposition: form-data; name="file"; filename="map-${stamp}-${numeroCbte}.xml"\r\n` +
      `Content-Type: application/xml\r\n\r\n<comprobante><n>${numeroCbte}</n></comprobante>\r\n--X--\r\n`;

    const subida = await app.inject({
      method: 'POST',
      url: '/documents',
      headers: {
        authorization: `Bearer ${token}`,
        'x-company-id': empresa,
        'content-type': 'multipart/form-data; boundary=X',
      },
      payload: forma,
    });
    expect(subida.statusCode, subida.body).toBe(201);

    const op = await pedir('POST', `/documents/${subida.json<{ id: string }>().id}/tax-transaction`, {
      direction: 'VENTAS',
      cbteTipo: 1,
      puntoVenta: 1,
      numero: numeroCbte,
      fecha: hoy,
      cuitContraparte: cuitCliente,
      razonSocial: 'Cliente',
      condicionIva: 'RESPONSABLE_INSCRIPTO',
      neto, iva, noGravado: '0', exento: '0', percepciones, total,
    });
    expect(op.statusCode, op.body).toBe(201);
    const id = op.json<{ taxTransactionId: string }>().taxTransactionId;

    expect(
      (await pedir('POST', `/tax-transactions/${id}/party`, { partyId: clienteId })).statusCode,
    ).toBe(200);
    return id;
  };

  const propuesta = async (id: string): Promise<Propuesta> =>
    (await pedir('GET', `/tax-transactions/${id}/asiento-propuesto`)).json<Propuesta>();

  beforeAll(async () => {
    initPool(process.env.DATABASE_URL!);
    app = await buildServer();
    await app.ready();
    db = await connect();
    stamp = await sufijoUnico(db);

    const { hash: argonHash } = await import('@node-rs/argon2');
    const fundadorId = (
      await db.query<{ id: string }>(
        'INSERT INTO users (email, full_name, password_hash) VALUES ($1,$2,$3) RETURNING id',
        [
          `fundador-map-${stamp}@estudio.test`,
          'Fundador',
          await argonHash(PASSWORD, { algorithm: 2, memoryCost: 19_456, timeCost: 2, parallelism: 1 }),
        ],
      )
    ).rows[0]!.id;

    const organizationId = (
      await db.query<{ create_organization: string }>('SELECT create_organization($1,$2,$3)', [
        `Estudio map ${stamp}`, withCheckDigit(`30${stamp}`), fundadorId,
      ])
    ).rows[0]!.create_organization;

    empresa = (
      await db.query<{ create_company: string }>('SELECT create_company($1,$2,$3,$4,$5,$6,$7,$8)', [
        fundadorId, organizationId, `Empresa map ${stamp}`, withCheckDigit(`27${stamp}`),
        'SA', 'AR-C', 'IGJ', '12-31',
      ])
    ).rows[0]!.create_company;

    const tokenFundador = (
      await app.inject({
        method: 'POST',
        url: '/auth/login',
        payload: { email: `fundador-map-${stamp}@estudio.test`, password: PASSWORD },
      })
    ).json<{ token: string }>().token;

    const email = `contadora-map-${stamp}@estudio.test`;
    const userId = (
      await app.inject({
        method: 'POST',
        url: `/organizations/${organizationId}/users`,
        headers: { authorization: `Bearer ${tokenFundador}` },
        payload: { email, fullName: 'Contadora', password: PASSWORD, level: 'MEMBER' },
      })
    ).json<{ id: string }>().id;

    for (const role of ['CONTADOR', 'ADMINISTRADOR']) {
      await app.inject({
        method: 'POST',
        url: `/companies/${empresa}/roles`,
        headers: { authorization: `Bearer ${tokenFundador}` },
        payload: { userId, role },
      });
    }

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

    cuitCliente = `30${stamp}${cuitCheckDigit(`30${stamp}`)}`;
    clienteId = (
      await pedir('POST', '/parties', {
        tipoDocumento: 'CUIT',
        numeroDocumento: cuitCliente,
        razonSocial: `Cliente map ${stamp}`,
        roles: ['CLIENTE'],
      })
    ).json<{ id: string }>().id;

    const anio = new Date().getUTCFullYear();
    expect(
      (await pedir('POST', '/fiscal-years', {
        code: `EJ${anio}-${stamp}`,
        startDate: `${anio}-01-01`,
        endDate: `${anio}-12-31`,
      })).statusCode,
    ).toBe(201);

    for (const cuenta of [
      { code: '1.1.02', name: 'Deudores por ventas', type: 'ACTIVO', requiresThirdParty: true },
      { code: '2.1.03', name: 'IVA débito fiscal', type: 'PASIVO' },
      { code: '4.1.01', name: 'Ventas', type: 'INGRESO' },
      { code: '5.1.01', name: 'Compras', type: 'GASTO' },
    ]) {
      expect((await pedir('POST', '/accounts', cuenta)).statusCode, cuenta.code).toBe(201);
    }
  }, 60_000);

  afterAll(async () => {
    await app?.close();
    await db?.end();
    await closePool();
  });

  it('sin mapeo no se propone nada, y se dice cuál rol falta', async () => {
    ventaSimple = await venta('100000.00', '21000.00', '121000.00');

    const p = await propuesta(ventaSimple);
    expect(p.renglones).toHaveLength(0);
    expect(p.motivoSinRenglones).toContain('Falta declarar');
    // Dice los tres nombres, no «faltan datos».
    expect(p.rolesFaltantes).toEqual(['CLIENTES', 'VENTAS', 'IVA_DEBITO']);
    expect(p.motivoSinRenglones).toContain('inventar la contabilidad');
  });

  it('con comprobantes y mapeo incompleto, la bandeja lo dice', async () => {
    const items = (await pedir('GET', '/work-queue?entidad=company_account_map&limite=50'))
      .json<{ items: { rama: string; bloquea: boolean; evidenciaFaltante: string[] | null }[] }>()
      .items;

    const aviso = items.find((i) => i.rama === 'MAPEO_CONTABLE_INCOMPLETO');
    expect(aviso).toBeDefined();
    // No bloquea: se puede seguir registrando a mano.
    expect(aviso!.bloquea).toBe(false);
    expect(aviso!.evidenciaFaltante).toContain('CLIENTES');
  });

  it('una cuenta del tipo equivocado no se acepta', async () => {
    // Ventas es una cuenta de ingreso: declarar el ingreso como deudores
    // produciría asientos cuadrados y falsos.
    const r = await pedir('PUT', '/accounting-map', {
      asignaciones: [{ rol: 'CLIENTES', cuenta: '4.1.01' }],
    });
    expect(r.statusCode).toBe(422);
    expect(r.json<{ error: string }>().error).toBe('CUENTA_DEL_TIPO_EQUIVOCADO');

    // Y el candado vive en la base, no en el handler.
    const cuenta = await db.query<{ id: string }>(
      'SELECT id FROM accounts WHERE company_id = $1 AND code = $2',
      [empresa, '4.1.01'],
    );
    await expect(
      db.query(
        `INSERT INTO company_account_map (company_id, rol, account_id, declarado_por)
         VALUES ($1,'CLIENTES',$2,'test')`,
        [empresa, cuenta.rows[0]!.id],
      ),
    ).rejects.toThrow(/E_MAPEO_TIPO/);
  });

  it('declarado el mapeo, la propuesta se arma y cuadra', async () => {
    const r = await pedir('PUT', '/accounting-map', {
      asignaciones: [
        { rol: 'CLIENTES', cuenta: '1.1.02' },
        { rol: 'IVA_DEBITO', cuenta: '2.1.03' },
        { rol: 'VENTAS', cuenta: '4.1.01' },
      ],
    });
    expect(r.statusCode, r.body).toBe(200);

    const p = await propuesta(ventaSimple);
    expect(p.motivoSinRenglones).toBeNull();
    expect(p.renglones).toHaveLength(3);

    const porCuenta = new Map(p.renglones.map((l) => [l.accountCode, l]));
    expect(porCuenta.get('1.1.02')!.debit, 'el total va a deudores').toBe('121000.00');
    expect(porCuenta.get('4.1.01')!.credit, 'el neto a ventas').toBe('100000.00');
    expect(porCuenta.get('2.1.03')!.credit, 'y el IVA a su cuenta').toBe('21000.00');

    // Cuadra. Se suma en centavos con enteros: los importes no pasan por float.
    const centavos = (s: string): bigint => BigInt(s.replace('.', ''));
    const debe = p.renglones.reduce((a, l) => a + centavos(l.debit), 0n);
    const haber = p.renglones.reduce((a, l) => a + centavos(l.credit), 0n);
    expect(debe).toBe(haber);
  });

  it('la propuesta llega al Mayor por el camino de siempre', async () => {
    const p = await propuesta(ventaSimple);

    // La carga es un `POST /journal-entries` como cualquier otro: la ruta de la
    // propuesta no escribe en el Diario.
    const alta = await pedir('POST', '/journal-entries', {
      journalCode: 'GENERAL',
      entryDate: p.fecha,
      description: p.descripcion,
      currency: 'ARS',
      lines: p.renglones,
      source: { type: 'INVOICE', id: ventaSimple },
      // §24: la propuesta sola no funda el asiento; lo funda que una persona la
      // haya revisado y la cargue, y eso es lo que dice la justificación.
      manualJustification: p.justificacionSugerida,
    });
    expect(alta.statusCode, alta.body).toBe(201);
    const entryId = alta.json<{ id: string }>().id;

    // Entra en borrador: todavía no toca el Mayor.
    const antes = await db.query<{ n: string }>(
      'SELECT count(*)::text AS n FROM ledger_movements WHERE company_id = $1',
      [empresa],
    );
    expect(antes.rows[0]!.n).toBe('0');

    expect((await pedir('POST', `/journal-entries/${entryId}/approve`)).statusCode).toBe(200);

    const mayor = await db.query<{ debe: string; haber: string }>(
      `SELECT coalesce(sum(debit), 0)::text AS debe, coalesce(sum(credit), 0)::text AS haber
         FROM ledger_movements WHERE company_id = $1`,
      [empresa],
    );
    expect(mayor.rows[0]!.debe).toBe('121000.00');
    expect(mayor.rows[0]!.haber).toBe('121000.00');

    // Y la propuesta ahora avisa que el comprobante ya tiene asiento: volver a
    // cargarla sería duplicarlo, y el duplicado pasa todos los controles.
    expect((await propuesta(ventaSimple)).asientoExistente).toBe(entryId);
  });

  it('no se propone lo que el mapeo no cubre', async () => {
    ventaConPercepcion = await venta('100000.00', '21000.00', '124000.00', '3000.00');

    const p = await propuesta(ventaConPercepcion);
    expect(p.renglones).toHaveLength(0);
    // Un asiento cuadrado y equivocado es peor que ninguno: pasa todos los
    // controles y dice una mentira.
    expect(p.motivoSinRenglones).toContain('percepciones');
    expect(p.motivoSinRenglones).toContain('cuadrado y equivocado');
  });

  it('la propuesta no se guarda en ningún lado', async () => {
    // Guardarla crearía una tercera verdad —el comprobante, el asiento y una
    // propuesta vieja— y es la única de las tres que no es un hecho.
    const tablas = (
      await db.query<{ table_name: string }>(
        `SELECT table_name FROM information_schema.tables
          WHERE table_schema = 'public' AND table_name LIKE '%propuesta%'`,
      )
    ).rows;
    expect(tablas).toHaveLength(0);

    const columnas = (
      await db.query<{ column_name: string }>(
        `SELECT column_name FROM information_schema.columns
          WHERE table_name = 'accounting_decisions'`,
      )
    ).rows.map((c) => c.column_name);
    expect(columnas).not.toContain('renglones');
    expect(columnas).not.toContain('propuesta');
  });

  it('declarar el mapeo no reescribe los asientos ya registrados', async () => {
    const antes = await db.query<{ n: string; debe: string }>(
      `SELECT count(*)::text AS n, coalesce(sum(debit), 0)::text AS debe
         FROM ledger_movements WHERE company_id = $1`,
      [empresa],
    );

    expect(
      (await pedir('PUT', '/accounting-map', {
        asignaciones: [{ rol: 'COMPRAS', cuenta: '5.1.01' }],
      })).statusCode,
    ).toBe(200);

    const despues = await db.query<{ n: string; debe: string }>(
      `SELECT count(*)::text AS n, coalesce(sum(debit), 0)::text AS debe
         FROM ledger_movements WHERE company_id = $1`,
      [empresa],
    );
    expect(despues.rows[0]).toEqual(antes.rows[0]);
  });
});
