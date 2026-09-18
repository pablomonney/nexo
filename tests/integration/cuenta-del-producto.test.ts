/**
 * La cuenta que el producto declara, cuando el renglón es de ese producto.
 *
 * `products.sales_account_id` y `purchase_account_id` existían desde la 0048, se
 * escribían, se devolvían y **no las leía nadie**: fuera de `routes/products.ts`
 * no había un solo consumidor contable. Una empresa podía configurar con
 * cuidado a qué cuenta va cada producto y el asiento propuesto seguía mandando
 * todo el neto a la cuenta genérica del rol.
 *
 * ## Qué se fija acá
 *
 *   1. **Que la cuenta del producto se use** cuando el renglón dice qué producto
 *      es. Es el único caso en que el sistema sabe de qué objeto habla sin
 *      suponer nada: lo declaró quien cargó la factura.
 *   2. **Que lo que no resuelve caiga en la genérica**, exactamente como antes.
 *      Un comprobante sin detalle, un renglón sin producto y un producto sin
 *      cuenta son tres formas del mismo caso y las tres siguen andando igual.
 *   3. **Que una configuración inválida no produzca un renglón válido.**
 *      Archivada, de agrupación o de otra empresa: ninguna se usa, y las dos
 *      primeras además se avisan, porque el asiento sale bien y la
 *      configuración sigue rota.
 *   4. **Que dos productos en dos renglones no se pisen.** Cada uno a la suya,
 *      por su importe.
 *
 * ## Lo que este archivo NO prueba, porque no existe todavía
 *
 * No hay precedencia. Nada acá decide que el producto le gane a otra
 * configuración: el rol genérico nunca fue una declaración sobre un producto en
 * particular, así que no compite por ese renglón. La precedencia formal es de
 * otra fase y cuando exista tendrá sus propios tests.
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

interface Renglon {
  readonly accountCode: string;
  readonly debit: string;
  readonly credit: string;
}

interface Propuesta {
  readonly renglones: readonly Renglon[];
  readonly motivoSinRenglones: string | null;
  readonly rolesFaltantes: readonly string[];
  readonly advertenciasDeConfiguracion: readonly string[];
}

interface RenglonACargar {
  readonly productoId?: string;
  readonly descripcion: string;
  readonly cantidad: string;
  readonly precioUnitario: string;
  readonly tratamiento: 'GRAVADO';
  readonly neto: string;
  readonly iva: string;
}

suite('La cuenta del producto en el asiento propuesto', () => {
  let app: FastifyInstance;
  let db: Client;
  let stamp: string;
  let token: string;
  let empresa: string;
  let otraEmpresa: string;
  let cuitContraparte: string;
  let contraparteId: string;
  let numeroCbte = 41_000;

  /** Producto → id, para no repetir el alta en cada caso. */
  const producto: Record<string, string> = {};

  const pedir = (method: 'GET' | 'POST' | 'PUT' | 'PATCH', url: string, payload?: unknown) =>
    app.inject({
      method,
      url,
      headers: { authorization: `Bearer ${token}`, 'x-company-id': empresa },
      ...(payload === undefined ? {} : { payload }),
    });

  const hoy = new Date().toISOString().slice(0, 10);

  /** Un comprobante con su detalle, ya vinculado a la contraparte. */
  const comprobante = async (
    direccion: 'VENTAS' | 'COMPRAS',
    neto: string,
    iva: string,
    total: string,
    renglones: readonly RenglonACargar[],
  ): Promise<string> => {
    numeroCbte += 1;
    const forma =
      `--X\r\nContent-Disposition: form-data; name="file"; filename="prod-${stamp}-${numeroCbte}.xml"\r\n` +
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
    expect(subida.statusCode, subida.body).toBe(201);

    const alta = await pedir(
      'POST',
      `/documents/${subida.json<{ id: string }>().id}/tax-transaction`,
      {
        direction: direccion,
        cbteTipo: 1,
        puntoVenta: 1,
        numero: numeroCbte,
        fecha: hoy,
        cuitContraparte,
        razonSocial: 'Contraparte',
        condicionIva: 'RESPONSABLE_INSCRIPTO',
        neto,
        iva,
        noGravado: '0',
        exento: '0',
        percepciones: '0',
        total,
        ...(direccion === 'COMPRAS'
          ? {
              constatacionDeclarada: {
                resultado: 'OK',
                motivo: 'Verificado en el portal de ARCA con clave fiscal del cliente',
              },
            }
          : {}),
      },
    );
    expect(alta.statusCode, alta.body).toBe(201);
    const id = alta.json<{ taxTransactionId: string }>().taxTransactionId;

    expect(
      (await pedir('POST', `/tax-transactions/${id}/party`, { partyId: contraparteId })).statusCode,
    ).toBe(200);

    if (renglones.length > 0) {
      const r = await pedir('PUT', `/tax-transactions/${id}/lines`, { renglones });
      expect(r.statusCode, r.body).toBe(200);
    }
    return id;
  };

  const propuesta = async (id: string): Promise<Propuesta> => {
    const r = await pedir('GET', `/tax-transactions/${id}/asiento-propuesto`);
    expect(r.statusCode, r.body).toBe(200);
    return r.json<Propuesta>();
  };

  /** Los renglones de resultado: ni la contraparte ni el IVA. */
  const resultado = (p: Propuesta, ...excluidos: string[]): Renglon[] =>
    p.renglones.filter((r) => !excluidos.includes(r.accountCode));

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
          `fundador-prod-${stamp}@estudio.test`,
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
        `Estudio prod ${stamp}`,
        withCheckDigit(`30${stamp}`),
        fundadorId,
      ])
    ).rows[0]!.create_organization;

    empresa = (
      await db.query<{ create_company: string }>('SELECT create_company($1,$2,$3,$4,$5,$6,$7,$8)', [
        fundadorId, organizationId, `Empresa prod ${stamp}`, withCheckDigit(`27${stamp}`),
        'SA', 'AR-C', 'IGJ', '12-31',
      ])
    ).rows[0]!.create_company;

    // La segunda existe solo para el aislamiento: mismos códigos de cuenta,
    // otra empresa. Es la forma en que un error de `company_id` se notaría.
    otraEmpresa = (
      await db.query<{ create_company: string }>('SELECT create_company($1,$2,$3,$4,$5,$6,$7,$8)', [
        fundadorId, organizationId, `Empresa ajena ${stamp}`, withCheckDigit(`23${stamp}`),
        'SA', 'AR-C', 'IGJ', '12-31',
      ])
    ).rows[0]!.create_company;

    const tokenFundador = (
      await app.inject({
        method: 'POST',
        url: '/auth/login',
        payload: { email: `fundador-prod-${stamp}@estudio.test`, password: PASSWORD },
      })
    ).json<{ token: string }>().token;

    const email = `contadora-prod-${stamp}@estudio.test`;
    const userId = (
      await app.inject({
        method: 'POST',
        url: `/organizations/${organizationId}/users`,
        headers: { authorization: `Bearer ${tokenFundador}` },
        payload: { email, fullName: 'Contadora', password: PASSWORD, level: 'MEMBER' },
      })
    ).json<{ id: string }>().id;

    for (const companyId of [empresa, otraEmpresa]) {
      for (const role of ['CONTADOR', 'ADMINISTRADOR']) {
        await app.inject({
          method: 'POST',
          url: `/companies/${companyId}/roles`,
          headers: { authorization: `Bearer ${tokenFundador}` },
          payload: { userId, role },
        });
      }
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

    cuitContraparte = `30${stamp}${cuitCheckDigit(`30${stamp}`)}`;
    contraparteId = (
      await pedir('POST', '/parties', {
        tipoDocumento: 'CUIT',
        numeroDocumento: cuitContraparte,
        razonSocial: `Contraparte prod ${stamp}`,
        roles: ['CLIENTE', 'PROVEEDOR'],
      })
    ).json<{ id: string }>().id;

    const anio = new Date().getUTCFullYear();
    expect(
      (
        await pedir('POST', '/fiscal-years', {
          code: `EJ${anio}-${stamp}`,
          startDate: `${anio}-01-01`,
          endDate: `${anio}-12-31`,
        })
      ).statusCode,
    ).toBe(201);

    const cuentas = [
      { code: '1.1.02', name: 'Deudores por ventas', type: 'ACTIVO', requiresThirdParty: true },
      { code: '1.1.05', name: 'IVA crédito fiscal', type: 'ACTIVO' },
      { code: '2.1.01', name: 'Proveedores', type: 'PASIVO' },
      { code: '2.1.03', name: 'IVA débito fiscal', type: 'PASIVO' },
      { code: '4.1.01', name: 'Ventas', type: 'INGRESO' },
      { code: '4.1.02', name: 'Ventas de software', type: 'INGRESO' },
      { code: '4.1.03', name: 'Ventas de hardware', type: 'INGRESO' },
      { code: '4.1.09', name: 'Ventas de la linea discontinuada', type: 'INGRESO' },
      { code: '5.1.01', name: 'Compras', type: 'GASTO' },
      { code: '5.1.02', name: 'Compras de insumos', type: 'GASTO' },
      { code: '5.2', name: 'Servicios contratados', type: 'GASTO' },
    ];
    for (const cuenta of cuentas) {
      // Las mismas cuentas en las dos empresas: si la resolución mirara el
      // código y no la empresa, todo seguiría pasando y nada lo diría.
      for (const companyId of [empresa, otraEmpresa]) {
        const r = await app.inject({
          method: 'POST',
          url: '/accounts',
          headers: { authorization: `Bearer ${token}`, 'x-company-id': companyId },
          payload: cuenta,
        });
        expect(r.statusCode, `${cuenta.code} ${r.body}`).toBe(201);
      }
    }

    expect(
      (
        await pedir('PUT', '/accounting-map', {
          asignaciones: [
            { rol: 'CLIENTES', cuenta: '1.1.02' },
            { rol: 'IVA_DEBITO', cuenta: '2.1.03' },
            { rol: 'VENTAS', cuenta: '4.1.01' },
            { rol: 'PROVEEDORES', cuenta: '2.1.01' },
            { rol: 'IVA_CREDITO', cuenta: '1.1.05' },
            { rol: 'COMPRAS', cuenta: '5.1.01' },
          ],
        })
      ).statusCode,
    ).toBe(200);

    const altas = [
      { clave: 'software', codigo: `SOFT-${stamp}`, cuentaVenta: '4.1.02' },
      { clave: 'hardware', codigo: `HARD-${stamp}`, cuentaVenta: '4.1.03' },
      { clave: 'pelado', codigo: `PELADO-${stamp}` },
      { clave: 'discontinuado', codigo: `DISCO-${stamp}`, cuentaVenta: '4.1.09' },
      { clave: 'insumo', codigo: `INSU-${stamp}`, cuentaCompra: '5.1.02' },
      { clave: 'servicio', codigo: `SERV-${stamp}`, cuentaCompra: '5.2' },
    ];
    for (const alta of altas) {
      const r = await pedir('POST', '/products', {
        codigo: alta.codigo,
        nombre: alta.codigo,
        impuesto: 'IVA',
        ...(alta.cuentaVenta === undefined ? {} : { cuentaVenta: alta.cuentaVenta }),
        ...(alta.cuentaCompra === undefined ? {} : { cuentaCompra: alta.cuentaCompra }),
      });
      expect(r.statusCode, `${alta.codigo} ${r.body}`).toBe(201);
      producto[alta.clave] = r.json<{ id: string }>().id;
    }
  }, 120_000);

  afterAll(async () => {
    await app?.close();
    await db?.end();
    await closePool();
  });

  // ---------------------------------------------------------------------------
  // Caso A — la cuenta específica se usa
  // ---------------------------------------------------------------------------
  it('venta de un producto con cuenta propia: el neto va a esa cuenta', async () => {
    const id = await comprobante('VENTAS', '1000.00', '210.00', '1210.00', [
      {
        productoId: producto['software']!,
        descripcion: 'Licencia anual',
        cantidad: '1',
        precioUnitario: '1000.0000',
        tratamiento: 'GRAVADO',
        neto: '1000.00',
        iva: '210.00',
      },
    ]);

    const p = await propuesta(id);
    expect(p.motivoSinRenglones).toBeNull();
    expect(p.advertenciasDeConfiguracion).toEqual([]);
    expect(p.renglones).toEqual([
      { accountCode: '1.1.02', debit: '1210.00', credit: '0', descripcion: expect.any(String), partyId: contraparteId },
      { accountCode: '4.1.02', debit: '0', credit: '1000.00', descripcion: expect.any(String) },
      { accountCode: '2.1.03', debit: '0', credit: '210.00', descripcion: 'IVA débito fiscal' },
    ]);
    // Y no aparece la genérica: no quedó neto sin resolver.
    expect(p.renglones.map((r) => r.accountCode)).not.toContain('4.1.01');
  });

  it('compra de un producto con cuenta propia: el neto va a esa cuenta', async () => {
    const id = await comprobante('COMPRAS', '800.00', '168.00', '968.00', [
      {
        productoId: producto['insumo']!,
        descripcion: 'Resma de papel',
        cantidad: '10',
        precioUnitario: '80.0000',
        tratamiento: 'GRAVADO',
        neto: '800.00',
        iva: '168.00',
      },
    ]);

    const p = await propuesta(id);
    expect(p.motivoSinRenglones).toBeNull();
    expect(p.renglones.map((r) => r.accountCode)).toEqual(['5.1.02', '1.1.05', '2.1.01']);
    expect(p.renglones[0]).toMatchObject({ debit: '800.00', credit: '0' });
    expect(p.renglones[2]).toMatchObject({ debit: '0', credit: '968.00' });
  });

  // ---------------------------------------------------------------------------
  // Caso B — sin cuenta específica, todo sigue igual
  // ---------------------------------------------------------------------------
  it('producto sin cuenta configurada: cae en la genérica del rol', async () => {
    const id = await comprobante('VENTAS', '500.00', '105.00', '605.00', [
      {
        productoId: producto['pelado']!,
        descripcion: 'Cosa sin cuenta',
        cantidad: '1',
        precioUnitario: '500.0000',
        tratamiento: 'GRAVADO',
        neto: '500.00',
        iva: '105.00',
      },
    ]);

    const p = await propuesta(id);
    expect(resultado(await propuesta(id), '1.1.02', '2.1.03')).toEqual([
      { accountCode: '4.1.01', debit: '0', credit: '500.00', descripcion: expect.any(String) },
    ]);
    expect(p.advertenciasDeConfiguracion).toEqual([]);
  });

  it('comprobante sin detalle: se arma como antes de que esto existiera', async () => {
    const id = await comprobante('VENTAS', '700.00', '147.00', '847.00', []);

    const p = await propuesta(id);
    expect(p.renglones.map((r) => r.accountCode)).toEqual(['1.1.02', '4.1.01', '2.1.03']);
    expect(p.renglones[1]).toMatchObject({ debit: '0', credit: '700.00' });
  });

  it('un renglón con producto y otro sin producto: se reparte, y el resto va a la genérica', async () => {
    const id = await comprobante('VENTAS', '1500.00', '315.00', '1815.00', [
      {
        productoId: producto['software']!,
        descripcion: 'Licencia',
        cantidad: '1',
        precioUnitario: '1000.0000',
        tratamiento: 'GRAVADO',
        neto: '1000.00',
        iva: '210.00',
      },
      {
        descripcion: 'Flete, sin producto en el maestro',
        cantidad: '1',
        precioUnitario: '500.0000',
        tratamiento: 'GRAVADO',
        neto: '500.00',
        iva: '105.00',
      },
    ]);

    const p = await propuesta(id);
    expect(resultado(p, '1.1.02', '2.1.03')).toEqual([
      { accountCode: '4.1.02', debit: '0', credit: '1000.00', descripcion: expect.any(String) },
      { accountCode: '4.1.01', debit: '0', credit: '500.00', descripcion: expect.any(String) },
    ]);
  });

  // ---------------------------------------------------------------------------
  // Caso F — dos productos, dos cuentas
  // ---------------------------------------------------------------------------
  it('dos productos distintos: cada renglón conserva su cuenta y su importe', async () => {
    const id = await comprobante('VENTAS', '3000.00', '630.00', '3630.00', [
      {
        productoId: producto['software']!,
        descripcion: 'Licencia',
        cantidad: '1',
        precioUnitario: '1200.0000',
        tratamiento: 'GRAVADO',
        neto: '1200.00',
        iva: '252.00',
      },
      {
        productoId: producto['hardware']!,
        descripcion: 'Servidor',
        cantidad: '1',
        precioUnitario: '1800.0000',
        tratamiento: 'GRAVADO',
        neto: '1800.00',
        iva: '378.00',
      },
    ]);

    const p = await propuesta(id);
    expect(resultado(p, '1.1.02', '2.1.03')).toEqual([
      { accountCode: '4.1.02', debit: '0', credit: '1200.00', descripcion: expect.any(String) },
      { accountCode: '4.1.03', debit: '0', credit: '1800.00', descripcion: expect.any(String) },
    ]);
    // Y sigue cuadrando: el reparto no inventó ni perdió un peso.
    const suma = (lado: 'debit' | 'credit'): number =>
      p.renglones.reduce((a, r) => a + Number(r[lado]), 0);
    expect(suma('debit')).toBe(suma('credit'));
    expect(suma('debit')).toBe(3630);
  });

  it('dos renglones del mismo producto son un solo renglón contable', async () => {
    const id = await comprobante('VENTAS', '2000.00', '420.00', '2420.00', [
      {
        productoId: producto['hardware']!,
        descripcion: 'Servidor, primera partida',
        cantidad: '1',
        precioUnitario: '1200.0000',
        tratamiento: 'GRAVADO',
        neto: '1200.00',
        iva: '252.00',
      },
      {
        productoId: producto['hardware']!,
        descripcion: 'Servidor, segunda partida',
        cantidad: '1',
        precioUnitario: '800.0000',
        tratamiento: 'GRAVADO',
        neto: '800.00',
        iva: '168.00',
      },
    ]);

    const p = await propuesta(id);
    expect(resultado(p, '1.1.02', '2.1.03')).toEqual([
      { accountCode: '4.1.03', debit: '0', credit: '2000.00', descripcion: expect.any(String) },
    ]);
  });

  // ---------------------------------------------------------------------------
  // Caso C — archivada
  // ---------------------------------------------------------------------------
  it('una cuenta archivada no se puede configurar en un producto', async () => {
    const cuentaId = (
      await pedir('GET', '/accounts')
    ).json<{ accounts: { id: string; code: string }[] }>()
      .accounts.find((a) => a.code === '4.1.09')!.id;

    const archivado = await pedir('PATCH', `/accounts/${cuentaId}`, {
      status: 'ARCHIVED',
      motivo: 'Se discontinuo la linea de productos',
    });
    expect(archivado.statusCode, archivado.body).toBe(200);

    const r = await pedir('POST', '/products', {
      codigo: `TARDE-${stamp}`,
      nombre: 'Alta posterior al archivado',
      impuesto: 'IVA',
      cuentaVenta: '4.1.09',
    });
    expect(r.statusCode, r.body).toBe(422);
    expect(r.json<{ error: string }>().error).toBe('CUENTA_DE_VENTA_ARCHIVADA');
  });

  it('un producto cuya cuenta se archivó después: cae en la genérica y se avisa', async () => {
    // El producto quedó configurado cuando la cuenta estaba activa —el test
    // anterior la archivó—, que es el único camino real a este estado: el
    // disparador no puede impedir que se archive una cuenta ya configurada.
    const id = await comprobante('VENTAS', '400.00', '84.00', '484.00', [
      {
        productoId: producto['discontinuado']!,
        descripcion: 'Ultima unidad de la linea vieja',
        cantidad: '1',
        precioUnitario: '400.0000',
        tratamiento: 'GRAVADO',
        neto: '400.00',
        iva: '84.00',
      },
    ]);

    const p = await propuesta(id);
    expect(p.renglones.map((r) => r.accountCode)).not.toContain('4.1.09');
    expect(resultado(p, '1.1.02', '2.1.03')).toEqual([
      { accountCode: '4.1.01', debit: '0', credit: '400.00', descripcion: expect.any(String) },
    ]);
    expect(p.advertenciasDeConfiguracion).toHaveLength(1);
    expect(p.advertenciasDeConfiguracion[0]).toContain(`DISCO-${stamp}`);
    expect(p.advertenciasDeConfiguracion[0]).toContain('genérica');
  });

  // ---------------------------------------------------------------------------
  // Caso D — de agrupación
  // ---------------------------------------------------------------------------
  it('una cuenta de agrupación no se puede configurar en un producto', async () => {
    const r = await pedir('POST', '/products', {
      codigo: `AGRUP-${stamp}`,
      nombre: 'Apunta a una agrupadora',
      impuesto: 'IVA',
      // `5.2` deja de ser imputable en el test que sigue; acá se usa una que ya
      // lo es: `1.1.02` no sirve por tipo, así que se prueba con la que el
      // disparador rechaza por imputabilidad una vez que tiene hija.
      cuentaCompra: '5.2',
    });
    // Todavía es imputable: el alta pasa. Lo que sigue la convierte en rubro.
    expect(r.statusCode, r.body).toBe(201);

    const cuentas = (await pedir('GET', '/accounts')).json<{
      accounts: { id: string; code: string }[];
    }>().accounts;
    const padre = cuentas.find((a) => a.code === '5.2')!.id;

    // Colgarle una hija es lo que la vuelve de agrupación: lo hace el disparador
    // `accounts_parent_not_postable` de la 0003, no una edición manual.
    expect(
      (
        await pedir('POST', '/accounts', {
          code: '5.2.01',
          name: 'Honorarios',
          type: 'GASTO',
          parentId: padre,
        })
      ).statusCode,
    ).toBe(201);

    // Y desde ahora configurarla se rechaza.
    const tarde = await pedir('POST', '/products', {
      codigo: `AGRUP2-${stamp}`,
      nombre: 'Apunta a una agrupadora ya convertida',
      impuesto: 'IVA',
      cuentaCompra: '5.2',
    });
    expect(tarde.statusCode, tarde.body).toBe(422);
    expect(tarde.json<{ error: string }>().error).toBe('CUENTA_DE_COMPRA_INVALIDA');
  });

  it('un producto cuya cuenta pasó a ser de agrupación: cae en la genérica y se avisa', async () => {
    const id = await comprobante('COMPRAS', '600.00', '126.00', '726.00', [
      {
        productoId: producto['servicio']!,
        descripcion: 'Servicio contratado',
        cantidad: '1',
        precioUnitario: '600.0000',
        tratamiento: 'GRAVADO',
        neto: '600.00',
        iva: '126.00',
      },
    ]);

    const p = await propuesta(id);
    expect(p.renglones.map((r) => r.accountCode)).not.toContain('5.2');
    expect(resultado(p, '2.1.01', '1.1.05')).toEqual([
      { accountCode: '5.1.01', debit: '600.00', credit: '0', descripcion: expect.any(String) },
    ]);
    expect(p.advertenciasDeConfiguracion).toHaveLength(1);
    expect(p.advertenciasDeConfiguracion[0]).toContain(`SERV-${stamp}`);
  });

  // ---------------------------------------------------------------------------
  // Caso E — otra empresa
  // ---------------------------------------------------------------------------
  it('un producto no puede apuntar a la cuenta de otra empresa', async () => {
    const ajena = (
      await db.query<{ id: string }>(
        `SELECT id FROM accounts WHERE company_id = $1 AND code = '4.1.02'`,
        [otraEmpresa],
      )
    ).rows[0]!.id;
    const propia = (
      await db.query<{ id: string }>(
        `SELECT id FROM products WHERE company_id = $1 AND code = $2`,
        [empresa, `SOFT-${stamp}`],
      )
    ).rows[0]!.id;

    // Por la ruta ni siquiera se puede intentar: la cuenta llega por código y se
    // resuelve dentro de la empresa. Así que se intenta por SQL, que es el único
    // camino que podría producir la fila — y la clave foránea compuesta de la
    // 0048 lo impide.
    await expect(
      db.query('UPDATE products SET sales_account_id = $1 WHERE id = $2', [ajena, propia]),
    ).rejects.toThrow(/products_cuenta_venta_fk|foreign key|llave foránea/iu);
  });

  it('el mismo código de cuenta en dos empresas resuelve al de cada una', async () => {
    // Las dos empresas tienen `4.1.02`. Si la resolución mirara el código en vez
    // de la fila, este test seguiría pasando por casualidad: lo que lo hace
    // valer es que la cuenta que se usa sea la fila de ESTA empresa.
    const id = await comprobante('VENTAS', '900.00', '189.00', '1089.00', [
      {
        productoId: producto['software']!,
        descripcion: 'Licencia',
        cantidad: '1',
        precioUnitario: '900.0000',
        tratamiento: 'GRAVADO',
        neto: '900.00',
        iva: '189.00',
      },
    ]);

    const p = await propuesta(id);
    const usada = resultado(p, '1.1.02', '2.1.03')[0]!.accountCode;
    expect(usada).toBe('4.1.02');

    const fila = await db.query<{ company_id: string }>(
      `SELECT a.company_id
         FROM products p JOIN accounts a ON a.id = p.sales_account_id
        WHERE p.id = $1`,
      [producto['software']!],
    );
    expect(fila.rows[0]!.company_id).toBe(empresa);
  });

  it('la otra empresa no ve ni un renglón de esta', async () => {
    const ajena = await app.inject({
      method: 'GET',
      url: '/products',
      headers: { authorization: `Bearer ${token}`, 'x-company-id': otraEmpresa },
    });
    expect(ajena.statusCode).toBe(200);
    expect(ajena.json<{ productos: unknown[] }>().productos).toEqual([]);
  });
});
