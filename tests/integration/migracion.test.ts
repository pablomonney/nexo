/**
 * El ciclo de una migración, contra la base.
 *
 * Lo que se prueba acá es lo que el motor puro no puede: que la idempotencia
 * viva en la base, que la reversión no se lleve puesto lo que ya estaba, y que
 * una migración de una empresa sea invisible para otra.
 *
 * Cada bloque corre el flujo entero —crear, cargar, mapear, validar, importar—
 * porque los pasos intermedios no significan nada por separado: una migración
 * validada que no se puede importar es un archivo leído, no una migración.
 */

import { closePool, initPool, withCompany } from '@aai/db';
import type { FastifyInstance } from 'fastify';
import { buildServer } from '@aai/api/server';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  cargarOrigen,
  crearMigracion,
  declararMapeo,
  importar,
  revertir,
  validarMigracion,
} from '@aai/api/migracion/ciclo';
import { asCompany, connect, hasDatabase, seed, type Client, type Fixture } from './helpers/db.js';

const suite = hasDatabase ? describe : describe.skip;

const CLIENTES = [
  'Razón Social;CUIT;Email;Condición IVA',
  'Acme SA;30-71000001-4;acme@test.local;Responsable Inscripto',
  'Beta SRL;20-11111111-2;beta@test.local;Monotributo',
].join('\n');

