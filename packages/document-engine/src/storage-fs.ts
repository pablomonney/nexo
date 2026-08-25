/**
 * Store en filesystem, para desarrollo local y para instalaciones on-premise.
 *
 * En producción sobre object storage la implementación cambia; el contrato no.
 * La única regla que este archivo agrega es la que el filesystem hace fácil
 * romper: **la ruta se deriva de la clave validada, nunca de una entrada del
 * usuario**, y se comprueba que el resultado siga dentro del directorio raíz.
 */

import { mkdir, readFile, stat, writeFile } from 'node:fs/promises';
import { dirname, join, resolve, sep } from 'node:path';
import { claveDe, claveEsDeEmpresa, type DocumentStore } from './storage.js';

export class FilesystemDocumentStore implements DocumentStore {
  readonly #raiz: string;

  constructor(raiz: string) {
    this.#raiz = resolve(raiz);
  }

  #rutaDe(companyId: string, storageKey: string): string {
    if (!claveEsDeEmpresa(companyId, storageKey)) {
      throw new Error('La clave no pertenece a la empresa en contexto');
    }
    const ruta = resolve(join(this.#raiz, storageKey));
    // Cinturón y tirantes: `claveEsDeEmpresa` ya rechaza travesías, pero un
    // cambio futuro en el formato de clave no puede convertirse en escritura
    // fuera del directorio raíz.
    if (!ruta.startsWith(this.#raiz + sep)) throw new Error('Ruta fuera del directorio raíz');
    return ruta;
  }

  async put(companyId: string, sha256: string, extension: string, bytes: Buffer): Promise<string> {
    const key = claveDe(companyId, sha256, extension);
    const ruta = this.#rutaDe(companyId, key);
    if (await existe(ruta)) return key; // mismo contenido: ya está archivado
    await mkdir(dirname(ruta), { recursive: true });
    await writeFile(ruta, bytes, { flag: 'wx' }).catch(async (error: NodeJS.ErrnoException) => {
      // `wx` falla si otro proceso lo escribió en el intervalo. Como el nombre es
      // el hash del contenido, ese archivo es idéntico: no hay nada que hacer.
      if (error.code !== 'EEXIST') throw error;
    });
    return key;
  }

  async get(companyId: string, storageKey: string): Promise<Buffer> {
    return readFile(this.#rutaDe(companyId, storageKey));
  }

  async has(companyId: string, storageKey: string): Promise<boolean> {
    try {
      return await existe(this.#rutaDe(companyId, storageKey));
    } catch {
      return false;
    }
  }
}

async function existe(ruta: string): Promise<boolean> {
  try {
    await stat(ruta);
    return true;
  } catch {
    return false;
  }
}
