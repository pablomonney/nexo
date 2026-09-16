/**
 * El adaptador de Mercado Pago. Suscripciones (`preapproval`).
 *
 * ## Qué se siguió
 *
 * No hay arquitectura nueva. Es `resend.ts` aplicado a los cobros, con las
 * mismas cuatro decisiones que ya estaban tomadas en el repositorio:
 *
 *   · `fetch` **inyectable**. Es lo que permite probar el adaptador entero sin
 *     cuenta de Mercado Pago y sin red — que hoy es la única forma posible,
 *     porque la cuenta todavía no existe.
 *   · `AbortController` con timeout. No hay llamada sin límite.
 *   · El access token se pide **por llamada**, nunca se guarda en el objeto.
 *   · Todo texto que sale de acá pasa por `taparValor` y `redactarTexto`.
 *
 * Sin dependencias nuevas: ni el SDK de Mercado Pago ni un cliente HTTP. Node
 * trae `fetch` y `node:crypto`, que es todo lo que hace falta para cuatro
 * llamadas y un HMAC. El SDK oficial además trae su propia política de
 * reintentos, que es justamente la decisión que no queremos delegar.
 *
 * ## Reintentos: leer y escribir no son lo mismo
 *
 * Este adaptador **no reintenta escrituras ante un 5xx**, y ahí se aparta del
 * proveedor de correo a propósito. Un 500 al crear una suscripción pudo ocurrir
 * después de haberla creado; repetirlo deja dos suscripciones cobrándole a la
 * misma empresa todos los meses. El criterio completo está en
 * `@aai/billing-engine/pasarela`, con las dos funciones separadas
 * (`reintentable` para lecturas, `reintentableEnEscritura` para el resto) para
 * que se pueda ejercitar sin pasar por acá.
 *
 * Lo que un 5xx en una escritura produce es un fallo con su código. Quién
 * decide qué hacer con él es la política de cobranza, que ya existe.
 *
 * ## Lo que nunca sale de este módulo
 *
 * El access token, el secreto de webhook, y **cualquier dato de tarjeta**. NEXO
 * no recibe ni pide números de tarjeta: la autorización del medio de pago ocurre
 * en el `init_point` de Mercado Pago, en su dominio. Lo único de la tarjeta que
 * vuelve y se guarda son el medio (`visa`, `master`) y los últimos cuatro
 * dígitos, que ya tienen columna en `payment_intents` desde la 0096 y son lo que
 * permite que alguien reconozca su propia tarjeta en un aviso de cobranza.
 */

import { createHmac, timingSafeEqual } from 'node:crypto';
import {
  estadoDePagoDesde,
  reintentable,
  reintentableEnEscritura,
  type CodigoDeFalloDePago,
  type EstadoExternoDePago,
  type EstadoExternoDeSuscripcion,
} from '@aai/billing-engine';
import { redactarTexto, taparValor } from '@aai/secrets';
import { isCurrency, money, toDecimalString } from '@aai/shared';
import type {
  FalloDePago,
  PagoExterno,
  PlanExterno,
  PlanParaProveedor,
  ProveedorDePagos,
  Resultado,
  SuscripcionExterna,
  SuscripcionParaProveedor,
  EntradaDeFirma,
} from './puerto.js';

/**
 * La base de la API.
 *
 * Constante del módulo y no variable de entorno, igual que `URL_DE_RESEND`: no
 * es una decisión del despliegue —hay una sola API de Mercado Pago— y una
 * variable de más es una que alguien puede apuntar a otro lado sin que nadie se
 * entere. Los tests no la necesitan porque inyectan `fetch`.
 *
 * **No hay dos URLs.** A diferencia de ARCA, Mercado Pago no tiene un dominio de
 * homologación: producción y prueba se distinguen por la credencial (`TEST-…` vs
 * `APP_USR-…`), y eso es lo que hace que el ambiente sea una propiedad del
 * secreto y no de la URL. La consecuencia es incómoda y hay que decirla: pegarle
 * a la API con la credencial equivocada cobra plata de verdad. Por eso el
 * ambiente se declara aparte y se compara contra el prefijo del token; ver
 * `fabrica.ts`.
 */
export const BASE_DE_MERCADO_PAGO = 'https://api.mercadopago.com';

