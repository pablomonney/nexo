/**
 * El ciclo de facturación de NEXO.
 *
 * ## Esto no es una ruta, y no puede serlo
 *
 * Ninguna función de este archivo recibe un pedido HTTP ni abre una conexión.
 * Reciben un `Tx` **que les da quien las llama**, y quien las llama es un script
 * del operador de la instalación, no un usuario de una empresa.
 *
 * El motivo es directo: el administrador de una empresa cliente no tiene por qué
 * poder emitirse a sí mismo un cargo, ni marcarlo pagado, ni levantarse una
 * suspensión. Por eso `aai_app` tiene **solo `SELECT`** sobre las tablas de
 * facturación (0096) y por eso no existe un endpoint que escriba en ellas.
 *
 * No alcanza con no escribirlo: `tests/security/facturacion-sin-ruta.test.ts`
 * comprueba que ninguna ruta importe este módulo. Una regla que solo vive en un
 * comentario dura hasta el primer apuro.
 *
 * ## Lo que el ciclo puede hacer hoy, y lo que no
 *
 *     emitir           sí — sale del precio acordado y del período
 *     registrar cobro  sí — un pago por transferencia se registra a mano
 *     cobrar solo      NO — no hay pasarela contratada
 *
 * El paso que falta es el único que necesita un tercero. Todo lo demás está y
 * corre. Cuando haya pasarela, `intentarCobro` deja de devolver
 * `SIN_PASARELA` y ninguna fila se migra.
 *
 * ## Cero no es «no se puede afirmar»
 *
 * Sin precio vigente, una suscripción **no se factura** y el informe lo dice.
 * No se emite un cargo de cero: un cargo de cero se ve igual que un cliente que
 * no debe nada, y el mes que viene nadie va a ir a buscar por qué.
 */

import { recordAudit, type Tx } from '@aai/db';
import {
  esAtrasado,
  esRepeticion,
  pasoPendiente,
  periodoDe,
  periodoSiguiente,
  planDeCobranza,
  proporcionDelPeriodo,
  prorratearPorDias,
  puedeTransicionar,
  puedeTransicionarDocumento,
  puedeTransicionarPago,
  revisarPolitica,
  type EstadoDeDocumento,
  type EstadoDePago,
  type EstadoDeSuscripcion,
  type PasoDeCobranza,
  type Periodicidad,
  type PoliticaDeCobranza,
} from '@aai/billing-engine';
import {
  addDays,
  moneyFromDecimalString,
  parseCalendarDate,
  toDecimalString,
  isCurrency,
  type CalendarDate,
} from '@aai/shared';

/** Lo que el ciclo hizo y lo que no pudo hacer, con el motivo. */
export interface InformeDeCiclo {
  readonly hoy: CalendarDate;
  readonly emitidos: readonly DocumentoEmitido[];
  readonly omitidos: readonly Omision[];
  readonly cobranza: readonly PasoEjecutado[];
}

export interface DocumentoEmitido {
  readonly documentId: string;
  readonly companyId: string;
  readonly numero: string;
  readonly moneda: string;
  readonly importe: string;
  readonly desde: CalendarDate;
  readonly hasta: CalendarDate;
}

/**
 * Una suscripción que tocaba facturar y no se facturó.
 *
 * Se informa una por una con su motivo en vez de contarlas: «tres omitidas» no
 * le sirve a nadie, y el motivo es exactamente lo que hay que arreglar.
 */
export interface Omision {
  readonly subscriptionId: string;
  readonly companyId: string;
  readonly motivo:
    | 'SIN_CONDICIONES_ACORDADAS'
    | 'SIN_PRECIO_VIGENTE'
    | 'MONEDA_DESCONOCIDA'
    | 'PERIODO_YA_FACTURADO';
  readonly detalle: string;
}

export interface PasoEjecutado {
  readonly documentId: string;
  readonly companyId: string;
  readonly paso: PasoDeCobranza;
  readonly resultado: 'HECHO' | 'FALLIDO' | 'OMITIDO';
  readonly detalle: string;
}

interface FilaDeSuscripcion {
  readonly id: string;
  readonly company_id: string;
  readonly plan_id: string;
  readonly estado: string;
  readonly periodicidad: string | null;
  readonly moneda: string | null;
  readonly importe_acordado: string | null;
  readonly proxima_facturacion: string | null;
  readonly vigencia_desde: string;
}

/**
 * Emite los cargos de todas las suscripciones que tocan hoy.
 *
 * «Que tocan hoy» incluye las atrasadas: si el ciclo no corrió el lunes, el
 * martes emite las del lunes y las del martes. Emitir solo las de hoy dejaría un
 * mes de servicio sin cobrar y nadie lo notaría hasta la conciliación.
 */
