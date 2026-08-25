/**
 * Crédito fiscal — y por qué este motor no dice que un crédito sea computable.
 *
 * Es la decisión más incómoda del paquete y la más importante.
 *
 * La computabilidad del crédito fiscal la deciden los arts. 12 y 13 de la Ley
 * 23.349: vinculación con operaciones gravadas, regla de tope, prorrateo de
 * actividades mixtas, exclusiones por tipo de bien. **Esa ley no está archivada
 * en este repositorio.** Un motor que devolviera `COMPUTABLE` estaría afirmando
 * algo que no verificó, con la agravante de que el usuario no tendría cómo
 * notarlo: la respuesta se vería igual que si sí lo hubiera verificado.
 *
 * Lo que sí se puede verificar, y se verifica, es la **forma**: que el
 * comprobante exista en ARCA, que el emisor no esté en la base de apócrifos, que
 * el IVA esté discriminado, que la alícuota cierre. Son condiciones necesarias.
 * Ninguna es suficiente.
 *
 * Por eso los estados son `NO_DETERMINABLE`, `IMPEDIDO_POR_FORMA` y
 * `FUENTE_NO_ENCONTRADA`. La ausencia de `COMPUTABLE` es el mensaje.
 *
 * Es el §11 aplicado: **validación fiscal ≠ validación contable ≠ validación
 * económica**. Que la factura exista en ARCA no dice nada sobre si el gasto es
 * del giro, y confundir las dos cosas es cómo un sistema termina computando el
 * IVA del asado del domingo.
 */

import type { Money } from '@aai/shared';
import { add, zero } from '@aai/shared';
import type {
  AlicuotaRelevada,
  ComprobanteIva,
  EvaluacionCreditoFiscal,
  HallazgoIva,
} from './contracts.js';
import { identificarAlicuota, verificarIvaDeclarado } from './alicuotas.js';

/** Lo que falta relevar para poder decidir de fondo. Se imprime, no se calla. */
const FALTA_RELEVAR = [
  'Ley 23.349 (IVA), arts. 12 y 13 — requisitos del crédito fiscal, regla de tope y prorrateo',
  'Ley 23.349, art. 28 — alícuotas y sus reducciones',
  'RG 1415 y RG 4291 — qué tipos de comprobante habilitan crédito fiscal',
] as const;

export function evaluarCreditoFiscal(
  comprobante: ComprobanteIva,
  catalogo: readonly AlicuotaRelevada[],
): EvaluacionCreditoFiscal {
  const hallazgos: HallazgoIva[] = [
    ...controlarConstatacion(comprobante),
    ...controlarEmisor(comprobante),
    ...controlarRenglones(comprobante, catalogo),
    ...controlarTotal(comprobante),
  ];

  const ivaDiscriminado = comprobante.renglones.reduce(
    (acc, renglon) => add(acc, renglon.iva),
    zero(comprobante.total.currency),
  );

  const bloqueado = hallazgos.some((hallazgo) => hallazgo.bloquea);

  return {
    comprobanteId: comprobante.id,
    estado: bloqueado ? 'IMPEDIDO_POR_FORMA' : 'NO_DETERMINABLE',
    hallazgos,
    ivaDiscriminado,
    faltaRelevar: FALTA_RELEVAR,
    mensaje: bloqueado
      ? 'El comprobante no cumple los controles de forma. No se puede llegar a la cuestión de fondo: primero hay que resolver esto.'
      : 'Los controles de forma pasan. La computabilidad del crédito NO está determinada: depende de la Ley 23.349, que no está relevada. Lo decide el profesional.',
  };
}

/**
 * La constatación en ARCA.
 *
 * `NO_CONSULTADO` y `FAIL` no son lo mismo y se informan distinto. Un
 * comprobante que ARCA rechaza es un problema del comprobante; uno que nunca se
 * consultó es un problema del sistema, y tratarlos igual haría que un corte de
 * servicio de ARCA se vea como una factura apócrifa.
 */
function controlarConstatacion(comprobante: ComprobanteIva): HallazgoIva[] {
  switch (comprobante.constatacion) {
    case 'OK':
      return [];
    case 'NO_CONSULTADO':
      return [
        {
          codigo: 'CONSTATACION_NO_CONSULTADA',
          mensaje:
            'El comprobante no se constató contra ARCA. No consultado no es lo mismo que no válido: falta el dato.',
          bloquea: true,
        },
      ];
    case 'NO_VERIFICABLE':
      return [
        {
          codigo: 'CONSTATACION_NO_CONSULTADA',
          mensaje:
            'La constatación no se pudo completar (servicio no disponible o comprobante fuera del alcance del WSCDC). Reintentar antes de decidir.',
          bloquea: true,
        },
      ];
    default:
      return [
        {
          codigo: 'CONSTATACION_NO_OK',
          mensaje: `ARCA respondió ${comprobante.constatacion} para el comprobante ${comprobante.tipoComprobante}-${comprobante.puntoVenta}-${comprobante.numero}.`,
          bloquea: true,
        },
      ];
  }
}