/** Lo que este módulo necesita de `fetch`. Se inyecta para poder probarlo. */
export type FetchLike = (
  url: string,
  init: {
    method: string;
    headers: Record<string, string>;
    body?: string;
    signal: AbortSignal;
  },
) => Promise<{ ok: boolean; status: number; text(): Promise<string> }>;

export interface OpcionesDeMercadoPago {
  /** El access token, resuelto por llamada. Nunca un valor guardado. */
  readonly accessToken: () => Promise<string>;
  /**
   * El secreto de firma de los webhooks, resuelto por llamada.
   *
   * Devuelve `null` cuando no hay ninguno configurado, que es un estado
   * legítimo —una instalación puede tener credenciales y todavía no haber dado
   * de alta la notificación— y se traduce en `verificarFirma() === null`, no en
   * `false`.
   */
  readonly webhookSecret: () => Promise<string | null>;
  readonly timeoutMs: number;
  /** Reintentos **además** del primero. 0 = un solo intento. */
  readonly maxRetries: number;
  readonly fetch?: FetchLike;
  /** Espera entre reintentos. Se inyecta para que los tests no duerman. */
  readonly esperar?: (ms: number) => Promise<void>;
  readonly base?: string;
}

// ── Lectura de la respuesta ────────────────────────────────────────────────
//
// Todo lo que sigue lee campos de un JSON ajeno. La regla es una sola y vale
// para las cinco funciones: **si el campo no está o no tiene el tipo esperado,
// se devuelve `null`**, jamás un valor por defecto. Un `0` inventado en un
// importe o un `'PENDIENTE'` inventado en un estado se propagan al billing como
// si fueran un hecho, y de ahí no vuelven.

function objeto(texto: string): Record<string, unknown> | null {
  try {
    const json: unknown = JSON.parse(texto);
    if (typeof json === 'object' && json !== null && !Array.isArray(json)) {
      return json as Record<string, unknown>;
    }
  } catch {
    /* No es JSON: no se inventa una lectura. */
  }
  return null;
}

function cadena(fuente: Record<string, unknown>, campo: string): string | null {
  const valor = fuente[campo];
  return typeof valor === 'string' && valor.length > 0 ? valor : null;
}

/**
 * El día de un sello de tiempo del proveedor, **sin hacer cuentas de huso**.
 *
 * `next_payment_date` viene como `2026-10-03T00:00:00.000-03:00`. Lo que hace
 * falta es el día, y se toma el que el proveedor escribió: recortar antes de la
 * `T` conserva la fecha **en el huso de la cuenta de Mercado Pago**, que es el
 * huso en el que el proveedor va a debitar.
 *
 * La alternativa —`new Date(...)` y después `toISOString()`— convierte a UTC, y
 * en Argentina (UTC−3) un cobro de la medianoche se leería como el día
 * siguiente. Sería un error de un día en una comparación que existe justamente
 * para detectar diferencias de días.
 */
function soloLaFecha(sello: string | null): string | null {
  if (sello === null) return null;
  const dia = sello.slice(0, 10);
  return /^\d{4}-\d{2}-\d{2}$/u.test(dia) ? dia : null;
}

/**
 * El identificador de un recurso, que Mercado Pago devuelve como texto en unos
 * endpoints y como número en otros (los pagos, notablemente).
 *
 * Se normaliza a texto porque las columnas de NEXO son texto: `referencia_externa`
 * y `evento_externo` guardan identificadores de proveedores cualesquiera, y
 * obligarlas a un tipo numérico las ataría a este proveedor en particular.
 */
function identificador(fuente: Record<string, unknown>, campo: string): string | null {
  const valor = fuente[campo];
  if (typeof valor === 'string' && valor.length > 0) return valor;
  // `Number.isInteger` y no `typeof === 'number'`: un id fraccionario no es un
  // id, y aceptarlo escribiría "1.5" en una columna de referencia.
  if (typeof valor === 'number' && Number.isInteger(valor)) return String(valor);
  return null;
}

/**
 * El mensaje de error de Mercado Pago, si viene con la forma esperada.
 *
 * Se leen `message` y `error`, y **nada más**. Volcar el cuerpo entero metería
 * en la base lo que el proveedor haya decidido devolver, que en varios
 * proveedores incluye el pedido original —con la cabecera de autorización
 * adentro—.
 */
function mensajeDeError(texto: string): string | null {
  const json = objeto(texto);
  if (json === null) return null;
  const m = cadena(json, 'message') ?? cadena(json, 'error');
  return m === null ? null : m.slice(0, 300);
}

