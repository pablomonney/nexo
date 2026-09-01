/**
 * El maestro de terceros, recorrido entero por HTTP.
 *
 * Hasta la migración 0047 `journal_entry_lines.party_id` era un `uuid` que no
 * referenciaba nada y que `POST /journal-entries` aceptaba del cuerpo del
 * pedido sin mirarlo. El trigger `assert_line_account_valid` lo **exigía**
 * cuando la cuenta pide tercero — o sea que el sistema obligaba a completar un
 * dato que después no podía resolver a un nombre.
 *
 * Este archivo prueba las dos mitades que hacen que eso quede cerrado:
 *
 *   1. que el maestro funcione (alta, roles, búsqueda, cuenta corriente);
 *   2. que **no** se pueda imputar ni vincular a un tercero que no corresponda
 *      —de otra empresa, inexistente, o con un CUIT distinto del que declara el
 *      comprobante—.
 *
 * La segunda mitad es la que importa. Un test que solo comprobara la primera
 * pasaría igual con el aislamiento roto.
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

suite('Maestro de terceros', () => {
  let app: FastifyInstance;
  let db: Client;
  let stamp: string;
  let token: string;
  let empresaA: string;
  let empresaB: string;
  let fundadorId: string;
  let organizationId: string;

  /** CUIT de proveedor, válido de verdad: se construye con el módulo 11 real. */
  const cuitDe = (prefijo: string, cuerpo: string): string =>
    `${prefijo}${cuerpo}${cuitCheckDigit(`${prefijo}${cuerpo}`)}`;

  let cuitAcme: string;
  let cuitOtro: string;

  const pedir = (
    method: 'GET' | 'POST' | 'PATCH',
    url: string,
    empresa: string,
    payload?: unknown,
  ) =>
    app.inject({
      method,
      url,
      headers: { authorization: `Bearer ${token}`, 'x-company-id': empresa },
      ...(payload === undefined ? {} : { payload }),
    });

  beforeAll(async () => {
    initPool(process.env.DATABASE_URL!);
    app = await buildServer();
    await app.ready();
    db = await connect();
    stamp = await sufijoUnico(db);

    cuitAcme = cuitDe('30', stamp);
    cuitOtro = cuitDe('33', stamp);

    const { hash: argonHash } = await import('@node-rs/argon2');
    fundadorId = (
      await db.query<{ id: string }>(
        'INSERT INTO users (email, full_name, password_hash) VALUES ($1,$2,$3) RETURNING id',
        [
          `fundador-terceros-${stamp}@estudio.test`,
          'Fundador',
          await argonHash(PASSWORD, { algorithm: 2, memoryCost: 19_456, timeCost: 2, parallelism: 1 }),
        ],
      )
    ).rows[0]!.id;

    organizationId = (
      await db.query<{ create_organization: string }>('SELECT create_organization($1,$2,$3)', [
        `Estudio terceros ${stamp}`,
        withCheckDigit(`30${stamp}`),
        fundadorId,
      ])
    ).rows[0]!.create_organization;

    const crearEmpresa = async (nombre: string, prefijo: string): Promise<string> =>
      (
        await db.query<{ create_company: string }>('SELECT create_company($1,$2,$3,$4,$5,$6,$7,$8)', [
          fundadorId,
          organizationId,
          nombre,
          withCheckDigit(`${prefijo}${stamp}`),
          'SA',
          'AR-C',
          'IGJ',
          '12-31',
        ])
      ).rows[0]!.create_company;

    empresaA = await crearEmpresa(`Empresa A ter ${stamp}`, '33');
    empresaB = await crearEmpresa(`Empresa B ter ${stamp}`, '27');

    // Una sola persona con rol en las dos empresas. Es el caso más exigente para
    // el aislamiento: el token es el mismo y lo único que cambia es la cabecera.
    // Si RLS fallara, fallaría acá.
    const tokenFundador = (
      await app.inject({
        method: 'POST',
        url: '/auth/login',
        payload: { email: `fundador-terceros-${stamp}@estudio.test`, password: PASSWORD },
      })
    ).json<{ token: string }>().token;

    const email = `contadora-${stamp}@estudio.test`;
    const alta = await app.inject({
      method: 'POST',
      url: `/organizations/${organizationId}/users`,
      headers: { authorization: `Bearer ${tokenFundador}` },
      payload: { email, fullName: 'Contadora', password: PASSWORD, level: 'MEMBER' },
    });
    expect(alta.statusCode, alta.body).toBe(200);
    const userId = alta.json<{ id: string }>().id;

    for (const empresa of [empresaA, empresaB]) {
      for (const role of ['CONTADOR', 'ADMINISTRADOR']) {
        const r = await app.inject({
          method: 'POST',
          url: `/companies/${empresa}/roles`,
          headers: { authorization: `Bearer ${tokenFundador}` },
          payload: { userId, role },
        });
        expect(r.statusCode, r.body).toBe(200);
      }
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

    // Ejercicio abierto y plan mínimo en cada empresa, por las rutas reales.
    for (const empresa of [empresaA, empresaB]) {
      const ej = await pedir('POST', '/fiscal-years', empresa, {
        code: `EJ2026-${stamp}`,
        startDate: '2026-01-01',
        endDate: '2026-12-31',
      });
      expect(ej.statusCode, ej.body).toBe(201);

      for (const cuenta of [
        { code: '1.1.01', name: 'Caja', type: 'ACTIVO' },
        { code: '4.1.01', name: 'Ventas', type: 'INGRESO' },
        // La cuenta que exige tercero: es la que hace que el candado de la 0005
        // se ejercite de verdad en vez de quedar dormido.
        { code: '2.1.01', name: 'Proveedores', type: 'PASIVO', requiresThirdParty: true },
      ]) {
        const r = await pedir('POST', '/accounts', empresa, cuenta);
        expect(r.statusCode, r.body).toBe(201);
      }
    }
  });

  afterAll(async () => {
    await app?.close();
    await db?.end();
    await closePool();
  });

  // -------------------------------------------------------------------------
  // Alta
  // -------------------------------------------------------------------------
  let acmeId: string;

  it('da de alta un tercero con sus roles y lo devuelve en el listado', async () => {
    const alta = await pedir('POST', '/parties', empresaA, {
      tipoDocumento: 'CUIT',
      numeroDocumento: cuitAcme,
      razonSocial: `ACME ${stamp}`,
      condicionIva: 'RESPONSABLE_INSCRIPTO',
      roles: ['PROVEEDOR', 'CLIENTE'],
      email: 'compras@acme.test',
    });
    expect(alta.statusCode, alta.body).toBe(201);
    acmeId = alta.json<{ id: string }>().id;

    const lista = await pedir('GET', '/parties', empresaA);
    expect(lista.statusCode, lista.body).toBe(200);
    const terceros = lista.json<{ terceros: { id: string; roles: string[] }[] }>().terceros;
    const acme = terceros.find((t) => t.id === acmeId);
    expect(acme, 'el tercero recién creado tiene que aparecer').toBeDefined();
    // Un mismo CUIT puede comprar y vender. Los dos roles conviven.
    expect(acme!.roles.sort()).toEqual(['CLIENTE', 'PROVEEDOR']);
  });

  it('rechaza un CUIT cuyo dígito verificador no cierra', async () => {
    const malo = cuitAcme.slice(0, 10) + ((Number(cuitAcme[10]) + 1) % 10);
    const r = await pedir('POST', '/parties', empresaA, {
      tipoDocumento: 'CUIT',
      numeroDocumento: malo,
      razonSocial: 'Mal tipeado',
      roles: ['PROVEEDOR'],
    });
    expect(r.statusCode, r.body).toBe(400);
  });

  it('no admite dos veces el mismo documento en la misma empresa', async () => {
    const r = await pedir('POST', '/parties', empresaA, {
      tipoDocumento: 'CUIT',
      numeroDocumento: cuitAcme,
      razonSocial: 'ACME duplicada',
      roles: ['PROVEEDOR'],
    });
    expect(r.statusCode, r.body).toBe(409);
    expect(r.json<{ error: string }>().error).toBe('TERCERO_DUPLICADO');
  });

  it('el mismo documento SÍ puede existir en otra empresa', async () => {
    // No es una excepción al aislamiento: son dos maestros independientes. Que
    // dos empresas le compren al mismo proveedor no las vincula.
    const r = await pedir('POST', '/parties', empresaB, {
      tipoDocumento: 'CUIT',
      numeroDocumento: cuitAcme,
      razonSocial: `ACME ${stamp} vista por B`,
      roles: ['PROVEEDOR'],
    });
    expect(r.statusCode, r.body).toBe(201);
  });

  it('un tercero SIN_IDENTIFICAR no lleva número, y con número no entra', async () => {
    const conNumero = await pedir('POST', '/parties', empresaA, {
      tipoDocumento: 'SIN_IDENTIFICAR',
      numeroDocumento: '12345678',
      razonSocial: 'Incoherente',
      roles: ['CLIENTE'],
    });
    expect(conNumero.statusCode, conNumero.body).toBe(400);

    const sinNumero = await pedir('POST', '/parties', empresaA, {
      tipoDocumento: 'SIN_IDENTIFICAR',
      razonSocial: 'Consumidor final del mostrador',
      roles: ['CLIENTE'],
    });
    expect(sinNumero.statusCode, sinNumero.body).toBe(201);
  });

  // -------------------------------------------------------------------------
  // Aislamiento
  // -------------------------------------------------------------------------
  it('la empresa B no ve la ficha de un tercero de la empresa A', async () => {
    const r = await pedir('GET', `/parties/${acmeId}`, empresaB);
    expect(r.statusCode, r.body).toBe(404);
  });

  it('la empresa B no lista el tercero de la empresa A', async () => {
    const lista = await pedir('GET', '/parties', empresaB);
    expect(lista.statusCode).toBe(200);
    const ids = lista.json<{ terceros: { id: string }[] }>().terceros.map((t) => t.id);
    expect(ids).not.toContain(acmeId);
  });

  it('no se puede imputar un asiento a un tercero de otra empresa', async () => {
    // El candado no es RLS: es la clave foránea compuesta `(company_id,
    // party_id)`. RLS no alcanzaría, porque las restricciones foráneas se
    // verifican con privilegios del sistema y verían la fila igual.
    const r = await pedir('POST', '/journal-entries', empresaB, {
      journalCode: 'GENERAL',
      entryDate: '2026-03-10',
      description: 'Imputación cruzada',
      currency: 'ARS',
      lines: [
        { accountCode: '2.1.01', debit: '100.00', credit: '0', partyId: acmeId },
        { accountCode: '1.1.01', debit: '0', credit: '100.00' },
      ],
      source: { type: 'MANUAL', id: null },
      manualJustification: 'No debería entrar',
    });
    expect(r.statusCode, r.body).not.toBe(201);
  });

  it('no se puede imputar un asiento a un tercero inexistente', async () => {
    const r = await pedir('POST', '/journal-entries', empresaA, {
      journalCode: 'GENERAL',
      entryDate: '2026-03-10',
      description: 'Tercero inventado',
      currency: 'ARS',
      lines: [
        {
          accountCode: '2.1.01',
          debit: '100.00',
          credit: '0',
          partyId: '00000000-0000-4000-8000-000000000000',
        },
        { accountCode: '1.1.01', debit: '0', credit: '100.00' },
      ],
      source: { type: 'MANUAL', id: null },
      manualJustification: 'No debería entrar',
    });
    expect(r.statusCode, r.body).not.toBe(201);
  });

  // -------------------------------------------------------------------------
  // Cuenta corriente
  // -------------------------------------------------------------------------
  it('la cuenta corriente suma los asientos aprobados y solo esos', async () => {
    const asiento = async (importe: string, aprobar: boolean): Promise<void> => {
      const alta = await pedir('POST', '/journal-entries', empresaA, {
        journalCode: 'GENERAL',
        entryDate: '2026-03-12',
        description: `Compra a ACME por ${importe}`,
        currency: 'ARS',
        lines: [
          { accountCode: '1.1.01', debit: importe, credit: '0' },
          { accountCode: '2.1.01', debit: '0', credit: importe, partyId: acmeId },
        ],
        source: { type: 'MANUAL', id: null },
        manualJustification: 'Compra registrada por la contadora',
      });
      expect(alta.statusCode, alta.body).toBe(201);
      if (aprobar) {
        const id = alta.json<{ id: string }>().id;
        const ok = await pedir('POST', `/journal-entries/${id}/approve`, empresaA);
        expect(ok.statusCode, ok.body).toBe(200);
      }
    };

    await asiento('1000.00', true);
    await asiento('500.00', true);
    // Este queda en BORRADOR: un asiento sin aprobar no le debe plata a nadie.
    await asiento('9999.00', false);

    const r = await pedir('GET', `/parties/${acmeId}/cuenta-corriente`, empresaA);
    expect(r.statusCode, r.body).toBe(200);
    const cc = r.json<{
      tercero: { debe: string; haber: string; saldo: string; movimientos: number };
      movimientos: { debe: string; haber: string }[];
    }>();

    expect(cc.tercero.haber).toBe('1500.00');
    expect(cc.tercero.debe).toBe('0.00');
    // Saldo acreedor: se le debe a ACME. El signo lo da la resta, no una regla.
    expect(cc.tercero.saldo).toBe('-1500.00');
    expect(cc.tercero.movimientos).toBe(2);
    expect(cc.movimientos).toHaveLength(2);
  });

  it('el saldo sale del Mayor: no hay ninguna columna que lo guarde', async () => {
    const columnas = await db.query<{ column_name: string }>(
      `SELECT column_name FROM information_schema.columns
        WHERE table_name = 'parties' AND column_name IN ('saldo', 'balance', 'debe', 'haber')`,
    );
    expect(
      columnas.rows,
      'un saldo almacenado sería una segunda verdad que algún día no coincide',
    ).toEqual([]);
  });

  // -------------------------------------------------------------------------
  // Vinculación con el comprobante
  // -------------------------------------------------------------------------
  async function comprobanteDe(cuit: string, numero: number): Promise<string> {
    const forma =
      `--X\r\nContent-Disposition: form-data; name="file"; filename="ter-${stamp}-${numero}.xml"\r\n` +
      `Content-Type: application/xml\r\n\r\n<comprobante><n>${numero}</n></comprobante>\r\n--X--\r\n`;

    const subida = await app.inject({
      method: 'POST',
      url: '/documents',
      headers: {
        authorization: `Bearer ${token}`,
        'x-company-id': empresaA,
        'content-type': 'multipart/form-data; boundary=X',
      },
      payload: forma,
    });
    expect(subida.statusCode, subida.body).toBe(201);
    const documentId = subida.json<{ id: string }>().id;

    const operacion = await pedir(
      'POST',
      `/documents/${documentId}/tax-transaction`,
      empresaA,
      {
        direction: 'COMPRAS',
        cbteTipo: 1,
        puntoVenta: 1,
        numero,
        fecha: '2026-03-15',
        cuitContraparte: cuit,
        razonSocial: 'Lo que dice el papel',
        condicionIva: 'RESPONSABLE_INSCRIPTO',
        neto: '1000.00',
        iva: '210.00',
        noGravado: '0',
        exento: '0',
        percepciones: '0',
        total: '1210.00',
      },
    );
    expect(operacion.statusCode, operacion.body).toBe(201);
    return operacion.json<{ taxTransactionId: string }>().taxTransactionId;
  }

  it('vincula el comprobante al tercero cuyo CUIT declara', async () => {
    const ttId = await comprobanteDe(cuitAcme, 9001);
    const r = await pedir('POST', `/tax-transactions/${ttId}/party`, empresaA, {
      partyId: acmeId,
    });
    expect(r.statusCode, r.body).toBe(200);

    // Y el comprobante sigue diciendo lo que decía: vincular no corrige.
    const fila = await db.query<{ razon_social: string; cuit_contraparte: string }>(
      'SELECT razon_social, cuit_contraparte FROM tax_transactions WHERE id = $1',
      [ttId],
    );
    expect(fila.rows[0]!.razon_social).toBe('Lo que dice el papel');
    expect(fila.rows[0]!.cuit_contraparte).toBe(cuitAcme);
  });

  it('rechaza vincular a un tercero con otro CUIT', async () => {
    // El error que este candado evita es invisible: el subdiario sigue saliendo
    // bien y la cuenta corriente del proveedor equivocado empieza a crecer.
    const otro = await pedir('POST', '/parties', empresaA, {
      tipoDocumento: 'CUIT',
      numeroDocumento: cuitOtro,
      razonSocial: `Otro proveedor ${stamp}`,
      roles: ['PROVEEDOR'],
    });
    expect(otro.statusCode, otro.body).toBe(201);
    const otroId = otro.json<{ id: string }>().id;

    const ttId = await comprobanteDe(cuitAcme, 9002);
    const r = await pedir('POST', `/tax-transactions/${ttId}/party`, empresaA, {
      partyId: otroId,
    });
    expect(r.statusCode, r.body).toBe(422);
    expect(r.json<{ error: string }>().error).toBe('TERCERO_NO_COINCIDE');
  });

  it('rechaza vincular a un tercero de otra empresa', async () => {
    const ttId = await comprobanteDe(cuitAcme, 9003);
    const ajeno = await pedir('GET', '/parties', empresaB);
    const idAjeno = ajeno.json<{ terceros: { id: string }[] }>().terceros[0]!.id;

    const r = await pedir('POST', `/tax-transactions/${ttId}/party`, empresaA, {
      partyId: idAjeno,
    });
    expect(r.statusCode, r.body).toBe(404);
  });

  it('desvincular es legítimo y queda registrado', async () => {
    const ttId = await comprobanteDe(cuitAcme, 9004);
    expect(
      (await pedir('POST', `/tax-transactions/${ttId}/party`, empresaA, { partyId: acmeId }))
        .statusCode,
    ).toBe(200);
    const r = await pedir('POST', `/tax-transactions/${ttId}/party`, empresaA, { partyId: null });
    expect(r.statusCode, r.body).toBe(200);

    const bitacora = await db.query<{ cantidad: string }>(
      `SELECT count(*)::text AS cantidad FROM audit_logs
        WHERE object_id = $1 AND action = 'VINCULAR_TERCERO'`,
      [ttId],
    );
    expect(Number(bitacora.rows[0]!.cantidad)).toBe(2);
  });

  // -------------------------------------------------------------------------
  // Bitácora y edición
  // -------------------------------------------------------------------------
  it('el alta de un tercero deja constancia en la bitácora', async () => {
    const r = await db.query<{ action: string; actor_id: string }>(
      `SELECT action, actor_id FROM audit_logs
        WHERE object_type = 'parties' AND object_id = $1 AND action = 'CREAR_TERCERO'`,
      [acmeId],
    );
    expect(r.rowCount, 'un alta sin constancia es una escritura sin auditoría').toBe(1);
    expect(r.rows[0]!.actor_id.startsWith('user:')).toBe(true);
  });

  it('archivar exige motivo y no borra nada', async () => {
    const sinMotivo = await pedir('PATCH', `/parties/${acmeId}`, empresaA, {
      status: 'ARCHIVADO',
    });
    expect(sinMotivo.statusCode, sinMotivo.body).toBe(400);

    const conMotivo = await pedir('PATCH', `/parties/${acmeId}`, empresaA, {
      status: 'ARCHIVADO',
      motivo: 'Dejó de operar con la empresa',
    });
    expect(conMotivo.statusCode, conMotivo.body).toBe(200);

    // Archivado no es borrado: los movimientos siguen en la cuenta corriente.
    const cc = await pedir('GET', `/parties/${acmeId}/cuenta-corriente`, empresaA);
    expect(cc.statusCode).toBe(200);
    expect(cc.json<{ tercero: { movimientos: number } }>().tercero.movimientos).toBe(2);
  });

  it('el borrado físico de un tercero está prohibido', async () => {
    await expect(db.query('DELETE FROM parties WHERE id = $1', [acmeId])).rejects.toThrow();
  });

  // -------------------------------------------------------------------------
  // Paginación
  // -------------------------------------------------------------------------
  it('la paginación por cursor no repite ni saltea', async () => {
    const primera = await pedir('GET', '/parties?limite=2', empresaA);
    expect(primera.statusCode).toBe(200);
    const p1 = primera.json<{ terceros: { id: string }[]; cursor: string | null }>();
    expect(p1.terceros).toHaveLength(2);
    expect(p1.cursor, 'hay más de dos terceros: tiene que haber cursor').not.toBeNull();

    const segunda = await pedir(
      'GET',
      `/parties?limite=2&cursor=${encodeURIComponent(p1.cursor!)}`,
      empresaA,
    );
    const p2 = segunda.json<{ terceros: { id: string }[] }>();
    const repetidos = p2.terceros.filter((t) => p1.terceros.some((o) => o.id === t.id));
    expect(repetidos, 'una página no puede repetir filas de la anterior').toEqual([]);
  });

  it('un cursor manipulado da 400 y no un error de la base', async () => {
    const r = await pedir('GET', '/parties?cursor=no-es-un-cursor', empresaA);
    expect(r.statusCode, r.body).toBe(400);
  });
});
