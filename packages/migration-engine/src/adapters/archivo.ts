/**
 * El adaptador genérico de archivos: CSV, XLSX, JSON y XML.
 *
 * ## No lee nada por su cuenta
 *
 * Los lectores ya existen en `@aai/document-engine` —`leerCsv` detecta el
 * separador, `leerXlsx` abre la planilla, `ArchivoZip` la descomprime con
 * límites contra bombas de descompresión— y están probados. Este archivo los
 * conecta al contrato de migración y nada más.
 *
 * ## Por qué JSON y XML terminan en filas y columnas
 *
 * Porque el resto del motor —mapeo, normalización, validación— trabaja sobre
 * tablas, y un JSON de clientes **es** una tabla escrita con llaves. Aplanarlo
 * acá deja un solo pipeline en vez de dos, y el que mira el resultado ve las
 * mismas columnas que vería con un CSV.
 *
 * Lo que no se hace es adivinar estructuras anidadas de profundidad
 * arbitraria: se aplana un nivel, y lo que quede adentro se muestra como texto
 * para que la persona decida. Aplanar tres niveles produce columnas como
 * `items.0.impuestos.1.alicuota`, que no ayudan a nadie.
 */

import { ArchivoZip, leerCsv, leerXlsx, sniff } from '@aai/document-engine';
import type {
  AdaptadorDeOrigen,
  DescripcionDeAdaptador,
  EntradaDeExtraccion,
  ResultadoDeExtraccion,
  TablaCruda,
} from '../contrato.js';
import type { Entidad } from '../canonico.js';
import { adivinarEntidad, comoMapa, sugerirMapeo } from '../mapeo.js';
import { ENTIDADES } from '../canonico.js';

/** Cuántas filas se leen como máximo de un archivo. */
export const TOPE_DE_FILAS = 200_000;

const extensionDe = (nombre: string): string => {
  const punto = nombre.lastIndexOf('.');
  return punto === -1 ? '' : nombre.slice(punto + 1).toLowerCase();
};

/** Un objeto plano, con lo anidado convertido a texto. */
function aplanar(objeto: Record<string, unknown>): Record<string, string> {
  const salida: Record<string, string> = {};
  for (const [clave, valor] of Object.entries(objeto)) {
    if (valor === null || valor === undefined) {
      salida[clave] = '';
      continue;
    }
    if (typeof valor === 'object') {
      // Un nivel más: `cliente.cuit` sí; `cliente.domicilio.calle` queda como
      // texto y lo resuelve quien mapea.
      if (!Array.isArray(valor)) {
        for (const [sub, v] of Object.entries(valor as Record<string, unknown>)) {
          salida[`${clave}.${sub}`] =
            v === null || v === undefined
              ? ''
              : typeof v === 'object'
                ? JSON.stringify(v)
                : String(v);
        }
        continue;
      }
      salida[clave] = JSON.stringify(valor);
      continue;
    }
    salida[clave] = String(valor);
  }
  return salida;
}

/** Convierte una lista de objetos en una tabla con columnas unificadas. */
function comoTabla(nombre: string, objetos: readonly Record<string, unknown>[]): TablaCruda {
  const planos = objetos.map(aplanar);
  // La unión de las claves y no las del primero: un JSON donde el segundo
  // registro trae un campo que el primero no tenía perdería esa columna.
  const columnas = [...new Set(planos.flatMap((p) => Object.keys(p)))];
  return {
    nombre,
    columnas,
    filas: planos.map((p) => columnas.map((c) => p[c] ?? '')),
  };
}

/** Busca dentro de un JSON el primer arreglo de objetos, que es la tabla. */
function tablasDeJson(texto: string, nombre: string): readonly TablaCruda[] {
  const raiz: unknown = JSON.parse(texto);

  if (Array.isArray(raiz)) {
    const objetos = raiz.filter((x): x is Record<string, unknown> => typeof x === 'object' && x !== null);
    return objetos.length === 0 ? [] : [comoTabla(nombre, objetos)];
  }
  if (typeof raiz !== 'object' || raiz === null) return [];

  // Un objeto con varias listas adentro son varias tablas: `{clientes: [...],
  // productos: [...]}` es exactamente cómo exporta la mitad de los sistemas.
  const tablas: TablaCruda[] = [];
  for (const [clave, valor] of Object.entries(raiz as Record<string, unknown>)) {
    if (!Array.isArray(valor)) continue;
    const objetos = valor.filter(
      (x): x is Record<string, unknown> => typeof x === 'object' && x !== null,
    );
    if (objetos.length > 0) tablas.push(comoTabla(clave, objetos));
  }
  return tablas;
}

