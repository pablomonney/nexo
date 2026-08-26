/**
 * Construcción del estado contable.
 *
 * ## Los dos controles que sostienen la fase
 *
 * **`CUENTA_SIN_RUBRO`.** Si el plan tiene una cuenta que ningún selector
 * captura, su saldo desaparece del estado. A veces el estado igual cierra —
 * cuando dos cuentas huérfanas se compensan— y entonces nadie lo nota nunca. Es
 * el modo de falla propio de los estados contables armados con plantilla, y por
 * eso este control **bloquea la emisión**.
 *
 * **`CUENTA_EN_DOS_RUBROS`.** Lo contrario: un selector demasiado ancho hace que
 * una cuenta sume dos veces. El activo queda inflado y la ecuación patrimonial
 * no cierra — o cierra, si el mismo error se repite del otro lado.
 *
 * Los dos son la razón por la que este archivo recorre las cuentas y no solo la
 * plantilla. Una construcción que solo mira la plantilla produce un estado
 * bonito sobre un plan de cuentas que no conoce.
 *
 * ## Por qué un estado que no cierra no se emite
 *
 * El Libro Diario se emite igual con sus observaciones: es el registro de lo que
 * pasó, y un libro con un hueco existe y hay que poder verlo para arreglarlo. Un
 * estado contable es otra cosa: es una **afirmación sobre la situación
 * patrimonial**, y una afirmación que no cierra es falsa. Se muestra, para poder
 * corregirla, pero `emisible` es `false`.
 */

import type { Currency, Money } from '@aai/shared';
import { add, money, negate, zero } from '@aai/shared';
import type {
  ControlDeEstado,
  EstadoContable,
  OrigenDelRenglon,
  PlantillaEstado,
  RenglonEmitido,
  SaldoDeCuenta,
  SelectorDeCuentas,
} from './contracts.js';
import { aplanar, validarPlantilla } from './template.js';

export interface DatosDelEstado {
  readonly companyId: string;
  readonly moneda: Currency;
  readonly fechaCierre: EstadoContable['fechaCierre'];
  readonly saldos: readonly SaldoDeCuenta[];
  /** Saldos del ejercicio anterior, para la columna comparativa. */
  readonly saldosComparativos?: readonly SaldoDeCuenta[];
  readonly fechaCierreComparativo?: EstadoContable['fechaCierre'];
  /**
   * Códigos de nodo que forman la ecuación patrimonial, si la plantilla la
   * declara. Sin ellos el control no corre y **se dice** que no corrió.
   */
  readonly ecuacion?: {
    readonly activo: string;
    readonly pasivo: string;
    readonly patrimonioNeto: string;
  };
}

export function construirEstado(
  plantilla: PlantillaEstado,
  datos: DatosDelEstado,
): EstadoContable {
  const erroresPlantilla = validarPlantilla(plantilla);
  if (erroresPlantilla.length > 0) {
    return {
      plantillaId: plantilla.id,
      tipo: plantilla.tipo,
      marco: plantilla.marco,
      companyId: datos.companyId,
      fechaCierre: datos.fechaCierre,
      fechaCierreComparativo: datos.fechaCierreComparativo ?? null,
      moneda: datos.moneda,
      renglones: [],
      controles: erroresPlantilla.map((error) => ({
        codigo: 'TOTAL_REFERENCIA_INEXISTENTE' as const,
        cumple: false,
        detalle: `${error.codigo}: ${error.mensaje}`,
        involucrados: [error.nodo],
      })),
      emisible: false,
      motivo:
        'La plantilla no es válida. No se construyó ningún renglón: un estado armado sobre una plantilla rota se vería normal y estaría mal.',
    };
  }

  const actual = calcular(plantilla, datos.saldos, datos.moneda);
  const comparativo =
    datos.saldosComparativos === undefined
      ? null
      : calcular(plantilla, datos.saldosComparativos, datos.moneda);

  const renglones: RenglonEmitido[] = aplanar(plantilla).map(({ nodo, nivel }) => ({
    codigo: nodo.codigo,
    etiqueta: nodo.etiqueta,
    tipo: nodo.tipo,
    nivel,
    importe: actual.importes.get(nodo.codigo) ?? zero(datos.moneda),
    comparativo: comparativo === null ? null : (comparativo.importes.get(nodo.codigo) ?? zero(datos.moneda)),
    origen: actual.origenes.get(nodo.codigo) ?? [],
    nota: nodo.nota ?? null,
    fundamento: nodo.fundamento ?? null,
  }));

  // La cobertura se controla sobre las DOS columnas. Un comparativo armado sobre
  // un plan de cuentas que la plantilla no cubre tiene el mismo problema que el
  // ejercicio actual, y se ve igual de poco: la columna de la izquierda con un
  // total que no explica sus renglones.
  const controles = [
    ...controlarCobertura(
      [
        { calculo: actual, saldos: datos.saldos, columna: 'ejercicio' },
        ...(comparativo === null || datos.saldosComparativos === undefined
          ? []
          : [{ calculo: comparativo, saldos: datos.saldosComparativos, columna: 'comparativo' }]),
      ],
    ),
    ...controlarEcuacion(actual.importes, datos),
  ];

  const falla = controles.filter((control) => !control.cumple);

  return {
    plantillaId: plantilla.id,
    tipo: plantilla.tipo,
    marco: plantilla.marco,
    companyId: datos.companyId,
    fechaCierre: datos.fechaCierre,
    fechaCierreComparativo: datos.fechaCierreComparativo ?? null,
    moneda: datos.moneda,
    renglones: renglones.filter(
      (renglon) => !ocultar(plantilla, renglon.codigo, renglon.importe, renglon.comparativo),
    ),
    controles,
    emisible: falla.length === 0,
    motivo:
      falla.length === 0
        ? 'Todos los controles pasan.'
        : `${falla.length} control(es) no pasan: ${falla.map((control) => control.codigo).join(', ')}. Un estado contable que no cierra no se emite: es una afirmación sobre la situación patrimonial, no un registro de lo que pasó.`,
  };
}

