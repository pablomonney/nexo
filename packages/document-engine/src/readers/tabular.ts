/**
 * Lectura de CSV y XLSX: extractos bancarios, exportaciones de sistemas de
 * gestión, subdiarios.
 *
 * Hay una decisión acá que parece un detalle y no lo es: **los valores se
 * devuelven siempre como texto**. Nunca se llama a `Number()`.
 *
 * En un XLSX el importe está guardado como `<v>1234.56</v>`, que es texto
 * decimal. Convertirlo a `number` para después volver a moneda lo haría pasar
 * por un flotante binario —el mismo motivo por el que `Money` usa `bigint`— y
 * un `0.1 + 0.2` metido en un extracto bancario no se nota hasta la
 * conciliación. Se conserva el texto y lo interpreta `parseImporteAr`.
 *
 * El corolario incómodo, que conviene mirar de frente: si el sistema que generó
 * la planilla ya escribió `1234.5599999999999`, la precisión se perdió antes de
 * llegar acá. El parser lo va a rechazar por exceso de decimales, y eso está
 * bien: es exactamente la señal de que el origen del dato tiene un problema.
 */

import { ArchivoZip } from './zip.js';

export interface TablaLeida {
  readonly encabezados: readonly string[];
  readonly filas: readonly (readonly string[])[];
  readonly separador?: string;
  readonly hoja?: string;
}

// ---------------------------------------------------------------------------
// CSV
// ---------------------------------------------------------------------------

const SEPARADORES = [';', ',', '\t', '|'] as const;

export function leerCsv(bytes: Buffer, separadorForzado?: string): TablaLeida {
  const texto = sinBom(decodificar(bytes));
  const separador = separadorForzado ?? detectarSeparador(texto);
  const filas = parsearCsv(texto, separador);
  if (filas.length === 0) return { encabezados: [], filas: [], separador };
  return { encabezados: filas[0]!, filas: filas.slice(1), separador };
}

/**
 * Los CSV argentinos suelen venir con `;` justamente porque la coma es el
 * separador decimal. Elegir mal parte cada importe en dos columnas.
 */
function detectarSeparador(texto: string): string {
  const lineas = texto
    .split(/\r?\n/)
    .filter((linea) => linea.trim().length > 0)
    .slice(0, 10);
  if (lineas.length === 0) return ',';

  let mejor = ',';
  let mejorPuntaje = -1;
  for (const separador of SEPARADORES) {
    const cuentas = lineas.map((linea) => parsearLinea(linea, separador).length);
    const primera = cuentas[0]!;
    if (primera < 2) continue;
    const consistente = cuentas.every((cuenta) => cuenta === primera);
    const puntaje = (consistente ? 1000 : 0) + primera;
    if (puntaje > mejorPuntaje) {
      mejorPuntaje = puntaje;
      mejor = separador;
    }
  }
  return mejor;
}

function parsearCsv(texto: string, separador: string): string[][] {
  const filas: string[][] = [];
  let campo = '';
  let fila: string[] = [];
  let enComillas = false;

  for (let i = 0; i < texto.length; i += 1) {
    const caracter = texto[i]!;

    if (enComillas) {
      if (caracter === '"') {
        if (texto[i + 1] === '"') {
          campo += '"';
          i += 1;
        } else {
          enComillas = false;
        }
      } else {
        campo += caracter;
      }
      continue;
    }

    if (caracter === '"' && campo.length === 0) {
      enComillas = true;
    } else if (caracter === separador) {
      fila.push(campo);
      campo = '';
    } else if (caracter === '\n') {
      fila.push(campo.replace(/\r$/, ''));
      filas.push(fila);
      fila = [];
      campo = '';
    } else {
      campo += caracter;
    }
  }

  if (campo.length > 0 || fila.length > 0) {
    fila.push(campo.replace(/\r$/, ''));
    filas.push(fila);
  }

  return filas.filter((f) => f.some((valor) => valor.trim().length > 0));
}

function parsearLinea(linea: string, separador: string): string[] {
  return parsearCsv(linea, separador)[0] ?? [];
}

/** BOM al principio de un CSV: Excel lo escribe siempre, y rompe el primer encabezado. */
const BOM = 0xfeff;

export function sinBom(texto: string): string {
  return texto.charCodeAt(0) === BOM ? texto.slice(1) : texto;
}

