/**
 * Validación de plantillas.
 *
 * La plantilla viene de la base, así que **no se puede confiar en que esté bien
 * formada**. Es el mismo razonamiento que el intérprete cerrado del motor
 * normativo: una estructura de datos que llega de afuera y gobierna un cálculo
 * contable se valida antes de usarla, no se ejecuta y se ve qué pasa.
 *
 * Lo que se valida acá son propiedades de la **plantilla sola**, sin mirar
 * ningún plan de cuentas: códigos únicos, sin ciclos, totales que referencian
 * nodos que existen, rubros con fundamento. Los controles que necesitan el plan
 * —cuentas sin rubro, cuentas en dos rubros— viven en `build.ts`, porque
 * dependen de la empresa.
 */

import type { NodoPlantilla, PlantillaEstado, TipoNodo } from './contracts.js';

export type CodigoErrorPlantilla =
  | 'CODIGO_DUPLICADO'
  | 'TOTAL_SIN_REFERENCIAS'
  | 'TOTAL_REFERENCIA_INEXISTENTE'
  | 'TOTAL_CIRCULAR'
  | 'RENGLON_SIN_SELECTOR'
  | 'RUBRO_SIN_HIJOS'
  | 'RUBRO_SIN_FUNDAMENTO'
  | 'NODO_CON_HIJOS_Y_SELECTOR'
  | 'PROFUNDIDAD_EXCESIVA'
  | 'PLANTILLA_VACIA';

export interface ErrorPlantilla {
  readonly codigo: CodigoErrorPlantilla;
  readonly nodo: string;
  readonly mensaje: string;
}

/**
 * Profundidad máxima del árbol.
 *
 * Seis niveles cubren Activo → Corriente → Créditos → Por ventas → Con
 * sociedades vinculadas → detalle, que es más de lo que cualquier ESP argentino
 * necesita. El tope no es una restricción de diseño: es lo que impide que una
 * plantilla mal cargada haga una recursión infinita en la construcción.
 */
const PROFUNDIDAD_MAXIMA = 6;

export function validarPlantilla(plantilla: PlantillaEstado): ErrorPlantilla[] {
  const errores: ErrorPlantilla[] = [];

  if (plantilla.raiz.length === 0) {
    return [
      {
        codigo: 'PLANTILLA_VACIA',
        nodo: plantilla.id,
        mensaje: 'La plantilla no tiene ningún nodo. Un estado contable vacío no es un estado contable.',
      },
    ];
  }

  const vistos = new Map<string, TipoNodo>();
  const totales = new Map<string, readonly string[]>();

  recorrer(plantilla.raiz, 1, (nodo, nivel) => {
    if (nivel > PROFUNDIDAD_MAXIMA) {
      errores.push({
        codigo: 'PROFUNDIDAD_EXCESIVA',
        nodo: nodo.codigo,
        mensaje: `El nodo está en el nivel ${nivel} y el máximo es ${PROFUNDIDAD_MAXIMA}.`,
      });
      return;
    }

    if (vistos.has(nodo.codigo)) {
      // Un código repetido no es un detalle estético: los TOTAL referencian por
      // código, y con dos nodos iguales el total sumaría uno de los dos según el
      // orden del recorrido.
      errores.push({
        codigo: 'CODIGO_DUPLICADO',
        nodo: nodo.codigo,
        mensaje: `El código "${nodo.codigo}" aparece más de una vez. Los totales referencian por código: con uno repetido, el total suma uno de los dos según el orden del recorrido.`,
      });
    }
    vistos.set(nodo.codigo, nodo.tipo);

    const tieneHijos = (nodo.hijos ?? []).length > 0;

    if (nodo.tipo === 'RUBRO') {
      if (!tieneHijos) {
        errores.push({
          codigo: 'RUBRO_SIN_HIJOS',
          nodo: nodo.codigo,
          mensaje: `El rubro "${nodo.etiqueta}" no tiene hijos: su importe siempre sería cero. Si toma cuentas directamente, es un RENGLON.`,
        });
      }
      if (nodo.fundamento === undefined || nodo.fundamento.trim() === '') {
        // Un rubro es una afirmación sobre cómo se agrupa la información
        // patrimonial, y el art. 63 dice cómo. Sin cita, la agrupación es una
        // opinión del que cargó la plantilla.
        errores.push({
          codigo: 'RUBRO_SIN_FUNDAMENTO',
          nodo: nodo.codigo,
          mensaje: `El rubro "${nodo.etiqueta}" no cita el artículo del que sale. Un rubro sin fundamento es una agrupación inventada.`,
        });
      }
    }

    if (nodo.tipo === 'RENGLON') {
      if (nodo.selector === undefined) {
        errores.push({
          codigo: 'RENGLON_SIN_SELECTOR',
          nodo: nodo.codigo,
          mensaje: `El renglón "${nodo.etiqueta}" no tiene selector: no hay forma de saber de qué cuentas sale su importe.`,
        });
      }
      if (tieneHijos) {
        errores.push({
          codigo: 'NODO_CON_HIJOS_Y_SELECTOR',
          nodo: nodo.codigo,
          mensaje: `El renglón "${nodo.etiqueta}" tiene hijos y selector a la vez. Sería ambiguo si su importe sale de las cuentas o de los hijos.`,
        });
      }
    }

    if (nodo.tipo === 'TOTAL') {
      const referencias = nodo.suma ?? [];
      if (referencias.length === 0) {
        errores.push({
          codigo: 'TOTAL_SIN_REFERENCIAS',
          nodo: nodo.codigo,
          mensaje: `El total "${nodo.etiqueta}" no dice qué suma.`,
        });
      }
      totales.set(nodo.codigo, referencias);
    }
  });

  // Las referencias se validan al final: un total puede referenciar un nodo que
  // aparece más adelante en el árbol, y eso es legítimo.
  for (const [codigo, referencias] of totales) {
    for (const referencia of referencias) {
      if (!vistos.has(referencia)) {
        errores.push({
          codigo: 'TOTAL_REFERENCIA_INEXISTENTE',
          nodo: codigo,
          mensaje: `El total "${codigo}" suma "${referencia}", que no existe en la plantilla.`,
        });
      }
    }
  }

  errores.push(...detectarCiclos(totales));

  return errores;
}

