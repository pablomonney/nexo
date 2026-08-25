/**
 * Lector mínimo de ZIP, para abrir planillas XLSX sin sumar una dependencia.
 *
 * Se lee el **directorio central**, no las cabeceras locales. La diferencia
 * importa: cuando el productor usa descriptor de datos (bit 3 del flag), la
 * cabecera local trae los tamaños en cero y hay que buscarlos más adelante. El
 * directorio central siempre los tiene bien, y es lo que hace cualquier
 * implementación seria.
 *
 * Dos límites explícitos, porque estos archivos llegan por mail desde terceros:
 * un tope de tamaño descomprimido total y un tope por entrada. Un ZIP de 40 KB
 * que se expande a 4 GB es un ataque conocido, no una hipótesis.
 */

import { inflateRawSync } from 'node:zlib';

const EOCD_SIG = 0x06054b50;
const CENTRAL_SIG = 0x02014b50;
const LOCAL_SIG = 0x04034b50;

export interface LimitesZip {
  readonly maxTotalDescomprimido: number;
  readonly maxPorEntrada: number;
  readonly maxEntradas: number;
}

export const LIMITES_ZIP: LimitesZip = {
  maxTotalDescomprimido: 256 * 1024 * 1024,
  maxPorEntrada: 64 * 1024 * 1024,
  maxEntradas: 4096,
};

interface EntradaCentral {
  readonly nombre: string;
  readonly metodo: number;
  readonly comprimido: number;
  readonly descomprimido: number;
  readonly offsetLocal: number;
}

export class ArchivoZip {
  readonly #bytes: Buffer;
  readonly #entradas: Map<string, EntradaCentral>;
  readonly #limites: LimitesZip;

  constructor(bytes: Buffer, limites: LimitesZip = LIMITES_ZIP) {
    this.#bytes = bytes;
    this.#limites = limites;
    this.#entradas = leerDirectorioCentral(bytes, limites);
  }

  get nombres(): readonly string[] {
    return [...this.#entradas.keys()];
  }

  tiene(nombre: string): boolean {
    return this.#entradas.has(nombre);
  }

  leer(nombre: string): Buffer {
    const entrada = this.#entradas.get(nombre);
    if (entrada === undefined) throw new Error(`El ZIP no contiene "${nombre}"`);
    if (entrada.descomprimido > this.#limites.maxPorEntrada) {
      throw new Error(`"${nombre}" supera el tamaño máximo por entrada`);
    }

    const cabecera = entrada.offsetLocal;
    if (this.#bytes.readUInt32LE(cabecera) !== LOCAL_SIG) {
      throw new Error(`Cabecera local inválida para "${nombre}"`);
    }
    const largoNombre = this.#bytes.readUInt16LE(cabecera + 26);
    const largoExtra = this.#bytes.readUInt16LE(cabecera + 28);
    const inicio = cabecera + 30 + largoNombre + largoExtra;
    const datos = this.#bytes.subarray(inicio, inicio + entrada.comprimido);

    if (entrada.metodo === 0) return Buffer.from(datos);
    if (entrada.metodo === 8) {
      const salida = inflateRawSync(datos, { maxOutputLength: this.#limites.maxPorEntrada });
      return salida;
    }
    throw new Error(`Método de compresión ${entrada.metodo} no soportado en "${nombre}"`);
  }
}

function leerDirectorioCentral(bytes: Buffer, limites: LimitesZip): Map<string, EntradaCentral> {
  const eocd = buscarEocd(bytes);
  if (eocd === -1) throw new Error('No es un ZIP válido: falta el fin del directorio central');

  const cantidad = bytes.readUInt16LE(eocd + 10);
  let offset = bytes.readUInt32LE(eocd + 16);

  if (cantidad > limites.maxEntradas) {
    throw new Error(`El ZIP declara ${cantidad} entradas: supera el máximo permitido`);
  }

  const entradas = new Map<string, EntradaCentral>();
  let totalDescomprimido = 0;

  for (let i = 0; i < cantidad; i += 1) {
    if (offset + 46 > bytes.length || bytes.readUInt32LE(offset) !== CENTRAL_SIG) {
      throw new Error('Directorio central corrupto');
    }
    const metodo = bytes.readUInt16LE(offset + 10);
    const comprimido = bytes.readUInt32LE(offset + 20);
    const descomprimido = bytes.readUInt32LE(offset + 24);
    const largoNombre = bytes.readUInt16LE(offset + 28);
    const largoExtra = bytes.readUInt16LE(offset + 30);
    const largoComentario = bytes.readUInt16LE(offset + 32);
    const offsetLocal = bytes.readUInt32LE(offset + 42);
    const nombre = bytes.subarray(offset + 46, offset + 46 + largoNombre).toString('utf8');

    totalDescomprimido += descomprimido;
    if (totalDescomprimido > limites.maxTotalDescomprimido) {
      throw new Error('El ZIP se expande por encima del límite permitido');
    }
    // Una entrada que apunta fuera del archivo, o un nombre con travesía, es un
    // ZIP construido a mano: no se procesa.
    if (offsetLocal + 30 > bytes.length) throw new Error(`Entrada "${nombre}" fuera de rango`);
    if (nombre.includes('..') || nombre.startsWith('/')) {
      throw new Error(`Entrada con nombre sospechoso: "${nombre}"`);
    }

    entradas.set(nombre, { nombre, metodo, comprimido, descomprimido, offsetLocal });
    offset += 46 + largoNombre + largoExtra + largoComentario;
  }

  return entradas;
}

function buscarEocd(bytes: Buffer): number {
  const minimo = Math.max(0, bytes.length - (0xffff + 22));
  for (let i = bytes.length - 22; i >= minimo; i -= 1) {
    if (bytes.readUInt32LE(i) === EOCD_SIG) return i;
  }
  return -1;
}
