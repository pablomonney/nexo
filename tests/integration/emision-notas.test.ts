/**
 * E6 — una nota de crédito o de débito corrige un comprobante AUTORIZADO, y la base lo exige (migración 0139).
 *
 * Lo que se afirma contra PostgreSQL:
 *
 *   1. Una nota sin comprobante asociado no se puede declarar; una factura con comprobante asociado, tampoco.
 *   2. El asociado tiene que estar **AUTORIZADO**: no se corrige lo que todavía no existe ni lo que quedó en duda.
 *   3. Tiene que ser una **factura o una nota de débito** (no una nota de crédito) **de la misma letra**.
 *   4. Tiene que ser de la **misma empresa y el mismo ambiente**.
 *   5. El asociado no se cambia después.
 *   6. De punta a punta: el caso de uso emite una nota de crédito que lleva su `CbtesAsoc`, con la base real y ARCA simulado.
 */

import { closePool, initPool } from '@aai/db';
import { RepositorioSqlDeEmision } from '@aai/api/fiscal/repositorio-de-emision';
import {
  armarComprobante,
  emitirIntencion,
  type DetalleComprobante,
  type RepositorioDeEmision,
  type RespuestaLote,
  type TransporteDeEmision,
} from '@aai/arca-emision';
import { withCheckDigit } from '@aai/shared';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { asCompany, connect, hasDatabase, type Client } from './helpers/db.js';
import { sufijoUnico } from './helpers/identificadores.js';

const suite = hasDatabase ? describe : describe.skip;

