/**
 * Arma un ZIP mínimo, para que las pruebas puedan construir el archivo que sube
 * una empresa real.
 *
 * Una exportación completa no es un CSV: son diez, uno por entidad, dentro de un
 * ZIP. Probar la migración con un archivo por vez no ejercita lo que de verdad
 * importa —el orden entre entidades, la resolución de referencias entre ellas—,
 * y guardar un `.zip` binario en el repositorio esconde su contenido.
 *
 * Escribe con **método 0**, sin comprimir. `ArchivoZip` lo lee, el archivo es
 * determinista byte a byte, y no hace falta ninguna dependencia nueva.
 */

const LOCAL = 0x04034b50;
const CENTRAL = 0x02014b50;
const EOCD = 0x06054b50;

/** El CRC-32 que exige el formato. Tabla armada una vez. */
const TABLA = (() => {
  const t = new Uint32Array(256);
  for (let i = 0; i < 256; i += 1) {
    let c = i;
    for (let k = 0; k < 8; k += 1) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[i] = c >>> 0;
  }
  return t;
})();

function crc32(datos: Buffer): number {
  let c = 0xffffffff;
  for (const byte of datos) c = TABLA[(c ^ byte) & 0xff]! ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

export function armarZip(entradas: Readonly<Record<string, string>>): Buffer {
  const locales: Buffer[] = [];
  const centrales: Buffer[] = [];
  let offset = 0;

  for (const [nombre, contenido] of Object.entries(entradas)) {
    const datos = Buffer.from(contenido, 'utf8');
    const nombreBytes = Buffer.from(nombre, 'utf8');
    const suma = crc32(datos);

    const local = Buffer.alloc(30 + nombreBytes.length);
    local.writeUInt32LE(LOCAL, 0);
    local.writeUInt16LE(20, 4); // versión necesaria
    local.writeUInt16LE(0, 6); // sin descriptor de datos
    local.writeUInt16LE(0, 8); // método 0: sin comprimir
    local.writeUInt16LE(0, 10); // hora
    local.writeUInt16LE(0x21, 12); // fecha: 1980-01-01, fija para que sea determinista
    local.writeUInt32LE(suma, 14);
    local.writeUInt32LE(datos.length, 18);
    local.writeUInt32LE(datos.length, 22);
    local.writeUInt16LE(nombreBytes.length, 26);
    local.writeUInt16LE(0, 28);
    nombreBytes.copy(local, 30);

    const central = Buffer.alloc(46 + nombreBytes.length);
    central.writeUInt32LE(CENTRAL, 0);
    central.writeUInt16LE(20, 4);
    central.writeUInt16LE(20, 6);
    central.writeUInt16LE(0, 8);
    central.writeUInt16LE(0, 10);
    central.writeUInt16LE(0, 12);
    central.writeUInt16LE(0x21, 14);
    central.writeUInt32LE(suma, 16);
    central.writeUInt32LE(datos.length, 20);
    central.writeUInt32LE(datos.length, 24);
    central.writeUInt16LE(nombreBytes.length, 28);
    central.writeUInt16LE(0, 30);
    central.writeUInt16LE(0, 32);
    central.writeUInt16LE(0, 34);
    central.writeUInt16LE(0, 36);
    central.writeUInt32LE(0, 38);
    central.writeUInt32LE(offset, 42);
    nombreBytes.copy(central, 46);

    locales.push(local, datos);
    centrales.push(central);
    offset += local.length + datos.length;
  }

  const directorio = Buffer.concat(centrales);
  const fin = Buffer.alloc(22);
  fin.writeUInt32LE(EOCD, 0);
  fin.writeUInt16LE(0, 4);
  fin.writeUInt16LE(0, 6);
  fin.writeUInt16LE(centrales.length, 8);
  fin.writeUInt16LE(centrales.length, 10);
  fin.writeUInt32LE(directorio.length, 12);
  fin.writeUInt32LE(offset, 16);
  fin.writeUInt16LE(0, 20);

  return Buffer.concat([...locales, directorio, fin]);
}
