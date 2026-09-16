/**
 * El puerto de la pasarela de pagos.
 *
 * Misma forma que resolvieron el correo, el proveedor de modelo y el gestor de
 * secretos: la estructura de este lado, el vendor del otro lado de la interfaz.
 *
 * ## Lo que este archivo NO nombra, a propósito
 *
 * No dice «Mercado Pago» en ninguna parte. Las operaciones están escritas en los
 * términos que **el billing de NEXO** necesita —asegurar un plan, suscribir una
 * empresa, pausar, cancelar— y no en los de la API de un proveedor. Si mañana
 * hubiera un segundo proveedor, lo que cambia es el adaptador.
 *
 * Es la diferencia entre:
 *
 *     NEXO Billing → Puerto → Mercado Pago
 *
 * y la que había que evitar:
 *
 *     NEXO Billing → Mercado Pago en todas partes
 *
 * ## Lo que NEXO no guarda nunca
 *
 * Ni número de tarjeta, ni CVV, ni fecha de vencimiento. Lo único que vuelve del
 * proveedor y se persiste son **referencias**: el id de la suscripción, el del
 * plan, y a lo sumo los últimos cuatro dígitos y el medio, que ya tienen columna
 * en `payment_intents` desde la 0096.
 */

/**
 * El vocabulario del proveedor y su traducción viven en el motor puro
 * (`@aai/billing-engine/pasarela`), no acá.
 *
 * La razón es que traducir «pausada» a un estado comercial de NEXO **es una
 * decisión de negocio**, no transporte: si viviera en este archivo, cambiar de
 * proveedor obligaría a volver a tomarla. Y siendo pura se puede ejercitar
 * entera, sin cuenta y sin red.
 *
 * Se reexportan para que quien implemente un adaptador tenga todo lo que
 * necesita en un solo import.
 */
export type {
  EstadoExternoDeSuscripcion,
  EstadoExternoDePago,
  CodigoDeFalloDePago,
} from '@aai/billing-engine';

import type {
  CodigoDeFalloDePago,
  EstadoDePago,
  EstadoExternoDeSuscripcion,
} from '@aai/billing-engine';

/** Cada cuánto se cobra. Es el vocabulario de `company_subscriptions`. */
export type Periodicidad = 'MENSUAL' | 'ANUAL';

/** Un plan de NEXO, en los términos que hacen falta para replicarlo afuera. */
export interface PlanParaProveedor {
  readonly codigo: string;
  readonly nombre: string;
  /** En la unidad menor de la moneda —centavos—, como todo importe del sistema. */
  readonly importeCentavos: bigint;
  readonly moneda: string;
  readonly periodicidad: Periodicidad;
  /**
   * Días de prueba que el **proveedor** tiene que regalar antes del primer
   * cobro, o `null` para que no regale ninguno.
   *
   * ## Existe, y está deliberadamente sin usar
   *
   * Mercado Pago soporta `free_trial` dentro de `auto_recurring`, con
   * `frequency_type: "days"`. El campo está acá para que el día que se quiera
   * usar no haya que tocar la interfaz — pero **hoy nadie lo manda, y es una
   * decisión tomada**, no un pendiente.
   *
   * El motivo: en NEXO la prueba de catorce días **es la suscripción**
   * (`estado = 'PRUEBA'`), empieza sin pedir tarjeta y termina cuando el cliente
   * convierte. Recién ahí se conecta la pasarela. Si además el plan del
   * proveedor tuviera `free_trial`, el reloj arrancaría de nuevo en el momento
   * de autorizar: el cliente tendría catorce días más de gracia **mientras NEXO
   * ya está emitiendo el cargo**. Serían dos semanas de servicio facturado que
   * nadie paga, por cliente y por plan.
   *
   * La prueba vive en un solo lugar. `scripts/declarar-plan-de-pasarela.mjs` no
   * lo manda nunca, y `tests/unit/pasarela-de-pagos.test.ts` comprueba que el
   * cuerpo salga sin `free_trial`.
   */
  readonly diasDePruebaDelProveedor?: number | null;
}