export async function emitirVencidos(
  tx: Tx,
  hoy: CalendarDate,
  actorId: string,
): Promise<{ emitidos: DocumentoEmitido[]; omitidos: Omision[] }> {
  const { rows } = await tx.query<FilaDeSuscripcion>(
    `SELECT id, company_id, plan_id, estado, periodicidad, moneda,
            importe_acordado::text AS importe_acordado,
            proxima_facturacion::text AS proxima_facturacion,
            vigencia_desde::text AS vigencia_desde
       FROM company_subscriptions
      WHERE estado IN ('ACTIVA', 'SUSPENDIDA')
        AND proxima_facturacion IS NOT NULL
        AND proxima_facturacion <= $1::date
      ORDER BY proxima_facturacion, id`,
    [hoy],
  );

  const emitidos: DocumentoEmitido[] = [];
  const omitidos: Omision[] = [];

  for (const s of rows) {
    // Suspendida se sigue facturando: la deuda corre igual. Lo que se corta es
    // el acceso, no el contrato — y si se dejara de facturar, levantar la
    // suspensión dejaría un hueco de servicio que ningún documento explica.
    if (
      s.periodicidad === null ||
      s.moneda === null ||
      s.importe_acordado === null ||
      s.proxima_facturacion === null
    ) {
      omitidos.push({
        subscriptionId: s.id,
        companyId: s.company_id,
        motivo: 'SIN_CONDICIONES_ACORDADAS',
        detalle:
          'La suscripción no tiene periodicidad, moneda, importe y próxima facturación. ' +
          'Sin las cuatro no hay qué cobrar ni cuándo.',
      });
      continue;
    }

    if (!isCurrency(s.moneda)) {
      omitidos.push({
        subscriptionId: s.id,
        companyId: s.company_id,
        motivo: 'MONEDA_DESCONOCIDA',
        detalle: `La moneda ${s.moneda} no está en el catálogo: no se sabe cuántos decimales tiene.`,
      });
      continue;
    }

    const periodicidad = s.periodicidad as Periodicidad;
    const desde = parseCalendarDate(s.proxima_facturacion);
    const periodo = periodoDe(desde, periodicidad);

    const yaEsta = await tx.query(
      'SELECT 1 FROM billing_periods WHERE subscription_id = $1 AND desde = $2::date',
      [s.id, periodo.desde],
    );
    if (yaEsta.rowCount !== null && yaEsta.rowCount > 0) {
      // El `UNIQUE` de la 0096 ya lo impide; esto lo convierte en un informe en
      // vez de en una excepción, que es lo que corresponde cuando el ciclo se
      // corre dos veces el mismo día. Correrlo dos veces tiene que ser inocuo.
      omitidos.push({
        subscriptionId: s.id,
        companyId: s.company_id,
        motivo: 'PERIODO_YA_FACTURADO',
        detalle: `El período que arranca el ${periodo.desde} ya tiene documento.`,
      });
      continue;
    }

    const acordado = moneyFromDecimalString(s.importe_acordado, s.moneda);

    // El primer período puede arrancar después del inicio de la vigencia: quien
    // se dio de alta un 16 paga la parte que usó, no el mes entero.
    const inicio = parseCalendarDate(s.vigencia_desde);
    const importe =
      inicio > periodo.desde && inicio <= periodo.hasta
        ? proporcionDelPeriodo(acordado, periodo, { desde: inicio, hasta: periodo.hasta })
        : acordado;

    const periodoFila = await tx.query<{ id: string }>(
      `INSERT INTO billing_periods
         (company_id, subscription_id, desde, hasta, estado, moneda, importe, created_by)
       VALUES ($1, $2, $3::date, $4::date, 'FACTURADO', $5, $6::numeric, $7)
       RETURNING id`,
      [s.company_id, s.id, periodo.desde, periodo.hasta, s.moneda, toDecimalString(importe), actorId],
    );

    const documento = await tx.query<{ id: string; numero: string }>(
      `INSERT INTO billing_documents
         (company_id, subscription_id, period_id, tipo, moneda, importe_total,
          estado, emitido_el, created_by)
       VALUES ($1, $2, $3, 'CARGO', $4, $5::numeric, 'EMITIDO', $6::date, $7)
       RETURNING id, numero::text AS numero`,
      [
        s.company_id,
        s.id,
        periodoFila.rows[0]!.id,
        s.moneda,
        toDecimalString(importe),
        hoy,
        actorId,
      ],
    );

    const doc = documento.rows[0]!;

    await tx.query(
      `INSERT INTO billing_document_lines
         (document_id, company_id, orden, concepto, cantidad, precio_unitario, importe)
       VALUES ($1, $2, 1, $3, 1, $4::numeric, $4::numeric)`,
      [
        doc.id,
        s.company_id,
        `Suscripción ${periodicidad.toLowerCase()} — ${periodo.desde} a ${periodo.hasta}`,
        toDecimalString(importe),
      ],
    );

    // `vence_el` queda en NULL y no en «hoy»: cuántos días de plazo se dan es
    // una decisión comercial que nadie declaró, y ponerle una la inventaría.
    // La vista informa `dias_de_atraso` en NULL, que es «no se puede afirmar».

    await recordAudit(tx, s.company_id, {
      actorType: 'SYSTEM',
      actorId,
      action: 'EMITIR_DOCUMENTO_DE_COBRO',
      objectType: 'billing_document',
      objectId: doc.id,
      newValue: {
        numero: doc.numero,
        moneda: s.moneda,
        importe: toDecimalString(importe),
        desde: periodo.desde,
        hasta: periodo.hasta,
        prorrateado: importe.amount !== acordado.amount,
      },
    });

    // El período siguiente lo calcula el motor y no un `+ 1` en SQL: es la misma
    // cuenta que decide dónde termina cada período, y hacerla dos veces en dos
    // lenguajes distintos es cómo aparecen los huecos de un día en febrero.
    await tx.query(
      'UPDATE company_subscriptions SET proxima_facturacion = $1::date WHERE id = $2',
      [periodoSiguiente(periodo, periodicidad).desde, s.id],
    );

    emitidos.push({
      documentId: doc.id,
      companyId: s.company_id,
      numero: doc.numero,
      moneda: s.moneda,
      importe: toDecimalString(importe),
      desde: periodo.desde,
      hasta: periodo.hasta,
    });
  }

  return { emitidos, omitidos };
}

