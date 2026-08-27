/**
 * Validación de una regla antes de que entre a la base.
 *
 * Cargar una regla contable es el acto por el cual el sistema pasa a afirmar
 * algo sobre la normativa argentina. Este módulo es el filtro, y está escrito
 * para **rechazar**: una regla entra solo si sobrevive a todas las
 * comprobaciones, y el motivo de cada rechazo se informa por separado para que
 * quien la escribió sepa qué arreglar.
 *
 * ## Es puro a propósito
 *
 * No lee archivos, no calcula hashes y no toca la base: recibe todo eso ya
 * resuelto en `ContextoDeCarga`. El lint de arquitectura lo exige
 * (`dominio-sin-io`), y además es lo que permite testear los ocho rechazos sin
 * montar un disco ni un PostgreSQL.
 *
 * ## Lo que NO hace
 *
 * No interpreta la norma. No decide si una regla es correcta en derecho: decide
 * si es **trazable** —si cita, si la cita existe en el documento archivado, si
 * el documento es el que dice ser— y si es **ejecutable** por el intérprete
 * cerrado. Que la regla diga lo que la norma dice lo resuelve una persona, y por
 * eso ninguna regla cargada por acá puede quedar en `ACTIVE`.
 */

import { evaluar, ErrorDeRegla, type Hechos, type ValorHecho } from './ast.js';

// ---------------------------------------------------------------------------
// 1. La forma del archivo
// ---------------------------------------------------------------------------

export type TipoDeHecho = 'BOOLEANO' | 'TEXTO' | 'NUMERO' | 'IMPORTE';

export interface HechoRequerido {
  readonly campo: string;
  readonly tipo: TipoDeHecho;
}

/**
 * Catálogo cerrado de acciones.
 *
 * Una acción es lo que la regla **produce** cuando sus condiciones se cumplen, y
 * cada entrada de acá tiene que tener un consumidor real en el sistema. Agregar
 * una es un acto deliberado: si el catálogo aceptara cualquier objeto, una regla
 * podría declarar un efecto que nadie implementa y el motor la resolvería con
 * éxito sin que pasara nada.
 */
export const ACCIONES_SOPORTADAS = {
  /**
   * Marca el tratamiento del crédito fiscal de un comprobante.
   *
   * `NO_COMPUTABLE` es el único resultado admitido hoy, y no por omisión: el
   * art. 12 de la Ley 23.349 enuncia una condición **necesaria** ("Sólo darán
   * lugar a cómputo … en la medida en que se vinculen con las operaciones
   * gravadas"). De una condición necesaria se deduce la negativa —si no se
   * vincula, no computa— y **no** la afirmativa. Admitir `COMPUTABLE` invitaría
   * a escribir una regla que afirme más de lo que el artículo dice.
   */
  MARCAR_CREDITO_FISCAL: ['NO_COMPUTABLE'],
} as const satisfies Record<string, readonly string[]>;

export type TipoDeAccion = keyof typeof ACCIONES_SOPORTADAS;

export interface ReglaDeArchivo {
  readonly fuente: {
    readonly organismo: string;
    readonly tipo: string;
    readonly numero: string;
    readonly anio: number;
    readonly documento: { readonly archivo: string; readonly sha256: string };
  };
  readonly regla: {
    readonly clave: string;
    readonly version: number;
    readonly dominio: 'accounting' | 'tax' | 'disclosure';
    readonly jurisdiccion: string;
    readonly tiposDeEnte: readonly string[];
    readonly marcos: readonly string[];
    readonly prioridad: number;
    readonly propuestaPor: string;
  };
  readonly condiciones: {
    readonly hechosRequeridos: readonly HechoRequerido[];
    readonly ast: unknown;
  };
  readonly accion: { readonly tipo: string; readonly resultado: string };
  readonly cita: {
    readonly articulo: string;
    readonly inciso?: string;
    /** Transcripción **literal** del fragmento que funda la regla. */
    readonly texto: string;
  };
  readonly vigencia: {
    readonly desde: string;
    readonly hasta: string | null;
    /** De dónde sale `desde`. Sin esto la fecha sería una afirmación sin respaldo. */
    readonly fundamento: string;
  };
  readonly estado: string;
}