interface Calculo {
  readonly importes: Map<string, Money>;
  readonly origenes: Map<string, OrigenDelRenglon[]>;
  /** Cuántos renglones capturaron cada cuenta. Sirve para los dos controles. */
  readonly veces: Map<string, string[]>;
}

function calcular(
  plantilla: PlantillaEstado,
  saldos: readonly SaldoDeCuenta[],
  moneda: Currency,
): Calculo {
  const importes = new Map<string, Money>();
  const origenes = new Map<string, OrigenDelRenglon[]>();
  const veces = new Map<string, string[]>();

  // Solo las cuentas imputables entran. Una cuenta de agrupación tiene el saldo
  // de sus hijas: sumarla además las contaría dos veces, y el error se vería
  // exactamente igual que un selector demasiado ancho.
  const cuentas = saldos.filter((saldo) => saldo.imputable);

  // --- 1. Renglones: cada uno toma sus cuentas ----------------------------
  for (const { nodo } of aplanar(plantilla)) {
    if (nodo.tipo !== 'RENGLON' || nodo.selector === undefined) continue;

    const capturadas = cuentas.filter((cuenta) => captura(nodo.selector!, cuenta));
    const origen: OrigenDelRenglon[] = [];
    let total = zero(moneda);

    for (const cuenta of capturadas) {
      const aporte = nodo.presentacion === 'INVERTIDO' ? negate(cuenta.saldo) : cuenta.saldo;
      total = add(total, aporte);
      origen.push({ accountId: cuenta.accountId, codigo: cuenta.codigo, aporte });

      const previos = veces.get(cuenta.accountId);
      if (previos === undefined) veces.set(cuenta.accountId, [nodo.codigo]);
      else previos.push(nodo.codigo);
    }

    importes.set(nodo.codigo, total);
    origenes.set(nodo.codigo, origen);
  }

  // --- 2. Rubros: de abajo hacia arriba -----------------------------------
  //
  // Se recorre en orden inverso al de presentación para que los hijos ya estén
  // calculados cuando se llega al padre. Es lo mismo que hace una hoja de
  // cálculo, sin necesitar un grafo de dependencias.
  const nodos = aplanar(plantilla);
  for (let i = nodos.length - 1; i >= 0; i -= 1) {
    const nodo = nodos[i]?.nodo;
    if (nodo === undefined || nodo.tipo !== 'RUBRO') continue;

    let total = zero(moneda);
    const origen: OrigenDelRenglon[] = [];
    for (const hijo of nodo.hijos ?? []) {
      total = add(total, importes.get(hijo.codigo) ?? zero(moneda));
      origen.push(...(origenes.get(hijo.codigo) ?? []));
    }
    importes.set(nodo.codigo, total);
    // El origen de un rubro es la unión del de sus hijos: así, hacer clic en
    // "Total del activo corriente" llega a las cuentas, no a otro subtotal.
    origenes.set(nodo.codigo, origen);
  }

  // --- 3. Totales: pueden referenciar cualquier nodo ----------------------
  //
  // Se resuelven al final y en varias pasadas, porque un total puede sumar otro
  // total. El validador ya garantizó que no hay ciclos, así que el punto fijo
  // se alcanza; el tope de iteraciones es la red por si esa garantía fallara.
  const totales = nodos.filter((entrada) => entrada.nodo.tipo === 'TOTAL');
  for (let pasada = 0; pasada < totales.length + 1; pasada += 1) {
    let cambio = false;
    for (const { nodo } of totales) {
      let total = zero(moneda);
      const origen: OrigenDelRenglon[] = [];
      for (const referencia of nodo.suma ?? []) {
        total = add(total, importes.get(referencia) ?? zero(moneda));
        origen.push(...(origenes.get(referencia) ?? []));
      }
      const previo = importes.get(nodo.codigo);
      if (previo === undefined || previo.amount !== total.amount) cambio = true;
      importes.set(nodo.codigo, total);
      origenes.set(nodo.codigo, origen);
    }
    if (!cambio) break;
  }

  return { importes, origenes, veces };
}

