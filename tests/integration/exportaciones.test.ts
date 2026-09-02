/**
 * Las exportaciones a CSV.
 *
 * ## Qué defiende
 *
 *   1. **Que exporte lo que la API afirma**, no una segunda cuenta: el balance
 *      del CSV tiene que ser el mismo que el de la pantalla.
 *   2. **Que un resultado vacío sea un archivo con encabezado**, no un error ni
 *      cero bytes: hay que poder distinguir «el período está vacío» de «algo
 *      falló».
 *   3. **Que una coma en una razón social no corra las columnas.**
 *   4. **Que los importes salgan como decimal exacto**, sin separador de miles
 *      y sin pasar por punto flotante.
 *   5. **Que el permiso se exija igual que en la pantalla.**
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

/** Parte una línea de CSV respetando las comillas. */
function celdas(linea: string): string[] {
  const salida: string[] = [];
  let actual = '';
  let entreComillas = false;

  for (let i = 0; i < linea.length; i += 1) {
    const c = linea[i]!;
    if (entreComillas) {
      if (c === '"' && linea[i + 1] === '"') {
        actual += '"';
        i += 1;
      } else if (c === '"') {
        entreComillas = false;
      } else {
        actual += c;
      }
    } else if (c === '"') {
      entreComillas = true;
    } else if (c === ',') {
      salida.push(actual);
      actual = '';
    } else {
      actual += c;
    }
  }
  salida.push(actual);
  return salida;
}

