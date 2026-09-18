/**
 * Una empresa nueva, de cero a estados contables.
 *
 * Los demás archivos prueban piezas. Éste prueba **el producto**: que un estudio
 * pueda dar de alta una empresa que no existía, dejarla lista para trabajar,
 * facturar, comprar, hacer una nota de crédito, y obtener información financiera
 * que cierre. Si este archivo pasa, NEXO sirve para un primer cliente; si no
 * pasa, no importa qué tan bien esté armado por dentro.
 *
 * ## El recorrido, en orden
 *
 *     empresa → plan de cuentas → mapeo → marco → ejercicio
 *     → tercero → producto
 *     → venta → propuesta → decisión → aprobación → Mayor
 *     → compra → idem
 *     → nota de crédito → idem
 *     → balance de sumas y saldos → estado de resultados → situación patrimonial
 *
 * Cada paso usa la ruta real. No hay ningún `INSERT` de atajo salvo los tres de
 * la creación del estudio y la empresa, que son funciones privilegiadas
 * (`create_organization`, `create_company`) y no tienen ruta HTTP porque la
 * autorización se comprueba adentro.
 *
 * ## Por qué los importes son los que son
 *
 * Están elegidos para que el resultado se pueda verificar de memoria:
 *
 *     venta            100.000 + 21.000 de IVA = 121.000
 *     nota de crédito   20.000 +  4.200 de IVA =  24.200
 *     compra            60.000 + 12.600 de IVA =  72.600
 *
 *     ventas netas     100.000 - 20.000 =  80.000
 *     compras                              60.000
 *     resultado                            20.000
 *
 * Un test cuyo número esperado sale de correr el sistema y copiar lo que dio no
 * prueba nada. Estos salen de la aritmética.
 */

import { closePool, initPool } from '@aai/db';
import { buildServer } from '@aai/api/server';
import { CUENTAS, CUENTA_DE_CIERRE, PLANTILLA, ROLES } from '@aai/shared';
import { cuitCheckDigit, totp, withCheckDigit } from '@aai/shared';
import type { FastifyInstance } from 'fastify';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { connect, hasDatabase, type Client } from './helpers/db.js';
import { sufijoUnico } from './helpers/identificadores.js';

const suite = hasDatabase ? describe : describe.skip;
const PASSWORD = 'una-contrasena-suficientemente-larga';

const FACTURA_A = 1;
const NOTA_CREDITO_A = 3;

interface Renglon {
  readonly accountCode: string;
  readonly debit: string;
  readonly credit: string;
  readonly descripcion: string;
  readonly partyId?: string;
  readonly taxTransactionId?: string;
}

interface Propuesta {
  readonly fecha: string;
  readonly descripcion: string;
  readonly renglones: readonly Renglon[];
  readonly motivoSinRenglones: string | null;
  readonly rolesFaltantes: readonly string[];
  readonly advertenciasDeConfiguracion: readonly string[];
  readonly justificacionSugerida: string | null;
}

