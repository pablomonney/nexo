/**
 * E4 — el caso de uso emitir y el de reconciliar, con la base y ARCA simulados.
 *
 * El repositorio simulado **respeta la misma máquina de estados que la base** (`puedeTransicionar`): si el caso de uso intentara
 * una transición que la base rechazaría, la prueba falla acá también. El ARCA simulado cuenta cuántas veces le piden un CAE:
 * la propiedad central es que **de la duda no se sale pidiendo otro**.
 */

import { puedeTransicionar, type EstadoDeEmision, type EvidenciaDeAutorizacion } from '@aai/tax-engine';
import { withCheckDigit } from '@aai/shared';
import { describe, expect, it } from 'vitest';
import {
  ErrorDeEmision,
  armarComprobante,
  emitirIntencion,
  reconciliarIntencion,
  reconciliarPendientes,
  type IntencionGuardada,
  type ReconciliadorDeEmision,
  type RepositorioDeEmision,
  type RespuestaLote,
  type TransporteDeEmision,
} from './index.js';

const CUIT = withCheckDigit('2045214832');

/** El comprobante que arma el documento comercial: Factura C de un monotributista a consumidor final. */
const armarFacturaC = (numero: number) =>
  armarComprobante({
    emisor: { cuit: CUIT, condicionIva: 'MONOTRIBUTO' },
    receptor: { condicionIva: 'CONSUMIDOR_FINAL', tipoDocumento: 'SIN_IDENTIFICAR', numeroDocumento: null },
    clase: 'FACTURA',
    puntoDeVenta: 1,
    numero,
    fecha: '2026-10-16',
    lineas: [{ tipo: 'PRODUCTO', tratamiento: 'GRAVADO', neto: '1500.00', iva: '0.00' }],
  });

// ─────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────
// Los simulados
// ─────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────

class RepoSimulado implements RepositorioDeEmision {
  readonly llamadasEnOrden: string[] = [];
  readonly intenciones = new Map<string, IntencionGuardada & { motivo?: string; codigo?: string | null; llamadas: number; actualizadaHaceSegundos: number }>();
  /** Si se pone, `reservarNumeroCorrelativo` lanza esto. */
  falloAlReservar: ErrorDeEmision | null = null;
  falloAlAutorizar: Error | null = null;

  crear(id: string, cambios: Partial<IntencionGuardada> = {}, actualizadaHaceSegundos = 0): void {
    this.intenciones.set(id, {
      id,
      estado: 'BORRADOR',
      ambiente: 'homologacion',
      puntoVenta: 1,
      cbteTipo: 11,
      cbteNumero: null,
      cae: null,
      caeVencimiento: null,
      llamadas: 0,
      actualizadaHaceSegundos,
      ...cambios,
    });
  }

  estado(id: string): EstadoDeEmision {
    return this.intenciones.get(id)!.estado;
  }

  private mover(id: string, hacia: EstadoDeEmision): void {
    const i = this.intenciones.get(id);
    if (i === undefined) throw new ErrorDeEmision('INTENCION_INEXISTENTE', id);
    if (i.estado !== hacia && !puedeTransicionar(i.estado, hacia)) {
      throw new ErrorDeEmision('TRANSICION_NO_PERMITIDA', `${i.estado} → ${hacia}`);
    }
    i.estado = hacia;
    i.actualizadaHaceSegundos = 0;
  }