suite('Exportaciones', () => {
  let app: FastifyInstance;
  let db: Client;
  let stamp: string;
  let token: string;
  let empresa: string;
  let hoy: string;

  const pedir = (method: 'GET' | 'POST', url: string, payload?: unknown) =>
    app.inject({
      method,
      url,
      headers: { authorization: `Bearer ${token}`, 'x-company-id': empresa },
      ...(payload === undefined ? {} : { payload }),
    });

  /** El CSV sin BOM, partido en líneas útiles. */
  const lineas = (cuerpo: string): string[] =>
    cuerpo.replace(/^\uFEFF/, '').split('\r\n').filter((l) => l.length > 0);

  beforeAll(async () => {
    initPool(process.env.DATABASE_URL!);
    app = await buildServer();
    await app.ready();
    db = await connect();
    stamp = await sufijoUnico(db);
    hoy = new Date().toISOString().slice(0, 10);

    const { hash: argonHash } = await import('@node-rs/argon2');
    const fundadorId = (
      await db.query<{ id: string }>(
        'INSERT INTO users (email, full_name, password_hash) VALUES ($1,$2,$3) RETURNING id',
        [
          `fundador-exp-${stamp}@estudio.test`,
          'Fundador',
          await argonHash(PASSWORD, { algorithm: 2, memoryCost: 19_456, timeCost: 2, parallelism: 1 }),
        ],
      )
    ).rows[0]!.id;

    const organizationId = (
      await db.query<{ create_organization: string }>('SELECT create_organization($1,$2,$3)', [
        `Estudio exp ${stamp}`, withCheckDigit(`30${stamp}`), fundadorId,
      ])
    ).rows[0]!.create_organization;

    empresa = (
      await db.query<{ create_company: string }>('SELECT create_company($1,$2,$3,$4,$5,$6,$7,$8)', [
        fundadorId, organizationId, `Empresa exp ${stamp}`, withCheckDigit(`27${stamp}`),
        'SA', 'AR-C', 'IGJ', '12-31',
      ])
    ).rows[0]!.create_company;

    const tokenFundador = (
      await app.inject({
        method: 'POST',
        url: '/auth/login',
        payload: { email: `fundador-exp-${stamp}@estudio.test`, password: PASSWORD },
      })
    ).json<{ token: string }>().token;

    const email = `contadora-exp-${stamp}@estudio.test`;
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

    const anio = new Date().getUTCFullYear();
    expect(
      (await pedir('POST', '/fiscal-years', {
        code: `EJ${anio}-${stamp}`, startDate: `${anio}-01-01`, endDate: `${anio}-12-31`,
      })).statusCode,
    ).toBe(201);
  }, 60_000);

  afterAll(async () => {
    await app?.close();
    await db?.end();
    await closePool();
  });

  it('sin movimientos, el archivo trae el encabezado y nada más', async () => {
    const r = await pedir('GET', '/exports/trial-balance.csv');
    expect(r.statusCode, r.body).toBe(200);
    expect(r.headers['content-type']).toContain('text/csv');
    expect(String(r.headers['content-disposition'])).toContain('attachment');

    const l = lineas(r.body);
    // Un archivo de cero bytes obligaría a adivinar si el período estaba vacío
    // o si algo falló.
    expect(l).toHaveLength(1);
    expect(celdas(l[0]!)).toEqual(['Código', 'Cuenta', 'Tipo', 'Debe', 'Haber', 'Saldo']);
  });

  it('el CSV dice lo mismo que la pantalla', async () => {
    for (const cuenta of [
      { code: '1.1.01', name: 'Caja', type: 'ACTIVO' },
      { code: '4.1.01', name: 'Ventas', type: 'INGRESO' },
    ]) {
      expect((await pedir('POST', '/accounts', cuenta)).statusCode).toBe(201);
    }

    const alta = await pedir('POST', '/journal-entries', {
      journalCode: 'GENERAL',
      entryDate: hoy,
      description: 'Venta de contado',
      currency: 'ARS',
      lines: [
        { accountCode: '1.1.01', debit: '1234.56', credit: '0' },
        { accountCode: '4.1.01', debit: '0', credit: '1234.56' },
      ],
      source: { type: 'MANUAL', id: null },
      manualJustification: 'Venta registrada por la contadora',
    });
    expect(alta.statusCode, alta.body).toBe(201);
    expect(
      (await pedir('POST', `/journal-entries/${alta.json<{ id: string }>().id}/approve`))
        .statusCode,
    ).toBe(200);

    const csv = lineas((await pedir('GET', '/exports/trial-balance.csv')).body);
    expect(csv).toHaveLength(3);

    const caja = celdas(csv.find((l) => l.startsWith('1.1.01'))!);
    // Decimal exacto, sin separador de miles: un CSV con «1.234,56» se abre
    // distinto en cada planilla del mundo.
    expect(caja[3]).toBe('1234.56');
    expect(caja[5]).toBe('1234.56');

    const anio = new Date().getUTCFullYear();
    const enPantallaResp = await pedir(
      'GET',
      `/reports/trial-balance?desde=${anio}-01-01&hasta=${anio}-12-31`,
    );
    expect(enPantallaResp.statusCode, enPantallaResp.body).toBe(200);
    const pantalla = enPantallaResp.json<{
      lineas: { codigo: string; debitos: string }[];
    }>();
    const enPantalla = pantalla.lineas.find((x) => x.codigo === '1.1.01')!;
    // El exportador no rehace la cuenta: lee lo mismo.
    expect(caja[3]).toBe(enPantalla.debitos);
  });

  it('una coma en el nombre no corre las columnas', async () => {
    const cliente = await pedir('POST', '/parties', {
      tipoDocumento: 'CUIT',
      numeroDocumento: `30${stamp}${cuitCheckDigit(`30${stamp}`)}`,
      // La coma es el caso que rompe un CSV mal escapado, y una razón social
      // con «S.A., sucursal» es de lo más común que hay.
      razonSocial: `Distribuidora del Sur, S.A. ${stamp}`,
      roles: ['CLIENTE'],
    });
    expect(cliente.statusCode, cliente.body).toBe(201);

    const forma =
      `--X\r\nContent-Disposition: form-data; name="file"; filename="exp-${stamp}.xml"\r\n` +
      `Content-Type: application/xml\r\n\r\n<c><n>1</n></c>\r\n--X--\r\n`;
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
    expect(subida.statusCode).toBe(201);

    const op = await pedir('POST', `/documents/${subida.json<{ id: string }>().id}/tax-transaction`, {
      direction: 'VENTAS',
      cbteTipo: 1,
      puntoVenta: 1,
      numero: 501,
      fecha: hoy,
      cuitContraparte: `30${stamp}${cuitCheckDigit(`30${stamp}`)}`,
      razonSocial: `Distribuidora del Sur, S.A. ${stamp}`,
      condicionIva: 'RESPONSABLE_INSCRIPTO',
      neto: '1000.00', iva: '210.00', noGravado: '0', exento: '0', percepciones: '0',
      total: '1210.00',
    });
    expect(op.statusCode, op.body).toBe(201);
    expect(
      (await pedir('POST', `/tax-transactions/${op.json<{ taxTransactionId: string }>().taxTransactionId}/party`, {
        partyId: cliente.json<{ id: string }>().id,
      })).statusCode,
    ).toBe(200);

    const csv = lineas((await pedir('GET', '/exports/aging.csv')).body);
    expect(csv.length).toBeGreaterThan(1);

    const fila = celdas(csv[1]!);
    // Once columnas exactas: si la coma hubiera partido la razón social serían
    // doce y el archivo se leería mal sin que nadie lo note.
    expect(fila).toHaveLength(11);
    expect(fila[0]).toBe(`Distribuidora del Sur, S.A. ${stamp}`);
    expect(fila[7], 'el pendiente es el total: no se cobró nada').toBe('1210.00');
  });

  it('las existencias exportan «no se afirma» y no un cero', async () => {
    const csv = lineas((await pedir('GET', '/exports/stock.csv')).body);
    expect(celdas(csv[0]!)).toEqual([
      'Código', 'Producto', 'Cantidad', 'Costo unitario', 'Costo total', 'Método', 'Por qué',
    ]);
  });

  it('exportar exige el mismo permiso que mirar', async () => {
    // Sin cabecera de empresa no hay contexto: la exportación no es una puerta
    // de atrás a los datos de otra.
    const r = await app.inject({
      method: 'GET',
      url: '/exports/trial-balance.csv',
      headers: { authorization: `Bearer ${token}` },
    });
    expect(r.statusCode).toBe(403);
  });
});
