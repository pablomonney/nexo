/**
 * Crédito fiscal — y por qué este motor sigue sin decir que un crédito sea
 * computable, ahora que la ley está archivada.
 *
 * Es la decisión más incómoda del paquete y la más importante, y la que más fácil
 * se malinterpreta después de destrabar una fuente.
 *
 * Hasta hace poco la explicación era simple: la **Ley de Impuesto al Valor
 * Agregado (t.o. 1997)** no estaba en el archivo, así que el motor no podía
 * pronunciarse. Ya está archivada, con hash, y su art. 12 se lee entero. Sería
 * razonable esperar que ahora aparezca `COMPUTABLE`.
 *
 * No aparece, y el motivo es mejor que el anterior: **el art. 12 no condiciona el
 * cómputo a algo que esté en el comprobante**. Dice que solo dan lugar a crédito
 * las compras *"en la medida en que se vinculen con las operaciones gravadas"*.
 * La misma factura de nafta es crédito para la empresa de fletes y no lo es para
 * el auto del socio; el comprobante es idéntico en los dos casos. Archivar la ley
 * no trajo ese dato — trajo poder decir exactamente cuál es el dato que falta, y
 * quién lo tiene.
 *
 * ## Lo que la ley archivada sí agregó
 *
 * Un control que antes no se podía hacer: la **regla de tope** del art. 12 inc.
 * a), primer párrafo. El crédito se computa *"hasta el límite del importe que
 * surja de aplicar sobre los montos totales netos [...] la alícuota a la que
 * dichas operaciones hubieran estado sujetas"*. El motor no sabe cuál era la
 * alícuota aplicable, pero sabe cuál es la mayor vigente a esa fecha, y un IVA
 * que la supera no es crédito bajo ninguna lectura del artículo.
 *
 * Es poco, y es real: hasta que la ley entró al archivo, un comprobante con un
 * IVA imposible pasaba los controles de forma.
 *
 * ## Lo que se verifica y lo que no
 *
 * Se verifica la **forma**: que el comprobante exista en ARCA, que el emisor no
 * esté en la base de apócrifos, que el IVA esté discriminado, que la alícuota
 * cierre, que el IVA no exceda el tope. Son condiciones necesarias. Ninguna es
 * suficiente.
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
import {
  alicuotasVigentes,
  identificarAlicuota,
  ivaSegunAlicuota,
  verificarIvaDeclarado,
} from './alicuotas.js';

/**
 * Lo que falta para poder decidir de fondo. Se imprime, no se calla.
 *
 * Los tres primeros no se destraban archivando una norma: son hechos del negocio
 * y de la operación. Ponerlos en la misma lista que una fuente faltante sería
 * sugerir que algún día un script los va a resolver.
 */
const FALTA_RELEVAR = [
  'La vinculación con operaciones gravadas (art. 12, inc. a, segundo párrafo). No está en el comprobante: es un hecho del negocio, y lo afirma quien lo conoce.',
  'Las exclusiones del art. 12 inc. a) puntos 1, 3 y 4 — automóviles por encima del tope, ciertos servicios del art. 3° inc. e), indumentaria que no sea ropa de trabajo. Dependen de QUÉ se compró, no de cuánto.',
  'El prorrateo del art. 13 cuando conviven operaciones gravadas y exentas. Depende del total del período, no de este comprobante.',
  'Qué régimen de emisión alcanza al emisor. La RG 1415 (arts. 15 y 16) y la RG 4291 ya están archivadas y dicen qué letra corresponde a cada operación; lo que no está relevado es a qué régimen quedó sujeto cada contribuyente, que sale de su situación y no del comprobante.',
] as const;

export function evaluarCreditoFiscal(
  comprobante: ComprobanteIva,
  catalogo: readonly AlicuotaRelevada[],
): EvaluacionCreditoFiscal {
  const hallazgos: HallazgoIva[] = [
    ...controlarConstatacion(comprobante),
    ...controlarEmisor(comprobante),
    ...controlarRenglones(comprobante, catalogo),
    ...controlarTope(comprobante, catalogo),
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
      : 'Los controles de forma pasan y el IVA no excede el tope del art. 12. La computabilidad NO está determinada: el art. 12 la condiciona a la vinculación con operaciones gravadas, que es un hecho del negocio y no del comprobante. Lo decide el profesional.',
  };
}

/**
 * La regla de tope del art. 12 inc. a), primer párrafo.
 *
 * El artículo limita el crédito al importe que surge de aplicar sobre los netos
 * *"la alícuota a la que dichas operaciones hubieran estado sujetas en su
 * oportunidad"*. Cuál era esa alícuota depende de qué se compró, y el motor no lo
 * sabe. Lo que sí sabe es cuál es **la mayor vigente a la fecha del comprobante**:
 * un IVA por encima de ese techo no puede ser crédito bajo ninguna lectura.
 *
 * Se compara contra el techo más alto y no contra el 21% general a propósito. Usar
 * la general convertiría en hallazgo todo comprobante de servicios públicos al
 * 27%, que es exactamente el caso legítimo que el segundo párrafo contempla.
 *
 * El control no corre sin catálogo: sin alícuotas relevadas ya hay un hallazgo
 * `SIN_ALICUOTAS_RELEVADAS`, y agregarle un tope calculado sobre nada sería ruido.
 */
function controlarTope(
  comprobante: ComprobanteIva,
  catalogo: readonly AlicuotaRelevada[],
): HallazgoIva[] {
  if (comprobante.direccion !== 'COMPRAS') return [];

  const vigentes = alicuotasVigentes(catalogo, comprobante.fecha);
  if (vigentes.length === 0) return [];

  // Comparación por productos cruzados: 27/100 contra 21/200 sin dividir nunca.
  const mayor = vigentes.reduce((actual, candidata) =>
    candidata.numerador * actual.denominador > actual.numerador * candidata.denominador
      ? candidata
      : actual,
  );

  const moneda = comprobante.total.currency;
  const netoTotal = comprobante.renglones.reduce(
    (acc, renglon) => add(acc, renglon.neto),
    zero(moneda),
  );
  const ivaTotal = comprobante.renglones.reduce(
    (acc, renglon) => add(acc, renglon.iva),
    zero(moneda),
  );

  const tope = ivaSegunAlicuota(netoTotal, mayor);
  // El centavo es el mismo redondeo del emisor que se tolera en `identificarAlicuota`.
  if (ivaTotal.amount <= tope.amount + 1n) return [];

  return [
    {
      codigo: 'CREDITO_EXCEDE_EL_TOPE',
      mensaje: `El comprobante discrimina ${ivaTotal.amount} de IVA sobre un neto de ${netoTotal.amount}. La alícuota más alta vigente al ${comprobante.fecha} es ${mayor.etiqueta}, que da como máximo ${tope.amount}. El art. 12 inc. a) de la Ley de IVA limita el crédito a ese importe: el excedente no es computable por ninguna vía.`,
      bloquea: true,
    },
  ];
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
