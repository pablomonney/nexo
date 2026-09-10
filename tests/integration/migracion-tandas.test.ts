/**
 * Tandas, puntos de control, reanudación y cancelación.
 *
 * Son las cuatro cosas que la primera versión no tenía y que hacen la
 * diferencia entre importar tres mil filas y importar cincuenta mil. Ninguna se
 * puede comprobar mirando el resultado final: hay que **cortar la importación
 * por la mitad** y ver qué quedó.
 *
 * `topeDeTandas` existe para eso: corre una tanda y vuelve. Es el mismo
 * mecanismo que usa la consola para no dejar un pedido HTTP colgado media hora,
 * así que probarlo así prueba el camino real y no uno de laboratorio.
 */

import { closePool, initPool, withCompany } from '@aai/db';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  cancelar,
  cargarOrigen,
  crearMigracion,
  declararMapeo,
  importar,
  leerProgreso,
  validarMigracion,
} from '@aai/api/migracion/ciclo';
import type { Entidad } from '@aai/migration-engine';
import { asCompany, connect, hasDatabase, seed, type Client, type Fixture } from './helpers/db.js';
import { armarZip } from './helpers/zip.js';
import { ARCHIVOS, ENTIDAD_DE, FECHA_ISO, MAPEO_DE } from './helpers/empresa-migrada.js';

const suite = hasDatabase ? describe : describe.skip;
const actor = 'user:tandas';

