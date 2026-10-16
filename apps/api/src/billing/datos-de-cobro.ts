/**
 * A dónde se transfiere para pagar NEXO: los datos bancarios del Prestador, para el cobro manual.
 *
 * Hasta el 2026-10-15 estos datos **no estaban en ningún lado del sistema**: los avisos de cobranza no traían CBU, alias ni
 * titular, y el cliente no sabía a dónde transferir (`docs/COBRO_MANUAL_POR_TRANSFERENCIA.md` §5). Ahora se declaran en el
 * entorno de la instalación —no en el repositorio, que es público— y salen en los avisos y en la pantalla de Suscripción.
 *
 * ## Qué se valida, y por qué se calla lo que no sirve
 *
 * Un CBU mal escrito en un aviso es plata de un cliente transferida a un tercero. Por eso:
 *
 *   · el CBU tiene que ser de **22 dígitos con los dos dígitos verificadores correctos** (algoritmo del BCRA): un error de
 *     tipeo en el `.env` se detecta al arrancar, no cuando un cliente ya transfirió;
 *   · el titular es obligatorio: transferir a una cuenta sin saber de quién es no es una instrucción de pago;
 *   · **si algo no pasa, no se muestra NADA** (y el arranque lo dice en el log). Mostrar datos a medias o corruptos es peor
 *     que no mostrar: el aviso dice «escribinos para pagar» en vez de una cuenta equivocada.
 *
 * El módulo no lee el entorno por su cuenta: recibe un objeto, así que se prueba sin tocar `process.env`.
 */

export interface DatosBancarios {
  /** A nombre de quién está la cuenta (razón social o nombre completo). */
  readonly titular: string;
  /** 22 dígitos, con sus dos dígitos verificadores correctos. */
  readonly cbu: string;
  /** Alias del CBU (6 a 20 caracteres), si lo tiene. */
  readonly alias: string | null;
  /** Nombre del banco, si se quiere mostrar. */
  readonly banco: string | null;
  /** CUIT del titular, 11 dígitos, si se quiere mostrar. */
  readonly cuit: string | null;
}

export interface LecturaDeDatosBancarios {
  /** Los datos, listos para mostrar; `null` si no hay o si algo no pasó la validación. */
  readonly datos: DatosBancarios | null;
  /** Por qué no hay datos, cuando se declaró algo y no sirvió. `null` si no se declaró nada o si todo está bien. */
  readonly problema: string | null;
}

const PESOS_BLOQUE_1 = [7, 1, 3, 9, 7, 1, 3] as const;
const PESOS_BLOQUE_2 = [3, 9, 7, 1, 3, 9, 7, 1, 3, 9, 7, 1, 3] as const;

function digitoVerificador(digitos: string, pesos: readonly number[]): number {
  let suma = 0;
  for (let i = 0; i < pesos.length; i += 1) suma += Number(digitos[i]) * pesos[i]!;
  return (10 - (suma % 10)) % 10;
}

/**
 * ¿Es un CBU bien formado? 22 dígitos: banco (3) + sucursal (4) + dígito verificador del bloque 1, y cuenta (13) + dígito
 * verificador del bloque 2. No dice si la cuenta **existe** (eso sólo lo sabe el banco), sí si no hay un error de tipeo.
 */
export function cbuValido(cbu: string): boolean {
  if (!/^\d{22}$/u.test(cbu)) return false;
  const bloque1 = cbu.slice(0, 8);
  const bloque2 = cbu.slice(8);
  return (
    digitoVerificador(bloque1.slice(0, 7), PESOS_BLOQUE_1) === Number(bloque1[7]) &&
    digitoVerificador(bloque2.slice(0, 13), PESOS_BLOQUE_2) === Number(bloque2[13])
  );
}

const limpio = (v: string | undefined): string => (v ?? '').trim();

/**
 * Lee `NEXO_COBRO_TITULAR`, `NEXO_COBRO_CBU` y, opcionales, `NEXO_COBRO_ALIAS`, `NEXO_COBRO_BANCO` y `NEXO_COBRO_CUIT`.
 *
 * Sin ninguna declarada: no hay datos y no hay problema (es el estado de una instalación que todavía no cobra). Con alguna
 * declarada y algo mal: no hay datos y el problema dice qué.
 */
export function leerDatosBancarios(env: Readonly<Record<string, string | undefined>>): LecturaDeDatosBancarios {
  const titular = limpio(env['NEXO_COBRO_TITULAR']);
  const cbu = limpio(env['NEXO_COBRO_CBU']).replace(/[\s-]/gu, '');
  const alias = limpio(env['NEXO_COBRO_ALIAS']);
  const banco = limpio(env['NEXO_COBRO_BANCO']);
  const cuit = limpio(env['NEXO_COBRO_CUIT']).replace(/[\s-]/gu, '');

  if ([titular, cbu, alias, banco, cuit].every((v) => v === '')) return { datos: null, problema: null };

  if (titular === '') return { datos: null, problema: 'falta NEXO_COBRO_TITULAR: no se muestran datos de cobro sin saber a nombre de quién está la cuenta' };
  if (cbu === '') return { datos: null, problema: 'falta NEXO_COBRO_CBU' };
  if (!cbuValido(cbu)) return { datos: null, problema: 'NEXO_COBRO_CBU no es un CBU válido (22 dígitos con sus dígitos verificadores): probablemente un error de tipeo' };
  if (alias !== '' && !/^[A-Za-z0-9.-]{6,20}$/u.test(alias)) return { datos: null, problema: 'NEXO_COBRO_ALIAS no es un alias válido (6 a 20 caracteres: letras, números, punto y guion)' };
  if (cuit !== '' && !/^\d{11}$/u.test(cuit)) return { datos: null, problema: 'NEXO_COBRO_CUIT no tiene 11 dígitos' };

  return {
    datos: { titular, cbu, alias: alias === '' ? null : alias, banco: banco === '' ? null : banco, cuit: cuit === '' ? null : cuit },
    problema: null,
  };
}

/**
 * El texto que va en un aviso. `null` si no hay datos: entonces el aviso no dice nada de transferencias (no inventa una
 * cuenta ni promete una forma de pago que no está declarada).
 *
 * No lleva importe ni número de documento a propósito: es la misma regla que el resto de los avisos (`avisos.ts`).
 */
export function instruccionesDeTransferencia(datos: DatosBancarios | null): string | null {
  if (datos === null) return null;
  const lineas = [
    'Para pagar por transferencia bancaria:',
    `  Titular: ${datos.titular}${datos.cuit === null ? '' : ` (CUIT ${datos.cuit})`}`,
    `  CBU/CVU: ${datos.cbu}`,
    ...(datos.alias === null ? [] : [`  Alias: ${datos.alias}`]),
    ...(datos.banco === null ? [] : [`  Banco: ${datos.banco}`]),
    'Al transferir, guardá el número de operación y avisanos: sin él no podemos conciliar el pago.',
  ];
  return lineas.join('\n');
}