function decodificar(bytes: Buffer): string {
  const utf8 = bytes.toString('utf8');
  // Los exports de sistemas viejos vienen en Latin-1: si UTF-8 produce
  // caracteres de reemplazo, la lectura correcta es la otra.
  return utf8.includes('�') ? bytes.toString('latin1') : utf8;
}

// ---------------------------------------------------------------------------
// XLSX
// ---------------------------------------------------------------------------

export function leerXlsx(bytes: Buffer): TablaLeida {
  const zip = new ArchivoZip(bytes);

  const nombreHoja =
    zip.nombres.find((nombre) => /^xl\/worksheets\/sheet1\.xml$/.test(nombre)) ??
    zip.nombres.find((nombre) => /^xl\/worksheets\/.+\.xml$/.test(nombre));
  if (nombreHoja === undefined) throw new Error('El XLSX no contiene ninguna hoja');

  const compartidas = zip.tiene('xl/sharedStrings.xml')
    ? leerCadenasCompartidas(zip.leer('xl/sharedStrings.xml').toString('utf8'))
    : [];

  const filas = leerHoja(zip.leer(nombreHoja).toString('utf8'), compartidas);
  if (filas.length === 0) return { encabezados: [], filas: [], hoja: nombreHoja };
  return { encabezados: filas[0]!, filas: filas.slice(1), hoja: nombreHoja };
}

function leerCadenasCompartidas(xml: string): string[] {
  const cadenas: string[] = [];
  for (const item of xml.match(/<si\b[\s\S]*?<\/si>/g) ?? []) {
    // Un `si` puede tener varios `t` cuando la celda mezcla formatos.
    const partes = [...item.matchAll(/<t\b[^>]*>([\s\S]*?)<\/t>/g)].map((m) =>
      desescapar(m[1] ?? ''),
    );
    cadenas.push(partes.join(''));
  }
  return cadenas;
}

function leerHoja(xml: string, compartidas: readonly string[]): string[][] {
  const filas: string[][] = [];

  for (const filaXml of xml.match(/<row\b[\s\S]*?<\/row>/g) ?? []) {
    const celdas = new Map<number, string>();
    let maximo = -1;

    for (const celdaMatch of filaXml.matchAll(/<c\b([^>]*)(?:\/>|>([\s\S]*?)<\/c>)/g)) {
      const atributos = celdaMatch[1] ?? '';
      const cuerpo = celdaMatch[2] ?? '';
      const referencia = /r="([A-Z]+)\d+"/.exec(atributos)?.[1];
      const columna = referencia === undefined ? maximo + 1 : columnaDeLetras(referencia);
      const tipo = /t="([^"]+)"/.exec(atributos)?.[1];

      let valor: string;
      if (tipo === 'inlineStr') {
        valor = [...cuerpo.matchAll(/<t\b[^>]*>([\s\S]*?)<\/t>/g)]
          .map((m) => desescapar(m[1] ?? ''))
          .join('');
      } else {
        const crudo = desescapar(/<v>([\s\S]*?)<\/v>/.exec(cuerpo)?.[1] ?? '');
        if (tipo === 's') {
          // Índice a la tabla de cadenas compartidas. Este sí es un entero.
          const indice = Number.parseInt(crudo, 10);
          valor = Number.isNaN(indice) ? '' : (compartidas[indice] ?? '');
        } else {
          // Numérico, fecha serial o booleano: se deja el texto tal cual. La
          // interpretación es de los parsers, no de este lector.
          valor = crudo;
        }
      }

      celdas.set(columna, valor);
      if (columna > maximo) maximo = columna;
    }

    const fila: string[] = [];
    for (let i = 0; i <= maximo; i += 1) fila.push(celdas.get(i) ?? '');
    if (fila.some((valor) => valor.trim().length > 0)) filas.push(fila);
  }

  return filas;
}

function columnaDeLetras(letras: string): number {
  let valor = 0;
  for (const letra of letras) valor = valor * 26 + (letra.charCodeAt(0) - 64);
  return valor - 1;
}

function desescapar(texto: string): string {
  return texto
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&#(\d+);/g, (_, codigo: string) => String.fromCodePoint(Number.parseInt(codigo, 10)))
    .replace(/&amp;/g, '&');
}