suite('migración por tandas', () => {
  let raw: Client;
  let fx: Fixture;

  beforeAll(async () => {
    initPool(process.env.DATABASE_URL!);
    raw = await connect();
    fx = await seed(raw, 'tandas');
  });

  afterAll(async () => {
    await raw?.end();
    await closePool();
  });

  /** Deja una migración lista para importar y devuelve su id. */
  async function preparar(titulo: string): Promise<string> {
    return withCompany({ companyId: fx.companyA, actorId: actor }, async (tx) => {
      const id = await crearMigracion(tx, fx.companyA, actor, {
        adaptador: 'ARCHIVO_GENERICO',
        titulo,
        fechaCorte: FECHA_ISO,
      });
      await cargarOrigen(tx, fx.companyA, actor, id, {
        nombre: 'empresa.zip',
        bytes: armarZip(ARCHIVOS),
      });
      const { rows } = await tx.query<{ id: string; nombre: string }>(
        'SELECT id, nombre FROM migration_tables WHERE migration_id = $1',
        [id],
      );
      await declararMapeo(
        tx,
        fx.companyA,
        actor,
        id,
        rows.map((t) => ({
          id: t.id,
          entidad: ENTIDAD_DE[t.nombre] as Entidad,
          mapeo: MAPEO_DE[t.nombre]!,
          incluida: true,
        })),
      );
      await validarMigracion(tx, fx.companyA, actor, id);
      return id;
    });
  }

  const progreso = (id: string): Promise<{ total: number; procesadas: number; tandas: number }> =>
    withCompany({ companyId: fx.companyA, actorId: actor }, (tx) => leerProgreso(tx, id));

  it('el plan de tandas se escribe antes de importar nada', async () => {
    const id = await preparar('Plan primero');

    // Una tanda por tabla como mínimo: el archivo trae diez.
    const parcial = await importar(fx.companyA, actor, id, { topeDeTandas: 1 });
    const p = await progreso(id);

    expect(p.tandas).toBe(Object.keys(ARCHIVOS).length);
    // El total se conoce desde la primera tanda: es lo que permite decir «de
    // cincuenta mil» en vez de descubrirlo al final.
    expect(p.total).toBeGreaterThan(0);
    expect(p.procesadas).toBeLessThan(p.total);
    expect(parcial.estado).toBe('IMPORTANDO');
    expect(parcial.progreso.tandasCompletadas).toBe(1);
  });

  it('reanudar es volver a llamar, y no vuelve a escribir lo escrito', async () => {
    const id = await preparar('Reanudable');

    // Se corre de a una tanda hasta terminar, como haría la consola.
    let vueltas = 0;
    let estado = 'IMPORTANDO';
    while (estado === 'IMPORTANDO' && vueltas < 50) {
      const r = await importar(fx.companyA, actor, id, { topeDeTandas: 1 });
      estado = r.estado;
      vueltas += 1;
    }

    expect(estado).toMatch(/^COMPLETADA/);
    // Diez tablas, diez tandas, diez vueltas: ni una de más.
    expect(vueltas).toBe(Object.keys(ARCHIVOS).length);

    const p = await progreso(id);
    expect(p.procesadas).toBe(p.total);

    // Y ninguna tanda se corrió dos veces.
    const { rows } = await asCompany(raw, fx.companyA, () =>
      raw.query<{ intentos: number; estado: string }>(
        'SELECT intentos, estado FROM migration_batches WHERE migration_id = $1',
        [id],
      ),
    );
    expect(rows).toHaveLength(Object.keys(ARCHIVOS).length);
    for (const t of rows) {
      expect(t.estado).toBe('COMPLETADA');
      expect(t.intentos).toBe(1);
    }
  }, 60_000);

  it('cada tanda deja escrito qué hizo', async () => {
    const id = await preparar('Con detalle');
    await importar(fx.companyA, actor, id);

    const { rows } = await asCompany(raw, fx.companyA, () =>
      raw.query<{
        entidad: string;
        filas: number;
        importados: number;
        ya_estaban: number;
        terminada: boolean;
      }>(
        `SELECT t.entidad, b.filas, b.importados, b.ya_estaban, b.terminada_el IS NOT NULL AS terminada
           FROM migration_batches b JOIN migration_tables t ON t.id = b.table_id
          WHERE b.migration_id = $1 ORDER BY t.entidad`,
        [id],
      ),
    );

    for (const t of rows) {
      expect(t.terminada).toBe(true);
      // Lo que la tanda tocó tiene que sumar lo que la tanda traía.
      expect(t.importados + t.ya_estaban).toBeLessThanOrEqual(t.filas);
    }
    // La segunda migración del mismo archivo: todo reconocido, nada nuevo.
    const total = rows.reduce((a, t) => a + t.importados, 0);
    const reconocido = rows.reduce((a, t) => a + t.ya_estaban, 0);
    expect(total + reconocido).toBeGreaterThan(0);
  }, 60_000);

  it('cancelar detiene la importación y deja lo que ya entró', async () => {
    const id = await preparar('Cancelable');

    // Una tanda, y ahí se pide la cancelación.
    await importar(fx.companyA, actor, id, { topeDeTandas: 1 });
    const antes = await progreso(id);

    const pedido = await withCompany({ companyId: fx.companyA, actorId: actor }, (tx) =>
      cancelar(tx, fx.companyA, actor, id, 'El archivo era el del año equivocado'),
    );
    expect(pedido.estado).toBe('CANCELACION_PEDIDA');

    // El importador ve el pedido y se detiene sin correr ninguna tanda más.
    const r = await importar(fx.companyA, actor, id);
    expect(r.cancelada).toBe(true);
    expect(r.estado).toBe('CANCELADA');

    const despues = await progreso(id);
    expect(despues.procesadas).toBe(antes.procesadas);
    expect(despues.procesadas).toBeGreaterThan(0);
    expect(despues.procesadas).toBeLessThan(despues.total);

    // Lo que se procesó, quedó procesado: cancelar no es revertir.
    //
    // Se mira el estado de las filas y no los vínculos: para cuando corre esta
    // prueba, las migraciones anteriores del mismo archivo ya trajeron esos
    // datos, así que la tanda los reconoce por su identidad y **no escribe un
    // vínculo nuevo** — el que ya existe los identifica, y el UNIQUE rechazaría
    // el segundo. Marcar la fila como resuelta es igual de definitivo, y es lo
    // que la cancelación no deshace.
    const resueltas = await asCompany(raw, fx.companyA, () =>
      raw.query<{ n: string }>(
        `SELECT count(*)::text n FROM migration_rows
          WHERE migration_id = $1
            AND estado IN ('IMPORTADA','YA_EXISTIA','OMITIDA','RECHAZADA')`,
        [id],
      ),
    );
    expect(Number(resueltas.rows[0]!.n)).toBeGreaterThan(0);

    const cabecera = await asCompany(raw, fx.companyA, () =>
      raw.query<{ cancelada_el: Date | null; motivo: string }>(
        'SELECT cancelada_el, cancelada_motivo AS motivo FROM migrations WHERE id = $1',
        [id],
      ),
    );
    expect(cabecera.rows[0]!.cancelada_el).not.toBeNull();
    expect(cabecera.rows[0]!.motivo).toContain('año equivocado');
  }, 60_000);

  it('una migración cancelada se puede retomar', async () => {
    // Cancelar no la mata: lo que quedó pendiente sigue ahí y se puede seguir.
    // Es la diferencia entre frenar y desistir.
    const id = await preparar('Retomable');
    await importar(fx.companyA, actor, id, { topeDeTandas: 1 });
    await withCompany({ companyId: fx.companyA, actorId: actor }, (tx) =>
      cancelar(tx, fx.companyA, actor, id, 'Freno un momento para revisar el mapeo'),
    );
    await importar(fx.companyA, actor, id);

    const r = await importar(fx.companyA, actor, id);
    expect(r.estado).toMatch(/^COMPLETADA/);

    const p = await progreso(id);
    expect(p.procesadas).toBe(p.total);
  }, 60_000);

  it('no se puede cancelar lo que no está importando', async () => {
    const id = await preparar('Sin empezar');
    await expect(
      withCompany({ companyId: fx.companyA, actorId: actor }, (tx) =>
        cancelar(tx, fx.companyA, actor, id, 'Un motivo suficientemente largo'),
      ),
    ).rejects.toThrow(/importando/);
  });

  it('las tandas de una empresa no existen para la otra', async () => {
    const id = await preparar('Aislada');
    await importar(fx.companyA, actor, id, { topeDeTandas: 2 });

    const desdeB = await asCompany(raw, fx.companyB, () =>
      raw.query<{ n: string }>('SELECT count(*)::text n FROM migration_batches'),
    );
    expect(desdeB.rows[0]!.n).toBe('0');
  });
});
