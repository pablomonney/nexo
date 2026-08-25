/**
 * Almacenamiento de documentos — tercera capa de aislamiento multiempresa
 * (SECURITY.md §4, después de RLS y de `withCompany`).
 *
 * Dos decisiones que conviene entender antes de tocar este archivo:
 *
 * **La clave la construye el store, no el que llama.** Si un handler pudiera
 * pasar una clave arbitraria, el aislamiento por empresa dependería de que ese
 * handler no tenga bugs. Acá la clave se deriva de `(companyId, sha256)` y toda
 * lectura verifica que la clave pertenezca a la empresa en contexto.
 *
 * **La deduplicación es por empresa, nunca global.** Un almacén direccionado por
 * contenido a nivel sistema ahorraría bytes, pero haría que subir un archivo
 * revelara si otra empresa ya lo tenía —un canal lateral suficiente para saber
 * si un competidor es cliente del mismo estudio, o si dos empresas comparten
 * proveedor—. Se paga el duplicado.
 */

export interface DocumentStore {
  put(companyId: string, sha256: string, extension: string, bytes: Buffer): Promise<string>;
  get(companyId: string, storageKey: string): Promise<Buffer>;
  has(companyId: string, storageKey: string): Promise<boolean>;
}

const HEX_64 = /^[0-9a-f]{64}$/;
const UUID = /^[0-9a-f-]{36}$/i;
const EXTENSION = /^[a-z0-9]{1,8}$/;

export function claveDe(companyId: string, sha256: string, extension: string): string {
  if (!UUID.test(companyId)) throw new Error('companyId inválido');
  if (!HEX_64.test(sha256)) throw new Error('sha256 inválido');
  const ext = extension.toLowerCase();
  if (!EXTENSION.test(ext)) throw new Error('extensión inválida');
  // Los dos primeros bytes del hash abren el árbol: un directorio con cien mil
  // archivos planos es un problema operativo en cualquier filesystem.
  return `empresa/${companyId.toLowerCase()}/${sha256.slice(0, 2)}/${sha256}.${ext}`;
}

/**
 * Comprueba que la clave corresponda a la empresa en contexto.
 *
 * Se llama en cada lectura. Una clave viajada por parámetro desde el cliente
 * —aunque hoy ningún endpoint lo permita— no puede alcanzar el archivo de otra
 * empresa.
 */
export function claveEsDeEmpresa(companyId: string, storageKey: string): boolean {
  if (!UUID.test(companyId)) return false;
  const prefijo = `empresa/${companyId.toLowerCase()}/`;
  if (!storageKey.startsWith(prefijo)) return false;
  // Sin travesías: ni `..`, ni barra invertida, ni segmentos vacíos.
  const resto = storageKey.slice(prefijo.length);
  return /^[0-9a-f]{2}\/[0-9a-f]{64}\.[a-z0-9]{1,8}$/.test(resto);
}

export const EXTENSION_POR_TIPO: Record<string, string> = {
  PDF: 'pdf',
  JPEG: 'jpg',
  PNG: 'png',
  XML: 'xml',
  CSV: 'csv',
  XLSX: 'xlsx',
  DESCONOCIDO: 'bin',
};

// ---------------------------------------------------------------------------
// Implementaciones
// ---------------------------------------------------------------------------

/** Para tests y para el desarrollo local sin filesystem. */
export class InMemoryDocumentStore implements DocumentStore {
  readonly #objetos = new Map<string, Buffer>();

  async put(companyId: string, sha256: string, extension: string, bytes: Buffer): Promise<string> {
    const key = claveDe(companyId, sha256, extension);
    // Idempotente: el mismo contenido en la misma empresa es el mismo objeto.
    if (!this.#objetos.has(key)) this.#objetos.set(key, Buffer.from(bytes));
    return key;
  }

  async get(companyId: string, storageKey: string): Promise<Buffer> {
    if (!claveEsDeEmpresa(companyId, storageKey)) {
      throw new Error('La clave no pertenece a la empresa en contexto');
    }
    const bytes = this.#objetos.get(storageKey);
    if (bytes === undefined) throw new Error('Objeto inexistente');
    return bytes;
  }

  async has(companyId: string, storageKey: string): Promise<boolean> {
    return claveEsDeEmpresa(companyId, storageKey) && this.#objetos.has(storageKey);
  }

  get tamaño(): number {
    return this.#objetos.size;
  }
}
