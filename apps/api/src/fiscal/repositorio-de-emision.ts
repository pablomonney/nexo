/**
 * El repositorio de la emisión fiscal sobre PostgreSQL — la mitad «de la base» del caso de uso de emisión (E4).
 *
 * El caso de uso (`emitirIntencion`, en `@aai/arca-emision`) no conoce la base: le pide cada transición a un repositorio. Este es
 * el repositorio real. **Vive en la aplicación y no importa ese paquete** (regla `la-emision-no-llega-a-la-aplicacion`, que se
 * levanta recién en E8): implementa el puerto *estructuralmente* y define su propio `ErrorDeEmision` —el caso de uso lo reconoce
 * por nombre—. Una prueba de integración comprueba que encajan.
 *
 * ## Cada método es UNA transición, con su precondición de estado
 *
 * Todos los `UPDATE` llevan `WHERE estado IN (…)`: si la intención no está donde el caso de uso cree, no se escribe nada y el
 * método falla (`TRANSICION_NO_PERMITIDA`) en vez de pisar lo que otro proceso haya hecho. Detrás, el trigger de la migración
 * 0117 repite la regla, así que una consulta suelta tampoco la saltea.
 *
 * ## Una transacción por método
 *
 * No hay una transacción que abarque la llamada a ARCA, y es a propósito: `EMITIENDO` tiene que estar **confirmado en la base
 * antes** de que salga el pedido. Si la transacción siguiera abierta durante la llamada y el proceso muriera, la base volvería a
 * `LISTA` y nadie sabría que el pedido pudo haber salido.
 */

import { recordAudit, withCompany, type Tx } from '@aai/db';

export type CodigoDeErrorDeEmision = 'CARRIL_OCUPADO' | 'ULTIMO_INCONSISTENTE' | 'INTENCION_INEXISTENTE' | 'TRANSICION_NO_PERMITIDA';

/** Mismo nombre y mismo `codigo` que el de `@aai/arca-emision`: el caso de uso lo reconoce por nombre. */
export class ErrorDeEmision extends Error {
  constructor(
    readonly codigo: CodigoDeErrorDeEmision,
    mensaje: string,
  ) {
    super(mensaje);
    this.name = 'ErrorDeEmision';
  }
}

export type EstadoGuardado = 'BORRADOR' | 'LISTA' | 'EMITIENDO' | 'AUTORIZADA' | 'RECHAZADA' | 'DESCONOCIDA' | 'RECONCILIANDO' | 'ANULADA';

export interface IntencionGuardada {
  readonly id: string;
  readonly estado: EstadoGuardado;
  readonly ambiente: 'homologacion' | 'produccion';
  readonly puntoVenta: number;
  readonly cbteTipo: number;
  readonly cbteNumero: number | null;
  readonly cae: string | null;
  /** `AAAA-MM-DD`. */
  readonly caeVencimiento: string | null;
}

export interface EvidenciaGuardada {
  readonly cae: string;
  /** `AAAAMMDD`, tal como lo devuelve el servicio. */
  readonly caeVencimiento: string;
  readonly numeroAutorizado: number;
}

export interface ContextoDeEmision {
  readonly companyId: string;
  /** `user:<uuid>` o `system:<proceso>`. */
  readonly actorId: string;
}

interface Fila {
  id: string;
  estado: EstadoGuardado;
  ambiente: 'homologacion' | 'produccion';
  punto_venta: number;
  cbte_tipo: number;
  cbte_numero: string | null;
  cae: string | null;
  cae_vencimiento: string | null;
}

const COLUMNAS = `id, estado, ambiente, punto_venta, cbte_tipo, cbte_numero::text AS cbte_numero, cae,
                  to_char(cae_vencimiento, 'YYYY-MM-DD') AS cae_vencimiento`;

const aIntencion = (f: Fila): IntencionGuardada => ({
  id: f.id,
  estado: f.estado,
  ambiente: f.ambiente,
  puntoVenta: f.punto_venta,
  cbteTipo: f.cbte_tipo,
  cbteNumero: f.cbte_numero === null ? null : Number(f.cbte_numero),
  cae: f.cae,
  caeVencimiento: f.cae_vencimiento,
});

const actorType = (actorId: string): 'USER' | 'SYSTEM' => (actorId.startsWith('user:') ? 'USER' : 'SYSTEM');

export class RepositorioSqlDeEmision {
  constructor(private readonly ctx: ContextoDeEmision) {}

  private transaccion<T>(fn: (tx: Tx) => Promise<T>): Promise<T> {
    return withCompany({ companyId: this.ctx.companyId, actorId: this.ctx.actorId }, fn);
  }

  private async auditar(tx: Tx, accion: string, id: string, nuevo: unknown, motivo?: string): Promise<void> {
    await recordAudit(tx, this.ctx.companyId, {
      actorType: actorType(this.ctx.actorId),
      actorId: this.ctx.actorId,
      action: accion,
      objectType: 'fiscal_emissions',
      objectId: id,
      newValue: nuevo,
      ...(motivo === undefined ? {} : { motivo }),
    });
  }

