/**
 * Sistema de citas (§31).
 *
 * La regla que gobierna este archivo: **una cita que no se puede abrir no es una
 * cita.** Si el nivel de verificación no es `V1` o no hay documento archivado
 * con hash, la UI no muestra la regla como aplicada — muestra
 * `FUENTE NO ENCONTRADA` y deriva a revisión profesional.
 *
 * El hash del documento no es un detalle de implementación: las URLs oficiales
 * cambian de lugar y los organismos reorganizan sus sitios, pero el hash del PDF
 * que el sistema leyó ese día no cambia nunca. La trazabilidad llega al byte,
 * no a la URL.
 */

import { ABSTENTION_MESSAGES } from '@aai/shared';
import type { Cita, VerificationLevel } from './contracts.js';

export interface DocumentoArchivado {
  readonly urlOficial: string;
  readonly archivo: string;
  readonly sha256: string;
  readonly fechaDescarga: string;
}

export interface CitaRenderizada {
  readonly lineas: readonly string[];
  /** `false` cuando la fuente no alcanza para presentar la regla como aplicada. */
  readonly presentable: boolean;
}

const ETIQUETA_NIVEL: Record<VerificationLevel, string> = {
  V1: 'V1 — VERIFICADO OFICIAL',
  V2: 'V2 — referencia oficial sin texto archivado',
  V3: 'V3 — fuente secundaria',
  V4: 'V4 — material explicativo',
};

/**
 * Arma el bloque de cita que ve el contador.
 *
 * Formato fijo y en el mismo orden siempre: quien audita compara citas de
 * distintos meses, y un orden que cambia obliga a leer cada una entera.
 */
export function renderizarCita(
  cita: Cita,
  documento: DocumentoArchivado | null,
  ruleKey?: string,
): CitaRenderizada {
  const presentable = cita.nivelVerificacion === 'V1' && documento !== null;

  if (!presentable) {
    return {
      presentable: false,
      lineas: [
        ABSTENTION_MESSAGES.NO_VERIFICABLE,
        `Nivel: ${ETIQUETA_NIVEL[cita.nivelVerificacion]}`,
        documento === null
          ? 'No hay documento original archivado: la cita no se puede abrir.'
          : 'La fuente no alcanza el nivel V1: no funda una regla activa.',
        'Requiere revisión profesional.',
      ],
    };
  }

  return {
    presentable: true,
    lineas: [
      ...(ruleKey === undefined ? [] : [`Regla aplicada:   ${ruleKey}`]),
      `Fuente:           ${cita.organismo}`,
      `Norma:            ${cita.norma}`,
      `Artículo:         ${cita.articulo ?? '—'}`,
      `Versión:          ${cita.version}`,
      `Vigente desde:    ${formatearFecha(cita.vigenciaDesde)}`,
      `Adoptada en:      ${cita.adoptadaEn ?? '—'}`,
      `URL oficial:      ${documento.urlOficial}`,
      `Documento:        ${documento.archivo} · sha256 ${documento.sha256.slice(0, 12)}…`,
      `Nivel:            ${ETIQUETA_NIVEL[cita.nivelVerificacion]}`,
    ],
  };
}

/** `2024-07-01` → `01/07/2024`. La UI habla en formato argentino. */
function formatearFecha(fecha: string | null): string {
  if (fecha === null) return '—';
  const [anio, mes, dia] = fecha.split('-');
  if (anio === undefined || mes === undefined || dia === undefined) return fecha;
  return `${dia}/${mes}/${anio}`;
}

/**
 * ¿Esta cita habilita presentar la regla como aplicada?
 *
 * Se exporta aparte del render porque quien decide si mostrar la regla no
 * siempre es quien la dibuja, y duplicar la condición en la UI es la forma más
 * simple de que un día se muestre una regla `V3` como si fuera oficial.
 */
export function citaHabilitaAplicacion(
  cita: Cita,
  documento: DocumentoArchivado | null,
): boolean {
  return cita.nivelVerificacion === 'V1' && documento !== null;
}
