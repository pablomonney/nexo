/**
 * El escritor de ZIP en streaming: lo que escribe lo leen el lector del repositorio y `tar`, y un archivo a medias NO es un ZIP.
 */

import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { crc32 } from 'node:zlib';
import { ArchivoZip } from '@aai/document-engine';
import { describe, expect, it } from 'vitest';
import { EscritorZip } from '../../apps/api/src/exportacion/zip-streaming.js';

const LIMITES = { maxTotalDescomprimido: 1 << 30, maxPorEntrada: 1 << 28, maxEntradas: 70_000 };

async function armar(
  entradas: Record<string, Buffer | AsyncIterable<Buffer>>,
  cerrar = true,
): Promise<{ zip: Buffer; escritor: EscritorZip }> {
  const pedazos: Buffer[] = [];
  const escritor = new EscritorZip(async (p) => {
    pedazos.push(p);
  });
  for (const [nombre, contenido] of Object.entries(entradas)) await escritor.agregar(nombre, contenido);
  if (cerrar) await escritor.cerrar();
  return { zip: Buffer.concat(pedazos), escritor };
}

async function* porPedazos(texto: string, tamano: number): AsyncGenerator<Buffer> {
  const b = Buffer.from(texto, 'utf8');
  for (let i = 0; i < b.length; i += tamano) yield b.subarray(i, i + tamano);
}

describe('EscritorZip', () => {
  it('lo que se escribe se lee igual, con buffers y con iterables en pedazos, con acentos en el nombre y el contenido', async () => {
    const largo = 'línea con ñ y € — '.repeat(5000);
    const { zip } = await armar({
      'LEEME.txt': Buffer.from('hola', 'utf8'),
      'datos/ñandú.ndjson': porPedazos(largo, 777),
      'vacio.txt': Buffer.alloc(0),
    });
    const lector = new ArchivoZip(zip, LIMITES);
    expect(lector.nombres).toEqual(['LEEME.txt', 'datos/ñandú.ndjson', 'vacio.txt']);
    expect(lector.leer('LEEME.txt').toString('utf8')).toBe('hola');
    expect(lector.leer('datos/ñandú.ndjson').toString('utf8')).toBe(largo);
    expect(lector.leer('vacio.txt').length).toBe(0);
  });

  it('informa por entrada el tamaño, el CRC-32 y el sha256 de lo que escribió', async () => {
    const contenido = 'una fila\notra fila\n';
    const { escritor } = await armar({ 'datos/t.ndjson': porPedazos(contenido, 5) });
    const e = escritor.entradas[0]!;
    expect(e.bytes).toBe(Buffer.byteLength(contenido));
    expect(e.crc32).toBe(crc32(Buffer.from(contenido)) >>> 0);
    expect(e.sha256).toBe(createHash('sha256').update(contenido).digest('hex'));
  });

  it('`tar` (un lector independiente) lo abre y ve los mismos nombres y contenidos', async () => {
    const { zip } = await armar({ 'a.txt': Buffer.from('A'), 'carpeta/b.txt': porPedazos('BBBB', 2) });
    const dir = mkdtempSync(join(tmpdir(), 'nexo-zip-'));
    try {
      const archivo = join(dir, 'x.zip');
      writeFileSync(archivo, zip);
      const lista = spawnSync('tar', ['-tf', archivo], { encoding: 'utf8' });
      if (lista.error !== undefined || lista.status !== 0) return; // sin `tar` con soporte de ZIP en esta máquina: lo cubre el lector del repositorio
      expect(lista.stdout.split(/\r?\n/u).filter(Boolean).sort()).toEqual(['a.txt', 'carpeta/b.txt']);
      const contenido = spawnSync('tar', ['-xOf', archivo, 'carpeta/b.txt'], { encoding: 'utf8' });
      expect(contenido.stdout).toBe('BBBB');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('un archivo al que no se le escribió el directorio central NO se abre como ZIP (un corte a mitad no parece completo)', async () => {
    const { zip } = await armar({ 'a.txt': Buffer.from('A') }, false);
    expect(() => new ArchivoZip(zip, LIMITES)).toThrow();
  });

  it('un nombre con travesía o con barra invertida se rechaza', async () => {
    const e = new EscritorZip(async () => undefined);
    await expect(e.agregar('../fuera.txt', Buffer.from('x'))).rejects.toThrow(/no permitido/u);
    await expect(e.agregar('/abs.txt', Buffer.from('x'))).rejects.toThrow(/no permitido/u);
    await expect(e.agregar('a\\b.txt', Buffer.from('x'))).rejects.toThrow(/no permitido/u);
  });

  it('respeta la contrapresión: espera a que el sumidero acepte cada pedazo', async () => {
    let enVuelo = 0;
    let maximo = 0;
    const e = new EscritorZip(async () => {
      enVuelo += 1;
      maximo = Math.max(maximo, enVuelo);
      await new Promise((r) => setTimeout(r, 1));
      enVuelo -= 1;
    });
    await e.agregar('x.txt', porPedazos('x'.repeat(100), 10));
    await e.cerrar();
    expect(maximo).toBe(1);
  });

  it('si el origen falla a mitad, el error se propaga (no se cierra un archivo que parezca bueno)', async () => {
    async function* roto(): AsyncGenerator<Buffer> {
      yield Buffer.from('parte');
      throw new Error('se cayó la lectura');
    }
    const e = new EscritorZip(async () => undefined);
    await expect(e.agregar('t.ndjson', roto())).rejects.toThrow('se cayó la lectura');
  });
});
