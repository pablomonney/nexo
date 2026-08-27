/**
 * Dónde guardan los scripts el ticket de acceso.
 *
 * Los dos comandos que hablan con ARCA (`arca:check` y `comprobantes:generar`)
 * comparten la misma caché a propósito. El WSAA da UN ticket por CUIT y
 * servicio: si cada script tuviera el suyo, verificar la conexión y después
 * generar el lote sería imposible — que es exactamente lo que pasó la primera
 * vez que se corrieron en fila.
 *
 * La ruta se puede fijar con `--ta-cache` o con `ARCA_TA_CACHE`. Por defecto va
 * a `~/.arca/tickets`, fuera del repositorio, porque lo que se guarda ahí es una
 * credencial.
 */

import { homedir } from 'node:os';
import { join } from 'node:path';

export function directorioDeTickets(args) {
  return args.get('ta-cache') ?? process.env.ARCA_TA_CACHE ?? join(homedir(), '.arca', 'tickets');
}

/**
 * Informa de dónde salió el ticket.
 *
 * Que un comando diga "ticket obtenido" cuando en realidad lo sacó de un archivo
 * escrito hace horas oculta justo el dato que hace falta cuando algo no anda: si
 * se habló con ARCA o no.
 */
export function contarDeDondeSalio({ ticket, deLaCache }) {
  const vence = ticket.expirationTime.toISOString();
  const minutos = Math.round((ticket.expirationTime.getTime() - Date.now()) / 60_000);
  return deLaCache
    ? `Ticket reusado de la caché — vence ${vence} (en ${minutos} min)`
    : `Ticket nuevo pedido al WSAA — vence ${vence} (en ${minutos} min)`;
}
