/**
 * Contrato del cliente de ARCA.
 *
 * Ninguna implementación lanza excepciones por indisponibilidad del organismo:
 * un servicio caído es un resultado (`NO_VERIFICABLE`), no un error de programa.
 * La lógica contable no debe tener que envolver cada llamada en un try/catch
 * para no romperse cuando ARCA está de mantenimiento.
 */

import type { ArcaEnvironment } from './environment.js';
import type {
  ComprobanteAConstatar,
  EstadoServicio,
  ResultadoApocrifo,
  ResultadoConstatacion,
  ResultadoPadron,
} from './types.js';

export interface ArcaClient {
  readonly environment: ArcaEnvironment;

  /**
   * Constatación de comprobantes recibidos (WSCDC).
   *
   * Responde la pregunta "¿este comprobante está autorizado?" y **solo** esa.
   * No dice que la operación económica haya existido: son dimensiones distintas
   * de validación (§11 del pliego).
   */
  constatarComprobante(
    companyId: string,
    comprobante: ComprobanteAConstatar,
  ): Promise<ResultadoConstatacion>;

  consultarPadron(companyId: string, cuit: string): Promise<ResultadoPadron>;

  /** Consulta al registro de contribuyentes apócrifos (wsapoc). */
  consultarApocrifo(companyId: string, cuit: string): Promise<ResultadoApocrifo>;

  /** Ping (`Dummy`) para el panel de estado y para decidir si vale la pena reintentar. */
  estadoServicio(): Promise<EstadoServicio>;
}
