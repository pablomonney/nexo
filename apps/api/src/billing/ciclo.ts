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
 *     cobrar solo      NO — y con pasarela conectada **tampoco**
 *
 * La última fila cambió de motivo en B2.5.5 y conviene no confundir los dos.
 *
 * Antes era «no hay pasarela contratada». Ahora hay adaptador, y sigue siendo
 * que no: en un esquema de suscripción (`preapproval`) **el débito lo ejecuta la
 * pasarela**, no NEXO. NEXO autoriza el medio de pago una vez y a partir de ahí
 * se entera por webhook. No existe ninguna operación «cobrale ahora a esta
 * suscripción», así que `intentarCobro` no cobra: consulta, y dice cuál de los
 * cuatro desenlaces es. Ver su propio encabezado.
 *
 * ## Cero no es «no se puede afirmar»
 *
 * Sin precio vigente, una suscripción **no se factura** y el informe lo dice.
 * No se emite un cargo de cero: un cargo de cero se ve igual que un cliente que
 * no debe nada, y el mes que viene nadie va a ir a buscar por qué.
 */

import { recordAudit, type Tx } from '@aai/db';
import { filtroDeOrganizacion, type OpcionesDelCiclo } from './alcance.js';
import { encolarAvisoDeCobranza, modulosEnPausaPorMora } from './avisos.js';
import { vencerPruebas, type InformeDePruebas } from './prueba.js';
import { config } from '../config.js';
import { crearProveedorDePagos } from '../pagos/fabrica.js';
import type { ProveedorDePagos } from '../pagos/puerto.js';
import {
  consecuenciaDeSuscripcion,
  esAtrasado,
  esProblemaDeConfiguracion,
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
  readonly pruebas: InformeDePruebas;
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
  /**
   * Acá **no está `SIN_PRECIO_VIGENTE`**, y la ausencia vale la pena explicarla
   * porque el valor estuvo en esta lista durante meses sin que nada lo emitiera.
   *
   * El ciclo no mira `plan_prices`: factura contra `importe_acordado`, que se
   * congeló al convertir la prueba y puede diferir de la lista —un contrato es
   * exactamente eso—. Y el `CHECK` de la 0096 garantiza que si hay importe hay
   * también periodicidad, moneda y próxima facturación, así que el caso «se iba
   * a facturar y no había precio» no puede ocurrir en este punto.
   *
   * Un valor que nadie produce es peor que uno que falta: quien leyera el tipo
   * concluiría que existe un control de precio vigente en el camino de emisión.
   * Ese control existe, pero **un paso antes** —en `POST /subscription/convertir`,
   * que es donde se decide el importe— y devuelve ese mismo nombre como código
   * de conflicto.
   */
  readonly motivo:
    | 'SIN_CONDICIONES_ACORDADAS'
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
  opciones: OpcionesDelCiclo = {},
): Promise<{ emitidos: DocumentoEmitido[]; omitidos: Omision[] }> {
  const alcance = filtroDeOrganizacion(opciones, 2);
  const { rows } = await tx.query<FilaDeSuscripcion>(
    `SELECT id, company_id, plan_id, estado, periodicidad, moneda,
            importe_acordado::text AS importe_acordado,
            proxima_facturacion::text AS proxima_facturacion,
            vigencia_desde::text AS vigencia_desde
       FROM company_subscriptions
      WHERE estado IN ('ACTIVA', 'MOROSA', 'SUSPENDIDA')
        AND proxima_facturacion IS NOT NULL
        AND proxima_facturacion <= $1::date
        ${alcance.sql}
      ORDER BY proxima_facturacion, id`,
    [hoy, alcance.valor],
  );

  const emitidos: DocumentoEmitido[] = [];
  const omitidos: Omision[] = [];

  for (const s of rows) {
    // Morosa y suspendida se siguen facturando: la deuda corre igual. Lo que se
    // corta o se degrada es el acceso, no el contrato — y si se dejara de
    // facturar, levantar el corte dejaría un hueco de servicio que ningún
    // documento explica.
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

  // Pagar levanta la suspensión **y la mora**, y solo si no queda otra deuda
  // emitida. Levantar con deuda abierta dejaría entrar a quien pagó una de tres
  // facturas.
  //
  // La condición es la misma para los dos estados y eso es lo correcto: son dos
  // grados del mismo hecho, y la vuelta de los dos es la misma —no deber nada—.
  // Tratar la mora con una regla más blanda —«pagó algo, devolvele los
  // módulos»— dejaría a alguien con el producto completo y dos facturas
  // abiertas, que es exactamente lo que la mora existe para no permitir.
  const deuda = await tx.query<{ n: string }>(
    `SELECT count(*)::text AS n FROM billing_documents
      WHERE subscription_id = $1 AND estado = 'EMITIDO'`,
    [d.subscription_id],
  );
  const sinDeuda = deuda.rows[0]!.n === '0';

  const sub = await tx.query<{ estado: EstadoDeSuscripcion }>(
    'SELECT estado FROM company_subscriptions WHERE id = $1',
    [d.subscription_id],
  );
  const estadoPrevio = sub.rows[0]?.estado;
  const reactivar =
    sinDeuda && (estadoPrevio === 'SUSPENDIDA' || estadoPrevio === 'MOROSA');

  if (reactivar) {
    // Las tres columnas se limpian juntas. `cs_morosa_con_fecha` y
    // `cs_baja_con_motivo` no lo exigen —solo aprietan sobre los estados que
    // las necesitan— pero dejar `morosa_desde` con fecha sobre una suscripción
    // activa haría que la próxima lectura contara días de mora de una deuda que
    // ya se pagó.
    await tx.query(
      `UPDATE company_subscriptions
          SET estado = 'ACTIVA', suspendida_el = NULL, morosa_desde = NULL, motivo = NULL
        WHERE id = $1`,
      [d.subscription_id],
    );
    await recordAudit(tx, d.company_id, {
      actorType: 'SYSTEM',
      actorId: entrada.actorId,
      action: 'REACTIVAR_POR_PAGO',
      objectType: 'company_subscription',
      objectId: d.subscription_id,
      // Desde dónde volvió, y no solo que volvió: «reactivada» sobre una morosa
      // y sobre una suspendida son dos recuperaciones distintas —una perdió
      // módulos, la otra perdió el acceso entero— y la bitácora es de donde
      // sale `saas_movimientos`.
      oldValue: { estado: estadoPrevio },
      newValue: { documento: d.id, estado: 'ACTIVA' },
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
    aviso_en_dias: number[];
    dias_de_gracia: number;
    dias_de_mora: number | null;
  }>(
    `SELECT reintentos_en_dias, aviso_en_dias, dias_de_gracia, dias_de_mora
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
    // `null` es «esta política no declara un paso de mora», y entonces el
    // calendario va de ACTIVA a SUSPENDIDA directo. No se traduce a cero: cero
    // sería «la mora empieza el día del fallo», que es otra decisión.
    diasDeMora: p.dias_de_mora,
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
/**
 * Lo que el paso de reintento necesita saber del mundo exterior.
 *
 * Se inyecta para poder ejercitar los cuatro desenlaces —incluidos los que en
 * producción aparecen una vez cada mil cobros— sin cuenta de pasarela y sin red.
 * En producción no se pasa nada y sale de `config`.
 */
export interface OpcionesDeCobranza extends OpcionesDelCiclo {
  readonly proveedor?: ProveedorDePagos;
  readonly ambienteConfigurado?: string;
}

/** Un documento impago con su empresa, tal como lo ve la cobranza. */
interface FilaEnCobranza {
  readonly document_id: string;
  readonly company_id: string;
  readonly subscription_id: string;
  readonly empresa: string;
  readonly fallo_el: string;
}

export async function avanzarCobranza(
  tx: Tx,
  hoy: CalendarDate,
  actorId: string,
  opciones: OpcionesDeCobranza = {},
): Promise<PasoEjecutado[]> {
  const politica = await politicaVigente(tx, hoy);

  const { rows } = await tx.query<FilaEnCobranza>(
    `SELECT d.id AS document_id, d.company_id, d.subscription_id, c.legal_name AS empresa,
            min(i.created_at)::date::text AS fallo_el
       FROM billing_documents d
       JOIN payment_intents i ON i.document_id = d.id AND i.estado = 'FALLIDO'
       JOIN companies c ON c.id = d.company_id
      WHERE d.estado = 'EMITIDO'
        AND ($1::uuid IS NULL OR c.organization_id = $1::uuid)
      GROUP BY d.id, d.company_id, d.subscription_id, c.legal_name
      ORDER BY 5, 1`,
    [opciones.soloOrganizacion ?? null],
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

    const ejecutado = await ejecutarPaso(tx, fila, paso, politica, actorId, opciones);
    hechos.push(ejecutado);
  }

  return hechos;
}

/**
 * Ejecuta un paso del calendario y lo deja registrado.
 *
 * ## El registro se escribe siempre, salga como salga
 *
 * Incluso cuando el paso se omite. Sin la fila, `pasoPendiente` lo encontraría
 * pendiente de nuevo mañana, y pasado, y el ciclo intentaría todos los días lo
 * mismo que no se puede hacer. Un paso omitido con su motivo es información; un
 * paso que no se registró es un bucle silencioso.
 */
async function ejecutarPaso(
  tx: Tx,
  fila: FilaEnCobranza,
  paso: PasoDeCobranza,
  politica: PoliticaDeCobranza,
  actorId: string,
  opciones: OpcionesDeCobranza,
): Promise<PasoEjecutado> {
  let resultado: 'HECHO' | 'FALLIDO' | 'OMITIDO' = 'HECHO';
  let detalle = '';

  /** Deja el paso escrito y arma la respuesta. Un solo lugar, para los cinco cierres. */
  const registrar = async (
    estado: 'HECHO' | 'FALLIDO' | 'OMITIDO',
    porque: string,
  ): Promise<PasoEjecutado> => {
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
        estado,
        porque,
      ],
    );
    return {
      documentId: fila.document_id,
      companyId: fila.company_id,
      paso,
      resultado: estado,
      detalle: porque,
    };
  };

  if (paso.tipo === 'REINTENTO') {
    const intento = await intentarCobro(tx, { subscriptionId: fila.subscription_id }, opciones);

    // Los cuatro resultados no se colapsan en dos. `OMITIDO` significa «no había
    // nada que hacer»; `FALLIDO` significa «se intentó y no salió». Meter
    // `MEDIO_NO_AUTORIZADO` en `OMITIDO` escondería el único caso que necesita
    // que alguien le escriba al cliente.
    resultado =
      intento.estado === 'SIN_PASARELA'
        ? 'OMITIDO'
        : intento.estado === 'A_CARGO_DEL_PROVEEDOR'
          ? 'HECHO'
          : 'FALLIDO';
    detalle = intento.detalle;
  } else if (paso.tipo === 'AVISO') {
    /**
     * El aviso **se encola, no se manda**.
     *
     * Hasta acá este paso no hacía nada: se registraba `OMITIDO` con un texto
     * que explicaba que el correo no estaba cableado. Ahora lo está, y lo está
     * de la única forma que se puede desde adentro de esta transacción — que
     * además tiene abierto un `UPDATE` sobre `company_subscriptions`—: la fila
     * va a `email_outbox` en `PENDIENTE` y la entrega la hace `correo:bandeja`
     * después, con su propio reloj.
     *
     * Mandarlo acá tendría un problema que no se puede arreglar: si la
     * transacción se revierte después de que el proveedor aceptó el mensaje, el
     * cliente ya recibió un correo sobre algo que no pasó. El motivo completo
     * está en `encolarSinEnviar`.
     *
     * El primer aviso y los siguientes dicen cosas distintas. El primero es «se
     * rechazó el cobro» y no anuncia ninguna consecuencia, porque todavía no hay
     * ninguna; los demás son «faltan N días», con el número, porque «pronto» no
     * le sirve a nadie para decidir cuándo pagar.
     */
    const numero = paso.numero ?? 1;
    const diasDelAviso = politica.avisoEnDias[numero - 1];
    const aviso = await encolarAvisoDeCobranza(
      tx,
      fila.company_id,
      numero === 1 ? 'RECHAZO_INICIAL' : 'SUSPENSION_PROXIMA',
      {
        empresa: fila.empresa,
        // `null` cuando no se puede afirmar. No cero: un correo que diga «te
        // quedan 0 días» a quien no está por ser suspendido es peor que uno que
        // no diga el número.
        diasParaLaSuspension:
          diasDelAviso === undefined ? null : politica.diasDeGracia - diasDelAviso,
      },
    );

    if (aviso.estado === 'SIN_DESTINATARIOS') {
      // Esto **no** es un problema del correo, y decirlo como uno mandaría a
      // revisar el proveedor. Es una empresa sin ningún administrador vigente y
      // activo, y lo que hay que arreglar está en otra pantalla.
      return registrar(
        'OMITIDO',
        'La empresa no tiene ningún administrador vigente y activo: no hay a quién ' +
          'avisarle. El aviso no salió y la cobranza sigue su curso igual.',
      );
    }

    resultado = 'HECHO';
    detalle =
      `Aviso ${numero} encolado para ${aviso.destinatarios} destinatario(s). ` +
      'Sale cuando se drene la bandeja de correo: `npm run correo:bandeja`.';

    await recordAudit(tx, fila.company_id, {
      actorType: 'SYSTEM',
      actorId,
      action: 'AVISAR_DE_COBRANZA',
      objectType: 'billing_document',
      objectId: fila.document_id,
      newValue: { aviso: numero, destinatarios: aviso.destinatarios, el: paso.el },
    });
  } else if (paso.tipo === 'MORA') {
    /**
     * El escalón que faltaba: la suscripción se degrada y el servicio sigue.
     *
     * Las dos comprobaciones de abajo no son ceremonia. La transición se
     * pregunta antes de intentarla —el `WHERE estado = 'ACTIVA'` la impediría
     * igual, pero en silencio: la suscripción quedaría sin degradar y el paso
     * registrado como hecho—. Y la deuda se vuelve a mirar porque entre que se
     * armó la lista y se llegó acá pudo entrar un pago: degradarle el acceso a
     * alguien que acaba de pagar es el error más caro que este paso puede
     * cometer, y el que más tarda en descubrirse.
     */
    const actual = await tx.query<{ estado: EstadoDeSuscripcion }>(
      'SELECT estado FROM company_subscriptions WHERE id = $1',
      [fila.subscription_id],
    );
    const desde = actual.rows[0]?.estado;
    if (desde === undefined || !puedeTransicionar(desde, 'MOROSA')) {
      return registrar(
        'OMITIDO',
        `La suscripción está ${desde ?? 'ausente'}: de ahí no se pasa a MOROSA.`,
      );
    }

    const deuda = await tx.query<{ n: string }>(
      `SELECT count(*)::text AS n FROM billing_documents
        WHERE subscription_id = $1 AND estado = 'EMITIDO' AND vence_el <= $2::date`,
      [fila.subscription_id, paso.el],
    );
    if (deuda.rows[0]!.n === '0') {
      return registrar(
        'OMITIDO',
        'Ya no hay deuda vencida en esta suscripción: no corresponde degradar el acceso.',
      );
    }

    const motivo = 'Falta de pago: acceso degradado';
    // El `WHERE` repite el estado que se acaba de leer, por lo mismo que abajo
    // en la suspensión: la guarda contra una escritura concurrente tiene que
    // decir lo mismo que `puedeTransicionar`, no una lista paralela.
    await tx.query(
      `UPDATE company_subscriptions
          SET estado = 'MOROSA', morosa_desde = $1::date, motivo = $2
        WHERE id = $3 AND estado = $4`,
      [paso.el, motivo, fila.subscription_id, desde],
    );
    await recordAudit(tx, fila.company_id, {
      actorType: 'SYSTEM',
      actorId,
      action: 'MARCAR_EN_MORA',
      objectType: 'company_subscription',
      objectId: fila.subscription_id,
      motivo: `Documento ${fila.document_id} impago según la política de cobranza vigente`,
      oldValue: { estado: desde },
      newValue: { estado: 'MOROSA', morosaDesde: paso.el },
    });

    // El aviso va **después** del `UPDATE`, en la misma transacción: describe un
    // hecho que ya está escrito. Que no haya a quién avisarle no revierte la
    // degradación —el acceso se degrada por la deuda, no por el correo— y por
    // eso este caso no devuelve `OMITIDO` como el del paso de AVISO.
    const aviso = await encolarAvisoDeCobranza(tx, fila.company_id, 'ACCESO_DEGRADADO', {
      empresa: fila.empresa,
      diasParaLaSuspension: politica.diasDeGracia - (politica.diasDeMora ?? 0),
      modulosEnPausa: await modulosEnPausaPorMora(tx),
    });

    detalle =
      'En mora: se apagaron los módulos que no sobreviven a la mora. El servicio sigue ' +
      'prestándose, los datos y la contabilidad quedan intactos, y todo vuelve al pagar. ' +
      (aviso.estado === 'ENCOLADO'
        ? `Aviso encolado para ${aviso.destinatarios} destinatario(s).`
        : 'Sin administradores vigentes: no se pudo avisar.');
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
      return registrar(
        'OMITIDO',
        `La suscripción está ${desde ?? 'ausente'}: de ahí no se pasa a SUSPENDIDA.`,
      );
    }

    /**
     * Esta suspensión **no pausa la suscripción de la pasarela**, y es una
     * decisión, no un olvido.
     *
     * `POST /subscription/:id/estado` sí la pausa: ahí una persona decidió
     * cortar el servicio. Acá la decisión la tomó la política de cobranza
     * porque el cobro falló, y pausar del otro lado apagaría los reintentos de
     * la propia pasarela — que son justamente lo que puede cobrar la deuda. Se
     * suspendería el acceso *y* se cerraría la única vía de recuperarlo.
     *
     * Lo que corresponde es lo contrario: NEXO corta el acceso, la pasarela
     * sigue intentando, y cuando el cobro entra el webhook reactiva. El
     * invariante que protege `sincronizarEstadoConLaPasarela` —que nadie quede
     * suspendido mientras le cobran **sin que corresponda**— no se viola: acá
     * corresponde, porque la deuda existe y el ciclo la sigue emitiendo.
     */
    // El `WHERE` repite **el estado que se acaba de leer**, no una lista escrita
    // a mano. Es una guarda contra una escritura concurrente, y tiene que decir
    // exactamente lo mismo que `puedeTransicionar` para no ser otra regla.
    //
    // Con una lista aparte se separan: la versión anterior comprobaba la
    // transición —que admite `PRUEBA → SUSPENDIDA`— y después actualizaba solo
    // `estado = 'ACTIVA'`. Una suscripción en prueba habría pasado el control,
    // no habría cambiado nada, y el paso habría quedado registrado como HECHO:
    // el silencio que el propio comentario de arriba dice querer evitar.
    await tx.query(
      `UPDATE company_subscriptions
          SET estado = 'SUSPENDIDA', suspendida_el = $1::date, motivo = $2
        WHERE id = $3 AND estado = $4`,
      [paso.el, 'Falta de pago', fila.subscription_id, desde],
    );
    await recordAudit(tx, fila.company_id, {
      actorType: 'SYSTEM',
      actorId,
      action: 'SUSPENDER_POR_FALTA_DE_PAGO',
      objectType: 'company_subscription',
      objectId: fila.subscription_id,
      motivo: `Documento ${fila.document_id} impago según la política de cobranza vigente`,
      // Desde dónde se suspendió. Una suspensión que vino de MOROSA recorrió el
      // calendario entero; una que vino de ACTIVA es una política sin escalón
      // intermedio, y las dos se ven igual si solo se guarda el estado nuevo.
      oldValue: { estado: desde },
      newValue: { documento: fila.document_id, suspendidaEl: paso.el, estado: 'SUSPENDIDA' },
    });

    const aviso = await encolarAvisoDeCobranza(tx, fila.company_id, 'SUSPENSION_APLICADA', {
      empresa: fila.empresa,
      // Ya se suspendió: no faltan días para nada. `null` es «no corresponde
      // decir un número acá», y el texto de este aviso no lo usa.
      diasParaLaSuspension: null,
    });

    detalle =
      'Suspendida por falta de pago. Los datos y la contabilidad quedan intactos. ' +
      (aviso.estado === 'ENCOLADO'
        ? `Aviso encolado para ${aviso.destinatarios} destinatario(s).`
        : 'Sin administradores vigentes: no se pudo avisar.');
  }

  return registrar(resultado, detalle);
}
/**
 * El paso de reintento de la política de cobranza, contra la pasarela.
 *
 * ## Por qué esta función no cobra, aunque se llame así
 *
 * Se llamaba `intentarCobro` cuando no existía ninguna pasarela y devolvía
 * `SIN_PASARELA` sin más. Ahora que hay adaptador conviene decir con precisión
 * qué se puede hacer, porque **no es cobrar**:
 *
 * En un esquema de suscripción (`preapproval`), el cobro periódico lo ejecuta el
 * proveedor. NEXO autoriza el medio de pago una vez, y a partir de ahí Mercado
 * Pago debita en cada período y avisa por webhook. **No hay ninguna operación
 * «cobrale ahora a esta suscripción»**, y no la hay en la API: inventarla acá
 * significaría escribir una llamada que no existe, o —peor— crear un cobro
 * suelto por fuera de la suscripción, que le cobraría al cliente un cargo
 * adicional en vez de reintentar el que falló.
 *
 * Lo que sí se puede hacer, y es lo que hace, es **preguntar**. De ahí salen
 * cuatro respuestas, y las cuatro son distintas para quien lee la bandeja:
 *
 *     SIN_PASARELA           no hay proveedor. El ciclo cobra por transferencia.
 *     A_CARGO_DEL_PROVEEDOR  la suscripción sigue autorizada: el reintento lo
 *                            hace el proveedor con su propio calendario. No hay
 *                            nada que NEXO pueda apurar.
 *     MEDIO_NO_AUTORIZADO    pausada o cancelada del otro lado. **Ningún
 *                            reintento va a entrar**: hace falta que el cliente
 *                            vuelva a autorizar un medio de pago.
 *     NO_SE_PUDO_CONSULTAR   el proveedor no contestó, o contestó algo ilegible.
 *                            No se sabe. No es lo mismo que «no se puede cobrar».
 *
 * La diferencia entre las dos últimas es la que más importa. `MEDIO_NO_AUTORIZADO`
 * dice «dejá de esperar, escribile al cliente»; `NO_SE_PUDO_CONSULTAR` dice
 * «volvé a preguntar mañana». Colapsarlas haría que una caída de veinte minutos
 * del proveedor se leyera como una cartera entera de tarjetas vencidas.
 *
 * ## El ambiente se comprueba antes de preguntar
 *
 * Una suscripción creada contra la cuenta de prueba no existe en la de
 * producción. Preguntar por ella con las credenciales de la otra cuenta devuelve
 * 404, y un 404 acá se leería como «esta suscripción no existe» — o sea, como
 * que el cliente nunca autorizó nada. Por eso `ambiente_pago` se compara contra
 * el ambiente configurado y, si no coinciden, se dice eso y no se llama.
 */
export type ResultadoDeReintento =
  | 'SIN_PASARELA'
  | 'A_CARGO_DEL_PROVEEDOR'
  | 'MEDIO_NO_AUTORIZADO'
  | 'NO_SE_PUDO_CONSULTAR';

export async function intentarCobro(
  tx: Tx,
  entrada: { readonly subscriptionId: string },
  opciones: {
    readonly proveedor?: ProveedorDePagos;
    readonly ambienteConfigurado?: string;
  } = {},
): Promise<{ readonly estado: ResultadoDeReintento; readonly detalle: string }> {
  const proveedor = opciones.proveedor ?? crearProveedorDePagos();
  const ambienteConfigurado = opciones.ambienteConfigurado ?? config.pagos.ambiente;

  const fila = await tx.query<{
    referencia_externa: string | null;
    proveedor_pago: string | null;
    ambiente_pago: string | null;
  }>(
    `SELECT referencia_externa, proveedor_pago, ambiente_pago
       FROM company_subscriptions WHERE id = $1`,
    [entrada.subscriptionId],
  );
  const s = fila.rows[0];

  if (s === undefined || s.referencia_externa === null) {
    // Sin referencia externa no hay nada que preguntar, y eso es lo normal en
    // una instalación sin pasarela: la suscripción existe, el ciclo emite, y el
    // cobro entra por transferencia. No es un fallo.
    return {
      estado: 'SIN_PASARELA',
      detalle:
        'La suscripción no está conectada a ninguna pasarela: el reintento automático no ' +
        'existe. Un cobro por transferencia se registra igual, a mano.',
    };
  }

  if (s.proveedor_pago !== proveedor.id) {
    return {
      estado: 'SIN_PASARELA',
      detalle:
        `La suscripción quedó conectada a "${s.proveedor_pago}" y la pasarela configurada ` +
        `es "${proveedor.id}". No se consultó: la referencia no vale en otra pasarela.`,
    };
  }

  if (s.ambiente_pago !== ambienteConfigurado) {
    // No se consulta. Ver el encabezado: un 404 de la cuenta equivocada se
    // leería como «el cliente nunca autorizó nada», que es lo contrario de lo
    // que pasa.
    return {
      estado: 'NO_SE_PUDO_CONSULTAR',
      detalle:
        `La suscripción se creó en el ambiente "${s.ambiente_pago}" y la instalación corre ` +
        `en "${ambienteConfigurado}". No se consultó al proveedor: la referencia pertenece a ` +
        'otra cuenta y preguntar por ella daría un 404 que se leería como una suscripción ' +
        'inexistente.',
    };
  }

  const salida = await proveedor.consultarSuscripcion(s.referencia_externa);

  if (!salida.ok) {
    if (salida.fallo.codigo === 'SIN_PASARELA') {
      return {
        estado: 'SIN_PASARELA',
        detalle:
          'No hay pasarela conectada: el reintento no se pudo ejecutar. ' +
          'Un cobro por transferencia se registra igual, a mano.',
      };
    }
    return {
      estado: 'NO_SE_PUDO_CONSULTAR',
      // El código va adelante para que la bandeja se lea de un vistazo, y
      // detrás va **de quién es el problema**. Sin esa segunda parte, un token
      // caducado se lee igual que una caída del proveedor, y quien mire la
      // cobranza se queda esperando a que se arregle solo algo que no se
      // arregla solo.
      detalle:
        `No se pudo consultar la suscripción (${salida.fallo.codigo}): ${salida.fallo.detalle}` +
        (esProblemaDeConfiguracion(salida.fallo.codigo)
          ? ' — Esto lo arregla quien administra la instalación, no el cliente: ' +
            'no hay nada que reintentar hasta que se corrija.'
          : ''),
    };
  }

  const consecuencia = consecuenciaDeSuscripcion(salida.valor.estado);

  if (salida.valor.estado === 'AUTORIZADA') {
    return {
      estado: 'A_CARGO_DEL_PROVEEDOR',
      detalle:
        'La suscripción sigue autorizada en la pasarela: el reintento del débito lo hace el ' +
        'proveedor con su propio calendario, y el resultado va a llegar por webhook. ' +
        'No hay ninguna operación que NEXO pueda ejecutar para apurarlo.',
    };
  }

  if (salida.valor.estado === 'PENDIENTE') {
    return {
      estado: 'MEDIO_NO_AUTORIZADO',
      detalle:
        'La suscripción está creada y el cliente nunca terminó de autorizar el medio de pago. ' +
        'Ningún reintento va a entrar hasta que complete la autorización.',
    };
  }

  return {
    estado: 'MEDIO_NO_AUTORIZADO',
    detalle:
      `La pasarela informa la suscripción como ${salida.valor.estado}: ningún reintento va a ` +
      `entrar. ${consecuencia.tipo === 'TRANSICION' ? consecuencia.motivo : ''}`.trim(),
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
    /**
     * Por qué falló, si falló. Ver más abajo: sin esto, pasar un intento a
     * `FALLIDO` viola `payment_intents_fallo_con_detalle` y **rompe la
     * transacción entera**, no solo este evento.
     */
    readonly detalleDelFallo?: string | null;
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

  /**
   * El motivo del fallo, que la base exige y que nadie estaba pasando.
   *
   * `payment_intents_fallo_con_detalle` (0096) impide guardar un `FALLIDO` sin
   * `detalle_error`. Es una regla buena: el día que un cliente pregunte por qué
   * no le pasó la tarjeta, esta columna es lo único que hay. Pero hasta acá
   * ninguna ruta de este camino la llenaba, así que el primer rechazo que
   * llegara por webhook tiraba una violación de `CHECK` **dentro de la
   * transacción del drenaje**: no fallaba ese evento, fallaba la corrida entera
   * y todo lo que venía detrás quedaba sin procesar.
   *
   * Cuando el proveedor no dice por qué, se escribe eso mismo. Es feo y es
   * cierto; inventar un motivo concreto sería peor, porque después alguien se
   * lo repite al cliente.
   *
   * Solo se escribe al pasar a `FALLIDO`: `COALESCE` en cualquier otra
   * transición conservaría el detalle de un fallo anterior sobre un intento que
   * después salió bien, y eso se leería como que el cobro falló.
   */
  const detalleDelFallo =
    evento.estadoInformado !== 'FALLIDO'
      ? null
      : (evento.detalleDelFallo ?? null) === null || evento.detalleDelFallo?.trim() === ''
        ? 'El proveedor informó el rechazo y no dio un motivo.'
        : evento.detalleDelFallo!;

  await tx.query(
    `UPDATE payment_intents
        SET estado = $1, updated_at = now(),
            referencia_externa = COALESCE(referencia_externa, $2),
            detalle_error = CASE WHEN $1 = 'FALLIDO' THEN $4 ELSE detalle_error END
      WHERE id = $3`,
    [evento.estadoInformado, evento.referenciaExterna ?? null, encontrado.id, detalleDelFallo],
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
  opciones: OpcionesDeCobranza = {},
): Promise<InformeDeCiclo> {
  // Las pruebas se vencen **antes** de emitir. Una prueba que venció hoy no
  // debe recibir un cargo hoy: quien no contrató nada no debe nada, y emitirle
  // un documento para anularlo después ensucia su historial con un cargo que
  // nunca correspondió.
  // El alcance viaja a las tres fases. Pasárselo a dos de tres dejaría un ciclo
  // que vence las pruebas de una organización y emite las de todas, que es
  // peor que no acotarlo: parecería acotado.
  const pruebas = await vencerPruebas(tx, hoy, actorId, opciones);
  const { emitidos, omitidos } = await emitirVencidos(tx, hoy, actorId, opciones);
  const cobranza = await avanzarCobranza(tx, hoy, actorId, opciones);
  return { hoy, emitidos, omitidos, cobranza, pruebas };
}