/**
 * Cómo se lee un fallo según su código HTTP.
 *
 * La distinción que importa es entre **problema del despliegue** —el token no
 * sirve— y **problema del cobro** —la tarjeta fue rechazada, el plan no existe—.
 * Llevan a acciones opuestas: la primera la arregla quien administra la
 * instalación; la segunda, el cliente. Mandar a revisar una tarjeta cuando lo
 * que caducó es el token de NEXO hace perder el tiempo a la persona equivocada.
 */
function porStatus(status: number): CodigoDeFalloDePago {
  if (status === 401 || status === 403) return 'CREDENCIAL_RECHAZADA';
  if (status === 404) return 'NO_ENCONTRADO';
  if (status === 409) return 'CONFLICTO';
  if (status === 429) return 'LIMITE_DE_TASA';
  if (status >= 500) return 'PROVEEDOR_CAIDO';
  return 'PEDIDO_INVALIDO';
}

// ── Vocabulario del proveedor ──────────────────────────────────────────────

/**
 * Los estados de `preapproval`, tal como los documenta Mercado Pago.
 *
 * El `Record` es un mapa explícito y no un `switch` con `default` **a
 * propósito**: un estado que Mercado Pago agregue mañana y que no esté acá tiene
 * que salir por `undefined` y convertirse en `RESPUESTA_ILEGIBLE`. Un `default`
 * lo mapearía a algo plausible, y ese «algo plausible» sería una afirmación
 * sobre el estado de cobro de un cliente que nadie verificó.
 */
const ESTADOS_DE_SUSCRIPCION: Readonly<Record<string, EstadoExternoDeSuscripcion>> = {
  pending: 'PENDIENTE',
  authorized: 'AUTORIZADA',
  paused: 'PAUSADA',
  cancelled: 'CANCELADA',
};

/** Los estados de `/v1/payments`. Mismo criterio: mapa cerrado, sin `default`. */
const ESTADOS_DE_PAGO: Readonly<Record<string, EstadoExternoDePago>> = {
  approved: 'APROBADO',
  authorized: 'AUTORIZADO',
  pending: 'PENDIENTE',
  in_process: 'EN_PROCESO',
  // Una mediación es una disputa abierta sobre un pago que ya se acreditó. Se
  // trata como «en proceso» —el desenlace no se sabe— y el motor se encarga de
  // que eso no retroceda un cobro ya `PAGADO`: `esAtrasado` lo registra sin
  // aplicarlo. Mapearlo a FALLIDO sería dar por perdida una disputa que puede
  // ganarse; a CONTRACARGO, darla por perdida antes de que ocurra.
  in_mediation: 'EN_PROCESO',
  rejected: 'RECHAZADO',
  cancelled: 'CANCELADO',
  refunded: 'DEVUELTO',
  charged_back: 'CONTRACARGO',
};

/**
 * De la periodicidad de NEXO a la de Mercado Pago.
 *
 * Anual es `12 months` y no `1 years`: `frequency_type` admite `months` y
 * `days`, y expresar el año en meses evita depender de una tercera unidad.
 */
function recurrencia(periodicidad: 'MENSUAL' | 'ANUAL'): { frequency: number; type: string } {
  return periodicidad === 'MENSUAL'
    ? { frequency: 1, type: 'months' }
    : { frequency: 12, type: 'months' };
}

/**
 * El importe, en decimal exacto, sin pasar por punto flotante.
 *
 * Mercado Pago recibe `transaction_amount` como número JSON, y NEXO lleva los
 * importes en centavos (`bigint`). El puente obvio —`Number('1234.56')`— mete un
 * `double` en el medio de un importe, que es exactamente lo que la Regla 4 del
 * README prohíbe y lo que `check:no-float` vigila.
 *
 * Así que el decimal se calcula con `toDecimalString` —entero, exacto— y se
 * inserta en el JSON como literal, reemplazando una marca. El texto que sale por
 * el cable es el mismo que salió de `bigint`, dígito por dígito.
 */
const MARCA_DE_IMPORTE = '@@importe@@';

