/**
 * Señales, proyección y simulación.
 *
 * Lo que este archivo defiende:
 *
 *   1. **Que sin umbral declarado nada sea un desvío.** `superaUmbral` viene en
 *      `null`, que es distinto de `false`: el sistema informa el hecho y no lo
 *      juzga. Es la tercera vez que aparece el criterio —después de
 *      `diasDePago` y `stockMinimo`— y tiene que valer igual.
 *   2. **Que declarar el umbral encienda el desvío**, y recién ahí entre a la
 *      bandeja.
 *   3. **Que cada señal traiga la cuenta** con la que se hizo.
 *   4. **Que la simulación imprima sus supuestos.** Una proyección de precio a
 *      volumen constante ignora la elasticidad, y decirlo es la diferencia
 *      entre una herramienta y un número que engaña.
 *   5. **Que la bandeja siga aislada** después de que la 0058 la reemplazara:
 *      `CREATE OR REPLACE` borra las reloptions y dejaría la vista sin
 *      `security_invoker`.
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

suite('Señales, proyección y simulación', () => {
  let app: FastifyInstance;
  let db: Client;
  let stamp: string;
  let token: string;
  let empresa: string;
  let clienteId: string;
  let cuitCliente: string;
  let numero = 9000;
  const anio = new Date().getUTCFullYear();

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
    cuitCliente = `30${stamp}${cuitCheckDigit(`30${stamp}`)}`;

    const { hash: argonHash } = await import('@node-rs/argon2');
    const fundadorId = (
      await db.query<{ id: string }>(
        'INSERT INTO users (email, full_name, password_hash) VALUES ($1,$2,$3) RETURNING id',
        [
          `fundador-sen-${stamp}@estudio.test`,
          'Fundador',
          await argonHash(PASSWORD, { algorithm: 2, memoryCost: 19_456, timeCost: 2, parallelism: 1 }),
        ],
      )
    ).rows[0]!.id;

    const organizationId = (
      await db.query<{ create_organization: string }>('SELECT create_organization($1,$2,$3)', [
        `Estudio sen ${stamp}`, withCheckDigit(`30${stamp}`), fundadorId,
      ])
    ).rows[0]!.create_organization;

    empresa = (
      await db.query<{ create_company: string }>('SELECT create_company($1,$2,$3,$4,$5,$6,$7,$8)', [
        fundadorId, organizationId, `Empresa sen ${stamp}`, withCheckDigit(`33${stamp}`),
        'SA', 'AR-C', 'IGJ', '12-31',
      ])
    ).rows[0]!.create_company;

    const tokenFundador = (
      await app.inject({
        method: 'POST',
        url: '/auth/login',
        payload: { email: `fundador-sen-${stamp}@estudio.test`, password: PASSWORD },
      })
    ).json<{ token: string }>().token;

    const email = `contadora-sen-${stamp}@estudio.test`;
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

    // Ejercicio que abarca hoy: las señales comparan contra `current_date`.
    expect(
      (await pedir('POST', '/fiscal-years', {
        code: `EJ${anio}-${stamp}`,
        startDate: `${anio}-01-01`,
        endDate: `${anio}-12-31`,
      })).statusCode,
    ).toBe(201);
    expect(
      (await pedir('POST', '/accounts', { code: '4.1.01', name: 'Ventas', type: 'INGRESO' }))
        .statusCode,
    ).toBe(201);

    clienteId = (
      await pedir('POST', '/parties', {
        tipoDocumento: 'CUIT', numeroDocumento: cuitCliente,
        razonSocial: `Cliente único ${stamp}`, condicionIva: 'RESPONSABLE_INSCRIPTO',
        roles: ['CLIENTE'],
      })
    ).json<{ id: string }>().id;

    // Un solo cliente concentra el 100% de las ventas, y la última compra fue
    // hace más de sesenta días. Las dos señales tienen algo real que medir.
    await venta('50000.00', haceDias(75));
    await venta('30000.00', haceDias(95));
  });

  afterAll(async () => {
    await app?.close();
    await db?.end();
    await closePool();
  });

  function haceDias(dias: number): string {
    const d = new Date();
    d.setUTCDate(d.getUTCDate() - dias);
    return d.toISOString().slice(0, 10);
  }

  async function venta(neto: string, fecha: string): Promise<void> {
    numero += 1;
    const forma =
      `--X\r\nContent-Disposition: form-data; name="file"; filename="sen-${stamp}-${numero}.xml"\r\n` +
      `Content-Type: application/xml\r\n\r\n<comprobante><n>${numero}</n></comprobante>\r\n--X--\r\n`;
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

    const iva = (Number(neto) * 0.21).toFixed(2);
    const op = await pedir('POST', `/documents/${subida.json<{ id: string }>().id}/tax-transaction`, {
      direction: 'VENTAS', cbteTipo: 1, puntoVenta: 1, numero, fecha,
      cuitContraparte: cuitCliente, razonSocial: 'Cliente',
      condicionIva: 'RESPONSABLE_INSCRIPTO',
      neto, iva, noGravado: '0', exento: '0', percepciones: '0',
      total: (Number(neto) + Number(iva)).toFixed(2),
    });
    expect(op.statusCode, op.body).toBe(201);
    expect(
      (await pedir('POST', `/tax-transactions/${op.json<{ taxTransactionId: string }>().taxTransactionId}/party`, {
        partyId: clienteId,
      })).statusCode,
    ).toBe(200);
  }

  // -------------------------------------------------------------------------
  it('sin umbral declarado el hecho se informa y no se llama desvío', async () => {
    const r = await pedir('GET', '/analysis/signals');
    expect(r.statusCode, r.body).toBe(200);
    const cuerpo = r.json<{
      senales: { tipo: string; valor: string; umbral: string | null; superaUmbral: boolean | null }[];
      alcance: string;
    }>();

    expect(cuerpo.senales.length).toBeGreaterThan(0);
    for (const s of cuerpo.senales) {
      expect(s.umbral, `${s.tipo} no debería tener umbral`).toBeNull();
      // null, NO false. `false` sería afirmar que está bien.
      expect(s.superaUmbral, `${s.tipo} no puede afirmar que está bien`).toBeNull();
    }
    expect(cuerpo.alcance).toContain('no lo juzga');
  });

  it('las cuentas se hacen igual: el cliente concentra el 100%', async () => {
    const r = await pedir('GET', '/analysis/signals');
    const c = r
      .json<{ senales: { tipo: string; valor: string; terceroId: string | null }[] }>()
      .senales.find((s) => s.tipo === 'CONCENTRACION_DE_CLIENTES')!;

    expect(c.terceroId).toBe(clienteId);
    expect(Number(c.valor)).toBe(100);
  });

  it('cada señal trae la cuenta con la que se hizo', async () => {
    const r = await pedir('GET', '/analysis/signals');
    for (const s of r.json<{ senales: { tipo: string; metodologia: string }[] }>().senales) {
      expect(s.metodologia.length, `${s.tipo} sin metodología`).toBeGreaterThan(40);
    }
  });

  it('nada entra a la bandeja mientras no haya umbral', async () => {
    const bandeja = await pedir('GET', '/work-queue?limite=200');
    expect(bandeja.statusCode, bandeja.body).toBe(200);
    expect(
      bandeja.json<{ items: { rama: string }[] }>().items.some((i) => i.rama === 'DESVIO_DECLARADO'),
      'llenar la bandeja de cosas que nadie pidió medir es la forma de que se deje de mirar',
    ).toBe(false);
  });

  // -------------------------------------------------------------------------
  it('declarar el umbral enciende el desvío y lo manda a la bandeja', async () => {
    const r = await pedir('PUT', '/analysis/thresholds', {
      caidaVentasPct: null,
      concentracionClientePct: 60,
      diasClienteInactivo: 60,
      moraPct: null,
    });
    expect(r.statusCode, r.body).toBe(200);

    const senales = await pedir('GET', '/analysis/signals?soloDesvios=si');
    const tipos = senales.json<{ senales: { tipo: string }[] }>().senales.map((s) => s.tipo);
    expect(tipos).toContain('CONCENTRACION_DE_CLIENTES');
    expect(tipos).toContain('CLIENTE_INACTIVO');
    // La caída de ventas sigue sin umbral: no se convierte en desvío.
    expect(tipos).not.toContain('VARIACION_DE_VENTAS');

    const bandeja = await pedir('GET', '/work-queue?limite=200');
    const item = bandeja
      .json<{ items: { rama: string; disponibilidad: string; motivo: string }[] }>()
      .items.find((i) => i.rama === 'DESVIO_DECLARADO');
    expect(item, 'ahora sí hay algo que la empresa pidió que se le avise').toBeDefined();
    // No se resuelve con un botón: es una decisión de negocio.
    expect(item!.disponibilidad).toBe('INFORMATIVO');
    expect(item!.motivo).toContain('umbral declarado');
  });

  it('declarar umbrales queda en la bitácora', async () => {
    const r = await db.query<{ n: string }>(
      `SELECT count(*)::text AS n FROM audit_logs
        WHERE company_id = $1 AND action = 'DECLARAR_UMBRALES_DE_ANALISIS'`,
      [empresa],
    );
    expect(Number(r.rows[0]!.n)).toBeGreaterThanOrEqual(1);
  });

  // -------------------------------------------------------------------------
  it('la simulación imprime sus supuestos y sus limitaciones', async () => {
    const r = await pedir('POST', '/analysis/simulate', {
      meses: 12,
      variacionDePrecio: 8,
    });
    expect(r.statusCode, r.body).toBe(200);
    const cuerpo = r.json<{
      base: { netoFacturado: string };
      resultado: { netoProyectado: string; variacionTotalPct: string };
      supuestos: string[];
      limitaciones: string[];
      metodologia: string;
    }>();

    // 80.000 facturados, +8% → 86.400. Aritmética, no pronóstico.
    expect(cuerpo.base.netoFacturado).toBe('80000.00');
    expect(cuerpo.resultado.netoProyectado).toBe('86400.00');
    // Decimal exacto: la variación combinada es una cuenta que se puede rehacer.
    expect(cuerpo.resultado.variacionTotalPct).toBe('8.0000');

    // Lo frágil, impreso: sin esto es un número que engaña.
    expect(cuerpo.supuestos.join(' ')).toContain('elasticidad');
    expect(cuerpo.limitaciones.join(' ')).toContain('costo de lo vendido');
    expect(cuerpo.metodologia).toContain('variación de precio');
  });

  it('una simulación sin cambios se rechaza', async () => {
    const r = await pedir('POST', '/analysis/simulate', {
      variacionDePrecio: 0,
      variacionDeVolumen: 0,
    });
    expect(r.statusCode, r.body).toBe(400);
  });

  it('la simulación no se guarda en ningún lado', async () => {
    const tablas = await db.query<{ table_name: string }>(
      `SELECT table_name FROM information_schema.tables
        WHERE table_schema = current_schema() AND table_type = 'BASE TABLE'
          AND (table_name LIKE '%simulacion%' OR table_name LIKE '%simulation%')`,
    );
    expect(tablas.rows).toEqual([]);
  });

  // -------------------------------------------------------------------------
  it('la proyección de cobranzas dice qué parte de la cartera no cubre', async () => {
    const r = await pedir('GET', '/analysis/proyeccion-de-cobranzas');
    expect(r.statusCode, r.body).toBe(200);
    const cuerpo = r.json<{
      proyeccion: { sinPlazoAcordado: string; pendienteTotal: string };
      alcance: string;
      metodologia: string;
    }>();

    // El cliente no tiene condición de pago declarada, así que TODO su
    // pendiente queda fuera de la proyección — y eso se informa.
    expect(cuerpo.proyeccion.sinPlazoAcordado).toBe(cuerpo.proyeccion.pendienteTotal);
    expect(cuerpo.alcance).toContain('sería inventar el acuerdo');
    expect(cuerpo.metodologia.length).toBeGreaterThan(40);
  });

  // -------------------------------------------------------------------------
  it('la bandeja conservó security_invoker después del reemplazo', async () => {
    // `CREATE OR REPLACE VIEW` NO conserva las reloptions: omitir la cláusula
    // habría dejado la bandeja evaluándose con los permisos de su dueño,
    // salteando el RLS de veinte tablas. Es la fuga que cerró la 0032.
    const r = await db.query<{ relname: string; reloptions: string[] | null }>(
      `SELECT relname, reloptions FROM pg_class
        WHERE relkind = 'v' AND relname LIKE 'work_queue%'`,
    );
    expect(r.rowCount).toBeGreaterThanOrEqual(9);
    for (const fila of r.rows) {
      expect(fila.reloptions, `${fila.relname} sin security_invoker repartiría todas las empresas`)
        .toContain('security_invoker=true');
    }
  });

  it('esta capa no pasa por ningún modelo', async () => {
    // Detectar un desvío es una comparación. Si esto generara predicciones de
    // IA habría filas en ai_predictions, y no las hay: lo que un modelo puede
    // hacer —explicar en palabras— vive en el subsistema de la 0018.
    const r = await db.query<{ n: string }>(
      `SELECT count(*)::text AS n FROM ai_predictions WHERE company_id = $1`,
      [empresa],
    );
    expect(r.rows[0]!.n).toBe('0');
  });
});
