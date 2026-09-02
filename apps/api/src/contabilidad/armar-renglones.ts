/**
 * De un comprobante y el mapeo declarado, a los renglones de un asiento.
 *
 * Es la función que faltaba. `decision-de-comprobante.ts` siempre supo producir
 * una propuesta con renglones —recibe el armador como parámetro— y la API le
 * pasaba `() => []`, así que la propuesta salía vacía y encima se descartaba.
 * No era un olvido: sin saber a qué cuenta va cada cosa, armar el asiento
 * exigía que el sistema eligiera la cuenta, y eso es inventar la contabilidad
 * de alguien.
 *
 * ## No inventa una sola cuenta
 *
 * Todo sale del mapeo que la empresa declaró (`company_account_map`). Si falta
 * un rol, no arma nada y **dice cuál falta**. Nunca elige «la cuenta más
 * parecida».
 *
 * ## Y no arma lo que no sabe armar
 *
 * Se arma el caso que el mapeo cubre: neto gravado más IVA contra la cuenta
 * corriente del tercero. Si el comprobante trae conceptos que ese mapeo no
 * contempla —no gravado, exento, percepciones— **no se propone nada**, con el
 * motivo escrito. Meterlos en la cuenta de ventas porque «total tiene que
 * cerrar» produciría un asiento cuadrado y equivocado, que es la peor
 * combinación posible: pasa todos los controles y dice una mentira.
 *
 * ## Cuadra por construcción, y aun así se comprueba
 *
 * El último control suma los dos lados. Si no dan iguales no se propone: un
 * asiento descuadrado lo rechazaría el candado de la base, pero llegar hasta
 * ahí ya habría hecho perder el tiempo a una persona.
 */

import type { Money } from '@aai/shared';
import { toDecimalString } from '@aai/shared';

/**
 * Los roles que el mapeo declara.
 *
 * Los seis primeros arman el asiento de un comprobante. Los dos últimos los
 * agregó la 0079 para el asiento de costo de mercadería vendida: no participan
 * de esta función, pero viven en el mismo mapeo porque son la misma clase de
 * declaración —a qué cuenta va cada cosa— y separarlos habría dejado dos
 * lugares donde declarar lo mismo.
 */
export type RolContable =
  | 'CLIENTES'
  | 'PROVEEDORES'
  | 'IVA_DEBITO'
  | 'IVA_CREDITO'
  | 'VENTAS'
  | 'COMPRAS'
  | 'MERCADERIA'
  | 'COSTO_DE_VENTAS';

export interface CuentaDelRol {
  readonly rol: RolContable;
  readonly codigo: string;
  readonly exigeTercero: boolean;
}

export interface ComprobanteParaArmar {
  readonly direccion: 'VENTAS' | 'COMPRAS';
  readonly neto: Money;
  readonly iva: Money;
  readonly total: Money;
  readonly noGravado: Money;
  readonly exento: Money;
  readonly percepciones: Money;
  readonly terceroId: string | null;
  readonly descripcion: string;
}

export interface RenglonPropuesto {
  readonly accountCode: string;
  readonly debit: string;
  readonly credit: string;
  readonly descripcion: string;
  readonly partyId?: string;
}

export interface Construccion {
  readonly renglones: readonly RenglonPropuesto[];
  /** Por qué no hay renglones. `null` cuando sí los hay. */
  readonly motivo: string | null;
  /** Los roles que hicieron falta y no estaban declarados. */
  readonly rolesFaltantes: readonly RolContable[];
}

const CERO = '0';

function vacia(motivo: string, rolesFaltantes: readonly RolContable[] = []): Construccion {
  return { renglones: [], motivo, rolesFaltantes };
}

/**
 * Arma los renglones, o explica por qué no.
 *
 * Nunca lanza: la llama `decidir()` en medio de una transacción, y una excepción
 * ahí convertiría «falta declarar una cuenta» en un error 500.
 */
