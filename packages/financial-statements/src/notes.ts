/**
 * Notas complementarias.
 *
 * Fuente: Ley 19.550 (T.O. 1984) **art. 65** — *"Para el caso que la
 * correspondiente información no estuviera contenida en los estados contables de
 * los artículos 63 y 64 o en sus notas, deberán acompañarse notas y cuadros, que
 * se considerarán parte de aquéllos."* Y el CCyC art. 326, que hace de los
 * estados contables una obligación de cierre.
 *
 * ## La única decisión de este archivo
 *
 * **Una cifra de una nota no se escribe: se referencia.**
 *
 * Es el invariante A-2 de `AUDIT_TRAIL.md` —*no existe cifra en nota sin
 * respaldo*— y la forma de garantizarlo no es validarlo al guardar, sino no
 * tener dónde escribir un número. Una `CifraDeNota` solo se puede construir
 * apuntando a un renglón del estado, y de ahí hereda su importe **y su linaje**.
 *
 * La alternativa —dejar que el redactor escriba el número y validar después que
 * coincida— falla de dos maneras. La primera vez que el estado se recalcula, la
 * nota queda desactualizada y sigue diciendo el número viejo con toda
 * naturalidad. Y cuando alguien la corrige a mano, la corrige a un número que
 * también escribió.
 *
 * ## Lo que este archivo no hace
 *
 * No redacta. El texto de una nota es una afirmación profesional sobre criterios
 * contables, hechos posteriores o contingencias; el sistema arma la estructura,
 * pega las cifras con su origen, y deja el texto a quien firma. El §42 en una
 * frase: nunca presentar salida de IA como asesoramiento profesional definitivo.
 */

import type { Money } from '@aai/shared';
import type { EstadoContable, OrigenDelRenglon, RenglonEmitido } from './contracts.js';

export type OrigenDelTexto = 'PLANTILLA' | 'HUMANO' | 'IA_BORRADOR';

/**
 * Una cifra dentro de una nota.
 *
 * No tiene constructor público con un importe: se obtiene de
 * `cifraDeRenglon()`, que la deriva de un renglón del estado. El importe y el
 * linaje vienen de ahí, no de quien redacta.
 */
export interface CifraDeNota {
  readonly etiqueta: string;
  /** Renglón del estado del que sale. Es el respaldo del A-2. */
  readonly renglonCodigo: string;
  readonly importe: Money;
  readonly comparativo: Money | null;
  /** Heredado del renglón: las cuentas que formaron el importe. */
  readonly origen: readonly OrigenDelRenglon[];
}

export type BloqueDeNota =
  | { readonly tipo: 'TEXTO'; readonly contenido: string; readonly origenTexto: OrigenDelTexto }
  | { readonly tipo: 'CIFRAS'; readonly cifras: readonly CifraDeNota[] }
  | {
      readonly tipo: 'CUADRO';
      readonly encabezados: readonly string[];
      readonly filas: readonly (readonly CifraDeNota[])[];
    };

export interface Nota {
  readonly numero: number;
  readonly titulo: string;
  readonly bloques: readonly BloqueDeNota[];
  /** Renglones del estado que remiten a esta nota. */
  readonly referidaPor: readonly string[];
  readonly fundamento: string;
}

export type CodigoErrorNota =
  | 'RENGLON_INEXISTENTE'
  | 'NOTA_SIN_BLOQUES'
  | 'NOTA_SIN_TEXTO'
  | 'REMISION_SIN_NOTA'
  | 'NOTA_NO_REFERIDA'
  | 'NUMERO_DUPLICADO'
  | 'BORRADOR_DE_IA_SIN_REVISAR';

export interface ErrorNota {
  readonly codigo: CodigoErrorNota;
  readonly nota: number;
  readonly mensaje: string;
}

/**
 * Deriva una cifra a partir de un renglón del estado.
 *
 * Devuelve `null` si el renglón no existe. **No hay una variante que acepte un
 * importe**: si la hubiera, el invariante A-2 pasaría a depender de que nadie la
 * use, y la experiencia de este repositorio es que alguien la usa.
 */
export function cifraDeRenglon(
  estado: EstadoContable,
  renglonCodigo: string,
  etiqueta?: string,
): CifraDeNota | null {
  const renglon = estado.renglones.find((fila) => fila.codigo === renglonCodigo);
  if (renglon === undefined) return null;

  return {
    etiqueta: etiqueta ?? renglon.etiqueta,
    renglonCodigo: renglon.codigo,
    importe: renglon.importe,
    comparativo: renglon.comparativo,
    origen: renglon.origen,
  };
}

/**
 * Una cifra que desagrega un renglón por cuenta.
 *
 * El caso típico de nota: "Créditos por ventas se compone de…". Cada línea del
 * cuadro es **una cuenta del origen del renglón**, así que la suma del cuadro es
 * el renglón por construcción y no hace falta verificarla.
 */
export function desagregarRenglon(
  estado: EstadoContable,
  renglonCodigo: string,
): CifraDeNota[] {
  const renglon = estado.renglones.find((fila) => fila.codigo === renglonCodigo);
  if (renglon === undefined) return [];

  return renglon.origen.map((origen) => ({
    etiqueta: origen.codigo,
    renglonCodigo: renglon.codigo,
    importe: origen.aporte,
    comparativo: null,
    origen: [origen],
  }));
}

export interface ResultadoNotas {
  readonly notas: readonly Nota[];
  readonly errores: readonly ErrorNota[];
  /** `false` inhabilita la emisión del juego de estados. */
  readonly consistente: boolean;
}