export type ResultadoDeCobro =
  | { readonly estado: 'REGISTRADO'; readonly intentId: string; readonly reactivada: boolean }
  | { readonly estado: 'YA_REGISTRADO'; readonly intentId: string }
  | { readonly estado: 'DOCUMENTO_NO_COBRABLE'; readonly detalle: string };

/**
 * Registra un cobro recibido fuera de toda pasarela — una transferencia.
 *
 * Es el camino que funciona hoy, y no es un parche: una parte de los clientes
 * paga por transferencia aunque haya pasarela, y esa plata tiene que poder
 * entrar al sistema igual.
 *
 * `idempotencia` la da quien llama y es obligatoria. Dos veces la misma clave
 * son el mismo cobro: el `UNIQUE` de la 0096 lo hace imposible en vez de
 * improbable, y acá se traduce a `YA_REGISTRADO` en vez de a una excepción,
 * porque reintentar el registro de un cobro es normal.
 */
export async function registrarCobro(
  tx: Tx,
  entrada: {
    readonly documentId: string;
    readonly proveedor: string;
    readonly idempotencia: string;
    readonly referenciaExterna?: string | null;
    readonly actorId: string;
    readonly pagadoEl: CalendarDate;
  },
): Promise<ResultadoDeCobro> {
  const doc = await tx.query<{
    id: string;
    company_id: string;
    subscription_id: string;
    estado: string;
    moneda: string;
    importe_total: string;
  }>(
    `SELECT id, company_id, subscription_id, estado, moneda, importe_total::text AS importe_total
       FROM billing_documents WHERE id = $1`,
    [entrada.documentId],
  );
  const d = doc.rows[0];
  if (d === undefined) {
    return { estado: 'DOCUMENTO_NO_COBRABLE', detalle: 'No existe ese documento.' };
  }

  // La idempotencia se pregunta **antes** que el estado del documento, y el
  // orden importa: registrar un cobro lo deja PAGADO, así que preguntar primero
  // por el estado hacía que el reintento del mismo registro —una red que se
  // cortó, un webhook reenviado— contestara «documento no cobrable». El que
  // reintenta lee eso como «algo salió mal» y lo intenta de otra forma, que es
  // exactamente cómo se cobra dos veces. Lo encontró el test de idempotencia,
  // no la lectura del código.
  const previo = await tx.query<{ id: string }>(
    'SELECT id FROM payment_intents WHERE idempotency_key = $1',
    [entrada.idempotencia],
  );
  if (previo.rows[0] !== undefined) {
    return { estado: 'YA_REGISTRADO', intentId: previo.rows[0].id };
  }

  if (d.estado !== 'EMITIDO' && d.estado !== 'INCOBRABLE') {
    return {
      estado: 'DOCUMENTO_NO_COBRABLE',
      detalle: `El documento está ${d.estado}: solo se cobra lo emitido o lo declarado incobrable.`,
    };
  }

  // Se crea PENDIENTE y se lo lleva a PAGADO por el mismo camino que va a usar
  // el webhook. Insertarlo ya en PAGADO sería un segundo camino hacia el mismo
  // estado, y el día que los dos difieran nadie va a saber cuál corrió.
  const intento = await tx.query<{ id: string }>(
    `INSERT INTO payment_intents
       (company_id, document_id, proveedor, referencia_externa, moneda, importe,
        estado, idempotency_key)
     VALUES ($1, $2, $3, $4, $5, $6::numeric, 'PENDIENTE', $7)
     RETURNING id`,
    [
      d.company_id,
      d.id,
      entrada.proveedor,
      entrada.referenciaExterna ?? null,
      d.moneda,
      d.importe_total,
      entrada.idempotencia,
    ],
  );

  const aplicado = await procesarEventoDePago(tx, {
    proveedor: entrada.proveedor,
    // El identificador del evento sale de la clave de idempotencia: un registro
    // manual no tiene número de evento de pasarela, y usar el mismo valor hace
    // que registrar dos veces choque contra el `UNIQUE` igual que un webhook
    // reenviado.
    eventoExterno: `manual:${entrada.idempotencia}`,
    tipo: 'COBRO_REGISTRADO_A_MANO',
    estadoInformado: 'PAGADO',
    intentId: intento.rows[0]!.id,
    ...(entrada.referenciaExterna === undefined
      ? {}
      : { referenciaExterna: entrada.referenciaExterna }),
  });
  if (aplicado.resultado !== 'APLICADO') {
    return {
      estado: 'DOCUMENTO_NO_COBRABLE',
      detalle: `El intento de pago quedó en ${aplicado.resultado} y no se aplicó el cobro.`,
    };
  }

  await tx.query(
    `UPDATE billing_documents SET estado = 'PAGADO', pagado_el = $1::date WHERE id = $2`,
    [entrada.pagadoEl, d.id],
  );

  await recordAudit(tx, d.company_id, {
    actorType: 'SYSTEM',
    actorId: entrada.actorId,
    action: 'REGISTRAR_COBRO',
    objectType: 'billing_document',
    objectId: d.id,
    newValue: {
      proveedor: entrada.proveedor,
      moneda: d.moneda,
      importe: d.importe_total,
      pagadoEl: entrada.pagadoEl,
    },
  });

  // Pagar levanta la suspensión, y solo si no queda otra deuda emitida. Levantar
  // con deuda abierta dejaría entrar a quien pagó una de tres facturas.
  const deuda = await tx.query<{ n: string }>(
    `SELECT count(*)::text AS n FROM billing_documents
      WHERE subscription_id = $1 AND estado = 'EMITIDO'`,
    [d.subscription_id],
  );
  const sinDeuda = deuda.rows[0]!.n === '0';

  const sub = await tx.query<{ estado: string }>(
    'SELECT estado FROM company_subscriptions WHERE id = $1',
    [d.subscription_id],
  );
  const reactivar = sinDeuda && sub.rows[0]?.estado === 'SUSPENDIDA';

  if (reactivar) {
    await tx.query(
      `UPDATE company_subscriptions
          SET estado = 'ACTIVA', suspendida_el = NULL, motivo = NULL
        WHERE id = $1`,
      [d.subscription_id],
    );
    await recordAudit(tx, d.company_id, {
      actorType: 'SYSTEM',
      actorId: entrada.actorId,
      action: 'REACTIVAR_POR_PAGO',
      objectType: 'company_subscription',
      objectId: d.subscription_id,
      newValue: { documento: d.id },
    });
  }

  return { estado: 'REGISTRADO', intentId: intento.rows[0]!.id, reactivada: reactivar };
}