suite('E6 · notas de crédito y de débito contra la base', () => {
  let db: Client;
  let empresa: string;
  let otraEmpresa: string;
  let carril = 400;

  const nuevoPv = (): number => {
    carril += 1;
    return carril;
  };

  const declarar = async (
    pv: number,
    tipo: number,
    opciones: { asociada?: string | null; empresaId?: string; ambiente?: string } = {},
  ): Promise<{ id?: string; code?: string; message?: string }> => {
    const empresaId = opciones.empresaId ?? empresa;
    try {
      const r = await asCompany(db, empresaId, () =>
        db.query<{ id: string }>(
          `INSERT INTO fiscal_emissions (company_id, ambiente, origen_tipo, origen_id, punto_venta, cbte_tipo, asociada_a, creado_por)
           VALUES ($1, $2, 'COMMERCIAL_DOCUMENT', $3, $4, $5, $6, 'test') RETURNING id`,
          [empresaId, opciones.ambiente ?? 'homologacion', crypto.randomUUID(), pv, tipo, opciones.asociada ?? null],
        ),
      );
      return { id: r.rows[0]!.id };
    } catch (error) {
      const e = error as { code?: string; message?: string };
      return { code: e.code ?? '', message: e.message ?? '' };
    }
  };

  /** Una factura ya AUTORIZADA (por SQL: lo que se prueba acá es la regla de la nota, no el camino de la factura). */
  const facturaAutorizada = async (pv: number, tipo = 11, opciones: { empresaId?: string; ambiente?: string } = {}): Promise<string> => {
    const empresaId = opciones.empresaId ?? empresa;
    const { id } = await declarar(pv, tipo, opciones);
    await asCompany(db, empresaId, async () => {
      await db.query('SELECT reservar_numero_fiscal_correlativo($1, 0)', [id]);
      await db.query(`UPDATE fiscal_emissions SET estado = 'EMITIENDO' WHERE id = $1`, [id]);
      await db.query(`UPDATE fiscal_emissions SET estado = 'AUTORIZADA', cae = '86421002219999', cae_vencimiento = '2026-10-26' WHERE id = $1`, [id]);
    });
    return id!;
  };

  const estado = async (id: string, empresaId = empresa): Promise<string> =>
    (await asCompany(db, empresaId, () => db.query<{ estado: string }>('SELECT estado FROM fiscal_emissions WHERE id = $1', [id]))).rows[0]!.estado;

  beforeAll(async () => {
    initPool(process.env.DATABASE_URL!);
    db = await connect();
    const stamp = await sufijoUnico(db);
    const userId = (
      await db.query<{ id: string }>('INSERT INTO users (email, full_name, password_hash) VALUES ($1,$2,$3) RETURNING id', [
        `notas-${stamp}@estudio.test`,
        'Notas',
        'x',
      ])
    ).rows[0]!.id;
    const org = (
      await db.query<{ create_organization: string }>('SELECT create_organization($1,$2,$3)', [
        `Estudio notas ${stamp}`,
        withCheckDigit(`30${stamp}`),
        userId,
      ])
    ).rows[0]!.create_organization;
    const crear = async (nombre: string, prefijo: string): Promise<string> =>
      (
        await db.query<{ create_company: string }>('SELECT create_company($1,$2,$3,$4,$5,$6,$7,$8)', [
          userId,
          org,
          nombre,
          withCheckDigit(`${prefijo}${stamp}`),
          'SA',
          'AR-C',
          'IGJ',
          '12-31',
        ])
      ).rows[0]!.create_company;
    empresa = await crear('Notas SA', '33');
    otraEmpresa = await crear('Otras Notas SA', '27');
  });

  afterAll(async () => {
    await db?.end();
    await closePool();
  });

  it('una nota sin comprobante asociado no se puede declarar (crédito y débito, A, B y C)', async () => {
    for (const tipo of [2, 3, 7, 8, 12, 13]) {
      const r = await declarar(nuevoPv(), tipo);
      expect(r.code, `tipo ${tipo}`).toBe('23514');
      expect(r.message).toMatch(/hay que decir cuál/u);
    }
  });

  it('una factura no puede declarar comprobante asociado', async () => {
    const asociada = await facturaAutorizada(nuevoPv());
    const r = await declarar(nuevoPv(), 11, { asociada });
    expect(r.code).toBe('23514');
    expect(r.message).toMatch(/Sólo una nota/u);
  });

  it('una nota de crédito sobre una factura AUTORIZADA de su letra se declara', async () => {
    const pv = nuevoPv();
    const factura = await facturaAutorizada(pv, 11);
    expect((await declarar(pv, 13, { asociada: factura })).id).toBeDefined();
    expect((await declarar(pv, 12, { asociada: factura })).id, 'y una de débito').toBeDefined();
  });

  it('el asociado tiene que estar AUTORIZADO: ni borrador, ni rechazado, ni en duda', async () => {
    const pv = nuevoPv();
    const borrador = (await declarar(pv, 11)).id!;
    expect((await declarar(pv, 13, { asociada: borrador })).message).toMatch(/AUTORIZADO.*BORRADOR/u);

    const enDuda = (await declarar(nuevoPv(), 11)).id!;
    await asCompany(db, empresa, async () => {
      await db.query('SELECT reservar_numero_fiscal_correlativo($1, 0)', [enDuda]);
      await db.query(`UPDATE fiscal_emissions SET estado = 'EMITIENDO' WHERE id = $1`, [enDuda]);
      await db.query(`UPDATE fiscal_emissions SET estado = 'DESCONOCIDA' WHERE id = $1`, [enDuda]);
    });
    expect((await declarar(nuevoPv(), 13, { asociada: enDuda })).code).toBe('23514');
  });

  it('el asociado es una factura o una nota de débito, no una nota de crédito', async () => {
    const pv = nuevoPv();
    const factura = await facturaAutorizada(pv, 11);
    const nc = (await declarar(pv, 13, { asociada: factura })).id!;
    await asCompany(db, empresa, async () => {
      await db.query('SELECT reservar_numero_fiscal_correlativo($1, 0)', [nc]);
      await db.query(`UPDATE fiscal_emissions SET estado = 'EMITIENDO' WHERE id = $1`, [nc]);
      await db.query(`UPDATE fiscal_emissions SET estado = 'AUTORIZADA', cae = '86421002218888', cae_vencimiento = '2026-10-26' WHERE id = $1`, [nc]);
    });
    const sobreNota = await declarar(nuevoPv(), 13, { asociada: nc });
    expect(sobreNota.code).toBe('23514');
    expect(sobreNota.message).toMatch(/no una nota de crédito/u);
  });

  it('la letra tiene que coincidir: una nota C no corrige una factura B', async () => {
    const facturaB = await facturaAutorizada(nuevoPv(), 6);
    const r = await declarar(nuevoPv(), 13, { asociada: facturaB });
    expect(r.code).toBe('23514');
    expect(r.message).toMatch(/misma letra/u);
  });

  it('misma empresa y mismo ambiente: ni la factura de otra empresa ni la de otro ambiente', async () => {
    const deOtra = await facturaAutorizada(nuevoPv(), 11, { empresaId: otraEmpresa });
    const cruzada = await declarar(nuevoPv(), 13, { asociada: deOtra });
    expect(cruzada.code).toBe('23514');
    expect(cruzada.message).toMatch(/no existe \(o es de otra empresa\)/u);

    const enProduccion = await facturaAutorizada(nuevoPv(), 11, { ambiente: 'produccion' });
    const otroAmbiente = await declarar(nuevoPv(), 13, { asociada: enProduccion, ambiente: 'homologacion' });
    expect(otroAmbiente.code).toBe('23514');
    expect(otroAmbiente.message).toMatch(/mismo ambiente/u);
  });

  it('una asociada que no existe', async () => {
    expect((await declarar(nuevoPv(), 13, { asociada: crypto.randomUUID() })).code).toBe('23514');
  });

  it('el comprobante asociado no se cambia después', async () => {
    const pv = nuevoPv();
    const f1 = await facturaAutorizada(pv, 11);
    const f2 = await facturaAutorizada(nuevoPv(), 11);
    const nota = (await declarar(pv, 13, { asociada: f1 })).id!;
    let codigo = '';
    try {
      await asCompany(db, empresa, () => db.query('UPDATE fiscal_emissions SET asociada_a = $2 WHERE id = $1', [nota, f2]));
    } catch (error) {
      codigo = (error as { code?: string }).code ?? '';
    }
    expect(codigo).toBe('23514');
  });

  it('de punta a punta: el caso de uso emite una nota de crédito que lleva su CbtesAsoc', async () => {
    const pv = nuevoPv();
    const factura = await facturaAutorizada(pv, 11);
    const numeroFactura = (
      await asCompany(db, empresa, () => db.query<{ n: string }>('SELECT cbte_numero::text AS n FROM fiscal_emissions WHERE id = $1', [factura]))
    ).rows[0]!.n;
    const nota = (await declarar(pv, 13, { asociada: factura })).id!;

    const enviados: DetalleComprobante[] = [];
    const arca: TransporteDeEmision = {
      estaVivo: async () => true,
      ultimoAutorizado: async (_pv, tipo) => (tipo === 13 ? 0 : 1),
      solicitarCae: async (_c, d): Promise<RespuestaLote> => {
        enviados.push(d);
        return {
          Resultado: 'A',
          errores: [],
          eventos: [],
          comprobantes: [{ Concepto: 1, DocTipo: 99, DocNro: '0', CbteDesde: d.CbteDesde, CbteHasta: d.CbteDesde, CbteFch: d.CbteFch, Resultado: 'A', CAE: '86421002217777', CAEFchVto: '20261026', Observaciones: [] }],
        };
      },
    };
    const repo = new RepositorioSqlDeEmision({ companyId: empresa, actorId: 'system:test' }) as unknown as RepositorioDeEmision;

    const r = await emitirIntencion({ repo, transporte: arca }, nota, (numero) =>
      armarComprobante({
        emisor: { cuit: withCheckDigit('2045214832'), condicionIva: 'MONOTRIBUTO' },
        receptor: { condicionIva: 'CONSUMIDOR_FINAL', tipoDocumento: 'SIN_IDENTIFICAR', numeroDocumento: null },
        clase: 'NOTA_DE_CREDITO',
        comprobanteAsociado: { cbteTipo: 11, puntoDeVenta: pv, numero: Number(numeroFactura) },
        puntoDeVenta: pv,
        numero,
        fecha: '2026-10-16',
        lineas: [{ tipo: 'PRODUCTO', tratamiento: 'GRAVADO', neto: '500.00', iva: '0.00' }],
      }),
    );

    expect(r).toMatchObject({ estado: 'AUTORIZADA', cbteNumero: 1 });
    expect(await estado(nota)).toBe('AUTORIZADA');
    expect((await repo.cargar(nota))?.asociadaA, 'el repositorio expone qué comprobante corrige').toBe(factura);
    expect(enviados[0]!.CbtesAsoc).toEqual([{ Tipo: 11, PtoVta: pv, Nro: Number(numeroFactura), Cuit: withCheckDigit('2045214832') }]);
  });
});
