/**
 * audit-engine — análisis de variaciones y detección de anomalías.
 *
 * ## Por qué esto no usa IA
 *
 * El roadmap pone "detección de anomalías" en la fase de IA avanzada, y la
 * lectura natural es que hace falta un modelo. No hace falta, y usarlo sería
 * peor.
 *
 * Un hallazgo de auditoría tiene que poder explicarse ante un tercero: *este
 * gasto subió 340% contra el ejercicio anterior*, *esta cuenta tuvo movimientos
 * el 31 de diciembre a las 23:50*, *este proveedor factura siempre 999 pesos por
 * debajo del tope*. Las tres son afirmaciones aritméticas sobre datos que el
 * sistema tiene, y un modelo que las produzca introduce una capa que no se puede
 * auditar a cambio de nada.
 *
 * La IA entra recién en el módulo siguiente, y para lo único que sirve acá: leer
 * un hallazgo ya calculado y redactar la pregunta que un auditor haría.
 *
 * ## Todo en enteros, y con mediana
 *
 * Igual que en FASE 4: **mediana y desviación absoluta mediana**, no media y
 * desvío estándar. La media se deja arrastrar por un único valor extremo, y en
 * auditoría los valores extremos son justamente lo que se busca.
 */

export * from './variaciones.js';
export * from './anomalias.js';