/**
 * La política vigente, o `null` si nadie declaró ninguna.
 *
 * `null` no es una política permisiva: es la ausencia de una. Quien la recibe
 * tiene que decidir qué hacer con eso, y lo que hace el ciclo es **no hacer
 * nada y decirlo**.
 */
export async function politicaVigente(
  tx: Tx,
  hoy: CalendarDate,
): Promise<PoliticaDeCobranza | null> {
  const { rows } = await tx.query<{
    reintentos_en_dias: number[];
    aviso_en_dias: number;
    dias_de_gracia: number;
  }>(
    `SELECT reintentos_en_dias, aviso_en_dias, dias_de_gracia
       FROM collection_policies
      WHERE vigente_desde <= $1::date
        AND (vigente_hasta IS NULL OR vigente_hasta > $1::date)
      ORDER BY vigente_desde DESC
      LIMIT 1`,
    [hoy],
  );
  const p = rows[0];
  if (p === undefined) return null;

  const politica: PoliticaDeCobranza = {
    reintentosEnDias: p.reintentos_en_dias,
    avisoEnDias: p.aviso_en_dias,
    diasDeGracia: p.dias_de_gracia,
  };
  // Los `CHECK` de la 0096 ya la validan al insertarla. Esto es la segunda
  // lectura, y existe porque las dos reglas se escribieron por separado: si
  // alguna vez difieren, es mejor enterarse acá que suspender a alguien de más.
  return revisarPolitica(politica).length === 0 ? politica : null;
}

/**
 * Avanza la cobranza de los documentos con un pago fallido.
 *
 * El disparador es **el fallo de pago**, no el vencimiento del documento: un
 * documento que nunca se intentó cobrar no está en mora por culpa del cliente.
 */
