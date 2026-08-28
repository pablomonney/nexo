/**
 * Estados contables de punta a punta: DIARIO → MAYOR → ESP / ER.
 *
 * `POST /statements/issue` **nunca se había ejercitado**. Los tests de estados
 * insertan las filas de `financial_statements` por SQL y los unitarios usan un
 * plan de cuentas hecho a medida de la plantilla, así que tres defectos
 * convivían sin que nada los tocara:
 *
 *   1. `CUENTA_SIN_RUBRO` evaluaba el plan entero y no lo que le corresponde al
 *      estado, de modo que un ESP marcaba como huérfana a toda cuenta de
 *      resultado con saldo;
 *   2. la ecuación patrimonial se declaraba en la ruta con códigos de nodo que
 *      la plantilla no tiene, y fallaba siempre;
 *   3. la cabecera se insertaba ya `EMITIDO` y el trigger de inmutabilidad
 *      rechazaba el primer renglón.
 *
 * Ninguno se ve leyendo el código. Los tres aparecen al llamar al endpoint.
 *
 * La afirmación que ordena el archivo: **el estado es el Mayor leído de otra
 * manera**. No que cuadre —cuadraba de a ratos— sino que cada cifra se pueda
 * seguir hasta los movimientos que la formaron, y que la suma coincida.
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

interface Estado {
  emisible: boolean;
  motivo: string;
  controles: { codigo: string; cumple: boolean; involucrados: string[]; detalle: string }[];
  clasificacion: { codigo: string; tipo: string; situacion: string; renglones: string[] }[];
  renglones: { codigo: string; importe: string; origen: { codigo: string; aporte: string }[] }[];
}

/**
 * Plan de cuentas del test. Sigue la convención de códigos de STATEMENTS.md
 * porque los selectores de la plantilla son por prefijo — con otra codificación
 * las cuentas quedarían fuera de todo renglón, que es un caso distinto y también
 * está probado.
 */
const PLAN = [
  { code: '1.1.01', name: 'Caja', type: 'ACTIVO' },
  { code: '1.1.03', name: 'Deudores por ventas', type: 'ACTIVO' },
  { code: '2.1.01', name: 'Proveedores', type: 'PASIVO' },
  { code: '3.1.01', name: 'Capital suscripto', type: 'PN' },
  { code: '3.4.01', name: 'Resultado del ejercicio', type: 'PN' },
  { code: '4.1.01', name: 'Ventas', type: 'INGRESO' },
  { code: '6.1.01', name: 'Gastos de administración', type: 'GASTO' },
  { code: '7.1.01', name: 'Documentos endosados', type: 'ORDEN' },
  { code: '7.2.01', name: 'Endosantes de documentos', type: 'ORDEN' },
];

