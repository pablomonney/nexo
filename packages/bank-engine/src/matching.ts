/**
 * El motor de matching.
 *
 * Todo el archivo se apoya en una decisión: **el importe exacto es una
 * precondición, no un componente del puntaje.**
 *
 * La alternativa —darle mucho peso al importe y dejar que un match con $ 0,50 de
 * diferencia gane igual por fecha y referencia— es lo que hace casi todo el
 * software de conciliación, y es lo que produce el error caro: un pago de
 * $ 1.234.567,00 conciliado contra una factura de $ 1.234.567,50 cierra la
 * factura, deja los cincuenta centavos flotando, y el saldo del proveedor queda
 * mal para siempre.
 *
 * Una diferencia de importe no es un match peor. Es una partida conciliatoria, y
 * se muestra en el acta, que es donde el contador la va a ver.
 *
 * El puntaje sirve para **ordenar entre candidatos que ya coinciden en importe**,
 * y nada más.
 */

import type { CalendarDate } from '@aai/shared';
import type {
  Ambiguedad,
  LineaConciliable,
  MovimientoBancario,
  PropuestaMatch,
  SenalDeMatch,
} from './contracts.js';

export interface OpcionesMatching {
  /**
   * Ventana de días dentro de la que una fecha distinta sigue siendo plausible.
   *
   * Existe porque un pago se acredita cuando el banco quiere, no cuando se
   * emitió. Cinco días hábiles es lo habitual para un cheque; el default de 7
   * corridos lo cubre sin volverse laxo.
   */
  readonly ventanaDias?: number;
  /**
   * Tope de combinaciones al buscar agrupaciones.
   *
   * Buscar todos los subconjuntos de N movimientos es 2^N. Con un extracto de
   * 400 líneas eso no termina nunca, así que hay un tope — y cuando se alcanza,
   * el motor **lo dice** en vez de devolver "no encontré nada".
   */
  readonly maxCombinaciones?: number;
  /** Cuántos movimientos como máximo puede juntar una agrupación. */
  readonly maxAgrupados?: number;
}

const VENTANA_POR_DEFECTO = 7;
const MAX_COMBINACIONES = 20_000;
const MAX_AGRUPADOS = 4;

/**
 * Pesos del puntaje. Enteros, y suman 100 con el importe adentro.
 *
 * El importe vale 60 aunque sea precondición: el puntaje se muestra al contador
 * y un 40 sobre 40 se lee peor que un 100 sobre 100 para el mismo match.
 */
const PESOS = {
  importe: 60,
  mismaFecha: 20,
  fechaCercana: 12,
  referencia: 15,
  descripcion: 5,
} as const;

export interface ResultadoMatching {
  readonly propuestas: readonly PropuestaMatch[];
  readonly ambiguos: readonly Ambiguedad[];
  readonly movimientosSinCandidato: readonly string[];
  readonly lineasSinCandidato: readonly string[];
  /** `true` si la búsqueda de agrupaciones se cortó por el tope. */
  readonly busquedaIncompleta: boolean;
}

