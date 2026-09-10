/**
 * S-42 — Una factura no se emite dos veces.
 *
 * Emitir es pedirle a ARCA que autorice una factura a nombre del contribuyente,
 * y **eso no se deshace**: un comprobante de más no se borra, se anula con una
 * nota de crédito, que es otro comprobante con su numeración y su impacto
 * contable.
 *
 * El caso que ordena toda la fase:
 *
 *     se manda el pedido → se corta → no se sabe si ARCA autorizó
 *
 * Reintentar ahí duplica la factura. Este archivo comprueba que el sistema no
 * pueda hacerlo, y lo comprueba **contra la base**, no contra una función: la
 * concurrencia y las transiciones prohibidas se resuelven en PostgreSQL, y una
 * regla que solo viva en TypeScript la saltea la primera consulta suelta.
 *
 * ## Lo que este archivo NO prueba
 *
 * Que emitir funcione. **No hay emisión habilitada** y `@aai/arca-emision`
 * sigue fuera del grafo de la aplicación. Lo que se prueba es la seguridad que
 * habrá que tener el día que esa regla se saque a sabiendas — construida antes,
 * que es la única forma de que no la escriba el apuro.
 */

import { closePool, initPool } from '@aai/db';
import {
  claveDeIntencion,
  estadoSegunDesenlace,
  puedePedirCae,
  puedeTransicionar,
  reconciliarPorUltimoAutorizado,
  reintentoSeguro,
  verificarEvidencia,
  type EstadoDeEmision,
} from '@aai/tax-engine';
import { faltaParaEmitir, puedeEmitir, EMISION_HABILITADA } from '@aai/api/fiscal/puerta';
import { SinReconciliador } from '@aai/api/fiscal/reconciliador';
import { withCheckDigit } from '@aai/shared';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { asCompany, connect, hasDatabase, type Client } from '../integration/helpers/db.js';
import { sufijoUnico } from '../integration/helpers/identificadores.js';

const suite = hasDatabase ? describe : describe.skip;

// ---------------------------------------------------------------------------
// Las reglas, sin base
// ---------------------------------------------------------------------------

describe('S-42 — de la duda no se sale emitiendo', () => {
  it('DESCONOCIDA no tiene ninguna transición a EMITIENDO', () => {
    // Es **el** candado de la fase. Si esta arista existiera, un timeout se
    // resolvería reintentando y ahí está la doble factura.
    expect(puedeTransicionar('DESCONOCIDA', 'EMITIENDO')).toBe(false);
    expect(puedeTransicionar('DESCONOCIDA', 'AUTORIZADA')).toBe(false);
    expect(puedeTransicionar('DESCONOCIDA', 'RECHAZADA')).toBe(false);
    // Lo único que se puede hacer es averiguar.
    expect(puedeTransicionar('DESCONOCIDA', 'RECONCILIANDO')).toBe(true);
  });

  it('solo se pide un CAE desde LISTA', () => {
    const todos: EstadoDeEmision[] = [
      'BORRADOR', 'LISTA', 'EMITIENDO', 'AUTORIZADA',
      'RECHAZADA', 'DESCONOCIDA', 'RECONCILIANDO', 'ANULADA',
    ];
    expect(todos.filter(puedePedirCae)).toEqual(['LISTA']);
  });

  it('una autorizada es terminal: no se re-emite', () => {
    for (const destino of ['LISTA', 'EMITIENDO', 'RECHAZADA', 'ANULADA'] as EstadoDeEmision[]) {
      expect(puedeTransicionar('AUTORIZADA', destino)).toBe(false);
    }
  });

  it('un timeout después de transmitir es duda, no error', () => {
    // La clasificación no es por tipo de error técnico: es por si el pedido
    // pudo haber llegado.
    expect(estadoSegunDesenlace('SIN_RESPUESTA')).toBe('DESCONOCIDA');
    expect(reintentoSeguro('SIN_RESPUESTA')).toBe(false);

    // Y lo único que se reintenta solo es lo que consta que no salió.
    expect(estadoSegunDesenlace('NO_SE_ENVIO')).toBe('LISTA');
    expect(reintentoSeguro('NO_SE_ENVIO')).toBe(true);

    expect(reintentoSeguro('RECHAZO')).toBe(false);
    expect(reintentoSeguro('AUTORIZO')).toBe(false);
  });
});

