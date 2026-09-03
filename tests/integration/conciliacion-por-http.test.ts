/**
 * La conciliación bancaria, por el camino que antes no existía.
 *
 * ## Qué encontró la auditoría de selectores
 *
 * La consola pedía el identificador de la conciliación con un `prompt`, y ese
 * identificador **no se podía conseguir**: `bank_reconciliations` no tenía ni un
 * solo `INSERT` en toda la aplicación —ni ruta, ni trigger—. Se podían proponer
 * coincidencias y confirmarlas, pero no había forma de crear la conciliación
 * que las sostiene. El test de la fase la insertaba por SQL directo, así que el
 * hueco no aparecía.
 *
 * Un campo que pide un uuid sin decir de dónde sacarlo casi siempre está
 * tapando que no hay de dónde.
 *
 * ## Qué defiende este archivo
 *
 *   1. **Que la conciliación se pueda abrir por HTTP.**
 *   2. **Que el saldo del libro no se declare**: sale del Mayor.
 *   3. **Que el acta no cierre sola**: confirmar con diferencia se rechaza.
 *   4. **Que no haya dos actas del mismo período.**
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

interface Verificacion {
  estado: string;
  verificable: boolean;
  /** `null` cuando no hay extracto contra el cual rehacer la cuenta. */
  coincide: boolean | null;
  detalle: string;
  guardado: { saldoExtracto: string; saldoLibro: string; ajusteNeto: string };
  recalculado: { saldoConciliado: string; saldoSegunLibro: string; cierra: boolean } | null;
  partidasConciliatorias: { enBancoNoEnLibro: string; enLibroNoEnBanco: string } | null;
  alcance: string;
}

