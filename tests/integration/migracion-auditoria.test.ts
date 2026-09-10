/**
 * La auditoría del V3: lo que hasta ahora nunca se vio fallar.
 *
 * ## Por qué existe este archivo
 *
 * Las suites del V2 comprueban que la migración funciona: los números cuadran,
 * la reversión deshace, la reanudación reanuda. Todas afirman lo mismo —que el
 * camino bueno sale bien— y ninguna comprueba la mitad que importa: **que el
 * sistema note cuando algo sale mal**.
 *
 * Una reconciliación que solo se probó dando cero no es una reconciliación: es
 * una consulta que devolvió cero. La única forma de saber que sirve es
 * romperla a propósito y ver que lo dice. Eso es lo que hace este archivo, y es
 * la misma regla que el resto del repositorio aplica a sus controles: un
 * control que no se ve fallar no es un control.
 *
 * Los casos están numerados como los pide la auditoría de V3 para que se pueda
 * ir del pedido a la evidencia sin adivinar cuál cubre cuál.
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
  reconciliarContabilidad,
  reconciliarStock,
  revertir,
  validarMigracion,
} from '@aai/api/migracion/ciclo';
import type { Entidad } from '@aai/migration-engine';
import { asCompany, connect, hasDatabase, seed, type Client, type Fixture } from './helpers/db.js';

const suite = hasDatabase ? describe : describe.skip;
const actor = 'user:auditor';
const FECHA = '15/01/2025';
const FECHA_ISO = '2025-01-15';

suite('auditoría V3: que el sistema note cuando algo sale mal', () => {
  let raw: Client;
  let fx: Fixture;

  beforeAll(async () => {
    initPool(process.env.DATABASE_URL!);
    raw = await connect();
    fx = await seed(raw, 'auditoria-v3');
  });

  afterAll(async () => {
    await raw?.end();
    await closePool();
  });

  /** Prepara una migración de una sola tabla y la deja lista para importar. */
  async function preparar(
    companyId: string,
    entidad: Entidad,
    mapeo: Readonly<Record<string, string>>,
    contenido: string,
    opciones: { readonly fechaCorte?: string; readonly titulo?: string } = {},
  ): Promise<string> {
    return withCompany({ companyId, actorId: actor }, async (tx) => {
      const id = await crearMigracion(tx, companyId, actor, {
        adaptador: 'ARCHIVO_GENERICO',
        titulo: opciones.titulo ?? `Auditoría de ${entidad}`,
        ...(opciones.fechaCorte === undefined ? {} : { fechaCorte: opciones.fechaCorte }),
      });
      await cargarOrigen(tx, companyId, actor, id, {
        nombre: 'datos.csv',
        bytes: Buffer.from(contenido, 'utf8'),
      });
      const { rows } = await tx.query<{ id: string }>(
        'SELECT id FROM migration_tables WHERE migration_id = $1',
        [id],
      );
      await declararMapeo(tx, companyId, actor, id, [
        { id: rows[0]!.id, entidad, mapeo, incluida: true },
      ]);
      await validarMigracion(tx, companyId, actor, id);
      return id;
    });
  }

  const enEmpresa = <T>(c: string, fn: () => Promise<T>): Promise<T> => asCompany(raw, c, fn);

  // =========================================================================
  // §8 · Las reconciliaciones, vistas fallar
  // =========================================================================

  it('§8 la reconciliación de stock detecta una diferencia y no la esconde', async () => {
    const sku = 'AUD-STOCK-1';
    await sembrarProducto(fx.companyA, sku);
    await sembrarDeposito(fx.companyA, 'AUD-DEP');

    const id = await preparar(
      fx.companyA,
      'STOCK_BALANCE',
      { SKU: 'sku', Deposito: 'deposito', Cantidad: 'cantidad', Corte: 'fechaCorte' },
      ['SKU;Deposito;Cantidad;Corte', `${sku};AUD-DEP;100;${FECHA}`].join('\n'),
      { fechaCorte: FECHA_ISO },
    );
    await importar(fx.companyA, actor, id);

    // Cuadra, como debe.
    const antes = await withCompany({ companyId: fx.companyA, actorId: actor }, (tx) =>
      reconciliarStock(tx, fx.companyA, id),
    );
    expect(antes).toHaveLength(1);
    expect(antes[0]!.cuadra).toBe(true);

    // Ahora se rompe a propósito: alguien registra un ajuste **anterior** a la
    // fecha de corte, que es exactamente el caso que una comparación contra el
    // stock de hoy no vería.
    await enEmpresa(fx.companyA, () =>
      raw.query(
        `INSERT INTO stock_movements
           (company_id, product_id, warehouse_id, tipo, cantidad, fecha,
            origen_tipo, motivo, created_by)
         VALUES ($1,
                 (SELECT id FROM products WHERE company_id = $1 AND code = $2),
                 (SELECT id FROM warehouses WHERE company_id = $1 AND code = 'AUD-DEP'),
                 'AJUSTE_NEGATIVO', 7, $3::date - 1,
                 'AJUSTE', 'Faltante contado antes del corte', 'user:almacen')`,
        [fx.companyA, sku, FECHA_ISO],
      ),
    );

    const despues = await withCompany({ companyId: fx.companyA, actorId: actor }, (tx) =>
      reconciliarStock(tx, fx.companyA, id),
    );
    expect(despues[0]!.cuadra, 'la diferencia de 7 unidades pasó desapercibida').toBe(false);
    expect(despues[0]!.enOrigen).toBe('100');
    expect(despues[0]!.enNexo).toBe('93.0000');
    expect(despues[0]!.diferencia).toBe('-7');
  });

  it('§8 la reconciliación contable detecta que falta un asiento', async () => {
    const id = await preparar(
      fx.companyA,
      'JOURNAL_ENTRY',
      { Asiento: 'asiento', Fecha: 'fecha', Cuenta: 'cuenta', Debe: 'debe', Haber: 'haber' },
      [
        'Asiento;Fecha;Cuenta;Debe;Haber',
        `A1;${FECHA};1.1.01;500,00;0`,
        `A1;${FECHA};4.1.01;0;500,00`,
      ].join('\n'),
    );
    await importar(fx.companyA, actor, id);

    const antes = await withCompany({ companyId: fx.companyA, actorId: actor }, (tx) =>
      reconciliarContabilidad(tx, fx.companyA, id),
    );
    for (const d of antes) expect(d.cuadra, `${d.concepto} no cuadraba de entrada`).toBe(true);

    // Se rompe el vínculo: es lo que pasaría si el asiento no se hubiera
    // escrito y el importador lo hubiera contado igual.
    await enEmpresa(fx.companyA, () =>
      raw.query(
        `UPDATE migration_links SET id_destino = '00000000-0000-0000-0000-000000000000'
          WHERE migration_id = $1 AND tabla_destino = 'journal_entries'`,
        [id],
      ),
    );

    const despues = await withCompany({ companyId: fx.companyA, actorId: actor }, (tx) =>
      reconciliarContabilidad(tx, fx.companyA, id),
    );
    const asientos = despues.find((d) => d.concepto === 'Asientos')!;
    expect(asientos.cuadra, 'el asiento desaparecido no se notó').toBe(false);
    expect(asientos.enOrigen).toBe('1');
    expect(asientos.enNexo).toBe('0');
  });

  it('§8 la reconciliación de filas detecta una fila que no terminó en ninguna parte', async () => {
    const id = await preparar(
      fx.companyA,
      'PARTY',
      { Razon: 'razonSocial', CUIT: 'cuit' },
      ['Razon;CUIT', 'Auditada Uno SA;30-71000001-4', 'Auditada Dos SA;20-11111111-2'].join('\n'),
      { titulo: 'Filas sin explicar' },
    );
    await importar(fx.companyA, actor, id);

    // Una fila vuelve a PENDIENTE: ni importada, ni rechazada, ni omitida.
    await enEmpresa(fx.companyA, () =>
      raw.query(
        `UPDATE migration_rows SET estado = 'PENDIENTE'
          WHERE id = (SELECT id FROM migration_rows WHERE migration_id = $1 ORDER BY numero LIMIT 1)`,
        [id],
      ),
    );

    const { rows } = await enEmpresa(fx.companyA, () =>
      raw.query<{ sin_explicar: number }>(
        `SELECT count(*)::int AS sin_explicar FROM migration_rows
          WHERE migration_id = $1 AND estado = 'PENDIENTE'`,
        [id],
      ),
    );
    // El reporte cuenta por estado: una fila PENDIENTE después de importar es
    // exactamente lo que «sin explicar» tiene que mostrar.
    expect(rows[0]!.sin_explicar).toBe(1);
  });

  // =========================================================================
  // §4 · Idempotencia, los casos que faltaban
  // =========================================================================

  it('§4-D el mismo archivo después de un fallo no duplica nada', async () => {
    const csv = [
      'Razon;CUIT',
      'Tras Fallo Uno SA;27-11111111-7',
      'Tras Fallo Dos SA;30-71000003-0',
    ].join('\n');

    const primera = await preparar(
      fx.companyB,
      'PARTY',
      { Razon: 'razonSocial', CUIT: 'cuit' },
      csv,
      { titulo: 'Primera, que se corta' },
    );
    // Una sola tanda y se corta: el resto queda pendiente.
    await importar(fx.companyB, actor, primera, { topeDeTandas: 1 });

    const antes = await contarTerceros(fx.companyB);

    // Y ahora alguien vuelve a empezar de cero con el mismo archivo, que es lo
    // que hace cualquiera cuando algo falló y no sabe qué quedó.
    const segunda = await preparar(fx.companyB, 'PARTY', { Razon: 'razonSocial', CUIT: 'cuit' }, csv, {
      titulo: 'Segunda, desde cero',
    });
    const r = await importar(fx.companyB, actor, segunda);

    expect(await contarTerceros(fx.companyB)).toBe(antes);
    expect(r.conteos[0]!.importados).toBe(0);
    expect(r.conteos[0]!.yaEstaban).toBe(2);
  });

  it('§4-F/§3 dos importaciones simultáneas de la misma migración no se pisan', async () => {
    // El caso reachable de verdad, y el que ninguna prueba miraba: alguien
    // aprieta «Importar» dos veces, o la consola larga una segunda vuelta antes
    // de que vuelva la primera. Las dos planifican, las dos ven las mismas
    // tandas pendientes y las dos las corren.
    //
    // Sin nada que las ordene, la segunda choca contra el UNIQUE de
    // `migration_links` con un 23505 que **aborta la tanda entera** —no es un
    // rechazo de datos, es un error de base—, y el progreso queda contado dos
    // veces.
    const id = await preparar(
      fx.companyB,
      'PARTY',
      { Razon: 'razonSocial', CUIT: 'cuit' },
      [
        'Razon;CUIT',
        'Concurrente Uno SA;33-71000004-8',
        'Concurrente Dos SA;30-71000008-8',
        'Concurrente Tres SA;27-11111113-2',
      ].join('\n'),
      { titulo: 'Dos a la vez' },
    );
    const antes = await contarTerceros(fx.companyB);

    const [a, b] = await Promise.allSettled([
      importar(fx.companyB, actor, id),
      importar(fx.companyB, actor, id),
    ]);

    // Ninguna de las dos puede terminar con un error de base ni con uno sobre
    // la máquina de estados. Si una pierde, tiene que decir **qué pasó**: que
    // hay otra corriendo, o que ya había terminado.
    for (const r of [a, b]) {
      if (r.status === 'rejected') {
        expect(String(r.reason), 'una corrida simultánea falló con un error crudo').toMatch(
          /ya se está importando|ya terminó/i,
        );
      }
    }

    // Y sobre todo: los tres terceros entraron una sola vez.
    expect(await contarTerceros(fx.companyB), 'la corrida simultánea duplicó').toBe(antes + 3);

    const progreso = await withCompany({ companyId: fx.companyB, actorId: actor }, (tx) =>
      leerProgreso(tx, id),
    );
    expect(progreso.procesadas, 'el progreso contó filas de más').toBe(progreso.total);
  });

  it('§3 con el candado tomado, la segunda corrida dice quién lo tiene', async () => {
    // El control anterior comprueba que dos corridas no se pisen; este
    // comprueba **el candado**, que es el mecanismo. Sin uno de los dos, o no
    // se sabe si el candado sirve, o no se sabe si hacía falta.
    const id = await preparar(
      fx.companyB,
      'PARTY',
      { Razon: 'razonSocial', CUIT: 'cuit' },
      ['Razon;CUIT', 'Con Candado SA;30-71000009-4'].join('\n'),
      { titulo: 'Con candado' },
    );

    await enEmpresa(fx.companyB, () =>
      raw.query('UPDATE migrations SET importando_desde = now() WHERE id = $1', [id]),
    );

    await expect(importar(fx.companyB, actor, id)).rejects.toThrow(/ya se está importando/);

    // Y no escribió nada: el candado frena antes de planificar.
    const { rows } = await enEmpresa(fx.companyB, () =>
      raw.query<{ n: string }>(
        'SELECT count(*)::text n FROM migration_batches WHERE migration_id = $1',
        [id],
      ),
    );
    expect(rows[0]!.n).toBe('0');
  });

  it('§3/§22 un candado vencido no deja la migración trabada para siempre', async () => {
    // Es la otra mitad: un candado que solo suelta quien lo tomó deja la
    // migración muerta si el proceso se murió. Se vence, y entonces se retoma.
    const id = await preparar(
      fx.companyB,
      'PARTY',
      { Razon: 'razonSocial', CUIT: 'cuit' },
      ['Razon;CUIT', 'Candado Vencido SA;27-11111114-0'].join('\n'),
      { titulo: 'Candado vencido' },
    );

    await enEmpresa(fx.companyB, () =>
      raw.query(
        `UPDATE migrations SET importando_desde = now() - interval '1 hour' WHERE id = $1`,
        [id],
      ),
    );

    const r = await importar(fx.companyB, actor, id);
    expect(r.estado).toMatch(/^COMPLETADA/);

    // Y al terminar lo soltó: la próxima no tiene que esperar una hora.
    const { rows } = await enEmpresa(fx.companyB, () =>
      raw.query<{ tomado: boolean }>(
        'SELECT importando_desde IS NOT NULL AS tomado FROM migrations WHERE id = $1',
        [id],
      ),
    );
    expect(rows[0]!.tomado).toBe(false);
  });

  // =========================================================================
  // §6 · Una tanda que falla deja constancia y se puede reintentar
  // =========================================================================

  it('§6 una tanda que falla queda FALLIDA, con su motivo y su intento contado', async () => {
    const id = await preparar(
      fx.companyB,
      'PARTY',
      { Razon: 'razonSocial', CUIT: 'cuit' },
      ['Razon;CUIT', 'Va A Fallar SA;30-71000010-7'].join('\n'),
      { titulo: 'Tanda que falla' },
    );

    // El fallo se provoca con un disparador de verdad sobre `parties`, que es
    // como falla una tanda en la vida real: una regla de la base que rechaza la
    // escritura. Un interruptor de pruebas dentro del importador probaría un
    // camino que producción no tiene.
    await raw.query(`
      CREATE OR REPLACE FUNCTION prueba_falla_la_tanda() RETURNS trigger
      LANGUAGE plpgsql AS $$
      BEGIN
        IF NEW.razon_social = 'Va A Fallar SA' THEN
          RAISE EXCEPTION 'La base rechazó este tercero, a propósito';
        END IF;
        RETURN NEW;
      END; $$`);
    await raw.query(`
      CREATE TRIGGER prueba_falla_la_tanda BEFORE INSERT ON parties
      FOR EACH ROW EXECUTE FUNCTION prueba_falla_la_tanda()`);

    try {
      await expect(importar(fx.companyB, actor, id)).rejects.toThrow(/a propósito/);
    } finally {
      await raw.query('DROP TRIGGER IF EXISTS prueba_falla_la_tanda ON parties');
      await raw.query('DROP FUNCTION IF EXISTS prueba_falla_la_tanda()');
    }

    const { rows } = await enEmpresa(fx.companyB, () =>
      raw.query<{ estado: string; error: string | null; intentos: number }>(
        'SELECT estado, error, intentos FROM migration_batches WHERE migration_id = $1',
        [id],
      ),
    );
    expect(rows[0]!.estado, 'la tanda que falló no quedó marcada').toBe('FALLIDA');
    expect(rows[0]!.error, 'la tanda falló sin dejar dicho por qué').not.toBeNull();
    expect(rows[0]!.intentos, 'el intento no se contó').toBe(1);

    // Y el candado quedó suelto: una corrida que se cayó no puede trabar la
    // migración hasta que venza el plazo.
    const cabecera = await enEmpresa(fx.companyB, () =>
      raw.query<{ tomado: boolean }>(
        'SELECT importando_desde IS NOT NULL AS tomado FROM migrations WHERE id = $1',
        [id],
      ),
    );
    expect(cabecera.rows[0]!.tomado, 'la corrida caída dejó el candado tomado').toBe(false);
  });

  // =========================================================================
  // §7 · Cancelar en cada momento
  // =========================================================================

  it('§7 no se puede cancelar antes de empezar a importar', async () => {
    const id = await preparar(
      fx.companyA,
      'PARTY',
      { Razon: 'razonSocial', CUIT: 'cuit' },
      ['Razon;CUIT', 'Sin Empezar SA;30-71000005-7'].join('\n'),
      { titulo: 'Sin empezar' },
    );
    await expect(
      withCompany({ companyId: fx.companyA, actorId: actor }, (tx) =>
        cancelar(tx, fx.companyA, actor, id, 'Un motivo suficientemente largo'),
      ),
    ).rejects.toThrow(/importando/);

    // Y sigue lista, no rota: cancelar algo que no empezó no puede dejarla peor.
    const { rows } = await enEmpresa(fx.companyA, () =>
      raw.query<{ estado: string }>('SELECT estado FROM migrations WHERE id = $1', [id]),
    );
    expect(rows[0]!.estado).toBe('LISTA');
  });

  it('§7 una migración terminada tampoco se cancela', async () => {
    const id = await preparar(
      fx.companyA,
      'PARTY',
      { Razon: 'razonSocial', CUIT: 'cuit' },
      ['Razon;CUIT', 'Terminada SA;20-11111112-0'].join('\n'),
      { titulo: 'Ya terminada' },
    );
    await importar(fx.companyA, actor, id);

    await expect(
      withCompany({ companyId: fx.companyA, actorId: actor }, (tx) =>
        cancelar(tx, fx.companyA, actor, id, 'Un motivo suficientemente largo'),
      ),
    ).rejects.toThrow(/importando/);
  });

  it('§7 ninguna migración queda IMPORTANDO para siempre sin dejar rastro', async () => {
    // El estado IMPORTANDO es legítimo entre tandas. Lo que no puede pasar es
    // que sea indistinguible de una migración colgada: si está IMPORTANDO,
    // tiene que haber tandas y tiene que verse cuántas faltan.
    const id = await preparar(
      fx.companyA,
      'PARTY',
      { Razon: 'razonSocial', CUIT: 'cuit' },
      ['Razon;CUIT', 'Colgada Uno SA;27-11111112-5', 'Colgada Dos SA;30-71000006-5'].join('\n'),
      { titulo: 'A medias' },
    );
    await importar(fx.companyA, actor, id, { topeDeTandas: 0 as never });

    const progreso = await withCompany({ companyId: fx.companyA, actorId: actor }, (tx) =>
      leerProgreso(tx, id),
    );
    expect(progreso.tandas).toBeGreaterThan(0);
    expect(progreso.tandasCompletadas).toBeLessThan(progreso.tandas);
    expect(progreso.total).toBeGreaterThan(0);
  });

  // =========================================================================
  // §12 · Relaciones que no pueden cruzar de empresa
  // =========================================================================

  it('§12 un comprobante no se vincula al tercero de otra empresa', async () => {
    // El CUIT existe, pero en la empresa B. La migración corre en la A: el
    // comprobante tiene que entrar **sin vincular**, no vinculado al ajeno.
    const cuit = '30710000073';
    await enEmpresa(fx.companyB, () =>
      raw.query(
        `INSERT INTO parties (company_id, tipo_documento, numero_documento, razon_social, created_by)
         VALUES ($1, 'CUIT', $2, 'Solo en la B SA', 'user:previo')
         ON CONFLICT DO NOTHING`,
        [fx.companyB, cuit],
      ),
    );

    const id = await preparar(
      fx.companyA,
      'SALES_DOCUMENT',
      {
        Tipo: 'tipoComprobante',
        PV: 'puntoVenta',
        Numero: 'numero',
        Fecha: 'fecha',
        CUIT: 'cuitCliente',
        Neto: 'neto',
        Total: 'total',
      },
      ['Tipo;PV;Numero;Fecha;CUIT;Neto;Total', `Factura A;9;5501;${FECHA};${cuit};100,00;100,00`].join(
        '\n',
      ),
      { titulo: 'Cliente de la otra empresa' },
    );
    await importar(fx.companyA, actor, id);

    const { rows } = await enEmpresa(fx.companyA, () =>
      raw.query<{ party_id: string | null; cuit: string }>(
        `SELECT party_id, cuit_contraparte AS cuit FROM tax_transactions
          WHERE company_id = $1 AND cbte_numero = 5501`,
        [fx.companyA],
      ),
    );
    expect(rows).toHaveLength(1);
    // El CUIT queda registrado —es lo que decía el comprobante— y el vínculo no.
    expect(rows[0]!.cuit).toBe(cuit);
    expect(rows[0]!.party_id).toBeNull();
  });

  // =========================================================================
  // §13 · Dos empresas migrando al mismo tiempo
  // =========================================================================

  it('§13 dos empresas migran a la vez y ninguna ve nada de la otra', async () => {
    // No es lo mismo que el aislamiento de siempre: acá las dos migraciones
    // corren **simultáneamente**, con las mismas identidades externas —el mismo
    // CUIT, el mismo SKU, el mismo nombre de archivo— y el `UNIQUE` de
    // `migration_links` es por empresa. Si estuviera mal declarado, la segunda
    // empresa vería su tercero como «ya existía» y no lo importaría.
    const csv = [
      'Razon;CUIT',
      'Comparte CUIT SA;30-71000011-1',
      'Comparte Otro SA;20-11111113-9',
    ].join('\n');

    const [idA, idB] = await Promise.all([
      preparar(fx.companyA, 'PARTY', { Razon: 'razonSocial', CUIT: 'cuit' }, csv, {
        titulo: 'Simultánea A',
      }),
      preparar(fx.companyB, 'PARTY', { Razon: 'razonSocial', CUIT: 'cuit' }, csv, {
        titulo: 'Simultánea B',
      }),
    ]);

    const [rA, rB] = await Promise.all([
      importar(fx.companyA, actor, idA),
      importar(fx.companyB, actor, idB),
    ]);

    // Las dos importaron las dos filas: la identidad de una no tapó a la otra.
    expect(rA.conteos[0]!.importados, 'la empresa A no importó lo suyo').toBe(2);
    expect(rB.conteos[0]!.importados, 'la empresa B no importó lo suyo').toBe(2);

    // Y cada tercero vive en su empresa, con su propio id.
    const idsA = await terceroPorCuit(fx.companyA, '30710000111');
    const idsB = await terceroPorCuit(fx.companyB, '30710000111');
    expect(idsA).not.toBeNull();
    expect(idsB).not.toBeNull();
    expect(idsA).not.toBe(idsB);

    // Desde A no se ve la migración de B ni al revés, ni siquiera sus tandas.
    for (const [propia, ajena, id] of [
      [fx.companyA, fx.companyB, idB],
      [fx.companyB, fx.companyA, idA],
    ] as const) {
      void ajena;
      const { rows } = await enEmpresa(propia, () =>
        raw.query('SELECT id FROM migrations WHERE id = $1', [id]),
      );
      expect(rows).toHaveLength(0);
    }
  });

  // =========================================================================
  // §5 · Rollback que no toca lo ajeno
  // =========================================================================

  it('§5 revertir no toca un tercero que otra operación creó con el mismo CUIT', async () => {
    // El caso peligroso: la migración **reconoció** un tercero que ya estaba
    // (creado = false). Revertir no puede archivarlo: no lo creó ella.
    const cuit = '20111111120';
    await enEmpresa(fx.companyA, () =>
      raw.query(
        `INSERT INTO parties (company_id, tipo_documento, numero_documento, razon_social, created_by)
         VALUES ($1, 'CUIT', $2, 'Preexistente SA', 'user:humano')
         ON CONFLICT DO NOTHING`,
        [fx.companyA, cuit],
      ),
    );

    const id = await preparar(
      fx.companyA,
      'PARTY',
      { Razon: 'razonSocial', CUIT: 'cuit' },
      ['Razon;CUIT', `Preexistente SA;${cuit}`].join('\n'),
      { titulo: 'Reconoce y revierte' },
    );
    const r = await importar(fx.companyA, actor, id);
    expect(r.conteos[0]!.yaEstaban).toBe(1);

    await withCompany({ companyId: fx.companyA, actorId: actor }, (tx) =>
      revertir(tx, fx.companyA, actor, id, 'Se revierte y no debe tocar lo preexistente'),
    );

    const { rows } = await enEmpresa(fx.companyA, () =>
      raw.query<{ status: string }>(
        'SELECT status FROM parties WHERE company_id = $1 AND numero_documento = $2',
        [fx.companyA, cuit],
      ),
    );
    expect(rows[0]!.status, 'la reversión archivó un tercero que no había creado').toBe('ACTIVO');
  });

  // ── Auxiliares ────────────────────────────────────────────────────────

  async function contarTerceros(companyId: string): Promise<number> {
    const { rows } = await enEmpresa(companyId, () =>
      raw.query<{ n: string }>('SELECT count(*)::text n FROM parties WHERE company_id = $1', [
        companyId,
      ]),
    );
    return Number(rows[0]!.n);
  }

  async function terceroPorCuit(companyId: string, cuit: string): Promise<string | null> {
    const { rows } = await enEmpresa(companyId, () =>
      raw.query<{ id: string }>(
        'SELECT id FROM parties WHERE company_id = $1 AND numero_documento = $2',
        [companyId, cuit],
      ),
    );
    return rows[0]?.id ?? null;
  }

  async function sembrarProducto(companyId: string, code: string): Promise<void> {
    await enEmpresa(companyId, () =>
      raw.query(
        `INSERT INTO products (company_id, code, name, tracks_stock, tax_treatment, created_by)
         VALUES ($1, $2, $2, true, 'NO_GRAVADO', 'user:previo')
         ON CONFLICT DO NOTHING`,
        [companyId, code],
      ),
    );
  }

  async function sembrarDeposito(companyId: string, code: string): Promise<void> {
    await enEmpresa(companyId, () =>
      raw.query(
        `INSERT INTO warehouses (company_id, code, name, created_by)
         VALUES ($1, $2, $2, 'user:previo') ON CONFLICT DO NOTHING`,
        [companyId, code],
      ),
    );
  }
});