export function proponerMatches(
  movimientos: readonly MovimientoBancario[],
  lineas: readonly LineaConciliable[],
  opciones: OpcionesMatching = {},
): ResultadoMatching {
  const ventana = opciones.ventanaDias ?? VENTANA_POR_DEFECTO;
  const disponibles = lineas.filter((linea) => !linea.yaConciliada);

  const propuestas: PropuestaMatch[] = [];
  const ambiguos: Ambiguedad[] = [];
  const movimientosUsados = new Set<string>();
  const lineasUsadas = new Set<string>();

  // --- Primera pasada: uno a uno ------------------------------------------
  //
  // Se resuelve primero lo inequívoco. Buscar agrupaciones antes dejaría que un
  // conjunto de tres movimientos se lleve una línea que tenía su par exacto.
  for (const movimiento of movimientos) {
    const candidatos = disponibles
      .filter((linea) => !lineasUsadas.has(linea.entryLineId))
      .filter((linea) => compatible(movimiento, linea))
      .map((linea) => puntuar(movimiento, linea, ventana))
      .sort((a, b) => b.score - a.score);

    const mejor = candidatos[0];
    if (mejor === undefined) continue;

    const empatados = candidatos.filter((candidato) => candidato.score === mejor.score);
    if (empatados.length > 1) {
      // No se elige. Dos líneas que puntúan igual contra el mismo movimiento son
      // dos respuestas posibles, y quedarse con la primera del array es el orden
      // de la consulta SQL decidiendo una imputación contable.
      ambiguos.push({
        movimientoId: movimiento.id,
        candidatos: empatados,
        motivo: `${empatados.length} líneas contables puntúan ${mejor.score} contra este movimiento. El motor no desempata: las diferencias entre ellas no están en los datos.`,
      });
      movimientosUsados.add(movimiento.id);
      continue;
    }

    propuestas.push(mejor);
    movimientosUsados.add(movimiento.id);
    for (const id of mejor.entryLineIds) lineasUsadas.add(id);
  }

  // --- Segunda pasada: agrupaciones ---------------------------------------
  //
  // El caso real: un depósito de cuatro cheques entra al banco como un solo
  // crédito y en el libro son cuatro cobranzas. Sin esto, quedan cinco partidas
  // conciliatorias que en realidad son una sola operación.
  const sobrantesMovimiento = movimientos.filter(
    (movimiento) => !movimientosUsados.has(movimiento.id),
  );
  const sobrantesLinea = disponibles.filter((linea) => !lineasUsadas.has(linea.entryLineId));

  const agrupacion = buscarAgrupaciones(sobrantesMovimiento, sobrantesLinea, {
    ventana,
    maxCombinaciones: opciones.maxCombinaciones ?? MAX_COMBINACIONES,
    maxAgrupados: opciones.maxAgrupados ?? MAX_AGRUPADOS,
  });

  for (const propuesta of agrupacion.propuestas) {
    propuestas.push(propuesta);
    for (const id of propuesta.movimientoIds) movimientosUsados.add(id);
    for (const id of propuesta.entryLineIds) lineasUsadas.add(id);
  }

  return {
    propuestas,
    ambiguos,
    movimientosSinCandidato: movimientos
      .filter((movimiento) => !movimientosUsados.has(movimiento.id))
      .map((movimiento) => movimiento.id),
    lineasSinCandidato: disponibles
      .filter((linea) => !lineasUsadas.has(linea.entryLineId))
      .map((linea) => linea.entryLineId),
    busquedaIncompleta: agrupacion.incompleta,
  };
}

/**
 * Precondición: mismo importe, mismo sentido.
 *
 * El sentido importa tanto como el importe. Una salida de $ 100.000 y una entrada
 * de $ 100.000 tienen el mismo número y son operaciones opuestas; sin este
 * control, un pago y una cobranza del mismo monto se conciliarían entre sí — y
 * los saldos cerrarían igual.
 */
function compatible(movimiento: MovimientoBancario, linea: LineaConciliable): boolean {
  return (
    movimiento.sentido === linea.sentido &&
    movimiento.importe.currency === linea.importe.currency &&
    movimiento.importe.amount === linea.importe.amount
  );
}

function puntuar(
  movimiento: MovimientoBancario,
  linea: LineaConciliable,
  ventana: number,
): PropuestaMatch {
  const senales: SenalDeMatch[] = [
    {
      codigo: 'IMPORTE_EXACTO',
      aporte: PESOS.importe,
      detalle: `Importe idéntico: ${movimiento.importe.amount} en unidades menores`,
    },
  ];

  const distancia = distanciaEnDias(movimiento.fecha, linea.fecha);
  if (distancia === 0) {
    senales.push({ codigo: 'MISMA_FECHA', aporte: PESOS.mismaFecha, detalle: 'Misma fecha' });
  } else if (distancia <= ventana) {
    // El aporte decae con la distancia, en enteros: a más días, menos puntos.
    const aporte = Math.max(1, Math.round((PESOS.fechaCercana * (ventana - distancia)) / ventana));
    senales.push({
      codigo: 'FECHA_CERCANA',
      aporte,
      detalle: `${distancia} día(s) de diferencia, dentro de la ventana de ${ventana}`,
    });
  } else {
    senales.push({
      codigo: 'FECHA_LEJANA',
      aporte: 0,
      detalle: `${distancia} día(s) de diferencia, fuera de la ventana de ${ventana}. Coincide el importe, pero la fecha no acompaña.`,
    });
  }

  if (movimiento.referencia !== null && linea.referencia !== null) {
    const coincide = normalizarReferencia(movimiento.referencia) === normalizarReferencia(linea.referencia);
    senales.push({
      codigo: coincide ? 'REFERENCIA_COINCIDE' : 'REFERENCIA_AUSENTE',
      aporte: coincide ? PESOS.referencia : 0,
      detalle: coincide
        ? `Referencia ${movimiento.referencia}`
        : `El banco dice ${movimiento.referencia} y el libro ${linea.referencia}`,
    });
  } else {
    senales.push({
      codigo: 'REFERENCIA_AUSENTE',
      aporte: 0,
      detalle: 'Falta la referencia de un lado o del otro',
    });
  }

  const palabras = palabrasEnComun(movimiento.descripcion, linea.descripcion);
  senales.push(
    palabras > 0
      ? {
          codigo: 'DESCRIPCION_COINCIDE',
          aporte: PESOS.descripcion,
          detalle: `${palabras} palabra(s) significativas en común`,
        }
      : {
          codigo: 'DESCRIPCION_DISTINTA',
          aporte: 0,
          detalle: 'Las descripciones no comparten palabras significativas',
        },
  );

  const score = senales.reduce((acc, senal) => acc + senal.aporte, 0);

  return {
    tipo: distancia === 0 ? 'EXACTO' : 'APROXIMADO',
    movimientoIds: [movimiento.id],
    entryLineIds: [linea.entryLineId],
    score,
    senales,
    importe: movimiento.importe,
  };
}