/**
 * Verifica el conjunto de notas contra el estado.
 *
 * Los dos controles que importan son **cruzados**, y se suelen mirar solo en una
 * dirección:
 *
 * - `REMISION_SIN_NOTA`: un renglón dice "ver nota 5" y la nota 5 no existe. Es
 *   el que todo el mundo revisa.
 * - `NOTA_NO_REFERIDA`: existe una nota 7 y ningún renglón remite a ella. Este
 *   casi nadie lo mira, y es el que delata una nota que quedó de un ejercicio
 *   anterior — con las cifras del ejercicio anterior adentro.
 */
export function verificarNotas(estado: EstadoContable, notas: readonly Nota[]): ResultadoNotas {
  const errores: ErrorNota[] = [];
  const numeros = new Set<number>();
  const codigosDelEstado = new Set(estado.renglones.map((renglon) => renglon.codigo));

  for (const nota of notas) {
    if (numeros.has(nota.numero)) {
      errores.push({
        codigo: 'NUMERO_DUPLICADO',
        nota: nota.numero,
        mensaje: `Hay más de una nota ${nota.numero}. Las remisiones de los renglones son por número.`,
      });
    }
    numeros.add(nota.numero);

    if (nota.bloques.length === 0) {
      errores.push({
        codigo: 'NOTA_SIN_BLOQUES',
        nota: nota.numero,
        mensaje: `La nota ${nota.numero} está vacía.`,
      });
    }

    if (!nota.bloques.some((bloque) => bloque.tipo === 'TEXTO')) {
      // Un cuadro de cifras sin una línea de texto que diga qué son no es una
      // nota: es una tabla suelta. El art. 65 pide notas y cuadros, no cuadros.
      errores.push({
        codigo: 'NOTA_SIN_TEXTO',
        nota: nota.numero,
        mensaje: `La nota ${nota.numero} solo tiene cifras. Una nota sin texto no explica nada: es una tabla suelta.`,
      });
    }

    for (const bloque of nota.bloques) {
      if (bloque.tipo === 'TEXTO' && bloque.origenTexto === 'IA_BORRADOR') {
        // §42: nunca presentar salida de IA como asesoramiento profesional
        // definitivo. Un borrador de IA puede existir; lo que no puede es llegar
        // a un estado emitido sin que una persona lo haga suyo.
        errores.push({
          codigo: 'BORRADOR_DE_IA_SIN_REVISAR',
          nota: nota.numero,
          mensaje: `La nota ${nota.numero} tiene texto marcado como borrador de IA. Una nota es una afirmación profesional: tiene que pasar a HUMANO antes de emitirse.`,
        });
      }

      for (const cifra of cifrasDe(bloque)) {
        if (!codigosDelEstado.has(cifra.renglonCodigo)) {
          errores.push({
            codigo: 'RENGLON_INEXISTENTE',
            nota: nota.numero,
            mensaje: `La cifra "${cifra.etiqueta}" referencia el renglón ${cifra.renglonCodigo}, que no está en el estado. La nota quedó de otro ejercicio o de otra plantilla.`,
          });
        }
      }
    }
  }

  // Remisiones del estado hacia las notas.
  for (const renglon of estado.renglones) {
    if (renglon.nota !== null && !numeros.has(renglon.nota)) {
      errores.push({
        codigo: 'REMISION_SIN_NOTA',
        nota: renglon.nota,
        mensaje: `El renglón ${renglon.codigo} remite a la nota ${renglon.nota}, que no existe.`,
      });
    }
  }

  // Y de las notas hacia el estado: el control que casi nadie mira.
  const referidas = new Set(
    estado.renglones
      .map((renglon) => renglon.nota)
      .filter((numero): numero is number => numero !== null),
  );
  for (const nota of notas) {
    if (!referidas.has(nota.numero)) {
      errores.push({
        codigo: 'NOTA_NO_REFERIDA',
        nota: nota.numero,
        mensaje: `Ningún renglón remite a la nota ${nota.numero}. Suele ser una nota que quedó del ejercicio anterior — con las cifras del ejercicio anterior adentro.`,
      });
    }
  }

  return { notas, errores, consistente: errores.length === 0 };
}

function cifrasDe(bloque: BloqueDeNota): readonly CifraDeNota[] {
  if (bloque.tipo === 'CIFRAS') return bloque.cifras;
  if (bloque.tipo === 'CUADRO') return bloque.filas.flat();
  return [];
}

/**
 * Todas las cifras de un conjunto de notas, con su linaje.
 *
 * Es lo que se guarda en `note_figures`, y lo que el invariante A-2 recorre.
 */
export function cifrasDeLasNotas(
  notas: readonly Nota[],
): { nota: number; cifra: CifraDeNota }[] {
  return notas.flatMap((nota) =>
    nota.bloques.flatMap((bloque) =>
      cifrasDe(bloque).map((cifra) => ({ nota: nota.numero, cifra })),
    ),
  );
}

/**
 * Renglones del estado que remiten a una nota y qué nota es.
 *
 * Sirve para armar el `referidaPor` sin que el redactor lo mantenga a mano: una
 * lista de referencias cruzadas escrita a mano se desactualiza al primer cambio
 * de plantilla.
 */
export function remisiones(estado: EstadoContable): Map<number, string[]> {
  const mapa = new Map<number, string[]>();
  for (const renglon of estado.renglones) {
    if (renglon.nota === null) continue;
    const previos = mapa.get(renglon.nota);
    if (previos === undefined) mapa.set(renglon.nota, [renglon.codigo]);
    else previos.push(renglon.codigo);
  }
  return mapa;
}

/** El renglón del estado al que una cifra remite, para navegar desde la nota. */
export function renglonDe(
  estado: EstadoContable,
  cifra: CifraDeNota,
): RenglonEmitido | undefined {
  return estado.renglones.find((renglon) => renglon.codigo === cifra.renglonCodigo);
}