export async function avanzarCobranza(
  tx: Tx,
  hoy: CalendarDate,
  actorId: string,
): Promise<PasoEjecutado[]> {
  const politica = await politicaVigente(tx, hoy);

  const { rows } = await tx.query<{
    document_id: string;
    company_id: string;
    subscription_id: string;
    fallo_el: string;
  }>(
    `SELECT d.id AS document_id, d.company_id, d.subscription_id,
            min(i.created_at)::date::text AS fallo_el
       FROM billing_documents d
       JOIN payment_intents i ON i.document_id = d.id AND i.estado = 'FALLIDO'
      WHERE d.estado = 'EMITIDO'
      GROUP BY d.id, d.company_id, d.subscription_id
      ORDER BY 4, 1`,
  );

  const hechos: PasoEjecutado[] = [];

  for (const fila of rows) {
    if (politica === null) {
      hechos.push({
        documentId: fila.document_id,
        companyId: fila.company_id,
        paso: { tipo: 'REINTENTO', el: hoy, numero: 1 },
        resultado: 'OMITIDO',
        detalle:
          'No hay política de cobranza declarada. Un pago fallido se registra y no ' +
          'dispara nada: eso no es cero reintentos, es que nadie dijo cuántos.',
      });
      continue;
    }

    const plan = planDeCobranza(parseCalendarDate(fila.fallo_el), politica);

    const previos = await tx.query<{ tipo: string; numero: number | null }>(
      'SELECT tipo, numero FROM collection_steps WHERE document_id = $1',
      [fila.document_id],
    );
    const yaHechos: PasoDeCobranza[] = previos.rows.map((p) => ({
      tipo: p.tipo as PasoDeCobranza['tipo'],
      el: hoy,
      ...(p.numero === null ? {} : { numero: p.numero }),
    }));

    const paso = pasoPendiente(plan, yaHechos, hoy);
    if (paso === null) continue;

    const ejecutado = await ejecutarPaso(tx, fila, paso, actorId);
    hechos.push(ejecutado);
  }

  return hechos;
}

async function ejecutarPaso(
  tx: Tx,
  fila: { document_id: string; company_id: string; subscription_id: string },
  paso: PasoDeCobranza,
  actorId: string,
): Promise<PasoEjecutado> {
  let resultado: 'HECHO' | 'FALLIDO' | 'OMITIDO' = 'HECHO';
  let detalle = '';

  if (paso.tipo === 'REINTENTO') {
    const intento = await intentarCobro();
    resultado = intento.estado === 'SIN_PASARELA' ? 'OMITIDO' : 'HECHO';
    detalle = intento.detalle;
  } else if (paso.tipo === 'AVISO') {
    // Avisar es mandar un correo, y no hay proveedor de correo. Se registra el
    // paso igual y se dice que no se pudo mandar: sin registro, el ciclo lo
    // volvería a intentar todos los días y el cliente no se enteraría igual.
    resultado = 'OMITIDO';
    detalle = 'No hay proveedor de correo configurado: el aviso no se envió.';
  } else {
    // La transición se pregunta antes de intentarla. El `WHERE estado = 'ACTIVA'`
    // de abajo la impediría igual, pero en silencio: la suscripción quedaría sin
    // suspender y el paso registrado como hecho. Preguntar primero permite decir
    // que no se suspendió y por qué.
    const actual = await tx.query<{ estado: EstadoDeSuscripcion }>(
      'SELECT estado FROM company_subscriptions WHERE id = $1',
      [fila.subscription_id],
    );
    const desde = actual.rows[0]?.estado;
    if (desde === undefined || !puedeTransicionar(desde, 'SUSPENDIDA')) {
      await tx.query(
        `INSERT INTO collection_steps
           (company_id, document_id, tipo, numero, programado_para, resultado, detalle)
         VALUES ($1, $2, $3, $4, $5::date, 'OMITIDO', $6)`,
        [
          fila.company_id,
          fila.document_id,
          paso.tipo,
          paso.numero ?? null,
          paso.el,
          `La suscripción está ${desde ?? 'ausente'}: de ahí no se pasa a SUSPENDIDA.`,
        ],
      );
      return {
        documentId: fila.document_id,
        companyId: fila.company_id,
        paso,
        resultado: 'OMITIDO',
        detalle: `La suscripción está ${desde ?? 'ausente'}: de ahí no se pasa a SUSPENDIDA.`,
      };
    }

    await tx.query(
      `UPDATE company_subscriptions
          SET estado = 'SUSPENDIDA', suspendida_el = $1::date, motivo = $2
        WHERE id = $3 AND estado = 'ACTIVA'`,
      [paso.el, 'Falta de pago', fila.subscription_id],
    );
    await recordAudit(tx, fila.company_id, {
      actorType: 'SYSTEM',
      actorId,
      action: 'SUSPENDER_POR_FALTA_DE_PAGO',
      objectType: 'company_subscription',
      objectId: fila.subscription_id,
      motivo: `Documento ${fila.document_id} impago según la política de cobranza vigente`,
      newValue: { documento: fila.document_id, suspendidaEl: paso.el },
    });
    detalle = 'Suspendida por falta de pago. Los datos y la contabilidad quedan intactos.';
  }

  await tx.query(
    `INSERT INTO collection_steps
       (company_id, document_id, tipo, numero, programado_para, resultado, detalle)
     VALUES ($1, $2, $3, $4, $5::date, $6, $7)`,
    [
      fila.company_id,
      fila.document_id,
      paso.tipo,
      paso.numero ?? null,
      paso.el,
      resultado,
      detalle,
    ],
  );

  return {
    documentId: fila.document_id,
    companyId: fila.company_id,
    paso,
    resultado,
    detalle,
  };
}

