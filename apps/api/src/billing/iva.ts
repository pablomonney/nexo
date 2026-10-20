/**
 * El IVA que se suma a un precio de lista que lo declara APARTE.
 *
 * Un precio de `plan_prices` con `incluye_impuestos = false` es **neto**: la lista dice «+ IVA». Lo que se le cobra al cliente es el neto
 * más el IVA, y hasta que esto existió el sistema cobraba el neto tal cual (la lista decía «+ IVA» y el cargo no lo sumaba: un 21 % menos
 * de lo que la página prometía).
 *
 * Todo en centavos enteros (`bigint`), nunca en punto flotante: es la regla del sistema y la que comprueba `check:no-float`.
 *
 * ## La alícuota
 *
 * 21 %, la general (Ley de IVA, art. 28, inc. a). Es una constante nombrada y no un número suelto porque es el único lugar donde la
 * facturación propia de NEXO la usa; si NEXO llegara a facturar con otra alícuota o con regímenes distintos, este es el sitio que cambia,
 * y debería salir del motor normativo.
 */

/** Alícuota general del IVA, en puntos porcentuales. */
export const ALICUOTA_GENERAL_DEL_IVA = 21n;

export interface ImporteConIva {
  readonly netoCentavos: bigint;
  readonly ivaCentavos: bigint;
  readonly totalCentavos: bigint;
}

/**
 * Suma el IVA a un neto. El IVA se redondea al centavo más cercano (la mitad hacia arriba): `neto × 21 / 100`.
 */
export function sumarIva(netoCentavos: bigint): ImporteConIva {
  if (netoCentavos < 0n) throw new RangeError('Un importe no puede ser negativo');
  const iva = (netoCentavos * ALICUOTA_GENERAL_DEL_IVA * 2n + 100n) / 200n;
  return { netoCentavos, ivaCentavos: iva, totalCentavos: netoCentavos + iva };
}

/** `12345` → `'123.45'`. */
export function centavosATexto(centavos: bigint): string {
  const negativo = centavos < 0n;
  const abs = negativo ? -centavos : centavos;
  const entera = abs / 100n;
  const resto = (abs % 100n).toString().padStart(2, '0');
  return `${negativo ? '-' : ''}${entera}.${resto}`;
}
