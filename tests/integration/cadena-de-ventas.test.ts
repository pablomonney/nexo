/**
 * S-19 — la cadena de ventas, de punta a punta, por HTTP.
 *
 * ```
 * CLIENTE → PRESUPUESTO → FACTURA → STOCK → CUENTA CORRIENTE → ASIENTO
 *         → MAYOR → COBRANZA → IMPUTACIÓN → COSTO DE LO VENDIDO
 *         → BANCO → CONCILIACIÓN
 * ```
 *
 * ## Por qué hacía falta
 *
 * Cada eslabón estaba probado en su propia suite, con su propio fixture: el
 * ciclo comercial llega hasta la operación fiscal y ahí se detiene; la
 * imputación de cobros arranca de una factura que se crea a mano; la salida de
 * stock se prueba contra un comprobante que nadie facturó. Las piezas andaban y
 * **nadie recorría la cadena entera con la misma operación**.
 *
 * Es la misma forma de defecto que S-16 y S-17 persiguen, un nivel más arriba:
 * no una función sin consumidor ni una tabla sin escritor, sino una **capa sin
 * la de al lado**. El circuito de compras ya tiene su cadena caminada
 * (`ciclo-compras`); esta es la de ventas.
 *
 * ## Lo que se comprueba en cada cruce
 *
 *   1. Lo que se factura es lo que el cliente aceptó, no lo que diga el pedido.
 *   2. La mercadería sale del depósito y el movimiento cita el comprobante.
 *   3. La deuda del cliente aparece sola: es una vista, no una fila que alguien
 *      escribe.
 *   4. El asiento sale del mapeo declarado por la empresa y entra por el único
 *      escritor del Mayor.
 *   5. El Mayor muestra el saldo del cliente, y la cobranza lo cancela **contra
 *      la factura**, no contra el total.
 *   6. El costo de lo vendido llega al Mayor por su propia propuesta, con el
 *      método de valuación declarado — y no llega si falta declararlo.
 *   7. El banco acredita la cobranza y la conciliación cierra: el extracto se
 *      compara contra el Mayor de esa cuenta, no contra un saldo declarado.
 *   8. Del asiento se vuelve al comprobante y del comprobante al presupuesto.
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

suite('S-19 — la cadena de ventas completa', () => {
  let app: FastifyInstance;
  let db: Client;
  let stamp: string;
  let token: string;
  let empresa: string;
  let clienteId: string;
  let productoId: string;
  let deposito: string;
  let hoy: string;

  /** Lo que la cadena va dejando, para que cada paso cite al anterior. */
  let presupuestoId = '';
  let facturaId = '';
  let asientoDeVenta = '';

  const pedir = (method: 'GET' | 'POST' | 'PUT', url: string, payload?: unknown) =>
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

    // Del reloj de la base: el período abierto lo decide ella.
    hoy = (await db.query<{ hoy: string }>('SELECT current_date::text AS hoy')).rows[0]!.hoy;

    const { hash: argonHash } = await import('@node-rs/argon2');
    const fundadorId = (
      await db.query<{ id: string }>(
        'INSERT INTO users (email, full_name, password_hash) VALUES ($1,$2,$3) RETURNING id',
        [
          `fundador-vta-${stamp}@estudio.test`,
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
        `Estudio vta ${stamp}`,
        withCheckDigit(`30${stamp}`),
        fundadorId,
      ])
    ).rows[0]!.create_organization;

    empresa = (
      await db.query<{ create_company: string }>('SELECT create_company($1,$2,$3,$4,$5,$6,$7,$8)', [
        fundadorId,
        organizationId,
        `Empresa vta ${stamp}`,
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
        payload: { email: `fundador-vta-${stamp}@estudio.test`, password: PASSWORD },
      })
    ).json<{ token: string }>().token;

    const email = `contadora-vta-${stamp}@estudio.test`;
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

    const anio = Number(hoy.slice(0, 4));
    expect(
      (
        await pedir('POST', '/fiscal-years', {
          code: `EJ${anio}-${stamp}`,
          startDate: `${anio}-01-01`,
          endDate: `${anio}-12-31`,
        })
      ).statusCode,
    ).toBe(201);

    // El plan de cuentas es por empresa: no hay cuentas por defecto. Estas
    // cinco son las que la cadena necesita, y cada una con su tipo — el mapeo
    // contable comprueba que el rol reciba una cuenta del tipo correcto.
    for (const cuenta of [
      { code: '1.1.01', name: 'Caja', type: 'ACTIVO' },
      { code: '1.1.02', name: 'Deudores por ventas', type: 'ACTIVO', requiresThirdParty: true },
      { code: '2.1.03', name: 'IVA débito fiscal', type: 'PASIVO' },
      { code: '4.1.01', name: 'Ventas', type: 'INGRESO' },
      { code: '5.1.01', name: 'Costo de mercadería vendida', type: 'COSTO' },
      { code: '1.1.03', name: 'Mercadería de reventa', type: 'ACTIVO' },
      { code: '1.1.04', name: 'Banco', type: 'ACTIVO' },
    ]) {
      expect((await pedir('POST', '/accounts', cuenta)).statusCode, cuenta.code).toBe(201);
    }

    expect(
      (
        await pedir('PUT', '/accounting-map', {
          asignaciones: [
            { rol: 'CLIENTES', cuenta: '1.1.02' },
            { rol: 'IVA_DEBITO', cuenta: '2.1.03' },
            { rol: 'VENTAS', cuenta: '4.1.01' },
          ],
        })
      ).statusCode,
    ).toBe(200);

    clienteId = (
      await pedir('POST', '/parties', {
        tipoDocumento: 'CUIT',
        numeroDocumento: `33${stamp}${cuitCheckDigit(`33${stamp}`)}`,
        razonSocial: `Cliente vta ${stamp}`,
        condicionIva: 'RESPONSABLE_INSCRIPTO',
        roles: ['CLIENTE'],
      })
    ).json<{ id: string }>().id;

    productoId = (
      await pedir('POST', '/products', {
        codigo: `PRD-${stamp}`,
        nombre: 'Producto que se vende',
        impuesto: 'IVA',
        cuentaVenta: '4.1.01',
        llevaStock: true,
      })
    ).json<{ id: string }>().id;

    deposito = (
      await pedir('POST', '/warehouses', { codigo: `DEP-${stamp}`, nombre: 'Depósito' })
    ).json<{ id: string }>().id;

    // Diez unidades en el depósito. La existencia inicial entra por ajuste y no
    // por un endpoint de «entrada»: **no existe**, y es a propósito — la
    // mercadería entra por una recepción de compra (un trigger la proyecta) o
    // por un ajuste con su motivo. Un alta suelta de existencias sería la forma
    // más fácil de inventar stock.
    expect(
      (
        await pedir('POST', '/stock-movements/ajuste', {
          productoId,
          depositoId: deposito,
          fecha: hoy,
          cantidad: '10',
          sentido: 'POSITIVO',
          motivo: 'Existencia inicial declarada al poner en marcha el depósito',
          // Con costo: sin él la salida no se puede costear y no hay CMV que
          // asentar. El endpoint no lo aceptaba —la base sí— y lo encontró
          // esta cadena al llegar al último eslabón.
          costoUnitario: '60.0000',
        })
      ).statusCode,
    ).toBe(201);
  }, 90_000);

  afterAll(async () => {
    await app?.close();
    await db?.end();
    await closePool();
  });

  it('1 · el cliente pide: presupuesto emitido y aceptado', async () => {
    const alta = await pedir('POST', '/commercial-documents', {
      direccion: 'VENTAS',
      tipo: 'PRESUPUESTO',
      terceroId: clienteId,
      fecha: hoy,
    });
    expect(alta.statusCode, alta.body).toBe(201);
    presupuestoId = alta.json<{ id: string }>().id;

    expect(
      (
        await pedir('PUT', `/commercial-documents/${presupuestoId}/lines`, {
          renglones: [
            {
              productoId,
              descripcion: 'Producto que se vende',
              cantidad: '4',
              unidad: 'UNIDAD',
              precioUnitario: '250.0000',
              tratamiento: 'GRAVADO',
              neto: '1000.00',
              iva: '210.00',
            },
          ],
        })
      ).statusCode,
    ).toBe(200);

    expect((await pedir('POST', `/commercial-documents/${presupuestoId}/emit`)).statusCode).toBe(
      200,
    );
    expect((await pedir('POST', `/commercial-documents/${presupuestoId}/accept`)).statusCode).toBe(
      200,
    );

    const doc = await pedir('GET', `/commercial-documents/${presupuestoId}`);
    expect(doc.json<{ documento: { total: string; status: string } }>().documento.total).toBe(
      '1210.00',
    );
  });

  it('2 · se factura lo aceptado, y la operación fiscal nace con su tercero', async () => {
    const factura = await pedir('POST', `/commercial-documents/${presupuestoId}/invoice`, {
      cbteTipo: 1,
      puntoVenta: 3,
      numero: Number(stamp.slice(-6)),
      fecha: hoy,
    });
    expect(factura.statusCode, factura.body).toBe(201);
    facturaId = factura.json<{ taxTransactionId: string }>().taxTransactionId;

    const tt = await db.query<{ total: string; party_id: string; direction: string }>(
      'SELECT total::text, party_id, direction FROM tax_transactions WHERE id = $1',
      [facturaId],
    );
    // Los importes salen de los renglones aceptados, no del cuerpo del pedido.
    expect(tt.rows[0]!.total).toBe('1210.00');
    expect(tt.rows[0]!.party_id).toBe(clienteId);
    expect(tt.rows[0]!.direction).toBe('VENTAS');
  });

  it('3 · la mercadería sale del depósito citando el comprobante', async () => {
    const antes = await pedir('GET', `/stock?productoId=${productoId}`);
    expect(antes.statusCode, antes.body).toBe(200);

    const salida = await pedir('POST', `/tax-transactions/${facturaId}/salida`, {
      depositoId: deposito,
      lineas: [{ productoId, cantidad: '4' }],
    });
    expect(salida.statusCode, salida.body).toBe(201);

    // El movimiento cita la operación fiscal: de la existencia se vuelve al
    // comprobante que la sacó.
    const movimiento = await db.query<{ origen_tipo: string; origen_id: string | null }>(
      `SELECT origen_tipo, origen_id::text
         FROM stock_movements
        WHERE company_id = $1 AND product_id = $2 AND tipo = 'SALIDA'
        ORDER BY created_at DESC LIMIT 1`,
      [empresa, productoId],
    );
    expect(movimiento.rows[0]!.origen_tipo).toBe('VENTA');
    expect(movimiento.rows[0]!.origen_id).toBe(facturaId);

    const existencias = await db.query<{ existencia: string }>(
      `SELECT existencia::text FROM stock_on_hand
        WHERE company_id = $1 AND product_id = $2 AND warehouse_id = $3`,
      [empresa, productoId, deposito],
    );
    expect(Number(existencias.rows[0]!.existencia), 'quedaron seis de las diez').toBe(6);
  });

  it('4 · la deuda del cliente aparece sola: nadie la escribe', async () => {
    const cc = await pedir('GET', `/parties/${clienteId}/saldo`);
    expect(cc.statusCode, cc.body).toBe(200);

    const cuerpo = cc.json<{
      comprobantes: { id: string; pendiente: string }[];
    }>();
    const nuestra = cuerpo.comprobantes.find((c) => c.id === facturaId);
    expect(nuestra, 'la factura compone el saldo del cliente').toBeDefined();
    expect(nuestra!.pendiente).toBe('1210.00');
  });

  it('5 · el asiento sale del mapeo declarado y entra por el único escritor', async () => {
    const propuesta = await pedir('GET', `/tax-transactions/${facturaId}/asiento-propuesto`);
    expect(propuesta.statusCode, propuesta.body).toBe(200);

    const p = propuesta.json<{
      renglones: { accountCode: string; debit: string; credit: string }[];
      fecha: string;
      descripcion: string;
      justificacionSugerida: string;
      motivoSinRenglones: string | null;
    }>();
    expect(p.motivoSinRenglones, 'con el mapeo declarado hay propuesta').toBeNull();

    const porCuenta = new Map(p.renglones.map((l) => [l.accountCode, l]));
    expect(porCuenta.get('1.1.02')!.debit).toBe('1210.00');
    expect(porCuenta.get('4.1.01')!.credit).toBe('1000.00');
    expect(porCuenta.get('2.1.03')!.credit).toBe('210.00');

    // Se carga por `POST /journal-entries` como cualquier otro asiento: la ruta
    // de la propuesta no escribe en el Diario.
    const alta = await pedir('POST', '/journal-entries', {
      journalCode: 'VENTAS',
      entryDate: p.fecha,
      description: p.descripcion,
      currency: 'ARS',
      lines: p.renglones.map((l) =>
        l.accountCode === '1.1.02' ? { ...l, partyId: clienteId } : l,
      ),
      source: { type: 'INVOICE', id: facturaId },
      manualJustification: p.justificacionSugerida,
    });
    expect(alta.statusCode, alta.body).toBe(201);
    asientoDeVenta = alta.json<{ id: string }>().id;

    expect((await pedir('POST', `/journal-entries/${asientoDeVenta}/approve`)).statusCode).toBe(
      200,
    );
  });

  it('6 · el Mayor muestra al cliente debiendo, y el Diario cuadra', async () => {
    const anio = hoy.slice(0, 4);
    const mayor = await pedir('GET', `/books/mayor?desde=${anio}-01-01&hasta=${hoy}`);
    expect(mayor.statusCode, mayor.body).toBe(200);

    const cuentas = mayor.json<{
      cuentas: { codigo: string; totalDebe: string; saldoFinal: string }[];
      saldosPorNaturaleza: { deudores: string; acreedores: string } | null;
    }>();

    const deudores = cuentas.cuentas.find((c) => c.codigo === '1.1.02');
    expect(deudores?.totalDebe, 'la venta llegó al Mayor').toBe('1210.00');
    // El cruce contra el balance de sumas y saldos viaja con el Mayor.
    expect(cuentas.saldosPorNaturaleza).not.toBeNull();
  });

  it('7 · la cobranza cancela la factura, no «el saldo»', async () => {
    const cobro = await pedir('POST', '/journal-entries', {
      journalCode: 'BANCOS',
      entryDate: hoy,
      description: `Cobranza del cliente ${stamp}`,
      currency: 'ARS',
      lines: [
        { accountCode: '1.1.04', debit: '1210.00', credit: '0' },
        { accountCode: '1.1.02', debit: '0', credit: '1210.00', partyId: clienteId },
      ],
      source: { type: 'RECEIPT', id: null },
      manualJustification: 'Cobranza de la factura de la cadena de ventas',
    });
    expect(cobro.statusCode, cobro.body).toBe(201);
    const cobroId = cobro.json<{ id: string }>().id;
    expect((await pedir('POST', `/journal-entries/${cobroId}/approve`)).statusCode).toBe(200);

    const linea = await db.query<{ id: string }>(
      `SELECT id FROM journal_entry_lines
        WHERE entry_id = $1 AND party_id = $2 AND credit > 0`,
      [cobroId, clienteId],
    );

    const imputacion = await pedir('POST', '/party-allocations', {
      taxTransactionId: facturaId,
      journalEntryLineId: linea.rows[0]!.id,
      importe: '1210.00',
    });
    expect(imputacion.statusCode, imputacion.body).toBe(201);

    // Saldada, la factura **sale** de la lista de pendientes: el endpoint pide
    // pendiente > 0 salvo que se pidan también las saldadas. Que desaparezca es
    // el resultado, no un dato que falte.
    const pendientes = (await pedir('GET', `/parties/${clienteId}/saldo`))
      .json<{ comprobantes: { id: string }[] }>()
      .comprobantes.map((c) => c.id);
    expect(pendientes).not.toContain(facturaId);

    const saldadas = (await pedir('GET', `/parties/${clienteId}/saldo?incluirSaldados=si`))
      .json<{
        comprobantes: { id: string; total: string; imputado: string; pendiente: string }[];
      }>()
      .comprobantes.find((c) => c.id === facturaId);
    expect(saldadas?.imputado, 'se imputó todo el comprobante').toBe('1210.00');
    expect(saldadas?.pendiente, 'la cadena cierra en cero').toBe('0.00');
  });

  /**
   * El último cruce, y el que más se saltea: **stock → contabilidad**.
   *
   * La mercadería salió en el paso 3 y el Mayor todavía no sabe nada del costo.
   * El asiento del CMV se propone por mes —el momento de asentarlo es política
   * contable y NEXO no la inventa— y exige tres cosas declaradas: método de
   * valuación, las dos cuentas del mapeo, y **costo en las entradas**.
   */
  it('8 · el costo de lo vendido llega al Mayor, con su método declarado', async () => {
    const mes = hoy.slice(0, 7);

    // Sin método declarado no hay propuesta, y el motivo lo dice.
    const sinMetodo = await pedir('GET', `/analysis/costo-de-ventas/asiento-propuesto?mes=${mes}`);
    expect(sinMetodo.statusCode, sinMetodo.body).toBe(200);
    expect(sinMetodo.json<{ motivoSinRenglones: string | null }>().motivoSinRenglones).toMatch(
      /método de valuación|no hubo salidas/i,
    );

    expect(
      (
        await pedir('PUT', '/stock-valuation', {
          metodo: 'PPP',
          vigenciaDesde: `${hoy.slice(0, 4)}-01-01`,
          motivo: 'Promedio ponderado para el ejercicio en curso',
        })
      ).statusCode,
    ).toBe(200);

    expect(
      (
        await pedir('PUT', '/accounting-map', {
          asignaciones: [
            { rol: 'MERCADERIA', cuenta: '1.1.03' },
            { rol: 'COSTO_DE_VENTAS', cuenta: '5.1.01' },
          ],
        })
      ).statusCode,
    ).toBe(200);

    const propuesta = await pedir('GET', `/analysis/costo-de-ventas/asiento-propuesto?mes=${mes}`);
    const p = propuesta.json<{
      renglones: { accountCode: string; debit: string; credit: string }[];
      motivoSinRenglones: string | null;
      justificacionSugerida: string | null;
    }>();
    expect(p.motivoSinRenglones, 'con costo declarado en la entrada, hay propuesta').toBeNull();

    // Cuatro unidades a $ 60: el costo sale del promedio, no del precio de venta.
    const porCuenta = new Map(p.renglones.map((l) => [l.accountCode, l]));
    expect(porCuenta.get('5.1.01')!.debit).toBe('240.00');
    expect(porCuenta.get('1.1.03')!.credit).toBe('240.00');

    const alta = await pedir('POST', '/journal-entries', {
      journalCode: 'AJUSTES',
      entryDate: hoy,
      description: `Costo de la mercadería vendida ${mes}`,
      currency: 'ARS',
      lines: p.renglones,
      source: { type: 'MANUAL', id: null },
      manualJustification: p.justificacionSugerida ?? 'Costo del mes, propuesto por el motor',
    });
    expect(alta.statusCode, alta.body).toBe(201);
    expect(
      (await pedir('POST', `/journal-entries/${alta.json<{ id: string }>().id}/approve`))
        .statusCode,
    ).toBe(200);
  });

  /**
   * El último tramo de tesorería: **el banco dice lo mismo que el libro**.
   *
   * La cobranza del paso 7 entró a la cuenta bancaria. Acá se importa el
   * extracto donde el banco la acredita y se concilia: la conciliación compara
   * el extracto contra el Mayor de esa cuenta, así que cierra sola si —y solo
   * si— el asiento de la cobranza llegó bien.
   *
   * Los dos extremos existían y se probaban por separado. Este paso los junta.
   */
  it('10 · el banco acredita la cobranza y la conciliación cierra', async () => {
    const cuentaBancaria = await pedir('POST', '/banks/accounts', {
      banco: `Banco de la cadena ${stamp}`,
      cuentaCodigo: '1.1.04',
    });
    expect(cuentaBancaria.statusCode, cuentaBancaria.body).toBe(201);
    const bancoId = cuentaBancaria.json<{ id: string }>().id;

    const mapeo = await pedir('POST', '/banks/statement-layouts', {
      bankAccountId: bancoId,
      nombre: 'Extracto de la cadena',
      filasEncabezado: 1,
      columnaFecha: 0,
      columnaDescripcion: 1,
      formatoFecha: 'AAAA-MM-DD',
      formatoImporte: 'ES_AR',
      signo: { tipo: 'COLUMNAS_SEPARADAS', columnaDebito: 2, columnaCredito: 3 },
    });
    expect(mapeo.statusCode, mapeo.body).toBe(201);

    const extracto = await pedir('POST', `/banks/accounts/${bancoId}/statements`, {
      layoutId: mapeo.json<{ id: string }>().id,
      desde: `${hoy.slice(0, 4)}-01-01`,
      hasta: hoy,
      saldoInicial: '0',
      saldoFinal: '1210.00',
      contenido: ['Fecha;Descripcion;Debito;Credito', `${hoy};COBRANZA CLIENTE;;1.210,00`].join(
        '\n',
      ),
    });
    expect(extracto.statusCode, extracto.body).toBe(201);
    expect(extracto.json<{ movimientos: number }>().movimientos).toBe(1);

    // El saldo del libro **no se declara**: sale del Mayor de la cuenta.
    const acta = await pedir('POST', `/banks/accounts/${bancoId}/reconciliations`, {
      desde: `${hoy.slice(0, 4)}-01-01`,
      hasta: hoy,
      saldoExtracto: '1210.00',
    });
    expect(acta.statusCode, acta.body).toBe(201);
    const conciliacion = acta.json<{ reconciliationId: string; saldoLibro: string }>();
    expect(conciliacion.saldoLibro, 'lo que el Mayor dice de esa cuenta').toBe('1210.00');

    // La propuesta encuentra el par: el movimiento del banco y la línea del
    // asiento de cobranza son la misma operación.
    const propuesta = await pedir(
      'POST',
      `/banks/accounts/${bancoId}/reconciliations/propose`,
      { desde: `${hoy.slice(0, 4)}-01-01`, hasta: hoy, saldoSegunExtracto: '1210.00' },
    );
    expect(propuesta.statusCode, propuesta.body).toBe(200);
    const p = propuesta.json<{ cierra: boolean; propuestas: { importe: string }[] }>();
    expect(p.cierra, 'extracto y libro dicen lo mismo').toBe(true);
    expect(p.propuestas[0]?.importe, 'el par es la cobranza').toBe('1210.00');

    expect(
      (await pedir('POST', `/banks/reconciliations/${conciliacion.reconciliationId}/confirm`))
        .statusCode,
    ).toBe(200);

    const verificada = await pedir(
      'GET',
      `/banks/reconciliations/${conciliacion.reconciliationId}/verificar`,
    );
    const v = verificada.json<{ verificable: boolean; coincide: boolean | null; detalle: string }>();
    expect(v.verificable).toBe(true);
    expect(v.coincide, v.detalle).toBe(true);
  });

  /**
   * S-22 — el primer número que mira para adelante, y sigue siendo una división.
   *
   * La cadena dejó cuatro unidades vendidas y seis en el depósito. «Cuánto dura
   * lo que hay» es existencia sobre consumo diario, y el consumo diario es lo
   * que salió por venta en noventa días dividido noventa. No es un pronóstico:
   * es el ritmo pasado, dicho con la cantidad de salidas que lo produjo para
   * que quien mire pueda descartarlo.
   */
  it('12 · el sistema puede decir cuánto dura lo que hay, y qué no puede afirmar', async () => {
    // Un segundo producto con existencia y sin una sola venta: es el caso que
    // no se puede afirmar, y tiene que decirse distinto de «alcanza para
    // siempre».
    const dormido = (
      await pedir('POST', '/products', {
        codigo: `DORM-${stamp}`,
        nombre: 'Producto que nadie compró',
        impuesto: 'IVA',
        cuentaVenta: '4.1.01',
        llevaStock: true,
      })
    ).json<{ id: string }>().id;

    expect(
      (
        await pedir('POST', '/stock-movements/ajuste', {
          productoId: dormido,
          depositoId: deposito,
          fecha: hoy,
          cantidad: '3',
          sentido: 'POSITIVO',
          motivo: 'Existencia inicial de un producto sin movimiento',
          costoUnitario: '10.0000',
        })
      ).statusCode,
    ).toBe(201);

    const r = await pedir('POST', '/intelligence/preguntar', {
      pregunta: '¿qué me va a faltar?',
      preguntaId: 'QUE_ME_VA_A_FALTAR',
    });
    expect(r.statusCode, r.body).toBe(200);

    const v = r.json<{
      entendida: boolean;
      respuesta: {
        valor: string;
        datos: { etiqueta: string; valor: string }[];
        metodologia: string;
        noIncluye: string | null;
        origen: string[];
      };
    }>();
    expect(v.entendida).toBe(true);

    // Seis unidades al ritmo de cuatro cada noventa días: 135 días.
    const nuestro = v.respuesta.datos.find((d) => d.etiqueta.startsWith(`PRD-${stamp}`));
    expect(nuestro, 'el producto que se vendió tiene cobertura afirmable').toBeDefined();
    expect(nuestro!.valor).toContain('~135 días');
    expect(nuestro!.valor, 'la cantidad de salidas que produjo el ritmo va al lado').toContain(
      '1 salida(s)',
    );

    // Y el que nadie compró no aparece con una cobertura inventada: aparece en
    // lo que no se puede afirmar, con el motivo.
    expect(v.respuesta.datos.map((d) => d.etiqueta)).not.toContain(
      `DORM-${stamp} — Producto que nadie compró`,
    );
    expect(v.respuesta.noIncluye).toContain('SIN_CONSUMO_EN_LA_VENTANA');
    expect(v.respuesta.metodologia).toContain('no un pronóstico');
    expect(v.respuesta.origen).toContain('stock_coverage');
  });

  it('13 · desde el asiento se vuelve al comprobante y al presupuesto', async () => {
    // El asiento cita la operación fiscal…
    const asiento = await db.query<{ source_type: string; source_id: string }>(
      'SELECT source_type, source_id::text FROM journal_entries WHERE id = $1',
      [asientoDeVenta],
    );
    expect(asiento.rows[0]!.source_id).toBe(facturaId);

    // …y la operación fiscal cita el documento comercial que la originó.
    const origen = await db.query<{ id: string; status: string }>(
      'SELECT id, status FROM commercial_documents WHERE tax_transaction_id = $1',
      [facturaId],
    );
    expect(origen.rows[0]!.id, 'el documento comercial recuerda qué facturó').toBe(presupuestoId);
    expect(origen.rows[0]!.status).toBe('FACTURADO');
  });
});
