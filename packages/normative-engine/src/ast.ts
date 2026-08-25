/**
 * Intérprete cerrado de condiciones.
 *
 * `conditions` y `action` de una regla son **datos declarativos**, no
 * JavaScript. Una regla no puede ejecutar código arbitrario, hacer red ni tocar
 * el disco — y no porque esté prohibido por convención, sino porque este
 * intérprete no tiene esas operaciones.
 *
 * Importa por dos motivos distintos. El obvio: una regla que viene de la base y
 * se evalúa con `eval` es ejecución remota de código. El menos obvio y más
 * cotidiano: un lenguaje chico y total se puede **auditar**. Un contador —o un
 * perito— puede leer el AST de una regla y entender qué hace, cosa que no pasa
 * con una función.
 *
 * ## La decisión que más importa
 *
 * **Lo que no se puede evaluar, falla. Nunca vale `false`.**
 *
 * Un campo que no está en los hechos, un operador desconocido, un AST
 * malformado: todos lanzan. La alternativa —tratarlos como falso— haría que una
 * regla dejara de aplicarse en silencio, y una regla que no se aplica sin que
 * nadie se entere es peor que una que rompe.
 */

export type ValorHecho = string | number | bigint | boolean | null;

export type Hechos = Readonly<Record<string, ValorHecho>>;

export class ErrorDeRegla extends Error {
  constructor(
    message: string,
    readonly ruta: string,
  ) {
    super(`${message} (en ${ruta})`);
    this.name = 'ErrorDeRegla';
  }
}

/** Tope de anidamiento. Una condición contable honesta no llega ni cerca. */
export const PROFUNDIDAD_MAXIMA = 12;
/** Tope de nodos, para que un AST cargado en la base no pueda colgar el proceso. */
export const NODOS_MAXIMOS = 500;

const COMPARADORES = ['eq', 'ne', 'lt', 'lte', 'gt', 'gte'] as const;
type Comparador = (typeof COMPARADORES)[number];

export function evaluar(condicion: unknown, hechos: Hechos): boolean {
  let nodos = 0;

  const paso = (nodo: unknown, profundidad: number, ruta: string): boolean => {
    nodos += 1;
    if (nodos > NODOS_MAXIMOS) {
      throw new ErrorDeRegla(`La condición supera los ${NODOS_MAXIMOS} nodos`, ruta);
    }
    if (profundidad > PROFUNDIDAD_MAXIMA) {
      throw new ErrorDeRegla(`La condición supera los ${PROFUNDIDAD_MAXIMA} niveles`, ruta);
    }
    if (nodo === null || typeof nodo !== 'object' || Array.isArray(nodo)) {
      throw new ErrorDeRegla('Se esperaba un nodo de condición', ruta);
    }

    const objeto = nodo as Record<string, unknown>;
    const op = objeto['op'];
    if (typeof op !== 'string') {
      throw new ErrorDeRegla('El nodo no declara operador', ruta);
    }

    switch (op) {
      case 'always':
        return true;
      case 'never':
        return false;

      case 'and':
      case 'or': {
        const args = objeto['args'];
        if (!Array.isArray(args) || args.length === 0) {
          throw new ErrorDeRegla(`"${op}" necesita al menos un argumento`, ruta);
        }
        // Sin cortocircuito: se evalúan todos los argumentos aunque el
        // resultado ya esté decidido. Si uno está mal escrito, se quiere saber
        // ahora y no el día que el otro cambie de valor.
        const resultados = args.map((arg, i) => paso(arg, profundidad + 1, `${ruta}.args[${i}]`));
        return op === 'and' ? resultados.every(Boolean) : resultados.some(Boolean);
      }

      case 'not': {
        const arg = objeto['arg'];
        if (arg === undefined) throw new ErrorDeRegla('"not" necesita un argumento', ruta);
        return !paso(arg, profundidad + 1, `${ruta}.arg`);
      }

      case 'in': {
        const valor = leerCampo(objeto['field'], hechos, ruta);
        const opciones = objeto['values'];
        if (!Array.isArray(opciones)) {
          throw new ErrorDeRegla('"in" necesita un arreglo de valores', ruta);
        }
        return opciones.some((opcion) => comparar('eq', valor, opcion, ruta));
      }

      case 'between': {
        const valor = leerCampo(objeto['field'], hechos, ruta);
        return (
          comparar('gte', valor, objeto['min'], ruta) && comparar('lte', valor, objeto['max'], ruta)
        );
      }

      default: {
        if (!(COMPARADORES as readonly string[]).includes(op)) {
          // Un operador que no existe no es "no aplica": es una regla que este
          // intérprete no puede evaluar, y hay que arreglarla.
          throw new ErrorDeRegla(`Operador desconocido: "${op}"`, ruta);
        }
        const valor = leerCampo(objeto['field'], hechos, ruta);
        return comparar(op as Comparador, valor, objeto['value'], ruta);
      }
    }
  };

  return paso(condicion, 0, '$');
}