suite('Estados contables sobre el Mayor', () => {
  let app: FastifyInstance;
  let db: Client;
  let token: string;
  let empresaA: string;
  let empresaB: string;
  let ejercicioA: string;
  const cuentas: Record<string, string> = {};
  let sinAprobar: string;

  const cab = (empresa: string) => ({
    authorization: `Bearer ${token}`,
    'x-company-id': empresa,
  });

  const pedir = (empresa: string, method: 'GET' | 'POST' | 'PATCH', url: string, payload?: unknown) =>
    app.inject({
      method,
      url,
      headers: cab(empresa),
      ...(payload === undefined ? {} : { payload }),
    });

  async function asiento(
    empresa: string,
    fecha: string,
    descripcion: string,
    lineas: { accountCode: string; debit?: string; credit?: string }[],
    opciones: { aprobar?: boolean } = {},
  ): Promise<string> {
    const alta = await pedir(empresa, 'POST', '/journal-entries', {
      journalCode: 'GENERAL',
      entryDate: fecha,
      description: descripcion,
      currency: 'ARS',
      lines: lineas.map((l) => ({
        accountCode: l.accountCode,
        debit: l.debit ?? '0',
        credit: l.credit ?? '0',
      })),
      source: { type: 'MANUAL', id: null },
      manualJustification: `Registrado por la contadora: ${descripcion}`,
    });
    expect(alta.statusCode, alta.body).toBe(201);
    const id = alta.json<{ id: string }>().id;
    if (opciones.aprobar !== false) {
      const ok = await pedir(empresa, 'POST', `/journal-entries/${id}/approve`);
      expect(ok.statusCode, ok.body).toBe(200);
    }
    return id;
  }

  async function estado(empresa: string, tipo: 'ESP' | 'ER', ejercicio: string): Promise<Estado> {
    const r = await pedir(empresa, 'GET', `/statements?ejercicio=${ejercicio}&tipo=${tipo}`);
    expect(r.statusCode, r.body).toBe(200);
    return r.json<Estado>();
  }

  const renglon = (e: Estado, codigo: string) => e.renglones.find((x) => x.codigo === codigo);
  const control = (e: Estado, codigo: string) => e.controles.find((x) => x.codigo === codigo);
  const clasif = (e: Estado, codigo: string) => e.clasificacion.find((x) => x.codigo === codigo);
  const centavos = (decimal: string) => BigInt(decimal.replace('.', ''));

  beforeAll(async () => {
    initPool(process.env.DATABASE_URL!);
    app = await buildServer();
    await app.ready();
    db = await connect();

    const stamp = await sufijoUnico(db);
    const email = `contadora-estados-${stamp}@estudio.test`;
    const { hash: argonHash } = await import('@node-rs/argon2');
    const hash = await argonHash(PASSWORD, {
      algorithm: 2, memoryCost: 19_456, timeCost: 2, parallelism: 1,
    });
    const usuario = await db.query<{ id: string }>(
      'INSERT INTO users (email, full_name, password_hash) VALUES ($1,$2,$3) RETURNING id',
      [email, 'Contadora', hash],
    );
    const userId = usuario.rows[0]!.id;
    const org = await db.query<{ create_organization: string }>(
      'SELECT create_organization($1,$2,$3)',
      [`Estudio estados ${stamp}`, withCheckDigit(`30${stamp}`), userId],
    );

    const crearEmpresa = async (nombre: string, prefijo: string): Promise<string> => {
      const c = await db.query<{ create_company: string }>(
        'SELECT create_company($1,$2,$3,$4,$5,$6,$7,$8)',
        [userId, org.rows[0]!.create_organization, nombre, withCheckDigit(`${prefijo}${stamp}`),
         'SA', 'AR-C', 'IGJ', '12-31'],
      );
      const id = c.rows[0]!.create_company;
      for (const rol of ['CONTADOR', 'ADMINISTRADOR']) {
        await db.query('SELECT grant_company_role($1,$2,$3,$4)', [userId, id, userId, rol]);
      }
      return id;
    };
    empresaA = await crearEmpresa('Estados A', '33');
    empresaB = await crearEmpresa('Estados B', '27');

    const inicial = (
      await app.inject({ method: 'POST', url: '/auth/login', payload: { email, password: PASSWORD } })
    ).json<{ token: string }>().token;
    const secret = (
      await app.inject({
        method: 'POST', url: '/auth/mfa/setup', headers: { authorization: `Bearer ${inicial}` },
      })
    ).json<{ secret: string }>().secret;
    await app.inject({
      method: 'POST', url: '/auth/mfa/confirm',
      payload: { code: totp(secret, Date.now()) },
      headers: { authorization: `Bearer ${inicial}` },
    });
    token = (
      await app.inject({ method: 'POST', url: '/auth/login', payload: { email, password: PASSWORD } })
    ).json<{ token: string }>().token;
    await app.inject({
      method: 'POST', url: '/auth/mfa/verify',
      payload: { code: totp(secret, Date.now()) },
      headers: { authorization: `Bearer ${token}` },
    });

    for (const empresa of [empresaA, empresaB]) {
      const marco = await pedir(empresa, 'POST', '/companies/current/reporting-framework', {
        framework: 'RT_FACPCE',
        validFrom: '2026-01-01',
      });
      expect(marco.statusCode, marco.body).toBe(200);

      // Una agrupadora con hija, para probar que no participa por sí misma.
      const padre = await pedir(empresa, 'POST', '/accounts', {
        code: '1.1', name: 'Disponibilidades', type: 'ACTIVO',
      });
      const padreId = padre.json<{ id: string }>().id;

      for (const cuenta of PLAN) {
        const r = await pedir(empresa, 'POST', '/accounts', {
          ...cuenta,
          ...(cuenta.code === '1.1.01' ? { parentId: padreId } : {}),
        });
        expect(r.statusCode, r.body).toBe(201);
        if (empresa === empresaA) cuentas[cuenta.code] = r.json<{ id: string }>().id;
        if (cuenta.code === '3.4.01') {
          await pedir(empresa, 'PATCH', `/accounts/${r.json<{ id: string }>().id}`, {
            closingRole: 'RESULTADO_DEL_EJERCICIO',
            motivo: 'Designación de la cuenta de resultado del ejercicio',
          });
        }
      }
      if (empresa === empresaA) cuentas['1.1'] = padreId;

      const ej = await pedir(empresa, 'POST', '/fiscal-years', {
        code: `EJ2026-${empresa === empresaA ? 'A' : 'B'}-${stamp}`,
        startDate: '2026-01-01',
        endDate: '2026-12-31',
      });
      expect(ej.statusCode, ej.body).toBe(201);
      if (empresa === empresaA) ejercicioA = ej.json<{ id: string }>().id;
    }

    // ---- Los movimientos de la empresa A --------------------------------
    // Aporte de capital, una venta a crédito, un cobro, un gasto impago, una
    // venta anulada con su contraasiento, y un par de cuentas de orden.
    await asiento(empresaA, '2026-01-02', 'Aporte de capital', [
      { accountCode: '1.1.01', debit: '500000.00' },
      { accountCode: '3.1.01', credit: '500000.00' },
    ]);
    await asiento(empresaA, '2026-03-10', 'Venta a crédito', [
      { accountCode: '1.1.03', debit: '300000.00' },
      { accountCode: '4.1.01', credit: '300000.00' },
    ]);
    await asiento(empresaA, '2026-04-05', 'Cobro parcial', [
      { accountCode: '1.1.01', debit: '120000.00' },
      { accountCode: '1.1.03', credit: '120000.00' },
    ]);
    await asiento(empresaA, '2026-06-20', 'Gasto de administración impago', [
      { accountCode: '6.1.01', debit: '80000.00' },
      { accountCode: '2.1.01', credit: '80000.00' },
    ]);
    await asiento(empresaA, '2026-07-01', 'Documentos endosados', [
      { accountCode: '7.1.01', debit: '45000.00' },
      { accountCode: '7.2.01', credit: '45000.00' },
    ]);

    const anulado = await asiento(empresaA, '2026-08-01', 'Venta cargada dos veces', [
      { accountCode: '1.1.03', debit: '99000.00' },
      { accountCode: '4.1.01', credit: '99000.00' },
    ]);
    const contra = await pedir(empresaA, 'POST', `/journal-entries/${anulado}/reverse`, {
      motivo: 'Se registró dos veces la misma venta',
    });
    expect(contra.statusCode, contra.body).toBe(201);

    // Un asiento que queda PROPUESTO: no es contabilidad y no debe llegar.
    sinAprobar = await asiento(
      empresaA, '2026-09-01', 'Venta sin aprobar',
      [{ accountCode: '1.1.03', debit: '7000.00' }, { accountCode: '4.1.01', credit: '7000.00' }],
      { aprobar: false },
    );

    // Empresa B, con un importe irrepetible.
    const ejB = await db.query<{ id: string }>(
      'SELECT id FROM fiscal_years WHERE company_id = $1',
      [empresaB],
    );
    void ejB;
    await asiento(empresaB, '2026-03-10', 'Venta de la empresa B', [
      { accountCode: '1.1.01', debit: '888888.00' },
      { accountCode: '4.1.01', credit: '888888.00' },
    ]);
  });

  afterAll(async () => {
    await app?.close();
    await db?.end();
    await closePool();
  });

  // -------------------------------------------------------------------------
  // 1 · Alcance: huérfana, ajena y capturada de más
  // -------------------------------------------------------------------------

  describe('1 · Qué cuentas le corresponden a cada estado', () => {
    it('el ESP no marca como huérfanas a las cuentas de resultado', async () => {
      // El defecto que esta fase cierra. Antes, `4.1.01` y `6.1.01` salían en
      // CUENTA_SIN_RUBRO y el ESP quedaba `emisible = false` para siempre.
      const esp = await estado(empresaA, 'ESP', ejercicioA);
      const sinRubro = control(esp, 'CUENTA_SIN_RUBRO')!;

      expect(sinRubro.involucrados).toEqual([]);
      expect(sinRubro.cumple).toBe(true);
    });

    it('el ER declara ajenas a las patrimoniales, y lo explica con su artículo', async () => {
      const er = await estado(empresaA, 'ER', ejercicioA);

      expect(control(er, 'CUENTA_SIN_RUBRO')!.cumple).toBe(true);
      const fuera = control(er, 'CUENTAS_FUERA_DEL_ALCANCE')!;
      expect(fuera.cumple).toBe(true);
      expect(fuera.involucrados).toEqual(
        expect.arrayContaining(['1.1.01', '1.1.03', '2.1.01', '3.1.01', '7.1.01']),
      );
      expect(fuera.detalle).toMatch(/art\. 64/);
    });

    it('cada cuenta tiene una situación explícita, no un silencio', async () => {
      const er = await estado(empresaA, 'ER', ejercicioA);

      expect(clasif(er, '4.1.01')!.situacion).toBe('CLASIFICADA');
      expect(clasif(er, '4.1.01')!.renglones).toEqual(['VENTAS']);
      expect(clasif(er, '1.1.01')!.situacion).toBe('FUERA_DEL_ALCANCE');
      expect(clasif(er, '1.1.01')!.renglones).toEqual([]);
    });

    it('una cuenta agrupadora no participa: su saldo está en las hijas', async () => {
      const esp = await estado(empresaA, 'ESP', ejercicioA);
      expect(clasif(esp, '1.1')).toBeUndefined();

      // Y la base impide imputarle directamente.
      const r = await pedir(empresaA, 'POST', '/journal-entries', {
        journalCode: 'GENERAL',
        entryDate: '2026-10-01',
        description: 'Imputación a una agrupadora',
        currency: 'ARS',
        lines: [
          { accountCode: '1.1', debit: '10.00', credit: '0' },
          { accountCode: '4.1.01', debit: '0', credit: '10.00' },
        ],
        source: { type: 'MANUAL', id: null },
        manualJustification: 'No debería entrar',
      });
      expect(r.statusCode).toBe(422);
      expect(r.body).toMatch(/E_ACCOUNT_NOT_POSTABLE/);
    });

    it('una cuenta con código fuera de la convención sí es huérfana', async () => {
      // El control no se apagó: se acotó. Una cuenta de activo que ningún
      // renglón captura sigue bloqueando, porque su saldo desaparecería.
      const alta = await pedir(empresaA, 'POST', '/accounts', {
        code: '1.9.99', name: 'Activo con código no previsto', type: 'ACTIVO',
      });
      expect(alta.statusCode, alta.body).toBe(201);
      await asiento(empresaA, '2026-10-05', 'Movimiento en la cuenta rara', [
        { accountCode: '1.9.99', debit: '1000.00' },
        { accountCode: '2.1.01', credit: '1000.00' },
      ]);

      const esp = await estado(empresaA, 'ESP', ejercicioA);
      const sinRubro = control(esp, 'CUENTA_SIN_RUBRO')!;
      expect(sinRubro.involucrados).toContain('1.9.99');
      expect(sinRubro.cumple).toBe(false);
      expect(esp.emisible).toBe(false);

      // Se deshace exactamente el movimiento y recién entonces se archiva la
      // cuenta: si se archivara con saldo, el estado la dejaría afuera —filtra
      // por `status = 'ACTIVE'`— y el activo quedaría corto sin que nada lo diga.
      await asiento(empresaA, '2026-10-06', 'Reverso del movimiento de prueba', [
        { accountCode: '2.1.01', debit: '1000.00' },
        { accountCode: '1.9.99', credit: '1000.00' },
      ]);
      const archivada = await pedir(empresaA, 'PATCH', `/accounts/${alta.json<{ id: string }>().id}`, {
        status: 'ARCHIVED',
        motivo: 'Alta de prueba del control de cobertura',
      });
      expect(archivada.statusCode, archivada.body).toBe(200);

      const despues = await estado(empresaA, 'ESP', ejercicioA);
      expect(control(despues, 'CUENTA_SIN_RUBRO')!.cumple).toBe(true);
    });
  });

  // -------------------------------------------------------------------------
  // 2 · ESP
  // -------------------------------------------------------------------------

  describe('2 · Estado de Situación Patrimonial', () => {
    it('cierra la ecuación patrimonial con los códigos de su plantilla', async () => {
      // Antes fallaba siempre: la ecuación se declaraba en la ruta con los
      // nodos `A` y `P`, y la plantilla usa `ACTIVO` y `PASIVO`.
      const esp = await estado(empresaA, 'ESP', ejercicioA);
      const ecuacion = control(esp, 'ECUACION_PATRIMONIAL')!;

      expect(ecuacion.involucrados).toEqual(['ACTIVO', 'PASIVO', 'PN']);
      expect(ecuacion.cumple).toBe(true);
      expect(esp.emisible).toBe(true);
    });

    it('expone activo, pasivo y patrimonio neto con los saldos del Mayor', async () => {
      const esp = await estado(empresaA, 'ESP', ejercicioA);

      // Caja 500.000 + 120.000 − 1.000 + 1.000; Deudores 300.000 − 120.000.
      expect(renglon(esp, 'AC_CAJA')!.importe).toBe('620000.00');
      expect(renglon(esp, 'AC_CRED')!.importe).toBe('180000.00');
      expect(renglon(esp, 'ACTIVO')!.importe).toBe('800000.00');
      expect(renglon(esp, 'PASIVO')!.importe).toBe('80000.00');
      expect(renglon(esp, 'PN')!.importe).toBe('720000.00');
    });

    it('el resultado del ejercicio integra el patrimonio neto', async () => {
      const esp = await estado(empresaA, 'ESP', ejercicioA);
      // Ventas 300.000 − gastos 80.000. La venta anulada y su contraasiento se
      // compensan; el asiento PROPUESTO no entra.
      expect(renglon(esp, 'PN_RESULTADO_EJERCICIO')!.importe).toBe('220000.00');
      expect(renglon(esp, 'PN_CAPITAL')!.importe).toBe('500000.00');
    });

    it('las cuentas de orden no inflan el activo ni el pasivo', async () => {
      const esp = await estado(empresaA, 'ESP', ejercicioA);
      expect(renglon(esp, 'ORDEN')!.importe).toBe('0.00');

      // Y ninguna cuenta de orden aporta a un rubro patrimonial.
      for (const codigo of ['ACTIVO', 'PASIVO', 'PN']) {
        const aportantes = renglon(esp, codigo)!.origen.map((o) => o.codigo);
        expect(aportantes).not.toContain('7.1.01');
        expect(aportantes).not.toContain('7.2.01');
      }
    });
  });

  // -------------------------------------------------------------------------
  // 3 · ER
  // -------------------------------------------------------------------------

  describe('3 · Estado de Resultados', () => {
    it('separa ingresos de gastos y determina el resultado', async () => {
      const er = await estado(empresaA, 'ER', ejercicioA);
      expect(renglon(er, 'VENTAS')!.importe).toBe('300000.00');
      expect(renglon(er, 'G_ADM')!.importe).toBe('-80000.00');
      expect(renglon(er, 'RESULTADO_EJERCICIO')!.importe).toBe('220000.00');
      expect(er.emisible).toBe(true);
    });

    it('el asiento anulado y su contraasiento no impactan dos veces', async () => {
      // La venta de 99.000 se cargó, se anuló y su contraasiento la compensó. Si
      // el estado contara el original sin el contraasiento —o al revés— el
      // resultado sería 319.000 o 121.000.
      const er = await estado(empresaA, 'ER', ejercicioA);
      expect(renglon(er, 'VENTAS')!.importe).toBe('300000.00');
    });

    it('un asiento PROPUESTO no llega al estado', async () => {
      const er = await estado(empresaA, 'ER', ejercicioA);
      // Los 7.000 sin aprobar no están.
      expect(renglon(er, 'VENTAS')!.importe).not.toBe('307000.00');
    });
  });

  // -------------------------------------------------------------------------
  // 4 · Reconciliación
  // -------------------------------------------------------------------------

  describe('4 · Diario → Mayor → Estados', () => {
    /** Las dos fotos previas al cierre, para comparar contra las posteriores. */
    let antes: { esp: Estado; er: Estado };

    it('el ESP reconcilia cuenta por cuenta con el Mayor', async () => {
      const mayor = await pedir(
        empresaA, 'GET', '/books/mayor?desde=2026-01-01&hasta=2026-12-31',
      );
      expect(mayor.statusCode, mayor.body).toBe(200);
      const saldos = new Map(
        mayor.json<{ cuentas: { codigo: string; saldoFinal: string }[] }>().cuentas
          .map((c) => [c.codigo, centavos(c.saldoFinal)]),
      );

      const esp = await estado(empresaA, 'ESP', ejercicioA);
      // Cada aporte de cada cuenta al ESP tiene que ser su saldo del Mayor, en
      // valor absoluto: el signo depende de la presentación del renglón.
      for (const linea of esp.renglones) {
        for (const origen of linea.origen) {
          const delMayor = saldos.get(origen.codigo);
          if (delMayor === undefined) continue;
          const aporte = centavos(origen.aporte);
          expect(
            [origen.codigo, aporte < 0n ? -aporte : aporte],
            `la cuenta ${origen.codigo} no coincide con el Mayor`,
          ).toEqual([origen.codigo, delMayor < 0n ? -delMayor : delMayor]);
        }
      }
    });

    it('el resultado del ER coincide con el balance de comprobación', async () => {
      const balance = await pedir(
        empresaA, 'GET', '/reports/trial-balance?desde=2026-01-01&hasta=2026-12-31',
      );
      const lineas = balance.json<{ lineas: { codigo: string; saldoFinal: string }[] }>().lineas;
      const deResultado = lineas.filter((l) => l.codigo.startsWith('4.') || l.codigo.startsWith('6.'));
      const resultado = -deResultado.reduce((acc, l) => acc + centavos(l.saldoFinal), 0n);

      const er = await estado(empresaA, 'ER', ejercicioA);
      expect(centavos(renglon(er, 'RESULTADO_EJERCICIO')!.importe)).toBe(resultado);
    });

    it('ESP y ER no cuentan el mismo movimiento dos veces dentro del mismo estado', async () => {
      for (const tipo of ['ESP', 'ER'] as const) {
        const e = await estado(empresaA, tipo, ejercicioA);
        expect([tipo, control(e, 'CUENTA_EN_DOS_RUBROS')!.cumple]).toEqual([tipo, true]);
        expect([tipo, control(e, 'CUENTA_FUERA_DE_ALCANCE')!.cumple]).toEqual([tipo, true]);
      }
    });

    it('el resultado del ER es el que el cierre de ejercicio determina', async () => {
      // La prueba de que los dos caminos —estado contable y refundición— salen
      // del mismo Mayor. Si difirieran, uno de los dos estaría clasificando mal.
      //
      // Antes hay que aprobar el asiento que quedó sin aprobar a propósito: el
      // checklist de cierre bloquea con SIN_PROPUESTOS, y esa es su función. Se
      // resuelve como pide, no salteándolo.
      expect((await pedir(empresaA, 'POST', `/journal-entries/${sinAprobar}/approve`)).statusCode).toBe(200);

      antes = {
        esp: await estado(empresaA, 'ESP', ejercicioA),
        er: await estado(empresaA, 'ER', ejercicioA),
      };
      const esperado = renglon(antes.er, 'RESULTADO_EJERCICIO')!.importe;

      expect((await pedir(empresaA, 'POST', `/fiscal-years/${ejercicioA}/pre-close`)).statusCode).toBe(201);
      const cierre = await pedir(empresaA, 'POST', `/fiscal-years/${ejercicioA}/close`);
      expect(cierre.statusCode, cierre.body).toBe(201);

      expect(cierre.json<{ resultado: string }>().resultado).toBe(esperado);
    });

    it('el estado del ejercicio es el mismo antes y después de cerrarlo', async () => {
      // Los asientos de cierre no entran al estado: describen el mecanismo de
      // reapertura, no la situación. Si entraran, el ESP posterior al cierre
      // sería un balance de ceros —formalmente cuadrado y sin información—.
      //
      // Y la refundición mueve el resultado de las cuentas de resultado a una de
      // PN: sin excluirla, el ER de un ejercicio cerrado daría cero. Que las dos
      // fotos coincidan es lo que prueba que el estado sale del Mayor y no del
      // momento en que se lo pidió.
      const esp = await estado(empresaA, 'ESP', ejercicioA);
      const er = await estado(empresaA, 'ER', ejercicioA);

      for (const codigo of ['ACTIVO', 'PASIVO', 'PN', 'PN_RESULTADO_EJERCICIO']) {
        expect([codigo, renglon(esp, codigo)!.importe]).toEqual([
          codigo,
          renglon(antes.esp, codigo)!.importe,
        ]);
      }
      expect(control(esp, 'ECUACION_PATRIMONIAL')!.cumple).toBe(true);
      expect(renglon(er, 'RESULTADO_EJERCICIO')!.importe).toBe(
        renglon(antes.er, 'RESULTADO_EJERCICIO')!.importe,
      );
    });
  });

  // -------------------------------------------------------------------------
  // 5 · Trazabilidad y emisión
  // -------------------------------------------------------------------------

  describe('5 · Trazabilidad', () => {
    let estadoId: string;

    it('se emite, y por primera vez el endpoint completa', async () => {
      const r = await pedir(empresaA, 'POST', '/statements/issue', {
        ejercicio: ejercicioA, tipo: 'ESP',
      });
      expect(r.statusCode, r.body).toBe(201);
      const cuerpo = r.json<{ estadoId: string; sha256: string; renglones: number }>();
      estadoId = cuerpo.estadoId;
      expect(cuerpo.sha256).toMatch(/^[0-9a-f]{64}$/);
      expect(cuerpo.renglones).toBeGreaterThan(10);

      const fila = await db.query<{ status: string }>(
        'SELECT status FROM financial_statements WHERE id = $1',
        [estadoId],
      );
      expect(fila.rows[0]!.status).toBe('EMITIDO');
    });

    it('una cifra publicada llega hasta los movimientos que la formaron', async () => {
      const linea = await db.query<{ id: string; line_code: string }>(
        `SELECT id, line_code FROM financial_statement_lines
          WHERE statement_id = $1 AND line_code = 'AC_CAJA'`,
        [estadoId],
      );
      const r = await pedir(empresaA, 'GET', `/statements/trace/${linea.rows[0]!.id}`);
      expect(r.statusCode, r.body).toBe(200);
      const traza = r.json<{ origen: { account_code: string }[] }>();
      expect(traza.origen.map((c) => c.account_code)).toContain('1.1.01');
    });

    it('los renglones de un estado emitido son inmutables', async () => {
      // El candado se mantiene: lo que cambió es el orden —se firma después de
      // escribir—, no la exigencia.
      const linea = await db.query<{ id: string }>(
        `SELECT id FROM financial_statement_lines WHERE statement_id = $1 LIMIT 1`,
        [estadoId],
      );
      await expect(
        db.query('UPDATE financial_statement_lines SET amount = 1 WHERE id = $1', [
          linea.rows[0]!.id,
        ]),
      ).rejects.toThrow(/inmutables/);
    });
  });

  // -------------------------------------------------------------------------
  // 6 · Aislamiento
  // -------------------------------------------------------------------------

  describe('6 · Multiempresa', () => {
    it('el estado de A no contiene ningún importe de B', async () => {
      const esp = await estado(empresaA, 'ESP', ejercicioA);
      expect(esp.renglones.map((r) => r.importe)).not.toContain('888888.00');
    });

    it('B arma su propio estado, con su propio plan', async () => {
      const ej = await db.query<{ id: string }>(
        'SELECT id FROM fiscal_years WHERE company_id = $1',
        [empresaB],
      );
      const esp = await estado(empresaB, 'ESP', ej.rows[0]!.id);
      expect(renglon(esp, 'AC_CAJA')!.importe).toBe('888888.00');
      expect(renglon(esp, 'PN_RESULTADO_EJERCICIO')!.importe).toBe('888888.00');
    });

    it('el ejercicio de otra empresa no existe para esta', async () => {
      const ej = await db.query<{ id: string }>(
        'SELECT id FROM fiscal_years WHERE company_id = $1',
        [empresaB],
      );
      const r = await pedir(empresaA, 'GET', `/statements?ejercicio=${ej.rows[0]!.id}&tipo=ESP`);
      expect(r.statusCode).toBe(404);
    });

    it('la plantilla de una empresa no la usa otra', async () => {
      // `cargarPlantillas` filtra por `company_id IS NULL OR = $1`. Una plantilla
      // propia de B no puede aparecer en el estado de A.
      const norma = await db.query<{ id: string }>('SELECT id FROM norm_versions LIMIT 1');
      await db.query(
        `INSERT INTO statement_templates
           (company_id, statement_kind, framework, entity_type, regulator, version,
            valid_from, structure, norm_version_id, articulo, created_by,
            scope_types, scope_fundamento)
         VALUES ($1,'ESP','RT_FACPCE','SA','IGJ',9,'2024-01-01',
                 '[{"codigo":"SOLO_DE_B","etiqueta":"Solo de B","tipo":"RUBRO"}]'::jsonb,
                 $2,'Art. 63','tester', ARRAY['ACTIVO'], 'propia de B')`,
        [empresaB, norma.rows[0]!.id],
      );

      const esp = await estado(empresaA, 'ESP', ejercicioA);
      expect(esp.renglones.map((r) => r.codigo)).not.toContain('SOLO_DE_B');
    });
  });
});