  async cargar(id: string): Promise<IntencionGuardada | null> {
    const i = this.intenciones.get(id);
    return i === undefined ? null : { ...i };
  }
  async reservarNumeroCorrelativo(id: string, ultimo: number): Promise<number> {
    this.llamadasEnOrden.push('reservar');
    if (this.falloAlReservar !== null) throw this.falloAlReservar;
    const i = this.intenciones.get(id)!;
    if (i.cbteNumero !== null) return i.cbteNumero;
    i.cbteNumero = ultimo + 1;
    this.mover(id, 'LISTA');
    return i.cbteNumero;
  }
  async marcarEmitiendo(id: string): Promise<void> {
    this.llamadasEnOrden.push('emitiendo');
    this.mover(id, 'EMITIENDO');
    this.intenciones.get(id)!.llamadas += 1;
  }
  async marcarAutorizada(id: string, e: EvidenciaDeAutorizacion): Promise<void> {
    this.llamadasEnOrden.push('autorizada');
    if (this.falloAlAutorizar !== null) throw this.falloAlAutorizar;
    this.mover(id, 'AUTORIZADA');
    const i = this.intenciones.get(id)!;
    i.cae = e.cae;
    i.caeVencimiento = `${e.caeVencimiento.slice(0, 4)}-${e.caeVencimiento.slice(4, 6)}-${e.caeVencimiento.slice(6)}`;
  }
  async marcarRechazada(id: string, codigo: string | null, motivo: string): Promise<void> {
    this.llamadasEnOrden.push('rechazada');
    if (motivo.trim() === '') throw new Error('la base exige motivo en una rechazada');
    this.mover(id, 'RECHAZADA');
    const i = this.intenciones.get(id)!;
    i.motivo = motivo;
    i.codigo = codigo;
  }
  async marcarDesconocida(id: string, motivo: string): Promise<void> {
    this.llamadasEnOrden.push('desconocida');
    this.mover(id, 'DESCONOCIDA');
    this.intenciones.get(id)!.motivo = motivo;
  }
  async marcarReconciliando(id: string): Promise<void> {
    this.llamadasEnOrden.push('reconciliando');
    this.mover(id, 'RECONCILIANDO');
  }
  async listarParaReconciliar(segundos: number): Promise<readonly IntencionGuardada[]> {
    return [...this.intenciones.values()]
      .filter((i) => i.estado === 'DESCONOCIDA' || (i.estado === 'EMITIENDO' && i.actualizadaHaceSegundos > segundos))
      .map((i) => ({ ...i }));
  }
}

class ArcaSimulado implements TransporteDeEmision {
  pedidosDeCae = 0;
  vivo = true;
  ultimo = 51;
  /** Cómo contesta `FECAESolicitar`: una respuesta, o una excepción. */
  respuesta: RespuestaLote | Error = autorizado(52);

  async estaVivo(): Promise<boolean> {
    return this.vivo;
  }
  async ultimoAutorizado(): Promise<number> {
    return this.ultimo;
  }
  async solicitarCae(): Promise<RespuestaLote> {
    this.pedidosDeCae += 1;
    if (this.respuesta instanceof Error) throw this.respuesta;
    return this.respuesta;
  }
}

function autorizado(numero: number, cae = '86421002219999'): RespuestaLote {
  return {
    Resultado: 'A',
    errores: [],
    eventos: [],
    comprobantes: [
      { Concepto: 1, DocTipo: 99, DocNro: '0', CbteDesde: numero, CbteHasta: numero, CbteFch: '20261016', Resultado: 'A', CAE: cae, CAEFchVto: '20261026', Observaciones: [] },
    ],
  };
}

function rechazado(codigo: number, mensaje: string): RespuestaLote {
  return {
    Resultado: 'R',
    errores: [{ Code: codigo, Msg: mensaje }],
    eventos: [],
    comprobantes: [
      { Concepto: 1, DocTipo: 99, DocNro: '0', CbteDesde: 52, CbteHasta: 52, CbteFch: '20261016', Resultado: 'R', CAE: null, CAEFchVto: null, Observaciones: [] },
    ],
  };
}

function entorno() {
  const repo = new RepoSimulado();
  const arca = new ArcaSimulado();
  repo.crear('i1');
  return { repo, arca, deps: { repo, transporte: arca } };
}

// ─────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────
// Emitir
// ─────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────

