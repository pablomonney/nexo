/**
 * Cliente SOAP del WSFEv1 — solo lo necesario para emitir un lote de prueba.
 *
 * Tres operaciones de las veintidós que publica el servicio: `FEDummy` para
 * saber si está vivo, `FECompUltimoAutorizado` para saber por dónde seguir la
 * numeración, y `FECAESolicitar` para pedir el CAE. Las otras diecinueve no se
 * implementan porque no hacen falta, y un cliente que expone operaciones que
 * nadie probó es un cliente que miente sobre lo que sabe hacer.
 *
 * El sobre XML se arma a mano, igual que en `@aai/arca`: la alternativa era
 * sumar un stack SOAP entero para tres llamadas cuyo contrato ya está archivado.
 */

import { XMLParser } from 'fast-xml-parser';
import type {
  Autenticacion,
  CabeceraLote,
  DetalleComprobante,
  ErrorArca,
  Observacion,
  RespuestaComprobante,
  RespuestaLote,
} from './contracts.js';
import type { PermisoDeEmision } from './homologacion.js';

const NS = 'http://ar.gov.afip.dif.FEV1/';

/** El permiso ya verificado. No se puede fabricar fuera de `homologacion.ts`. */
type PermisoConcedido = Extract<PermisoDeEmision, { permitido: true }>;

export interface OpcionesWsfev1 {
  readonly permiso: PermisoConcedido;
  readonly fetchImpl?: typeof fetch;
}

const parser = new XMLParser({
  ignoreAttributes: true,
  parseTagValue: false,
  removeNSPrefix: true,
});

export class ClienteWsfev1 {
  readonly #endpoint: string;
  readonly #fetch: typeof fetch;

  constructor(opciones: OpcionesWsfev1) {
    // El endpoint sale del permiso, no de un parámetro. Si viniera aparte, el
    // candado verificaría una URL y el cliente podría usar otra.
    this.#endpoint = opciones.permiso.endpoint;
    this.#fetch = opciones.fetchImpl ?? fetch;
  }

  async #llamar(operacion: string, cuerpo: string): Promise<Record<string, unknown>> {
    const sobre =
      '<?xml version="1.0" encoding="UTF-8"?>' +
      '<soap:Envelope xmlns:soap="http://schemas.xmlsoap.org/soap/envelope/" ' +
      `xmlns:ar="${NS}"><soap:Header/><soap:Body>` +
      `<ar:${operacion}>${cuerpo}</ar:${operacion}>` +
      '</soap:Body></soap:Envelope>';

    const respuesta = await this.#fetch(this.#endpoint, {
      method: 'POST',
      headers: {
        'Content-Type': 'text/xml; charset=utf-8',
        SOAPAction: `${NS}${operacion}`,
      },
      body: sobre,
    });

    const texto = await respuesta.text();
    if (!respuesta.ok) {
      throw new Error(`${operacion} respondió ${respuesta.status}: ${texto.slice(0, 600)}`);
    }

    const arbol = parser.parse(texto) as Record<string, never>;
    const envelope = (arbol['Envelope'] ?? {}) as Record<string, never>;
    const body = (envelope['Body'] ?? {}) as Record<string, never>;

    const fault = body['Fault'];
    if (fault !== undefined) {
      throw new Error(`${operacion} devolvió SOAP Fault: ${JSON.stringify(fault).slice(0, 600)}`);
    }

    const wrapper = (body[`${operacion}Response`] ?? {}) as Record<string, never>;
    return (wrapper[`${operacion}Result`] ?? {}) as Record<string, unknown>;
  }

  /** ¿Está vivo el servicio? Se llama antes de emitir, no después de fallar. */
  async dummy(): Promise<{ appServer: string; dbServer: string; authServer: string }> {
    const r = await this.#llamar('FEDummy', '');
    return {
      appServer: String(r['AppServer'] ?? '?'),
      dbServer: String(r['DbServer'] ?? '?'),
      authServer: String(r['AuthServer'] ?? '?'),
    };
  }

  /**
   * Último comprobante autorizado para ese punto de venta y tipo.
   *
   * Es obligatorio consultarlo antes de emitir: la numeración tiene que ser
   * correlativa y sin huecos, y el número siguiente lo pone el emisor, no ARCA.
   * Empezar en 1 «porque es un ambiente de prueba» produce un rechazo con un
   * código que no dice eso.
   */
  async ultimoAutorizado(auth: Autenticacion, ptoVta: number, cbteTipo: number): Promise<number> {
    const r = await this.#llamar(
      'FECompUltimoAutorizado',
      autenticacionXml(auth) + `<ar:PtoVta>${ptoVta}</ar:PtoVta><ar:CbteTipo>${cbteTipo}</ar:CbteTipo>`,
    );

    const errores = listaDe(r['Errors'], 'Err').map(comoError);
    if (errores.length > 0) {
      throw new Error(
        `FECompUltimoAutorizado: ${errores.map((e) => `[${e.Code}] ${e.Msg}`).join(' · ')}`,
      );
    }
    return Number(r['CbteNro'] ?? 0);
  }

  /** `FECAESolicitar`. Un solo comprobante por llamada, por elección — ver el script. */
  async solicitarCae(
    auth: Autenticacion,
    cabecera: CabeceraLote,
    detalles: readonly DetalleComprobante[],
  ): Promise<RespuestaLote> {
    const cuerpo =
      autenticacionXml(auth) +
      '<ar:FeCAEReq>' +
      `<ar:FeCabReq><ar:CantReg>${cabecera.CantReg}</ar:CantReg>` +
      `<ar:PtoVta>${cabecera.PtoVta}</ar:PtoVta>` +
      `<ar:CbteTipo>${cabecera.CbteTipo}</ar:CbteTipo></ar:FeCabReq>` +
      '<ar:FeDetReq>' +
      detalles.map(detalleXml).join('') +
      '</ar:FeDetReq></ar:FeCAEReq>';

    const r = await this.#llamar('FECAESolicitar', cuerpo);
    const cabeceraResp = (r['FeCabResp'] ?? {}) as Record<string, unknown>;

    return {
      Resultado: String(cabeceraResp['Resultado'] ?? ''),
      comprobantes: listaDe((r['FeDetResp'] ?? {}) as unknown, 'FECAEDetResponse').map(
        comoComprobante,
      ),
      errores: listaDe(r['Errors'], 'Err').map(comoError),
      eventos: listaDe(r['Events'], 'Evt').map(comoObservacion),
    };
  }
}

