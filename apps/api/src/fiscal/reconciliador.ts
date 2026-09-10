/**
 * El puerto de reconciliación fiscal. **No hay implementación conectada.**
 *
 * Misma forma que resolvieron el correo, el proveedor de modelo y el gestor de
 * secretos: la estructura de este lado, el organismo del otro lado de la
 * interfaz.
 *
 * ## Qué pregunta responde
 *
 * Una sola, y es la que ordena toda la fase B2.5.4.1:
 *
 *     mandé el pedido, se cortó, **¿ARCA lo autorizó o no?**
 *
 * No se contesta reintentando. Se contesta preguntándole al organismo.
 *
 * ## Los dos mecanismos, y por qué hacen falta los dos
 *
 * ARCA ofrece dos operaciones distintas, y ninguna alcanza sola:
 *
 *     FECompUltimoAutorizado   dice por dónde va la numeración de un punto de
 *                              venta y un tipo. Comparado contra el número que
 *                              la intención reservó, resuelve **si existe**:
 *                              último ≥ reservado → el comprobante está.
 *                              Lo que NO dice es cuál es su CAE.
 *
 *     FECompConsultar          trae el comprobante completo, con su CAE y su
 *                              vencimiento. Es lo único que permite pasar a
 *                              AUTORIZADA con evidencia.
 *
 * **`FECompUltimoAutorizado` está implementado** en `@aai/arca-emision` y su
 * manual está archivado con hash. **`FECompConsultar` no está implementado**, y
 * este archivo no lo inventa: escribir el sobre XML de memoria produciría un
 * cliente que parece funcionar y falla contra el servicio real.
 *
 * La consecuencia, dicha sin disimulo: hoy la reconciliación puede determinar
 * **si** un comprobante quedó autorizado, y no puede recuperar su CAE. Una
 * intención que resultó existir queda esperando a que alguien la complete a
 * mano, y eso es preferible a inventarle un CAE.
 */

import type { EvidenciaDeAutorizacion } from '@aai/tax-engine';

/** Lo que hay que saber para preguntar por una emisión. */
export interface ConsultaDeReconciliacion {
  readonly companyId: string;
  readonly ambiente: 'homologacion' | 'produccion';
  readonly puntoVenta: number;
  readonly cbteTipo: number;
  /** El número que esta intención reservó. */
  readonly numeroReservado: number;
}

export type ResultadoDeReconciliacion =
  /** ARCA lo autorizó, y se pudo recuperar la evidencia completa. */
  | { readonly estado: 'AUTORIZADO'; readonly evidencia: EvidenciaDeAutorizacion }
  /**
   * ARCA nunca lo autorizó. El número quedó consumido igual: se sabe que ese
   * comprobante no existe, no que el número se pueda reusar.
   */
  | { readonly estado: 'NO_AUTORIZADO'; readonly detalle: string }
  /**
   * Existe y no se pudo traer el CAE.
   *
   * Es el estado que produce hoy la falta de `FECompConsultar`, y se declara
   * aparte a propósito: no es «no se pudo reconciliar» —se reconcilió, y la
   * respuesta fue que el comprobante está— sino «falta un dato para poder
   * escribirlo». Confundirlos llevaría a reintentar una emisión que ya existe.
   */
  | { readonly estado: 'EXISTE_SIN_EVIDENCIA'; readonly detalle: string }
  /** No se pudo averiguar. La intención sigue en duda. */
  | { readonly estado: 'SIN_RESPUESTA'; readonly detalle: string }
  /** No hay con qué preguntar. Es una condición del despliegue, no un error. */
  | { readonly estado: 'SIN_RECONCILIADOR'; readonly detalle: string };

export interface ReconciliadorFiscal {
  readonly id: string;
  consultar(consulta: ConsultaDeReconciliacion): Promise<ResultadoDeReconciliacion>;
}

/**
 * El que hay hoy: ninguno.
 *
 * No tira. Que no haya reconciliador es una condición conocida —la emisión no
 * está habilitada— y no un error del código que la consulta. Lo que sí hace es
 * **no mentir**: contesta `SIN_RECONCILIADOR`, que es distinto de
 * `NO_AUTORIZADO`.
 *
 * La diferencia no es sutil. `NO_AUTORIZADO` habilitaría a dar la intención por
 * fallida y facturar de nuevo; `SIN_RECONCILIADOR` deja la duda planteada, que
 * es lo correcto cuando no se preguntó nada.
 */
export class SinReconciliador implements ReconciliadorFiscal {
  readonly id = 'ninguno';

  async consultar(): Promise<ResultadoDeReconciliacion> {
    return {
      estado: 'SIN_RECONCILIADOR',
      detalle:
        'No hay reconciliador fiscal conectado. La emisión no está habilitada, así que no ' +
        'debería haber intenciones en duda; si hay una, se resuelve consultando el ' +
        'comprobante en el portal de ARCA y completándola a mano.',
    };
  }
}