describe('S-42 — AUTORIZADA exige evidencia de ARCA', () => {
  const buena = { cae: '75123456789012', caeVencimiento: '20261231', numeroAutorizado: 7 };

  it('con CAE, vencimiento y el número reservado, alcanza', () => {
    expect(verificarEvidencia(buena, 7)).toEqual({ valida: true });
  });

  it('un CAE vacío o no numérico no es evidencia', () => {
    expect(verificarEvidencia({ ...buena, cae: '' }, 7)).toMatchObject({ motivo: 'CAE_VACIO' });
    expect(verificarEvidencia({ ...buena, cae: 'aprobado' }, 7)).toMatchObject({
      motivo: 'CAE_NO_NUMERICO',
    });
  });

  it('un número autorizado distinto del reservado NO se acepta', () => {
    // El menos evidente y el que más importa: si ARCA autorizó otro número, lo
    // autorizado no es lo que se pidió. Guardarlo como si fuera lo mismo
    // dejaría la numeración describiendo algo que no pasó.
    expect(verificarEvidencia({ ...buena, numeroAutorizado: 8 }, 7)).toMatchObject({
      motivo: 'NUMERO_DISTINTO_DEL_RESERVADO',
    });
  });
});

describe('S-42 — la reconciliación concluye, no adivina', () => {
  it('el último autorizado alcanza o supera el reservado: el comprobante existe', () => {
    expect(reconciliarPorUltimoAutorizado(7, 7)).toBe('EXISTE_FALTA_RECUPERAR_CAE');
    expect(reconciliarPorUltimoAutorizado(9, 7)).toBe('EXISTE_FALTA_RECUPERAR_CAE');
  });

  it('el último es el anterior al reservado: nunca se autorizó', () => {
    expect(reconciliarPorUltimoAutorizado(6, 7)).toBe('NO_SE_AUTORIZO');
  });

  it('un hueco que el razonamiento no explica se declara inconsistente', () => {
    // Adivinar acá sería peor que decirlo: la conclusión decidiría si se
    // vuelve a facturar una venta.
    expect(reconciliarPorUltimoAutorizado(3, 7)).toBe('INCONSISTENTE');
  });

  it('sin reconciliador, la respuesta NO es «no autorizado»', async () => {
    // La distinción decide si se factura de nuevo. `NO_AUTORIZADO` habilitaría
    // a hacerlo; `SIN_RECONCILIADOR` deja la duda planteada, que es lo correcto
    // cuando no se preguntó nada.
    const r = await new SinReconciliador().consultar();
    expect(r.estado).toBe('SIN_RECONCILIADOR');
  });
});

describe('S-42 — la clave identifica la operación, no la petición', () => {
  const base = {
    companyId: '11111111-1111-1111-1111-111111111111',
    ambiente: 'produccion' as const,
    origenTipo: 'COMMERCIAL_DOCUMENT',
    origenId: '22222222-2222-2222-2222-222222222222',
  };

  it('la misma operación da la misma clave, siempre', () => {
    expect(claveDeIntencion(base)).toBe(claveDeIntencion({ ...base }));
  });

  it('el ambiente forma parte: la misma venta en homologación es otro hecho', () => {
    expect(claveDeIntencion(base)).not.toBe(
      claveDeIntencion({ ...base, ambiente: 'homologacion' }),
    );
  });

  it('dos operaciones distintas dan claves distintas', () => {
    expect(claveDeIntencion(base)).not.toBe(
      claveDeIntencion({ ...base, origenId: '33333333-3333-3333-3333-333333333333' }),
    );
  });

  it('un componente vacío no arma una clave', () => {
    expect(() => claveDeIntencion({ ...base, origenId: '' })).toThrow(/vacío/u);
  });
});

