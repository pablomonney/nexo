/**
 * El vocabulario de una cuenta contable: la fuente única.
 *
 * ## Por qué existe este archivo
 *
 * Los siete tipos de cuenta estaban escritos **seis veces** en TypeScript, más
 * el `CHECK` de la 0003: en el alta de cuentas, en el cierre de ejercicio, en el
 * contexto del Mayor, en los estados contables, en el catálogo y en los mapas de
 * la importación. Las seis listaban lo mismo, que es exactamente la situación en
 * la que este repositorio ya se equivocó dos veces —el organismo de contralor y
 * el tipo de entidad—: **dos copias de una decisión se desincronizan y nadie lo
 * nota, porque las dos siguen contestando**.
 *
 * Lo mismo pasaba con los cinco roles fiscales (dos copias) y con la naturaleza
 * que le corresponde a cada tipo (tres mapas idénticos).
 *
 * ## Qué NO vive acá, y por qué
 *
 * Esto es vocabulario, no reglas. Tres cosas que parecían candidatas y se
 * quedaron donde estaban:
 *
 *     TIPOS_PATRIMONIALES      cierre-de-ejercicio.ts. Es el subconjunto que
 *                              sobrevive a la refundición: una regla contable
 *                              del cierre, no una lista de valores admitidos.
 *
 *     TEXTO_A_TIPO             escritores.ts. Traduce «patrimonio neto» al
 *     TIPO_POR_DIGITO          vocabulario, y deducir el tipo del primer dígito
 *                              es una convención que esa capa declara como tal.
 *                              El contrato es de la importación: qué acepta de
 *                              un sistema ajeno.
 *
 * Mudarlas acá habría convertido un archivo de vocabulario en un archivo de
 * reglas, que es la forma en que estos archivos se echan a perder.
 *
 * ## Los CHECK de la base se quedan
 *
 * `accounts.type`, `accounts.nature` y `accounts.tax_role` siguen teniendo su
 * restricción en SQL. No son una segunda definición: son la defensa de
 * integridad, y valen aunque el que escriba no pase por este código. Lo que sí
 * hace falta es que no se desincronicen, y de eso se encarga un test que lee la
 * migración y compara.
 */

/** Los siete de `accounts.type` (migración 0003). */
export const TIPOS_DE_CUENTA = [
  'ACTIVO',
  'PASIVO',
  'PN',
  'INGRESO',
  'COSTO',
  'GASTO',
  'ORDEN',
] as const;

export type TipoDeCuenta = (typeof TIPOS_DE_CUENTA)[number];

/** Los dos de `accounts.nature`. */
export const NATURALEZAS = ['DEUDORA', 'ACREEDORA'] as const;

export type Naturaleza = (typeof NATURALEZAS)[number];

/**
 * La naturaleza que le corresponde a cada tipo cuando nadie la invierte.
 *
 * «Cuando nadie la invierte» es la parte que importa: una regularizadora tiene
 * la naturaleza contraria a la de su tipo y eso es correcto —una previsión es
 * acreedora dentro del activo—. Este mapa dice cuál es la habitual, no cuál es
 * la única admitida, y por eso el alta lo usa como valor por defecto y no como
 * validación.
 */
export const NATURALEZA_POR_TIPO: Readonly<Record<TipoDeCuenta, Naturaleza>> = {
  ACTIVO: 'DEUDORA',
  PASIVO: 'ACREEDORA',
  PN: 'ACREEDORA',
  INGRESO: 'ACREEDORA',
  COSTO: 'DEUDORA',
  GASTO: 'DEUDORA',
  ORDEN: 'DEUDORA',
};

/** Los cinco de `accounts.tax_role`. El efecto fiscal de una cuenta, si tiene. */
export const TAX_ROLES = [
  'IVA_CF',
  'IVA_DF',
  'PERCEPCION',
  'RETENCION',
  'DIFERENCIA_CAMBIO',
] as const;

export type TaxRole = (typeof TAX_ROLES)[number];
