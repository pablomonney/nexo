/**
 * Alícuotas: se identifican, no se suponen.
 *
 * El comprobante trae un neto y un IVA discriminado. La pregunta es a qué
 * alícuota corresponden — y la respuesta correcta muchas veces es *no lo sé*.
 *
 * Lo que este archivo **no** hace, y es la parte importante:
 *
 * - No calcula el IVA a partir del neto. Lee el que el comprobante discrimina.
 *   Calcularlo sería reemplazar lo que el emisor declaró por lo que el sistema
 *   cree, y el que responde ante ARCA por ese número es el emisor.
 * - No supone 21% cuando no hay catálogo. Es la alícuota general en Argentina
 *   desde hace décadas y por eso mismo es la suposición más peligrosa: acierta
 *   casi siempre, y las veces que falla —carnes, frutas, medicina prepaga,
 *   servicios públicos, bienes de capital— falla en operaciones grandes.
 * - No redondea para que cierre. Si la diferencia excede el redondeo de la
 *   alícuota, es un hallazgo, no un ajuste.
 */

import type { CalendarDate, Money } from '@aai/shared';
import { money } from '@aai/shared';
import type { AlicuotaRelevada, HallazgoIva } from './contracts.js';

export interface IdentificacionAlicuota {
  readonly alicuota: AlicuotaRelevada | null;
  readonly hallazgos: readonly HallazgoIva[];
}

/** Alícuotas vigentes a la fecha del comprobante. El §6 en una función. */
export function alicuotasVigentes(
  catalogo: readonly AlicuotaRelevada[],
  fecha: CalendarDate,
): AlicuotaRelevada[] {
  return catalogo.filter(
    (alicuota) =>
      alicuota.vigenteDesde <= fecha &&
      (alicuota.vigenteHasta === null || fecha <= alicuota.vigenteHasta),
  );
}

/**
 * Qué alícuota relevada produce ese IVA sobre ese neto.
 *
 * Se prueban todas las vigentes y se acepta la que dé el importe exacto, o
 * dentro de un centavo. La tolerancia de un centavo no es laxitud: es que el
 * emisor redondeó cada renglón y nosotros estamos rehaciendo la cuenta desde el
 * total. Más de un centavo ya no es redondeo.
 *
 * Si ninguna da, el resultado es `null` con un hallazgo. **No se elige la más
 * cercana**: una alícuota "aproximada" en el subdiario de IVA es un número que
 * después alguien declara.
 */
export function identificarAlicuota(
  neto: Money,
  iva: Money,
  catalogo: readonly AlicuotaRelevada[],
  fecha: CalendarDate,
): IdentificacionAlicuota {
  const vigentes = alicuotasVigentes(catalogo, fecha);

  if (vigentes.length === 0) {
    return {
      alicuota: null,
      hallazgos: [
        {
          codigo: 'SIN_ALICUOTAS_RELEVADAS',
          mensaje:
            'No hay alícuotas de IVA relevadas para esta fecha. Si la base está vacía, corré `npm run tax:seed`. Si la fecha es anterior al 18/11/2002, no hay nada que correr: el texto ordenado archivado no transcribe sus antecedentes, así que nadie relevó qué decía el art. 28 entonces. El sistema no supone 21%.',
          bloquea: true,
        },
      ],
    };
  }

  // Un neto en cero no permite deducir nada: 0 × cualquier alícuota da 0.
  if (neto.amount === 0n) {
    return {
      alicuota: null,
      hallazgos:
        iva.amount === 0n
          ? []
          : [
              {
                codigo: 'IVA_INCOHERENTE_CON_ALICUOTA',
                mensaje: `El renglón tiene IVA ${iva.amount} sobre un neto de cero. Ninguna alícuota produce eso.`,
                bloquea: true,
              },
            ],
    };
  }

  for (const candidata of vigentes) {
    if (esperado(neto, candidata) === iva.amount) {
      return { alicuota: candidata, hallazgos: [] };
    }
  }

  // Segunda vuelta, admitiendo el centavo de redondeo del emisor.
  for (const candidata of vigentes) {
    const diferencia = esperado(neto, candidata) - iva.amount;
    if (diferencia === 1n || diferencia === -1n) {
      return { alicuota: candidata, hallazgos: [] };
    }
  }

  return {
    alicuota: null,
    hallazgos: [
      {
        codigo: 'ALICUOTA_NO_IDENTIFICADA',
        mensaje: `Ninguna alícuota vigente (${vigentes
          .map((a) => a.etiqueta)
          .join(', ')}) produce un IVA de ${iva.amount} sobre un neto de ${neto.amount}. Puede ser un comprobante con varias alícuotas en un renglón, un error del emisor, o una alícuota que falta relevar.`,
        bloquea: true,
      },
    ],
  };
}

/**
 * Verifica el IVA declarado contra la alícuota que el propio comprobante dice
 * aplicar.
 *
 * Distinto de identificar: acá el comprobante ya afirmó cuál es, y lo que se
 * controla es que el número le cierre. Un comprobante que dice "21%" y trae un
 * IVA que no sale del 21% está mal emitido, y llevarlo así al subdiario traslada
 * el error a la declaración jurada.
 */
export function verificarIvaDeclarado(
  neto: Money,
  iva: Money,
  alicuota: AlicuotaRelevada,
): HallazgoIva[] {
  const debido = esperado(neto, alicuota);
  const diferencia = debido - iva.amount;
  if (diferencia === 0n || diferencia === 1n || diferencia === -1n) return [];

  return [
    {
      codigo: 'IVA_INCOHERENTE_CON_ALICUOTA',
      mensaje: `El comprobante declara ${alicuota.etiqueta} sobre un neto de ${neto.amount}, que da ${debido}, y discrimina ${iva.amount}. Diferencia: ${diferencia} en unidades menores.`,
      bloquea: true,
    },
  ];
}

/**
 * IVA que corresponde a un neto según una alícuota, en unidades menores.
 *
 * Redondeo al centavo más cercano con desempate hacia arriba, hecho en enteros:
 * `(|neto| × num × 2 + den) / (den × 2)`, y el signo se repone al final. La
 * aritmética entera es obligatoria acá — el IVA de un neto grande calculado en
 * punto flotante se corre de a centavos y el subdiario deja de sumar.
 *
 * El valor absoluto no es adorno. La división de `bigint` trunca hacia cero, así
 * que sobre un neto negativo —una nota de crédito cargada con signo— el mismo
 * cálculo redondearía hacia arriba en vez de al más cercano, y una nota de
 * crédito devolvería un centavo menos de IVA del que retuvo la factura.
 */
function esperado(neto: Money, alicuota: AlicuotaRelevada): bigint {
  const negativo = neto.amount < 0n;
  const absoluto = negativo ? -neto.amount : neto.amount;
  const numerador = absoluto * alicuota.numerador * 2n + alicuota.denominador;
  const redondeado = numerador / (alicuota.denominador * 2n);
  return negativo ? -redondeado : redondeado;
}

/** El mismo cálculo, expuesto para quien necesita el importe y no el control. */
export function ivaSegunAlicuota(neto: Money, alicuota: AlicuotaRelevada): Money {
  return money(esperado(neto, alicuota), neto.currency);
}