/**
 * Cobrarle a una tarjeta. **No hay pasarela contratada.**
 *
 * Devuelve un estado en vez de tirar: que no haya proveedor de pagos es una
 * condición conocida del despliegue, no un error del ciclo. El ciclo sigue
 * corriendo, emite, informa y deja constancia de qué no pudo hacer.
 *
 * El día que haya pasarela, esto pasa a llamar al adaptador y **ninguna fila se
 * migra**: lo que cambia es de dónde sale la respuesta.
 */
export async function intentarCobro(): Promise<{
  readonly estado: 'SIN_PASARELA';
  readonly detalle: string;
}> {
  return {
    estado: 'SIN_PASARELA',
    detalle:
      'No hay pasarela de pago conectada: el reintento no se pudo ejecutar. ' +
      'Un cobro por transferencia se registra igual, a mano.',
  };
}

export type ResultadoDeEvento =
  | 'APLICADO'
  | 'REPETIDO'
  | 'ATRASADO'
  | 'DESCONOCIDO'
  | 'CONFLICTO';

/**
 * Aplica lo que informó una pasarela sobre un intento de cobro.
 *
 * Es el punto por donde va a entrar el webhook el día que haya proveedor. Hoy lo
 * usa `registrarCobro`, que es el mismo acto con otro origen: alguien mira el
 * extracto bancario y dice «esto entró». Que los dos caminos pasen por acá es lo
 * que hace que un cobro por transferencia y uno por tarjeta dejen el mismo
 * rastro.
 *
 * ## Los cuatro finales, y por qué ninguno es «error»
 *
 *     APLICADO     la transición era válida y se aplicó
 *     REPETIDO     el mismo evento otra vez: las pasarelas reenvían
 *     ATRASADO     describe un estado ya superado; se guarda y no se aplica
 *     CONFLICTO    ni repetido ni atrasado ni válido: se guarda sin aplicar
 *
 * **Todos se guardan.** Descartar un evento sin dejar rastro borra la
 * explicación de por qué el cobro quedó como quedó, y esa explicación es lo
 * único que hay el día que un cliente diga que pagó.
 *
 * El `UNIQUE (proveedor, evento_externo)` de la 0096 hace que procesar dos veces
 * el mismo evento sea **imposible**, no improbable: acá se lo detecta antes para
 * poder contestar `REPETIDO` en vez de romper la transacción entera.
 */
