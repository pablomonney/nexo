/**
 * Punto de entrada: solo reexporta.
 *
 * Las definiciones viven en `contracts.ts`. Un barril que además define crea un
 * ciclo en cuanto un módulo importa sus tipos de él — el lint de arquitectura ya
 * lo detectó una vez en `@aai/ai-engine`.
 */

export * from './contracts.js';
export * from './proveedores.js';
export * from './redaccion.js';
