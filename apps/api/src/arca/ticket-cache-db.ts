/**
 * La caché de tickets del WSAA **compartida entre procesos**, sobre `arca_access_tickets`.
 *
 * ## El problema
 *
 * El WSAA da **un** ticket por (CUIT, servicio) y **niega el segundo mientras el primero viva** —`coe.alreadyAuthenticated`
 * durante unas doce horas—, y el propio organismo advierte que pedir tickets de más es motivo de bloqueo. Hasta ahora la API
 * pedía uno por consulta: con dos consultas seguidas la segunda fallaba, y con dos instancias corriendo, peor. El CLI
 * ya resolvía esto con una caché en archivo (`TicketCacheFs`); una API con más de un proceso necesita que la caché
 * viva donde viven todos los procesos: la base.
 *
 * ## Qué garantiza
 *
 * - **Un solo login por ticket.** `obtenerOCrear` toma un candado de la base por (ambiente, CUIT, servicio), vuelve a leer
 *   ya con el candado adentro y recién entonces, si hace falta, le pide el ticket al WSAA. Dos procesos simultáneos reciben el
 *   **mismo** ticket; un ticket vencido se renueva **una sola vez**.
 * - **El ambiente es parte de la identidad.** Un ticket de homologación y uno de producción para el mismo CUIT no se
 *   confunden jamás: la instancia fija el ambiente y la tabla lo guarda.
 * - **Un ticket que está por vencer no deja a nadie sin servicio.** Se renueva con margen, pero el WSAA no emite uno nuevo
 *   hasta que el anterior vence de verdad (`alreadyAuthenticated`). Si el pedido de renovación se rechaza por eso y el ticket
 *   guardado todavía sirve, se **usa ese**: lo contrario sería quedarse sin ticket justo en los últimos minutos.
 *
 * ## Lo que se guarda es una credencial
 *
 * `token` y `sign` autorizan a operar ante ARCA en nombre del contribuyente mientras duran (horas). Por eso: **no se
 * loguean nunca**, **no salen por ninguna ruta** y la tabla **no tiene `company_id`**, así que la exportación de una empresa
 * no la alcanza. No es lo mismo que la clave privada —que ni se guarda acá— y vencen solos, pero la copia de seguridad
 * conserva los de las últimas horas: es uno de los motivos por los que las copias están cifradas y fuera de la imagen.
 *
 * ## Por qué vive en `apps/api` y no en `packages/arca`
 *
 * Porque toca la base, y el paquete no puede (`dominio-sin-io`). El paquete sólo define el puerto (`TicketCache`) y el
 * contrato opcional `obtenerOCrear`.
 */

import { WsaaFaultError, type AccessTicket, type ArcaEnvironment, type ServiceName, type TicketCache } from '@aai/arca';
import { withoutCompany, type Tx } from '@aai/db';

/** Quién figura como actor en la sesión de base: no es una persona ni una empresa. */
const ACTOR = 'system:arca-tickets';

/** Se renueva cuando faltan menos de dos minutos: alcanza para terminar un pedido en vuelo, y no obliga a pelear con el WSAA. */
const MARGEN_POR_DEFECTO_MS = 120_000;

/** Un ticket que vence en menos de esto no sirve ni como último recurso: la llamada siguiente ya fallaría. */
const MINIMO_PARA_USAR_MS = 15_000;

/** Cuánto espera el candado antes de rendirse. Pasado esto alguien se quedó colgado y es mejor fallar a quedar esperando. */
const ESPERA_DEL_CANDADO = '45s';

interface FilaDeTicket {
  token: string;
  sign: string;
  generation_time: Date;
  expiration_time: Date;
}

export interface OpcionesDeTicketCacheDb {
  readonly margenMs?: number;
  /** Para las pruebas. */
  readonly ahora?: () => Date;
}

/** El WSAA contesta `coe.alreadyAuthenticated` cuando ya hay un ticket vivo; el prefijo del namespace lo elige el servidor. */
export function esTicketYaEmitido(error: unknown): boolean {
  return error instanceof WsaaFaultError && /(^|:)coe\.alreadyAuthenticated$/u.test(error.code);
}

export class TicketCacheDb implements TicketCache {
  readonly #ambiente: Exclude<ArcaEnvironment, 'mock'>;
  readonly #margenMs: number;
  readonly #ahora: () => Date;