/** Lo que el cargador averigua antes de llamar acá: disco, hash y base. */
export interface ContextoDeCarga {
  /** `null` si la norma no está en el corpus. */
  readonly normVersionId: string | null;
  /** SHA-256 registrado en `norm_documents`. `null` si no hay documento. */
  readonly sha256Registrado: string | null;
  /** SHA-256 recalculado sobre el archivo en disco. `null` si no se pudo leer. */
  readonly sha256Calculado: string | null;
  /**
   * Texto plano del documento archivado, ya sin marcado.
   *
   * `null` si no se pudo leer. Se compara contra la cita después de normalizar
   * espacios: el HTML de INFOLEG parte los párrafos en varias líneas y una cita
   * correcta no debería fallar por eso.
   */
  readonly textoDelDocumento: string | null;
}

// ---------------------------------------------------------------------------
// 2. Los rechazos
// ---------------------------------------------------------------------------

export type CodigoDeRechazo =
  | 'FALTA_INFORMACION_OBLIGATORIA'
  | 'NORMA_INEXISTENTE_EN_CORPUS'
  | 'SHA256_NO_COINCIDE'
  | 'SIN_CITA'
  | 'UBICACION_INEXISTENTE'
  | 'CITA_NO_COINCIDE_CON_DOCUMENTO'
  | 'CONDICION_FUERA_DEL_INTERPRETE'
  | 'HECHO_NO_DECLARADO'
  | 'ACCION_NO_SOPORTADA'
  | 'ESTADO_NO_PERMITIDO';

export interface Rechazo {
  readonly codigo: CodigoDeRechazo;
  readonly detalle: string;
}

export type ResultadoDeValidacion =
  | { readonly ok: true; readonly hechosDetectados: readonly string[] }
  | { readonly ok: false; readonly rechazos: readonly Rechazo[] };

// ---------------------------------------------------------------------------
// 3. La validación
// ---------------------------------------------------------------------------

/** Colapsa espacios y saltos para poder comparar texto extraído de HTML. */
export function normalizarTexto(texto: string): string {
  return texto.replace(/\s+/g, ' ').trim();
}

const SONDA: Record<TipoDeHecho, ValorHecho> = {
  BOOLEANO: true,
  TEXTO: '',
  NUMERO: 0,
  IMPORTE: 0n,
};