suite('Una empresa nueva, de cero a estados contables', () => {
  let app: FastifyInstance;
  let db: Client;
  let stamp: string;
  let token: string;
  let empresa: string;
  let ejercicio: string;
  let clienteId: string;
  let proveedorId: string;
  let cuitCliente: string;
  let cuitProveedor: string;
  let productoId: string;
  let numeroCbte = 81_000;

  /** El ejercicio se abre en el año en curso: el asiento cae en un período vivo. */
  const anio = new Date().getUTCFullYear();
  const hoy = new Date().toISOString().slice(0, 10);

  const pedir = (
    method: 'GET' | 'POST' | 'PUT' | 'PATCH',
    url: string,
    payload?: unknown,
  ) =>
    app.inject({
      method,
      url,
      headers: { authorization: `Bearer ${token}`, 'x-company-id': empresa },
      ...(payload === undefined ? {} : { payload }),
    });

  const ok = (r: { statusCode: number; body: string }, esperado = 200): void => {
    expect(r.statusCode, r.body).toBe(esperado);
  };

  // ---------------------------------------------------------------------------
  // Una operación completa: comprobante, detalle, propuesta, asiento, aprobación
  // ---------------------------------------------------------------------------
  const operar = async (opciones: {
    direccion: 'VENTAS' | 'COMPRAS';
    cbteTipo: number;
    cuit: string;
    parteId: string;
    neto: string;
    iva: string;
    total: string;
    descripcionLinea: string;
    journalCode: 'VENTAS' | 'COMPRAS';
  }): Promise<{ propuesta: Propuesta; entryId: string }> => {
    numeroCbte += 1;
    const forma =
      `--X\r\nContent-Disposition: form-data; name="file"; filename="nueva-${stamp}-${numeroCbte}.xml"\r\n` +
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
    ok(subida, 201);

    const alta = await pedir(
      'POST',
      `/documents/${subida.json<{ id: string }>().id}/tax-transaction`,
      {
        direction: opciones.direccion,
        cbteTipo: opciones.cbteTipo,
        puntoVenta: 1,
        numero: numeroCbte,
        fecha: hoy,
        cuitContraparte: opciones.cuit,
        razonSocial: opciones.direccion === 'VENTAS' ? 'Cliente' : 'Proveedor',
        condicionIva: 'RESPONSABLE_INSCRIPTO',
        neto: opciones.neto,
        iva: opciones.iva,
        noGravado: '0',
        exento: '0',
        percepciones: '0',
        total: opciones.total,
        ...(opciones.direccion === 'COMPRAS'
          ? {
              constatacionDeclarada: {
                resultado: 'OK',
                motivo: 'Verificado en el portal de ARCA con clave fiscal del cliente',
              },
            }
          : {}),
      },
    );
    ok(alta, 201);
    const comprobanteId = alta.json<{ taxTransactionId: string }>().taxTransactionId;

    ok(await pedir('POST', `/tax-transactions/${comprobanteId}/party`, { partyId: opciones.parteId }));

    ok(
      await pedir('PUT', `/tax-transactions/${comprobanteId}/lines`, {
        renglones: [
          {
            productoId,
            descripcion: opciones.descripcionLinea,
            cantidad: '1',
            precioUnitario: `${opciones.neto}00`.slice(0, opciones.neto.length + 2),
            tratamiento: 'GRAVADO',
            neto: opciones.neto,
            iva: opciones.iva,
          },
        ],
      }),
    );

    const propuestaRes = await pedir(
      'GET',
      `/tax-transactions/${comprobanteId}/asiento-propuesto`,
    );
    ok(propuestaRes);
    const propuesta = propuestaRes.json<Propuesta>();
    expect(propuesta.motivoSinRenglones, JSON.stringify(propuesta)).toBeNull();

    // La decisión: una persona mira la propuesta y la carga. La propuesta por sí
    // sola no funda nada.
    const creado = await pedir('POST', '/journal-entries', {
      journalCode: opciones.journalCode,
      entryDate: propuesta.fecha,
      description: propuesta.descripcion,
      lines: propuesta.renglones.map((r) => ({
        accountCode: r.accountCode,
        debit: r.debit,
        credit: r.credit,
        ...(r.partyId === undefined ? {} : { partyId: r.partyId }),
        ...(r.taxTransactionId === undefined ? {} : { taxTransactionId: r.taxTransactionId }),
        description: r.descripcion,
      })),
      source: { type: 'INVOICE', id: comprobanteId },
      manualJustification: propuesta.justificacionSugerida ?? 'Revisado y aceptado por la contadora',
    });
    ok(creado, 201);
    const entryId = creado.json<{ id: string }>().id;

    // Y la aprobación, que es el acto que lo pone en el Mayor.
    ok(await pedir('POST', `/journal-entries/${entryId}/approve`));

    return { propuesta, entryId };
  };

  /** Saldo de una cuenta en el Mayor: debe menos haber, en pesos. */
  const saldo = async (codigo: string): Promise<number> => {
    const r = await db.query<{ saldo: string }>(
      `SELECT coalesce(sum(l.debit - l.credit), 0)::text AS saldo
         FROM journal_entry_lines l
         JOIN journal_entries e ON e.id = l.entry_id
         JOIN accounts a ON a.id = l.account_id
        WHERE l.company_id = $1 AND a.code = $2 AND e.status = 'APROBADO'`,
      [empresa, codigo],
    );
    return Number(r.rows[0]!.saldo);
  };

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
          `fundador-nueva-${stamp}@estudio.test`,
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
        `Estudio nueva ${stamp}`,
        withCheckDigit(`30${stamp}`),
        fundadorId,
      ])
    ).rows[0]!.create_organization;

    // SA con IGJ y RT_FACPCE: la combinación que las plantillas globales de
    // estados contables cubren (Ley 19.550, arts. 63 y 64).
    empresa = (
      await db.query<{ create_company: string }>('SELECT create_company($1,$2,$3,$4,$5,$6,$7,$8)', [
        fundadorId, organizationId, `Ferretería del Norte ${stamp}`, withCheckDigit(`27${stamp}`),
        'SA', 'AR-C', 'IGJ', '12-31',
      ])
    ).rows[0]!.create_company;

    const tokenFundador = (
      await app.inject({
        method: 'POST',
        url: '/auth/login',
        payload: { email: `fundador-nueva-${stamp}@estudio.test`, password: PASSWORD },
      })
    ).json<{ token: string }>().token;

    const email = `contadora-nueva-${stamp}@estudio.test`;
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
  }, 120_000);

  afterAll(async () => {
    await app?.close();
    await db?.end();
    await closePool();
  });

  // ==========================================================================
  // 1 · La empresa nace sin nada
  // ==========================================================================
  it('recién creada, la empresa no puede trabajar, y el sistema dice por qué', async () => {
    const r = await db.query<{
      cuentas_imputables: number;
      ejercicios: number;
      roles_mapeados: number;
      marcos_de_reporte: number;
    }>(
      `SELECT cuentas_imputables, ejercicios, roles_mapeados, marcos_de_reporte
         FROM company_readiness WHERE company_id = $1`,
      [empresa],
    );

    expect(r.rows[0]).toEqual({
      cuentas_imputables: 0,
      ejercicios: 0,
      roles_mapeados: 0,
      marcos_de_reporte: 0,
    });
  });

  // ==========================================================================
  // 2 · El plan de cuentas
  // ==========================================================================
  it('materializa el plan NEXO PYME: 185 cuentas, 42 agrupadoras, 143 imputables', async () => {
    const r = await pedir('POST', '/chart-template');
    ok(r, 201);
    expect(r.json<{ cuentas: number; plantilla: string; version: number }>()).toMatchObject({
      cuentas: 185,
      plantilla: PLANTILLA.templateId,
      version: PLANTILLA.version,
    });

    const conteo = await db.query<{ total: string; agrupadoras: string; imputables: string }>(
      `SELECT count(*)::text AS total,
              count(*) FILTER (WHERE NOT is_postable)::text AS agrupadoras,
              count(*) FILTER (WHERE is_postable)::text     AS imputables
         FROM accounts WHERE company_id = $1`,
      [empresa],
    );
    expect(conteo.rows[0]).toEqual({ total: '185', agrupadoras: '42', imputables: '143' });

    // Y es exactamente el catálogo, no 185 cuentas cualesquiera.
    expect(CUENTAS.length).toBe(185);
  });

  it('la copia conserva la procedencia y los metadatos', async () => {
    const chart = await db.query<{ template_id: string; template_version: number }>(
      'SELECT template_id, template_version FROM account_charts WHERE company_id = $1',
      [empresa],
    );
    expect(chart.rows[0]).toEqual({
      template_id: PLANTILLA.templateId,
      template_version: PLANTILLA.version,
    });

    // Los tres metadatos de la 0128 viajaron con la copia.
    const meta = await db.query<{ regularizadoras: string; especializadas: string; notas: string }>(
      `SELECT count(*) FILTER (WHERE regularizadora)::text  AS regularizadoras,
              count(*) FILTER (WHERE especializada)::text   AS especializadas,
              count(*) FILTER (WHERE nota IS NOT NULL)::text AS notas
         FROM accounts WHERE company_id = $1`,
      [empresa],
    );
    expect(Number(meta.rows[0]!.regularizadoras)).toBe(
      CUENTAS.filter((c) => c.regularizadora === true).length,
    );
    expect(Number(meta.rows[0]!.especializadas)).toBe(
      CUENTAS.filter((c) => c.especializada === true).length,
    );
    expect(Number(meta.rows[0]!.notas)).toBeGreaterThan(0);

    // La cuenta que recibe la refundición quedó designada por la copia: sin ella
    // el cierre de ejercicio se rechaza con E_RESULT_ACCOUNT_MISSING.
    const cierre = await db.query<{ code: string }>(
      `SELECT code FROM accounts
        WHERE company_id = $1 AND closing_role = 'RESULTADO_DEL_EJERCICIO'`,
      [empresa],
    );
    expect(cierre.rows.map((f) => f.code)).toEqual([CUENTA_DE_CIERRE]);
  });

  // ==========================================================================
  // 3 · La configuración mínima para operar
  // ==========================================================================
  it('declara el mapeo contable con las cuentas del plan recién copiado', async () => {
    // Las ocho cuentas salen del catálogo: es el mapeo que el propio modelo
    // propone, no uno inventado para el test.
    const r = await pedir('PUT', '/accounting-map', {
      asignaciones: Object.entries(ROLES).map(([rol, cuenta]) => ({ rol, cuenta })),
    });
    ok(r);
    expect(r.json<{ declarados: number; faltantes: string[] }>()).toMatchObject({
      declarados: 8,
      faltantes: [],
    });
  });

  it('declara el marco contable y abre el ejercicio', async () => {
    ok(
      await pedir('POST', '/companies/current/reporting-framework', {
        framework: 'RT_FACPCE',
        validFrom: `${anio}-01-01`,
      }),
    );

    const r = await pedir('POST', '/fiscal-years', {
      code: `EJ${anio}-${stamp}`,
      startDate: `${anio}-01-01`,
      endDate: `${anio}-12-31`,
    });
    ok(r, 201);
    ejercicio = r.json<{ id: string }>().id;

    const listo = await db.query<{
      cuentas_imputables: number;
      ejercicios: number;
      periodos_abiertos_hoy: number;
      roles_mapeados: number;
      marcos_de_reporte: number;
    }>('SELECT * FROM company_readiness WHERE company_id = $1', [empresa]);
    expect(listo.rows[0]).toMatchObject({
      cuentas_imputables: 143,
      ejercicios: 1,
      roles_mapeados: 8,
      marcos_de_reporte: 1,
    });
    expect(listo.rows[0]!.periodos_abiertos_hoy).toBeGreaterThan(0);
  });

  // ==========================================================================
  // 4 · Terceros y producto
  // ==========================================================================
  it('da de alta un cliente, un proveedor y un producto con sus dos cuentas', async () => {
    cuitCliente = `30${stamp}${cuitCheckDigit(`30${stamp}`)}`;
    cuitProveedor = `23${stamp}${cuitCheckDigit(`23${stamp}`)}`;

    const cliente = await pedir('POST', '/parties', {
      tipoDocumento: 'CUIT',
      numeroDocumento: cuitCliente,
      razonSocial: `Cliente ${stamp}`,
      roles: ['CLIENTE'],
    });
    ok(cliente, 201);
    clienteId = cliente.json<{ id: string }>().id;

    const proveedor = await pedir('POST', '/parties', {
      tipoDocumento: 'CUIT',
      numeroDocumento: cuitProveedor,
      razonSocial: `Proveedor ${stamp}`,
      roles: ['PROVEEDOR'],
    });
    ok(proveedor, 201);
    proveedorId = proveedor.json<{ id: string }>().id;

    // Las dos cuentas son del plan de ESTA empresa, activas, imputables y del
    // tipo que el disparador de la 0048 exige: ingreso para venta, costo para
    // compra. Si alguna no lo fuera, el alta devolvería 422.
    const p = await pedir('POST', '/products', {
      codigo: `TORNILLO-${stamp}`,
      nombre: 'Tornillo de acero 6x40',
      impuesto: 'IVA',
      cuentaVenta: ROLES.VENTAS,
      cuentaCompra: ROLES.COMPRAS,
      llevaStock: true,
    });
    ok(p, 201);
    productoId = p.json<{ id: string }>().id;

    const cuentas = await db.query<{ code: string; status: string; is_postable: boolean; type: string }>(
      `SELECT a.code, a.status, a.is_postable, a.type
         FROM products pr JOIN accounts a
           ON a.id IN (pr.sales_account_id, pr.purchase_account_id)
          AND a.company_id = pr.company_id
        WHERE pr.id = $1 ORDER BY a.code`,
      [productoId],
    );
    expect(cuentas.rows).toHaveLength(2);
    for (const c of cuentas.rows) {
      expect(c.status).toBe('ACTIVE');
      expect(c.is_postable).toBe(true);
    }
  });

  // ==========================================================================
  // 5 · La primera venta
  // ==========================================================================
  it('factura una venta y la lleva al Mayor', async () => {
    const { propuesta } = await operar({
      direccion: 'VENTAS',
      cbteTipo: FACTURA_A,
      cuit: cuitCliente,
      parteId: clienteId,
      neto: '100000.00',
      iva: '21000.00',
      total: '121000.00',
      descripcionLinea: 'Tornillos de acero',
      journalCode: 'VENTAS',
    });

    expect(propuesta.advertenciasDeConfiguracion).toEqual([]);
    expect(propuesta.renglones).toEqual([
      {
        accountCode: ROLES.CLIENTES,
        debit: '121000.00',
        credit: '0',
        descripcion: expect.any(String),
        partyId: clienteId,
      },
      {
        accountCode: ROLES.VENTAS,
        debit: '0',
        credit: '100000.00',
        descripcion: expect.any(String),
      },
      {
        accountCode: ROLES.IVA_DEBITO,
        debit: '0',
        credit: '21000.00',
        descripcion: 'IVA débito fiscal',
        // La cuenta de IVA tiene rol fiscal: sin este vínculo el asiento no se
        // puede cargar. `validate.ts` lo rechaza con E_TAX_LINK_MISSING.
        taxTransactionId: expect.any(String),
      },
    ]);

    expect(await saldo(ROLES.CLIENTES)).toBe(121_000);
    expect(await saldo(ROLES.VENTAS)).toBe(-100_000);
    expect(await saldo(ROLES.IVA_DEBITO)).toBe(-21_000);
  });

  // ==========================================================================
  // 6 · La primera compra
  // ==========================================================================
  it('registra una compra y la lleva al Mayor', async () => {
    const { propuesta } = await operar({
      direccion: 'COMPRAS',
      cbteTipo: FACTURA_A,
      cuit: cuitProveedor,
      parteId: proveedorId,
      neto: '60000.00',
      iva: '12600.00',
      total: '72600.00',
      descripcionLinea: 'Reposición de tornillos',
      journalCode: 'COMPRAS',
    });

    expect(propuesta.renglones.map((r) => r.accountCode)).toEqual([
      ROLES.COMPRAS,
      ROLES.IVA_CREDITO,
      ROLES.PROVEEDORES,
    ]);

    expect(await saldo(ROLES.COMPRAS)).toBe(60_000);
    expect(await saldo(ROLES.IVA_CREDITO)).toBe(12_600);
    expect(await saldo(ROLES.PROVEEDORES)).toBe(-72_600);
  });

  // ==========================================================================
  // 7 · La nota de crédito
  // ==========================================================================
  it('emite una nota de crédito de venta y el Mayor la refleja invertida', async () => {
    const { propuesta } = await operar({
      direccion: 'VENTAS',
      cbteTipo: NOTA_CREDITO_A,
      cuit: cuitCliente,
      parteId: clienteId,
      neto: '20000.00',
      iva: '4200.00',
      total: '24200.00',
      descripcionLinea: 'Devolución de tornillos fallados',
      journalCode: 'VENTAS',
    });

    expect(propuesta.descripcion).toContain('Nota de crédito de venta');
    // El cliente al haber: debe menos.
    expect(propuesta.renglones.find((r) => r.accountCode === ROLES.CLIENTES)).toMatchObject({
      debit: '0',
      credit: '24200.00',
    });
    expect(propuesta.renglones.find((r) => r.accountCode === ROLES.VENTAS)).toMatchObject({
      debit: '20000.00',
      credit: '0',
    });

    // Y el Mayor, después de las tres operaciones.
    expect(await saldo(ROLES.CLIENTES)).toBe(121_000 - 24_200);
    expect(await saldo(ROLES.VENTAS)).toBe(-(100_000 - 20_000));
    expect(await saldo(ROLES.IVA_DEBITO)).toBe(-(21_000 - 4_200));
  });

  // ==========================================================================
  // 8 · Los libros
  // ==========================================================================
  it('el balance de sumas y saldos cuadra', async () => {
    const r = await pedir(
      'GET',
      `/reports/trial-balance?desde=${anio}-01-01&hasta=${anio}-12-31`,
    );
    ok(r);
    const balance = r.json<{
      totales: { debitos: string; creditos: string };
      cuadra: boolean;
      verificaciones: { nombre: string; cumple: boolean }[];
    }>();

    expect(balance.cuadra).toBe(true);
    expect(balance.verificaciones.filter((v) => !v.cumple)).toEqual([]);
    expect(Number(balance.totales.debitos)).toBe(Number(balance.totales.creditos));
    // Las tres operaciones: 121.000 + 72.600 + 24.200
    expect(Number(balance.totales.debitos)).toBe(217_800);
  });

  it('el Mayor muestra las cuentas movidas y nada más', async () => {
    const r = await pedir('GET', `/books/mayor?desde=${anio}-01-01&hasta=${anio}-12-31`);
    ok(r);
    const mayor = r.json<{ cuentas: { codigo: string; saldoFinal: string }[] }>();

    const movidas = mayor.cuentas.map((c) => c.codigo).sort();
    expect(movidas).toEqual(
      [
        ROLES.CLIENTES,
        ROLES.VENTAS,
        ROLES.IVA_DEBITO,
        ROLES.COMPRAS,
        ROLES.IVA_CREDITO,
        ROLES.PROVEEDORES,
      ].sort(),
    );
  });

  // ==========================================================================
  // 9 · Los estados contables
  // ==========================================================================
  it('el estado de resultados dice lo que dicen los movimientos', async () => {
    const r = await pedir('GET', `/statements?ejercicio=${ejercicio}&tipo=ER`);
    ok(r);
    const er = r.json<{
      emisible: boolean;
      motivo: string | null;
      controles: { codigo: string; cumple: boolean; detalle: string }[];
      renglones: {
        codigo: string;
        etiqueta: string;
        tipo: 'RUBRO' | 'RENGLON' | 'TOTAL';
        importe: string;
        origen: { codigo: string; aporte: string }[];
      }[];
    }>();

    expect(
      er.emisible,
      `${er.motivo} :: ${JSON.stringify(er.controles.filter((c) => !c.cumple))}`,
    ).toBe(true);

    // Se busca por la cuenta que aporta, no por la posición del renglón: la
    // plantilla puede reordenar rubros y eso no cambia lo que pasó.
    const aporteDe = (codigo: string): number =>
      er.renglones
        .filter((renglon) => renglon.tipo === 'RENGLON')
        .flatMap((renglon) => renglon.origen)
        .filter((origen) => origen.codigo === codigo)
        .reduce((total, origen) => total + Math.abs(Number(origen.aporte)), 0);

    // Ventas netas: 100.000 facturados menos 20.000 de la nota de crédito.
    expect(aporteDe(ROLES.VENTAS)).toBe(80_000);
    expect(aporteDe(ROLES.COMPRAS)).toBe(60_000);
  });

  it('la situación patrimonial cumple la ecuación contable', async () => {
    const r = await pedir('GET', `/statements?ejercicio=${ejercicio}&tipo=ESP`);
    ok(r);
    const esp = r.json<{
      emisible: boolean;
      motivo: string | null;
      controles: { codigo: string; cumple: boolean; detalle: string }[];
      renglones: {
        codigo: string;
        tipo: 'RUBRO' | 'RENGLON' | 'TOTAL';
        importe: string;
        origen: { codigo: string; aporte: string }[];
      }[];
    }>();

    expect(
      esp.emisible,
      `${esp.motivo} :: ${JSON.stringify(esp.controles.filter((c) => !c.cumple))}`,
    ).toBe(true);

    // La ecuación no es un campo aparte: es un control del estado, y lo evalúa
    // el motor sobre los renglones emitidos.
    const ecuacion = esp.controles.find((c) => c.codigo === 'ECUACION_PATRIMONIAL');
    expect(ecuacion, JSON.stringify(esp.controles)).toBeDefined();
    expect(ecuacion!.cumple, ecuacion!.detalle).toBe(true);

    // Activo    = 121.000 - 24.200 (clientes) + 12.600 (IVA CF) = 109.400
    // Pasivo    = 72.600 (proveedores) + 16.800 (IVA DF)        =  89.400
    // PN        = resultado del ejercicio                       =  20.000
    const aporteDe = (codigo: string): number =>
      esp.renglones
        .filter((renglon) => renglon.tipo === 'RENGLON')
        .flatMap((renglon) => renglon.origen)
        .filter((origen) => origen.codigo === codigo)
        .reduce((total, origen) => total + Math.abs(Number(origen.aporte)), 0);

    expect(aporteDe(ROLES.CLIENTES)).toBe(96_800);
    expect(aporteDe(ROLES.IVA_CREDITO)).toBe(12_600);
    expect(aporteDe(ROLES.PROVEEDORES)).toBe(72_600);
    expect(aporteDe(ROLES.IVA_DEBITO)).toBe(16_800);
  });

  it('el estado se puede emitir, y queda firmado', async () => {
    const r = await pedir('POST', '/statements/issue', { ejercicio, tipo: 'ESP' });
    ok(r, 201);

    const emitido = await db.query<{ status: string; content_sha256: string }>(
      `SELECT status, content_sha256 FROM financial_statements
        WHERE company_id = $1 AND statement_kind = 'ESP' AND status <> 'ANULADO'`,
      [empresa],
    );
    expect(emitido.rows).toHaveLength(1);
    expect(emitido.rows[0]!.status).toBe('EMITIDO');
    expect(emitido.rows[0]!.content_sha256).toMatch(/^[0-9a-f]{64}$/u);
  });
});