/**
 * XML a tabla: los hijos repetidos del nodo con más repeticiones son las filas.
 *
 * Se resuelve con expresiones regulares y no con un parser de XML completo
 * porque lo que hace falta es reconocer una lista de elementos hermanos con los
 * mismos hijos, no interpretar espacios de nombres ni entidades. Un parser
 * entero acá sería una dependencia nueva para un problema más chico.
 */
function tablasDeXml(texto: string, nombre: string): readonly TablaCruda[] {
  const etiquetas = [...texto.matchAll(/<([A-Za-z_][\w.-]*)\b[^>]*>/g)].map((m) => m[1]!);
  const cuenta = new Map<string, number>();
  for (const e of etiquetas) cuenta.set(e, (cuenta.get(e) ?? 0) + 1);

  // El elemento que más se repite es la fila. Con **uno solo** no hay nada que
  // se repita, y ese es el caso que hay que atender: un XML de un solo registro
  // es un XML legítimo, y hasta ahora devolvía cero tablas sin decir nada.
  //
  // Cuando ninguno se repite, se toma el que cuelga de la raíz y tiene hijos:
  // es la misma decisión que tomaría cualquiera mirando el archivo. Si eso
  // tampoco existe, se devuelve vacío y el adaptador avisa.
  const repetida =
    [...cuenta.entries()]
      .filter(([, n]) => n > 1)
      .sort((a, b) => b[1] - a[1])[0]?.[0] ?? unicoConHijos(texto);
  if (repetida === undefined) return [];

  const bloques = [...texto.matchAll(new RegExp(`<${repetida}\\b[^>]*>([\\s\\S]*?)</${repetida}>`, 'g'))];
  const objetos = bloques.map((b) => {
    const cuerpo = b[1] ?? '';
    const campos: Record<string, unknown> = {};
    for (const m of cuerpo.matchAll(/<([A-Za-z_][\w.-]*)\b[^>]*>([\s\S]*?)<\/\1>/g)) {
      campos[m[1]!] = desescapar(m[2] ?? '');
    }
    return campos;
  });

  const conCampos = objetos.filter((o) => Object.keys(o).length > 0);
  return conCampos.length === 0 ? [] : [comoTabla(`${nombre}:${repetida}`, conCampos)];
}

/**
 * El elemento que hace de fila cuando hay uno solo.
 *
 * El primer hijo de la raíz que a su vez tenga hijos. `<productos><producto>…`
 * devuelve `producto`, que es lo que un humano diría mirando el archivo.
 */
function unicoConHijos(texto: string): string | undefined {
  const raiz = /<([A-Za-z_][\w.-]*)\b[^>]*>([\s\S]*)<\/\1>/.exec(texto.replace(/<\?[\s\S]*?\?>/g, ''));
  if (raiz === null) return undefined;
  const hijo = /<([A-Za-z_][\w.-]*)\b[^>]*>([\s\S]*?)<\/\1>/.exec(raiz[2] ?? '');
  if (hijo === null) return undefined;
  return /<[A-Za-z_]/.test(hijo[2] ?? '') ? hijo[1] : undefined;
}

const desescapar = (t: string): string =>
  t
    .replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, '$1')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&amp;/g, '&')
    .trim();

const DESCRIPCION: DescripcionDeAdaptador = {
  codigo: 'ARCHIVO_GENERICO',
  nombre: 'Archivo (CSV, XLSX, JSON, XML)',
  medio: 'ARCHIVO',
  estado: 'IMPLEMENTADO',
  capacidades: {
    // Todas: un archivo puede traer cualquier entidad, y qué trae lo decide el
    // mapeo, no el adaptador.
    entidades: [...ENTIDADES],
    formatos: ['csv', 'tsv', 'txt', 'xlsx', 'xls', 'json', 'xml', 'zip'],
    porTandas: false,
    reanudable: false,
    // Depende del archivo: si trae una columna de código, se usa como id
    // externo; si no, la migración se identifica por contenido.
    conIdExterno: false,
  },
};

export class AdaptadorDeArchivo implements AdaptadorDeOrigen {
  readonly descripcion = DESCRIPCION;