function conImporte(cuerpo: Record<string, unknown>, centavos: bigint, moneda: string): string {
  if (!isCurrency(moneda)) {
    throw new RangeError(`Moneda desconocida: ${JSON.stringify(moneda)}`);
  }
  const decimal = toDecimalString(money(centavos, moneda));
  const texto = JSON.stringify(cuerpo);

  // Que la marca aparezca exactamente una vez no es una obviedad que se pueda
  // asumir: si un día alguien agrega un segundo importe al cuerpo y reusa la
  // marca, `replace` cambiaría el primero y dejaría el segundo como el texto
  // `"@@importe@@"`. Mercado Pago contestaría 400 y el motivo no sería evidente.
  const veces = texto.split(`"${MARCA_DE_IMPORTE}"`).length - 1;
  if (veces !== 1) {
    throw new Error(
      `El cuerpo tiene ${veces} marcas de importe y debería tener exactamente una.`,
    );
  }
  return texto.replace(`"${MARCA_DE_IMPORTE}"`, decimal);
}

// ── El adaptador ───────────────────────────────────────────────────────────

/** Qué clase de llamada es, que es lo que decide si se puede reintentar. */
type Naturaleza = 'LECTURA' | 'ESCRITURA';

interface Respuesta {
  readonly cuerpo: Record<string, unknown>;
  readonly status: number;
}

export class ProveedorDeMercadoPago implements ProveedorDePagos {
  /**
   * La identidad que queda en `payment_intents.proveedor` y
   * `payment_events.proveedor`.
   *
   * Es el nombre del proveedor y no el del adaptador: esas columnas existen para
   * contestar «¿quién dijo que esto se cobró?», y esa respuesta tiene que seguir
   * siendo cierta el día que el adaptador se reescriba. Además es la mitad de la
   * clave `UNIQUE (proveedor, evento_externo)` que hace idempotentes a los
   * webhooks: cambiarlo volvería reprocesables todos los eventos ya vistos.
   */
  readonly id = 'mercadopago';

  readonly #opciones: OpcionesDeMercadoPago;
  readonly #fetch: FetchLike;
  readonly #esperar: (ms: number) => Promise<void>;
  readonly #base: string;

  constructor(opciones: OpcionesDeMercadoPago) {
    this.#opciones = opciones;
    this.#fetch = opciones.fetch ?? (globalThis.fetch as unknown as FetchLike);
    this.#esperar = opciones.esperar ?? ((ms) => new Promise((r) => setTimeout(r, ms)));
    this.#base = opciones.base ?? BASE_DE_MERCADO_PAGO;
  }

  // ── Planes ───────────────────────────────────────────────────────────────

