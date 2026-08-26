/**
 * sandbox — simulación sobre esquema aislado (§34).
 *
 * Dos piezas, y la primera es la que importa.
 *
 * ## 1. El candado pregunta al revés
 *
 * `verificarAislamiento` no comprueba que el destino **no** sea producción.
 * Comprueba que **sí** sea un sandbox, exigiendo una marca que solo existe si
 * alguien corrió a propósito la migración de sandbox sobre esa base.
 *
 * La diferencia es el modo de falla. Una lista de bases prohibidas falla abierta:
 * la base nueva que nadie agregó pasa, la de otro cliente pasa, la que alguien
 * renombró pasa. Y lo que pasa cuando falla no es un error visible — es una
 * simulación escribiendo asientos en la contabilidad real de alguien.
 *
 * Exigir prueba falla cerrada. Producción es rechazada no porque esté en una
 * lista, sino porque no puede demostrar lo que se le pide.
 *
 * ## 2. Los mismos motores, no una copia
 *
 * `simular` importa `@aai/accounting-engine` y `@aai/tax-engine` tal cual los usa
 * la aplicación. Un sandbox con lógica propia —más simple, sin las validaciones
 * que molestan en una demo— no muestra el sistema: muestra uno que no existe.
 *
 * Y `simular` pide un `Aislamiento` ya probado en su firma. Ese tipo no se puede
 * construir desde afuera del módulo del candado, así que no hay forma de correr
 * una simulación sin haber pasado por él.
 *
 * El resto —crear la base, aplicar las migraciones, dejar la marca— vive en
 * `scripts/sandbox.mjs`, porque este paquete es dominio puro y no abre conexiones.
 */

export * from './aislamiento.js';
export * from './escenario.js';
