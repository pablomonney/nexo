/**
 * Interpretación de importes leídos de un documento.
 *
 * Este archivo existe por un error concreto que cuesta mucho: leer `1.234` como
 * mil doscientos treinta y cuatro cuando el documento decía uno coma doscientos
 * treinta y cuatro, o al revés. Es un error de tres órdenes de magnitud que no
 * rompe nada —el asiento cierra igual, el IVA cuadra igual— y aparece recién
 * cuando alguien mira el mayor de un proveedor.
 *
 * La regla, que es el §52 aplicado donde muerde: **ante ambigüedad real, se
 * abstiene**. Devolver un error obliga al contador a mirar un campo; elegir por
 * él produce un número plausible y equivocado que nadie va a mirar nunca.
 *
 * Convenciones que sí se resuelven sin preguntar, porque no son ambiguas:
 *
 * | Entrada        | Resultado    | Por qué |
 * |----------------|--------------|---------|
 * | `1.234,56`     | 1234.56      | Hay ambos separadores: el último es el decimal |
 * | `1,234.56`     | 1234.56      | Ídem, formato anglosajón |
 * | `12.345.678`   | 12345678     | Tres o más grupos de 3: solo puede ser miles |
 * | `1.234`        | **abstiene** | Puede ser 1234 (miles) o 1,234 (decimal) |
 * | `1.23`         | 1.23         | Dos dígitos no forman un grupo de miles |
 * | `(1.234,56)`   | -1234.56     | Paréntesis contables |
 */

import type { Currency, Money, Result } from '@aai/shared';
import { err, moneyFromDecimalString, ok } from '@aai/shared';

export type CodigoErrorParseo =
  | 'VACIO'
  | 'SIN_DIGITOS'
  | 'AMBIGUO'
  | 'DECIMALES_EXCEDIDOS'
  | 'FORMATO_INVALIDO';

export interface ErrorParseo {
  readonly codigo: CodigoErrorParseo;
  readonly mensaje: string;
  /** Cuando es ambiguo: las lecturas posibles, para que la UI las ofrezca. */
  readonly candidatos?: readonly string[];
}

export interface ImporteInterpretado {
  readonly money: Money;
  /** Confianza de la *interpretación*, independiente de la de la lectura. */
  readonly confianza: number;
  readonly nota?: string;
}

/**
 * Espacios de cualquier clase. `\p{Zs}` cubre los que un PDF mete entre los
 * miles —duro, fino, de agrupación— sin dejar caracteres invisibles en el
 * código fuente, que es como estos bugs se vuelven imposibles de ver en un diff.
 */
const ESPACIOS = /[\s\p{Zs}]/gu;
const SIGNOS_MONEDA = /(?:^|\b)(?:AR\$|US\$|U\$S|USD|ARS|EUR|R\$|\$|€|£)/gi;

export function parseImporteAr(
  entrada: string,
  currency: Currency = 'ARS',
): Result<ImporteInterpretado, ErrorParseo> {
  if (entrada.trim().length === 0) {
    return err({ codigo: 'VACIO', mensaje: 'El campo está vacío' });
  }

  let texto = entrada.replace(ESPACIOS, '').replace(SIGNOS_MONEDA, '');

  // Negativos: signo adelante, signo atrás o paréntesis contables.
  let negativo = false;
  if (/^\(.*\)$/.test(texto)) {
    negativo = true;
    texto = texto.slice(1, -1);
  }
  // `\p{Pd}` son los guiones (‐ – —) y `−` el signo menos tipográfico, que
  // no es el guion ASCII aunque se le parezca en pantalla.
  texto = texto.replace(/[\p{Pd}−]/gu, '-');
  if (texto.startsWith('-')) {
    negativo = !negativo;
    texto = texto.slice(1);
  } else if (texto.endsWith('-')) {
    negativo = !negativo;
    texto = texto.slice(0, -1);
  }
  texto = texto.replace(/^\+/, '');

  if (!/\d/.test(texto)) {
    return err({ codigo: 'SIN_DIGITOS', mensaje: `"${entrada}" no contiene dígitos` });
  }
  if (!/^[0-9.,]+$/.test(texto)) {
    return err({
      codigo: 'FORMATO_INVALIDO',
      mensaje: `"${entrada}" tiene caracteres que no forman parte de un importe`,
    });
  }

  const resuelto = resolverSeparadores(texto);
  if (!resuelto.ok) return resuelto;

  const { entero, decimales, confianza, nota } = resuelto.value;

  if (decimales.length > 2) {
    // Un total con más de dos decimales no es un total: es un precio unitario o
    // una lectura mal segmentada. Redondear acá escondería cuál de las dos.
    return err({
      codigo: 'DECIMALES_EXCEDIDOS',
      mensaje: `"${entrada}" tiene ${decimales.length} decimales. Redondear es una decisión contable, no de lectura.`,
    });
  }

  const decimal = `${negativo ? '-' : ''}${entero}${decimales.length > 0 ? `.${decimales}` : ''}`;
  try {
    return ok({
      money: moneyFromDecimalString(decimal, currency),
      confianza,
      ...(nota !== undefined ? { nota } : {}),
    });
  } catch (error) {
    return err({
      codigo: 'FORMATO_INVALIDO',
      mensaje: error instanceof Error ? error.message : 'Importe inválido',
    });
  }
}