describe('S-42 — la puerta de emisión está cerrada, y dice por qué', () => {
  const todoListo = {
    ambiente: 'produccion',
    hayCredencialVigente: true,
    wsfeAutorizado: true,
    hayPuntoDeVenta: true,
    hayReconciliador: true,
  };

  it('la capacidad NO está habilitada en esta versión', () => {
    expect(EMISION_HABILITADA).toBe(false);
  });

  it('ni con todo lo demás en orden se puede emitir', () => {
    // Es la comprobación que define el cierre de la fase: la seguridad está
    // construida y la capacidad sigue cerrada.
    expect(puedeEmitir(todoListo)).toBe(false);

    const faltan = faltaParaEmitir(todoListo).map((f) => f.condicion);
    expect(faltan).toContain('CAPACIDAD_HABILITADA');
    expect(faltan).toContain('TRANSPORTE_DISPONIBLE');
  });

  it('informa TODAS las condiciones que faltan, no la primera', () => {
    // Informar de a una obliga a intentar, fallar, arreglar y fallar por lo
    // siguiente. En un trámite ante un organismo cada vuelta cuesta un día.
    const faltan = faltaParaEmitir({
      ambiente: 'mock',
      hayCredencialVigente: false,
      wsfeAutorizado: false,
      hayPuntoDeVenta: false,
      hayReconciliador: false,
    });
    expect(faltan.length).toBeGreaterThanOrEqual(6);
    for (const f of faltan) expect(f.explicacion.length).toBeGreaterThan(30);
  });

  it('el ambiente mock no habilita emisión', () => {
    const faltan = faltaParaEmitir({ ...todoListo, ambiente: 'mock' }).map((f) => f.condicion);
    expect(faltan).toContain('AMBIENTE_FISCAL');
  });
});

// ---------------------------------------------------------------------------
// Las garantías de la base
// ---------------------------------------------------------------------------

