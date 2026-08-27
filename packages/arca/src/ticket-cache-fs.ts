/**
 * Caché de tickets de acceso en disco.
 *
 * El WSAA **no emite un segundo TA mientras el primero siga vivo**: responde
 * `coe.alreadyAuthenticated` — "El CEE ya posee un TA valido para el acceso al
 * WSN solicitado". El TA dura horas. Sin una caché que sobreviva al proceso,
 * dos comandos seguidos no pueden funcionar: el primero se lleva el ticket y el
 * segundo se queda afuera hasta que venza.
 *
 * `InMemoryTicketCache` no alcanza para eso — muere con el proceso, y el caso
 * que duele es justamente entre procesos. Esta guarda el TA en un archivo.
 *
 * ## Lo que se guarda es una credencial
 *
 * `token` y `sign` autorizan a operar ante ARCA en nombre del contribuyente.
 * Valen, mientras duran, casi lo mismo que la clave privada. Por eso:
 *
 * - §27 del pliego: **nunca dentro del repositorio**. Se verifica y se rechaza,
 *   igual que con el `.crt` — un token commiteado tampoco se des-commitea.
 * - El archivo se crea con permisos `0600`.
 *
 * ## El ambiente es parte de la identidad, no de la clave de búsqueda
 *
 * `TicketCache.get(cuit, service)` no recibe el ambiente, así que el ambiente lo
 * fija la instancia. No es un detalle: un TA de homologación y uno de producción
 * para el mismo `(cuit, servicio)` se verían idénticos en un mapa por clave, y
 * confundirlos significaría operar contra el organismo con el ticket del otro
 * ambiente. Cada ambiente tiene su carpeta.
 */

import { chmodSync, mkdirSync, readFileSync, unlinkSync, writeFileSync } from 'node:fs';
import { isAbsolute, join, relative, resolve } from 'node:path';
import type { AccessTicket, TicketCache } from './credentials.js';
import type { ArcaEnvironment, ServiceName } from './environment.js';

export interface TicketCacheFsOptions {
  /** Carpeta donde viven los tickets. Debe estar fuera del repositorio. */
  readonly directorio: string;
  readonly ambiente: ArcaEnvironment;
  /**
   * Cuánto antes del vencimiento se considera que el ticket ya no sirve.
   *
   * La caché en memoria usa un minuto porque vive dentro de una request. Esta
   * abarca un comando entero: emitir cincuenta comprobantes de a uno lleva
   * minutos, y un TA que vence a mitad del lote produce un error que parece una
   * caída del servicio y no lo es. Diez minutos por defecto.
   */
  readonly margenMs?: number;
  /** Raíz del repositorio, para el control de §27. */
  readonly raizRepositorio?: string;
}

const MARGEN_POR_DEFECTO_MS = 600_000;

/** ¿`candidato` cae adentro de `raiz`? */
export function estaAdentroDe(candidato: string, raiz: string): boolean {
  const rel = relative(resolve(raiz), resolve(candidato));
  return rel === '' || (!rel.startsWith('..') && !isAbsolute(rel));
}

export class TicketCacheFs implements TicketCache {
  readonly #dir: string;
  readonly #margenMs: number;

  constructor(options: TicketCacheFsOptions) {
    const dir = resolve(options.directorio, options.ambiente);

    if (options.raizRepositorio !== undefined && estaAdentroDe(dir, options.raizRepositorio)) {
      throw new Error(
        `La caché de tickets no puede vivir dentro del repositorio (${dir}). ` +
          'Un token de ARCA es una credencial: si se commitea, queda en el historial. ' +
          'Elegí una carpeta fuera del árbol del proyecto.',
      );
    }

    mkdirSync(dir, { recursive: true });
    this.#dir = dir;
    this.#margenMs = options.margenMs ?? MARGEN_POR_DEFECTO_MS;
  }

  get directorio(): string {
    return this.#dir;
  }

  archivoDe(cuit: string, service: ServiceName): string {
    // El CUIT y el servicio ya vienen validados aguas arriba, pero el nombre de
    // archivo se construye igual con una lista blanca: nada que venga de afuera
    // debería poder elegir en qué ruta se escribe.
    const limpio = `${cuit}-${service}`.replace(/[^A-Za-z0-9_-]/g, '_');
    return join(this.#dir, `${limpio}.json`);
  }

  async get(cuit: string, service: ServiceName): Promise<AccessTicket | null> {
    const ruta = this.archivoDe(cuit, service);
    let crudo: string;
    try {
      crudo = readFileSync(ruta, 'utf8');
    } catch {
      return null;
    }

    let ticket: AccessTicket;
    try {
      const datos = JSON.parse(crudo) as Record<string, unknown>;
      ticket = {
        token: String(datos['token']),
        sign: String(datos['sign']),
        cuit: String(datos['cuit']),
        service: datos['service'] as ServiceName,
        generationTime: new Date(String(datos['generationTime'])),
        expirationTime: new Date(String(datos['expirationTime'])),
      };
    } catch {
      // Un archivo ilegible no es motivo para abortar: se descarta y se pide uno
      // nuevo. Si el WSAA contesta `alreadyAuthenticated`, ese error ya explica
      // que hay un TA vivo que perdimos.
      try {
        unlinkSync(ruta);
      } catch {
        /* si tampoco se puede borrar, el `get` siguiente vuelve a intentarlo */
      }
      return null;
    }

    // Un ticket guardado para otro CUIT o servicio en el archivo que no le
    // corresponde es un archivo corrupto, no un acierto de caché.
    if (ticket.cuit !== cuit || ticket.service !== service) return null;
    if (Number.isNaN(ticket.expirationTime.getTime())) return null;
    if (ticket.expirationTime.getTime() - Date.now() < this.#margenMs) return null;

    return ticket;
  }

  async put(ticket: AccessTicket): Promise<void> {
    const ruta = this.archivoDe(ticket.cuit, ticket.service);
    writeFileSync(
      ruta,
      JSON.stringify(
        {
          ...ticket,
          generationTime: ticket.generationTime.toISOString(),
          expirationTime: ticket.expirationTime.toISOString(),
        },
        null,
        2,
      ),
      { encoding: 'utf8', mode: 0o600 },
    );
    try {
      chmodSync(ruta, 0o600);
    } catch {
      /* en Windows el modo es orientativo; el archivo igual queda escrito */
    }
  }
}
