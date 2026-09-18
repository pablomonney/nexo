/**
 * El circuito contable completo, de la operación al Mayor.
 *
 * Los otros archivos prueban piezas: `cuenta-del-producto` prueba la
 * resolución, `aprendizaje-solo-cuentas-validas` prueba el aprendizaje,
 * `mapeo-contable` prueba la declaración. Éste prueba que el circuito **cierre**,
 * y sobre todo las tres cosas que solo se ven mirándolo entero:
 *
 *   1. **Que la dirección del asiento salga de la clase del comprobante.** Una
 *      nota de crédito de ventas no es una venta: deshace una. Hasta ahora
 *      `asiento-propuesto` no leía `cbte_tipo` y proponía las notas de crédito
 *      con la dirección de una factura. El asiento salía cuadrado y al revés,
 *      que es la peor combinación: pasa todos los controles.
 *
 *   2. **Que una configuración que dejó de servir no llegue al asiento.** Ni la
 *      del producto ni la del rol. Las dos se pueden romper después de
 *      declaradas, porque lo que cambia es la cuenta y no la configuración.
 *
 *   3. **Que proponer no sea registrar.** La propuesta no tiene número, no está
 *      en ningún libro y no mueve un saldo hasta que una persona la carga y otra
 *      la aprueba.
 *
 * ## Por qué los importes de los renglones son siempre positivos
 *
 * `journal_entry_lines` tiene `CHECK (debit >= 0)` y `CHECK (credit >= 0)` desde
 * la 0005. Invertir una operación es cambiar de lado, no poner un menos. Si
 * alguna vez apareciera un importe negativo acá, el asiento no entraría al
 * Diario — así que se comprueba en cada caso.
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

/** Los códigos de ARCA que la base ya trae sembrados, con su clase. */
const FACTURA_A = 1;
const NOTA_DEBITO_A = 2;
const NOTA_CREDITO_A = 3;
/** Fuera del catálogo: su clase no se puede resolver. */
const TIPO_INVENTADO = 997;

interface Renglon {
  readonly accountCode: string;
  readonly debit: string;
  readonly credit: string;
  readonly descripcion: string;
  readonly partyId?: string;
}

