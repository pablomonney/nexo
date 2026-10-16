/**
 * E4 — la numeración fiscal es correlativa (migración 0138), probada contra la base.
 *
 * ARCA **no tolera huecos** (pedir último+2 se rechaza con el error 10016, medido en homologación el 2026-10-16) y un
 * rechazo **no consume** el número. Lo que se afirma:
 *
 *   1. El número reservado es **el siguiente al último autorizado por ARCA**, no el del contador local.
 *   2. Una intención RECHAZADA libera su número: el pedido siguiente lleva el mismo. Una ANULADA también.
 *   3. Una intención en DESCONOCIDA **no** lo libera: puede estar autorizada, y reusar su número es la doble emisión.
 *   4. **Una sola emisión en curso por punto de venta y tipo**: la segunda no reserva (55P03) hasta que se resuelva la primera.
 *   5. Si ARCA dice un último autorizado menor que el que esta empresa ya tiene autorizado, no se reserva.
 *   6. Es idempotente, y dos reservas simultáneas en el mismo carril dan exactamente un ganador.
 */

import { closePool, initPool } from '@aai/db';
import { withCheckDigit } from '@aai/shared';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { asCompany, connect, hasDatabase, type Client } from './helpers/db.js';
import { sufijoUnico } from './helpers/identificadores.js';

const suite = hasDatabase ? describe : describe.skip;

