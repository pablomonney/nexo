/**
 * Cliente mock de ARCA.
 *
 * Es el cliente por defecto durante el desarrollo: permite construir y testear
 * todo el pipeline de ingesta, clasificación y validación **sin certificado
 * X.509 y sin tocar la red**.
 *
 * Dos reglas que lo hacen útil de verdad:
 *
 *  1. Es determinístico. La misma entrada da siempre la misma salida, así que
 *     un test que falla, falla siempre.
 *  2. Sabe fallar. Un mock que solo devuelve respuestas felices produce un
 *     sistema que nunca fue probado contra un organismo caído — que es el
 *     estado en el que ARCA está una parte no despreciable del tiempo.
 */

import type { ArcaClient } from '../client.js';
import type { CapabilityStore, CredentialStore } from '../credentials.js';
import { SERVICE_NAMES } from '../environment.js';
import type { ArcaEnvironment } from '../environment.js';
import type {
  ComprobanteAConstatar,
  EstadoServicio,
  ResultadoApocrifo,
  ResultadoConstatacion,
  ResultadoPadron,
} from '../types.js';
import {
  claveComprobante,
  COMPROBANTES_PRUEBA,
  CUIT_PRUEBA,
  ESCENARIOS,
  type EscenarioArca,
} from './fixtures.js';

export interface MockOptions {
  /** Escenario para comprobantes que no estén en el juego de fixtures. */
  readonly escenarioPorDefecto?: EscenarioArca;
  /** Fuerza un escenario para TODA consulta: sirve para probar degradación. */
  readonly forzarEscenario?: EscenarioArca;
  readonly credentials?: CredentialStore;
  readonly capabilities?: CapabilityStore;
  /** Reloj inyectable para que las aserciones sobre fechas sean estables. */
  readonly now?: () => Date;
}

export class MockArcaClient implements ArcaClient {
  readonly environment: ArcaEnvironment = 'mock';

  readonly #escenarios = new Map<string, EscenarioArca>();
  readonly #options: MockOptions;
  readonly #now: () => Date;

  /** Registro de llamadas, para poder afirmar sobre lo que el sistema consultó. */
  readonly llamadas: Array<{ metodo: string; companyId: string; argumento: unknown }> = [];

  constructor(options: MockOptions = {}) {
    this.#options = options;
    this.#now = options.now ?? (() => new Date());

    for (const fixture of COMPROBANTES_PRUEBA) {
      this.#escenarios.set(
        claveComprobante(
          fixture.cuitEmisor,
          fixture.puntoVenta,
          fixture.tipoComprobante,
          fixture.numeroComprobante,
        ),
        fixture.escenario,
      );
    }
  }

  /** Permite a un test definir el resultado de un comprobante puntual. */
  registrarEscenario(clave: string, escenario: EscenarioArca): void {
    this.#escenarios.set(clave, escenario);
  }

  async #verificarAcceso(
    companyId: string,
    servicio: (typeof SERVICE_NAMES)[keyof typeof SERVICE_NAMES],
  ): Promise<'SIN_CREDENCIAL' | 'SERVICIO_NO_HABILITADO' | null> {
    const credentials = this.#options.credentials;
    if (credentials !== undefined) {
      const certificate = await credentials.getCertificate(companyId);
      if (certificate === null) return 'SIN_CREDENCIAL';
    }
    const capabilities = this.#options.capabilities;
    if (capabilities !== undefined && !(await capabilities.isEnabled(companyId, servicio))) {
      return 'SERVICIO_NO_HABILITADO';
    }
    return null;
  }

  async constatarComprobante(
    companyId: string,
    comprobante: ComprobanteAConstatar,
  ): Promise<ResultadoConstatacion> {
    this.llamadas.push({ metodo: 'constatarComprobante', companyId, argumento: comprobante });
    const consultadoEn = this.#now().toISOString();

    const bloqueo = await this.#verificarAcceso(companyId, SERVICE_NAMES.wscdc);
    if (bloqueo !== null) {
      return {
        estado: 'NO_VERIFICABLE',
        observaciones: [],
        errores: [],
        motivoNoVerificable: bloqueo,
        consultadoEn,
        ambiente: this.environment,
      };
    }

    const clave = claveComprobante(
      comprobante.cuitEmisor,
      comprobante.puntoVenta,
      comprobante.tipoComprobante,
      comprobante.numeroComprobante,
    );
    const nombre =
      this.#options.forzarEscenario ??
      this.#escenarios.get(clave) ??
      this.#options.escenarioPorDefecto ??
      'RECHAZADO_INEXISTENTE';
    const escenario = ESCENARIOS[nombre];

    if (escenario.falla !== undefined) {
      return {
        estado: 'NO_VERIFICABLE',
        observaciones: [],
        errores: [],
        motivoNoVerificable: escenario.falla,
        consultadoEn,
        ambiente: this.environment,
      };
    }

    return {
      estado: escenario.resultado === 'A' ? 'APROBADO' : 'RECHAZADO',
      observaciones: escenario.observaciones,
      errores: escenario.errores,
      respuestaCruda: { Resultado: escenario.resultado, escenario: nombre },
      consultadoEn,
      ambiente: this.environment,
    };
  }

  async consultarPadron(companyId: string, cuit: string): Promise<ResultadoPadron> {
    this.llamadas.push({ metodo: 'consultarPadron', companyId, argumento: cuit });
    const consultadoEn = this.#now().toISOString();

    const bloqueo = await this.#verificarAcceso(companyId, SERVICE_NAMES.padronA13);
    if (bloqueo !== null) {
      return { encontrado: false, datos: null, motivoNoVerificable: bloqueo, consultadoEn };
    }

    if (cuit === CUIT_PRUEBA.desconocido) {
      return { encontrado: false, datos: null, consultadoEn };
    }

    return {
      encontrado: true,
      datos: {
        cuit,
        razonSocial: cuit === CUIT_PRUEBA.proveedorApocrifo ? 'PROVEEDOR DUDOSO SRL' : 'PROVEEDOR DE PRUEBA SA',
        estadoClave: 'ACTIVO',
        condicionIva: 'RESPONSABLE_INSCRIPTO',
        domicilioFiscal: 'CIUDAD AUTONOMA DE BUENOS AIRES',
      },
      consultadoEn,
    };
  }

  async consultarApocrifo(companyId: string, cuit: string): Promise<ResultadoApocrifo> {
    this.llamadas.push({ metodo: 'consultarApocrifo', companyId, argumento: cuit });
    const consultadoEn = this.#now().toISOString();

    const bloqueo = await this.#verificarAcceso(companyId, SERVICE_NAMES.wscdc);
    if (bloqueo !== null) {
      // `null` y no `false`: no saber si es apócrifo NO es saber que no lo es.
      return { esApocrifo: null, motivoNoVerificable: bloqueo, consultadoEn };
    }

    return { esApocrifo: cuit === CUIT_PRUEBA.proveedorApocrifo, consultadoEn };
  }

  async estadoServicio(): Promise<EstadoServicio> {
    const caido =
      this.#options.forzarEscenario === 'SERVICIO_CAIDO' ||
      this.#options.forzarEscenario === 'TIMEOUT';
    const estado = caido ? 'ERROR' : 'OK';
    return { appServer: estado, dbServer: estado, authServer: estado, disponible: !caido };
  }
}
