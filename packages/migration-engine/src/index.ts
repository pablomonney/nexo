/**
 * El motor de migración: de un sistema cualquiera a NEXO, por un solo camino.
 *
 *     fuente → extracción → tablas crudas → mapeo → normalización
 *            → validación → vista previa → importación → reconciliación
 *
 * Cada paso vive en su archivo y no sabe de los otros dos más allá de su
 * entrada y su salida. Un origen nuevo agrega un adaptador; nada más se toca.
 *
 * Este paquete es **puro**: no abre conexiones, no escribe en la base y no lee
 * el disco por su cuenta. Lo que persiste está en `apps/api/src/migracion/`, y
 * esa separación es la que permite probar el motor entero sin base de datos.
 */

export * from './canonico.js';
export * from './contrato.js';
export * from './normalizador.js';
export * from './mapeo.js';
export * from './validador.js';
export * from './estados.js';
export * from './reconciliacion.js';
export * from './adapters/archivo.js';
export * from './adapters/preparados.js';

import { RegistroDeAdaptadores } from './contrato.js';
import { AdaptadorDeArchivo } from './adapters/archivo.js';
import { PENDIENTES } from './adapters/preparados.js';

/**
 * El registro que usa la aplicación.
 *
 * Se arma una sola vez y con todo adentro —lo implementado y lo que falta—
 * porque la matriz de compatibilidad tiene que poder mostrar las dos cosas. Lo
 * que separa una de otra es el estado, no la ausencia.
 */
export function registroPorDefecto(): RegistroDeAdaptadores {
  const registro = new RegistroDeAdaptadores();
  registro.registrar(new AdaptadorDeArchivo());
  for (const pendiente of PENDIENTES) registro.registrar(pendiente);
  return registro;
}
