/**
 * Punto de entrada del paquete: solo reexporta.
 *
 * Las definiciones viven en `contracts.ts`. Tenerlas acá creaba un ciclo — los
 * módulos importaban sus tipos del mismo archivo que los reexportaba— y el lint
 * de arquitectura lo detectó. Un barril que además define es un ciclo esperando.
 */

export * from './contracts.js';
export * from './contexto.js';
export * from './schema.js';
export * from './providers.js';
export * from './confianza.js';
export * from './validation.js';
export * from './aprendizaje.js';
export * from './classification-agent.js';
export * from './prompts/registry.js';