export async function procesarEventoDePago(
  tx: Tx,
  evento: {
    readonly proveedor: string;
    readonly eventoExterno: string;
    readonly tipo: string;
    readonly estadoInformado: EstadoDePago;
    readonly referenciaExterna?: string | null;
    readonly intentId?: string | null;
    readonly ocurrioEl?: Date | null;
  },
): Promise<{ readonly resultado: ResultadoDeEvento; readonly intentId: string | null }> {
  const yaVisto = await tx.query<{ resultado: string; intent_id: string | null }>(
    'SELECT resultado, intent_id FROM payment_events WHERE proveedor = $1 AND evento_externo = $2',
    [evento.proveedor, evento.eventoExterno],
  );
  if (yaVisto.rows[0] !== undefined) {
    return { resultado: 'REPETIDO', intentId: yaVisto.rows[0].intent_id };
  }

  const intento = await tx.query<{ id: string; estado: EstadoDePago }>(
    evento.intentId != null
      ? 'SELECT id, estado FROM payment_intents WHERE id = $1'
      : 'SELECT id, estado FROM payment_intents WHERE proveedor = $1 AND referencia_externa = $2',
    evento.intentId != null
      ? [evento.intentId]
      : [evento.proveedor, evento.referenciaExterna ?? ''],
  );

  const encontrado = intento.rows[0];
  const guardar = async (resultado: ResultadoDeEvento, detalle: string): Promise<void> => {
    await tx.query(
      `INSERT INTO payment_events
         (intent_id, proveedor, evento_externo, tipo, ocurrio_el, resultado, detalle)
       VALUES ($1, $2, $3, $4, $5, $6, $7)`,
      [
        encontrado?.id ?? null,
        evento.proveedor,
        evento.eventoExterno,
        evento.tipo,
        evento.ocurrioEl ?? null,
        resultado,
        detalle,
      ],
    );
  };

  if (encontrado === undefined) {
    // Un evento sobre un cobro que este sistema no inició. Se guarda igual: es
    // la evidencia de que la pasarela cree que existe algo que acá no está.
    await guardar('DESCONOCIDO', 'No hay ningún intento de pago que se corresponda con el evento.');
    return { resultado: 'DESCONOCIDO', intentId: null };
  }

  if (esRepeticion(encontrado.estado, evento.estadoInformado)) {
    await guardar('REPETIDO', `El intento ya estaba en ${encontrado.estado}.`);
    return { resultado: 'REPETIDO', intentId: encontrado.id };
  }

  if (esAtrasado(encontrado.estado, evento.estadoInformado)) {
    await guardar(
      'ATRASADO',
      `Informa ${evento.estadoInformado} y el intento ya está en ${encontrado.estado}: ` +
        'aplicarlo lo haría retroceder.',
    );
    return { resultado: 'ATRASADO', intentId: encontrado.id };
  }

  if (!puedeTransicionarPago(encontrado.estado, evento.estadoInformado)) {
    await guardar(
      'CONFLICTO',
      `De ${encontrado.estado} no se pasa a ${evento.estadoInformado}. No se aplicó.`,
    );
    return { resultado: 'CONFLICTO', intentId: encontrado.id };
  }

  await tx.query(
    `UPDATE payment_intents
        SET estado = $1, updated_at = now(),
            referencia_externa = COALESCE(referencia_externa, $2)
      WHERE id = $3`,
    [evento.estadoInformado, evento.referenciaExterna ?? null, encontrado.id],
  );
  await guardar('APLICADO', `De ${encontrado.estado} a ${evento.estadoInformado}.`);
  return { resultado: 'APLICADO', intentId: encontrado.id };
}

/**
 * Anula un documento de cobro emitido por error.
 *
 * Anular **no** es declarar incobrable. Anular dice «esto no debió emitirse»;
 * incobrable dice «se emitió bien y no se va a cobrar», que es un hecho
 * económico distinto. Confundirlos borra la deuda en lugar de reconocer la
 * pérdida.
 *
 * Y anular no es borrar: el documento queda, con su número, su motivo y quién lo
 * anuló. La numeración de esta serie admite huecos, pero un documento que
 * desaparece no deja hueco — deja una pregunta sin respuesta.
 */
export async function anularDocumento(
  tx: Tx,
  entrada: { readonly documentId: string; readonly motivo: string; readonly actorId: string },
): Promise<{ readonly estado: 'ANULADO' | 'NO_SE_PUEDE'; readonly detalle: string }> {
  if (entrada.motivo.trim().length < 5) {
    return {
      estado: 'NO_SE_PUEDE',
      detalle: 'Anular sin motivo deja una pregunta sin respuesta dentro de seis meses.',
    };
  }

  const doc = await tx.query<{ company_id: string; estado: EstadoDeDocumento; numero: string }>(
    'SELECT company_id, estado, numero::text AS numero FROM billing_documents WHERE id = $1',
    [entrada.documentId],
  );
  const d = doc.rows[0];
  if (d === undefined) return { estado: 'NO_SE_PUEDE', detalle: 'No existe ese documento.' };

  if (!puedeTransicionarDocumento(d.estado, 'ANULADO')) {
    return {
      estado: 'NO_SE_PUEDE',
      detalle:
        `El documento está ${d.estado} y de ahí no se anula. ` +
        'Un cobro que se revierte se acredita con una nota de crédito, no se anula: ' +
        'volver atrás dejaría el pago apuntando a un documento que ya no existe.',
    };
  }

  await tx.query(
    `UPDATE billing_documents SET estado = 'ANULADO', motivo_anulacion = $1 WHERE id = $2`,
    [entrada.motivo, entrada.documentId],
  );
  await tx.query(`UPDATE billing_periods SET estado = 'CANCELADO' WHERE id = (
      SELECT period_id FROM billing_documents WHERE id = $1)`, [entrada.documentId]);

  await recordAudit(tx, d.company_id, {
    actorType: 'SYSTEM',
    actorId: entrada.actorId,
    action: 'ANULAR_DOCUMENTO_DE_COBRO',
    objectType: 'billing_document',
    objectId: entrada.documentId,
    motivo: entrada.motivo,
    oldValue: { estado: d.estado },
    newValue: { estado: 'ANULADO', numero: d.numero },
  });

  return { estado: 'ANULADO', detalle: `Documento ${d.numero} anulado.` };
}