interface OpcionesAgrupacion {
  readonly ventana: number;
  readonly maxCombinaciones: number;
  readonly maxAgrupados: number;
}

/**
 * Busca N movimientos cuya suma iguale una línea, y N líneas que sumen un
 * movimiento.
 *
 * La búsqueda está acotada de dos maneras: por cantidad de elementos agrupados y
 * por combinaciones evaluadas. Cuando el tope se alcanza, `incompleta` viene en
 * `true` y el acta lo dice. Un motor que se queda sin presupuesto y devuelve
 * "no hay agrupaciones" hace creer que las buscó todas.
 */
function buscarAgrupaciones(
  movimientos: readonly MovimientoBancario[],
  lineas: readonly LineaConciliable[],
  opciones: OpcionesAgrupacion,
): { propuestas: PropuestaMatch[]; incompleta: boolean } {
  const propuestas: PropuestaMatch[] = [];
  let presupuesto = opciones.maxCombinaciones;
  const movimientosUsados = new Set<string>();
  const lineasUsadas = new Set<string>();

  // N movimientos → 1 línea.
  for (const linea of lineas) {
    if (presupuesto <= 0) break;
    if (lineasUsadas.has(linea.entryLineId)) continue;

    const candidatos = movimientos.filter(
      (movimiento) =>
        !movimientosUsados.has(movimiento.id) &&
        movimiento.sentido === linea.sentido &&
        movimiento.importe.currency === linea.importe.currency &&
        dentroDeVentana(movimiento.fecha, linea.fecha, opciones.ventana),
    );

    const encontrado = subconjuntoQueSuma(
      candidatos.map((movimiento) => movimiento.importe.amount),
      linea.importe.amount,
      opciones.maxAgrupados,
      () => (presupuesto -= 1) > 0,
    );
    if (encontrado === null) continue;

    const elegidos = encontrado.map((indice) => candidatos[indice]!);
    for (const movimiento of elegidos) movimientosUsados.add(movimiento.id);
    lineasUsadas.add(linea.entryLineId);

    propuestas.push({
      tipo: 'AGRUPADO',
      movimientoIds: elegidos.map((movimiento) => movimiento.id),
      entryLineIds: [linea.entryLineId],
      // Una agrupación nunca llega al puntaje de un match uno a uno. Es correcta
      // más veces de las que uno esperaría y equivocada de formas que no se ven:
      // tres importes que casualmente suman el cuarto no son la misma operación.
      score: PESOS.importe + PESOS.mismaFecha,
      senales: [
        {
          codigo: 'AGRUPACION',
          aporte: PESOS.importe + PESOS.mismaFecha,
          detalle: `${elegidos.length} movimientos del banco suman exactamente esta línea del libro. Revisá que sean la misma operación: tres importes que suman un cuarto pueden ser coincidencia.`,
        },
      ],
      importe: linea.importe,
    });
  }

  // 1 movimiento → N líneas. El caso del pago de varias facturas en una
  // transferencia.
  for (const movimiento of movimientos) {
    if (presupuesto <= 0) break;
    if (movimientosUsados.has(movimiento.id)) continue;

    const candidatos = lineas.filter(
      (linea) =>
        !lineasUsadas.has(linea.entryLineId) &&
        linea.sentido === movimiento.sentido &&
        linea.importe.currency === movimiento.importe.currency &&
        dentroDeVentana(linea.fecha, movimiento.fecha, opciones.ventana),
    );

    const encontrado = subconjuntoQueSuma(
      candidatos.map((linea) => linea.importe.amount),
      movimiento.importe.amount,
      opciones.maxAgrupados,
      () => (presupuesto -= 1) > 0,
    );
    if (encontrado === null) continue;

    const elegidas = encontrado.map((indice) => candidatos[indice]!);
    movimientosUsados.add(movimiento.id);
    for (const linea of elegidas) lineasUsadas.add(linea.entryLineId);

    propuestas.push({
      tipo: 'AGRUPADO',
      movimientoIds: [movimiento.id],
      entryLineIds: elegidas.map((linea) => linea.entryLineId),
      score: PESOS.importe + PESOS.mismaFecha,
      senales: [
        {
          codigo: 'AGRUPACION',
          aporte: PESOS.importe + PESOS.mismaFecha,
          detalle: `Este movimiento del banco iguala la suma de ${elegidas.length} líneas del libro.`,
        },
      ],
      importe: movimiento.importe,
    });
  }

  return { propuestas, incompleta: presupuesto <= 0 };
}

