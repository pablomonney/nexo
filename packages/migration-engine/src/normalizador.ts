/**
 * De texto crudo a valor canónico, sin perder el original.
 *
 * ## No se escribió un parser nuevo
 *
 * `parseImporteAr` y `parseFechaAr` ya viven en `@aai/document-engine`, ya
 * resuelven los formatos argentinos y —lo que más importa— ya devuelven
 * `AMBIGUO` con los candidatos en vez de elegir por su cuenta. Escribir otro
 * habría creado dos respuestas distintas a «¿cuánto vale este importe?», que es
 * exactamente el defecto que este repositorio persigue.
 *
 * Lo único que agrega este archivo es la parte que el motor de documentos no
 * tenía por qué saber: cómo se llama cada campo canónico y de qué tipo es.
 *
 * ## La ambigüedad no se resuelve adivinando
 *
 * `1,234.56` puede ser mil doscientos treinta y cuatro con cincuenta y seis, o
 * uno coma doscientos treinta y cuatro. Cuando no se puede distinguir, el campo
 * queda en `null` con el motivo escrito y la fila cae en revisión. Elegir una
 * lectura y seguir sería importar un número inventado con cara de dato.
 */

import { parseFechaAr, parseImporteAr } from '@aai/document-engine';
import { isValidCuit, normalizeCuit } from '@aai/shared';
import type { Campo, TipoDeCampo } from './canonico.js';
import { tipoDe } from './canonico.js';

/** Espacios de cualquier clase, incluidos los que mete una planilla. */
const ESPACIOS = /[\s\p{Zs}]+/gu;

const limpiar = (t: string): string => t.replace(ESPACIOS, ' ').trim();

const vacio = <T>(crudo: string): Campo<T> => ({
  crudo,
  valor: null,
  motivo: 'El campo vino vacío',
});

function normalizarCuit(crudo: string): Campo<string> {
  const limpio = normalizeCuit(crudo);
  if (limpio === '') return vacio(crudo);
  if (!isValidCuit(limpio)) {
    // Se conserva el crudo igual: el CUIT mal cargado en el sistema viejo es un
    // dato del sistema viejo, y borrarlo escondería el problema en vez de
    // mostrarlo.
    return { crudo, valor: null, motivo: 'El dígito verificador del CUIT no cierra' };
  }
  return { crudo, valor: limpio };
}

function normalizarFecha(crudo: string): Campo<string> {
  const r = parseFechaAr(crudo);
  if (!r.ok) {
    const candidatos = r.error.candidatos;
    return {
      crudo,
      valor: null,
      motivo:
        candidatos === undefined
          ? r.error.mensaje
          : `${r.error.mensaje}. Puede ser ${candidatos.join(' o ')}: hay que declarar cuál`,
    };
  }
  return { crudo, valor: r.value.fecha };
}

function normalizarImporte(crudo: string): Campo<string> {
  const r = parseImporteAr(crudo);
  if (!r.ok) {
    const candidatos = r.error.candidatos;
    return {
      crudo,
      valor: null,
      motivo:
        candidatos === undefined
          ? r.error.mensaje
          : `${r.error.mensaje}. Puede ser ${candidatos.join(' o ')}: hay que declarar el formato`,
    };
  }
  // Se guarda como texto decimal, no como número de JavaScript: un importe en
  // punto flotante es la forma más silenciosa de perder centavos, y el
  // repositorio entero lo prohíbe.
  return { crudo, valor: r.value.money.amount.toString() };
}

/**
 * Una cantidad no es un importe.
 *
 * Comparte los formatos —miles y decimales— pero admite fracciones que un peso
 * no tiene: 0,5 kilos es una cantidad válida y medio centavo no es un importe.
 * Se reusa el mismo parser y se lee el resultado como número decimal.
 */
function normalizarCantidad(crudo: string): Campo<number> {
  const texto = crudo.trim();
  if (texto === '') return vacio(crudo);

  const r = parseImporteAr(texto);
  if (!r.ok) {
    const candidatos = r.error.candidatos;
    return {
      crudo,
      valor: null,
      motivo:
        candidatos === undefined
          ? r.error.mensaje
          : `${r.error.mensaje}. Puede ser ${candidatos.join(' o ')}`,
    };
  }
  const enPesos = Number(r.value.money.amount) / 100;
  return { crudo, valor: enPesos };
}

function normalizarEntero(crudo: string): Campo<number> {
  const texto = crudo.trim();
  if (texto === '') return vacio(crudo);
  if (!/^-?\d+$/.test(texto)) {
    return { crudo, valor: null, motivo: 'No es un número entero' };
  }
  return { crudo, valor: Number(texto) };
}

const VERDADEROS = new Set(['si', 'sí', 's', 'true', 'verdadero', '1', 'x', 'yes']);
const FALSOS = new Set(['no', 'n', 'false', 'falso', '0', '']);

function normalizarBooleano(crudo: string): Campo<boolean> {
  const t = limpiar(crudo).toLowerCase();
  if (VERDADEROS.has(t)) return { crudo, valor: true };
  if (FALSOS.has(t)) return { crudo, valor: false };
  return { crudo, valor: null, motivo: 'No se entiende como sí o no' };
}

function normalizarTexto(crudo: string): Campo<string> {
  const t = limpiar(crudo);
  return t === '' ? vacio(crudo) : { crudo, valor: t };
}

/** Normaliza un valor según el tipo que le corresponde a su campo canónico. */
export function normalizar(campo: string, crudo: string): Campo<unknown> {
  const tipo: TipoDeCampo = tipoDe(campo);
  switch (tipo) {
    case 'CUIT':
      return normalizarCuit(crudo);
    case 'FECHA':
      return normalizarFecha(crudo);
    case 'IMPORTE':
      return normalizarImporte(crudo);
    case 'CANTIDAD':
      return normalizarCantidad(crudo);
    case 'ENTERO':
      return normalizarEntero(crudo);
    case 'BOOLEANO':
      return normalizarBooleano(crudo);
    case 'TEXTO':
      return normalizarTexto(crudo);
  }
}

/** Normaliza una fila entera contra un mapeo columna→campo canónico. */
export function normalizarFila(
  columnas: readonly string[],
  valores: readonly string[],
  mapeo: Readonly<Record<string, string>>,
): Readonly<Record<string, Campo<unknown>>> {
  const salida: Record<string, Campo<unknown>> = {};
  for (const [i, columna] of columnas.entries()) {
    const canonico = mapeo[columna];
    if (canonico === undefined || canonico === '') continue;
    salida[canonico] = normalizar(canonico, valores[i] ?? '');
  }
  return salida;
}
