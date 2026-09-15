/**
 * Cómo se le pone una pasarela distinta al servidor, y por qué hay un tipo para
 * eso.
 *
 * Tres lugares del sistema necesitan poder recibir un proveedor de pagos que no
 * sea el que sale de `config`: el webhook, las rutas de suscripción y el
 * proceso que drena la bandeja. Cuando cada uno declaraba su propia forma de
 * recibirlo, la misma cosa se llamaba `ambiente` en un archivo y
 * `ambienteConfigurado` en otro, y el `buildServer` terminaba traduciendo entre
 * las dos.
 *
 * ## Esto existe para los tests, y decirlo importa
 *
 * No hay cuenta de Mercado Pago. Y aunque la hubiera, una suite que hablara con
 * la API real estaría **a un `.env` mal copiado de cobrarle a alguien**:
 * producción y prueba comparten `api.mercadopago.com` y se distinguen solo por
 * el prefijo del token. Inyectar un doble no es una comodidad, es la única forma
 * responsable de ejercitar estos caminos.
 *
 * En producción no se pasa nada y todo sale de `config.pagos`.
 */

import type { ProveedorDePagos } from './puerto.js';

export interface PasarelaInyectada {
  /** El proveedor a usar. Sin esto, el que salga de la configuración. */
  readonly proveedor?: ProveedorDePagos;
  /** Contra qué cuenta. Sin esto, `PAYMENTS_ENV`. */
  readonly ambiente?: string;
  /** A dónde vuelve el navegador tras autorizar. Sin esto, `PAYMENTS_BACK_URL`. */
  readonly urlDeRetorno?: string | null;
}