suite('migración: de un archivo a la empresa', () => {
  let app: FastifyInstance;
  let raw: Client;
  let fx: Fixture;

  beforeAll(async () => {
    initPool(process.env.DATABASE_URL!);
    app = await buildServer();
    await app.ready();
    raw = await connect();
    fx = await seed(raw, 'migracion');
  });

  afterAll(async () => {
    await app?.close();
    await raw?.end();
    await closePool();
  });

  const actor = 'user:tester';

  /** Corre el ciclo entero y devuelve el id de la migración. */
  async function migrar(
    companyId: string,
    contenido: string,
    nombre = 'clientes.csv',
  ): Promise<{ id: string; importados: number; yaEstaban: number }> {
    return withCompany({ companyId, actorId: actor }, async (tx) => {
      const id = await crearMigracion(tx, companyId, actor, {
        adaptador: 'ARCHIVO_GENERICO',
        titulo: 'Clientes del sistema anterior',
      });

      await cargarOrigen(tx, companyId, actor, id, { nombre, bytes: Buffer.from(contenido, 'utf8') });

      const { rows } = await tx.query<{ id: string; columnas: string[] }>(
        'SELECT id, columnas FROM migration_tables WHERE migration_id = $1',
        [id],
      );
      await declararMapeo(tx, companyId, actor, id, [
        {
          id: rows[0]!.id,
          entidad: 'PARTY',
          mapeo: {
            'Razón Social': 'razonSocial',
            CUIT: 'cuit',
            Email: 'email',
            'Condición IVA': 'condicionIva',
          },
          incluida: true,
        },
      ]);

      const veredicto = await validarMigracion(tx, companyId, actor, id);
      expect(veredicto.sePuedeImportar, JSON.stringify(veredicto)).toBe(true);
      return id;
    }).then(async (id) => {
      // `importar` abre sus propias transacciones —una por tanda— así que se
      // llama **fuera** del `withCompany` de la preparación. Es la contrapartida
      // de tener puntos de control: una tanda que no se confirma no es un punto
      // de control.
      const resultado = await importar(companyId, actor, id);
      const party = resultado.conteos.find((c) => c.entidad === 'PARTY');
      return { id, importados: party?.importados ?? 0, yaEstaban: party?.yaEstaban ?? 0 };
    });
  }

  it('trae los clientes del archivo y los deja en la empresa', async () => {
    const r = await migrar(fx.companyA, CLIENTES);
    expect(r.importados).toBe(2);

    const { rows } = await asCompany(raw, fx.companyA, () =>
      raw.query<{ razon_social: string; numero_documento: string; condicion_iva: string }>(
        `SELECT razon_social, numero_documento, condicion_iva FROM parties
          WHERE numero_documento IN ('30710000014','20111111112') ORDER BY razon_social`,
      ),
    );

    expect(rows).toHaveLength(2);
    expect(rows[0]!.razon_social).toBe('Acme SA');
    // El CUIT llegó con guiones y quedó normalizado.
    expect(rows[0]!.numero_documento).toBe('30710000014');
    expect(rows[0]!.condicion_iva).toBe('RESPONSABLE_INSCRIPTO');
  });

  it('la fila cruda queda guardada tal como vino', async () => {
    // Es la respuesta a «¿de dónde salió este dato?». Sin ella, un cliente
    // importado no se puede auditar contra el sistema del que vino.
    const { id } = await migrar(fx.companyA, CLIENTES, 'otro.csv');
    const { rows } = await asCompany(raw, fx.companyA, () =>
      raw.query<{ crudo: string[]; numero: number }>(
        'SELECT crudo, numero FROM migration_rows WHERE migration_id = $1 ORDER BY numero',
        [id],
      ),
    );

    expect(rows[0]!.crudo[0]).toBe('Acme SA');
    expect(rows[0]!.crudo[1]).toBe('30-71000001-4');
    expect(rows[0]!.numero).toBe(1);
  });

  it('correr la misma migración otra vez no duplica nada', async () => {
    // La garantía está en el UNIQUE de `migration_links`, no en un `if`: la
    // segunda corrida reconoce las identidades y no escribe.
    const antes = await contarTerceros(fx.companyA);
    const r = await migrar(fx.companyA, CLIENTES, 'repetido.csv');
    const despues = await contarTerceros(fx.companyA);

    expect(r.importados).toBe(0);
    expect(r.yaEstaban).toBe(2);
    expect(despues).toBe(antes);
  });

  it('reconoce un cliente que ya estaba cargado a mano', async () => {
    // La idempotencia por vínculos solo cubre lo que entró por una migración.
    // Un tercero cargado antes a mano tiene que reconocerse por su CUIT, o la
    // migración lo duplica.
    const cuit = '27111111117';
    await asCompany(raw, fx.companyB, () =>
      raw.query(
        `INSERT INTO parties (company_id, tipo_documento, numero_documento, razon_social, created_by)
         VALUES ($1, 'CUIT', $2, 'Cargada a mano', 'user:previo')`,
        [fx.companyB, cuit],
      ),
    );

    const r = await migrar(
      fx.companyB,
      ['Razón Social;CUIT', `Otra Razón SA;${cuit}`].join('\n'),
      'ya-estaba.csv',
    );

    expect(r.importados).toBe(0);
    expect(r.yaEstaban).toBe(1);
  });

  it('un CUIT con dígito verificador malo entra sin documento, no entra mal', async () => {
    // `27111111114` no supera el verificador. El tercero se importa igual —el
    // origen lo tenía y esconderlo no lo arregla— pero **sin** documento, para
    // que no quede en NEXO un CUIT que la AFIP va a rechazar al facturarle.
    // Queda la advertencia diciendo qué traía el archivo.
    const { id } = await migrar(
      fx.companyA,
      ['Razón Social;CUIT', 'Verificador Malo SA;27-11111111-4'].join('\n'),
      'cuit-malo.csv',
    );

    const { rows } = await asCompany(raw, fx.companyA, () =>
      raw.query<{ tipo_documento: string; numero_documento: string | null }>(
        `SELECT tipo_documento, numero_documento FROM parties
          WHERE company_id = $1 AND razon_social = 'Verificador Malo SA'`,
        [fx.companyA],
      ),
    );
    expect(rows[0]).toEqual({ tipo_documento: 'SIN_IDENTIFICAR', numero_documento: null });

    const { rows: avisos } = await asCompany(raw, fx.companyA, () =>
      raw.query<{ nivel: string; mensaje: string }>(
        `SELECT nivel, mensaje FROM migration_findings WHERE migration_id = $1`,
        [id],
      ),
    );
    expect(avisos.some((a) => a.mensaje.includes('27-11111111-4'))).toBe(true);
    expect(avisos.every((a) => a.nivel !== 'ERROR')).toBe(true);
  });

  it('revertir archiva lo que la migración creó y no toca lo demás', async () => {
    const cuit = '30710000030';
    const { id } = await migrar(
      fx.companyB,
      ['Razón Social;CUIT', `Para Revertir SA;${cuit}`].join('\n'),
      'revertible.csv',
    );

    const revertida = await withCompany({ companyId: fx.companyB, actorId: actor }, (tx) =>
      revertir(tx, fx.companyB, actor, id, 'El archivo tenía la columna equivocada'),
    );
    expect(revertida.archivados).toBe(1);

    const { rows } = await asCompany(raw, fx.companyB, () =>
      raw.query<{ status: string }>(
        'SELECT status FROM parties WHERE company_id = $1 AND numero_documento = $2',
        [fx.companyB, cuit],
      ),
    );
    // Archivado y no borrado: un tercero puede tener movimientos colgando.
    expect(rows[0]!.status).toBe('ARCHIVADO');

    // Y el que ya estaba antes de migrar sigue activo.
    const previo = await asCompany(raw, fx.companyB, () =>
      raw.query<{ status: string }>(
        `SELECT status FROM parties WHERE company_id = $1 AND numero_documento = '27111111117'`,
        [fx.companyB],
      ),
    );
    expect(previo.rows[0]!.status).toBe('ACTIVO');
  });

  it('un archivo con errores no se puede importar', async () => {
    const conError = ['Razón Social;CUIT', ';30-71000001-4'].join('\n');

    await withCompany({ companyId: fx.companyA, actorId: actor }, async (tx) => {
      const id = await crearMigracion(tx, fx.companyA, actor, {
        adaptador: 'ARCHIVO_GENERICO',
        titulo: 'Con error',
      });
      await cargarOrigen(tx, fx.companyA, actor, id, {
        nombre: 'malo.csv',
        bytes: Buffer.from(conError, 'utf8'),
      });
      const { rows } = await tx.query<{ id: string }>(
        'SELECT id FROM migration_tables WHERE migration_id = $1',
        [id],
      );
      await declararMapeo(tx, fx.companyA, actor, id, [
        { id: rows[0]!.id, entidad: 'PARTY', mapeo: { 'Razón Social': 'razonSocial', CUIT: 'cuit' }, incluida: true },
      ]);

      const veredicto = await validarMigracion(tx, fx.companyA, actor, id);
      expect(veredicto.sePuedeImportar).toBe(false);
      expect(veredicto.errores).toBeGreaterThan(0);
      return id;
    }).then(async (id) => {
      // Y el estado quedó en VALIDADA, no en LISTA: importar tiene que fallar.
      await expect(importar(fx.companyA, actor, id)).rejects.toThrow(/no puede pasar/);
    });
  });

  it('una entidad sin escritor se omite y se dice por qué, en vez de rechazarla', async () => {
    // Las cobranzas son hoy la única entidad que el motor transporta y no sabe
    // escribir. La validación lo avisa **antes** de confirmar, que es cuando
    // todavía se puede cambiar el mapeo.
    const cobranzas = ['Fecha;Importe;Referencia', '01/03/2026;100,00;REC-1'].join('\n');

    const id = await withCompany({ companyId: fx.companyA, actorId: actor }, async (tx) => {
      const id = await crearMigracion(tx, fx.companyA, actor, {
        adaptador: 'ARCHIVO_GENERICO',
        titulo: 'Cobranzas',
      });
      await cargarOrigen(tx, fx.companyA, actor, id, {
        nombre: 'cobranzas.csv',
        bytes: Buffer.from(cobranzas, 'utf8'),
      });
      const { rows } = await tx.query<{ id: string }>(
        'SELECT id FROM migration_tables WHERE migration_id = $1',
        [id],
      );
      await declararMapeo(tx, fx.companyA, actor, id, [
        {
          id: rows[0]!.id,
          entidad: 'COLLECTION',
          mapeo: { Fecha: 'fecha', Importe: 'importe', Referencia: 'referencia' },
          incluida: true,
        },
      ]);

      const veredicto = await validarMigracion(tx, fx.companyA, actor, id);
      expect(veredicto.sePuedeImportar).toBe(true);
      expect(veredicto.sinEscritor.map((s) => s.entidad)).toContain('COLLECTION');
      // El motivo no es «todavía no»: dice exactamente qué le falta.
      expect(veredicto.sinEscritor[0]!.motivo).toContain('journal_entry_line_id');
      return id;
    });

    const resultado = await importar(fx.companyA, actor, id);
    const cobranza = resultado.conteos.find((c) => c.entidad === 'COLLECTION');
    // Ni importadas ni rechazadas por una regla de datos: omitidas. Contarlas
    // como rechazadas diría que sus datos estaban mal, y no lo estaban.
    expect(cobranza?.importados).toBe(0);

    const { rows } = await asCompany(raw, fx.companyA, () =>
      raw.query<{ estado: string }>(
        `SELECT r.estado FROM migration_rows r WHERE r.migration_id = $1`,
        [id],
      ),
    );
    expect(rows.map((x) => x.estado)).toEqual(['OMITIDA']);
  });

  it('un asiento descuadrado no se importa y no se ajusta solo', async () => {
    const descuadrado = [
      'Fecha;Cuenta;Debe;Haber;Asiento',
      '01/03/2026;1.1.01;100,00;0;9',
      '01/03/2026;4.1.01;0;90,00;9',
    ].join('\n');

    await withCompany({ companyId: fx.companyA, actorId: actor }, async (tx) => {
      const id = await crearMigracion(tx, fx.companyA, actor, {
        adaptador: 'ARCHIVO_GENERICO',
        titulo: 'Descuadrado',
      });
      await cargarOrigen(tx, fx.companyA, actor, id, {
        nombre: 'desc.csv',
        bytes: Buffer.from(descuadrado, 'utf8'),
      });
      const { rows } = await tx.query<{ id: string }>(
        'SELECT id FROM migration_tables WHERE migration_id = $1',
        [id],
      );
      await declararMapeo(tx, fx.companyA, actor, id, [
        {
          id: rows[0]!.id,
          entidad: 'JOURNAL_ENTRY',
          mapeo: { Fecha: 'fecha', Cuenta: 'cuenta', Debe: 'debe', Haber: 'haber', Asiento: 'asiento' },
          incluida: true,
        },
      ]);

      const v = await validarMigracion(tx, fx.companyA, actor, id);
      expect(v.sePuedeImportar).toBe(false);

      const { rows: hallazgos } = await tx.query<{ mensaje: string }>(
        `SELECT mensaje FROM migration_findings
          WHERE migration_id = $1 AND codigo = 'ASIENTO_DESCUADRADO'`,
        [id],
      );
      expect(hallazgos[0]!.mensaje).toContain('10,00');
      expect(hallazgos[0]!.mensaje).toContain('no agrega un renglón');
    });
  });

  it('la fila cruda es inmutable: se vuelve a migrar, no se corrige', async () => {
    const { id } = await migrar(fx.companyA, CLIENTES, 'inmutable.csv');
    const { rows } = await asCompany(raw, fx.companyA, () =>
      raw.query<{ id: string }>('SELECT id FROM migration_rows WHERE migration_id = $1 LIMIT 1', [id]),
    );

    await expect(
      asCompany(raw, fx.companyA, () =>
        raw.query(`UPDATE migration_rows SET crudo = '["editado"]'::jsonb WHERE id = $1`, [
          rows[0]!.id,
        ]),
      ),
    ).rejects.toThrow(/no se modifica/);
  });

  async function contarTerceros(companyId: string): Promise<number> {
    const { rows } = await asCompany(raw, companyId, () =>
      raw.query<{ n: string }>('SELECT count(*)::text n FROM parties WHERE company_id = $1', [
        companyId,
      ]),
    );
    return Number(rows[0]!.n);
  }
});

