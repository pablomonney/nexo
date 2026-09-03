/**
 * El Diario resumido del art. 327, y lo que hace falta para que exista.
 *
 * ## Qué encontró el barrido S-16
 *
 * `resumirPorMes` y `resumenCoincideConDetalle` estaban escritos, probados y
 * documentados en `@aai/accounting-engine`, y **no los llamaba nadie**. El
 * barrido no los marcó al principio por un agujero suyo: contaba como uso una
 * mención en un comentario de otro paquete. Un control que se conforma con un
 * comentario no controla nada.
 *
 * Al mismo tiempo, `vat_books.compras_sha256` y `ventas_sha256` existían desde
 * la migración 0021 con el motivo escrito —«es lo que hace verificable la
 * referencia que el art. 327 del CCyC exige para un asiento resumido»— y ningún
 * INSERT las escribía. Es el mismo defecto que tuvo `bank_reconciliations`.
 *
 * ## Qué defiende este archivo
 *
 *   1. **Sin subdiario emitido no hay resumen.** No es una advertencia: el
 *      resumen no sale.
 *   2. **El resumen sale del subdiario, y se verifica que sea el mismo.** El
 *      hash de hoy contra el que se archivó al generar el libro.
 *   3. **Si el detalle cambió después, el resumen deja de valer.** Es el caso
 *      que la verificación existe para detectar.
 *   4. **El resumen suma lo mismo que el detalle**, y eso viaja en la respuesta.
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

interface Resumido {
  periodo: string;
  resumible: boolean;
  resumidos: {
    journalCode: string;
    totalDebe: string;
    totalHaber: string;
    operaciones: number;
    subdiario: { nombre: string; referencia: string };
    lineas: {
      codigo: string;
      debe: string;
      haber: string;
      operaciones: number;
    }[];
    verificacion: { coincide: boolean; detalle: string };
  }[];
  rechazos: {
    motivo: string;
    journalCode: string;
    detalle: string;
    fundamento: string;
  }[];
  detallados: { asientos: number; libros: string[] };
}

suite('Diario resumido (CCyC art. 327)', () => {
  let app: FastifyInstance;
  let db: Client;
  let token: string;
  let empresa: string;
  let anio: number;
  let mes: number;
  let fecha: string;
  let periodId: string;

  const pedir = (method: 'GET' | 'POST', url: string, payload?: unknown) =>
    app.inject({
      method,
      url,
      headers: { authorization: `Bearer ${token}`, 'x-company-id': empresa },
      ...(payload === undefined ? {} : { payload }),
    });

  /**
   * Una operación de IVA Compras del mes, cargada por SQL.
   *
   * El total se pasa escrito y no se calcula acá: sumar plata en JavaScript es
   * lo que el gate `check:no-float` prohíbe en el código, y un test que lo hace
   * enseña a hacerlo.
   */
  const cargarComprobante = async (
    numero: number,
    neto: string,
    iva: string,
    total: string,
  ): Promise<void> => {
    await db.query(
      `INSERT INTO tax_transactions
         (company_id, tax_id, period_id, direction, cbte_tipo, punto_venta, cbte_numero,
          cbte_fecha, cuit_contraparte, razon_social, condicion_iva,
          neto, iva, no_gravado, exento, percepciones, total, created_by)
       SELECT $1, t.id, $2, 'COMPRAS', 1, 1, $3, $4::date, '30500010912', 'Proveedor SA',
              'RESPONSABLE_INSCRIPTO', $5, $6, '0', '0', '0', $7, 'tester'
         FROM taxes t WHERE t.code = 'IVA'`,
      [empresa, periodId, numero, fecha, neto, iva, total],
    );
  };

  beforeAll(async () => {
    initPool(process.env.DATABASE_URL!);
    app = await buildServer();
    await app.ready();
    db = await connect();
    const stamp = await sufijoUnico(db);

    // Del reloj de la base, no del de Node: el período abierto lo decide la base.
    const hoy = (
      await db.query<{ hoy: string; anio: number; mes: number }>(
        `SELECT current_date::text AS hoy,
                extract(year FROM current_date)::int AS anio,
                extract(month FROM current_date)::int AS mes`,
      )
    ).rows[0]!;
    fecha = hoy.hoy;
    anio = hoy.anio;
    mes = hoy.mes;

    const { hash: argonHash } = await import('@node-rs/argon2');
    const fundadorId = (
      await db.query<{ id: string }>(
        'INSERT INTO users (email, full_name, password_hash) VALUES ($1,$2,$3) RETURNING id',
        [
          `fundador-res-${stamp}@estudio.test`,
          'Fundador',
          await argonHash(PASSWORD, {
            algorithm: 2,
            memoryCost: 19_456,
            timeCost: 2,
            parallelism: 1,
          }),
        ],
      )
    ).rows[0]!.id;

    const organizationId = (
      await db.query<{ create_organization: string }>('SELECT create_organization($1,$2,$3)', [
        `Estudio res ${stamp}`,
        withCheckDigit(`30${stamp}`),
        fundadorId,
      ])
    ).rows[0]!.create_organization;

    empresa = (
      await db.query<{ create_company: string }>('SELECT create_company($1,$2,$3,$4,$5,$6,$7,$8)', [
        fundadorId,
        organizationId,
        `Empresa res ${stamp}`,
        withCheckDigit(`27${stamp}`),
        'SA',
        'AR-C',
        'IGJ',
        '12-31',
      ])
    ).rows[0]!.create_company;

    const tokenFundador = (
      await app.inject({
        method: 'POST',
        url: '/auth/login',
        payload: {
          email: `fundador-res-${stamp}@estudio.test`,
          password: PASSWORD,
        },
      })
    ).json<{ token: string }>().token;

    const email = `contadora-res-${stamp}@estudio.test`;
    const userId = (
      await app.inject({
        method: 'POST',
        url: `/organizations/${organizationId}/users`,
        headers: { authorization: `Bearer ${tokenFundador}` },
        payload: {
          email,
          fullName: 'Contadora',
          password: PASSWORD,
          level: 'MEMBER',
        },
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
      await app.inject({
        method: 'POST',
        url: '/auth/login',
        payload: { email, password: PASSWORD },
      })
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
      await app.inject({
        method: 'POST',
        url: '/auth/login',
        payload: { email, password: PASSWORD },
      })
    ).json<{ token: string }>().token;
    await app.inject({
      method: 'POST',
      url: '/auth/mfa/verify',
      payload: { code: totp(secret, Date.now()) },
      headers: { authorization: `Bearer ${token}` },
    });

    expect(
      (
        await pedir('POST', '/fiscal-years', {
          code: `EJ${anio}-${stamp}`,
          startDate: `${anio}-01-01`,
          endDate: `${anio}-12-31`,
        })
      ).statusCode,
    ).toBe(201);

    for (const cuenta of [
      { code: '1.1.05', name: 'Proveedores', type: 'PASIVO' },
      { code: '5.1.01', name: 'Mercaderías', type: 'GASTO' },
      { code: '1.1.06', name: 'IVA crédito fiscal', type: 'ACTIVO' },
    ]) {
      expect((await pedir('POST', '/accounts', cuenta)).statusCode, cuenta.code).toBe(201);
    }

    periodId = (
      await db.query<{ id: string }>(
        `SELECT id FROM periods WHERE company_id = $1 AND $2::date BETWEEN start_date AND end_date`,
        [empresa, fecha],
      )
    ).rows[0]!.id;

    // Dos asientos en el libro COMPRAS: son los que el resumen va a condensar.
    for (const importe of ['1000.00', '2000.00']) {
      const alta = await pedir('POST', '/journal-entries', {
        journalCode: 'COMPRAS',
        entryDate: fecha,
        description: `Compra por ${importe}`,
        currency: 'ARS',
        lines: [
          { accountCode: '5.1.01', debit: importe, credit: '0' },
          { accountCode: '1.1.05', debit: '0', credit: importe },
        ],
        source: { type: 'MANUAL', id: null },
        manualJustification: 'Compra registrada por la contadora',
      });
      expect(alta.statusCode, alta.body).toBe(201);
      expect(
        (await pedir('POST', `/journal-entries/${alta.json<{ id: string }>().id}/approve`))
          .statusCode,
      ).toBe(200);
    }
  }, 90_000);

  afterAll(async () => {
    await app?.close();
    await db?.end();
    await closePool();
  });

  it('sin Libro de IVA generado no hay resumen: el detalle no existe todavía', async () => {
    const r = await pedir('GET', `/books/diario-resumido?anio=${anio}&mes=${mes}`);
    expect(r.statusCode, r.body).toBe(200);

    const v = r.json<Resumido>();
    expect(v.resumible).toBe(false);
    expect(v.resumidos).toEqual([]);
    const rechazo = v.rechazos.find((x) => x.motivo === 'SUBDIARIO_NO_EMITIDO');
    expect(rechazo, JSON.stringify(v.rechazos)).toBeDefined();
    expect(rechazo!.journalCode).toBe('COMPRAS');
    // El fundamento viaja con el rechazo: la negativa cita el artículo.
    expect(rechazo!.fundamento).toContain('art. 327');
  });

  it('generado el libro, el resumen sale y cita el subdiario con su hash', async () => {
    await cargarComprobante(1, '1000.00', '210.00', '1210.00');
    await cargarComprobante(2, '2000.00', '420.00', '2420.00');

    const generado = await pedir('POST', `/vat/books/${anio}/${mes}/generate`);
    expect(generado.statusCode, generado.body).toBe(201);
    const subdiarios = generado.json<{ subdiarios: { compras: string } }>().subdiarios;
    expect(subdiarios.compras).toContain('sha256:');

    // El hash quedó archivado, que es lo que nadie escribía antes.
    const fila = await db.query<{ compras_sha256: string | null }>(
      'SELECT compras_sha256 FROM vat_books WHERE company_id = $1 AND anio = $2 AND mes = $3',
      [empresa, anio, mes],
    );
    expect(fila.rows[0]!.compras_sha256).toMatch(/^[0-9a-f]{64}$/u);
    expect(subdiarios.compras).toContain(fila.rows[0]!.compras_sha256!);

    const v = (
      await pedir('GET', `/books/diario-resumido?anio=${anio}&mes=${mes}`)
    ).json<Resumido>();

    expect(v.rechazos, JSON.stringify(v.rechazos)).toEqual([]);
    expect(v.resumible).toBe(true);
    expect(v.resumidos).toHaveLength(1);

    const resumen = v.resumidos[0]!;
    expect(resumen.journalCode).toBe('COMPRAS');
    // Un solo asiento resumido en lugar de los dos del mes.
    expect(resumen.operaciones).toBe(2);
    expect(resumen.totalDebe).toBe('3000.00');
    expect(resumen.totalHaber).toBe('3000.00');
    // La cita apunta al archivo, con su hash: es lo que el art. 327 pide poder
    // verificar.
    expect(resumen.subdiario.referencia).toContain(fila.rows[0]!.compras_sha256!);
    // Y el control del motor corrió y viaja en la respuesta.
    expect(resumen.verificacion.coincide, resumen.verificacion.detalle).toBe(true);
  });

  it('el archivo que la cita menciona se puede descargar, y su hash es el citado', async () => {
    const r = await pedir('GET', `/vat/subdiarios/COMPRAS/${anio}/${mes}.csv`);
    expect(r.statusCode, r.body).toBe(200);
    expect(r.headers['content-type']).toContain('text/csv');

    const fila = await db.query<{ compras_sha256: string }>(
      'SELECT compras_sha256 FROM vat_books WHERE company_id = $1 AND anio = $2 AND mes = $3',
      [empresa, anio, mes],
    );
    expect(r.headers['x-content-sha256']).toBe(fila.rows[0]!.compras_sha256);
    // Y el archivo trae los dos comprobantes del período.
    expect(r.body.split('\n').filter((linea) => linea.trim() !== '')).toHaveLength(3);
  });

  it('si el detalle cambia después de emitido, el resumen deja de surgir de él', async () => {
    // Es el caso que la verificación existe para detectar: el subdiario que se
    // archivó y el que hay hoy ya no son el mismo.
    await cargarComprobante(3, '500.00', '105.00', '605.00');

    const v = (
      await pedir('GET', `/books/diario-resumido?anio=${anio}&mes=${mes}`)
    ).json<Resumido>();

    expect(v.resumible).toBe(false);
    expect(v.resumidos).toEqual([]);
    const rechazo = v.rechazos.find((x) => x.motivo === 'SUBDIARIO_CAMBIO_DESPUES_DE_EMITIDO');
    expect(rechazo, JSON.stringify(v.rechazos)).toBeDefined();
    expect(rechazo!.detalle).toContain('Algo cambió después');
    expect(rechazo!.fundamento).toContain('art. 327');
  });

  it('lo que no tiene subdiario va al Diario detallado, y se dice cuál es', async () => {
    const alta = await pedir('POST', '/journal-entries', {
      journalCode: 'GENERAL',
      entryDate: fecha,
      description: 'Ajuste manual',
      currency: 'ARS',
      lines: [
        { accountCode: '5.1.01', debit: '100.00', credit: '0' },
        { accountCode: '1.1.05', debit: '0', credit: '100.00' },
      ],
      source: { type: 'MANUAL', id: null },
      manualJustification: 'Ajuste cargado por la contadora',
    });
    expect(alta.statusCode, alta.body).toBe(201);
    expect(
      (await pedir('POST', `/journal-entries/${alta.json<{ id: string }>().id}/approve`))
        .statusCode,
    ).toBe(200);

    const v = (
      await pedir('GET', `/books/diario-resumido?anio=${anio}&mes=${mes}`)
    ).json<Resumido>();

    // GENERAL no se resume —no tiene registro auxiliar detrás— y eso no es un
    // rechazo: es el Diario normal.
    expect(v.detallados.libros).toEqual(['GENERAL']);
    expect(v.detallados.asientos).toBe(1);
    expect(v.rechazos.some((x) => x.journalCode === 'GENERAL')).toBe(false);
  });
});
