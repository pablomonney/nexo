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
  //
  // Una nota está **anclada** de dos maneras posibles, y le alcanza con una:
  //
  //   * un renglón del estado remite a ella (`nodo.nota` en la plantilla), o
  //   * alguna de sus cifras sale de un renglón de este estado.
  //
  // La segunda vía se agregó al conectar las notas al circuito productivo. Las
  // plantillas sembradas —arts. 63 y 64— **no declaran ninguna remisión**: el
  // mecanismo existe en el modelo y ninguna plantilla lo usa todavía. Con solo
  // la primera vía, toda nota real quedaba marcada como huérfana y el control
  // pasaba a ser ruido de fondo, que es como un control deja de mirarse.
  //
  // Lo que sigue detectando, que es lo que importa: la nota que no se apoya en
  // nada de este estado. Suele ser la que quedó del ejercicio anterior, con las
  // cifras del ejercicio anterior adentro.
  const referidas = new Set(
    estado.renglones
      .map((renglon) => renglon.nota)
      .filter((numero): numero is number => numero !== null),
  );
  for (const nota of notas) {
    const cifras = nota.bloques.flatMap((bloque) => cifrasDe(bloque));

    // Una nota **con cifras** tiene que traer al menos una de este estado. Si
    // todas vienen de otro lado, informa números que acá no significan nada —
    // que es el caso que este control existe para encontrar.
    //
    // Una nota **sin cifras** no puede traer números viejos: es texto. A esa se
    // le exige remisión solo cuando la plantilla usa el mecanismo, es decir
    // cuando algún renglón remite a alguna nota. Con solo un lado declarado no
    // hay inconsistencia que detectar, y marcarlas todas convertiría el control
    // en ruido de fondo — que es como un control deja de mirarse. Las plantillas
    // sembradas de los arts. 63 y 64 no declaran ninguna remisión todavía.
    const anclada =
      referidas.has(nota.numero) ||
      (cifras.length > 0
        ? cifras.some((cifra) => codigosDelEstado.has(cifra.renglonCodigo))
        : referidas.size === 0);

    if (!anclada) {
      errores.push({
        codigo: 'NOTA_NO_REFERIDA',
        nota: nota.numero,
        mensaje: `La nota ${nota.numero} no se apoya en ningún renglón de este estado: ni un renglón remite a ella, ni ninguna de sus cifras sale de acá. Suele ser una nota que quedó del ejercicio anterior — con las cifras del ejercicio anterior adentro.`,
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

// ---------------------------------------------------------------------------
// Generación determinística
// ---------------------------------------------------------------------------

/**
 * Tipos de nota que el sistema sabe tratar.
 *
 * No es una taxonomía contable: es la lista de lo que este sistema puede
 * sostener con lo que tiene. Lo que no está acá se carga como `OTRA` y lo
 * redacta una persona.
 */
export type TipoDeNota =
  | 'BASES_DE_PREPARACION'
  | 'COMPOSICION_DE_RUBRO'
  | 'RESULTADO_DEL_EJERCICIO'
  | 'OTRA';

/**
 * Qué sostiene la nota. Distinto de quién la firmó.
 *
 * - `VERIFIED`: las cifras salen de renglones del estado y el texto de datos
 *   declarados. No hay nada que suponer.
 * - `REQUIRES_REVIEW`: hay con qué proponerla, y lo que falta es juicio
 *   profesional — no un dato.
 * - `INSUFFICIENT_EVIDENCE`: el sistema no tiene la información. **No se redacta
 *   texto y no se rellena con supuestos.**
 */
export type EstadoDeEvidencia = 'VERIFIED' | 'REQUIRES_REVIEW' | 'INSUFFICIENT_EVIDENCE';

export interface NotaPropuesta {
  readonly tipo: TipoDeNota;
  readonly numero: number;
  readonly titulo: string;
  readonly bloques: readonly BloqueDeNota[];
  readonly evidencia: EstadoDeEvidencia;
  /**
   * Por qué la evidencia es la que es.
   *
   * En `INSUFFICIENT_EVIDENCE` dice **qué falta**, que es lo único útil que se
   * puede decir cuando no se puede decir nada más.
   */
  readonly motivo: string;
  readonly fundamento: string;
}

/**
 * Datos que el sistema ya declaró y que una nota puede citar sin suponer nada.
 *
 * Todo lo que entra acá está registrado en otra parte: el marco contable sale de
 * `company_reporting_frameworks` y la norma de la plantilla del estado. Si
 * mañana hiciera falta un criterio de valuación, **no se agrega acá con un valor
 * por defecto**: se agrega cuando exista dónde declararlo, y hasta entonces la
 * nota que lo necesite queda sin evidencia.
 */
export interface ContextoDeNotas {
  readonly marco: string;
  readonly articulo: string;
  readonly moneda: string;
  /** Renglones que se desagregan por cuenta. Los elige quien pide las notas. */
  readonly rubrosADesagregar: readonly string[];
}

const ART_65 = 'Ley 19.550 (T.O. 1984), art. 65';

/**
 * Propone el juego de notas que el estado puede sostener.
 *
 * **Determinística**: mismas cifras, mismo texto, mismo orden. No estima, no
 * infiere por el nombre de una cuenta y no completa lo que falta — cuando no
 * alcanza devuelve `INSUFFICIENT_EVIDENCE` con lo que falta escrito.
 *
 * El texto que produce es de origen `PLANTILLA`: una frase armada con datos
 * declarados. No es una redacción profesional, y por eso ninguna nota que
 * afirme un *criterio* sale mejor que `REQUIRES_REVIEW`. Las que llegan a
 * `VERIFIED` son las que solo afirman **composición**: qué cuentas forman un
 * rubro y por cuánto, que es aritmética sobre el Mayor.
 */
export function proponerNotas(
  estado: EstadoContable,
  contexto: ContextoDeNotas,
): NotaPropuesta[] {
  const propuestas: NotaPropuesta[] = [];
  let numero = 0;
  const siguiente = (): number => (numero += 1);

  // --- 1. Bases de preparación -------------------------------------------
  //
  // El marco y la norma están declarados; que sean los que corresponden al ente
  // es una afirmación profesional. Por eso REQUIRES_REVIEW y no VERIFIED: el
  // dato es cierto, la conclusión que se saca de él la firma una persona.
  propuestas.push({
    tipo: 'BASES_DE_PREPARACION',
    numero: siguiente(),
    titulo: 'Bases de preparación',
    bloques: [
      {
        tipo: 'TEXTO',
        origenTexto: 'PLANTILLA',
        contenido:
          `Los presentes estados contables fueron preparados conforme al marco ${contexto.marco} ` +
          `declarado por el ente, con la estructura de ${contexto.articulo}, y se expresan en ` +
          `${contexto.moneda}.`,
      },
    ],
    evidencia: 'REQUIRES_REVIEW',
    motivo:
      'El marco contable, la norma de la estructura y la moneda están declarados en el sistema. ' +
      'Que sean los aplicables a este ente es una afirmación profesional, no un dato.',
    fundamento: ART_65,
  });

  // --- 2. Composición de los rubros pedidos -------------------------------
  for (const codigo of contexto.rubrosADesagregar) {
    const renglon = estado.renglones.find((fila) => fila.codigo === codigo);
    if (renglon === undefined) {
      propuestas.push({
        tipo: 'COMPOSICION_DE_RUBRO',
        numero: siguiente(),
        titulo: `Composición de ${codigo}`,
        // Sin texto y sin cifras: no hay nada que decir, y decir algo sería
        // inventarlo. La nota existe para que el faltante quede a la vista.
        bloques: [],
        evidencia: 'INSUFFICIENT_EVIDENCE',
        motivo: `El estado no tiene el renglón ${codigo}: no hay de dónde sacar su composición.`,
        fundamento: ART_65,
      });
      continue;
    }

    const filas = desagregarRenglon(estado, codigo);
    if (filas.length === 0) {
      propuestas.push({
        tipo: 'COMPOSICION_DE_RUBRO',
        numero: siguiente(),
        titulo: `Composición de ${renglon.etiqueta}`,
        bloques: [],
        evidencia: 'INSUFFICIENT_EVIDENCE',
        motivo:
          `El renglón ${codigo} no tiene ninguna cuenta detrás. Un rubro sin composición no se ` +
          'explica: o está en cero, o la plantilla no lo está capturando.',
        fundamento: ART_65,
      });
      continue;
    }

    propuestas.push({
      tipo: 'COMPOSICION_DE_RUBRO',
      numero: siguiente(),
      titulo: `Composición de ${renglon.etiqueta}`,
      bloques: [
        {
          tipo: 'TEXTO',
          origenTexto: 'PLANTILLA',
          contenido: `El rubro ${renglon.etiqueta} se compone de las siguientes cuentas:`,
        },
        { tipo: 'CUADRO', encabezados: ['Cuenta', 'Importe'], filas: filas.map((fila) => [fila]) },
      ],
      // La única clase que llega a VERIFIED: cada línea del cuadro es una cuenta
      // del origen del renglón, así que la suma ES el renglón por construcción.
      // No hay nada que revisar salvo la aritmética, y la aritmética está hecha.
      evidencia: 'VERIFIED',
      motivo: `Las ${filas.length} cuenta(s) salen del linaje del renglón ${codigo}.`,
      fundamento: ART_65,
    });
  }

  // --- 3. Resultado del ejercicio ----------------------------------------
  const resultado = estado.renglones.find((fila) => fila.codigo === 'RESULTADO_EJERCICIO');
  if (resultado !== undefined) {
    const cifra = cifraDeRenglon(estado, resultado.codigo, 'Resultado del ejercicio');
    propuestas.push({
      tipo: 'RESULTADO_DEL_EJERCICIO',
      numero: siguiente(),
      titulo: 'Resultado del ejercicio',
      bloques: [
        {
          tipo: 'TEXTO',
          origenTexto: 'PLANTILLA',
          contenido:
            'El resultado del ejercicio surge de la diferencia entre los ingresos y los gastos ' +
            'registrados, según el detalle del estado de resultados.',
        },
        ...(cifra === null ? [] : [{ tipo: 'CIFRAS' as const, cifras: [cifra] }]),
      ],
      evidencia: 'VERIFIED',
      motivo: `Sale del renglón ${resultado.codigo} del estado, con su linaje.`,
      fundamento: ART_65,
    });
  }

  return propuestas;
}

/**
 * Notas que el sistema **no** puede proponer, con lo que le falta a cada una.
 *
 * Se devuelven en vez de omitirse. Una nota ausente y una nota imposible se ven
 * igual —no está— y mandan a hacer cosas distintas: buscar el generador, o
 * cargar el dato que falta.
 */
export function notasNoGenerables(): readonly {
  readonly tipo: string;
  readonly motivo: string;
  readonly falta: string;
}[] {
  return [
    {
      tipo: 'BIENES_DE_USO',
      motivo:
        'El art. 63 inc. 1) b) 3 pide altas, bajas, depreciaciones y valores de origen del ejercicio.',
      falta:
        'Un submayor de bienes de uso. El sistema registra el saldo contable de la cuenta y no el ' +
        'movimiento por bien, así que no puede armar el cuadro sin inventarlo.',
    },
    {
      tipo: 'PLAZOS_Y_GARANTIAS_DE_CREDITOS_Y_DEUDAS',
      motivo: 'Art. 63 inc. 4) b) y c): plazos de vencimiento, y si están documentados o garantizados.',
      falta:
        'Vencimientos y garantías no están modelados. `party_id` identifica al tercero, no la ' +
        'fecha de vencimiento ni la garantía.',
    },
    {
      tipo: 'CRITERIOS_DE_VALUACION',
      motivo: 'Las políticas contables aplicadas a cada rubro.',
      falta:
        'El sistema declara el marco contable del ente, no el criterio de valuación por rubro. ' +
        'Redactarlo con el criterio más frecuente sería afirmar por el ente lo que no dijo.',
    },
    {
      tipo: 'HECHOS_POSTERIORES',
      motivo: 'Hechos ocurridos entre el cierre y la emisión que afecten la interpretación.',
      falta: 'Son hechos del mundo, no del sistema. Los aporta quien firma.',
    },
  ];
}
