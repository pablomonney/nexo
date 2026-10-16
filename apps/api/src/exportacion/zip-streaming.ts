/**
 * Un escritor de ZIP que se escribe de a pedazos, sin dependencias y sin guardar nada en disco.
 *
 * ## Por qué existe
 *
 * La exportación completa de una empresa no entra en memoria (el Mayor de una empresa grande son millones de líneas) ni
 * conviene dejarla en un archivo temporal (el contenedor de producción tiene el sistema de archivos de solo lectura). Así
 * que se arma el ZIP mientras se lee la base y cada pedazo sale hacia el cliente apenas existe.
 *
 * ## Cómo
 *
 * Método 0 (sin comprimir) y **descriptor de datos** (bit 3): como no se sabe el tamaño ni el CRC de una entrada hasta
 * terminarla, la cabecera local va con ceros y los valores reales vienen justo después de los datos y, definitivos, en el
 * directorio central que cierra el archivo. Es lo que hace cualquier productor en streaming, y lo lee el lector del
 * repositorio (`ArchivoZip` lee el directorio central), `tar` y los programas de ZIP comunes. Los nombres van en UTF-8
 * (bit 11).
 *
 * Sin compresión a propósito: el contenido es texto de filas (se comprime bien afuera, con cualquier herramienta) y los
 * archivos adjuntos ya vienen comprimidos (PDF, JPG). Comprimir acá sumaría CPU del servidor de producción por nada.
 *
 * ## Lo que NO hace
 *
 * No es ZIP64: una entrada de más de 4 GiB, un archivo de más de 4 GiB o más de 65.535 entradas **no se pueden escribir**
 * y la exportación falla con un error que lo dice (`LIMITE_DE_ZIP`) en vez de producir un archivo que algunos programas
 * leerían mal. Una empresa que llegue a ese tamaño necesita una exportación por lotes, que es otra decisión.
 */

import { createHash } from 'node:crypto';
import { crc32 } from 'node:zlib';

const LOCAL = 0x04034b50;
const DESCRIPTOR = 0x08074b50;
const CENTRAL = 0x02014b50;
const EOCD = 0x06054b50;

/** UTF-8 (bit 11) + descriptor de datos (bit 3). */
const FLAGS = 0x0808;
const MAX_32 = 0xffffffff;
const MAX_ENTRADAS = 0xffff;

export class ErrorDeLimiteDeZip extends Error {
  readonly codigo = 'LIMITE_DE_ZIP';
}

export interface EntradaEscrita {
  readonly nombre: string;
  readonly bytes: number;
  readonly crc32: number;
  readonly sha256: string;
}

/** Hacia dónde salen los bytes. Devuelve cuando el pedazo fue aceptado (así se respeta la contrapresión). */
export type Sumidero = (pedazo: Buffer) => Promise<void>;

/**
 * La fecha de cada entrada es siempre la misma (1980-01-01 00:00, el origen del formato DOS): **no se lee el reloj**. La
 * fecha real de la exportación está en el manifiesto (`generadoEn`, que sale de la base) y un ZIP con la misma entrada da
 * los mismos bytes: se puede comparar y probar sin depender de la hora.
 */
const FECHA_DOS = { hora: 0, dia: (0 << 9) | (1 << 5) | 1 };

export class EscritorZip {
  readonly #sumidero: Sumidero;
  readonly #fecha = FECHA_DOS;
  readonly #entradas: { entrada: EntradaEscrita; offset: number }[] = [];
  #offset = 0;
  #cerrado = false;

  constructor(sumidero: Sumidero) {
    this.#sumidero = sumidero;
  }

  get entradas(): readonly EntradaEscrita[] {
    return this.#entradas.map((e) => e.entrada);
  }

  async #emitir(pedazo: Buffer): Promise<void> {
    this.#offset += pedazo.length;
    if (this.#offset > MAX_32) throw new ErrorDeLimiteDeZip('El archivo supera los 4 GiB que admite este formato.');
    await this.#sumidero(pedazo);
  }