export interface SuscripcionParaProveedor {
  /**
   * Qué entidad de NEXO representa. Viaja al proveedor como referencia externa
   * y es lo que permite reconstruir el vínculo desde un webhook.
   *
   * **Nunca el correo**: una persona cambia de dirección, y dos empresas pueden
   * compartirla.
   */
  readonly referenciaNexo: string;
  readonly planExternoId: string;
  /** El proveedor lo exige para identificar al pagador. No es la clave. */
  readonly correoDelPagador: string;
  readonly importeCentavos: bigint;
  readonly moneda: string;
  /** A dónde vuelve el navegador después de autorizar. */
  readonly urlDeRetorno: string;
}

export interface FalloDePago {
  readonly codigo: CodigoDeFalloDePago;
  /** Sanitizado: nunca lleva credenciales ni datos de tarjeta. */
  readonly detalle: string;
  readonly status?: number;
}

export type Resultado<T> =
  | { readonly ok: true; readonly valor: T }
  | { readonly ok: false; readonly fallo: FalloDePago };

export interface PlanExterno {
  readonly id: string;
  readonly estado: string;
}

export interface SuscripcionExterna {
  readonly id: string;
  readonly estado: EstadoExternoDeSuscripcion;
  /** A dónde mandar al cliente para que autorice. Solo al crearla. */
  readonly urlDeAutorizacion?: string | null;
  /** La referencia de NEXO que viajó, tal como la devuelve el proveedor. */
  readonly referenciaNexo?: string | null;
  /**
   * Cuándo va a debitar el proveedor la próxima vez, en `AAAA-MM-DD`.
   *
   * Es lo único que permite contestar la pregunta que nadie podía contestar:
   * **¿la fecha en la que NEXO factura es la misma en la que la pasarela
   * cobra?** El ciclo de NEXO avanza `proxima_facturacion` con su propio
   * calendario y el proveedor debita con el suyo, contado desde el día que el
   * cliente autorizó. No tienen por qué coincidir, y cuando se separan nadie se
   * entera: los dos sistemas funcionan bien, cada uno por su lado.
   *
   * `null` es «el proveedor no lo informó», no «no hay próximo cobro».
   */
  readonly proximoCobro?: string | null;
}

/** Lo que se sabe de un cobro concreto dentro de una suscripción. */
export interface PagoExterno {
  readonly id: string;
  /** Ya traducido con `estadoDePagoDesde`: el adaptador normaliza, el motor traduce. */
  readonly estado: EstadoDePago;
  readonly suscripcionExternaId?: string | null;
  readonly importeCentavos?: bigint | null;
  readonly moneda?: string | null;
  readonly medio?: string | null;
  readonly ultimos4?: string | null;
  /**
   * Por qué el proveedor rechazó el cobro, en sus palabras.
   *
   * `payment_intents` tiene `CHECK (estado <> 'FALLIDO' OR detalle_error IS NOT
   * NULL)` desde la 0096: un fallo sin motivo no se puede guardar, y con razón
   * —el día que un cliente pregunte por qué no le pasó la tarjeta, esto es lo
   * único que hay—. Hasta B2.5.6 el puerto no traía este dato, así que el
   * primer rechazo que llegara por webhook **rompía la transacción del drenaje
   * entero** y dejaba sin procesar todo lo que venía detrás.
   *
   * Nunca lleva datos del medio de pago: es el código y el texto del proveedor,
   * y el adaptador los recorta antes de devolverlos.
   */
  readonly detalleDelFallo?: string | null;
}

/**
 * Lo que el billing le pide a una pasarela.
 *
 * Ocho operaciones, y ninguna de más: cada una existe porque el ciclo comercial
 * de NEXO la necesita. `consultarPago` está porque **un webhook no se cree solo**
 * — el payload dice qué pasó, y el estado definitivo se le pregunta al
 * proveedor.
 */
export interface ProveedorDePagos {
  readonly id: string;

  /** Crea el plan del lado del proveedor, o devuelve el que ya está. */
  asegurarPlan(plan: PlanParaProveedor): Promise<Resultado<PlanExterno>>;

