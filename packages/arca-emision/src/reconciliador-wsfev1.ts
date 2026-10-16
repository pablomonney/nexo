/**
 * El reconciliador fiscal contra WSFEv1: «mandé el pedido, se cortó, ¿ARCA lo autorizó o no?».
 *
 * Cierra lo que `NEXO_B2_5_4_1_FISCAL_EMISSION_SAFETY.md` §16 dejaba como riesgo #1 («`FECompConsultar` sin implementar: una
 * intención que resultó autorizada no recupera su CAE sola»). Implementa **estructuralmente** el puerto `ReconciliadorFiscal` de
 * `apps/api/src/fiscal/reconciliador.ts` (sin importarlo: la API no puede importar este paquete — es la regla
 * `la-emision-no-llega-a-la-aplicacion`, y levantarla es una decisión aparte, a sabiendas).
 *
 * ## Los dos mecanismos, en orden
 *
 *   1. `FECompUltimoAutorizado` dice por dónde va la numeración de ese punto de venta y tipo, y por lo tanto **si** el número
 *      reservado se autorizó:
 *          último ≥ reservado        → existe, hay que traerlo;
 *          último = reservado − 1    → nunca se autorizó;
 *          último < reservado − 1    → inconsistente: **no se adivina**.
 *   2. `FECompConsultar` trae el comprobante con su CAE y su vencimiento: es la evidencia para pasar a AUTORIZADA.
 *
 * ## Las reglas que no se negocian
 *
 *   · Ante la duda, **la duda sigue**: cualquier cosa que no sea una respuesta inequívoca de ARCA deja la intención en
 *     `SIN_RESPUESTA`. Preguntar de más cuesta una consulta; emitir de más cuesta una factura.
 *   · `NO_AUTORIZADO` sólo sale de «el último autorizado es exactamente el anterior al reservado». Un error de red, una
 *     credencial vencida o un `INDETERMINADO` **nunca** lo producen: habilitarían a facturar de nuevo algo que quizá existe.
 *   · La evidencia se devuelve tal cual; quien la guarda la valida (`verificarEvidencia` del motor fiscal: el número
 *     autorizado tiene que ser el reservado).
 */

import type { Autenticacion, ConsultaDeComprobante } from './contracts.js';
import type { ClienteWsfev1 } from './wsfev1.js';

export interface PedidoDeReconciliacionWsfe {
  readonly puntoVenta: number;
  readonly cbteTipo: number;
  /** El número que la intención reservó. */
  readonly numeroReservado: number;
}

export type ResultadoDeReconciliacionWsfe =
  | {
      readonly estado: 'AUTORIZADO';
      readonly evidencia: { readonly cae: string; readonly caeVencimiento: string; readonly numeroAutorizado: number };
    }
  | { readonly estado: 'NO_AUTORIZADO'; readonly detalle: string }
  | { readonly estado: 'EXISTE_SIN_EVIDENCIA'; readonly detalle: string }
  | { readonly estado: 'SIN_RESPUESTA'; readonly detalle: string };

export class ReconciliadorWsfev1 {
  readonly id = 'wsfev1';

  constructor(
    private readonly cliente: ClienteWsfev1,
    /** Devuelve el ticket vigente (de la caché compartida: el WSAA da uno solo por CUIT y servicio). */
    private readonly autenticar: () => Promise<Autenticacion>,
  ) {}

  async reconciliar(p: PedidoDeReconciliacionWsfe): Promise<ResultadoDeReconciliacionWsfe> {
    if (!Number.isInteger(p.numeroReservado) || p.numeroReservado <= 0) {
      return { estado: 'SIN_RESPUESTA', detalle: 'El número reservado no es válido: no se reconcilia.' };
    }

    let auth: Autenticacion;
    let ultimo: number;
    try {
      auth = await this.autenticar();
      ultimo = await this.cliente.ultimoAutorizado(auth, p.puntoVenta, p.cbteTipo);
    } catch (error) {
      return { estado: 'SIN_RESPUESTA', detalle: `No se pudo preguntar por la numeración: ${mensajeSeguro(error)}` };
    }

    if (ultimo === p.numeroReservado - 1) {
      return {
        estado: 'NO_AUTORIZADO',
        detalle:
          `ARCA informa que el último autorizado es el ${String(ultimo)}: el ${String(p.numeroReservado)} nunca se autorizó. ` +
          'ARCA no avanzó su numeración: el siguiente pedido lleva ese mismo número (medido en homologación el 2026-10-16: no tolera huecos).',
      };
    }
    if (ultimo < p.numeroReservado - 1) {
      return {
        estado: 'SIN_RESPUESTA',
        detalle:
          `INCONSISTENTE: el último autorizado es el ${String(ultimo)} y se había reservado el ${String(p.numeroReservado)}. ` +
          'No se adivina: revisar a mano en el portal de ARCA.',
      };
    }

    // último ≥ reservado: el comprobante existe. Falta traer su CAE.
    let consulta: ConsultaDeComprobante;
    try {
      consulta = await this.cliente.consultarComprobante(auth, p.puntoVenta, p.cbteTipo, p.numeroReservado);
    } catch (error) {
      return {
        estado: 'EXISTE_SIN_EVIDENCIA',
        detalle: `Existe (el último autorizado es el ${String(ultimo)}), pero no se pudo traer su CAE: ${mensajeSeguro(error)}`,
      };
    }

    switch (consulta.estado) {
      case 'NO_EXISTE':
        return {
          estado: 'SIN_RESPUESTA',
          detalle:
            `CONTRADICCIÓN: el último autorizado es el ${String(ultimo)} pero la consulta del ${String(p.numeroReservado)} dice que no existe. ` +
            'No se concluye nada: revisar a mano en el portal de ARCA.',
        };
      case 'INDETERMINADO':
        return {
          estado: 'EXISTE_SIN_EVIDENCIA',
          detalle: `Existe (el último autorizado es el ${String(ultimo)}), pero ARCA no devolvió su CAE: ${consulta.motivo}`,
        };
      case 'ENCONTRADO': {
        const c = consulta.comprobante;
        if (c.Resultado !== 'A' || c.CAE === null || c.CAEFchVto === null) {
          return {
            estado: 'EXISTE_SIN_EVIDENCIA',
            detalle: `ARCA devolvió el comprobante con Resultado "${c.Resultado}" y sin CAE o vencimiento completos.`,
          };
        }
        if (c.CbteDesde !== p.numeroReservado || c.CbteHasta !== p.numeroReservado) {
          return {
            estado: 'SIN_RESPUESTA',
            detalle: `ARCA devolvió el comprobante ${String(c.CbteDesde)}–${String(c.CbteHasta)} y se había reservado el ${String(p.numeroReservado)}: no coinciden.`,
          };
        }
        return { estado: 'AUTORIZADO', evidencia: { cae: c.CAE, caeVencimiento: c.CAEFchVto, numeroAutorizado: c.CbteDesde } };
      }
    }
  }
}

/** El mensaje de un error, sin lo que pudiera traer una credencial: sólo texto corto y sin `token`/`sign`. */
function mensajeSeguro(error: unknown): string {
  const m = error instanceof Error ? error.message : String(error);
  return m.replace(/(token|sign)[^,;)]*/giu, '$1=[oculto]').slice(0, 300);
}
