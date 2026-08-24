import type { ArcaClient } from './client.js';
import type { CapabilityStore, CredentialStore, TicketCache } from './credentials.js';
import { NullCredentialStore } from './credentials.js';
import type { ArcaEnvironment } from './environment.js';
import { MockArcaClient } from './mock/mock-client.js';
import { SoapArcaClient } from './soap/soap-client.js';

export interface ArcaClientConfig {
  readonly environment: ArcaEnvironment;
  readonly credentials?: CredentialStore;
  readonly capabilities?: CapabilityStore;
  readonly ticketCache?: TicketCache;
  readonly timeoutMs?: number;
}

/**
 * Elige la implementación según el ambiente.
 *
 * Regla deliberada: **el mock se usa si y solo si el ambiente es `mock`.**
 *
 * La alternativa cómoda sería "si no hay credencial, usá el mock". Es una
 * trampa: una configuración incompleta en producción produciría validaciones
 * fiscales inventadas que el sistema informaría como reales. Prefiere fallar
 * visible — sin credencial, el cliente real devuelve `NO_VERIFICABLE` con
 * motivo `SIN_CREDENCIAL`, y la UI lo muestra como lo que es.
 */
export function createArcaClient(config: ArcaClientConfig): ArcaClient {
  if (config.environment === 'mock') {
    return new MockArcaClient({
      ...(config.credentials ? { credentials: config.credentials } : {}),
      ...(config.capabilities ? { capabilities: config.capabilities } : {}),
    });
  }

  return new SoapArcaClient({
    environment: config.environment,
    credentials: config.credentials ?? new NullCredentialStore(),
    ...(config.capabilities ? { capabilities: config.capabilities } : {}),
    ...(config.ticketCache ? { ticketCache: config.ticketCache } : {}),
    ...(config.timeoutMs !== undefined ? { timeoutMs: config.timeoutMs } : {}),
  });
}

export function parseEnvironment(value: string | undefined): ArcaEnvironment {
  switch (value) {
    case 'produccion':
      return 'produccion';
    case 'homologacion':
      return 'homologacion';
    case 'mock':
    case undefined:
    case '':
      return 'mock';
    default:
      throw new Error(
        `ARCA_ENVIRONMENT inválido: ${JSON.stringify(value)}. Valores: mock | homologacion | produccion`,
      );
  }
}