describe('E4 · emitir: el camino feliz', () => {
  it('BORRADOR → LISTA → EMITIENDO → AUTORIZADA, con el número siguiente al último autorizado por ARCA', async () => {
    const { repo, arca, deps } = entorno();

    const r = await emitirIntencion(deps, 'i1', armarFacturaC);

    expect(r).toEqual({ estado: 'AUTORIZADA', cae: '86421002219999', caeVencimiento: '20261026', cbteNumero: 52, yaEstaba: false });
    expect(repo.estado('i1')).toBe('AUTORIZADA');
    expect(repo.intenciones.get('i1')).toMatchObject({ cbteNumero: 52, cae: '86421002219999', caeVencimiento: '2026-10-26', llamadas: 1 });
    expect(arca.pedidosDeCae).toBe(1);
  });

  it('se persiste EMITIENDO ANTES de llamar a ARCA (y reservar antes que eso)', async () => {
    const { repo, deps } = entorno();
    const orden: string[] = [];
    const real = deps.transporte.solicitarCae.bind(deps.transporte);
    deps.transporte.solicitarCae = async (...a) => {
      orden.push(`ARCA (el repositorio ya hizo: ${repo.llamadasEnOrden.join(',')})`);
      return real(...a);
    };
    await emitirIntencion(deps, 'i1', armarFacturaC);
    expect(orden).toEqual(['ARCA (el repositorio ya hizo: reservar,emitiendo)']);
  });

  it('emitir otra vez una AUTORIZADA devuelve lo mismo y NO vuelve a pedir un CAE', async () => {
    const { arca, deps } = entorno();
    await emitirIntencion(deps, 'i1', armarFacturaC);
    const otra = await emitirIntencion(deps, 'i1', armarFacturaC);
    expect(otra).toMatchObject({ estado: 'AUTORIZADA', cae: '86421002219999', cbteNumero: 52, yaEstaba: true });
    expect(arca.pedidosDeCae).toBe(1);
  });
});

describe('E4 · emitir: de la duda no se sale emitiendo', () => {
  it.each(['EMITIENDO', 'DESCONOCIDA', 'RECONCILIANDO'] as const)('una intención %s se niega a emitir y ni siquiera consulta a ARCA', async (estado) => {
    const { repo, arca, deps } = entorno();
    repo.crear('x', { estado, cbteNumero: 52 });

    const r = await emitirIntencion(deps, 'x', armarFacturaC);

    expect(r).toMatchObject({ estado: 'NO_SE_EMITIO', motivo: 'EN_DUDA' });
    expect(arca.pedidosDeCae).toBe(0);
    expect(repo.estado('x')).toBe(estado);
  });

  it.each(['RECHAZADA', 'ANULADA'] as const)('una intención %s es terminal: no se emite', async (estado) => {
    const { repo, arca, deps } = entorno();
    repo.crear('x', { estado, cbteNumero: 52 });
    expect(await emitirIntencion(deps, 'x', armarFacturaC)).toMatchObject({ estado: 'NO_SE_EMITIO', motivo: 'ESTADO_NO_EMITIBLE' });
    expect(arca.pedidosDeCae).toBe(0);
  });

  it('un timeout después de llamar es DESCONOCIDA, y volver a emitir NO pide otro CAE (la propiedad central)', async () => {
    const { repo, arca, deps } = entorno();
    arca.respuesta = new Error('timeout leyendo la respuesta');

    const primera = await emitirIntencion(deps, 'i1', armarFacturaC);
    expect(primera).toMatchObject({ estado: 'DESCONOCIDA' });
    expect(repo.estado('i1')).toBe('DESCONOCIDA');

    // Cinco reintentos «porque no andaba»: ninguno llega a ARCA.
    for (let i = 0; i < 5; i += 1) {
      expect(await emitirIntencion(deps, 'i1', armarFacturaC)).toMatchObject({ estado: 'NO_SE_EMITIO', motivo: 'EN_DUDA' });
    }
    expect(arca.pedidosDeCae, 'se pidió más de un CAE para la misma intención: doble emisión posible').toBe(1);
  });

  it('una respuesta que no se puede interpretar (parcial, vacía, con error sin resultado) es duda, no rechazo', async () => {
    for (const r of [
      { Resultado: 'P', errores: [], eventos: [], comprobantes: [] },
      { Resultado: '', errores: [{ Code: 600, Msg: 'token' }], eventos: [], comprobantes: [] },
      { Resultado: 'A', errores: [], eventos: [], comprobantes: [] },
    ] as RespuestaLote[]) {
      const { repo, arca, deps } = entorno();
      arca.respuesta = r;
      expect(await emitirIntencion(deps, 'i1', armarFacturaC)).toMatchObject({ estado: 'DESCONOCIDA' });
      expect(repo.estado('i1')).toBe('DESCONOCIDA');
    }
  });

  it('«autorizado» pero con un número distinto del reservado es duda (y el CAE no se pierde)', async () => {
    const { repo, arca, deps } = entorno();
    arca.respuesta = autorizado(53);
    const r = await emitirIntencion(deps, 'i1', armarFacturaC);
    expect(r).toMatchObject({ estado: 'DESCONOCIDA', caeSinGuardar: '86421002219999' });
    expect(repo.estado('i1')).toBe('DESCONOCIDA');
    expect(repo.intenciones.get('i1')!.cae).toBeNull();
  });

  it('ARCA autorizó y no se pudo escribir: se devuelve el CAE para dejar constancia y no se reintenta', async () => {
    const { repo, arca, deps } = entorno();
    repo.falloAlAutorizar = new Error('la base se cayó');
    const r = await emitirIntencion(deps, 'i1', armarFacturaC);
    expect(r).toMatchObject({ estado: 'DESCONOCIDA', caeSinGuardar: '86421002219999' });
    // Quedó EMITIENDO: el reconciliador periódico la recupera cuando pase el plazo.
    expect(repo.estado('i1')).toBe('EMITIENDO');
    expect(await emitirIntencion(deps, 'i1', armarFacturaC)).toMatchObject({ motivo: 'EN_DUDA' });
    expect(arca.pedidosDeCae).toBe(1);
  });
});