/**
 * Subconjunto de tamaño ≥ 2 cuya suma da el objetivo.
 *
 * Búsqueda en profundidad con poda, sobre `bigint`. Devuelve índices y no
 * importes porque dos movimientos pueden tener el mismo importe y hay que saber
 * cuál se usó.
 *
 * `gastar()` descuenta del presupuesto global y devuelve `false` cuando se
 * acabó: la recursión corta y el llamador se entera.
 */
function subconjuntoQueSuma(
  importes: readonly bigint[],
  objetivo: bigint,
  maximo: number,
  gastar: () => boolean,
): number[] | null {
  const elegidos: number[] = [];

  function buscar(desde: number, restante: bigint): boolean {
    if (restante === 0n && elegidos.length >= 2) return true;
    if (restante <= 0n || elegidos.length >= maximo) return false;

    for (let i = desde; i < importes.length; i += 1) {
      if (!gastar()) return false;
      const importe = importes[i];
      if (importe === undefined || importe > restante) continue;
      elegidos.push(i);
      if (buscar(i + 1, restante - importe)) return true;
      elegidos.pop();
    }
    return false;
  }

  return buscar(0, objetivo) ? [...elegidos] : null;
}

// ---------------------------------------------------------------------------
// Utilidades de comparación
// ---------------------------------------------------------------------------

/**
 * Días entre dos fechas.
 *
 * Se calcula sobre `Date.UTC` a partir de los componentes de la `CalendarDate`,
 * nunca parseando la cadena con `new Date(iso)`: eso la interpreta como UTC en
 * unos motores y como local en otros, y una diferencia de un día en la ventana
 * cambia qué se propone.
 */
export function distanciaEnDias(a: CalendarDate, b: CalendarDate): number {
  const MS_POR_DIA = 86_400_000;
  const diferencia = Math.abs(aUtc(a) - aUtc(b));
  return Math.round(diferencia / MS_POR_DIA);
}

function aUtc(fecha: CalendarDate): number {
  const anio = Number(fecha.slice(0, 4));
  const mes = Number(fecha.slice(5, 7));
  const dia = Number(fecha.slice(8, 10));
  return Date.UTC(anio, mes - 1, dia);
}

function dentroDeVentana(a: CalendarDate, b: CalendarDate, ventana: number): boolean {
  return distanciaEnDias(a, b) <= ventana;
}

/**
 * Normaliza una referencia para compararla.
 *
 * Los bancos imprimen el mismo número de cheque como `0000012345`, `12345` y
 * `CHQ 12.345`. Se comparan solo los dígitos, y se descartan los ceros a la
 * izquierda. Si no quedan dígitos, se compara el texto en mayúsculas.
 */
export function normalizarReferencia(referencia: string): string {
  const digitos = referencia.replace(/\D/gu, '').replace(/^0+/u, '');
  return digitos === '' ? referencia.trim().toUpperCase() : digitos;
}

/**
 * Palabras significativas en común entre dos descripciones.
 *
 * Se descartan las de tres letras o menos y una lista corta de palabras que
 * aparecen en casi todo extracto bancario. Sin ese filtro, "PAGO" y
 * "TRANSFERENCIA" harían coincidir cualquier cosa con cualquier cosa, y el
 * aporte de la descripción dejaría de discriminar.
 */
const RUIDO = new Set([
  'PAGO',
  'PAGOS',
  'COBRO',
  'TRANSFERENCIA',
  'TRANSF',
  'DEPOSITO',
  'DEBITO',
  'CREDITO',
  'CUENTA',
  'BANCO',
  'VARIOS',
  'OPERACION',
]);

export function palabrasEnComun(a: string, b: string): number {
  const izquierda = significativas(a);
  const derecha = significativas(b);
  let comunes = 0;
  for (const palabra of izquierda) {
    if (derecha.has(palabra)) comunes += 1;
  }
  return comunes;
}

function significativas(texto: string): Set<string> {
  const palabras = texto
    .toUpperCase()
    .normalize('NFD')
    .replace(/\p{Diacritic}/gu, '')
    .split(/[^A-Z0-9]+/u)
    .filter((palabra) => palabra.length > 3 && !RUIDO.has(palabra));
  return new Set(palabras);
}