function captura(selector: SelectorDeCuentas, cuenta: SaldoDeCuenta): boolean {
  if (selector.excluir?.includes(cuenta.codigo) === true) return false;
  if (selector.codigos?.includes(cuenta.codigo) === true) return true;

  // `codigos` es una vía ALTERNATIVA, no un criterio más que se combine con los
  // otros. Si un selector solo enumera códigos, las cuentas que no están en esa
  // lista no entran — aunque `tipos` y `prefijos` estén ausentes.
  //
  // Sin esta línea, `{ codigos: ['1.2.01'] }` captura TODO el plan: los dos
  // criterios restantes son "no declarado, así que no filtra", y su conjunción es
  // verdadera para cualquier cuenta. El renglón se ve razonable, suma de más, y
  // el error aparece como una cuenta en dos rubros — si es que hay otro renglón
  // que la reclame. Lo encontró un test, no una lectura del código.
  if (selector.tipos === undefined && selector.prefijos === undefined) return false;

  const porTipo = selector.tipos === undefined || selector.tipos.includes(cuenta.tipo);
  const porPrefijo =
    selector.prefijos === undefined ||
    selector.prefijos.some((prefijo) => cuenta.codigo.startsWith(prefijo));

  return porTipo && porPrefijo;
}

// ---------------------------------------------------------------------------
// Controles
// ---------------------------------------------------------------------------

interface ColumnaAControlar {
  readonly calculo: Calculo;
  readonly saldos: readonly SaldoDeCuenta[];
  readonly columna: string;
}

function controlarCobertura(columnas: readonly ColumnaAControlar[]): ControlDeEstado[] {
  const huerfanas: { codigo: string; columna: string }[] = [];
  const duplicadas: { codigo: string; columna: string; en: readonly string[] }[] = [];

  for (const { calculo, saldos, columna } of columnas) {
    for (const cuenta of saldos.filter((saldo) => saldo.imputable)) {
      const renglones = calculo.veces.get(cuenta.accountId);
      if (renglones === undefined) huerfanas.push({ codigo: cuenta.codigo, columna });
      else if (renglones.length > 1) {
        duplicadas.push({ codigo: cuenta.codigo, columna, en: renglones });
      }
    }
  }

  return [
    {
      codigo: 'CUENTA_SIN_RUBRO',
      cumple: huerfanas.length === 0,
      detalle:
        huerfanas.length === 0
          ? 'Todas las cuentas imputables del plan caen en algún renglón'
          : `${huerfanas.length} cuenta(s) del plan no las captura ningún renglón: su saldo desaparece del estado. A veces el estado igual cierra —cuando dos huérfanas se compensan— y entonces nadie lo nota. Falta un renglón en la plantilla, o la cuenta está mal codificada. Columnas afectadas: ${[...new Set(huerfanas.map((cuenta) => cuenta.columna))].join(', ')}.`,
      involucrados: huerfanas.map((cuenta) => cuenta.codigo),
    },
    {
      codigo: 'CUENTA_EN_DOS_RUBROS',
      cumple: duplicadas.length === 0,
      detalle:
        duplicadas.length === 0
          ? 'Ninguna cuenta suma en más de un renglón'
          : `${duplicadas.length} cuenta(s) suman en más de un renglón: ${duplicadas
              .map((cuenta) => `${cuenta.codigo} (${cuenta.en.join(', ')})`)
              .join('; ')}. Hay un selector demasiado ancho.`,
      involucrados: duplicadas.map((cuenta) => cuenta.codigo),
    },
  ];
}

