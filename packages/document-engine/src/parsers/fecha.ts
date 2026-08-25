/**
 * Interpretación de fechas leídas de un documento.
 *
 * Una fecha mal leída no produce un número raro: produce un comprobante
 * imputado a otro período. En IVA eso significa una declaración jurada mal
 * presentada y, si el período ya venció, una rectificativa. Por eso este parser
 * es igual de terco que el de importes.
 *
 * Formatos que resuelve, y por qué cada uno es inequívoco:
 *
 * | Entrada       | Resultado    | Por qué |
 * |---------------|--------------|---------|
 * | `05/03/2026`  | 2026-03-05   | Convención argentina: día primero |
 * | `2026-03-05`  | 2026-03-05   | Primer grupo de 4 dígitos: ISO 8601 |
 * | `20260305`    | 2026-03-05   | Formato de los servicios de ARCA (AAAAMMDD) |
 * | `05/03/26`    | 2026-03-05   | Año de dos dígitos: se interpreta y **se anota** |
 * | `12/25/2026`  | **abstiene** | 25 no es un mes: el documento no usa formato argentino |
 * | `31/02/2026`  | **abstiene** | Febrero no tiene 31 días |
 *
 * El caso `12/25/2026` es el importante. Intercambiar día y mes en silencio
 * porque "se ve que está al revés" es exactamente cómo un comprobante de
 * diciembre termina imputado en enero.
 */

import type { CalendarDate, Result } from '@aai/shared';
import { calendarDate, daysInMonth, err, ok } from '@aai/shared';
import type { ErrorParseo } from './importe.js';

export interface FechaInterpretada {
  readonly fecha: CalendarDate;
  readonly confianza: number;
  readonly nota?: string;
}

const MESES: Record<string, number> = {
  ene: 1, enero: 1,
  feb: 2, febrero: 2,
  mar: 3, marzo: 3,
  abr: 4, abril: 4,
  may: 5, mayo: 5,
  jun: 6, junio: 6,
  jul: 7, julio: 7,
  ago: 8, agosto: 8,
  sep: 9, sept: 9, septiembre: 9, setiembre: 9,
  oct: 10, octubre: 10,
  nov: 11, noviembre: 11,
  dic: 12, diciembre: 12,
};

export interface OpcionesFecha {
  /** Año de referencia para resolver los de dos dígitos. Por defecto, el actual. */
  readonly anioReferencia?: number;
}

export function parseFechaAr(
  entrada: string,
  opciones: OpcionesFecha = {},
): Result<FechaInterpretada, ErrorParseo> {
  const texto = entrada.trim().replace(/\s+/g, ' ');
  if (texto.length === 0) return err({ codigo: 'VACIO', mensaje: 'El campo está vacío' });

  // AAAAMMDD compacto — el que usan los web services de ARCA.
  const compacto = /^(\d{4})(\d{2})(\d{2})$/.exec(texto);
  if (compacto !== null) {
    return construir(
      Number(compacto[1]),
      Number(compacto[2]),
      Number(compacto[3]),
      1,
      undefined,
      entrada,
    );
  }

  // ISO 8601 — el primer grupo de cuatro dígitos no deja lugar a dudas.
  const iso = /^(\d{4})[-/.](\d{1,2})[-/.](\d{1,2})$/.exec(texto);
  if (iso !== null) {
    return construir(Number(iso[1]), Number(iso[2]), Number(iso[3]), 1, undefined, entrada);
  }

  // `5 de marzo de 2026`, `05-mar-2026`, `5 mar 26`
  const conMes = /^(\d{1,2})[\s./-]+(?:de\s+)?([A-Za-zÁÉÍÓÚáéíóúñÑ]{3,10})\.?[\s./-]+(?:de\s+)?(\d{2,4})$/.exec(texto);
  if (conMes !== null) {
    const clave = normalizarMes(conMes[2]!);
    const mes = MESES[clave];
    if (mes === undefined) {
      return err({
        codigo: 'FORMATO_INVALIDO',
        mensaje: `"${entrada}": "${conMes[2]}" no es un mes reconocible`,
      });
    }
    const anio = resolverAnio(conMes[3]!, opciones);
    return construir(anio.valor, mes, Number(conMes[1]), 1, anio.nota, entrada);
  }

  // dd/mm/aaaa y variantes. Convención argentina: día primero.
  const numerico = /^(\d{1,2})[-/.](\d{1,2})[-/.](\d{2,4})$/.exec(texto);
  if (numerico !== null) {
    const primero = Number(numerico[1]);
    const segundo = Number(numerico[2]);
    const anio = resolverAnio(numerico[3]!, opciones);

    if (segundo > 12) {
      // El segundo grupo no puede ser un mes. Si el primero sí lo es, el
      // documento viene en mm/dd —formato anglosajón—, y darlo vuelta en
      // silencio movería el comprobante de mes. Se abstiene.
      const sugerencia =
        primero >= 1 && primero <= 12
          ? ` Podría estar en formato mm/dd/aaaa, que daría ${anio.valor}-${pad(primero)}-${pad(segundo)}, pero el sistema no lo asume.`
          : '';
      return err({
        codigo: 'FORMATO_INVALIDO',
        mensaje: `"${entrada}" no es una fecha en formato argentino: ${segundo} no es un mes.${sugerencia}`,
      });
    }

    return construir(anio.valor, segundo, primero, 1, anio.nota, entrada);
  }

  return err({
    codigo: 'FORMATO_INVALIDO',
    mensaje: `"${entrada}" no tiene forma de fecha`,
  });
}