describe('E4 · emitir: rechazo de ARCA', () => {
  it('RECHAZADA, con el código y el motivo de ARCA', async () => {
    const { repo, deps } = entorno();
    deps.transporte = Object.assign(new ArcaSimulado(), { respuesta: rechazado(10015, 'Factura B: el CUIT del receptor no es válido') });
    const r = await emitirIntencion(deps, 'i1', armarFacturaC);
    expect(r).toMatchObject({ estado: 'RECHAZADA', codigo: '10015' });
    expect((r as { motivo: string }).motivo).toContain('[10015] Factura B');
    expect(repo.estado('i1')).toBe('RECHAZADA');
    expect(repo.intenciones.get('i1')!.codigo).toBe('10015');
  });

  it('el motivo del rechazo se acota (es texto de un tercero)', async () => {
    const { deps } = entorno();
    deps.transporte = Object.assign(new ArcaSimulado(), { respuesta: rechazado(10016, 'x'.repeat(5000)) });
    const r = (await emitirIntencion(deps, 'i1', armarFacturaC)) as { motivo: string };
    expect(r.motivo.length).toBeLessThanOrEqual(500);
  });

  it('un rechazo sin ningún motivo igual se guarda con uno (la base lo exige)', async () => {
    const { repo, deps } = entorno();
    deps.transporte = Object.assign(new ArcaSimulado(), {
      respuesta: { Resultado: 'R', errores: [], eventos: [], comprobantes: [] } as RespuestaLote,
    });
    expect(await emitirIntencion(deps, 'i1', armarFacturaC)).toMatchObject({ estado: 'RECHAZADA', codigo: null });
    expect(repo.intenciones.get('i1')!.motivo).toMatch(/sin dar motivo/u);
  });
});

