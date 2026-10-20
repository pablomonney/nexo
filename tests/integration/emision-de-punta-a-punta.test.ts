/**
 * E4 — emitir de punta a punta contra la BASE DE VERDAD, con un ARCA simulado.
 *
 * El caso de uso (`@aai/arca-emision`) y el repositorio real (`apps/api/src/fiscal/repositorio-de-emision.ts`) corren juntos sobre
 * PostgreSQL —el trigger de transiciones, el índice de numeración, la reserva correlativa, la bitácora—, y lo único simulado es
 * ARCA, que cuenta cuántas veces le piden un CAE. Lo que se afirma:
 *
 *   1. El camino feliz deja la intención AUTORIZADA con su CAE, el número siguiente al último autorizado y la bitácora escrita.
 *   2. **De la duda no se sale emitiendo**, y la base lo confirma: tras un timeout, cinco reintentos no llegan a ARCA y el
 *      pendiente aparece en la bandeja y bloquea el punto de venta.
 *   3. Un rechazo libera el número: la intención siguiente lleva el mismo, y ARCA lo acepta.
 *   4. Dos emisiones simultáneas en el mismo punto de venta: **una sola llega a ARCA**.
 *   5. Una emisión que quedó EMITIENDO (el proceso murió) se recupera y se resuelve contra ARCA.
 *   6. Cada transición exige el estado de origen: no se pisa lo que hizo otro proceso.
 *   7. La empresa de al lado no ve nada.
 */

import { closePool, initPool } from '@aai/db';
import { RepositorioSqlDeEmision } from '@aai/api/fiscal/repositorio-de-emision';
import {
  armarComprobante,
  emitirIntencion,
  reconciliarIntencion,
  reconciliarPendientes,
  type ReconciliadorDeEmision,
  type RepositorioDeEmision,
  type RespuestaLote,
  type TransporteDeEmision,
} from '@aai/arca-emision';
import { withCheckDigit } from '@aai/shared';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { asCompany, connect, hasDatabase, type Client } from './helpers/db.js';
import { sufijoUnico } from './helpers/identificadores.js';

const suite = hasDatabase ? describe : describe.skip;

class ArcaSimulado implements TransporteDeEmision {
  pedidosDeCae = 0;
  ultimo: number;
  respuesta: RespuestaLote | Error | null = null;
  demoraMs = 0;
  constructor(ultimo: number) {
    this.ultimo = ultimo;
  }
  async estaVivo(): Promise<boolean> {
    return true;
  }
  async ultimoAutorizado(): Promise<number> {
    return this.ultimo;
  }
  async solicitarCae(cabecera: { PtoVta: number; CbteTipo: number }, detalle: { CbteDesde: number }): Promise<RespuestaLote> {
    this.pedidosDeCae += 1;
    if (this.demoraMs > 0) await new Promise((r) => setTimeout(r, this.demoraMs));
    const r = this.respuesta;
    if (r instanceof Error) throw r;
    if (r !== null) return r;
    this.ultimo = detalle.CbteDesde; // autoriza el número que le piden y avanza
    return autorizado(detalle.CbteDesde);
  }
}

function autorizado(numero: number): RespuestaLote {
  return {
    Resultado: 'A',
    errores: [],
    eventos: [],
    comprobantes: [
      { Concepto: 1, DocTipo: 99, DocNro: '0', CbteDesde: numero, CbteHasta: numero, CbteFch: '20261016', Resultado: 'A', CAE: `8642100221${String(numero).padStart(4, '0')}`, CAEFchVto: '20261026', Observaciones: [] },
    ],
  };
}

const rechazo = (n: number): RespuestaLote => ({
  Resultado: 'R',
  errores: [{ Code: 10015, Msg: 'El CUIT del receptor no es válido' }],
  eventos: [],
  comprobantes: [{ Concepto: 1, DocTipo: 99, DocNro: '0', CbteDesde: n, CbteHasta: n, CbteFch: '20261016', Resultado: 'R', CAE: null, CAEFchVto: null, Observaciones: [] }],
});