suite('migración: aislamiento entre empresas', () => {
  let raw: Client;
  let fx: Fixture;

  beforeAll(async () => {
    initPool(process.env.DATABASE_URL!);
    raw = await connect();
    fx = await seed(raw, 'migracion-rls');
  });

  afterAll(async () => {
    await raw?.end();
    await closePool();
  });

  it('la migración de una empresa no existe para la otra', async () => {
    const id = await withCompany({ companyId: fx.companyA, actorId: 'user:a' }, (tx) =>
      crearMigracion(tx, fx.companyA, 'user:a', {
        adaptador: 'ARCHIVO_GENERICO',
        titulo: 'Privada de A',
      }),
    );

    // Con la empresa B en contexto y el rol de la aplicación puesto, esa fila
    // no existe. Es RLS forzado, no un `WHERE` en la consulta.
    const { rows } = await asCompany(raw, fx.companyB, () =>
      raw.query('SELECT id FROM migrations WHERE id = $1', [id]),
    );
    expect(rows).toHaveLength(0);
  });

  it('tampoco sus filas crudas ni sus vínculos', async () => {
    const desdeB = await asCompany(raw, fx.companyB, async () => {
      const filas = await raw.query('SELECT count(*)::int n FROM migration_rows');
      const links = await raw.query('SELECT count(*)::int n FROM migration_links');
      const hall = await raw.query('SELECT count(*)::int n FROM migration_findings');
      return { filas: filas.rows[0], links: links.rows[0], hall: hall.rows[0] };
    });

    // B no cargó ninguna migración: todo lo que ve es cero, aunque A tenga filas.
    expect(desdeB.filas).toEqual({ n: 0 });
    expect(desdeB.links).toEqual({ n: 0 });
    expect(desdeB.hall).toEqual({ n: 0 });
  });

  it('la aplicación no puede borrar filas de migración', async () => {
    // Se les revocó el DELETE: una fila cruda es prueba de lo que el sistema
    // anterior tenía, y borrarla la deja de ser prueba.
    await expect(
      asCompany(raw, fx.companyA, () => raw.query('DELETE FROM migration_rows')),
    ).rejects.toThrow(/permiso denegado|permission denied/i);
  });
});