function leerCampo(field: unknown, hechos: Hechos, ruta: string): ValorHecho {
  if (typeof field !== 'string' || field.length === 0) {
    throw new ErrorDeRegla('El nodo no declara campo', ruta);
  }
  // `hasOwn` y no `hechos[field] !== undefined`: un hecho presente con valor
  // `null` es distinto de un hecho que nadie proveyó, y solo el segundo es un
  // error de la regla.
  if (!Object.hasOwn(hechos, field)) {
    throw new ErrorDeRegla(`El hecho "${field}" no está en el contexto`, ruta);
  }
  return hechos[field]!;
}

/**
 * Comparación con tipos comparables.
 *
 * Los importes viajan como `bigint`; las fechas y los códigos, como texto. No se
 * mezclan: comparar `100n` con `"100"` devolvería `false` en silencio, que es
 * justo el resultado plausible y equivocado que este módulo evita.
 */
function comparar(op: Comparador, valor: ValorHecho, referencia: unknown, ruta: string): boolean {
  const derecha = normalizarLiteral(referencia, ruta);

  if (valor === null || derecha === null) {
    if (op === 'eq') return valor === derecha;
    if (op === 'ne') return valor !== derecha;
    throw new ErrorDeRegla('No se puede ordenar contra un valor nulo', ruta);
  }

  if (typeof valor !== typeof derecha) {
    throw new ErrorDeRegla(
      `No se comparan ${typeof valor} y ${typeof derecha}: la regla mezcla tipos`,
      ruta,
    );
  }

  switch (op) {
    case 'eq':
      return valor === derecha;
    case 'ne':
      return valor !== derecha;
    case 'lt':
      return valor < derecha;
    case 'lte':
      return valor <= derecha;
    case 'gt':
      return valor > derecha;
    case 'gte':
      return valor >= derecha;
  }
}

/**
 * Los literales del AST llegan de un `jsonb`, así que un importe viene como
 * texto. `{ "type": "bigint", "value": "12345" }` lo declara explícitamente:
 * adivinar por la forma del string convertiría un código de cuenta numérico en
 * un importe.
 */
function normalizarLiteral(valor: unknown, ruta: string): ValorHecho {
  if (valor === null) return null;
  if (typeof valor === 'string' || typeof valor === 'number' || typeof valor === 'boolean') {
    return valor;
  }
  if (typeof valor === 'object' && !Array.isArray(valor)) {
    const objeto = valor as Record<string, unknown>;
    if (objeto['type'] === 'bigint' && typeof objeto['value'] === 'string') {
      try {
        return BigInt(objeto['value']);
      } catch {
        throw new ErrorDeRegla(`"${objeto['value']}" no es un entero válido`, ruta);
      }
    }
  }
  throw new ErrorDeRegla('Literal de tipo no admitido en una condición', ruta);
}

/**
 * Recorre el AST sin evaluarlo y devuelve los hechos que necesita.
 *
 * Sirve para dos cosas concretas: validar una regla al cargarla, antes de que
 * falle en producción, y armar el contexto mínimo en vez de pasar todo.
 */
export function hechosRequeridos(condicion: unknown): readonly string[] {
  const encontrados = new Set<string>();

  const recorrer = (nodo: unknown, profundidad: number): void => {
    if (profundidad > PROFUNDIDAD_MAXIMA) return;
    if (nodo === null || typeof nodo !== 'object' || Array.isArray(nodo)) return;
    const objeto = nodo as Record<string, unknown>;
    if (typeof objeto['field'] === 'string') encontrados.add(objeto['field']);
    if (Array.isArray(objeto['args'])) {
      for (const arg of objeto['args']) recorrer(arg, profundidad + 1);
    }
    if (objeto['arg'] !== undefined) recorrer(objeto['arg'], profundidad + 1);
  };

  recorrer(condicion, 0);
  return [...encontrados].sort();
}
