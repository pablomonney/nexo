/**
 * Cheques propios y de terceros.
 *
 * Lo que este archivo defiende, en orden de importancia:
 *
 *   1. **Que el estado no se pueda escribir.** No hay endpoint que lo fije: se
 *      registra el hecho y el estado se deriva del último movimiento. Un estado
 *      escribible permitiría decir «acreditado» sin que existiera el cobro, y
 *      ahí la cartera pasa a ser una opinión.
 *   2. **Que la máquina de estados viva en la base.** Depositar un cheque ya
 *      acreditado tiene que ser imposible por cualquier camino, no solo por el
 *      que pasa por la API.
 *   3. **Que el libro sea inmutable.** Deshacer es un movimiento nuevo.
 *   4. **Que el módulo no toque el Mayor.** Cargar un cheque no crea ningún
 *      asiento, y la bandeja avisa mientras no cite uno.
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

suite('Cheques', () => {
  let app: FastifyInstance;
  let db: Client;
  let stamp: string;
  let token: string;
  let empresa: string;
  let clienteId: string;
  let proveedorId: string;
  let cuentaBancaria: string;
  let numero = 40000;

  const pedir = (method: 'GET' | 'POST' | 'PUT', url: string, payload?: unknown) =>
    app.inject({
      method,
      url,
      headers: { authorization: `Bearer ${token}`, 'x-company-id': empresa },
      ...(payload === undefined ? {} : { payload }),
    });

  const enDias = (dias: number): string => {
    const d = new Date();
    d.setUTCDate(d.getUTCDate() + dias);
    return d.toISOString().slice(0, 10);
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
          `fundador-chq-${stamp}@estudio.test`,
          'Fundador',
          await argonHash(PASSWORD, { algorithm: 2, memoryCost: 19_456, timeCost: 2, parallelism: 1 }),
        ],
      )
    ).rows[0]!.id;

    const organizationId = (
      await db.query<{ create_organization: string }>('SELECT create_organization($1,$2,$3)', [
        `Estudio chq ${stamp}`, withCheckDigit(`30${stamp}`), fundadorId,
      ])
    ).rows[0]!.create_organization;

    empresa = (
      await db.query<{ create_company: string }>('SELECT create_company($1,$2,$3,$4,$5,$6,$7,$8)', [
        fundadorId, organizationId, `Empresa chq ${stamp}`, withCheckDigit(`27${stamp}`),
        'SA', 'AR-C', 'IGJ', '12-31',
      ])
    ).rows[0]!.create_company;

    const tokenFundador = (
      await app.inject({
        method: 'POST',
        url: '/auth/login',
        payload: { email: `fundador-chq-${stamp}@estudio.test`, password: PASSWORD },
      })
    ).json<{ token: string }>().token;

    const email = `contadora-chq-${stamp}@estudio.test`;
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

    clienteId = (
      await pedir('POST', '/parties', {
        tipoDocumento: 'CUIT',
        numeroDocumento: `30${stamp}${cuitCheckDigit(`30${stamp}`)}`,
        razonSocial: `Cliente chq ${stamp}`,
        roles: ['CLIENTE'],
      })
    ).json<{ id: string }>().id;

    proveedorId = (
      await pedir('POST', '/parties', {
        tipoDocumento: 'CUIT',
        numeroDocumento: `33${stamp}${cuitCheckDigit(`33${stamp}`)}`,
        razonSocial: `Proveedor chq ${stamp}`,
        roles: ['PROVEEDOR'],
      })
    ).json<{ id: string }>().id;

    // El ejercicio hace falta por dos motivos distintos: sin período no se
    // puede asentar, y la señal de rechazos se ancla en el ejercicio —como la
    // mora— porque es de toda la empresa y no de un cheque.
    const anio = new Date().getUTCFullYear();
    expect(
      (await pedir('POST', '/fiscal-years', {
        code: `EJ${anio}-${stamp}`,
        startDate: `${anio}-01-01`,
        endDate: `${anio}-12-31`,
      })).statusCode,
    ).toBe(201);

    // La cuenta contable por la API, que resuelve el plan; la cuenta bancaria
    // directo, porque su alta por HTTP no existe todavía y este archivo prueba
    // cheques, no bancos.
    expect(
      (await pedir('POST', '/accounts', { code: '1.1.03', name: 'Banco', type: 'ACTIVO' }))
        .statusCode,
    ).toBe(201);
    const cuenta = await db.query<{ id: string }>(
      'SELECT id FROM accounts WHERE company_id = $1 AND code = $2',
      [empresa, '1.1.03'],
    );
    cuentaBancaria = (
      await db.query<{ id: string }>(
        `INSERT INTO bank_accounts (company_id, account_id, bank_name)
         VALUES ($1,$2,'Banco de prueba') RETURNING id`,
        [empresa, cuenta.rows[0]!.id],
      )
    ).rows[0]!.id;
  }, 60_000);

  afterAll(async () => {
    await app?.close();
    await db?.end();
    await closePool();
  });

  /** Un cheque de tercero cargado y recibido, listo para operar. */
  async function chequeRecibido(importe: string, fechaPago: string): Promise<string> {
    numero += 1;
    const alta = await pedir('POST', '/checks', {
      tipo: 'RECIBIDO',
      numero: String(numero),
      banco: 'Banco Nación',
      importe,
      fechaEmision: enDias(-5),
      fechaPago,
      terceroId: clienteId,
    });
    expect(alta.statusCode, alta.body).toBe(201);
    const id = alta.json<{ id: string }>().id;

    expect(
      (await pedir('POST', `/checks/${id}/movimientos`, {
        tipo: 'RECIBIDO',
        fecha: enDias(-5),
      })).statusCode,
    ).toBe(201);
    return id;
  }

  it('cargar un cheque no lo pone en circulación ni toca el Mayor', async () => {
    const asientosAntes = await db.query<{ n: string }>(
      'SELECT count(*)::text AS n FROM journal_entries WHERE company_id = $1',
      [empresa],
    );

    numero += 1;
    const alta = await pedir('POST', '/checks', {
      tipo: 'RECIBIDO',
      numero: String(numero),
      banco: 'Banco Galicia',
      importe: '1000.00',
      fechaEmision: enDias(-1),
      fechaPago: enDias(30),
      terceroId: clienteId,
    });
    expect(alta.statusCode, alta.body).toBe(201);

    const detalle = await pedir('GET', `/checks/${alta.json<{ id: string }>().id}`);
    expect(detalle.json<{ cheque: { estado: string } }>().cheque.estado)
      .toBe('SIN_MOVIMIENTOS');

    const asientosDespues = await db.query<{ n: string }>(
      'SELECT count(*)::text AS n FROM journal_entries WHERE company_id = $1',
      [empresa],
    );
    expect(asientosDespues.rows[0]!.n, 'el módulo no escribe en el Mayor')
      .toBe(asientosAntes.rows[0]!.n);
  });

  it('el mismo banco no emite dos veces el mismo número', async () => {
    numero += 1;
    const cuerpo = {
      tipo: 'RECIBIDO' as const,
      numero: String(numero),
      banco: 'Banco Provincia',
      importe: '500.00',
      fechaEmision: enDias(-1),
      fechaPago: enDias(10),
      terceroId: clienteId,
    };
    expect((await pedir('POST', '/checks', cuerpo)).statusCode).toBe(201);

    const repetido = await pedir('POST', '/checks', cuerpo);
    expect(repetido.statusCode, repetido.body).toBe(409);
    expect(repetido.json<{ message: string }>().message).toContain('duplicaría');
  });

  it('un cheque propio exige cuenta bancaria y uno de tercero no la admite', async () => {
    numero += 1;
    const sinCuenta = await pedir('POST', '/checks', {
      tipo: 'EMITIDO',
      numero: String(numero),
      banco: 'Banco Nación',
      importe: '100.00',
      fechaEmision: enDias(0),
      fechaPago: enDias(0),
      terceroId: proveedorId,
    });
    expect(sinCuenta.statusCode, sinCuenta.body).toBe(422);
    expect(sinCuenta.json<{ error: string }>().error).toBe('CUENTA_INCOHERENTE');

    numero += 1;
    const terceroConCuenta = await pedir('POST', '/checks', {
      tipo: 'RECIBIDO',
      numero: String(numero),
      banco: 'Banco Nación',
      importe: '100.00',
      fechaEmision: enDias(0),
      fechaPago: enDias(0),
      terceroId: clienteId,
      cuentaBancariaId: cuentaBancaria,
    });
    expect(terceroConCuenta.statusCode, terceroConCuenta.body).toBe(422);
  });

  it('la fecha de pago no puede ser anterior a la de emisión', async () => {
    numero += 1;
    const r = await pedir('POST', '/checks', {
      tipo: 'RECIBIDO',
      numero: String(numero),
      banco: 'Banco Nación',
      importe: '100.00',
      fechaEmision: enDias(0),
      fechaPago: enDias(-10),
      terceroId: clienteId,
    });

    expect(r.statusCode, r.body).toBe(422);
    expect(r.json<{ error: string }>().error).toBe('FECHA_DE_PAGO_ANTERIOR');
  });

  it('el estado sale del último movimiento y no de una columna', async () => {
    const id = await chequeRecibido('2500.00', enDias(20));

    expect(
      (await pedir('GET', `/checks/${id}`)).json<{ cheque: { estado: string; enCartera: boolean } }>()
        .cheque,
    ).toMatchObject({ estado: 'RECIBIDO', enCartera: true });

    expect(
      (await pedir('POST', `/checks/${id}/movimientos`, {
        tipo: 'DEPOSITADO',
        fecha: enDias(0),
        cuentaBancariaId: cuentaBancaria,
      })).statusCode,
    ).toBe(201);

    const despues = (await pedir('GET', `/checks/${id}`))
      .json<{ cheque: { estado: string; enCartera: boolean } }>().cheque;
    expect(despues.estado).toBe('DEPOSITADO');
    expect(despues.enCartera, 'depositado ya no está en la cartera').toBe(false);

    // Y no existe ninguna columna de estado que alguien pueda escribir.
    const columnas = await db.query<{ column_name: string }>(
      `SELECT column_name FROM information_schema.columns WHERE table_name = 'checks'`,
    );
    expect(columnas.rows.map((f) => f.column_name)).not.toContain('estado');
  });

  it('un cheque de tercero no puede empezar por otro movimiento que RECIBIDO', async () => {
    numero += 1;
    const id = (
      await pedir('POST', '/checks', {
        tipo: 'RECIBIDO',
        numero: String(numero),
        banco: 'Banco Nación',
        importe: '300.00',
        fechaEmision: enDias(-1),
        fechaPago: enDias(5),
        terceroId: clienteId,
      })
    ).json<{ id: string }>().id;

    const r = await pedir('POST', `/checks/${id}/movimientos`, {
      tipo: 'DEPOSITADO',
      fecha: enDias(0),
      cuentaBancariaId: cuentaBancaria,
    });

    expect(r.statusCode, r.body).toBe(422);
    expect(r.json<{ error: string }>().error).toBe('PRIMER_MOVIMIENTO_INVALIDO');
  });

  it('lo que ya terminó no vuelve a moverse', async () => {
    const id = await chequeRecibido('700.00', enDias(-2));
    for (const mov of [
      { tipo: 'DEPOSITADO', fecha: enDias(-1), cuentaBancariaId: cuentaBancaria },
      { tipo: 'ACREDITADO', fecha: enDias(0) },
    ]) {
      expect((await pedir('POST', `/checks/${id}/movimientos`, mov)).statusCode).toBe(201);
    }

    const r = await pedir('POST', `/checks/${id}/movimientos`, {
      tipo: 'DEPOSITADO',
      fecha: enDias(0),
      cuentaBancariaId: cuentaBancaria,
    });

    expect(r.statusCode, r.body).toBe(422);
    expect(r.json<{ error: string }>().error).toBe('CHEQUE_CERRADO');
  });

  it('un rechazado vuelve a la cartera y se puede volver a depositar', async () => {
    // Es lo que pasa de verdad: el cheque rebota, se reclama, y se vuelve a
    // presentar. Tratarlo como terminal obligaría a cargar un cheque nuevo con
    // el mismo número, que el índice de idempotencia —bien— rechaza.
    const id = await chequeRecibido('900.00', enDias(-3));
    for (const mov of [
      { tipo: 'DEPOSITADO', fecha: enDias(-2), cuentaBancariaId: cuentaBancaria },
      { tipo: 'RECHAZADO', fecha: enDias(-1), motivo: 'Sin fondos suficientes' },
    ]) {
      expect((await pedir('POST', `/checks/${id}/movimientos`, mov)).statusCode).toBe(201);
    }

    const enCartera = (await pedir('GET', `/checks/${id}`))
      .json<{ cheque: { estado: string; enCartera: boolean } }>().cheque;
    expect(enCartera.estado).toBe('RECHAZADO');
    expect(enCartera.enCartera, 'volvió a estar en poder de la empresa').toBe(true);

    expect(
      (await pedir('POST', `/checks/${id}/movimientos`, {
        tipo: 'DEPOSITADO',
        fecha: enDias(0),
        cuentaBancariaId: cuentaBancaria,
      })).statusCode,
    ).toBe(201);
  });

  it('un rechazo sin motivo no se registra', async () => {
    const id = await chequeRecibido('120.00', enDias(3));
    const r = await pedir('POST', `/checks/${id}/movimientos`, {
      tipo: 'RECHAZADO',
      fecha: enDias(0),
    });

    // Un cobro que no ocurrió y nadie explicó por qué no se puede reclamar.
    expect(r.statusCode, r.body).toBeGreaterThanOrEqual(400);
  });

  it('depositar exige la cuenta y endosar exige el destinatario', async () => {
    const sinCuenta = await chequeRecibido('310.00', enDias(4));
    const a = await pedir('POST', `/checks/${sinCuenta}/movimientos`, {
      tipo: 'DEPOSITADO',
      fecha: enDias(0),
    });
    expect(a.json<{ error: string }>().error).toBe('DEPOSITO_SIN_CUENTA');

    const sinDestino = await chequeRecibido('320.00', enDias(4));
    const b = await pedir('POST', `/checks/${sinDestino}/movimientos`, {
      tipo: 'ENDOSADO',
      fecha: enDias(0),
    });
    expect(b.json<{ error: string }>().error).toBe('ENDOSO_SIN_DESTINATARIO');
  });

  it('endosar a un proveedor lo saca de la cartera', async () => {
    const id = await chequeRecibido('1400.00', enDias(45));
    expect(
      (await pedir('POST', `/checks/${id}/movimientos`, {
        tipo: 'ENDOSADO',
        fecha: enDias(0),
        terceroId: proveedorId,
      })).statusCode,
    ).toBe(201);

    const c = (await pedir('GET', `/checks/${id}`))
      .json<{ cheque: { estado: string; enCartera: boolean } }>().cheque;
    expect(c.estado).toBe('ENDOSADO');
    expect(c.enCartera, 'ya no es de esta empresa').toBe(false);
  });

  it('el libro de movimientos no se edita ni se borra', async () => {
    const id = await chequeRecibido('160.00', enDias(6));
    const mov = await db.query<{ id: string }>(
      'SELECT id FROM check_movements WHERE check_id = $1 LIMIT 1',
      [id],
    );

    await expect(
      db.query(`UPDATE check_movements SET motivo = 'editado' WHERE id = $1`, [mov.rows[0]!.id]),
    ).rejects.toThrow();
    await expect(
      db.query('DELETE FROM check_movements WHERE id = $1', [mov.rows[0]!.id]),
    ).rejects.toThrow();
  });

  it('la cartera reparte por tramo de fecha de pago', async () => {
    const antes = (await pedir('GET', '/checks/flujo'))
      .json<{ cartera: Record<string, string> | null }>().cartera;
    const base = (clave: string): number => Number(antes?.[clave] ?? 0);

    await chequeRecibido('111.00', enDias(-1));
    await chequeRecibido('222.00', enDias(15));
    await chequeRecibido('333.00', enDias(45));
    await chequeRecibido('444.00', enDias(90));

    const r = await pedir('GET', '/checks/flujo');
    const c = r.json<{ cartera: Record<string, string>; alcance: string }>();

    expect(Number(c.cartera['alDiaDeHoy']) - base('alDiaDeHoy')).toBe(111);
    expect(Number(c.cartera['proximos30']) - base('proximos30')).toBe(222);
    expect(Number(c.cartera['de31a60']) - base('de31a60')).toBe(333);
    expect(Number(c.cartera['masDe60']) - base('masDe60')).toBe(444);
    // No se suma a la proyección de cobranzas: contaría la misma plata dos veces.
    expect(c.alcance).toContain('dos veces');
  });

  it('un cheque cobrable y sin depositar aparece en la bandeja', async () => {
    const id = await chequeRecibido('555.00', enDias(-4));

    const items = (await pedir('GET', '/work-queue?limite=200'))
      .json<{ items: { rama: string; entityId: string; fechaLimite: string }[] }>().items;
    const aviso = items.find(
      (i) => i.rama === 'CHEQUE_COBRABLE_SIN_DEPOSITAR' && i.entityId === id,
    );

    expect(aviso, 'la fecha de pago pasó y sigue en cartera').toBeDefined();
    expect(aviso!.fechaLimite).toBe(enDias(-4));
  });

  it('un cheque sin asiento aparece en la bandeja: no está en el Mayor', async () => {
    const id = await chequeRecibido('666.00', enDias(25));

    const items = (await pedir('GET', '/work-queue?limite=200'))
      .json<{ items: { rama: string; entityId: string; evidenciaFaltante: string[] }[] }>().items;
    const aviso = items.find((i) => i.rama === 'CHEQUE_SIN_ASIENTO' && i.entityId === id);

    expect(aviso).toBeDefined();
    expect(aviso!.evidenciaFaltante).toContain('ASIENTO');
  });

  // -------------------------------------------------------------------------
  // La capa de decisión (ADR-018)
  // -------------------------------------------------------------------------
  it('un cheque sin asiento no suma al flujo de fondos, y se dice por qué', async () => {
    // Es la condición precisa del doble conteo: sin asiento, el crédito que lo
    // originó sigue figurando pendiente, así que sumarlo contaría lo mismo dos
    // veces. No se decide por opción: sale de un hecho de la base.
    const antes = (await pedir('GET', '/analysis/flujo-de-fondos'))
      .json<{ consolidado: { sentido: string; total: string; noSumable: string }[] }>()
      .consolidado.find((c) => c.sentido === 'ENTRA') ?? { total: '0', noSumable: '0' };

    await chequeRecibido('777.00', enDias(10));

    const r = await pedir('GET', '/analysis/flujo-de-fondos');
    expect(r.statusCode, r.body).toBe(200);
    const cuerpo = r.json<{
      consolidado: { sentido: string; total: string; noSumable: string }[];
      porFuente: { fuente: string; noSumable: string; motivoNoSumable: string | null }[];
      alcance: string;
    }>();
    const entra = cuerpo.consolidado.find((c) => c.sentido === 'ENTRA')!;

    expect(
      Number(entra.total) - Number(antes.total),
      'sin asiento no entra al total',
    ).toBe(0);
    expect(
      Number(entra.noSumable) - Number(antes.noSumable),
      'pero se informa aparte, no se omite',
    ).toBe(777);

    const cheques = cuerpo.porFuente.find((f) => f.fuente === 'CHEQUES')!;
    expect(cheques.motivoNoSumable, 'con su motivo al lado').toContain('dos veces');
    expect(cuerpo.alcance).toContain('no un pronóstico');
  });

  it('con asiento citado, el mismo cheque sí suma', async () => {
    const antes = (await pedir('GET', '/analysis/flujo-de-fondos'))
      .json<{ consolidado: { sentido: string; total: string; noSumable: string }[] }>()
      .consolidado.find((c) => c.sentido === 'ENTRA') ?? { total: '0', noSumable: '0' };

    // Un asiento cualquiera aprobado: lo que importa es que el cheque lo cite,
    // porque eso significa que el cobro llegó al Mayor.
    const asiento = await pedir('POST', '/journal-entries', {
      journalCode: 'GENERAL',
      entryDate: enDias(0),
      description: 'Valores a depositar',
      currency: 'ARS',
      lines: [
        { accountCode: '1.1.03', debit: '888.00', credit: '0' },
        { accountCode: '1.1.03', debit: '0', credit: '888.00' },
      ],
      source: { type: 'MANUAL', id: null },
      manualJustification: 'Registro del cheque recibido',
    });
    expect(asiento.statusCode, asiento.body).toBe(201);
    const asientoId = asiento.json<{ id: string }>().id;
    expect((await pedir('POST', `/journal-entries/${asientoId}/approve`)).statusCode).toBe(200);

    numero += 1;
    const id = (
      await pedir('POST', '/checks', {
        tipo: 'RECIBIDO',
        numero: String(numero),
        banco: 'Banco Ciudad',
        importe: '888.00',
        fechaEmision: enDias(-1),
        fechaPago: enDias(12),
        terceroId: clienteId,
        asientoId,
      })
    ).json<{ id: string }>().id;
    expect(
      (await pedir('POST', `/checks/${id}/movimientos`, { tipo: 'RECIBIDO', fecha: enDias(-1) }))
        .statusCode,
    ).toBe(201);

    const despues = (await pedir('GET', '/analysis/flujo-de-fondos'))
      .json<{ consolidado: { sentido: string; total: string; proximos30: string }[] }>()
      .consolidado.find((c) => c.sentido === 'ENTRA')!;

    expect(Number(despues.total) - Number(antes.total)).toBe(888);
    expect(Number(despues.proximos30) - Number(antes.proximos30)).toBe(888);
  });

  it('la señal de rechazos informa la proporción y no la juzga sin umbral', async () => {
    const r = await pedir('GET', '/analysis/signals');
    const senal = r.json<{
      senales: { tipo: string; valor: string; superaUmbral: boolean | null; metodologia: string }[];
    }>().senales.find((s) => s.tipo === 'RECHAZO_DE_CHEQUES');

    expect(senal, 'hay cheques recibidos: la señal existe').toBeDefined();
    expect(senal!.superaUmbral, 'sin umbral declarado no se afirma un desvío').toBeNull();
    expect(senal!.metodologia).toContain('riesgo de la cartera');
    expect(Number(senal!.valor), 'hubo al menos un rechazo en esta suite').toBeGreaterThan(0);
  });

  it('declarar el umbral enciende el desvío y lo manda a la bandeja', async () => {
    expect(
      (await pedir('PUT', '/analysis/thresholds', {
        caidaVentasPct: null,
        concentracionClientePct: null,
        diasClienteInactivo: null,
        moraPct: null,
        rechazoChequesPct: 1,
      })).statusCode,
      // Estricto: un `>= 200` deja pasar un 404, y este mismo test lo dejó pasar
      // cuando el método estaba mal. Un control laxo es un control apagado.
    ).toBe(200);

    const senal = (await pedir('GET', '/analysis/signals'))
      .json<{ senales: { tipo: string; superaUmbral: boolean | null }[] }>()
      .senales.find((s) => s.tipo === 'RECHAZO_DE_CHEQUES');
    expect(senal!.superaUmbral, 'ahora sí hay contra qué comparar').toBe(true);

    // Y la señal tiene que llegar a la bandeja. Es el paso que el renombre de
    // `analysis_signals` podía romper en silencio: la vista de la bandeja
    // resuelve por OID, no por nombre.
    const items = (await pedir('GET', '/work-queue?limite=200'))
      .json<{ items: { rama: string; estado: string; trazaRef: string }[] }>().items;
    const aviso = items.find(
      (i) => i.rama === 'DESVIO_DECLARADO' && i.estado === 'RECHAZO_DE_CHEQUES',
    );

    expect(aviso, 'el desvío declarado llega a la bandeja').toBeDefined();
    expect(aviso!.trazaRef, 'y lleva a la cartera, no al tablero general').toBe('/checks');
  });

  it('las vistas de cheques conservan security_invoker', async () => {
    const r = await db.query<{ relname: string; reloptions: string[] | null }>(
      `SELECT relname, reloptions FROM pg_class
        WHERE relname IN ('check_status', 'checks_en_cartera', 'work_queue_cheques')`,
    );
    expect(r.rowCount).toBe(3);
    for (const v of r.rows) {
      expect(v.reloptions, `${v.relname} sin security_invoker filtra entre empresas`)
        .toContain('security_invoker=true');
    }
  });
});