function autenticacionXml(auth: Autenticacion): string {
  return (
    '<ar:Auth>' +
    `<ar:Token>${escapar(auth.Token)}</ar:Token>` +
    `<ar:Sign>${escapar(auth.Sign)}</ar:Sign>` +
    `<ar:Cuit>${auth.Cuit}</ar:Cuit>` +
    '</ar:Auth>'
  );
}

/**
 * El detalle, en el orden del WSDL.
 *
 * El orden importa: el esquema es una `s:sequence`, no un `s:all`. Mandar
 * `ImpNeto` antes que `ImpTotConc` produce un error de validación cuyo mensaje no
 * menciona el orden.
 */
function detalleXml(d: DetalleComprobante): string {
  const opcional = (nombre: string, valor: string | number | undefined): string =>
    valor === undefined ? '' : `<ar:${nombre}>${valor}</ar:${nombre}>`;

  return (
    '<ar:FECAEDetRequest>' +
    `<ar:Concepto>${d.Concepto}</ar:Concepto>` +
    `<ar:DocTipo>${d.DocTipo}</ar:DocTipo>` +
    `<ar:DocNro>${d.DocNro}</ar:DocNro>` +
    `<ar:CbteDesde>${d.CbteDesde}</ar:CbteDesde>` +
    `<ar:CbteHasta>${d.CbteHasta}</ar:CbteHasta>` +
    `<ar:CbteFch>${d.CbteFch}</ar:CbteFch>` +
    `<ar:ImpTotal>${d.ImpTotal}</ar:ImpTotal>` +
    `<ar:ImpTotConc>${d.ImpTotConc}</ar:ImpTotConc>` +
    `<ar:ImpNeto>${d.ImpNeto}</ar:ImpNeto>` +
    `<ar:ImpOpEx>${d.ImpOpEx}</ar:ImpOpEx>` +
    `<ar:ImpTrib>${d.ImpTrib}</ar:ImpTrib>` +
    `<ar:ImpIVA>${d.ImpIVA}</ar:ImpIVA>` +
    opcional('FchServDesde', d.FchServDesde) +
    opcional('FchServHasta', d.FchServHasta) +
    opcional('FchVtoPago', d.FchVtoPago) +
    `<ar:MonId>${d.MonId}</ar:MonId>` +
    `<ar:MonCotiz>${d.MonCotiz}</ar:MonCotiz>` +
    opcional('CondicionIVAReceptorId', d.CondicionIVAReceptorId) +
    // Para clase C no va: el comprobante no discrimina IVA y un array vacío es
    // motivo de rechazo. Por eso se omite el nodo entero, no se manda vacío.
    (d.Iva === undefined || d.Iva.length === 0
      ? ''
      : '<ar:Iva>' +
        d.Iva.map(
          (a) =>
            `<ar:AlicIva><ar:Id>${a.Id}</ar:Id>` +
            `<ar:BaseImp>${a.BaseImp}</ar:BaseImp>` +
            `<ar:Importe>${a.Importe}</ar:Importe></ar:AlicIva>`,
        ).join('') +
        '</ar:Iva>') +
    '</ar:FECAEDetRequest>'
  );
}

function escapar(valor: string): string {
  return valor
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
}

/** El parser colapsa los arrays de un solo elemento. Se re-expanden acá. */
function listaDe(nodo: unknown, hijo: string): Record<string, unknown>[] {
  if (nodo === undefined || nodo === null || typeof nodo !== 'object') return [];
  const contenido = (nodo as Record<string, unknown>)[hijo];
  if (contenido === undefined) return [];
  return Array.isArray(contenido)
    ? (contenido as Record<string, unknown>[])
    : [contenido as Record<string, unknown>];
}

function comoError(n: Record<string, unknown>): ErrorArca {
  return { Code: Number(n['Code'] ?? 0), Msg: String(n['Msg'] ?? '') };
}

function comoObservacion(n: Record<string, unknown>): Observacion {
  return { Code: Number(n['Code'] ?? 0), Msg: String(n['Msg'] ?? '') };
}

function comoComprobante(n: Record<string, unknown>): RespuestaComprobante {
  const cae = n['CAE'] === undefined || n['CAE'] === '' ? null : String(n['CAE']);
  return {
    Concepto: Number(n['Concepto'] ?? 0),
    DocTipo: Number(n['DocTipo'] ?? 0),
    DocNro: String(n['DocNro'] ?? ''),
    CbteDesde: Number(n['CbteDesde'] ?? 0),
    CbteHasta: Number(n['CbteHasta'] ?? 0),
    CbteFch: String(n['CbteFch'] ?? ''),
    Resultado: String(n['Resultado'] ?? ''),
    CAE: cae,
    CAEFchVto: n['CAEFchVto'] === undefined ? null : String(n['CAEFchVto']),
    Observaciones: listaDe(n['Observaciones'], 'Obs').map(comoObservacion),
  };
}