  /**
   * Agrega una entrada. `contenido` puede ser un buffer o un iterable asíncrono de pedazos: éste último es lo que permite
   * escribir una tabla de millones de filas sin tenerla entera en memoria.
   */
  async agregar(nombre: string, contenido: Buffer | AsyncIterable<Buffer>): Promise<EntradaEscrita> {
    if (this.#cerrado) throw new Error('El ZIP ya se cerró.');
    if (this.#entradas.length >= MAX_ENTRADAS) {
      throw new ErrorDeLimiteDeZip('El archivo supera las 65.535 entradas que admite este formato.');
    }
    if (nombre.includes('..') || nombre.startsWith('/') || nombre.includes('\\')) {
      throw new Error(`Nombre de entrada no permitido: "${nombre}"`);
    }

    const nombreBytes = Buffer.from(nombre, 'utf8');
    const offsetLocal = this.#offset;

    const cabecera = Buffer.alloc(30 + nombreBytes.length);
    cabecera.writeUInt32LE(LOCAL, 0);
    cabecera.writeUInt16LE(20, 4); // versión necesaria
    cabecera.writeUInt16LE(FLAGS, 6);
    cabecera.writeUInt16LE(0, 8); // método 0: sin comprimir
    cabecera.writeUInt16LE(this.#fecha.hora, 10);
    cabecera.writeUInt16LE(this.#fecha.dia, 12);
    // crc y tamaños en cero: van en el descriptor.
    cabecera.writeUInt16LE(nombreBytes.length, 26);
    nombreBytes.copy(cabecera, 30);
    await this.#emitir(cabecera);

    let crc = 0;
    let bytes = 0;
    const sha = createHash('sha256');
    const pasar = async (pedazo: Buffer): Promise<void> => {
      if (pedazo.length === 0) return;
      crc = crc32(pedazo, crc);
      sha.update(pedazo);
      bytes += pedazo.length;
      if (bytes > MAX_32) throw new ErrorDeLimiteDeZip(`"${nombre}" supera los 4 GiB que admite este formato.`);
      await this.#emitir(pedazo);
    };

    if (Buffer.isBuffer(contenido)) await pasar(contenido);
    else for await (const pedazo of contenido) await pasar(pedazo);

    const descriptor = Buffer.alloc(16);
    descriptor.writeUInt32LE(DESCRIPTOR, 0);
    descriptor.writeUInt32LE(crc >>> 0, 4);
    descriptor.writeUInt32LE(bytes, 8);
    descriptor.writeUInt32LE(bytes, 12);
    await this.#emitir(descriptor);

    const entrada: EntradaEscrita = { nombre, bytes, crc32: crc >>> 0, sha256: sha.digest('hex') };
    this.#entradas.push({ entrada, offset: offsetLocal });
    return entrada;
  }

  /** Escribe el directorio central y cierra. Sin esto el archivo no es un ZIP. */
  async cerrar(): Promise<void> {
    if (this.#cerrado) return;
    this.#cerrado = true;

    const inicioCentral = this.#offset;
    let tamanoCentral = 0;
    for (const { entrada, offset } of this.#entradas) {
      const nombreBytes = Buffer.from(entrada.nombre, 'utf8');
      const central = Buffer.alloc(46 + nombreBytes.length);
      central.writeUInt32LE(CENTRAL, 0);
      central.writeUInt16LE(20, 4); // versión que lo hizo
      central.writeUInt16LE(20, 6); // versión necesaria
      central.writeUInt16LE(FLAGS, 8);
      central.writeUInt16LE(0, 10);
      central.writeUInt16LE(this.#fecha.hora, 12);
      central.writeUInt16LE(this.#fecha.dia, 14);
      central.writeUInt32LE(entrada.crc32, 16);
      central.writeUInt32LE(entrada.bytes, 20);
      central.writeUInt32LE(entrada.bytes, 24);
      central.writeUInt16LE(nombreBytes.length, 28);
      central.writeUInt32LE(offset, 42);
      nombreBytes.copy(central, 46);
      tamanoCentral += central.length;
      await this.#emitir(central);
    }

    const fin = Buffer.alloc(22);
    fin.writeUInt32LE(EOCD, 0);
    fin.writeUInt16LE(this.#entradas.length, 8);
    fin.writeUInt16LE(this.#entradas.length, 10);
    fin.writeUInt32LE(tamanoCentral, 12);
    fin.writeUInt32LE(inicioCentral, 16);
    await this.#emitir(fin);
  }
}