/**
 * La ecuación patrimonial: Activo = Pasivo + Patrimonio Neto.
 *
 * Cuando la plantilla no declara qué nodos la componen, el control **no corre y
 * lo dice**. Un estado que informa "ecuación verificada" sin haberla verificado
 * es peor que uno que no la verifica: el primero miente, el segundo avisa.
 */
function controlarEcuacion(
  importes: Map<string, Money>,
  datos: DatosDelEstado,
): ControlDeEstado[] {
  if (datos.ecuacion === undefined) {
    return [
      {
        codigo: 'ECUACION_PATRIMONIAL',
        cumple: true,
        detalle:
          'La plantilla no declara qué nodos forman la ecuación patrimonial, así que no se verificó. No se verificó no es lo mismo que se verificó y da bien.',
        involucrados: [],
      },
    ];
  }

  // Un código mal escrito daría `undefined`, y con un `?? 0n` el control diría
  // "0 = 0 + 0" y pasaría. Sería un control que se desactiva con un error de
  // tipeo, y nadie lo notaría porque su salida se ve idéntica a la de un balance
  // que cierra.
  const faltantes = [datos.ecuacion.activo, datos.ecuacion.pasivo, datos.ecuacion.patrimonioNeto]
    .filter((codigo) => !importes.has(codigo));

  if (faltantes.length > 0) {
    return [
      {
        codigo: 'ECUACION_PATRIMONIAL',
        cumple: false,
        detalle: `La ecuación patrimonial declara nodos que la plantilla no tiene: ${faltantes.join(', ')}. El control no se puede correr, y no correrlo en silencio sería peor.`,
        involucrados: faltantes,
      },
    ];
  }

  const activo = importes.get(datos.ecuacion.activo)?.amount ?? 0n;
  const pasivo = importes.get(datos.ecuacion.pasivo)?.amount ?? 0n;
  const patrimonio = importes.get(datos.ecuacion.patrimonioNeto)?.amount ?? 0n;
  const cumple = activo === pasivo + patrimonio;

  return [
    {
      codigo: 'ECUACION_PATRIMONIAL',
      cumple,
      detalle: cumple
        ? `Activo (${activo}) = Pasivo (${pasivo}) + PN (${patrimonio})`
        : `Activo ${activo} ≠ Pasivo ${pasivo} + PN ${patrimonio}. Diferencia: ${activo - pasivo - patrimonio} en unidades menores.`,
      involucrados: [datos.ecuacion.activo, datos.ecuacion.pasivo, datos.ecuacion.patrimonioNeto],
    },
  ];
}

/**
 * Sobre el comparativo, y por qué no hay un control de "misma estructura".
 *
 * Las dos columnas se calculan con la **misma** `PlantillaEstado`, así que tienen
 * los mismos renglones por construcción: un control que lo verificara no podría
 * fallar nunca, y un control que no puede fallar es una promesa, no un control.
 *
 * El riesgo real del comparativo no es la estructura sino el **plan de cuentas**:
 * el ejercicio anterior puede tener cuentas que la plantilla de hoy no cubre. Eso
 * sí es detectable, y por eso `controlarCobertura` corre sobre las dos columnas.
 */

/** Un renglón oculto si está en cero y la plantilla lo pidió, en ambas columnas. */
function ocultar(
  plantilla: PlantillaEstado,
  codigo: string,
  importe: Money,
  comparativo: Money | null,
): boolean {
  const nodo = aplanar(plantilla).find((entrada) => entrada.nodo.codigo === codigo)?.nodo;
  if (nodo?.ocultarSiCero !== true) return false;
  // Se oculta solo si está en cero **en las dos columnas**: un rubro que este año
  // es cero y el anterior no, se muestra — su desaparición sería el dato.
  return importe.amount === 0n && (comparativo === null || comparativo.amount === 0n);
}

/** Suma de los importes de un conjunto de renglones, para los subtotales de UI. */
export function totalDe(
  estado: EstadoContable,
  codigos: readonly string[],
): Money {
  return codigos.reduce((acc, codigo) => {
    const renglon = estado.renglones.find((fila) => fila.codigo === codigo);
    return renglon === undefined ? acc : add(acc, renglon.importe);
  }, money(0n, estado.moneda));
}