  /**
   * Crea el plan del lado de Mercado Pago.
   *
   * **Se llama «asegurar» y no «crear», y hay que ser honesto sobre por qué: la
   * idempotencia no vive acá.** Mercado Pago no tiene una operación «creá este
   * plan si no existe»; dos POST crean dos planes. Lo que impide el duplicado es
   * la tabla de mapeo (`payment_plan_map`, migración 0118) con su índice único
   * por plan y ambiente: si ya hay un `preapproval_plan_id` guardado, esta
   * función no se llama.
   *
   * La cabecera `X-Idempotency-Key` va igual, como segunda red por si el mapeo
   * se escribe y la respuesta se pierde en el camino. Es mejor esfuerzo: se
   * envía porque no cuesta nada y puede ahorrar un duplicado, no porque
   * garantice algo que la base ya garantiza mejor.
   */
  async asegurarPlan(plan: PlanParaProveedor): Promise<Resultado<PlanExterno>> {
    const { frequency, type } = recurrencia(plan.periodicidad);

    let cuerpo: string;
    try {
      /**
       * `free_trial` se agrega **solo si quien llama lo pidió**, y hoy no lo
       * pide nadie.
       *
       * Mercado Pago lo acepta dentro de `auto_recurring` con
       * `frequency_type: "days"`. Que el adaptador sepa mandarlo y que el
       * comando que crea los planes no lo use es deliberado: la prueba de
       * catorce días vive en NEXO —ver `PlanParaProveedor`— y duplicarla acá
       * regalaría dos semanas de servicio ya facturado.
       *
       * El campo ausente y el campo en cero **no son lo mismo** para el
       * proveedor, así que no se manda `free_trial: null` ni `frequency: 0`: si
       * no hay prueba del lado de la pasarela, la clave no aparece.
       */
      const dias = plan.diasDePruebaDelProveedor ?? null;
      const pruebaGratis =
        dias !== null && dias > 0
          ? { free_trial: { frequency: dias, frequency_type: 'days' } }
          : {};

      cuerpo = conImporte(
        {
          reason: plan.nombre,
          auto_recurring: {
            frequency,
            frequency_type: type,
            transaction_amount: MARCA_DE_IMPORTE,
            currency_id: plan.moneda,
            ...pruebaGratis,
          },
        },
        plan.importeCentavos,
        plan.moneda,
      );
    } catch (error) {
      // Una moneda que NEXO no conoce o un cuerpo mal armado son errores de
      // programación, no del proveedor. Se informan como pedido inválido —que es
      // lo que sería— en vez de dejar escapar la excepción hacia el ciclo de
      // facturación, que la trataría como una caída.
      return this.#error('PEDIDO_INVALIDO', (error as Error).message);
    }

    const salida = await this.#llamar('POST', '/preapproval_plan', 'ESCRITURA', cuerpo, {
      'x-idempotency-key': `plan:${plan.codigo}:${plan.periodicidad}:${plan.importeCentavos}`,
    });
    if (!salida.ok) return salida;

    const id = identificador(salida.valor.cuerpo, 'id');
    if (id === null) return this.#ilegible('el plan creado no trae id');

    return {
      ok: true,
      valor: { id, estado: cadena(salida.valor.cuerpo, 'status') ?? 'desconocido' },
    };
  }

  // ── Suscripciones ────────────────────────────────────────────────────────

  async crearSuscripcion(datos: SuscripcionParaProveedor): Promise<Resultado<SuscripcionExterna>> {
    let cuerpo: string;
    try {
      cuerpo = conImporte(
        {
          preapproval_plan_id: datos.planExternoId,
          // Mercado Pago exige el correo del pagador para identificarlo de su
          // lado. Que lo exija no lo convierte en la clave: la clave es
          // `external_reference`, que es lo que se busca al recibir un webhook.
          payer_email: datos.correoDelPagador,
          // El vínculo con NEXO. Sin esto, un webhook trae un id de Mercado Pago
          // y nada más, y reconstruir a qué empresa corresponde dependería de
          // buscar por correo — que es justamente lo que no se hace.
          external_reference: datos.referenciaNexo,
          back_url: datos.urlDeRetorno,
          // `pending`: la suscripción queda esperando que el pagador autorice el
          // medio de pago en el `init_point`. Pedir `authorized` de entrada
          // requeriría un `card_token_id`, o sea que NEXO tocara la tarjeta.
          status: 'pending',
          auto_recurring: {
            transaction_amount: MARCA_DE_IMPORTE,
            currency_id: datos.moneda,
          },
        },
        datos.importeCentavos,
        datos.moneda,
      );
    } catch (error) {
      return this.#error('PEDIDO_INVALIDO', (error as Error).message);
    }

    const salida = await this.#llamar('POST', '/preapproval', 'ESCRITURA', cuerpo, {
      'x-idempotency-key': `sub:${datos.referenciaNexo}`,
    });
    if (!salida.ok) return salida;
    return this.#leerSuscripcion(salida.valor.cuerpo);
  }

  async consultarSuscripcion(id: string): Promise<Resultado<SuscripcionExterna>> {
    const salida = await this.#llamar('GET', `/preapproval/${encodeURIComponent(id)}`, 'LECTURA');
    if (!salida.ok) return salida;
    return this.#leerSuscripcion(salida.valor.cuerpo);
  }

  async pausarSuscripcion(id: string): Promise<Resultado<SuscripcionExterna>> {
    return this.#cambiarEstado(id, 'paused');
  }

  /**
   * Reactivar es poner `authorized`.
   *
   * Solo funciona sobre una suscripción pausada que conserve su medio de pago
   * autorizado; sobre una cancelada, Mercado Pago contesta 4xx y acá sale como
   * `CONFLICTO` o `PEDIDO_INVALIDO`. Es correcto que falle: de `CANCELADA` no se
   * vuelve, ni de este lado ni del otro.
   */
  async reactivarSuscripcion(id: string): Promise<Resultado<SuscripcionExterna>> {
    return this.#cambiarEstado(id, 'authorized');
  }

  async cancelarSuscripcion(id: string): Promise<Resultado<SuscripcionExterna>> {
    return this.#cambiarEstado(id, 'cancelled');
  }

  async #cambiarEstado(id: string, estado: string): Promise<Resultado<SuscripcionExterna>> {
    const salida = await this.#llamar(
      'PUT',
      `/preapproval/${encodeURIComponent(id)}`,
      'ESCRITURA',
      JSON.stringify({ status: estado }),
    );
    if (!salida.ok) return salida;
    return this.#leerSuscripcion(salida.valor.cuerpo);
  }

  #leerSuscripcion(cuerpo: Record<string, unknown>): Resultado<SuscripcionExterna> {
    const id = identificador(cuerpo, 'id');
    if (id === null) return this.#ilegible('la suscripción no trae id');

    const crudo = cadena(cuerpo, 'status');
    if (crudo === null) return this.#ilegible('la suscripción no trae status');

    const estado = ESTADOS_DE_SUSCRIPCION[crudo];
    if (estado === undefined) {
      // Un estado desconocido no se aproxima. Decir «PAUSADA» sobre algo que
      // Mercado Pago llama de otra forma sería suspenderle el servicio a una
      // empresa por un valor que nadie leyó nunca.
      return this.#ilegible(`estado de suscripción no reconocido: ${crudo}`);
    }

    return {
      ok: true,
      valor: {
        id,
        estado,
        // `init_point` solo viene al crearla. Que falte en una consulta es lo
        // normal, no un fallo.
        urlDeAutorizacion: cadena(cuerpo, 'init_point'),
        referenciaNexo: cadena(cuerpo, 'external_reference'),
        proximoCobro: soloLaFecha(cadena(cuerpo, 'next_payment_date')),
      },
    };
  }

  // ── Pagos ────────────────────────────────────────────────────────────────

  /**
   * El estado definitivo de un cobro, preguntado al proveedor.
   *
   * Existe porque **un webhook no se cree solo**. El payload de una notificación
   * dice «pasó algo con el pago N»; lo que pasó se pregunta acá, con la
   * credencial de NEXO, contra la API. Es lo que hace que un webhook falsificado
   * —o simplemente viejo— no pueda mover un cobro por sí mismo.
   */
  async consultarPago(id: string): Promise<Resultado<PagoExterno>> {
    const salida = await this.#llamar('GET', `/v1/payments/${encodeURIComponent(id)}`, 'LECTURA');
    if (!salida.ok) return salida;

    const cuerpo = salida.valor.cuerpo;
    const idPago = identificador(cuerpo, 'id');
    if (idPago === null) return this.#ilegible('el pago no trae id');

    const crudo = cadena(cuerpo, 'status');
    if (crudo === null) return this.#ilegible('el pago no trae status');

    const externo = ESTADOS_DE_PAGO[crudo];
    if (externo === undefined) {
      return this.#ilegible(`estado de pago no reconocido: ${crudo}`);
    }

    // Los datos de la tarjeta que sí se guardan, y los únicos. `card` trae
    // bastante más —nombre del titular, bin, vencimiento— y nada de eso se lee.
    const tarjeta = cuerpo['card'];
    const ultimos4 =
      typeof tarjeta === 'object' && tarjeta !== null
        ? cadena(tarjeta as Record<string, unknown>, 'last_four_digits')
        : null;

    return {
      ok: true,
      valor: {
        id: idPago,
        estado: estadoDePagoDesde(externo),
        // De qué suscripción salió este cobro. Es lo que permite atribuirlo sin
        // confiar en el payload del webhook.
        suscripcionExternaId: identificador(cuerpo, 'preapproval_id'),
        // **El importe no se lee.** Mercado Pago lo devuelve como número JSON, y
        // convertirlo a centavos exigiría multiplicar un `double` por 100 —el
        // error que la Regla 4 existe para impedir—. El importe que el billing
        // usa es el suyo, que salió de `plan_prices` en centavos y nunca fue
        // float. Si algún día hiciera falta comparar el cobrado con el
        // esperado, se lee el texto crudo del campo y se parsea con
        // `moneyFromDecimalString`, no con `Number`.
        importeCentavos: null,
        moneda: cadena(cuerpo, 'currency_id'),
        medio: cadena(cuerpo, 'payment_method_id'),
        ultimos4,
        // `status_detail` es donde Mercado Pago dice **por qué**:
        // `cc_rejected_insufficient_amount`, `cc_rejected_bad_filled_date`,
        // `cc_rejected_high_risk`. Se guarda el código crudo y no una
        // traducción: traducirlo acá obligaría a mantener un diccionario de
        // códigos ajenos, y el que falte se convertiría en un motivo inventado.
        //
        // Se recorta a 500: es el texto del proveedor y no hay ningún motivo
        // para que ocupe más. La columna no tiene tope, pero un campo sin tope
        // alimentado desde afuera es un campo que alguien va a llenar.
        detalleDelFallo: cadena(cuerpo, 'status_detail')?.slice(0, 500) ?? null,
      },
    };
  }

  // ── Firma de webhooks ────────────────────────────────────────────────────

  /**
   * ¿La notificación viene de verdad de Mercado Pago?
   *
   * Mercado Pago firma con HMAC-SHA256 sobre un manifiesto armado con tres
   * cosas: el id del recurso notificado, el `x-request-id` de la llamada y el
   * timestamp de la propia firma. Viene en `x-signature`, con la forma
   * `ts=<epoch>,v1=<hex>`.
   *
   * Que el manifiesto incluya el `ts` es lo que hace que la firma no se pueda
   * reusar con otro contenido; que incluya el `id` es lo que impide tomar la
   * firma de una notificación real y pegarla en una inventada sobre otro pago.
   *
   * ## Las tres respuestas, y por qué son tres
   *
   *     null    no se puede afirmar: no hay secreto configurado. Es una
   *             instalación incompleta, no un ataque.
   *     false   vino algo que dice ser una firma y no cierra. **Esto sí es un
   *             incidente**, y quien llama tiene que poder tratarlo distinto.
   *     true    cierra.
   *
   * Colapsar los tres en un booleano haría que una instalación sin secreto
   * generara alertas de suplantación todo el día, y que nadie las mirara el día
   * que fueran ciertas.
   */
  async verificarFirma(entrada: EntradaDeFirma): Promise<boolean | null> {
    const secreto = await this.#opciones.webhookSecret();
    if (secreto === null || secreto === '') return null;

    const firma = entrada.cabeceras['x-signature'];
    // Falta la cabecera. Es `false` y no `null`: hay secreto configurado, o sea
    // que **se espera** que venga firmada. Una notificación sin firma cuando se
    // exige firma es precisamente lo que se está filtrando.
    if (firma === undefined || firma === '') return false;

    const partes = new Map<string, string>();
    for (const trozo of firma.split(',')) {
      const corte = trozo.indexOf('=');
      if (corte === -1) continue;
      partes.set(trozo.slice(0, corte).trim(), trozo.slice(corte + 1).trim());
    }

    const ts = partes.get('ts');
    const v1 = partes.get('v1');
    if (ts === undefined || v1 === undefined) return false;

    // El manifiesto es literal: el orden de los campos y los puntos y comas son
    // parte del acuerdo. `x-request-id` puede no venir, y en ese caso el
    // segmento se omite entero — que es lo que hace Mercado Pago del lado que
    // firma, no un `undefined` en el medio del texto.
    const requestId = entrada.cabeceras['x-request-id'];
    const manifiesto =
      `id:${entrada.recursoId};` +
      (requestId === undefined || requestId === '' ? '' : `request-id:${requestId};`) +
      `ts:${ts};`;

    const esperado = createHmac('sha256', secreto).update(manifiesto).digest();

    let recibido: Buffer;
    try {
      recibido = Buffer.from(v1, 'hex');
    } catch {
      return false;
    }

    // `timingSafeEqual` tira si los largos no coinciden, así que se comparan
    // antes. La comparación de largos no filtra nada útil: el largo de un
    // SHA-256 es público.
    if (recibido.length !== esperado.length) return false;

    // Comparación de tiempo constante. Un `===` sobre el hexadecimal filtraría,
    // byte a byte, cuánto de la firma se acertó, y con suficientes intentos eso
    // permite construir una firma válida sin conocer el secreto.
    return timingSafeEqual(recibido, esperado);
  }

  // ── Transporte ───────────────────────────────────────────────────────────

  #error(codigo: CodigoDeFalloDePago, detalle: string, status?: number): Resultado<never> {
    const fallo: FalloDePago =
      status === undefined ? { codigo, detalle } : { codigo, detalle, status };
    return { ok: false, fallo };
  }

  #ilegible(detalle: string): Resultado<never> {
    return this.#error(
      'RESPUESTA_ILEGIBLE',
      `Mercado Pago contestó algo que no se puede interpretar: ${detalle}`,
    );
  }

  /**
   * Una llamada, con sus reintentos si corresponde.
   *
   * `naturaleza` es lo que decide qué se reintenta, y es el parámetro más
   * importante de esta función: pasarla mal en una escritura significa cobrar
   * dos veces.
   */
  async #llamar(
    metodo: string,
    ruta: string,
    naturaleza: Naturaleza,
    cuerpo?: string,
    extras: Record<string, string> = {},
  ): Promise<Resultado<Respuesta>> {
    const sePuede = naturaleza === 'LECTURA' ? reintentable : reintentableEnEscritura;
    let ultimo: FalloDePago | null = null;

    for (let intento = 1; intento <= this.#opciones.maxRetries + 1; intento += 1) {
      const salida = await this.#unIntento(metodo, ruta, cuerpo, extras);
      if (salida.ok) return salida;

      ultimo = salida.fallo;
      if (!sePuede(salida.fallo.codigo) || intento > this.#opciones.maxRetries) break;

      // Backoff exponencial con techo, igual que en el correo y en el proveedor
      // de modelo: sin techo, el tercer reintento de una caída larga espera más
      // que el timeout de la llamada entera.
      await this.#esperar(Math.min(200 * 2 ** (intento - 1), 4_000));
    }

    return { ok: false, fallo: ultimo! };
  }

  async #unIntento(
    metodo: string,
    ruta: string,
    cuerpo: string | undefined,
    extras: Record<string, string>,
  ): Promise<Resultado<Respuesta>> {
    const controlador = new AbortController();
    const reloj = setTimeout(() => controlador.abort(), this.#opciones.timeoutMs);

    // El token se pide acá, no en el constructor. Si el gestor de secretos no lo
    // tiene, el error es **suyo** y no se traduce a «el proveedor está caído»:
    // no es lo mismo y llevan a acciones opuestas.
    let credencial: string;
    try {
      credencial = await this.#opciones.accessToken();
    } catch (error) {
      clearTimeout(reloj);
      const crudo = (error as { message?: string }).message ?? 'sin detalle';
      return this.#error(
        'CREDENCIAL_RECHAZADA',
        `no se pudo resolver el access token: ${redactarTexto(crudo)}`,
      );
    }

    let respuesta;
    try {
      respuesta = await this.#fetch(`${this.#base}${ruta}`, {
        method: metodo,
        headers: {
          'content-type': 'application/json',
          // La única vez que la credencial aparece. No se guarda en ningún campo
          // del objeto, no se loguea, y no viaja en ningún error: las dos
          // limpiezas de abajo la sacan de cualquier texto que el proveedor
          // devuelva.
          authorization: `Bearer ${credencial}`,
          ...extras,
        },
        ...(cuerpo === undefined ? {} : { body: cuerpo }),
        signal: controlador.signal,
      });
    } catch (error) {
      const nombre = (error as { name?: string }).name;
      if (nombre === 'AbortError') {
        return this.#error(
          'TIMEOUT',
          `no contestó en ${this.#opciones.timeoutMs} ms. No se reintenta: un timeout no dice ` +
            'que la operación no haya ocurrido, y repetirla podría cobrar dos veces',
        );
      }
      // Doble limpieza, por dos motivos distintos: `taparValor` saca la
      // credencial concreta esté donde esté, y `redactarTexto` saca cualquier
      // parámetro que parezca un secreto en cualquier URL del mensaje.
      const crudo = (error as { message?: string }).message ?? 'sin detalle';
      return this.#error('RED', redactarTexto(taparValor(crudo, credencial)));
    } finally {
      clearTimeout(reloj);
    }

    const texto = await respuesta.text().catch(() => '');

    if (!respuesta.ok) {
      const delProveedor = mensajeDeError(texto);
      return this.#error(
        porStatus(respuesta.status),
        `Mercado Pago contestó ${respuesta.status}` +
          (delProveedor === null
            ? ''
            : `: ${redactarTexto(taparValor(delProveedor, credencial))}`),
        respuesta.status,
      );
    }

    const cuerpoLeido = objeto(texto);
    if (cuerpoLeido === null) {
      return this.#ilegible(`respondió ${respuesta.status} con un cuerpo que no es un objeto JSON`);
    }

    return { ok: true, valor: { cuerpo: cuerpoLeido, status: respuesta.status } };
  }
}