describe('E4 · emitir: lo que se descubre ANTES de llamar no toca la intención', () => {
  it('ARCA no está sano: no se reserva, no se persiste nada, no se pide nada', async () => {
    const { repo, arca, deps } = entorno();
    arca.vivo = false;
    expect(await emitirIntencion(deps, 'i1', armarFacturaC)).toMatchObject({ estado: 'NO_SE_EMITIO', motivo: 'SERVICIO_NO_DISPONIBLE' });
    expect(repo.estado('i1')).toBe('BORRADOR');
    expect(repo.llamadasEnOrden).toEqual([]);
    expect(arca.pedidosDeCae).toBe(0);
  });

  it('la consulta del último autorizado falla: ídem', async () => {
    const { repo, arca, deps } = entorno();
    arca.ultimoAutorizado = async () => {
      throw new Error('ECONNREFUSED');
    };
    expect(await emitirIntencion(deps, 'i1', armarFacturaC)).toMatchObject({ motivo: 'SERVICIO_NO_DISPONIBLE' });
    expect(repo.estado('i1')).toBe('BORRADOR');
  });

  it('si el comprobante no se puede armar, NO se reserva número (no se traba el punto de venta)', async () => {
    const { repo, arca, deps } = entorno();
    const sinLineas = (numero: number) =>
      armarComprobante({
        emisor: { cuit: CUIT, condicionIva: 'MONOTRIBUTO' },
        receptor: { condicionIva: 'CONSUMIDOR_FINAL', tipoDocumento: 'SIN_IDENTIFICAR', numeroDocumento: null },
        clase: 'FACTURA',
        puntoDeVenta: 1,
        numero,
        fecha: '2026-10-16',
        lineas: [],
      });
    const r = await emitirIntencion(deps, 'i1', sinLineas);
    expect(r).toMatchObject({ estado: 'NO_SE_EMITIO', motivo: 'NO_ARMABLE' });
    expect((r as { problemas?: unknown[] }).problemas?.length).toBeGreaterThan(0);
    expect(repo.llamadasEnOrden).toEqual([]);
    expect(repo.estado('i1')).toBe('BORRADOR');
    expect(arca.pedidosDeCae).toBe(0);
  });

  it('el comprobante armado tiene que ser el que se declaró: otro tipo → no se reserva ni se emite', async () => {
    const { repo, arca, deps } = entorno();
    repo.crear('b', { cbteTipo: 6 }); // la intención dice «Factura B» y el armado da una C
    expect(await emitirIntencion(deps, 'b', armarFacturaC)).toMatchObject({ estado: 'NO_SE_EMITIO', motivo: 'NO_ES_LA_INTENCION' });
    expect(repo.llamadasEnOrden).toEqual([]);
    expect(arca.pedidosDeCae).toBe(0);
  });

  it('hay otra emisión sin resolver en el punto de venta: se informa, no se emite', async () => {
    const { repo, arca, deps } = entorno();
    repo.falloAlReservar = new ErrorDeEmision('CARRIL_OCUPADO', 'Hay otra emisión sin resolver en el punto de venta 1');
    expect(await emitirIntencion(deps, 'i1', armarFacturaC)).toMatchObject({ estado: 'NO_SE_EMITIO', motivo: 'CARRIL_OCUPADO' });
    expect(arca.pedidosDeCae).toBe(0);
  });

  it('ARCA y la base no cuentan lo mismo: no se emite', async () => {
    const { repo, deps } = entorno();
    repo.falloAlReservar = new ErrorDeEmision('ULTIMO_INCONSISTENTE', 'ARCA informa 40 y esta empresa tiene autorizado el 52');
    expect(await emitirIntencion(deps, 'i1', armarFacturaC)).toMatchObject({ motivo: 'NUMERACION_INCONSISTENTE' });
  });

  it('un error inesperado del repositorio no se disfraza', async () => {
    const { repo, deps } = entorno();
    repo.falloAlReservar = new ErrorDeEmision('TRANSICION_NO_PERMITIDA', 'inesperado');
    await expect(emitirIntencion(deps, 'i1', armarFacturaC)).rejects.toThrow(/inesperado/u);
  });

  it('una intención que no existe', async () => {
    const { deps } = entorno();
    await expect(emitirIntencion(deps, 'nada', armarFacturaC)).rejects.toMatchObject({ codigo: 'INTENCION_INEXISTENTE' });
  });
});