interface Propuesta {
  readonly fecha: string;
  readonly descripcion: string;
  readonly renglones: readonly Renglon[];
  readonly motivoSinRenglones: string | null;
  readonly rolesFaltantes: readonly string[];
  readonly advertenciasDeConfiguracion: readonly string[];
  readonly justificacionSugerida: string | null;
  readonly asientoExistente: string | null;
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

suite('El circuito contable, de la operación al Mayor', () => {
  let app: FastifyInstance;
  let db: Client;
  let stamp: string;
  let token: string;
  let empresa: string;
  let otraEmpresa: string;
  let cuitContraparte: string;
  let contraparteId: string;
  let numeroCbte = 61_000;
  const producto: Record<string, string> = {};

  const cab = (companyId = empresa) => ({
    authorization: `Bearer ${token}`,
    'x-company-id': companyId,
  });

  const pedir = (
    method: 'GET' | 'POST' | 'PUT' | 'PATCH',
    url: string,
    payload?: unknown,
    companyId?: string,
  ) =>
    app.inject({
      method,
      url,
      headers: cab(companyId),
      ...(payload === undefined ? {} : { payload }),
    });

  const hoy = new Date().toISOString().slice(0, 10);

  const comprobante = async (
    direccion: 'VENTAS' | 'COMPRAS',
    cbteTipo: number,
    importes: { neto: string; iva: string; total: string; percepciones?: string },
    renglones: readonly RenglonACargar[] = [],
  ): Promise<string> => {
    numeroCbte += 1;
    const forma =
      `--X\r\nContent-Disposition: form-data; name="file"; filename="circ-${stamp}-${numeroCbte}.xml"\r\n` +
      `Content-Type: application/xml\r\n\r\n<comprobante><n>${numeroCbte}</n></comprobante>\r\n--X--\r\n`;

    const subida = await app.inject({
      method: 'POST',
      url: '/documents',
      headers: { ...cab(), 'content-type': 'multipart/form-data; boundary=X' },
      payload: forma,
    });
    expect(subida.statusCode, subida.body).toBe(201);

    const alta = await pedir(
      'POST',
      `/documents/${subida.json<{ id: string }>().id}/tax-transaction`,
      {
        direction: direccion,
        cbteTipo,
        puntoVenta: 1,
        numero: numeroCbte,
        fecha: hoy,
        cuitContraparte,
        razonSocial: 'Contraparte',
        condicionIva: 'RESPONSABLE_INSCRIPTO',
        neto: importes.neto,
        iva: importes.iva,
        noGravado: '0',
        exento: '0',
        percepciones: importes.percepciones ?? '0',
        total: importes.total,
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

  /** Debe y haber de una propuesta, en centavos, desde los renglones mismos. */
  const sumas = (p: Propuesta): { debe: number; haber: number } => ({
    debe: p.renglones.reduce((a, r) => a + Math.round(Number(r.debit) * 100), 0),
    haber: p.renglones.reduce((a, r) => a + Math.round(Number(r.credit) * 100), 0),
  });

  /** Lo que todo asiento propuesto tiene que cumplir, sin importar el caso. */
  const cuadraYEsPositivo = (p: Propuesta): void => {
    const { debe, haber } = sumas(p);
    expect(debe, 'el debe no iguala al haber').toBe(haber);
    for (const r of p.renglones) {
      expect(Number(r.debit), `${r.accountCode} con débito negativo`).toBeGreaterThanOrEqual(0);
      expect(Number(r.credit), `${r.accountCode} con crédito negativo`).toBeGreaterThanOrEqual(0);
      // Un renglón es de un lado o del otro, nunca de los dos: `jel_one_side`.
      expect(
        Number(r.debit) === 0 || Number(r.credit) === 0,
        `${r.accountCode} tiene débito y crédito a la vez`,
      ).toBe(true);
    }
  };

  const ladoDe = (p: Propuesta, codigo: string): 'DEBE' | 'HABER' => {
    const r = p.renglones.find((x) => x.accountCode === codigo);
    expect(r, `no hay renglón de ${codigo}`).toBeDefined();
    return Number(r!.debit) > 0 ? 'DEBE' : 'HABER';
  };

  const cuentaId = async (codigo: string, companyId = empresa): Promise<string> => {
    const r = await db.query<{ id: string }>(
      'SELECT id FROM accounts WHERE company_id = $1 AND code = $2',
      [companyId, codigo],
    );
    return r.rows[0]!.id;
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
          `fundador-circ-${stamp}@estudio.test`,
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
        `Estudio circ ${stamp}`,
        withCheckDigit(`30${stamp}`),
        fundadorId,
      ])
    ).rows[0]!.create_organization;

    empresa = (
      await db.query<{ create_company: string }>('SELECT create_company($1,$2,$3,$4,$5,$6,$7,$8)', [
        fundadorId, organizationId, `Empresa circ ${stamp}`, withCheckDigit(`27${stamp}`),
        'SA', 'AR-C', 'IGJ', '12-31',
      ])
    ).rows[0]!.create_company;

    otraEmpresa = (
      await db.query<{ create_company: string }>('SELECT create_company($1,$2,$3,$4,$5,$6,$7,$8)', [
        fundadorId, organizationId, `Empresa circ ajena ${stamp}`, withCheckDigit(`23${stamp}`),
        'SA', 'AR-C', 'IGJ', '12-31',
      ])
    ).rows[0]!.create_company;

    const tokenFundador = (
      await app.inject({
        method: 'POST',
        url: '/auth/login',
        payload: { email: `fundador-circ-${stamp}@estudio.test`, password: PASSWORD },
      })
    ).json<{ token: string }>().token;

    const email = `contadora-circ-${stamp}@estudio.test`;
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
        razonSocial: `Contraparte circ ${stamp}`,
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
      { code: '4.1.08', name: 'Ventas a reemplazar', type: 'INGRESO' },
      { code: '5.1.01', name: 'Compras', type: 'GASTO' },
      { code: '5.1.02', name: 'Compras de insumos', type: 'GASTO' },
    ];
    for (const cuenta of cuentas) {
      for (const companyId of [empresa, otraEmpresa]) {
        const r = await pedir('POST', '/accounts', cuenta, companyId);
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

    for (const alta of [
      { clave: 'software', codigo: `SOFT-${stamp}`, cuentaVenta: '4.1.02' },
      { clave: 'insumo', codigo: `INSU-${stamp}`, cuentaCompra: '5.1.02' },
    ]) {
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

  // ==========================================================================
  // Dirección económica según la clase del comprobante
  // ==========================================================================
  describe('La clase del comprobante decide para qué lado va el asiento', () => {
    it('factura de venta: el cliente debe, la venta y el IVA van al haber', async () => {
      const id = await comprobante('VENTAS', FACTURA_A, {
        neto: '1000.00', iva: '210.00', total: '1210.00',
      });
      const p = await propuesta(id);

      expect(p.motivoSinRenglones).toBeNull();
      expect(ladoDe(p, '1.1.02')).toBe('DEBE');
      expect(ladoDe(p, '4.1.01')).toBe('HABER');
      expect(ladoDe(p, '2.1.03')).toBe('HABER');
      expect(p.descripcion).toContain('Venta');
      cuadraYEsPositivo(p);
    });

    it('nota de crédito de venta: se invierte entero', async () => {
      // Es el defecto que esta fase cierra. Antes salía igual que una factura:
      // débito a Deudores por una venta que se está deshaciendo.
      const id = await comprobante('VENTAS', NOTA_CREDITO_A, {
        neto: '1000.00', iva: '210.00', total: '1210.00',
      });
      const p = await propuesta(id);

      expect(p.motivoSinRenglones).toBeNull();
      expect(ladoDe(p, '1.1.02')).toBe('HABER');
      expect(ladoDe(p, '4.1.01')).toBe('DEBE');
      expect(ladoDe(p, '2.1.03')).toBe('DEBE');
      expect(p.descripcion).toContain('Nota de crédito de venta');
      cuadraYEsPositivo(p);
    });

    it('nota de débito de venta: va igual que una factura, sin caso especial', async () => {
      // Una nota de débito aumenta lo mismo que aumenta una factura. No hay un
      // `if` para ella: `signoDe` le da el mismo signo, y eso alcanza.
      const id = await comprobante('VENTAS', NOTA_DEBITO_A, {
        neto: '500.00', iva: '105.00', total: '605.00',
      });
      const p = await propuesta(id);

      expect(ladoDe(p, '1.1.02')).toBe('DEBE');
      expect(ladoDe(p, '4.1.01')).toBe('HABER');
      expect(p.descripcion).toContain('Nota de débito de venta');
      cuadraYEsPositivo(p);
    });

    it('factura de compra: se le debe al proveedor', async () => {
      const id = await comprobante('COMPRAS', FACTURA_A, {
        neto: '800.00', iva: '168.00', total: '968.00',
      });
      const p = await propuesta(id);

      expect(ladoDe(p, '2.1.01')).toBe('HABER');
      expect(ladoDe(p, '5.1.01')).toBe('DEBE');
      expect(ladoDe(p, '1.1.05')).toBe('DEBE');
      cuadraYEsPositivo(p);
    });

    it('nota de crédito de compra: ya no se le debe', async () => {
      const id = await comprobante('COMPRAS', NOTA_CREDITO_A, {
        neto: '800.00', iva: '168.00', total: '968.00',
      });
      const p = await propuesta(id);

      expect(ladoDe(p, '2.1.01')).toBe('DEBE');
      expect(ladoDe(p, '5.1.01')).toBe('HABER');
      expect(ladoDe(p, '1.1.05')).toBe('HABER');
      expect(p.descripcion).toContain('Nota de crédito de compra');
      cuadraYEsPositivo(p);
    });

    it('nota de débito de compra: va igual que una factura de compra', async () => {
      const id = await comprobante('COMPRAS', NOTA_DEBITO_A, {
        neto: '300.00', iva: '63.00', total: '363.00',
      });
      const p = await propuesta(id);

      expect(ladoDe(p, '2.1.01')).toBe('HABER');
      expect(ladoDe(p, '5.1.01')).toBe('DEBE');
      cuadraYEsPositivo(p);
    });

    it('la cuenta del producto también se invierte en una nota de crédito', async () => {
      // La resolución de cuentas y la dirección son dos cosas distintas y tienen
      // que componerse: la cuenta la elige el producto, el lado lo elige la
      // clase.
      const id = await comprobante(
        'VENTAS',
        NOTA_CREDITO_A,
        { neto: '900.00', iva: '189.00', total: '1089.00' },
        [
          {
            productoId: producto['software']!,
            descripcion: 'Licencia devuelta',
            cantidad: '1',
            precioUnitario: '900.0000',
            tratamiento: 'GRAVADO',
            neto: '900.00',
            iva: '189.00',
          },
        ],
      );
      const p = await propuesta(id);

      expect(p.renglones.map((r) => r.accountCode)).toContain('4.1.02');
      expect(ladoDe(p, '4.1.02')).toBe('DEBE');
      expect(ladoDe(p, '1.1.02')).toBe('HABER');
      cuadraYEsPositivo(p);
    });

    it('un tipo que no está en el catálogo no se propone', async () => {
      const id = await comprobante('VENTAS', TIPO_INVENTADO, {
        neto: '100.00', iva: '21.00', total: '121.00',
      });
      const p = await propuesta(id);

      expect(p.renglones).toEqual([]);
      expect(p.motivoSinRenglones).toContain('catálogo de ARCA');
      expect(p.motivoSinRenglones).toContain('chance en dos');
      expect(p.descripcion).toContain('Comprobante');
    });
  });

  // ==========================================================================
  // Integridad del asiento propuesto
  // ==========================================================================
  describe('El asiento propuesto es matemáticamente válido', () => {
    it('las percepciones siguen impidiendo la propuesta', async () => {
      // No cambió en esta fase y no debe cambiar: meterlas en la cuenta de
      // ventas para que el total cierre da un asiento cuadrado y falso.
      const id = await comprobante('VENTAS', FACTURA_A, {
        neto: '1000.00', iva: '210.00', percepciones: '30.00', total: '1240.00',
      });
      const p = await propuesta(id);

      expect(p.renglones).toEqual([]);
      expect(p.motivoSinRenglones).toContain('percepciones');
    });

    it('un detalle que no cierra contra la cabecera lo rechaza la base', async () => {
      // El candado de la 0049 es un CONSTRAINT TRIGGER diferido: falla al
      // COMMIT, no al insertar. Es la garantía sobre la que se apoya el reparto
      // del neto entre varias cuentas.
      const id = await comprobante('VENTAS', FACTURA_A, {
        neto: '1000.00', iva: '210.00', total: '1210.00',
      });
      const r = await pedir('PUT', `/tax-transactions/${id}/lines`, {
        renglones: [
          {
            productoId: producto['software']!,
            descripcion: 'Licencia mal cargada',
            cantidad: '1',
            precioUnitario: '600.0000',
            tratamiento: 'GRAVADO',
            neto: '600.00',
            iva: '126.00',
          },
        ],
      });
      expect(r.statusCode, r.body).toBeGreaterThanOrEqual(400);
    });

    it('el reparto entre varias cuentas suma exactamente el neto', async () => {
      const id = await comprobante(
        'VENTAS',
        FACTURA_A,
        { neto: '1500.00', iva: '315.00', total: '1815.00' },
        [
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
            descripcion: 'Soporte, sin producto',
            cantidad: '1',
            precioUnitario: '500.0000',
            tratamiento: 'GRAVADO',
            neto: '500.00',
            iva: '105.00',
          },
        ],
      );
      const p = await propuesta(id);

      const resultado = p.renglones.filter((r) => r.accountCode.startsWith('4.'));
      expect(resultado.map((r) => r.accountCode)).toEqual(['4.1.02', '4.1.01']);
      expect(resultado.reduce((a, r) => a + Number(r.credit), 0)).toBe(1500);
      cuadraYEsPositivo(p);
    });
  });

  // ==========================================================================
  // Configuración que dejó de servir
  // ==========================================================================
  describe('Una configuración rota no llega al asiento', () => {
    it('un rol declarado contra una cuenta archivada no se usa, y se avisa', async () => {
      // Se declara el rol contra `4.1.08` estando activa, y después se archiva:
      // es el único camino real, porque el disparador de la 0130 impide
      // declararla ya archivada.
      expect(
        (
          await pedir('PUT', '/accounting-map', {
            asignaciones: [{ rol: 'VENTAS', cuenta: '4.1.08' }],
          })
        ).statusCode,
      ).toBe(200);

      const archivado = await pedir('PATCH', `/accounts/${await cuentaId('4.1.08')}`, {
        status: 'ARCHIVED',
        motivo: 'Se reemplaza por otra cuenta de ventas',
      });
      expect(archivado.statusCode, archivado.body).toBe(200);

      const id = await comprobante('VENTAS', FACTURA_A, {
        neto: '400.00', iva: '84.00', total: '484.00',
      });
      const p = await propuesta(id);

      // No se propone, y no porque falte declararlo: está declarado y no sirve.
      expect(p.renglones).toEqual([]);
      expect(p.rolesFaltantes).toContain('VENTAS');
      expect(p.advertenciasDeConfiguracion.some((a) => a.includes('4.1.08'))).toBe(true);
      expect(p.advertenciasDeConfiguracion.some((a) => a.includes('archivada'))).toBe(true);

      // Se repara volviendo a declarar el rol, y el circuito sigue.
      expect(
        (
          await pedir('PUT', '/accounting-map', {
            asignaciones: [{ rol: 'VENTAS', cuenta: '4.1.01' }],
          })
        ).statusCode,
      ).toBe(200);
      const reparada = await propuesta(id);
      expect(reparada.renglones.map((r) => r.accountCode)).toContain('4.1.01');
      cuadraYEsPositivo(reparada);
    });

    it('declarar un rol contra una cuenta archivada se rechaza', async () => {
      const r = await pedir('PUT', '/accounting-map', {
        asignaciones: [{ rol: 'VENTAS', cuenta: '4.1.08' }],
      });
      expect(r.statusCode, r.body).toBe(422);
      expect(r.json<{ error: string }>().error).toBe('CUENTA_ARCHIVADA');
    });

    it('ninguna cuenta no imputable ni archivada aparece en una propuesta', async () => {
      const id = await comprobante('VENTAS', FACTURA_A, {
        neto: '250.00', iva: '52.50', total: '302.50',
      });
      const p = await propuesta(id);
      expect(p.renglones.length).toBeGreaterThan(0);

      for (const r of p.renglones) {
        const fila = await db.query<{ is_postable: boolean; status: string }>(
          'SELECT is_postable, status FROM accounts WHERE company_id = $1 AND code = $2',
          [empresa, r.accountCode],
        );
        expect(fila.rows[0]!.is_postable, `${r.accountCode} no es imputable`).toBe(true);
        expect(fila.rows[0]!.status, `${r.accountCode} está archivada`).toBe('ACTIVE');
      }
    });
  });

  // ==========================================================================
  // Proponer no es registrar
  // ==========================================================================
  describe('Proponer y registrar son dos actos distintos', () => {
    it('pedir la propuesta no crea ningún asiento', async () => {
      const id = await comprobante('VENTAS', FACTURA_A, {
        neto: '2000.00', iva: '420.00', total: '2420.00',
      });

      const antes = await db.query<{ n: string }>(
        'SELECT count(*)::text AS n FROM journal_entries WHERE company_id = $1',
        [empresa],
      );
      const p = await propuesta(id);
      expect(p.renglones.length).toBe(3);
      expect(p.asientoExistente).toBeNull();
      const despues = await db.query<{ n: string }>(
        'SELECT count(*)::text AS n FROM journal_entries WHERE company_id = $1',
        [empresa],
      );

      expect(despues.rows[0]!.n).toBe(antes.rows[0]!.n);
    });

    it('la propuesta se carga por el camino de siempre, entra en borrador y la aprueba una persona', async () => {
      const id = await comprobante('VENTAS', FACTURA_A, {
        neto: '3000.00', iva: '630.00', total: '3630.00',
      });
      const p = await propuesta(id);

      const creado = await pedir('POST', '/journal-entries', {
        journalCode: 'VENTAS',
        entryDate: p.fecha,
        description: p.descripcion,
        lines: p.renglones.map((r) => ({
          accountCode: r.accountCode,
          debit: r.debit,
          credit: r.credit,
          ...(r.partyId === undefined ? {} : { partyId: r.partyId }),
          description: r.descripcion,
        })),
        source: { type: 'INVOICE', id },
        manualJustification: p.justificacionSugerida ?? 'Cargado por la contadora',
      });
      expect(creado.statusCode, creado.body).toBe(201);

      const asiento = creado.json<{ id: string; status: string }>();
      // Lo que importa no es el nombre del estado sino que NO sea `APROBADO`:
      // que NEXO lo haya propuesto no lo firma. La 0005 admite cuatro estados y
      // la aprobación es un acto aparte, con aprobador y fecha.
      expect(asiento.status).toBe('PROPUESTO');
      expect(asiento.status).not.toBe('APROBADO');

      const enBase = await db.query<{
        status: string;
        total_debit: string;
        total_credit: string;
        approved_by: string | null;
      }>(
        `SELECT status, total_debit::text, total_credit::text, approved_by
           FROM journal_entries WHERE id = $1`,
        [asiento.id],
      );
      expect(enBase.rows[0]!.status).toBe('PROPUESTO');
      expect(enBase.rows[0]!.approved_by).toBeNull();
      expect(enBase.rows[0]!.total_debit).toBe(enBase.rows[0]!.total_credit);
      expect(enBase.rows[0]!.total_debit).toBe('3630.00');

      // Y ahora el comprobante sí dice que tiene asiento: la segunda propuesta
      // avisa en vez de invitar a duplicarlo.
      expect((await propuesta(id)).asientoExistente).toBe(asiento.id);
    });

    it('una nota de crédito cargada como asiento entra invertida y cuadra en el Mayor', async () => {
      const id = await comprobante('VENTAS', NOTA_CREDITO_A, {
        neto: '1000.00', iva: '210.00', total: '1210.00',
      });
      const p = await propuesta(id);

      const creado = await pedir('POST', '/journal-entries', {
        journalCode: 'VENTAS',
        entryDate: p.fecha,
        description: p.descripcion,
        lines: p.renglones.map((r) => ({
          accountCode: r.accountCode,
          debit: r.debit,
          credit: r.credit,
          ...(r.partyId === undefined ? {} : { partyId: r.partyId }),
          description: r.descripcion,
        })),
        source: { type: 'INVOICE', id },
        manualJustification: 'Nota de crédito revisada y aceptada por quien la carga',
      });
      expect(creado.statusCode, creado.body).toBe(201);

      const lineas = await db.query<{ code: string; debit: string; credit: string }>(
        `SELECT a.code, l.debit::text, l.credit::text
           FROM journal_entry_lines l JOIN accounts a ON a.id = l.account_id
          WHERE l.entry_id = $1 ORDER BY l.line_no`,
        [creado.json<{ id: string }>().id],
      );
      const deudores = lineas.rows.find((l) => l.code === '1.1.02')!;
      expect(Number(deudores.credit)).toBe(1210);
      expect(Number(deudores.debit)).toBe(0);
    });
  });

  // ==========================================================================
  // Sugerencia, decisión y registración siguen separadas
  // ==========================================================================
  describe('El aprendizaje y la IA sugieren, no registran', () => {
    it('la IA está deshabilitada y el circuito de asiento funciona igual', async () => {
      // No hay endpoint que informe el estado del proveedor, así que se
      // comprueba donde vive: la configuración que el arranque evalúa.
      const { config } = await import('@aai/api/config');
      const { estadoDelProveedor } = await import('@aai/api/ai/proveedor');
      expect(estadoDelProveedor(config.ai)).toBe('DESHABILITADO');

      const id = await comprobante('VENTAS', FACTURA_A, {
        neto: '700.00', iva: '147.00', total: '847.00',
      });
      const p = await propuesta(id);
      expect(p.renglones.length).toBe(3);
      cuadraYEsPositivo(p);
    });

    it('una preferencia aprendida no escribe en el Mayor ni aparece en la propuesta', async () => {
      // Se aprende una cuenta distinta de la del mapeo para la misma empresa. Si
      // el aprendizaje tuviera autoridad contable, la propuesta la usaría.
      const antes = await db.query<{ n: string }>(
        'SELECT count(*)::text AS n FROM journal_entry_lines WHERE company_id = $1',
        [empresa],
      );

      await db.query(
        `INSERT INTO classification_preferences
           (company_id, signal, suggested_account_id, support_count, last_confirmed_at)
         VALUES ($1, $2, $3, 99, now())`,
        [empresa, `proveedor:${cuitContraparte}`, await cuentaId('4.1.02')],
      );

      const id = await comprobante('VENTAS', FACTURA_A, {
        neto: '600.00', iva: '126.00', total: '726.00',
      });
      const p = await propuesta(id);

      // La propuesta usa la cuenta del rol, no la aprendida.
      expect(p.renglones.map((r) => r.accountCode)).toContain('4.1.01');
      expect(p.renglones.map((r) => r.accountCode)).not.toContain('4.1.02');

      const despues = await db.query<{ n: string }>(
        'SELECT count(*)::text AS n FROM journal_entry_lines WHERE company_id = $1',
        [empresa],
      );
      expect(despues.rows[0]!.n).toBe(antes.rows[0]!.n);
    });
  });

  // ==========================================================================
  // Multiempresa
  // ==========================================================================
  describe('Ninguna cuenta de otra empresa entra en un asiento de ésta', () => {
    it('las cuentas propuestas son todas de esta empresa', async () => {
      const id = await comprobante('VENTAS', FACTURA_A, {
        neto: '150.00', iva: '31.50', total: '181.50',
      });
      const p = await propuesta(id);

      for (const r of p.renglones) {
        const fila = await db.query<{ n: string }>(
          'SELECT count(*)::text AS n FROM accounts WHERE company_id = $1 AND code = $2',
          [empresa, r.accountCode],
        );
        expect(fila.rows[0]!.n, `${r.accountCode} no es de esta empresa`).toBe('1');
      }
    });

    it('la otra empresa no ve este comprobante', async () => {
      const id = await comprobante('VENTAS', FACTURA_A, {
        neto: '100.00', iva: '21.00', total: '121.00',
      });
      const ajena = await pedir(
        'GET',
        `/tax-transactions/${id}/asiento-propuesto`,
        undefined,
        otraEmpresa,
      );
      expect(ajena.statusCode).toBe(404);
    });

    it('un rol no se puede declarar contra la cuenta de otra empresa', async () => {
      // Lo impide la clave foránea compuesta `cam_cuenta_fk` de la 0074, antes
      // de que el disparador llegue a mirar nada. Se prueba por SQL porque por
      // la ruta no se puede ni intentar: la cuenta llega por código y se
      // resuelve dentro de la empresa.
      const ajena = await cuentaId('4.1.01', otraEmpresa);
      await expect(
        db.query(
          `INSERT INTO company_account_map (company_id, rol, account_id, declarado_por)
           VALUES ($1, 'VENTAS', $2, 'test')
           ON CONFLICT (company_id, rol) DO UPDATE SET account_id = EXCLUDED.account_id`,
          [empresa, ajena],
        ),
      ).rejects.toThrow(/cam_cuenta_fk|foreign key|llave foránea/iu);
    });
  });
});