function controlarEmisor(comprobante: ComprobanteIva): HallazgoIva[] {
  const hallazgos: HallazgoIva[] = [];

  if (comprobante.emisorApocrifo === true) {
    hallazgos.push({
      codigo: 'EMISOR_APOCRIFO',
      mensaje: `El CUIT ${comprobante.cuitContraparte ?? '(sin dato)'} figura en la base de facturas apócrifas de ARCA.`,
      bloquea: true,
    });
  } else if (comprobante.emisorApocrifo === null) {
    // No bloquea: bloquear cada compra porque el padrón no respondió pararía el
    // estudio entero. Pero queda dicho, porque "no se pudo consultar" no es
    // "está todo bien".
    hallazgos.push({
      codigo: 'EMISOR_SIN_VERIFICAR',
      mensaje:
        'No se pudo verificar si el emisor está en la base de apócrifos. El dato falta; no se asume que esté limpio.',
      bloquea: false,
    });
  }

  if (comprobante.direccion === 'COMPRAS' && comprobante.condicionContraparte === 'DESCONOCIDA') {
    hallazgos.push({
      codigo: 'CONDICION_CONTRAPARTE_DESCONOCIDA',
      mensaje:
        'No se conoce la condición del emisor frente al IVA. Sin eso no se puede saber si el comprobante podía discriminar el impuesto.',
      bloquea: false,
    });
  }

  return hallazgos;
}

function controlarRenglones(
  comprobante: ComprobanteIva,
  catalogo: readonly AlicuotaRelevada[],
): HallazgoIva[] {
  const hallazgos: HallazgoIva[] = [];

  comprobante.renglones.forEach((renglon, indice) => {
    // Un renglón íntegramente exento o no gravado no lleva IVA y no necesita
    // alícuota. Exigirle una convertiría cada compra exenta en un hallazgo.
    if (renglon.neto.amount === 0n && renglon.iva.amount === 0n) return;

    if (renglon.neto.amount !== 0n && renglon.iva.amount === 0n) {
      hallazgos.push({
        codigo: 'IVA_NO_DISCRIMINADO',
        mensaje: `El renglón ${indice + 1} tiene neto ${renglon.neto.amount} y no discrimina IVA. Un comprobante sin IVA discriminado no genera crédito fiscal.`,
        bloquea: true,
        renglon: indice + 1,
      });
      return;
    }

    const declarada =
      renglon.alicuotaId === null
        ? null
        : (catalogo.find((alicuota) => alicuota.id === renglon.alicuotaId) ?? null);

    if (declarada !== null) {
      for (const hallazgo of verificarIvaDeclarado(renglon.neto, renglon.iva, declarada)) {
        hallazgos.push({ ...hallazgo, renglon: indice + 1 });
      }
      return;
    }

    const identificada = identificarAlicuota(
      renglon.neto,
      renglon.iva,
      catalogo,
      comprobante.fecha,
    );
    for (const hallazgo of identificada.hallazgos) {
      hallazgos.push({ ...hallazgo, renglon: indice + 1 });
    }
  });

  return hallazgos;
}

/**
 * El total declarado tiene que ser la suma de sus partes.
 *
 * Sin tolerancia, igual que en el motor documental: los importes vienen del
 * comprobante ya redondeados por el emisor, así que la suma tiene que dar
 * exacta. Un peso de diferencia significa que hay un concepto que el sistema no
 * está leyendo — una percepción, un impuesto interno—, y aceptarlo lo haría
 * desaparecer del subdiario.
 */
function controlarTotal(comprobante: ComprobanteIva): HallazgoIva[] {
  let suma: Money = zero(comprobante.total.currency);
  for (const renglon of comprobante.renglones) {
    suma = add(add(add(add(suma, renglon.neto), renglon.iva), renglon.noGravado), renglon.exento);
  }
  suma = add(suma, comprobante.percepciones);

  if (suma.amount === comprobante.total.amount) return [];

  return [
    {
      codigo: 'TOTAL_NO_CIERRA',
      mensaje: `El comprobante declara un total de ${comprobante.total.amount} y sus conceptos suman ${suma.amount} (unidades menores). Diferencia: ${comprobante.total.amount - suma.amount}. Hay un concepto que el sistema no está leyendo.`,
      bloquea: true,
    },
  ];
}