  async extraer(entrada: EntradaDeExtraccion): Promise<ResultadoDeExtraccion> {
    const bytes = entrada.bytes;
    const nombre = entrada.nombreArchivo ?? 'archivo';
    if (bytes === undefined) {
      throw new Error('El adaptador de archivo necesita el contenido del archivo');
    }

    const avisos: string[] = [];
    const tablas = await this.#leer(bytes, nombre, avisos);

    const recortadas = tablas.map((t) => {
      if (t.filas.length <= TOPE_DE_FILAS) return t;
      avisos.push(
        `«${t.nombre}» trae ${t.filas.length} filas y se leyeron las primeras ` +
          `${TOPE_DE_FILAS}. El resto queda sin procesar.`,
      );
      return { ...t, filas: t.filas.slice(0, TOPE_DE_FILAS) };
    });

    // Ninguna tabla y ningún aviso es la peor combinación: el archivo entró, no
    // pasó nada, y nadie sabe por qué. Le pasaba a un XML del que no se podía
    // deducir cuál era la fila.
    if (recortadas.length === 0 && avisos.length === 0) {
      avisos.push(
        `«${nombre}» no tiene filas: no se pudo reconocer ninguna tabla adentro. Si es un XML, ` +
          'revisá que los registros cuelguen todos del mismo elemento.',
      );
    }

    for (const t of recortadas) {
      if (t.filas.length === 0) avisos.push(`«${t.nombre}» no tiene filas`);
    }

    return { tablas: recortadas.filter((t) => t.columnas.length > 0), avisos };
  }

  async #leer(bytes: Buffer, nombre: string, avisos: string[]): Promise<readonly TablaCruda[]> {
    const extension = extensionDe(nombre);
    const olfateado = sniff(bytes, nombre);

    for (const riesgo of olfateado.riesgos) {
      avisos.push(`El archivo trae una señal a mirar: ${riesgo.detalle ?? riesgo.codigo}`);
    }

    if (extension === 'json' || olfateado.tipo === 'DESCONOCIDO') {
      const texto = bytes.toString('utf8').trim();
      if (texto.startsWith('{') || texto.startsWith('[')) {
        return tablasDeJson(texto, nombre);
      }
    }
    if (extension === 'xml' || olfateado.tipo === 'XML') {
      return tablasDeXml(bytes.toString('utf8'), nombre);
    }
    if (extension === 'xlsx' || extension === 'xls' || olfateado.tipo === 'XLSX') {
      const t = leerXlsx(bytes);
      return [{ nombre: t.hoja ?? nombre, columnas: t.encabezados, filas: t.filas }];
    }
    if (extension === 'zip') {
      return this.#leerZip(bytes, avisos);
    }

    const t = leerCsv(bytes, entradaSeparador(nombre));
    return [{ nombre, columnas: t.encabezados, filas: t.filas }];
  }

  /** Un ZIP con varios archivos son varias tablas, una por archivo legible. */
  #leerZip(bytes: Buffer, avisos: string[]): readonly TablaCruda[] {
    const zip = new ArchivoZip(bytes);
    const tablas: TablaCruda[] = [];
    for (const nombre of zip.nombres) {
      const extension = extensionDe(nombre);
      if (!['csv', 'tsv', 'txt', 'json', 'xml'].includes(extension)) {
        avisos.push(`«${nombre}» quedó afuera: el ZIP solo se abre para CSV, JSON y XML`);
        continue;
      }
      // `leer` tira si la entrada supera el límite del ZIP; un archivo malo
      // adentro no puede tumbar la lectura de los otros.
      let contenido;
      try {
        contenido = zip.leer(nombre);
      } catch (error) {
        avisos.push(`«${nombre}» no se pudo abrir: ${error instanceof Error ? error.message : String(error)}`);
        continue;
      }
      if (extension === 'json') {
        tablas.push(...tablasDeJson(contenido.toString('utf8'), nombre));
      } else if (extension === 'xml') {
        tablas.push(...tablasDeXml(contenido.toString('utf8'), nombre));
      } else {
        const t = leerCsv(contenido);
        tablas.push({ nombre, columnas: t.encabezados, filas: t.filas });
      }
    }
    return tablas;
  }

  entidadSugerida(tabla: TablaCruda): Entidad | null {
    return adivinarEntidad(tabla.columnas);
  }

  mapeoSugerido(tabla: TablaCruda): Readonly<Record<string, string>> {
    const entidad = adivinarEntidad(tabla.columnas);
    return entidad === null ? {} : comoMapa(sugerirMapeo(entidad, tabla.columnas));
  }
}

/** `.tsv` fuerza el tabulador; el resto lo detecta el lector. */
const entradaSeparador = (nombre: string): string | undefined =>
  extensionDe(nombre) === 'tsv' ? '\t' : undefined;