suite('E4 · numeración correlativa de la emisión', () => {
  let db: Client;
  let empresa: string;
  let carril = 100;

  /** Cada prueba usa su propio punto de venta: los carriles no se pisan entre sí. */
  const nuevoPuntoDeVenta = (): number => {
    carril += 1;
    return carril;
  };

  const declarar = async (pv: number, tipo = 11): Promise<string> =>
    (
      await asCompany(db, empresa, () =>
        db.query<{ id: string }>(
          `INSERT INTO fiscal_emissions (company_id, ambiente, origen_tipo, origen_id, punto_venta, cbte_tipo, creado_por)
           VALUES ($1, 'homologacion', 'COMMERCIAL_DOCUMENT', $2, $3, $4, 'test') RETURNING id`,
          [empresa, crypto.randomUUID(), pv, tipo],
        ),
      )
    ).rows[0]!.id;

  const reservar = async (id: string, ultimoArca: number): Promise<{ numero?: string; code?: string }> => {
    try {
      const r = await asCompany(db, empresa, () =>
        db.query<{ n: string }>('SELECT reservar_numero_fiscal_correlativo($1, $2)::text AS n', [id, ultimoArca]),
      );
      return { numero: r.rows[0]!.n };
    } catch (error) {
      return { code: (error as { code?: string }).code ?? '' };
    }
  };

  const pasar = async (id: string, estado: string, extra = ''): Promise<void> => {
    await asCompany(db, empresa, () =>
      db.query(`UPDATE fiscal_emissions SET estado = $2 ${extra} WHERE id = $1`, [id, estado]),
    );
  };

  const estadoDe = async (id: string): Promise<string> =>
    (await asCompany(db, empresa, () => db.query<{ estado: string }>('SELECT estado FROM fiscal_emissions WHERE id = $1', [id])))
      .rows[0]!.estado;

  beforeAll(async () => {
    initPool(process.env.DATABASE_URL!);
    db = await connect();
    const stamp = await sufijoUnico(db);
    const userId = (
      await db.query<{ id: string }>('INSERT INTO users (email, full_name, password_hash) VALUES ($1,$2,$3) RETURNING id', [
        `correlativa-${stamp}@estudio.test`,
        'Numeradora',
        'x',
      ])
    ).rows[0]!.id;
    const org = (
      await db.query<{ create_organization: string }>('SELECT create_organization($1,$2,$3)', [
        `Estudio correlativa ${stamp}`,
        withCheckDigit(`30${stamp}`),
        userId,
      ])
    ).rows[0]!.create_organization;
    empresa = (
      await db.query<{ create_company: string }>('SELECT create_company($1,$2,$3,$4,$5,$6,$7,$8)', [
        userId,
        org,
        'Correlativa SA',
        withCheckDigit(`33${stamp}`),
        'SA',
        'AR-C',
        'IGJ',
        '12-31',
      ])
    ).rows[0]!.create_company;
  });

  afterAll(async () => {
    await db?.end();
    await closePool();
  });

  it('el número reservado es el siguiente al último autorizado por ARCA, no el del contador local', async () => {
    const pv = nuevoPuntoDeVenta();
    const id = await declarar(pv);
    const r = await reservar(id, 51);
    expect(r.numero).toBe('52');
    expect(await estadoDe(id)).toBe('LISTA');
    const c = await asCompany(db, empresa, () =>
      db.query<{ n: string }>(
        `SELECT last_number::text AS n FROM fiscal_counters WHERE punto_venta = $1 AND cbte_tipo = 11 AND ambiente = 'homologacion'`,
        [pv],
      ),
    );
    expect(c.rows[0]!.n).toBe('52');
  });

  it('es idempotente: reservar dos veces no consume otro número ni toca el contador', async () => {
    const id = await declarar(nuevoPuntoDeVenta());
    expect((await reservar(id, 10)).numero).toBe('11');
    expect((await reservar(id, 10)).numero).toBe('11');
    // Aunque ARCA «avanzara» entre los dos pedidos, el número ya reservado no se mueve.
    expect((await reservar(id, 30)).numero).toBe('11');
  });

  it('una intención RECHAZADA libera su número: la siguiente lleva el mismo (ARCA no avanzó)', async () => {
    const pv = nuevoPuntoDeVenta();
    const a = await declarar(pv);
    expect((await reservar(a, 51)).numero).toBe('52');
    await pasar(a, 'EMITIENDO');
    await pasar(a, 'RECHAZADA', ", ultimo_error = 'ARCA rechazó (10015)'");

    const b = await declarar(pv);
    expect((await reservar(b, 51)).numero, 'tras un rechazo, el siguiente pedido lleva el mismo número').toBe('52');
  });

  it('una intención ANULADA también libera su número', async () => {
    const pv = nuevoPuntoDeVenta();
    const a = await declarar(pv);
    expect((await reservar(a, 7)).numero).toBe('8');
    await pasar(a, 'ANULADA');

    const b = await declarar(pv);
    expect((await reservar(b, 7)).numero).toBe('8');
  });

  it('una intención en DESCONOCIDA NO libera el carril: puede estar autorizada, y reusar el número es la doble emisión', async () => {
    const pv = nuevoPuntoDeVenta();
    const a = await declarar(pv);
    await reservar(a, 51);
    await pasar(a, 'EMITIENDO');
    await pasar(a, 'DESCONOCIDA');

    const b = await declarar(pv);
    expect((await reservar(b, 51)).code, 'se reservó un número con una emisión en duda en el mismo carril').toBe('55P03');
    expect((await reservar(b, 52)).code).toBe('55P03');
    expect(await estadoDe(b)).toBe('BORRADOR');
  });

  it('una sola emisión en curso por carril: mientras haya una LISTA, EMITIENDO o RECONCILIANDO, no se reserva otra', async () => {
    const pv = nuevoPuntoDeVenta();
    const a = await declarar(pv);
    await reservar(a, 0);
    const b = await declarar(pv);
    expect((await reservar(b, 0)).code, 'LISTA bloquea').toBe('55P03');

    await pasar(a, 'EMITIENDO');
    expect((await reservar(b, 0)).code, 'EMITIENDO bloquea').toBe('55P03');
    await pasar(a, 'DESCONOCIDA');
    await pasar(a, 'RECONCILIANDO');
    expect((await reservar(b, 0)).code, 'RECONCILIANDO bloquea').toBe('55P03');
  });

  it('la autorizada libera el carril, y el siguiente sigue a ARCA', async () => {
    const pv = nuevoPuntoDeVenta();
    const a = await declarar(pv);
    expect((await reservar(a, 51)).numero).toBe('52');
    await pasar(a, 'EMITIENDO');
    await pasar(a, 'AUTORIZADA', ", cae = '86421002211999', cae_vencimiento = '2026-10-26'");

    const b = await declarar(pv);
    expect((await reservar(b, 52)).numero).toBe('53');
  });

  it('si ARCA dice un último autorizado menor que el que esta empresa ya tiene autorizado, no se reserva', async () => {
    const pv = nuevoPuntoDeVenta();
    const a = await declarar(pv);
    await reservar(a, 51);
    await pasar(a, 'EMITIENDO');
    await pasar(a, 'AUTORIZADA', ", cae = '86421002211998', cae_vencimiento = '2026-10-26'");

    const b = await declarar(pv);
    expect((await reservar(b, 40)).code).toBe('23514'); // check_violation
    expect(await estadoDe(b)).toBe('BORRADOR');
  });

  it('un último autorizado inválido se rechaza', async () => {
    const id = await declarar(nuevoPuntoDeVenta());
    expect((await reservar(id, -1)).code).toBe('22023'); // invalid_parameter_value
  });

  it('dos reservas simultáneas en el mismo carril dan exactamente un ganador', async () => {
    const pv = nuevoPuntoDeVenta();
    const a = await declarar(pv);
    const b = await declarar(pv);
    // Dos conexiones distintas: la base tiene que serializar, no el cliente.
    const otra = await connect();
    try {
      const sobre = async (cliente: Client, id: string): Promise<{ numero?: string; code?: string }> => {
        try {
          await cliente.query('BEGIN');
          await cliente.query('SET LOCAL ROLE aai_app');
          await cliente.query('SELECT set_config($1, $2, true)', ['app.company_id', empresa]);
          const r = await cliente.query<{ n: string }>('SELECT reservar_numero_fiscal_correlativo($1, 51)::text AS n', [id]);
          await cliente.query('COMMIT');
          return { numero: r.rows[0]!.n };
        } catch (error) {
          await cliente.query('ROLLBACK').catch(() => undefined);
          return { code: (error as { code?: string }).code ?? '' };
        }
      };
      const [ra, rb] = await Promise.all([sobre(db, a), sobre(otra, b)]);
      const ganadores = [ra, rb].filter((r) => r.numero !== undefined);
      const perdedores = [ra, rb].filter((r) => r.code === '55P03');
      expect(ganadores).toHaveLength(1);
      expect(perdedores).toHaveLength(1);
      expect(ganadores[0]!.numero).toBe('52');
    } finally {
      await otra.end();
    }
  });

  it('carriles distintos (otro punto de venta, otro tipo) no se bloquean entre sí', async () => {
    const pv = nuevoPuntoDeVenta();
    const a = await declarar(pv, 11);
    await reservar(a, 5);
    const otroTipo = await declarar(pv, 6);
    const otroPv = await declarar(nuevoPuntoDeVenta(), 11);
    expect((await reservar(otroTipo, 0)).numero).toBe('1');
    expect((await reservar(otroPv, 0)).numero).toBe('1');
  });

  it('el número de una rechazada queda en su historia, pero no impide el de la siguiente (el índice no la cuenta)', async () => {
    const pv = nuevoPuntoDeVenta();
    const a = await declarar(pv);
    await reservar(a, 3);
    await pasar(a, 'EMITIENDO');
    await pasar(a, 'RECHAZADA', ", ultimo_error = 'rechazo'");
    const b = await declarar(pv);
    expect((await reservar(b, 3)).numero).toBe('4');
    const n = await asCompany(db, empresa, () =>
      db.query<{ c: string }>(
        `SELECT count(*)::text AS c FROM fiscal_emissions WHERE punto_venta = $1 AND cbte_numero = 4`,
        [pv],
      ),
    );
    expect(n.rows[0]!.c).toBe('2');
  });
});