suite('E4 · emitir de punta a punta (base real, ARCA simulado)', () => {
  let db: Client;
  let empresa: string;
  let otraEmpresa: string;
  let carril = 200;

  const nuevoPuntoDeVenta = (): number => {
    carril += 1;
    return carril;
  };

  const repoDe = (companyId = empresa): RepositorioDeEmision =>
    new RepositorioSqlDeEmision({ companyId, actorId: 'system:test-emisor' }) as unknown as RepositorioDeEmision;

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

  const fila = async (id: string) =>
    (
      await asCompany(db, empresa, () =>
        db.query<{ estado: string; cbte_numero: string | null; cae: string | null; cae_vencimiento: string | null; llamadas: number; codigo_rechazo: string | null; ultimo_error: string | null }>(
          `SELECT estado, cbte_numero::text, cae, to_char(cae_vencimiento, 'YYYY-MM-DD') AS cae_vencimiento, llamadas, codigo_rechazo, ultimo_error
             FROM fiscal_emissions WHERE id = $1`,
          [id],
        ),
      )
    ).rows[0]!;

  /** Un comprobante cuyo punto de venta es el de la intención. */
  const armarEn = (pv: number) => (numero: number) =>
    armarComprobante({
      emisor: { cuit: withCheckDigit('2045214832'), condicionIva: 'MONOTRIBUTO' },
      receptor: { condicionIva: 'CONSUMIDOR_FINAL', tipoDocumento: 'SIN_IDENTIFICAR', numeroDocumento: null },
      clase: 'FACTURA',
      puntoDeVenta: pv,
      numero,
      fecha: '2026-10-16',
      lineas: [{ tipo: 'PRODUCTO', tratamiento: 'GRAVADO', neto: '1500.00', iva: '0.00' }],
    });

  beforeAll(async () => {
    initPool(process.env.DATABASE_URL!);
    db = await connect();
    const stamp = await sufijoUnico(db);
    const userId = (
      await db.query<{ id: string }>('INSERT INTO users (email, full_name, password_hash) VALUES ($1,$2,$3) RETURNING id', [
        `emisor-${stamp}@estudio.test`,
        'Emisor',
        'x',
      ])
    ).rows[0]!.id;
    const org = (
      await db.query<{ create_organization: string }>('SELECT create_organization($1,$2,$3)', [
        `Estudio emisor ${stamp}`,
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
    empresa = await crear('Emisora SA', '33');
    otraEmpresa = await crear('Otra SA', '27');
  });

  afterAll(async () => {
    await db?.end();
    await closePool();
  });

  it('el repositorio real encaja con el puerto del caso de uso (si no, no compila ni se conecta)', () => {
    const r: RepositorioDeEmision = repoDe();
    expect(typeof r.reservarNumeroCorrelativo).toBe('function');
  });

  it('camino feliz: AUTORIZADA con CAE, número siguiente al último de ARCA, una llamada y la bitácora escrita', async () => {
    const pv = nuevoPuntoDeVenta();
    const id = await declarar(pv);
    const arca = new ArcaSimulado(51);

    const r = await emitirIntencion({ repo: repoDe(), transporte: arca }, id, armarEn(pv));

    expect(r).toMatchObject({ estado: 'AUTORIZADA', cbteNumero: 52, yaEstaba: false });
    expect(await fila(id)).toMatchObject({ estado: 'AUTORIZADA', cbte_numero: '52', cae: '86421002210052', cae_vencimiento: '2026-10-26', llamadas: 1 });
    expect(arca.pedidosDeCae).toBe(1);

    const acciones = (
      await db.query<{ action: string }>(`SELECT action FROM audit_logs WHERE object_id = $1 AND object_type = 'fiscal_emissions' ORDER BY occurred_at, id`, [id])
    ).rows.map((x) => x.action);
    expect(acciones).toEqual(['RESERVAR_NUMERO_FISCAL', 'EMITIR_COMPROBANTE', 'EMITIR_COMPROBANTE']);

    // Y emitir otra vez devuelve lo mismo sin llamar a nadie.
    expect(await emitirIntencion({ repo: repoDe(), transporte: arca }, id, armarEn(pv))).toMatchObject({ yaEstaba: true, cbteNumero: 52 });
    expect(arca.pedidosDeCae).toBe(1);
  });

  it('de la duda no se sale emitiendo: tras un timeout, cinco reintentos no llegan a ARCA, y el pendiente bloquea', async () => {
    const pv = nuevoPuntoDeVenta();
    const id = await declarar(pv);
    const arca = new ArcaSimulado(10);
    arca.respuesta = new Error('timeout leyendo la respuesta');

    expect(await emitirIntencion({ repo: repoDe(), transporte: arca }, id, armarEn(pv))).toMatchObject({ estado: 'DESCONOCIDA' });
    expect(await fila(id)).toMatchObject({ estado: 'DESCONOCIDA', cbte_numero: '11' });

    for (let i = 0; i < 5; i += 1) {
      expect(await emitirIntencion({ repo: repoDe(), transporte: arca }, id, armarEn(pv))).toMatchObject({ motivo: 'EN_DUDA' });
    }
    expect(arca.pedidosDeCae).toBe(1);

    // Aparece en la bandeja y bloquea.
    const cola = await asCompany(db, empresa, () =>
      db.query<{ bloquea: boolean; rama: string }>('SELECT bloquea, rama FROM work_queue_emision WHERE entity_id = $1', [id]),
    );
    expect(cola.rows[0]).toEqual({ bloquea: true, rama: 'EMISION_SIN_RESOLVER' });

    // Otra venta en el mismo punto de venta y tipo no puede emitir hasta resolverla (la numeración es correlativa).
    const otra = await declarar(pv);
    const arca2 = new ArcaSimulado(10);
    expect(await emitirIntencion({ repo: repoDe(), transporte: arca2 }, otra, armarEn(pv))).toMatchObject({ motivo: 'CARRIL_OCUPADO' });
    expect(arca2.pedidosDeCae).toBe(0);
    expect((await fila(otra)).estado).toBe('BORRADOR');
  });

  it('reconciliar: ARCA dice que existe → AUTORIZADA con su CAE, y el punto de venta queda libre', async () => {
    const pv = nuevoPuntoDeVenta();
    const id = await declarar(pv);
    const arca = new ArcaSimulado(20);
    arca.respuesta = new Error('ECONNRESET');
    await emitirIntencion({ repo: repoDe(), transporte: arca }, id, armarEn(pv));

    const reconciliador: ReconciliadorDeEmision = {
      reconciliar: async (p) => ({ estado: 'AUTORIZADO', evidencia: { cae: '86421002211234', caeVencimiento: '20261026', numeroAutorizado: p.numeroReservado } }),
    };
    expect(await reconciliarIntencion({ repo: repoDe(), reconciliador }, id)).toMatchObject({ estado: 'AUTORIZADA', cae: '86421002211234', cbteNumero: 21 });
    expect(await fila(id)).toMatchObject({ estado: 'AUTORIZADA', cae: '86421002211234', cae_vencimiento: '2026-10-26' });

    // El carril quedó libre: la siguiente sigue a ARCA (que ahora dice 21).
    const sig = await declarar(pv);
    expect(await emitirIntencion({ repo: repoDe(), transporte: new ArcaSimulado(21) }, sig, armarEn(pv))).toMatchObject({ estado: 'AUTORIZADA', cbteNumero: 22 });
  });

  it('reconciliar: ARCA nunca lo autorizó → RECHAZADA, y la siguiente reusa el MISMO número', async () => {
    const pv = nuevoPuntoDeVenta();
    const id = await declarar(pv);
    const arca = new ArcaSimulado(30);
    arca.respuesta = new Error('timeout');
    await emitirIntencion({ repo: repoDe(), transporte: arca }, id, armarEn(pv));
    expect((await fila(id)).cbte_numero).toBe('31');

    const reconciliador: ReconciliadorDeEmision = { reconciliar: async () => ({ estado: 'NO_AUTORIZADO', detalle: 'último autorizado 30' }) };
    expect(await reconciliarIntencion({ repo: repoDe(), reconciliador }, id)).toMatchObject({ estado: 'RECHAZADA' });
    expect((await fila(id)).ultimo_error).toMatch(/nunca lo autorizó/u);

    const sig = await declarar(pv);
    const r = await emitirIntencion({ repo: repoDe(), transporte: new ArcaSimulado(30) }, sig, armarEn(pv));
    expect(r, 'ARCA no avanzó: el número 31 tiene que volver a usarse').toMatchObject({ estado: 'AUTORIZADA', cbteNumero: 31 });
  });

  it('un rechazo de ARCA se guarda con código y motivo, y libera el número para la siguiente', async () => {
    const pv = nuevoPuntoDeVenta();
    const id = await declarar(pv);
    const arca = new ArcaSimulado(40);
    arca.respuesta = rechazo(41);

    const r = await emitirIntencion({ repo: repoDe(), transporte: arca }, id, armarEn(pv));
    expect(r).toMatchObject({ estado: 'RECHAZADA', codigo: '10015' });
    expect(await fila(id)).toMatchObject({ estado: 'RECHAZADA', codigo_rechazo: '10015' });
    expect((await fila(id)).ultimo_error).toContain('[10015]');

    const sig = await declarar(pv);
    expect(await emitirIntencion({ repo: repoDe(), transporte: new ArcaSimulado(40) }, sig, armarEn(pv))).toMatchObject({ estado: 'AUTORIZADA', cbteNumero: 41 });
  });

  it('dos emisiones simultáneas en el mismo punto de venta: UNA sola llega a ARCA', async () => {
    const pv = nuevoPuntoDeVenta();
    const a = await declarar(pv);
    const b = await declarar(pv);
    const arca = new ArcaSimulado(50);
    // La primera sigue «llamando» mientras la segunda intenta reservar. Con 150 ms la prueba se volvía una carrera cuando la máquina andaba cargada
    // (la primera terminaba antes de que la segunda intentara y las dos salían AUTORIZADAS); 800 ms deja margen sin cambiar lo que se afirma.
    arca.demoraMs = 800;

    const [ra, rb] = await Promise.all([
      emitirIntencion({ repo: repoDe(), transporte: arca }, a, armarEn(pv)),
      emitirIntencion({ repo: repoDe(), transporte: arca }, b, armarEn(pv)),
    ]);

    const resultados = [ra, rb];
    expect(resultados.filter((r) => r.estado === 'AUTORIZADA')).toHaveLength(1);
    expect(resultados.filter((r) => r.estado === 'NO_SE_EMITIO' && r.motivo === 'CARRIL_OCUPADO')).toHaveLength(1);
    expect(arca.pedidosDeCae).toBe(1);
  });

  it('una emisión que quedó EMITIENDO (el proceso murió) se recupera y se resuelve contra ARCA', async () => {
    const pv = nuevoPuntoDeVenta();
    const id = await declarar(pv);
    const repo = repoDe();
    await repo.reservarNumeroCorrelativo(id, 60);
    await repo.marcarEmitiendo(id); // …y el proceso muere acá, con el pedido posiblemente en la calle
    expect((await fila(id)).estado).toBe('EMITIENDO');

    // Recién escrita: todavía puede estar en vuelo, no se toca.
    const reconciliador: ReconciliadorDeEmision = {
      reconciliar: async (p) => ({ estado: 'AUTORIZADO', evidencia: { cae: '86421002215555', caeVencimiento: '20261026', numeroAutorizado: p.numeroReservado } }),
    };
    const aun = await reconciliarPendientes({ repo, reconciliador }, { segundosEmitiendo: 300 });
    expect((await fila(id)).estado, 'se le metió la mano a una emisión que podía estar en vuelo').toBe('EMITIENDO');
    void aun;

    // Pasó el plazo: huérfana.
    await db.query(`UPDATE fiscal_emissions SET actualizado_el = now() - interval '20 minutes' WHERE id = $1`, [id]);
    const resumen = await reconciliarPendientes({ repo, reconciliador }, { segundosEmitiendo: 300 });
    expect(resumen.huerfanasRecuperadas).toBeGreaterThanOrEqual(1);
    expect(await fila(id)).toMatchObject({ estado: 'AUTORIZADA', cae: '86421002215555' });
  });

  it('cada transición exige el estado de origen: no se pisa lo que hizo otro proceso', async () => {
    const pv = nuevoPuntoDeVenta();
    const id = await declarar(pv);
    const repo = repoDe();
    // Autorizar una BORRADOR: la precondición no se cumple y no se escribe nada.
    await expect(repo.marcarAutorizada(id, { cae: '86421002219999', caeVencimiento: '20261026', numeroAutorizado: 1 })).rejects.toMatchObject({
      name: 'ErrorDeEmision',
      codigo: 'TRANSICION_NO_PERMITIDA',
    });
    expect(await fila(id)).toMatchObject({ estado: 'BORRADOR', cae: null });

    await repo.reservarNumeroCorrelativo(id, 0);
    await repo.marcarEmitiendo(id);
    await expect(repo.marcarEmitiendo(id)).rejects.toMatchObject({ codigo: 'TRANSICION_NO_PERMITIDA' });
    expect((await fila(id)).llamadas).toBe(1);
  });

  it('una intención que no existe', async () => {
    await expect(repoDe().reservarNumeroCorrelativo(crypto.randomUUID(), 1)).rejects.toMatchObject({ codigo: 'INTENCION_INEXISTENTE' });
    expect(await repoDe().cargar(crypto.randomUUID())).toBeNull();
  });

  it('la empresa de al lado no ve la intención', async () => {
    const id = await declarar(nuevoPuntoDeVenta());
    expect(await repoDe(otraEmpresa).cargar(id)).toBeNull();
    await expect(repoDe(otraEmpresa).marcarEmitiendo(id)).rejects.toMatchObject({ codigo: 'TRANSICION_NO_PERMITIDA' });
  });
});