suite('Conciliación bancaria por HTTP', () => {
  let app: FastifyInstance;
  let db: Client;
  let stamp: string;
  let token: string;
  let empresa: string;
  let cuentaCierra: string;
  let cuentaNoCierra: string;
  let anio: number;
  let desde: string;
  let hasta: string;

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

    anio = new Date().getUTCFullYear();
    desde = `${anio}-01-01`;
    // El corte es hoy: tiene que caer dentro de un período abierto.
    hasta = new Date().toISOString().slice(0, 10);

    const { hash: argonHash } = await import('@node-rs/argon2');
    const fundadorId = (
      await db.query<{ id: string }>(
        'INSERT INTO users (email, full_name, password_hash) VALUES ($1,$2,$3) RETURNING id',
        [
          `fundador-conc-${stamp}@estudio.test`,
          'Fundador',
          await argonHash(PASSWORD, { algorithm: 2, memoryCost: 19_456, timeCost: 2, parallelism: 1 }),
        ],
      )
    ).rows[0]!.id;

    const organizationId = (
      await db.query<{ create_organization: string }>('SELECT create_organization($1,$2,$3)', [
        `Estudio conc ${stamp}`, withCheckDigit(`30${stamp}`), fundadorId,
      ])
    ).rows[0]!.create_organization;

    empresa = (
      await db.query<{ create_company: string }>('SELECT create_company($1,$2,$3,$4,$5,$6,$7,$8)', [
        fundadorId, organizationId, `Empresa conc ${stamp}`, withCheckDigit(`27${stamp}`),
        'SA', 'AR-C', 'IGJ', '12-31',
      ])
    ).rows[0]!.create_company;

    const tokenFundador = (
      await app.inject({
        method: 'POST',
        url: '/auth/login',
        payload: { email: `fundador-conc-${stamp}@estudio.test`, password: PASSWORD },
      })
    ).json<{ token: string }>().token;

    const email = `contadora-conc-${stamp}@estudio.test`;
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

    expect(
      (await pedir('POST', '/fiscal-years', {
        code: `EJ${anio}-${stamp}`, startDate: `${anio}-01-01`, endDate: `${anio}-12-31`,
      })).statusCode,
    ).toBe(201);

    for (const cuenta of [
      { code: '1.1.03', name: 'Banco que cierra', type: 'ACTIVO' },
      { code: '1.1.04', name: 'Banco que no cierra', type: 'ACTIVO' },
      { code: '4.1.01', name: 'Ventas', type: 'INGRESO' },
    ]) {
      expect((await pedir('POST', '/accounts', cuenta)).statusCode, cuenta.code).toBe(201);
    }

    // El alta de cuentas bancarias por HTTP no existe todavía, y este archivo
    // prueba la conciliación y no el alta. Se insertan directo, igual que hace
    // la suite de cheques.
    for (const [codigo, destino] of [['1.1.03', 'cierra'], ['1.1.04', 'no cierra']] as const) {
      const cuenta = await db.query<{ id: string }>(
        'SELECT id FROM accounts WHERE company_id = $1 AND code = $2',
        [empresa, codigo],
      );
      const banco = await db.query<{ id: string }>(
        `INSERT INTO bank_accounts (company_id, account_id, bank_name)
         VALUES ($1,$2,$3) RETURNING id`,
        [empresa, cuenta.rows[0]!.id, `Banco ${destino} ${stamp}`],
      );
      if (codigo === '1.1.03') cuentaCierra = banco.rows[0]!.id;
      else cuentaNoCierra = banco.rows[0]!.id;
    }

    // Un movimiento real en el Mayor: la cuenta que cierra queda en 1.000.
    const alta = await pedir('POST', '/journal-entries', {
      journalCode: 'GENERAL',
      entryDate: hasta,
      description: 'Cobranza acreditada',
      currency: 'ARS',
      lines: [
        { accountCode: '1.1.03', debit: '1000.00', credit: '0' },
        { accountCode: '4.1.01', debit: '0', credit: '1000.00' },
      ],
      source: { type: 'MANUAL', id: null },
      manualJustification: 'Cobranza registrada por la contadora',
    });
    expect(alta.statusCode, alta.body).toBe(201);
    expect(
      (await pedir('POST', `/journal-entries/${alta.json<{ id: string }>().id}/approve`))
        .statusCode,
    ).toBe(200);

    // El extracto del banco, importado por el camino real. Hace falta para que
    // la verificación tenga contra qué rehacer la cuenta: sin el lado del banco
    // no se puede distinguir una partida conciliatoria de un extracto que nadie
    // importó. El alta del mapeo todavía no existe por HTTP, así que va por SQL
    // (igual que la cuenta bancaria, y por el mismo motivo).
    const layoutId = (
      await db.query<{ id: string }>(
        `INSERT INTO bank_statement_layouts
           (company_id, bank_account_id, nombre, filas_encabezado, columna_fecha,
            columna_descripcion, esquema_signo, columna_debito, columna_credito,
            formato_fecha, formato_importe, separador, created_by)
         VALUES ($1, $2, 'Extracto de prueba', 1, 0, 1, 'COLUMNAS_SEPARADAS', 2, 3,
                 'AAAA-MM-DD', 'ES_AR', ';', 'tester')
         RETURNING id`,
        [empresa, cuentaCierra],
      )
    ).rows[0]!.id;

    const extracto = await pedir('POST', `/banks/accounts/${cuentaCierra}/statements`, {
      layoutId,
      desde,
      hasta,
      saldoInicial: '0',
      saldoFinal: '1000.00',
      contenido: ['Fecha;Descripcion;Debito;Credito', `${hasta};COBRANZA ACREDITADA;;1.000,00`].join('\n'),
    });
    expect(extracto.statusCode, extracto.body).toBe(201);
    expect(extracto.json<{ movimientos: number }>().movimientos).toBe(1);
  }, 60_000);

  afterAll(async () => {
    await app?.close();
    await db?.end();
    await closePool();
  });

  it('la conciliación se abre por HTTP, y el saldo del libro sale del Mayor', async () => {
    const r = await pedir('POST', `/banks/accounts/${cuentaCierra}/reconciliations`, {
      desde,
      hasta,
      saldoExtracto: '1000.00',
    });
    expect(r.statusCode, r.body).toBe(201);

    const c = r.json<{ reconciliationId: string; saldoLibro: string; alcance: string }>();
    // No se declaró: se derivó del asiento aprobado de arriba.
    expect(c.saldoLibro).toBe('1000.00');
    expect(c.alcance).toContain('no se declara');
    expect(c.reconciliationId).toBeTruthy();
  });

  it('la lista la muestra con su diferencia, que es el acta', async () => {
    const r = await pedir('GET', '/banks/reconciliations');
    expect(r.statusCode).toBe(200);
    const lista = r.json<{
      conciliaciones: { status: string; saldoLibro: string; diferencia: string;
                        coincidencias: number }[];
    }>().conciliaciones;

    expect(lista).toHaveLength(1);
    expect(lista[0]!.status).toBe('BORRADOR');
    expect(lista[0]!.saldoLibro).toBe('1000.00');
    // Extracto 1.000 + ajustes 0 − libro 1.000 = 0: el acta cierra.
    expect(Number(lista[0]!.diferencia)).toBe(0);
    expect(lista[0]!.coincidencias).toBe(0);
  });

  it('no hay dos actas del mismo período para la misma cuenta', async () => {
    const r = await pedir('POST', `/banks/accounts/${cuentaCierra}/reconciliations`, {
      desde, hasta, saldoExtracto: '1000.00',
    });
    // Dos actas confirmadas del mismo mes son dos verdades sobre el mismo saldo.
    expect(r.statusCode).toBe(409);
    expect(r.json<{ message: string }>().message).toContain('dos verdades');
  });

  it('un acta que no cierra no se confirma', async () => {
    // La otra cuenta no tiene movimientos: el libro está en cero y el extracto
    // dice 900. La diferencia es real y la base no deja confirmarla.
    const abierta = await pedir('POST', `/banks/accounts/${cuentaNoCierra}/reconciliations`, {
      desde, hasta, saldoExtracto: '900.00',
    });
    expect(abierta.statusCode, abierta.body).toBe(201);
    expect(abierta.json<{ saldoLibro: string }>().saldoLibro).toBe('0');

    const id = abierta.json<{ reconciliationId: string }>().reconciliationId;
    const confirmar = await pedir('POST', `/banks/reconciliations/${id}/confirm`);
    expect(confirmar.statusCode, confirmar.body).toBe(409);

    // Y sigue en borrador: un intento fallido no deja el acta a medio confirmar.
    const estado = await db.query<{ status: string }>(
      'SELECT status FROM bank_reconciliations WHERE id = $1',
      [id],
    );
    expect(estado.rows[0]!.status).toBe('BORRADOR');
  });

  it('el acta que cierra se confirma, y queda firmada', async () => {
    const lista = (await pedir('GET', '/banks/reconciliations?status=BORRADOR'))
      .json<{ conciliaciones: { id: string; diferencia: string }[] }>().conciliaciones;
    const cierra = lista.find((c) => Number(c.diferencia) === 0)!;

    expect((await pedir('POST', `/banks/reconciliations/${cierra.id}/confirm`)).statusCode)
      .toBe(200);

    const fila = await db.query<{ status: string; confirmed_by: string | null }>(
      'SELECT status, confirmed_by FROM bank_reconciliations WHERE id = $1',
      [cierra.id],
    );
    expect(fila.rows[0]!.status).toBe('CONFIRMADA');
    // Sin firma no hay confirmación: lo exige un CHECK desde la 0022.
    expect(fila.rows[0]!.confirmed_by).not.toBeNull();
  });

  /**
   * La verificación de una conciliación confirmada.
   *
   * `verificarActa` estaba escrita en `@aai/bank-engine` y **no la llamaba
   * nadie** — la encontró el barrido S-16. Una conciliación guardada es un dato
   * derivado, y un derivado que nadie vuelve a verificar se desincroniza en
   * silencio: alcanza con un asiento nuevo en el período.
   */
  it('una conciliación confirmada se puede volver a verificar', async () => {
    const confirmada = (await pedir('GET', '/banks/reconciliations?status=CONFIRMADA'))
      .json<{ conciliaciones: { id: string }[] }>().conciliaciones[0];
    expect(confirmada, 'el test anterior dejó una confirmada').toBeDefined();

    const r = await pedir('GET', `/banks/reconciliations/${confirmada!.id}/verificar`);
    expect(r.statusCode, r.body).toBe(200);

    const v = r.json<Verificacion>();

    expect(v.estado).toBe('CONFIRMADA');
    expect(v.verificable, 'el extracto del período está importado').toBe(true);
    // Nada cambió desde que se confirmó: la cuenta rehecha da lo mismo.
    expect(v.coincide, v.detalle).toBe(true);
    expect(v.recalculado!.saldoConciliado).toBe(v.guardado.saldoLibro);
    // El movimiento del extracto casó con la línea del Mayor: no queda nada
    // suelto de ningún lado.
    expect(Number(v.partidasConciliatorias!.enBancoNoEnLibro)).toBe(0);
    expect(Number(v.partidasConciliatorias!.enLibroNoEnBanco)).toBe(0);
    expect(v.alcance).toContain('algo cambió después');
  });

  /**
   * El caso que la verificación **no** puede juzgar.
   *
   * La cuenta que no cierra nunca recibió un extracto. Rehacer la cuenta ahí
   * daría "no coincide" siempre —sin el lado del banco, cada línea del Mayor
   * parece una partida conciliatoria—, y eso sería acusar un cambio que no
   * ocurrió. La respuesta correcta es que no se puede afirmar.
   */
  it('sin extracto importado la verificación dice que no se puede verificar', async () => {
    const borrador = (await pedir('GET', '/banks/reconciliations?status=BORRADOR'))
      .json<{ conciliaciones: { id: string; cuentaId: string }[] }>()
      .conciliaciones.find((c) => c.cuentaId === cuentaNoCierra);
    expect(borrador, 'la cuenta que no cierra dejó un acta en borrador').toBeDefined();

    const v = (await pedir('GET', `/banks/reconciliations/${borrador!.id}/verificar`))
      .json<Verificacion>();

    expect(v.verificable).toBe(false);
    // Ni `true` ni `false`: no hay con qué decirlo.
    expect(v.coincide).toBeNull();
    expect(v.detalle).toContain('no se puede verificar');
    // Y no se muestran partidas conciliatorias inventadas por la falta de datos.
    expect(v.recalculado).toBeNull();
    expect(v.partidasConciliatorias).toBeNull();
  });

  it('un asiento nuevo en el período hace que la verificación no coincida', async () => {
    // Es el caso que la verificación existe para detectar: la conciliación
    // guardada sigue diciendo lo de ayer, y el libro ya no dice lo mismo.
    const confirmada = (await pedir('GET', '/banks/reconciliations?status=CONFIRMADA'))
      .json<{ conciliaciones: { id: string }[] }>().conciliaciones[0]!;

    const antes = await pedir('GET', `/banks/reconciliations/${confirmada.id}/verificar`);
    expect(antes.json<Verificacion>().coincide).toBe(true);

    const alta = await pedir('POST', '/journal-entries', {
      journalCode: 'GENERAL',
      entryDate: `${anio}-01-15`,
      description: 'Movimiento posterior a la conciliación',
      currency: 'ARS',
      lines: [
        { accountCode: '1.1.03', debit: '1500.00', credit: '0' },
        { accountCode: '4.1.01', debit: '0', credit: '1500.00' },
      ],
      source: { type: 'MANUAL', id: null },
      manualJustification: 'Asiento cargado después de confirmar la conciliación',
    });
    expect(alta.statusCode, alta.body).toBe(201);
    expect(
      (await pedir('POST', `/journal-entries/${alta.json<{ id: string }>().id}/approve`)).statusCode,
    ).toBe(200);

    const despues = await pedir('GET', `/banks/reconciliations/${confirmada.id}/verificar`);
    const v = despues.json<{ coincide: boolean; detalle: string }>();
    expect(v.coincide, 'el libro cambió: la conciliación guardada ya no lo refleja').toBe(false);
    expect(v.detalle).toContain('Algo cambió después de confirmarla');
  });

  it('sin período que contenga la fecha de corte, no se abre', async () => {
    const r = await pedir('POST', `/banks/accounts/${cuentaCierra}/reconciliations`, {
      desde: `${anio - 5}-01-01`,
      hasta: `${anio - 5}-01-31`,
      saldoExtracto: '0',
    });
    expect(r.statusCode).toBe(409);
    expect(r.json<{ message: string }>().message).toContain('período');
  });
});
