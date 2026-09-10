/**
 * Lo que el importador tiene que rechazar, y con qué palabras.
 *
 * ## Por qué el mensaje es parte de la prueba
 *
 * Un rechazo sin explicación deja a alguien mirando una pantalla que dice «12
 * filas no entraron» sin saber qué corregir. El texto del hallazgo es lo único
 * que convierte un rechazo en una instrucción, así que se afirma sobre él y no
 * solo sobre el conteo.
 *
 * ## Rechazar no es fallar
 *
 * Ninguno de estos casos aborta la importación: la fila se marca, el motivo se
 * guarda y la migración sigue con las demás. Una factura que cita un proveedor
 * que no está no tiene por qué impedir que entren los cien clientes.
 */

import { closePool, initPool, withCompany } from '@aai/db';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  cargarOrigen,
  crearMigracion,
  declararMapeo,
  importar,
  validarMigracion,
} from '@aai/api/migracion/ciclo';
import type { Entidad } from '@aai/migration-engine';
import { asCompany, connect, hasDatabase, seed, type Client, type Fixture } from './helpers/db.js';

const suite = hasDatabase ? describe : describe.skip;
const actor = 'user:rechazos';

suite('lo que una migración rechaza, y por qué', () => {
  let raw: Client;
  let fx: Fixture;

  beforeAll(async () => {
    initPool(process.env.DATABASE_URL!);
    raw = await connect();
    fx = await seed(raw, 'rechazos');
  });

  afterAll(async () => {
    await raw?.end();
    await closePool();
  });

  /**
   * Migra un CSV suelto y devuelve los hallazgos que quedaron.
   *
   * Devuelve los mensajes y no solo los códigos: el código dice qué clase de
   * problema hubo y el mensaje dice cuál, que es lo que alguien necesita.
   */
  async function migrar(
    entidad: Entidad,
    mapeo: Readonly<Record<string, string>>,
    contenido: string,
    opciones: { readonly fechaCorte?: string } = {},
  ): Promise<{ mensajes: string[]; importados: number; rechazados: number }> {
    const id = await withCompany({ companyId: fx.companyA, actorId: actor }, async (tx) => {
      const id = await crearMigracion(tx, fx.companyA, actor, {
        adaptador: 'ARCHIVO_GENERICO',
        titulo: `Rechazos de ${entidad}`,
        ...(opciones.fechaCorte === undefined ? {} : { fechaCorte: opciones.fechaCorte }),
      });
      await cargarOrigen(tx, fx.companyA, actor, id, {
        nombre: 'datos.csv',
        bytes: Buffer.from(contenido, 'utf8'),
      });
      const { rows } = await tx.query<{ id: string }>(
        'SELECT id FROM migration_tables WHERE migration_id = $1',
        [id],
      );
      await declararMapeo(tx, fx.companyA, actor, id, [
        { id: rows[0]!.id, entidad, mapeo, incluida: true },
      ]);
      await validarMigracion(tx, fx.companyA, actor, id);
      return id;
    });

    const r = await importar(fx.companyA, actor, id);
    const { rows } = await asCompany(raw, fx.companyA, () =>
      raw.query<{ mensaje: string }>(
        `SELECT mensaje FROM migration_findings
          WHERE migration_id = $1 AND codigo = 'NO_SE_PUDO_ESCRIBIR'`,
        [id],
      ),
    );
    const conteo = r.conteos[0];
    return {
      mensajes: rows.map((x) => x.mensaje),
      importados: conteo?.importados ?? 0,
      rechazados: conteo?.rechazados ?? 0,
    };
  }

  // ── Referencias que no existen ────────────────────────────────────────

  it('un asiento contra una cuenta que no está dice cuál y qué hacer', async () => {
    const r = await migrar(
      'JOURNAL_ENTRY',
      { Asiento: 'asiento', Fecha: 'fecha', Cuenta: 'cuenta', Debe: 'debe', Haber: 'haber' },
      [
        'Asiento;Fecha;Cuenta;Debe;Haber',
        '1;15/01/2025;9.9.99;100,00;0',
        '1;15/01/2025;1.1.01;0;100,00',
      ].join('\n'),
    );

    expect(r.importados).toBe(0);
    expect(r.mensajes.join(' ')).toContain('9.9.99');
    expect(r.mensajes.join(' ')).toContain('plan de cuentas');
    // Y dice por qué no la crea sola, que es la pregunta siguiente.
    expect(r.mensajes.join(' ')).toContain('de qué lado suma');
  });

  it('un movimiento de un producto que no está no crea el producto', async () => {
    const r = await migrar(
      'STOCK_MOVEMENT',
      { SKU: 'sku', Fecha: 'fecha', Tipo: 'tipo', Cantidad: 'cantidad' },
      ['SKU;Fecha;Tipo;Cantidad', 'NO-EXISTE;15/01/2025;Entrada;5'].join('\n'),
    );

    expect(r.importados).toBe(0);
    expect(r.mensajes[0]).toContain('NO-EXISTE');
    expect(r.mensajes[0]).toContain('ni unidad ni tratamiento fiscal');
  });

  it('un pago a un proveedor que no está se rechaza en vez de inventarlo', async () => {
    const r = await migrar(
      'PAYMENT',
      { Fecha: 'fecha', Importe: 'importe', CUIT: 'cuitProveedor' },
      ['Fecha;Importe;CUIT', '15/01/2025;1.000,00;30-71000001-4'].join('\n'),
    );

    expect(r.importados).toBe(0);
    expect(r.mensajes[0]).toContain('30710000014');
    expect(r.mensajes[0]).toContain('Migrá primero los terceros');
  });

  // ── Datos que no se pueden interpretar sin decidir por el cliente ──────

  it('un comprobante que solo trae el total no se reparte suponiendo el IVA', async () => {
    const r = await migrar(
      'SALES_DOCUMENT',
      { Tipo: 'tipoComprobante', PV: 'puntoVenta', Numero: 'numero', Fecha: 'fecha', Total: 'total' },
      ['Tipo;PV;Numero;Fecha;Total', 'Factura A;3;7001;15/01/2025;12.100,00'].join('\n'),
    );

    expect(r.importados).toBe(0);
    // Dice las dos cifras y el motivo: el libro de IVA se arma con las partes.
    expect(r.mensajes[0]).toContain('12100.00');
    expect(r.mensajes[0]).toContain('libro de IVA');
    expect(r.mensajes[0]).toContain('cambiaría el impuesto');
  });

  it('un tipo de comprobante que no está en el catálogo de ARCA se rechaza', async () => {
    const r = await migrar(
      'SALES_DOCUMENT',
      {
        Tipo: 'tipoComprobante',
        PV: 'puntoVenta',
        Numero: 'numero',
        Fecha: 'fecha',
        Total: 'total',
        Neto: 'neto',
      },
      ['Tipo;PV;Numero;Fecha;Total;Neto', 'Comprobante X;3;7002;15/01/2025;100,00;100,00'].join('\n'),
    );

    expect(r.importados).toBe(0);
    expect(r.mensajes[0]).toContain('Comprobante X');
    // Y enumera lo que sí entiende, en vez de dejar a alguien probando.
    expect(r.mensajes[0]).toContain('Factura A');
  });

  it('el tipo de comprobante se reconoce escrito de las tres maneras', async () => {
    // El complemento del control anterior: si rechazara todo, el mensaje de
    // arriba sería correcto y el importador, inútil.
    for (const [i, tipo] of ['1', 'Factura A', 'FC A'].entries()) {
      const r = await migrar(
        'SALES_DOCUMENT',
        {
          Tipo: 'tipoComprobante',
          PV: 'puntoVenta',
          Numero: 'numero',
          Fecha: 'fecha',
          Total: 'total',
          Neto: 'neto',
        },
        [
          'Tipo;PV;Numero;Fecha;Total;Neto',
          `${tipo};4;${8000 + i};15/01/2025;100,00;100,00`,
        ].join('\n'),
      );
      expect(r.importados, `${tipo}: ${r.mensajes.join(' | ')}`).toBe(1);
    }
  });

  it('una existencia negativa no es una existencia', async () => {
    const r = await migrar(
      'STOCK_BALANCE',
      { SKU: 'sku', Cantidad: 'cantidad' },
      ['SKU;Cantidad', 'ART-NEG;-5'].join('\n'),
      { fechaCorte: '2025-01-15' },
    );
    expect(r.importados).toBe(0);
    // Rechaza por el producto que no está, que es lo primero que falla. Lo que
    // importa es que **no lo crea**: la existencia negativa nunca llega a
    // escribirse.
    expect(r.mensajes[0]).toContain('ART-NEG');
  });

  it('una existencia sin fecha no se fecha hoy', async () => {
    // Sin fecha de corte declarada ni columna que la traiga: fechar hoy una
    // existencia de hace dos años le pone al libro un movimiento en el momento
    // equivocado, y eso corre el promedio ponderado.
    await asCompany(raw, fx.companyA, () =>
      raw.query(
        `INSERT INTO products (company_id, code, name, tracks_stock, tax_treatment, created_by)
         VALUES ($1, 'ART-SIN-FECHA', 'Sin fecha', true, 'NO_GRAVADO', 'user:previo')`,
        [fx.companyA],
      ),
    );
    await asCompany(raw, fx.companyA, () =>
      raw.query(
        `INSERT INTO warehouses (company_id, code, name, created_by)
         VALUES ($1, 'UNICO', 'Depósito único', 'user:previo')
         ON CONFLICT DO NOTHING`,
        [fx.companyA],
      ),
    );

    const r = await migrar(
      'STOCK_BALANCE',
      { SKU: 'sku', Deposito: 'deposito', Cantidad: 'cantidad' },
      ['SKU;Deposito;Cantidad', 'ART-SIN-FECHA;UNICO;10'].join('\n'),
    );

    expect(r.importados).toBe(0);
    expect(r.mensajes[0]).toContain('a qué fecha');
  });

  // ── Archivos que no se pueden leer ────────────────────────────────────

  it('un archivo que no es lo que dice su extensión se rechaza al cargarlo', async () => {
    await withCompany({ companyId: fx.companyA, actorId: actor }, async (tx) => {
      const id = await crearMigracion(tx, fx.companyA, actor, {
        adaptador: 'ARCHIVO_GENERICO',
        titulo: 'Archivo roto',
      });
      await expect(
        cargarOrigen(tx, fx.companyA, actor, id, {
          nombre: 'planilla.xlsx',
          bytes: Buffer.from('esto no es un xlsx, es texto suelto', 'utf8'),
        }),
      ).rejects.toThrow();
    });
  });

  it('un archivo vacío se carga y avisa que no trae filas', async () => {
    // No es un error: es un archivo. Rechazarlo con una excepción diría que
    // algo salió mal cuando lo que pasó es que no había nada.
    const avisos = await withCompany({ companyId: fx.companyA, actorId: actor }, async (tx) => {
      const id = await crearMigracion(tx, fx.companyA, actor, {
        adaptador: 'ARCHIVO_GENERICO',
        titulo: 'Vacío',
      });
      return cargarOrigen(tx, fx.companyA, actor, id, {
        nombre: 'vacio.csv',
        bytes: Buffer.from('Razon Social;CUIT', 'utf8'),
      });
    });
    expect(avisos.filas).toBe(0);
    expect(avisos.avisos.join(' ')).toContain('no tiene filas');
  });

  // ── Un rechazo no arrastra al resto ───────────────────────────────────

  it('una fila rechazada no impide que entren las demás', async () => {
    const r = await migrar(
      'PARTY',
      { 'Razon Social': 'razonSocial', CUIT: 'cuit' },
      [
        'Razon Social;CUIT',
        'Buena Uno SA;30-71000001-4',
        'Buena Dos SA;20-11111111-2',
        'Buena Tres SA;27-11111111-7',
      ].join('\n'),
    );
    // Las tres entran: es el control positivo del conjunto.
    expect(r.importados).toBe(3);
    expect(r.mensajes).toEqual([]);
  });
});