suite('S-42 — la base impide el duplicado, no el código', () => {
  let db: Client;
  let empresaA: string;
  let empresaB: string;
  let stamp: string;

  /** Declara una intención. Devuelve el id, o el código de error de PostgreSQL. */
  const declarar = async (
    empresa: string,
    origenId: string,
    ambiente = 'produccion',
  ): Promise<{ id?: string; code?: string }> => {
    try {
      const r = await asCompany(db, empresa, () =>
        db.query<{ id: string }>(
          `INSERT INTO fiscal_emissions
             (company_id, ambiente, origen_tipo, origen_id, punto_venta, cbte_tipo, creado_por)
           VALUES ($1, $2, 'COMMERCIAL_DOCUMENT', $3, 1, 1, 'test')
           RETURNING id`,
          [empresa, ambiente, origenId],
        ),
      );
      return { id: r.rows[0]!.id };
    } catch (error) {
      return { code: (error as { code?: string }).code ?? '' };
    }
  };

  const estadoDe = async (empresa: string, id: string): Promise<string> => {
    const r = await asCompany(db, empresa, () =>
      db.query<{ estado: string }>('SELECT estado FROM fiscal_emissions WHERE id = $1', [id]),
    );
    return r.rows[0]!.estado;
  };

  beforeAll(async () => {
    initPool(process.env.DATABASE_URL!);
    db = await connect();
    stamp = await sufijoUnico(db);

    const userId = (
      await db.query<{ id: string }>(
        'INSERT INTO users (email, full_name, password_hash) VALUES ($1,$2,$3) RETURNING id',
        [`emision-${stamp}@estudio.test`, 'Emisora', 'x'],
      )
    ).rows[0]!.id;
    const org = (
      await db.query<{ create_organization: string }>('SELECT create_organization($1,$2,$3)', [
        `Estudio emision ${stamp}`, withCheckDigit(`30${stamp}`), userId,
      ])
    ).rows[0]!.create_organization;

    const crear = async (nombre: string, prefijo: string): Promise<string> =>
      (
        await db.query<{ create_company: string }>(
          'SELECT create_company($1,$2,$3,$4,$5,$6,$7,$8)',
          [userId, org, nombre, withCheckDigit(`${prefijo}${stamp}`), 'SA', 'AR-C', 'IGJ', '12-31'],
        )
      ).rows[0]!.create_company;

    empresaA = await crear('Emisión A', '33');
    empresaB = await crear('Emisión B', '27');
  });

  afterAll(async () => {
    await db?.end();
    await closePool();
  });

  it('dos intenciones para la misma venta: la segunda choca contra el índice', async () => {
    const venta = crypto.randomUUID();
    const primera = await declarar(empresaA, venta);
    expect(primera.id).toBeDefined();

    const segunda = await declarar(empresaA, venta);
    // 23505 — unique_violation. **No** un `if` que se pueda saltear.
    expect(segunda.code, 'la segunda intención entró: hay doble emisión posible').toBe('23505');
  });

  it('dos pedidos simultáneos producen una sola intención', async () => {
    // La ventana que un `if (!existe) crear` deja abierta. Se lanzan los dos
    // sin esperar al primero, que es como llegan dos clics.
    const venta = crypto.randomUUID();
    const [a, b] = await Promise.all([declarar(empresaA, venta), declarar(empresaA, venta)]);

    const creadas = [a, b].filter((r) => r.id !== undefined);
    const rechazadas = [a, b].filter((r) => r.code === '23505');
    expect(creadas).toHaveLength(1);
    expect(rechazadas).toHaveLength(1);
  });

  it('la misma venta en otro ambiente sí es otra intención', async () => {
    const venta = crypto.randomUUID();
    expect((await declarar(empresaA, venta, 'produccion')).id).toBeDefined();
    expect((await declarar(empresaA, venta, 'homologacion')).id).toBeDefined();
  });

  it('la venta de otra empresa no colisiona', async () => {
    const venta = crypto.randomUUID();
    expect((await declarar(empresaA, venta)).id).toBeDefined();
    expect((await declarar(empresaB, venta)).id).toBeDefined();
  });

  it('la empresa de al lado no ve la intención', async () => {
    const venta = crypto.randomUUID();
    const { id } = await declarar(empresaA, venta);
    const r = await asCompany(db, empresaB, () =>
      db.query('SELECT id FROM fiscal_emissions WHERE id = $1', [id!]),
    );
    expect(r.rowCount).toBe(0);
  });

  it('reservar dos veces no consume dos números', async () => {
    // Es lo idempotente: un reintento no puede quemar un número por intento.
    const { id } = await declarar(empresaA, crypto.randomUUID());
    const uno = await asCompany(db, empresaA, () =>
      db.query<{ n: string }>('SELECT reservar_numero_fiscal($1)::text AS n', [id!]),
    );
    const dos = await asCompany(db, empresaA, () =>
      db.query<{ n: string }>('SELECT reservar_numero_fiscal($1)::text AS n', [id!]),
    );
    expect(dos.rows[0]!.n).toBe(uno.rows[0]!.n);
    expect(await estadoDe(empresaA, id!)).toBe('LISTA');
  });

  it('dos reservas simultáneas dan números distintos', async () => {
    // El defecto de `MAX(numero) + 1`: los dos lectores ven el mismo máximo.
    const a = await declarar(empresaA, crypto.randomUUID());
    const b = await declarar(empresaA, crypto.randomUUID());

    const [ra, rb] = await Promise.all([
      asCompany(db, empresaA, () =>
        db.query<{ n: string }>('SELECT reservar_numero_fiscal($1)::text AS n', [a.id!]),
      ),
      asCompany(db, empresaA, () =>
        db.query<{ n: string }>('SELECT reservar_numero_fiscal($1)::text AS n', [b.id!]),
      ),
    ]);

    expect(ra.rows[0]!.n).not.toBe(rb.rows[0]!.n);
  });

  it('la transición DESCONOCIDA → EMITIENDO la rechaza la base', async () => {
    // La misma regla que `emision.ts`, garantizada donde no se puede saltear.
    const { id } = await declarar(empresaA, crypto.randomUUID());
    await asCompany(db, empresaA, () =>
      db.query('SELECT reservar_numero_fiscal($1)', [id!]),
    );

    const mover = async (estado: string): Promise<string> => {
      try {
        await asCompany(db, empresaA, () =>
          db.query('UPDATE fiscal_emissions SET estado = $2 WHERE id = $1', [id!, estado]),
        );
        return 'ok';
      } catch (error) {
        return (error as { code?: string }).code ?? '';
      }
    };

    expect(await mover('EMITIENDO')).toBe('ok');
    expect(await mover('DESCONOCIDA')).toBe('ok');
    // 23514 — check_violation, que es como el trigger informa.
    expect(await mover('EMITIENDO'), 'de la duda se pudo volver a emitir').toBe('23514');
    expect(await mover('RECONCILIANDO')).toBe('ok');
  });

  it('no se escribe AUTORIZADA sin CAE', async () => {
    const { id } = await declarar(empresaA, crypto.randomUUID());
    await asCompany(db, empresaA, () => db.query('SELECT reservar_numero_fiscal($1)', [id!]));
    await asCompany(db, empresaA, () =>
      db.query("UPDATE fiscal_emissions SET estado = 'EMITIENDO' WHERE id = $1", [id!]),
    );

    let code = '';
    try {
      await asCompany(db, empresaA, () =>
        db.query("UPDATE fiscal_emissions SET estado = 'AUTORIZADA' WHERE id = $1", [id!]),
      );
    } catch (error) {
      code = (error as { code?: string }).code ?? '';
    }
    expect(code, 'se marcó autorizada sin evidencia de ARCA').toBe('23514');
  });

  it('el número reservado no se cambia', async () => {
    const { id } = await declarar(empresaA, crypto.randomUUID());
    await asCompany(db, empresaA, () => db.query('SELECT reservar_numero_fiscal($1)', [id!]));

    let code = '';
    try {
      await asCompany(db, empresaA, () =>
        db.query('UPDATE fiscal_emissions SET cbte_numero = 999 WHERE id = $1', [id!]),
      );
    } catch (error) {
      code = (error as { code?: string }).code ?? '';
    }
    expect(code).toBe('23514');
  });

  it('una intención en duda aparece en los pendientes, y bloquea', async () => {
    const { id } = await declarar(empresaA, crypto.randomUUID());
    await asCompany(db, empresaA, () => db.query('SELECT reservar_numero_fiscal($1)', [id!]));
    for (const estado of ['EMITIENDO', 'DESCONOCIDA']) {
      await asCompany(db, empresaA, () =>
        db.query('UPDATE fiscal_emissions SET estado = $2 WHERE id = $1', [id!, estado]),
      );
    }

    const pendientes = await asCompany(db, empresaA, () =>
      db.query<{ bloquea: boolean }>(
        "SELECT bloquea FROM work_queue WHERE rama = 'EMISION_SIN_RESOLVER' AND entity_id = $1",
        [id!],
      ),
    );
    expect(pendientes.rowCount).toBe(1);
    expect(pendientes.rows[0]!.bloquea).toBe(true);
  });

  it('una intención fiscal no se borra', async () => {
    const { id } = await declarar(empresaA, crypto.randomUUID());
    let code = '';
    try {
      await asCompany(db, empresaA, () =>
        db.query('DELETE FROM fiscal_emissions WHERE id = $1', [id!]),
      );
    } catch (error) {
      code = (error as { code?: string }).code ?? '';
    }
    // 42501 — insufficient_privilege.
    expect(code).toBe('42501');
  });
});