  /** Una transición con su precondición: si no había nada en el estado esperado, no se escribió nada y se dice. */
  private async transicion(
    tx: Tx,
    id: string,
    desde: readonly EstadoGuardado[],
    hacia: EstadoGuardado,
    asignaciones = '',
    valores: readonly unknown[] = [],
  ): Promise<void> {
    const r = await tx.query(
      `UPDATE fiscal_emissions
          SET estado = $2, actualizado_el = now()${asignaciones === '' ? '' : `, ${asignaciones}`}
        WHERE id = $1 AND estado = ANY($3::text[])`,
      [id, hacia, desde, ...valores],
    );
    if (r.rowCount !== 1) {
      throw new ErrorDeEmision(
        'TRANSICION_NO_PERMITIDA',
        `La intención fiscal ${id} no estaba en ${desde.join(' o ')}: no se pasó a ${hacia}.`,
      );
    }
  }

  async cargar(id: string): Promise<IntencionGuardada | null> {
    return this.transaccion(async (tx) => {
      const r = await tx.query<Fila>(`SELECT ${COLUMNAS} FROM fiscal_emissions WHERE id = $1`, [id]);
      const fila = r.rows[0];
      return fila === undefined ? null : aIntencion(fila);
    });
  }

  async reservarNumeroCorrelativo(id: string, ultimoAutorizadoPorArca: number): Promise<number> {
    return this.transaccion(async (tx) => {
      try {
        const r = await tx.query<{ n: string }>('SELECT reservar_numero_fiscal_correlativo($1, $2)::text AS n', [id, ultimoAutorizadoPorArca]);
        const numero = Number(r.rows[0]!.n);
        await this.auditar(tx, 'RESERVAR_NUMERO_FISCAL', id, { numero, ultimoAutorizadoPorArca });
        return numero;
      } catch (error) {
        const e = error as { code?: string; message?: string };
        // La transacción ya está abortada: la traducción va afuera de la sentencia, en el `catch` de quien la abrió.
        if (e.code === '55P03') throw new ErrorDeEmision('CARRIL_OCUPADO', e.message ?? 'Hay otra emisión sin resolver en este punto de venta.');
        if (e.code === '23514' && /ARCA informa/u.test(e.message ?? '')) throw new ErrorDeEmision('ULTIMO_INCONSISTENTE', e.message ?? '');
        if (e.code === 'P0002') throw new ErrorDeEmision('INTENCION_INEXISTENTE', e.message ?? id);
        throw error;
      }
    });
  }

  async marcarEmitiendo(id: string): Promise<void> {
    await this.transaccion(async (tx) => {
      await this.transicion(tx, id, ['LISTA'], 'EMITIENDO', 'llamadas = llamadas + 1');
      await this.auditar(tx, 'EMITIR_COMPROBANTE', id, { estado: 'EMITIENDO' });
    });
  }

  async marcarAutorizada(id: string, evidencia: EvidenciaGuardada): Promise<void> {
    await this.transaccion(async (tx) => {
      await this.transicion(
        tx,
        id,
        ['EMITIENDO', 'RECONCILIANDO'],
        'AUTORIZADA',
        "cae = $4, cae_vencimiento = to_date($5, 'YYYYMMDD'), ultimo_error = NULL",
        [evidencia.cae, evidencia.caeVencimiento],
      );
      await this.auditar(tx, 'EMITIR_COMPROBANTE', id, {
        estado: 'AUTORIZADA',
        cae: evidencia.cae,
        caeVencimiento: evidencia.caeVencimiento,
        numeroAutorizado: evidencia.numeroAutorizado,
      });
    });
  }

  async marcarRechazada(id: string, codigo: string | null, motivo: string): Promise<void> {
    await this.transaccion(async (tx) => {
      await this.transicion(tx, id, ['EMITIENDO', 'RECONCILIANDO'], 'RECHAZADA', 'ultimo_error = $4, codigo_rechazo = $5', [motivo, codigo]);
      await this.auditar(tx, 'EMITIR_COMPROBANTE', id, { estado: 'RECHAZADA', codigo }, motivo);
    });
  }

  async marcarDesconocida(id: string, motivo: string): Promise<void> {
    await this.transaccion(async (tx) => {
      await this.transicion(tx, id, ['EMITIENDO', 'RECONCILIANDO'], 'DESCONOCIDA', 'ultimo_error = $4', [motivo]);
      await this.auditar(tx, 'EMITIR_COMPROBANTE', id, { estado: 'DESCONOCIDA' }, motivo);
    });
  }

  async marcarReconciliando(id: string): Promise<void> {
    await this.transaccion(async (tx) => {
      await this.transicion(tx, id, ['DESCONOCIDA'], 'RECONCILIANDO');
      await this.auditar(tx, 'RECONCILIAR_EMISION', id, { estado: 'RECONCILIANDO' }, 'Se averigua contra ARCA si el comprobante se autorizó');
    });
  }

  async listarParaReconciliar(segundosEmitiendo: number): Promise<readonly IntencionGuardada[]> {
    return this.transaccion(async (tx) => {
      const r = await tx.query<Fila>(
        `SELECT ${COLUMNAS} FROM fiscal_emissions
          WHERE estado = 'DESCONOCIDA'
             OR (estado = 'EMITIENDO' AND actualizado_el < now() - make_interval(secs => $1))
          ORDER BY actualizado_el`,
        [segundosEmitiendo],
      );
      return r.rows.map(aIntencion);
    });
  }
}