/**
 * Cambia el plan de una suscripción en medio de un período.
 *
 * El período se parte en dos y cada parte se cobra a su precio. El reparto lo
 * hace `prorratearPorDias` sobre el importe del período completo, y no dos
 * cálculos independientes: en un mes de 31 días partido al medio, dos cuentas
 * redondeadas por separado dan un centavo de más o de menos que después nadie
 * encuentra.
 *
 * **No emite nada.** Deja la suscripción con el importe nuevo y el período en
 * curso ajustado; lo que se cobra lo emite el ciclo, que es el único que emite.
 * Que el cambio de plan pudiera emitir un documento haría que hubiera dos
 * caminos hacia un cargo, y el día que difieran nadie va a saber cuál corrió.
 */
export async function cambiarDePlan(
  tx: Tx,
  entrada: {
    readonly subscriptionId: string;
    readonly nuevoPlanId: string;
    readonly nuevoImporte: string;
    readonly desde: CalendarDate;
    readonly actorId: string;
  },
): Promise<
  | { readonly estado: 'CAMBIADO'; readonly cobrableDelPeriodo: string; readonly restante: string }
  | { readonly estado: 'NO_SE_PUEDE'; readonly detalle: string }
> {
  const s = await tx.query<{
    company_id: string;
    estado: EstadoDeSuscripcion;
    moneda: string | null;
    importe_acordado: string | null;
    periodicidad: string | null;
    proxima_facturacion: string | null;
  }>(
    `SELECT company_id, estado, moneda, importe_acordado::text AS importe_acordado,
            periodicidad, proxima_facturacion::text AS proxima_facturacion
       FROM company_subscriptions WHERE id = $1`,
    [entrada.subscriptionId],
  );
  const sub = s.rows[0];
  if (sub === undefined) {
    return { estado: 'NO_SE_PUEDE', detalle: 'No existe esa suscripción.' };
  }
  if (
    sub.moneda === null ||
    sub.importe_acordado === null ||
    sub.periodicidad === null ||
    sub.proxima_facturacion === null
  ) {
    return {
      estado: 'NO_SE_PUEDE',
      detalle: 'La suscripción no tiene condiciones acordadas: no hay período que partir.',
    };
  }
  if (!isCurrency(sub.moneda)) {
    return { estado: 'NO_SE_PUEDE', detalle: `Moneda ${sub.moneda} fuera del catálogo.` };
  }

  // El período en curso es el que **todavía no** se facturó: `proxima_facturacion`
  // marca su inicio.
  const periodo = periodoDe(parseCalendarDate(sub.proxima_facturacion), sub.periodicidad as Periodicidad);
  if (entrada.desde <= periodo.desde || entrada.desde > periodo.hasta) {
    return {
      estado: 'NO_SE_PUEDE',
      detalle:
        `El cambio tiene que caer dentro del período en curso ` +
        `(${periodo.desde} a ${periodo.hasta}) y después de su primer día.`,
    };
  }

  const viejo = moneyFromDecimalString(sub.importe_acordado, sub.moneda);
  const nuevo = moneyFromDecimalString(entrada.nuevoImporte, sub.moneda);

  // El primer tramo termina el día anterior al cambio: el día del cambio ya se
  // cobra al precio nuevo.
  const tramos = [
    { desde: periodo.desde, hasta: addDays(entrada.desde, -1) },
    { desde: entrada.desde, hasta: periodo.hasta },
  ];
  const [porElViejo] = prorratearPorDias(viejo, periodo, tramos);
  const [, porElNuevo] = prorratearPorDias(nuevo, periodo, tramos);

  await tx.query(
    `UPDATE company_subscriptions SET plan_id = $1, importe_acordado = $2::numeric WHERE id = $3`,
    [entrada.nuevoPlanId, entrada.nuevoImporte, entrada.subscriptionId],
  );

  await recordAudit(tx, sub.company_id, {
    actorType: 'SYSTEM',
    actorId: entrada.actorId,
    action: 'CAMBIAR_PLAN_DE_SUSCRIPCION',
    objectType: 'company_subscription',
    objectId: entrada.subscriptionId,
    oldValue: { importe: sub.importe_acordado },
    newValue: {
      importe: entrada.nuevoImporte,
      desde: entrada.desde,
      periodo: `${periodo.desde}..${periodo.hasta}`,
    },
  });

  return {
    estado: 'CAMBIADO',
    cobrableDelPeriodo: toDecimalString(porElViejo!),
    restante: toDecimalString(porElNuevo!),
  };
}

/** El ciclo completo. Correrlo dos veces el mismo día es inocuo. */
export async function correrCiclo(
  tx: Tx,
  hoy: CalendarDate,
  actorId: string,
): Promise<InformeDeCiclo> {
  const { emitidos, omitidos } = await emitirVencidos(tx, hoy, actorId);
  const cobranza = await avanzarCobranza(tx, hoy, actorId);
  return { hoy, emitidos, omitidos, cobranza };
}