interface Separado {
  readonly entero: string;
  readonly decimales: string;
  readonly confianza: number;
  readonly nota?: string;
}

function resolverSeparadores(texto: string): Result<Separado, ErrorParseo> {
  const puntos = (texto.match(/\./g) ?? []).length;
  const comas = (texto.match(/,/g) ?? []).length;

  if (puntos === 0 && comas === 0) {
    return ok({ entero: texto, decimales: '', confianza: 1 });
  }

  // Ambos separadores presentes: el último es el decimal. No hay ambigüedad
  // posible, porque ninguna convención usa el mismo símbolo para las dos cosas.
  if (puntos > 0 && comas > 0) {
    const ultimoPunto = texto.lastIndexOf('.');
    const ultimaComa = texto.lastIndexOf(',');
    const decimalSep = ultimoPunto > ultimaComa ? '.' : ',';
    const milesSep = decimalSep === '.' ? ',' : '.';
    const partes = texto.split(decimalSep);
    if (partes.length > 2) {
      return err({
        codigo: 'FORMATO_INVALIDO',
        mensaje: `"${texto}" repite el separador decimal`,
      });
    }
    const entero = partes[0]!.split(milesSep).join('');
    if (!/^\d+$/.test(entero) || !/^\d+$/.test(partes[1]!)) {
      return err({ codigo: 'FORMATO_INVALIDO', mensaje: `"${texto}" no es un importe válido` });
    }
    return ok({ entero, decimales: partes[1]!, confianza: 1 });
  }

  // Un solo tipo de separador. Acá vive la ambigüedad.
  const sep = puntos > 0 ? '.' : ',';
  const veces = puntos > 0 ? puntos : comas;
  const grupos = texto.split(sep);
  if (grupos.some((grupo) => grupo.length === 0)) {
    return err({ codigo: 'FORMATO_INVALIDO', mensaje: `"${texto}" tiene un separador suelto` });
  }
  const ultimo = grupos[grupos.length - 1]!;

  // Dos o más separadores solo pueden ser miles: `1.234.567`. Y para serlo, todos
  // los grupos salvo el primero deben tener exactamente 3 dígitos.
  if (veces >= 2) {
    const bienFormado = grupos.slice(1).every((grupo) => /^\d{3}$/.test(grupo));
    if (!bienFormado) {
      return err({
        codigo: 'FORMATO_INVALIDO',
        mensaje: `"${texto}" usa "${sep}" varias veces pero no agrupa de a tres`,
      });
    }
    return ok({ entero: grupos.join(''), decimales: '', confianza: 1 });
  }

  // Un solo separador. Tres casos.
  if (ultimo.length !== 3) {
    // No puede ser un grupo de miles: es decimal, sin ambigüedad.
    return ok({ entero: grupos[0]!, decimales: ultimo, confianza: 1 });
  }

  // Tres dígitos después del separador: `1.234` o `1,234`.
  //
  // Podría ser mil doscientos treinta y cuatro, o uno con tres decimales. Las dos
  // lecturas son legítimas y difieren en mil veces. No se elige.
  const comoMiles = grupos.join('');
  const comoDecimal = `${grupos[0]}.${ultimo}`;
  return err({
    codigo: 'AMBIGUO',
    mensaje:
      `"${texto}" puede leerse como ${comoMiles} (separador de miles) o como ` +
      `${comoDecimal} (separador decimal). El sistema no elige por el contador.`,
    candidatos: [comoMiles, comoDecimal],
  });
}

/**
 * Variante para cuando otro campo del mismo documento resuelve la ambigüedad.
 *
 * Ejemplo real: el total dice `1.234` y el neto dice `1.019,83` con IVA `214,17`.
 * La suma sólo cierra si el total es 1234. Ahí la ambigüedad la resuelve la
 * aritmética del comprobante, no una preferencia del parser — y por eso la
 * decisión queda registrada en la nota del campo.
 */
export function desambiguarPorControl(
  entrada: string,
  esperado: Money,
  currency: Currency = 'ARS',
): Result<ImporteInterpretado, ErrorParseo> {
  const directo = parseImporteAr(entrada, currency);
  if (directo.ok) return directo;
  if (directo.error.codigo !== 'AMBIGUO' || directo.error.candidatos === undefined) return directo;

  for (const candidato of directo.error.candidatos) {
    let money: Money;
    try {
      money = moneyFromDecimalString(candidato, currency);
    } catch {
      continue;
    }
    if (money.amount === esperado.amount) {
      return ok({
        money,
        // No llega a 1: la lectura sigue siendo ambigua; lo que la resuelve es
        // una comprobación externa, y eso vale menos que un campo inequívoco.
        confianza: 0.9,
        nota: `Lectura ambigua resuelta por control aritmético del comprobante (candidatos: ${directo.error.candidatos.join(' | ')})`,
      });
    }
  }
  return directo;
}