/**
 * Ciclos entre totales.
 *
 * `A suma B` y `B suma A` es una plantilla que hace colgar la construcción. Se
 * detecta con un recorrido en profundidad marcando los nodos en curso, que es lo
 * mismo que hace el lint de arquitectura con las dependencias circulares.
 */
function detectarCiclos(totales: Map<string, readonly string[]>): ErrorPlantilla[] {
  const errores: ErrorPlantilla[] = [];
  const estado = new Map<string, 'EN_CURSO' | 'LISTO'>();

  function visitar(codigo: string, camino: readonly string[]): void {
    const actual = estado.get(codigo);
    if (actual === 'LISTO') return;
    if (actual === 'EN_CURSO') {
      errores.push({
        codigo: 'TOTAL_CIRCULAR',
        nodo: codigo,
        mensaje: `Hay un ciclo entre totales: ${[...camino, codigo].join(' → ')}.`,
      });
      return;
    }

    estado.set(codigo, 'EN_CURSO');
    for (const referencia of totales.get(codigo) ?? []) {
      if (totales.has(referencia)) visitar(referencia, [...camino, codigo]);
    }
    estado.set(codigo, 'LISTO');
  }

  for (const [codigo] of totales) visitar(codigo, []);
  return errores;
}

/**
 * Recorre el árbol entero, sin cortar por profundidad.
 *
 * La versión anterior no bajaba más allá de `PROFUNDIDAD_MAXIMA`, y el efecto era
 * el peor posible: una plantilla demasiado profunda quedaba **truncada en
 * silencio**. Los nodos de abajo no se visitaban, así que ni se validaban ni
 * capturaban cuentas — y el control de profundidad, que existía para rechazar
 * esa plantilla, nunca llegaba a ejecutarse.
 *
 * Un árbol de JSON es finito y no tiene ciclos, así que bajar sin tope no puede
 * colgar. El tope sigue estando, pero como **rechazo** en el validador, que es
 * donde tiene efecto.
 */
function recorrer(
  nodos: readonly NodoPlantilla[],
  nivel: number,
  visitar: (nodo: NodoPlantilla, nivel: number) => void,
): void {
  for (const nodo of nodos) {
    visitar(nodo, nivel);
    recorrer(nodo.hijos ?? [], nivel + 1, visitar);
  }
}

/** Todos los nodos del árbol, en orden de presentación, con su nivel. */
export function aplanar(
  plantilla: PlantillaEstado,
): { nodo: NodoPlantilla; nivel: number }[] {
  const salida: { nodo: NodoPlantilla; nivel: number }[] = [];
  recorrer(plantilla.raiz, 1, (nodo, nivel) => salida.push({ nodo, nivel }));
  return salida;
}

/**
 * Plantillas vigentes a una fecha, para un marco, tipo de ente y regulador.
 *
 * El §6 también rige acá: el ESP de un ejercicio cerrado en 2024 se arma con la
 * plantilla que regía en 2024, no con la de hoy. Un cambio de plantilla que
 * reescriba los estados ya emitidos sería reescribir la historia.
 */
export function plantillaAplicable(
  plantillas: readonly PlantillaEstado[],
  criterio: {
    tipo: PlantillaEstado['tipo'];
    marco: PlantillaEstado['marco'];
    tipoEnte: PlantillaEstado['tipoEnte'];
    regulador: PlantillaEstado['regulador'];
    fecha: PlantillaEstado['vigenteDesde'];
  },
): PlantillaEstado | null {
  const candidatas = plantillas.filter(
    (plantilla) =>
      plantilla.tipo === criterio.tipo &&
      plantilla.marco === criterio.marco &&
      plantilla.tipoEnte === criterio.tipoEnte &&
      plantilla.regulador === criterio.regulador &&
      plantilla.vigenteDesde <= criterio.fecha &&
      (plantilla.vigenteHasta === null || criterio.fecha <= plantilla.vigenteHasta),
  );

  if (candidatas.length === 0) return null;

  // Con más de una vigente se toma la de versión mayor. No es una heurística:
  // `statement_templates` tiene un índice único por (marco, ente, regulador,
  // tipo, version) y la vigencia se cierra al publicar la siguiente, así que dos
  // vigentes a la misma fecha es un dato mal cargado. Se elige la más nueva y el
  // control de la base es el que tiene que impedir que llegue a pasar.
  return candidatas.reduce((mejor, actual) => (actual.version > mejor.version ? actual : mejor));
}