export function validarReglaParaCarga(
  cruda: unknown,
  contexto: ContextoDeCarga,
): ResultadoDeValidacion {
  const rechazos: Rechazo[] = [];
  const falta = (que: string) =>
    rechazos.push({ codigo: 'FALTA_INFORMACION_OBLIGATORIA', detalle: que });

  if (cruda === null || typeof cruda !== 'object') {
    return { ok: false, rechazos: [{ codigo: 'FALTA_INFORMACION_OBLIGATORIA', detalle: 'El archivo no contiene un objeto' }] };
  }
  const r = cruda as Partial<ReglaDeArchivo>;

  // --- 7. El estado ---------------------------------------------------------
  // Primero, porque es el candado que hace inofensivo todo lo demás: este
  // cargador no tiene forma de insertar una regla activa.
  if (r.estado !== 'DRAFT') {
    rechazos.push({
      codigo: 'ESTADO_NO_PERMITIDO',
      detalle:
        `El archivo declara estado "${String(r.estado)}". El cargador solo admite "DRAFT": ` +
        'activar una regla exige la aprobación del §32 y se hace con `npm run reglas:aprobar`.',
    });
  }

  // --- 2. La estructura -----------------------------------------------------
  const meta = r.regla;
  if (meta === undefined) falta('regla');
  else {
    if (typeof meta.clave !== 'string' || meta.clave.length === 0) falta('regla.clave');
    if (typeof meta.version !== 'number' || meta.version < 1) falta('regla.version');
    if (!['accounting', 'tax', 'disclosure'].includes(String(meta.dominio))) falta('regla.dominio');
    if (typeof meta.jurisdiccion !== 'string' || meta.jurisdiccion.length === 0) falta('regla.jurisdiccion');
    if (typeof meta.prioridad !== 'number') falta('regla.prioridad');
    // Quien propone queda registrado porque la base exige que no sea el mismo
    // que después aprueba: sin proponente, la segregación de funciones no existe.
    if (typeof meta.propuestaPor !== 'string' || meta.propuestaPor.length === 0) falta('regla.propuestaPor');
  }

  // --- 6. La vigencia -------------------------------------------------------
  const vig = r.vigencia;
  if (vig === undefined) falta('vigencia');
  else {
    if (!/^\d{4}-\d{2}-\d{2}$/.test(String(vig.desde))) falta('vigencia.desde (AAAA-MM-DD)');
    if (vig.hasta !== null && !/^\d{4}-\d{2}-\d{2}$/.test(String(vig.hasta))) {
      falta('vigencia.hasta (AAAA-MM-DD o null)');
    }
    // Una fecha sin fundamento es una afirmación sin respaldo, igual que una
    // regla sin cita. El §6 depende de estas fechas.
    if (typeof vig.fundamento !== 'string' || vig.fundamento.trim().length === 0) {
      falta('vigencia.fundamento — de dónde sale la fecha de vigencia');
    }
  }

  // --- 1. La fuente ---------------------------------------------------------
  const fuente = r.fuente;
  if (fuente === undefined) falta('fuente');
  else if (typeof fuente.documento?.sha256 !== 'string' || fuente.documento.sha256.length === 0) {
    falta('fuente.documento.sha256');
  }

  if (contexto.normVersionId === null) {
    rechazos.push({
      codigo: 'NORMA_INEXISTENTE_EN_CORPUS',
      detalle:
        `La norma ${fuente?.organismo ?? '?'} ${fuente?.tipo ?? '?'} ${fuente?.numero ?? '?'}/${fuente?.anio ?? '?'} ` +
        'no está en `norms`. Una regla sin norma cargada no se puede resolver ni citar.',
    });
  }

  // --- SHA-256 --------------------------------------------------------------
  // Se comparan las tres: la que declara el archivo, la registrada en la base y
  // la recalculada del disco. Que dos coincidan y la tercera no es exactamente
  // el caso que este control existe para encontrar.
  const declarado = fuente?.documento?.sha256;
  if (contexto.sha256Calculado === null) {
    rechazos.push({
      codigo: 'SHA256_NO_COINCIDE',
      detalle: 'No se pudo leer el documento archivado para recalcular su hash.',
    });
  } else if (declarado !== undefined) {
    if (declarado !== contexto.sha256Calculado) {
      rechazos.push({
        codigo: 'SHA256_NO_COINCIDE',
        detalle:
          `El archivo declara ${declarado.slice(0, 16)}… y el documento en disco es ` +
          `${contexto.sha256Calculado.slice(0, 16)}…`,
      });
    }
    if (contexto.sha256Registrado !== null && declarado !== contexto.sha256Registrado) {
      rechazos.push({
        codigo: 'SHA256_NO_COINCIDE',
        detalle:
          `El archivo declara ${declarado.slice(0, 16)}… y norm_documents registra ` +
          `${contexto.sha256Registrado.slice(0, 16)}…`,
      });
    }
  }

  // --- 5. La cita -----------------------------------------------------------
  const cita = r.cita;
  if (cita === undefined || typeof cita.texto !== 'string' || cita.texto.trim().length === 0) {
    rechazos.push({
      codigo: 'SIN_CITA',
      detalle: 'La regla no transcribe el fragmento que la funda. Sin cita no hay regla (§30).',
    });
  } else if (typeof cita.articulo !== 'string' || cita.articulo.trim().length === 0) {
    falta('cita.articulo');
  } else if (contexto.textoDelDocumento !== null) {
    const documento = normalizarTexto(contexto.textoDelDocumento);

    // ¿Existe el artículo citado en el documento?
    const patronArticulo = new RegExp(
      `ART[IÍ]CULO\\s*°?\\s*${cita.articulo.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\b`,
      'i',
    );
    if (!patronArticulo.test(documento)) {
      rechazos.push({
        codigo: 'UBICACION_INEXISTENTE',
        detalle: `El documento archivado no contiene un "ARTICULO ${cita.articulo}".`,
      });
    }

    // ¿El texto citado está, literal, en el documento?
    if (!documento.includes(normalizarTexto(cita.texto))) {
      rechazos.push({
        codigo: 'CITA_NO_COINCIDE_CON_DOCUMENTO',
        detalle:
          'El texto citado no aparece literalmente en el documento archivado. ' +
          'Una cita parafraseada es una interpretación disfrazada de transcripción.',
      });
    }
  }

  // --- 4. La acción ---------------------------------------------------------
  const accion = r.accion;
  if (accion === undefined || typeof accion.tipo !== 'string') {
    falta('accion.tipo');
  } else {
    const admitidos = (ACCIONES_SOPORTADAS as Record<string, readonly string[]>)[accion.tipo];
    if (admitidos === undefined) {
      rechazos.push({
        codigo: 'ACCION_NO_SOPORTADA',
        detalle:
          `"${accion.tipo}" no está en el catálogo de acciones. Admitidas: ` +
          `${Object.keys(ACCIONES_SOPORTADAS).join(', ')}.`,
      });
    } else if (!admitidos.includes(accion.resultado)) {
      rechazos.push({
        codigo: 'ACCION_NO_SOPORTADA',
        detalle:
          `La acción "${accion.tipo}" no admite el resultado "${String(accion.resultado)}". ` +
          `Admitidos: ${admitidos.join(', ')}.`,
      });
    }
  }

  // --- 3. Las condiciones ---------------------------------------------------
  const hechosDetectados: string[] = [];
  const cond = r.condiciones;
  if (cond === undefined || cond.ast === undefined) {
    falta('condiciones.ast');
  } else if (!Array.isArray(cond.hechosRequeridos)) {
    falta('condiciones.hechosRequeridos');
  } else {
    const declarados = new Map<string, TipoDeHecho>();
    for (const h of cond.hechosRequeridos) {
      if (typeof h?.campo === 'string' && h.campo.length > 0 && h.tipo in SONDA) {
        declarados.set(h.campo, h.tipo);
      } else {
        falta('condiciones.hechosRequeridos[].campo / .tipo');
      }
    }

    const sonda: Record<string, ValorHecho> = {};
    for (const [campo, tipo] of declarados) sonda[campo] = SONDA[tipo];

    // El árbitro de "esta condición pertenece al intérprete permitido" es el
    // intérprete mismo. Reimplementar acá una validación de la gramática sería
    // tener dos definiciones de lo permitido, y la segunda se desactualiza.
    try {
      evaluar(cond.ast, sonda as Hechos);
      hechosDetectados.push(...declarados.keys());
    } catch (error) {
      if (error instanceof ErrorDeRegla && /no está en el contexto/.test(error.message)) {
        // El AST usa un hecho que la regla no declaró. Es un error del archivo,
        // no del intérprete: se informa aparte para que se entienda cuál.
        rechazos.push({
          codigo: 'HECHO_NO_DECLARADO',
          detalle: `${error.message}. Agregalo a condiciones.hechosRequeridos.`,
        });
      } else {
        rechazos.push({
          codigo: 'CONDICION_FUERA_DEL_INTERPRETE',
          detalle: error instanceof Error ? error.message : String(error),
        });
      }
    }
  }

  if (rechazos.length > 0) return { ok: false, rechazos };
  return { ok: true, hechosDetectados };
}
