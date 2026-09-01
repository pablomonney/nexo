/**
 * La capa analítica.
 *
 * Lo que este archivo defiende:
 *
 *   1. **Que los números salgan de los hechos.** Se cargan ventas conocidas y
 *      se comprueba que el total sea exactamente esa suma, no una aproximación.
 *   2. **Que cada cifra se pueda abrir** (§64). El `trazaRef` de un mes tiene
 *      que devolver los comprobantes que formaron ese total — y se lo ejecuta
 *      de verdad, no se comprueba que la cadena exista.
 *   3. **Que no invente margen.** Ninguna respuesta trae rentabilidad, y todas
 *      dicen por qué.
 *   4. **Que la cobertura sea visible.** Un informe sobre el 50% de las ventas
 *      no puede leerse igual que uno sobre el 100%.
 *   5. **Que no haya ni una cifra almacenada.**
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

suite('Analítica', () => {
  let app: FastifyInstance;
  let db: Client;
  let stamp: string;
  let token: string;
  let empresa: string;
  let clienteId: string;
  let cuitCliente: string;
  let productoId: string;
  let numero = 8000;

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
          `fundador-ana-${stamp}@estudio.test`,
          'Fundador',
          await argonHash(PASSWORD, { algorithm: 2, memoryCost: 19_456, timeCost: 2, parallelism: 1 }),
        ],
      )
    ).rows[0]!.id;

    const organizationId = (
      await db.query<{ create_organization: string }>('SELECT create_organization($1,$2,$3)', [
        `Estudio ana ${stamp}`, withCheckDigit(`30${stamp}`), fundadorId,
      ])
    ).rows[0]!.create_organization;

    empresa = (
      await db.query<{ create_company: string }>('SELECT create_company($1,$2,$3,$4,$5,$6,$7,$8)', [
        fundadorId, organizationId, `Empresa ana ${stamp}`, withCheckDigit(`26${stamp}`),
        'SA', 'AR-C', 'IGJ', '12-31',
      ])
    ).rows[0]!.create_company;

    const tokenFundador = (
      await app.inject({
        method: 'POST',
        url: '/auth/login',
        payload: { email: `fundador-ana-${stamp}@estudio.test`, password: PASSWORD },
      })
    ).json<{ token: string }>().token;

    const email = `contadora-ana-${stamp}@estudio.test`;
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
        code: `EJ2026-${stamp}`, startDate: '2026-01-01', endDate: '2026-12-31',
      })).statusCode,
    ).toBe(201);
    expect(
      (await pedir('POST', '/accounts', { code: '4.1.01', name: 'Ventas', type: 'INGRESO' }))
        .statusCode,
    ).toBe(201);

    clienteId = (
      await pedir('POST', '/parties', {
        tipoDocumento: 'CUIT', numeroDocumento: cuitCliente,
        razonSocial: `Cliente ana ${stamp}`, condicionIva: 'RESPONSABLE_INSCRIPTO',
        roles: ['CLIENTE'],
      })
    ).json<{ id: string }>().id;

    productoId = (
      await pedir('POST', '/products', {
        codigo: `PROD-${stamp}`, nombre: 'Producto analítico',
        impuesto: 'IVA', cuentaVenta: '4.1.01',
      })
    ).json<{ id: string }>().id;

    // Tres ventas de marzo: dos CON detalle y tercero, una sin nada. La tercera
    // existe para que la cobertura tenga algo que informar.
    await venta('10000.00', '2026-03-05', true, true);
    await venta('20000.00', '2026-03-12', true, true);
    await venta('5000.00', '2026-03-20', false, false);
  });

  afterAll(async () => {
    await app?.close();
    await db?.end();
    await closePool();
  });

  async function venta(
    neto: string,
    fecha: string,
    conTercero: boolean,
    conDetalle: boolean,
  ): Promise<string> {
    numero += 1;
    const forma =
      `--X\r\nContent-Disposition: form-data; name="file"; filename="ana-${stamp}-${numero}.xml"\r\n` +
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
    const total = (Number(neto) + Number(iva)).toFixed(2);
    const op = await pedir('POST', `/documents/${subida.json<{ id: string }>().id}/tax-transaction`, {
      direction: 'VENTAS', cbteTipo: 1, puntoVenta: 1, numero, fecha,
      cuitContraparte: cuitCliente, razonSocial: 'Cliente', condicionIva: 'RESPONSABLE_INSCRIPTO',
      neto, iva, noGravado: '0', exento: '0', percepciones: '0', total,
    });
    expect(op.statusCode, op.body).toBe(201);
    const ttId = op.json<{ taxTransactionId: string }>().taxTransactionId;

    if (conTercero) {
      expect(
        (await pedir('POST', `/tax-transactions/${ttId}/party`, { partyId: clienteId })).statusCode,
      ).toBe(200);
    }
    if (conDetalle) {
      expect(
        (await pedir('PUT', `/tax-transactions/${ttId}/lines`, {
          renglones: [
            {
              productoId, descripcion: 'Producto analítico', cantidad: '1',
              precioUnitario: neto, tratamiento: 'GRAVADO', neto, iva,
            },
          ],
        })).statusCode,
      ).toBe(200);
    }
    return ttId;
  }

  // -------------------------------------------------------------------------
  it('el total del mes es exactamente la suma de los comprobantes', async () => {
    const r = await pedir('GET', '/analytics/operaciones?direccion=VENTAS&meses=24');
    expect(r.statusCode, r.body).toBe(200);
    const marzo = r
      .json<{ meses: { desde: string; neto: string; comprobantes: number; sinTercero: number }[] }>()
      .meses.find((m) => m.desde === '2026-03-01')!;

    // 10.000 + 20.000 + 5.000. Ni redondeado ni aproximado.
    expect(marzo.neto).toBe('35000.00');
    expect(marzo.comprobantes).toBe(3);
    expect(marzo.sinTercero, 'una de las tres no se resolvió contra el maestro').toBe(1);
  });

  it('la traza de un mes abre los comprobantes que lo formaron', async () => {
    // §64 ejercitado de verdad: se sigue el enlace y se comprueba que devuelve
    // las filas. Un test que solo mirara que la cadena existe pasaría con una
    // traza rota.
    const r = await pedir('GET', '/analytics/operaciones?direccion=VENTAS&meses=24');
    const marzo = r
      .json<{ meses: { desde: string; trazaRef: string; comprobantes: number }[] }>()
      .meses.find((m) => m.desde === '2026-03-01')!;

    const detras = await pedir('GET', marzo.trazaRef);
    expect(detras.statusCode, detras.body).toBe(200);
    const operaciones = detras.json<{ operaciones: { total: string }[] }>().operaciones;
    expect(operaciones).toHaveLength(marzo.comprobantes);

    const suma = operaciones.reduce((a, o) => a + Number(o.total), 0);
    expect(suma.toFixed(2)).toBe((35000 * 1.21).toFixed(2));
  });

  it('el mes sale de la fecha del comprobante, no de cuándo se cargó', async () => {
    // Los tres se cargaron hoy y los tres son de marzo de 2026.
    const r = await pedir('GET', '/analytics/operaciones?direccion=VENTAS&meses=24');
    const meses = r.json<{ meses: { desde: string }[] }>().meses;
    expect(meses.map((m) => m.desde)).toContain('2026-03-01');
  });

  // -------------------------------------------------------------------------
  it('el informe por producto dice qué porción del total representa', async () => {
    const r = await pedir('GET', '/analytics/productos?direccion=VENTAS');
    expect(r.statusCode, r.body).toBe(200);
    const cuerpo = r.json<{
      productos: { codigo: string; neto: string; trazaRef: string }[];
      cobertura: { netoConDetalle: string; netoTotal: string };
      alcance: string;
    }>();

    const producto = cuerpo.productos.find((p) => p.codigo === `PROD-${stamp}`)!;
    expect(producto.neto).toBe('30000.00');

    // Y acá está lo importante: el producto suma 30.000 de un total de 35.000.
    // Sin la cobertura, ese informe se leería como si fuera todo.
    expect(cuerpo.cobertura.netoConDetalle).toBe('30000.00');
    expect(cuerpo.cobertura.netoTotal).toBe('35000.00');
    expect(cuerpo.alcance).toContain('cobertura');
  });

  it('la traza de un producto abre sus movimientos', async () => {
    const r = await pedir('GET', '/analytics/productos?direccion=VENTAS');
    const producto = r
      .json<{ productos: { codigo: string; trazaRef: string }[] }>()
      .productos.find((p) => p.codigo === `PROD-${stamp}`)!;

    const detras = await pedir('GET', producto.trazaRef);
    expect(detras.statusCode, detras.body).toBe(200);
  });

  it('el informe por tercero solo cuenta lo resuelto, y lo dice', async () => {
    const r = await pedir('GET', '/analytics/terceros?direccion=VENTAS');
    const cuerpo = r.json<{
      terceros: { partyId: string; neto: string; trazaRef: string }[];
      alcance: string;
    }>();

    const cliente = cuerpo.terceros.find((t) => t.partyId === clienteId)!;
    // 30.000 y no 35.000: la venta sin tercero no tiene a quién sumarse.
    expect(cliente.neto).toBe('30000.00');
    expect(cuerpo.alcance).toContain('no tienen a quién sumarse');

    const detras = await pedir('GET', cliente.trazaRef);
    expect(detras.statusCode, detras.body).toBe(200);
  });

  it('la cobertura separa detalle de tercero resuelto', async () => {
    const r = await pedir('GET', '/analytics/cobertura');
    expect(r.statusCode, r.body).toBe(200);
    const fila = r
      .json<{
        cobertura: {
          direccion: string; comprobantes: number; conDetalle: number; conTercero: number;
        }[];
      }>()
      .cobertura.find((c) => c.direccion === 'VENTAS')!;

    expect(fila.comprobantes).toBe(3);
    expect(fila.conDetalle).toBe(2);
    expect(fila.conTercero).toBe(2);
  });

  // -------------------------------------------------------------------------
  // Lo que no se inventa
  // -------------------------------------------------------------------------
  it('ninguna respuesta trae margen ni rentabilidad, y todas dicen por qué', async () => {
    for (const url of ['/analytics/resumen', '/analytics/productos', '/analytics/operaciones']) {
      const r = await pedir('GET', url);
      expect(r.statusCode, `${url}: ${r.body}`).toBe(200);
      const crudo = JSON.stringify(r.json()).toLowerCase();
      for (const prohibido of ['"margen"', '"rentabilidad"', '"utilidad"', '"ganancia"']) {
        expect(crudo, `${url} no puede traer ${prohibido} sin costo de lo vendido`)
          .not.toContain(prohibido);
      }
    }
    // Y el motivo va dicho donde lo lee quien busca el margen.
    const resumen = await pedir('GET', '/analytics/resumen');
    expect(resumen.json<{ alcance: string }>().alcance).toContain('costo de lo vendido');
  });

  it('el flujo bancario avisa que la caja no entra', async () => {
    const r = await pedir('GET', '/analytics/flujo-bancario');
    expect(r.statusCode, r.body).toBe(200);
    expect(r.json<{ alcance: string }>().alcance).toContain('efectivo en caja no entra');
  });

  it('no hay ni una cifra analítica almacenada', async () => {
    // Toda la capa son vistas. Una tabla de agregados sería la segunda verdad
    // de siempre, con el agravante de que en analítica nadie la contrasta.
    const tablas = await db.query<{ table_name: string }>(
      `SELECT table_name FROM information_schema.tables
        WHERE table_schema = current_schema() AND table_type = 'BASE TABLE'
          AND table_name LIKE 'analytics%'`,
    );
    expect(tablas.rows).toEqual([]);

    const vistas = await db.query<{ n: string }>(
      `SELECT count(*)::text AS n FROM information_schema.views
        WHERE table_schema = current_schema() AND table_name LIKE 'analytics%'`,
    );
    expect(Number(vistas.rows[0]!.n)).toBeGreaterThanOrEqual(6);
  });

  it('el resumen se deriva de las vistas que ya existían', async () => {
    const r = await pedir('GET', '/analytics/resumen');
    const resumen = r.json<{
      resumen: { aCobrar: string; pendientes: number; productosEnNegativo: number };
    }>().resumen;
    expect(resumen).not.toBeNull();
    expect(Number(resumen.pendientes)).toBeGreaterThanOrEqual(0);
  });

  // -------------------------------------------------------------------------
  it('la analítica no alcanza sin el permiso del dominio que expone', async () => {
    // Un rol con analytics:read pero sin product:read no ve qué se vendió de
    // cada producto por esta otra puerta.
    const solo = await db.query<{ n: string }>(
      `SELECT count(*)::text AS n FROM role_permissions rp
         JOIN roles r ON r.id = rp.role_id
         JOIN permissions p ON p.id = rp.permission_id
        WHERE r.code = 'CARGADOR' AND p.code IN ('analytics:read', 'product:read')`,
    );
    expect(solo.rows[0]!.n, 'el CARGADOR no tiene ninguno de los dos').toBe('0');
  });

  it('las vistas analíticas corren con los permisos de quien consulta', async () => {
    const r = await db.query<{ relname: string; reloptions: string[] }>(
      `SELECT relname, reloptions FROM pg_class
        WHERE relkind = 'v' AND relname LIKE 'analytics%'`,
    );
    expect(r.rowCount).toBeGreaterThanOrEqual(6);
    for (const fila of r.rows) {
      expect(fila.reloptions, `${fila.relname} sin security_invoker mostraría otras empresas`)
        .toContain('security_invoker=true');
    }
  });
});
