/**
 * El total consolidado de una pregunta hecha en varias empresas.
 *
 * Lo calcula el sistema y no el modelo: el asistente tiene prohibido sumar (una cifra que ninguna herramienta devolvió se rechaza entera), y un
 * «total del estudio» tiene que ser un número que se pueda rehacer. Es aritmética de enteros (centavos): nunca coma flotante.
 *
 * Sólo se suma cuando todas las respuestas son importes en la MISMA unidad. Sumar unidades distintas, o dejar afuera a la empresa que no pudo
 * afirmar su valor, daría un número que parece total y no lo es: en esos casos no hay total y se dice por qué.
 */

export interface FilaConsolidable {
  readonly valor: string | null;
  readonly unidad: string;
}

export interface Consolidado {
  readonly valor: string;
  readonly unidad: string;
  readonly empresasSumadas: number;
}

/** «1.234.567,89» → centavos. `null` si no es un importe en ese formato. */
export function centavosDe(valor: string): bigint | null {
  const m = /^(-?)(\d{1,3}(?:\.\d{3})*|\d+)(?:,(\d{1,2}))?$/u.exec(valor.trim());
  if (m === null) return null;
  const entero = BigInt(m[2]!.replace(/\./gu, ''));
  const dec = BigInt((m[3] ?? '').padEnd(2, '0') || '0');
  const total = entero * 100n + dec;
  return m[1] === '-' ? -total : total;
}

/** Centavos → «1.234.567,89», como los escribe el resto del sistema. */
export function centavosATextoEs(c: bigint): string {
  const negativo = c < 0n;
  const abs = negativo ? -c : c;
  const entero = (abs / 100n).toString().replace(/\B(?=(\d{3})+(?!\d))/gu, '.');
  return `${negativo ? '-' : ''}${entero},${(abs % 100n).toString().padStart(2, '0')}`;
}


export function consolidar(filas: readonly FilaConsolidable[]): { consolidado: Consolidado | null; motivoSinTotal: string | null } {
  if (filas.length < 2) return { consolidado: null, motivoSinTotal: 'Hay una sola empresa: no hay nada que consolidar.' };
  if (new Set(filas.map((f) => f.unidad)).size !== 1) return { consolidado: null, motivoSinTotal: 'Las empresas contestan en unidades distintas: no se suman.' };
  // Un porcentaje o una razón no se suma: el promedio de dos porcentajes no es el porcentaje del conjunto.
  if (filas.some((f) => /%/u.test(f.unidad))) return { consolidado: null, motivoSinTotal: 'Es un porcentaje: no se suma entre empresas.' };
  const importes = filas.map((f) => (f.valor === null ? null : centavosDe(f.valor)));
  if (importes.some((i) => i === null)) {
    return { consolidado: null, motivoSinTotal: 'Alguna empresa no pudo afirmar su valor, o no es un importe: el total no se calcula.' };
  }
  const total = importes.reduce<bigint>((a, i) => a + (i ?? 0n), 0n);
  return { consolidado: { valor: centavosATextoEs(total), unidad: filas[0]!.unidad, empresasSumadas: filas.length }, motivoSinTotal: null };
}
