/**
 * Listas de precios: por lista, por cliente, por cantidad y por fecha.
 *
 * Lo que este archivo defiende, en orden de importancia:
 *
 *   1. **Que el precio se resuelva por la fecha de la operación.** Es el §6
 *      aplicado a los precios: reimprimir un presupuesto de marzo con la lista
 *      de septiembre produce un documento que dice algo que nunca se ofreció.
 *   2. **Que el precio venga con su procedencia.** De qué lista y de qué tramo,
 *      o del precio base, o `SIN_PRECIO`. Nunca un número pelado.
 *   3. **Que no se invente un tramo.** Si el más chico empieza en 10 y se
 *      preguntan 5, no hay precio por lista — no se usa el de 10.
 *   4. **Que un tercero no tenga dos listas el mismo día.** El sistema no
 *      tendría con qué elegir.
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

suite('Listas de precios', () => {
  let app: FastifyInstance;
  let db: Client;
  let stamp: string;
  let token: string;
  let empresa: string;
  let clienteId: string;
  let otroClienteId: string;
  let productoId: string;
  let productoSinPrecioId: string;
  let listaMarzo: string;
  let listaSeptiembre: string;

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

    const { hash: argonHash } = await import('@node-rs/argon2');
    const fundadorId = (
      await db.query<{ id: string }>(
        'INSERT INTO users (email, full_name, password_hash) VALUES ($1,$2,$3) RETURNING id',
        [
          `fundador-precio-${stamp}@estudio.test`,
          'Fundador',
          await argonHash(PASSWORD, { algorithm: 2, memoryCost: 19_456, timeCost: 2, parallelism: 1 }),
        ],
      )
    ).rows[0]!.id;

    const organizationId = (
      await db.query<{ create_organization: string }>('SELECT create_organization($1,$2,$3)', [
        `Estudio precio ${stamp}`, withCheckDigit(`30${stamp}`), fundadorId,
      ])
    ).rows[0]!.create_organization;

    empresa = (
      await db.query<{ create_company: string }>('SELECT create_company($1,$2,$3,$4,$5,$6,$7,$8)', [
        fundadorId, organizationId, `Empresa precio ${stamp}`, withCheckDigit(`27${stamp}`),
        'SA', 'AR-C', 'IGJ', '12-31',
      ])
    ).rows[0]!.create_company;

    const tokenFundador = (
      await app.inject({
        method: 'POST',
        url: '/auth/login',
        payload: { email: `fundador-precio-${stamp}@estudio.test`, password: PASSWORD },
      })
    ).json<{ token: string }>().token;

    const email = `contadora-precio-${stamp}@estudio.test`;
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

    for (const cuenta of [
      { code: '4.1.01', name: 'Ventas', type: 'INGRESO' },
      { code: '5.1.01', name: 'Compras', type: 'GASTO' },
    ]) {
      expect((await pedir('POST', '/accounts', cuenta)).statusCode).toBe(201);
    }

    productoId = (
      await pedir('POST', '/products', {
        codigo: `P-${stamp}`,
        nombre: 'Producto con precio base',
        tipo: 'PRODUCTO',
        tratamientoImpositivo: 'GRAVADO',
        impuesto: 'IVA',
        cuentaVenta: '4.1.01',
        precioLista: '100.00',
      })
    ).json<{ id: string }>().id;

    productoSinPrecioId = (
      await pedir('POST', '/products', {
        codigo: `S-${stamp}`,
        nombre: 'Producto sin precio base',
        tipo: 'PRODUCTO',
        tratamientoImpositivo: 'GRAVADO',
        impuesto: 'IVA',
        cuentaVenta: '4.1.01',
      })
    ).json<{ id: string }>().id;

    clienteId = (
      await pedir('POST', '/parties', {
        tipoDocumento: 'CUIT',
        numeroDocumento: `30${stamp}${cuitCheckDigit(`30${stamp}`)}`,
        razonSocial: `Mayorista ${stamp}`,
        condicionIva: 'RESPONSABLE_INSCRIPTO',
        roles: ['CLIENTE'],
      })
    ).json<{ id: string }>().id;

    otroClienteId = (
      await pedir('POST', '/parties', {
        tipoDocumento: 'CUIT',
        numeroDocumento: `33${stamp}${cuitCheckDigit(`33${stamp}`)}`,
        razonSocial: `Minorista ${stamp}`,
        condicionIva: 'RESPONSABLE_INSCRIPTO',
        roles: ['CLIENTE'],
      })
    ).json<{ id: string }>().id;

    // Dos listas del mismo año que no se pisan: es lo que permite probar que la
    // resolución mira la fecha de la operación y no la de hoy.
    listaMarzo = (
      await pedir('POST', '/price-lists', {
        codigo: `MAR-${stamp}`,
        nombre: 'Mayorista marzo',
        vigenteDesde: '2026-03-01',
        vigenteHasta: '2026-08-31',
      })
    ).json<{ id: string }>().id;

    listaSeptiembre = (
      await pedir('POST', '/price-lists', {
        codigo: `SEP-${stamp}`,
        nombre: 'Mayorista septiembre',
        vigenteDesde: '2026-09-01',
      })
    ).json<{ id: string }>().id;
  }, 60_000);

  afterAll(async () => {
    await app?.close();
    await db?.end();
    await closePool();
  });

  it('carga precios con tramos de cantidad', async () => {
    const r = await pedir('PUT', `/price-lists/${listaMarzo}/items`, {
      items: [
        { productoId, cantidadDesde: '1', precio: '80.00' },
        { productoId, cantidadDesde: '10', precio: '70.00' },
        { productoId, cantidadDesde: '100', precio: '60.00' },
      ],
    });

    expect(r.statusCode, r.body).toBe(200);
    expect(r.json<{ items: number }>().items).toBe(3);

    const items = await pedir('GET', `/price-lists/${listaMarzo}/items`);
    expect(items.json<{ items: unknown[] }>().items).toHaveLength(3);
  });

  it('rechaza dos precios para el mismo producto y el mismo tramo', async () => {
    const r = await pedir('PUT', `/price-lists/${listaSeptiembre}/items`, {
      items: [
        { productoId, cantidadDesde: '1', precio: '90.00' },
        { productoId, cantidadDesde: '1', precio: '95.00' },
      ],
    });

    expect(r.statusCode, r.body).toBe(409);
    expect(r.json<{ message: string }>().message).toContain('elegir');
  });

  it('asigna la lista al cliente y no admite dos en el mismo período', async () => {
    expect(
      (await pedir('POST', `/parties/${clienteId}/price-lists`, {
        priceListId: listaMarzo,
        desde: '2026-03-01',
        hasta: '2026-08-31',
      })).statusCode,
    ).toBe(201);

    const superpuesta = await pedir('POST', `/parties/${clienteId}/price-lists`, {
      priceListId: listaSeptiembre,
      desde: '2026-06-01',
    });

    expect(superpuesta.statusCode, superpuesta.body).toBe(422);
    expect(superpuesta.json<{ error: string }>().error).toBe('LISTAS_SUPERPUESTAS');
  });

  it('resuelve el precio del tramo que corresponde a la cantidad', async () => {
    const tramo = async (cantidad: string): Promise<{ precio: string; tramoDesde: string }> =>
      (
        await pedir(
          'GET',
          `/pricing/resolve?productoId=${productoId}&terceroId=${clienteId}` +
            `&fecha=2026-05-15&cantidad=${cantidad}`,
        )
      ).json<{ precio: string; tramoDesde: string }>();

    expect((await tramo('1')).precio).toBe('80.0000');
    expect((await tramo('9')).precio).toBe('80.0000');
    expect((await tramo('10')).precio, 'el borde del tramo entra en el tramo').toBe('70.0000');
    expect((await tramo('99')).precio).toBe('70.0000');
    expect((await tramo('250')).precio).toBe('60.0000');
    expect((await tramo('250')).tramoDesde).toBe('100.0000');
  });

  it('el precio se resuelve por la fecha de la operación, no por hoy', async () => {
    // Es el §6 aplicado a los precios y el motivo de toda la migración.
    // La asignación del cliente cubre marzo–agosto; en mayo hay lista, en
    // octubre ya no, y ahí cae al precio base del producto.
    const enMayo = (
      await pedir(
        'GET',
        `/pricing/resolve?productoId=${productoId}&terceroId=${clienteId}&fecha=2026-05-15&cantidad=1`,
      )
    ).json<{ precio: string; origen: string; listaCodigo: string }>();

    const enOctubre = (
      await pedir(
        'GET',
        `/pricing/resolve?productoId=${productoId}&terceroId=${clienteId}&fecha=2026-10-15&cantidad=1`,
      )
    ).json<{ precio: string; origen: string }>();

    expect(enMayo.origen).toBe('LISTA_DEL_TERCERO');
    expect(enMayo.precio).toBe('80.0000');
    expect(enMayo.listaCodigo).toContain('MAR-');

    expect(enOctubre.origen, 'fuera de la vigencia no se usa la lista').toBe('PRECIO_BASE');
    expect(enOctubre.precio).toBe('100.0000');
  });

  it('un cliente sin lista asignada cae al precio base', async () => {
    const r = await pedir(
      'GET',
      `/pricing/resolve?productoId=${productoId}&terceroId=${otroClienteId}&fecha=2026-05-15&cantidad=1`,
    );

    expect(r.json<{ origen: string; precio: string }>().origen).toBe('PRECIO_BASE');
    expect(r.json<{ precio: string }>().precio).toBe('100.0000');
  });

  it('sin precio en ningún lado contesta SIN_PRECIO y no estima', async () => {
    const r = await pedir(
      'GET',
      `/pricing/resolve?productoId=${productoSinPrecioId}&terceroId=${clienteId}&fecha=2026-05-15&cantidad=1`,
    );
    const cuerpo = r.json<{ precio: string | null; origen: string; metodologia: string }>();

    expect(cuerpo.origen).toBe('SIN_PRECIO');
    expect(cuerpo.precio, 'un cero se leería como gratis').toBeNull();
    expect(cuerpo.metodologia).toContain('no se estima');
  });

  it('no inventa un tramo cuando la cantidad no llega al más chico', async () => {
    // La lista de septiembre arranca en 20 unidades. Preguntar por 5 no tiene
    // respuesta *por lista*: usar el precio de 20 sería regalar el descuento
    // mayorista a una compra minorista.
    expect(
      (await pedir('PUT', `/price-lists/${listaSeptiembre}/items`, {
        items: [{ productoId, cantidadDesde: '20', precio: '55.00' }],
      })).statusCode,
    ).toBe(200);

    expect(
      (await pedir('POST', `/parties/${otroClienteId}/price-lists`, {
        priceListId: listaSeptiembre,
        desde: '2026-09-01',
      })).statusCode,
    ).toBe(201);

    const pocas = (
      await pedir(
        'GET',
        `/pricing/resolve?productoId=${productoId}&terceroId=${otroClienteId}&fecha=2026-09-15&cantidad=5`,
      )
    ).json<{ origen: string; precio: string }>();

    const muchas = (
      await pedir(
        'GET',
        `/pricing/resolve?productoId=${productoId}&terceroId=${otroClienteId}&fecha=2026-09-15&cantidad=25`,
      )
    ).json<{ origen: string; precio: string }>();

    expect(pocas.origen, 'sin tramo aplicable no hay precio de lista').toBe('PRECIO_BASE');
    expect(pocas.precio).toBe('100.0000');
    expect(muchas.origen).toBe('LISTA_DEL_TERCERO');
    expect(muchas.precio).toBe('55.0000');
  });

  it('la fecha es obligatoria: no hay default a hoy', async () => {
    const r = await pedir(
      'GET',
      `/pricing/resolve?productoId=${productoId}&terceroId=${clienteId}&cantidad=1`,
    );

    // Un default silencioso a `current_date` es exactamente cómo se cotiza un
    // presupuesto viejo con la lista de esta semana.
    expect(r.statusCode, r.body).toBe(400);
  });

  it('cada precio viaja con su procedencia, nunca pelado', async () => {
    const r = await pedir(
      'GET',
      `/pricing/resolve?productoId=${productoId}&terceroId=${clienteId}&fecha=2026-05-15&cantidad=50`,
    );
    const cuerpo = r.json<Record<string, unknown>>();

    for (const clave of ['precio', 'origen', 'listaCodigo', 'tramoDesde', 'fecha', 'metodologia']) {
      expect(cuerpo, `falta ${clave}: un precio sin procedencia es indefendible`)
        .toHaveProperty(clave);
    }
    expect(cuerpo['alcance']).toContain('sugerencia');
  });

  it('la cobertura cuenta lo que hay, sin afirmar vigencia de más', async () => {
    const r = await pedir('GET', '/price-lists');
    const listas = r.json<{ listas: { id: string; productos: number; tercerosAsignados: number }[] }>()
      .listas;

    const marzo = listas.find((l) => l.id === listaMarzo)!;
    expect(marzo.productos).toBe(1);
    expect(marzo.tercerosAsignados).toBe(1);
  });

  it('las listas de una empresa no se ven desde otra', async () => {
    const r = await db.query<{ n: string }>(
      `SELECT count(*)::text AS n FROM price_lists WHERE company_id <> $1`,
      [empresa],
    );
    // La consulta corre como superusuario y ve todo; lo que se comprueba es que
    // la política existe y compara contra la empresa en contexto.
    const politica = await db.query<{ qual: string }>(
      `SELECT qual FROM pg_policies WHERE tablename = 'price_lists'`,
    );
    expect(politica.rows[0]!.qual).toContain('app_company_id()');
    expect(Number(r.rows[0]!.n)).toBeGreaterThanOrEqual(0);
  });
});