  crearSuscripcion(datos: SuscripcionParaProveedor): Promise<Resultado<SuscripcionExterna>>;
  consultarSuscripcion(id: string): Promise<Resultado<SuscripcionExterna>>;
  pausarSuscripcion(id: string): Promise<Resultado<SuscripcionExterna>>;
  reactivarSuscripcion(id: string): Promise<Resultado<SuscripcionExterna>>;
  cancelarSuscripcion(id: string): Promise<Resultado<SuscripcionExterna>>;

  /** El estado definitivo de un cobro, preguntado al proveedor. */
  consultarPago(id: string): Promise<Resultado<PagoExterno>>;

  /**
   * ¿La notificación viene de verdad del proveedor?
   *
   * Devuelve `null` cuando **no se puede afirmar**: no hay proveedor, o hay pero
   * no tiene secreto de firma configurado. Es distinto de `false`, que significa
   * «vino firmada y la firma no cierra» —o sea, alguien intentó hacerse pasar
   * por el proveedor—. Quien llame tiene que poder distinguirlos: uno es una
   * instalación incompleta y el otro es un incidente de seguridad.
   *
   * Es `async` aunque el cálculo del HMAC sea sincrónico, y a propósito: el
   * secreto se resuelve **por llamada** contra el gestor de secretos, igual que
   * la credencial en el resto del sistema. Devolverlo sincrónico obligaría a
   * guardar el secreto dentro del objeto, que vive tanto como el proceso.
   */
  verificarFirma(entrada: EntradaDeFirma): Promise<boolean | null>;
}

export interface EntradaDeFirma {
  readonly cabeceras: Readonly<Record<string, string | undefined>>;
  readonly cuerpoCrudo: string;
  /** El identificador del recurso que la notificación menciona. */
  readonly recursoId: string;
}

/**
 * El que hay hoy: ninguno.
 *
 * No tira. Que no haya pasarela contratada es una condición conocida del
 * despliegue —está escrita en `NEXO_BILLING.md` §10— y no un error del ciclo de
 * facturación, que sigue emitiendo, llevando la cobranza y registrando los
 * cobros por transferencia.
 *
 * Contesta `SIN_PASARELA` en todo, que es exactamente lo que `intentarCobro()`
 * devolvía antes de que este puerto existiera. La diferencia es que ahora ese
 * estado sale de un proveedor y no de una función escrita a mano, así que
 * conectar uno no cambia ninguna línea de quien lo usa.
 */
export class SinPasarela implements ProveedorDePagos {
  readonly id = 'ninguno';

  readonly #fallo: FalloDePago = {
    codigo: 'SIN_PASARELA',
    detalle:
      'No hay pasarela de pago conectada. El ciclo emite y lleva la cobranza igual; ' +
      'un cobro por transferencia se registra a mano.',
  };

  async asegurarPlan(): Promise<Resultado<PlanExterno>> {
    return { ok: false, fallo: this.#fallo };
  }
  async crearSuscripcion(): Promise<Resultado<SuscripcionExterna>> {
    return { ok: false, fallo: this.#fallo };
  }
  async consultarSuscripcion(): Promise<Resultado<SuscripcionExterna>> {
    return { ok: false, fallo: this.#fallo };
  }
  async pausarSuscripcion(): Promise<Resultado<SuscripcionExterna>> {
    return { ok: false, fallo: this.#fallo };
  }
  async reactivarSuscripcion(): Promise<Resultado<SuscripcionExterna>> {
    return { ok: false, fallo: this.#fallo };
  }
  async cancelarSuscripcion(): Promise<Resultado<SuscripcionExterna>> {
    return { ok: false, fallo: this.#fallo };
  }
  async consultarPago(): Promise<Resultado<PagoExterno>> {
    return { ok: false, fallo: this.#fallo };
  }

  /**
   * `null`, no `false`.
   *
   * Sin proveedor no hay nada que verificar, y contestar `false` haría que el
   * webhook registrara «firma inválida» —que se lee como un intento de
   * suplantación— cuando lo que pasa es que no hay pasarela.
   */
  async verificarFirma(): Promise<boolean | null> {
    return null;
  }
}