describe('E4 · emitir: una LISTA (se reservó y no llegó a salir) se retoma sólo si el número sigue siendo el siguiente', () => {
  it('con el número aún vigente, emite sin reservar otro', async () => {
    const { repo, arca, deps } = entorno();
    repo.crear('l', { estado: 'LISTA', cbteNumero: 52 });
    const r = await emitirIntencion(deps, 'l', armarFacturaC);
    expect(r).toMatchObject({ estado: 'AUTORIZADA', cbteNumero: 52 });
    expect(repo.llamadasEnOrden).toEqual(['emitiendo', 'autorizada']);
    expect(arca.pedidosDeCae).toBe(1);
  });

  it('si ARCA ya avanzó (el número ya no es el siguiente), no emite: hay que anular o reconciliar', async () => {
    const { repo, arca, deps } = entorno();
    arca.ultimo = 52; // alguien emitió el 52 mientras tanto
    repo.crear('l', { estado: 'LISTA', cbteNumero: 52 });
    expect(await emitirIntencion(deps, 'l', armarFacturaC)).toMatchObject({ estado: 'NO_SE_EMITIO', motivo: 'NUMERO_DESFASADO' });
    expect(arca.pedidosDeCae).toBe(0);
    expect(repo.estado('l')).toBe('LISTA');
  });

  it('si no se puede armar con el número reservado, queda LISTA y lo dice', async () => {
    const { repo, deps } = entorno();
    repo.crear('l', { estado: 'LISTA', cbteNumero: 52 });
    const r = await emitirIntencion(deps, 'l', () => armarComprobante({
      emisor: { cuit: '1', condicionIva: 'MONOTRIBUTO' },
      receptor: { condicionIva: 'CONSUMIDOR_FINAL', tipoDocumento: 'SIN_IDENTIFICAR', numeroDocumento: null },
      clase: 'FACTURA', puntoDeVenta: 1, numero: 52, fecha: '2026-10-16', lineas: [],
    }));
    expect(r).toMatchObject({ motivo: 'NO_ARMABLE' });
    expect((r as { detalle: string }).detalle).toMatch(/LISTA/u);
    expect(repo.estado('l')).toBe('LISTA');
  });
});

// ─────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────
// Reconciliar
// ─────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────