function normalizarMes(texto: string): string {
  // NFD separa la tilde de la letra; `\p{Diacritic}` la borra. Así "Setiembre",
  // "SETIEMBRE" y "setiémbre" caen en la misma clave.
  return texto
    .toLowerCase()
    .normalize('NFD')
    .replace(/\p{Diacritic}/gu, '');
}

function pad(valor: number): string {
  return String(valor).padStart(2, '0');
}

interface AnioResuelto {
  readonly valor: number;
  readonly nota?: string;
}

/**
 * Resuelve un año de dos dígitos.
 *
 * Interpretar `26` como 2026 es una interpretación, no una invención: el valor
 * original sigue guardado en `rawValue`, y la nota deja constancia del supuesto.
 * La ventana es de un año hacia adelante —hay comprobantes con fecha futura por
 * error de carga, pero no de veinte años—.
 */
function resolverAnio(bruto: string, opciones: OpcionesFecha): AnioResuelto {
  if (bruto.length === 4) return { valor: Number(bruto) };
  const referencia = opciones.anioReferencia ?? new Date().getUTCFullYear();
  const siglo = Math.floor(referencia / 100) * 100;
  const candidato = siglo + Number(bruto);
  const valor = candidato > referencia + 1 ? candidato - 100 : candidato;
  return {
    valor,
    nota: `Año de dos dígitos ("${bruto}") interpretado como ${valor}`,
  };
}

function construir(
  anio: number,
  mes: number,
  dia: number,
  confianza: number,
  nota: string | undefined,
  entrada: string,
): Result<FechaInterpretada, ErrorParseo> {
  if (mes < 1 || mes > 12) {
    return err({ codigo: 'FORMATO_INVALIDO', mensaje: `"${entrada}": ${mes} no es un mes` });
  }
  if (dia < 1 || dia > daysInMonth(anio, mes)) {
    return err({
      codigo: 'FORMATO_INVALIDO',
      mensaje: `"${entrada}": el ${dia} no existe en el mes ${pad(mes)}/${anio}`,
    });
  }
  // Rango de cordura. Una fecha de 1912 en un comprobante es un OCR que leyó mal
  // el año, no un documento centenario.
  if (anio < 1990 || anio > 2100) {
    return err({
      codigo: 'FORMATO_INVALIDO',
      mensaje: `"${entrada}": el año ${anio} está fuera del rango razonable para un comprobante`,
    });
  }
  return ok({
    fecha: calendarDate(anio, mes, dia),
    confianza: nota === undefined ? confianza : Math.min(confianza, 0.85),
    ...(nota !== undefined ? { nota } : {}),
  });
}