  constructor(ambiente: ArcaEnvironment, opciones: OpcionesDeTicketCacheDb = {}) {
    if (ambiente === 'mock') {
      throw new Error('El ambiente «mock» no tiene tickets: no hay nada que cachear.');
    }
    this.#ambiente = ambiente;
    this.#margenMs = opciones.margenMs ?? MARGEN_POR_DEFECTO_MS;
    this.#ahora = opciones.ahora ?? (() => new Date());
  }

  async #leer(tx: Tx, cuit: string, service: ServiceName): Promise<AccessTicket | null> {
    const r = await tx.query<FilaDeTicket>(
      `SELECT token, sign, generation_time, expiration_time
         FROM arca_access_tickets
        WHERE cuit = $1 AND service = $2 AND environment = $3`,
      [cuit, service, this.#ambiente],
    );
    const fila = r.rows[0];
    if (fila === undefined) return null;
    return {
      token: fila.token,
      sign: fila.sign,
      cuit,
      service,
      generationTime: fila.generation_time,
      expirationTime: fila.expiration_time,
    };
  }

  async #guardar(tx: Tx, ticket: AccessTicket, soloSiEsMasNuevo: boolean): Promise<void> {
    await tx.query(
      `INSERT INTO arca_access_tickets (cuit, service, environment, token, sign, generation_time, expiration_time)
       VALUES ($1, $2, $3, $4, $5, $6, $7)
       ON CONFLICT (cuit, service, environment) DO UPDATE
          SET token = EXCLUDED.token, sign = EXCLUDED.sign,
              generation_time = EXCLUDED.generation_time, expiration_time = EXCLUDED.expiration_time,
              created_at = now()
        ${soloSiEsMasNuevo ? 'WHERE EXCLUDED.expiration_time > arca_access_tickets.expiration_time' : ''}`,
      [ticket.cuit, ticket.service, this.#ambiente, ticket.token, ticket.sign, ticket.generationTime, ticket.expirationTime],
    );
  }

  /** ¿Le queda más de `margen` de vida? */
  #sirve(ticket: AccessTicket, margenMs: number): boolean {
    return ticket.expirationTime.getTime() - this.#ahora().getTime() > margenMs;
  }

  async get(cuit: string, service: ServiceName): Promise<AccessTicket | null> {
    const ticket = await withoutCompany(ACTOR, (tx) => this.#leer(tx, cuit, service));
    return ticket !== null && this.#sirve(ticket, this.#margenMs) ? ticket : null;
  }

  async put(ticket: AccessTicket): Promise<void> {
    // Sólo reemplaza por uno más nuevo: un proceso lento que llega tarde no pisa el ticket que ya renovó otro.
    await withoutCompany(ACTOR, (tx) => this.#guardar(tx, ticket, true));
  }

  async obtenerOCrear(
    cuit: string,
    service: ServiceName,
    crear: () => Promise<AccessTicket>,
  ): Promise<{ ticket: AccessTicket; deLaCache: boolean }> {
    return withoutCompany(ACTOR, async (tx) => {
      await tx.query(`SET LOCAL lock_timeout = '${ESPERA_DEL_CANDADO}'`);
      // El candado se toma ANTES de leer: quien llega segundo espera acá y, al entrar, encuentra lo que escribió el primero.
      await tx.query('SELECT pg_advisory_xact_lock(hashtextextended($1, 0))', [
        `arca-ticket:${this.#ambiente}:${cuit}:${service}`,
      ]);

      const guardado = await this.#leer(tx, cuit, service);
      if (guardado !== null && this.#sirve(guardado, this.#margenMs)) {
        return { ticket: guardado, deLaCache: true };
      }

      try {
        const nuevo = await crear();
        await this.#guardar(tx, nuevo, false);
        return { ticket: nuevo, deLaCache: false };
      } catch (error) {
        // Está por vencer pero todavía vale, y el WSAA no da otro hasta que venza: se usa el que hay.
        if (guardado !== null && esTicketYaEmitido(error) && this.#sirve(guardado, MINIMO_PARA_USAR_MS)) {
          return { ticket: guardado, deLaCache: true };
        }
        throw error;
      }
    });
  }
}