describe('E4 · reconciliar: averigua, nunca emite', () => {
  const evidencia = (numero = 52): EvidenciaDeAutorizacion => ({ cae: '86421002219999', caeVencimiento: '20261026', numeroAutorizado: numero });

  function enDuda() {
    const repo = new RepoSimulado();
    repo.crear('d', { estado: 'DESCONOCIDA', cbteNumero: 52 });
    return repo;
  }
  const reconciliadorQue = (r: Awaited<ReturnType<ReconciliadorDeEmision['reconciliar']>> | Error): ReconciliadorDeEmision => ({
    reconciliar: async () => {
      if (r instanceof Error) throw r;
      return r;
    },
  });

  it('ARCA dice que existe y trae la evidencia → AUTORIZADA', async () => {
    const repo = enDuda();
    const r = await reconciliarIntencion({ repo, reconciliador: reconciliadorQue({ estado: 'AUTORIZADO', evidencia: evidencia() }) }, 'd');
    expect(r).toMatchObject({ estado: 'AUTORIZADA', cae: '86421002219999', cbteNumero: 52 });
    expect(repo.estado('d')).toBe('AUTORIZADA');
  });

  it('ARCA nunca lo autorizó (el último es el anterior) → RECHAZADA, con motivo', async () => {
    const repo = enDuda();
    const r = await reconciliarIntencion({ repo, reconciliador: reconciliadorQue({ estado: 'NO_AUTORIZADO', detalle: 'último autorizado 51' }) }, 'd');
    expect(r).toMatchObject({ estado: 'RECHAZADA' });
    expect(repo.estado('d')).toBe('RECHAZADA');
    expect(repo.intenciones.get('d')!.motivo).toMatch(/nunca lo autorizó/u);
  });

  it.each([
    ['SIN_RESPUESTA', { estado: 'SIN_RESPUESTA', detalle: 'red caída' } as const],
    ['EXISTE_SIN_EVIDENCIA', { estado: 'EXISTE_SIN_EVIDENCIA', detalle: 'existe, falta el CAE' } as const],
  ])('%s → la duda sigue (vuelve a DESCONOCIDA), y no se rechaza ni se autoriza', async (_n, respuesta) => {
    const repo = enDuda();
    const r = await reconciliarIntencion({ repo, reconciliador: reconciliadorQue(respuesta) }, 'd');
    expect(r).toMatchObject({ estado: 'SIGUE_EN_DUDA' });
    expect(repo.estado('d')).toBe('DESCONOCIDA');
  });

  it('el reconciliador que revienta no resuelve nada: la duda sigue', async () => {
    const repo = enDuda();
    expect(await reconciliarIntencion({ repo, reconciliador: reconciliadorQue(new Error('boom')) }, 'd')).toMatchObject({ estado: 'SIGUE_EN_DUDA' });
    expect(repo.estado('d')).toBe('DESCONOCIDA');
  });

  it('«existe» con otro número autorizado: la evidencia no sirve y la duda sigue', async () => {
    const repo = enDuda();
    const r = await reconciliarIntencion({ repo, reconciliador: reconciliadorQue({ estado: 'AUTORIZADO', evidencia: evidencia(60) }) }, 'd');
    expect(r).toMatchObject({ estado: 'SIGUE_EN_DUDA' });
    expect(repo.estado('d')).toBe('DESCONOCIDA');
  });

  it('una intención que no está en duda no se reconcilia', async () => {
    const repo = new RepoSimulado();
    repo.crear('a', { estado: 'AUTORIZADA', cbteNumero: 52 });
    repo.crear('b');
    const rec = reconciliadorQue({ estado: 'NO_AUTORIZADO', detalle: 'x' });
    expect(await reconciliarIntencion({ repo, reconciliador: rec }, 'a')).toEqual({ estado: 'NADA_QUE_RECONCILIAR', actual: 'AUTORIZADA' });
    expect(await reconciliarIntencion({ repo, reconciliador: rec }, 'b')).toEqual({ estado: 'NADA_QUE_RECONCILIAR', actual: 'BORRADOR' });
  });

  it('la pasada periódica recupera las huérfanas (EMITIENDO viejas) y reconcilia todo; las EMITIENDO recientes no se tocan', async () => {
    const repo = new RepoSimulado();
    repo.crear('huerfana', { estado: 'EMITIENDO', cbteNumero: 52 }, 900); // 15 minutos sin moverse
    repo.crear('en-vuelo', { estado: 'EMITIENDO', cbteNumero: 53 }, 10); // hace diez segundos: puede estar llamando
    repo.crear('duda', { estado: 'DESCONOCIDA', cbteNumero: 54 });
    repo.crear('libre');
    const respuestas: Record<number, Awaited<ReturnType<ReconciliadorDeEmision['reconciliar']>>> = {
      52: { estado: 'AUTORIZADO', evidencia: { cae: '86421002211111', caeVencimiento: '20261026', numeroAutorizado: 52 } },
      54: { estado: 'NO_AUTORIZADO', detalle: 'último 53' },
    };
    const resumen = await reconciliarPendientes({
      repo,
      reconciliador: { reconciliar: async (p) => respuestas[p.numeroReservado]! },
    });
    expect(resumen).toEqual({ revisadas: 2, autorizadas: 1, rechazadas: 1, siguenEnDuda: 0, huerfanasRecuperadas: 1 });
    expect(repo.estado('huerfana')).toBe('AUTORIZADA');
    expect(repo.estado('duda')).toBe('RECHAZADA');
    expect(repo.estado('en-vuelo')).toBe('EMITIENDO');
    expect(repo.estado('libre')).toBe('BORRADOR');
  });
});

describe('E4 · la propiedad que importa, barrida', () => {
  it('ninguna combinación de desenlaces y reintentos pide más de un CAE por intención', async () => {
    const respuestas: Array<RespuestaLote | Error> = [
      autorizado(52),
      rechazado(10016, 'no es el próximo'),
      new Error('timeout'),
      new Error('ECONNRESET'),
      { Resultado: 'P', errores: [], eventos: [], comprobantes: [] },
      autorizado(99),
    ];
    for (const respuesta of respuestas) {
      const { arca, deps } = entorno();
      arca.respuesta = respuesta;
      for (let i = 0; i < 6; i += 1) await emitirIntencion(deps, 'i1', armarFacturaC);
      expect(arca.pedidosDeCae, `respuesta ${String(respuesta instanceof Error ? respuesta.message : respuesta.Resultado)}`).toBe(1);
    }
  });
});