export function armarRenglones(
  comprobante: ComprobanteParaArmar,
  mapeo: ReadonlyMap<RolContable, CuentaDelRol>,
): Construccion {
  const otros = [comprobante.noGravado, comprobante.exento, comprobante.percepciones];
  if (otros.some((m) => m.amount !== 0n)) {
    return vacia(
      'El comprobante trae conceptos que el mapeo declarado no contempla (no gravado, ' +
        'exento o percepciones). Meterlos en la cuenta de ventas para que el total cierre ' +
        'daría un asiento cuadrado y equivocado: se propone nada y lo arma una persona.',
    );
  }

  const esVenta = comprobante.direccion === 'VENTAS';
  const rolContraparte: RolContable = esVenta ? 'CLIENTES' : 'PROVEEDORES';
  const rolResultado: RolContable = esVenta ? 'VENTAS' : 'COMPRAS';
  const rolIva: RolContable = esVenta ? 'IVA_DEBITO' : 'IVA_CREDITO';

  // El IVA solo hace falta si el comprobante lo discrimina. Exigir la cuenta
  // para un comprobante sin IVA sería pedir una declaración que no se usa.
  const necesarios: RolContable[] = [rolContraparte, rolResultado];
  if (comprobante.iva.amount !== 0n) necesarios.push(rolIva);

  const faltantes = necesarios.filter((rol) => !mapeo.has(rol));
  if (faltantes.length > 0) {
    return vacia(
      'Falta declarar a qué cuenta va: ' +
        faltantes.join(', ') +
        '. Sin eso el sistema no elige ninguna: elegirla sería inventar la contabilidad de ' +
        'esta empresa.',
      faltantes,
    );
  }

  const contraparte = mapeo.get(rolContraparte)!;
  const resultado = mapeo.get(rolResultado)!;

  if (contraparte.exigeTercero && comprobante.terceroId === null) {
    return vacia(
      `La cuenta ${contraparte.codigo} exige tercero y el comprobante todavía no está ` +
        'vinculado a uno. Vinculalo y la propuesta se arma sola.',
    );
  }

  const tercero = comprobante.terceroId === null ? {} : { partyId: comprobante.terceroId };

  const renglones: RenglonPropuesto[] = esVenta
    ? [
        {
          accountCode: contraparte.codigo,
          debit: toDecimalString(comprobante.total),
          credit: CERO,
          descripcion: comprobante.descripcion,
          ...tercero,
        },
        {
          accountCode: resultado.codigo,
          debit: CERO,
          credit: toDecimalString(comprobante.neto),
          descripcion: comprobante.descripcion,
        },
      ]
    : [
        {
          accountCode: resultado.codigo,
          debit: toDecimalString(comprobante.neto),
          credit: CERO,
          descripcion: comprobante.descripcion,
        },
        {
          accountCode: contraparte.codigo,
          debit: CERO,
          credit: toDecimalString(comprobante.total),
          descripcion: comprobante.descripcion,
          ...tercero,
        },
      ];

  if (comprobante.iva.amount !== 0n) {
    const iva = mapeo.get(rolIva)!;
    renglones.splice(esVenta ? 2 : 1, 0, {
      accountCode: iva.codigo,
      debit: esVenta ? CERO : toDecimalString(comprobante.iva),
      credit: esVenta ? toDecimalString(comprobante.iva) : CERO,
      descripcion: `IVA ${esVenta ? 'débito' : 'crédito'} fiscal`,
    });
  }

  // Cuadra por construcción —total = neto + IVA— y aun así se comprueba: llegar
  // al candado de la base con un descuadre ya habría hecho perder el tiempo a
  // una persona. La suma es en enteros: los importes nunca pasan por un float.
  const debe = comprobante.total.amount;
  const haber = comprobante.neto.amount + comprobante.iva.amount;
  if (debe !== haber) {
    return vacia(
      `El total (${toDecimalString(comprobante.total)}) no es la suma del neto y el IVA ` +
        `(${toDecimalString(comprobante.neto)} + ${toDecimalString(comprobante.iva)}). ` +
        'No se propone un asiento que no cuadra.',
    );
  }

  return { renglones, motivo: null, rolesFaltantes: [] };
}
