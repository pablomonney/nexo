/**
 * Qué puede usar una empresa según su plan.
 *
 * ## Esto NO es una capa de seguridad, y confundirlo sería grave
 *
 * El aislamiento entre empresas lo sostienen el RLS y los permisos, y no
 * dependen de esto en absoluto. Una puerta comercial responde otra pregunta:
 * «¿esta empresa contrató este módulo?».
 *
 * La consecuencia es que **falla abierta**, y es deliberado:
 *
 *   · un dominio que no está en el catálogo se deja pasar;
 *   · una empresa sin suscripción se deja pasar;
 *   · una suscripción sin plan cargado se deja pasar.
 *
 * El error caro de una puerta comercial es dejar afuera a alguien que paga. El
 * error caro de una puerta de seguridad es dejar entrar a alguien que no, y esa
 * puerta es otra. Cerrar esta de más produce un cliente furioso el primer día
 * del mes; cerrarla de menos produce un mes de un módulo regalado, que se
 * arregla facturándolo.
 *
 * ## Falla abierta por lo que no se sabe, NO por lo que dice que no
 *
 * Los tres casos de arriba son formas de **no tener información**: nadie
 * contrató, o el catálogo no dice nada. Una suscripción `SUSPENDIDA` no es eso:
 * es información, y dice que no. `NEXO_BILLING.md` §9 lo escribe con todas las
 * letras — «suspender corta el acceso y **conserva todo**» — y hasta la
 * auditoría B-2 el código hacía lo contrario.
 *
 * El defecto era una confusión de dos silencios. `funcionalidadesDe` filtraba
 * por `estado IN ('ACTIVA','PRUEBA')`, así que una suspendida devolvía **cero
 * filas**, y cero filas se leía como «esta empresa no tiene plan»: el caso que
 * se deja pasar. Al vencer la prueba de catorce días, la empresa pasaba de ver
 * los módulos de su plan a verlos **todos**. Dejar de pagar ampliaba el
 * producto.
 *
 * Por eso el estado se consulta **aparte** de las funcionalidades. Son dos
 * preguntas distintas —«¿qué contrató?» y «¿está al día?»— y colapsarlas en una
 * sola consulta fue exactamente lo que produjo el agujero.
 *
 * Lo que la suspensión NO toca: los dominios que ningún plan gobierna. Ahí
 * están `suscripciones`, `planes` y `companies`, que son por dónde se ve la
 * deuda y se vuelve a contratar. Una puerta que deja al cliente afuera de la
 * caja no cobra: enoja.
 *
 * ## La mora degrada, no corta
 *
 * Desde la 0124 hay un estado entre `ACTIVA` y `SUSPENDIDA`. `MOROSA` dice que
 * la empresa debe, que el servicio se sigue prestando, y que **parte** del
 * producto dejó de estar disponible.
 *
 * Cuál parte lo dice `product_features.sobrevive_la_mora` (0125), y el criterio
 * es uno solo: se conserva lo que sostiene una obligación con plazo y con multa
 * —facturar, asentar, cerrar un período, presentar ante ARCA— y se apaga lo que
 * sirve para mejorar el negocio. Cortarle a un cliente que debe dos semanas de
 * abono la posibilidad de emitir una factura no es cobrar: es causarle un
 * perjuicio que no guarda ninguna proporción con la deuda, y que encima no lo
 * ayuda a pagar.
 *
 * Nada se borra. Lo apagado vuelve entero al pagar.
 *
 * ## El mapa sale de la base, no de una lista acá
 *
 * `product_features.dominios` dice qué prefijo de ruta cubre cada
 * funcionalidad. Una lista escrita en TypeScript se desincroniza de la matriz
 * comercial en cuanto alguien agregue un plan, y el síntoma sería un cliente
 * viendo algo que no compró.
 *
 * ## Cachea, y por eso hay que saber cuánto
 *
 * El mapa cambia cuando cambia el catálogo —una migración— y las suscripciones
 * cambian cuando alguien contrata. Consultarlo en cada pedido agregaría dos
 * consultas al camino más caliente del sistema. Se cachea por proceso durante
 * un minuto: un upgrade tarda hasta un minuto en verse, y eso es aceptable
 * para una puerta comercial y no lo sería para una de seguridad.
 */

import type { Tx } from '@aai/db';

/** Cuánto vive el mapa en memoria, en milisegundos. */
const VIDA_DEL_CACHE = 60_000;

interface Cacheado<T> {
  readonly valor: T;
  readonly hasta: number;
}

/**
 * Las dos cosas que dice el catálogo, cacheadas juntas.
 *
 * Juntas y no en dos entradas: salen de la misma consulta y de la misma tabla,
 * y dos caches con vencimientos propios pueden quedar describiendo catálogos
 * distintos durante hasta un minuto. El síntoma sería un dominio que existe en
 * el mapa y no en el conjunto —o al revés—, que se lee como «esta
 * funcionalidad sobrevive a la mora» sin que nadie lo haya decidido.
 */
interface Catalogo {
  /** Dominio de ruta → funcionalidad que lo cubre. */
  readonly dominios: ReadonlyMap<string, string>;
  /** Las funcionalidades que dejan de estar disponibles con la suscripción en mora. */
  readonly noSobrevivenLaMora: ReadonlySet<string>;
}

let catalogo: Cacheado<Catalogo> | undefined;
const porEmpresa = new Map<string, Cacheado<ReadonlySet<string> | null>>();
const estadoPorEmpresa = new Map<string, Cacheado<EstadoComercial | null>>();

/**
 * En qué situación está la suscripción vigente de una empresa.
 *
 * `null` es «no hay ninguna suscripción», que es distinto de todas las demás:
 * es el único caso en que no se sabe nada, y el único que deja pasar.
 */
export type EstadoComercial = 'PRUEBA' | 'ACTIVA' | 'MOROSA' | 'SUSPENDIDA' | 'CANCELADA';

/**
 * Los estados en los que la empresa no llega a los módulos que un plan gobierna.
 *
 * Escrito como lista de lo que corta y no como lista de lo que deja pasar: un
 * estado nuevo en el vocabulario tiene que decidir explícitamente si corta, en
 * vez de heredar el corte por omisión y dejar a alguien afuera sin que nadie lo
 * haya decidido.
 */
const CORTAN_EL_ACCESO: ReadonlySet<EstadoComercial> = new Set<EstadoComercial>([
  'SUSPENDIDA',
  'CANCELADA',
]);

// `MOROSA` **no está acá**, y la ausencia es la decisión completa: la mora no
// corta, degrada. Meterla en esta lista habría sido la forma más corta de
// implementar la 0124 y también la de borrar la única diferencia que justifica
// que el estado exista. Lo que hace la mora está en `alcanzaElPlan`, en su
// propia rama, contra `product_features.sobrevive_la_mora`.

/** El catálogo entero, de una consulta, cacheado un minuto. */
async function catalogoDeFuncionalidades(tx: Tx): Promise<Catalogo> {
  const ahora = Date.now();
  if (catalogo !== undefined && catalogo.hasta > ahora) return catalogo.valor;

  const { rows } = await tx.query<{
    code: string;
    dominios: string[];
    sobrevive_la_mora: boolean;
  }>('SELECT code, dominios, sobrevive_la_mora FROM product_features');

  const mapa = new Map<string, string>();
  const noSobreviven = new Set<string>();
  for (const f of rows) {
    for (const d of f.dominios) mapa.set(d, f.code);
    if (!f.sobrevive_la_mora) noSobreviven.add(f.code);
  }

  const valor: Catalogo = { dominios: mapa, noSobrevivenLaMora: noSobreviven };
  catalogo = { valor, hasta: ahora + VIDA_DEL_CACHE };
  return valor;
}

/**
 * Dominio de ruta → funcionalidad que lo cubre.
 *
 * Un dominio que no está acá no lo cubre ninguna funcionalidad, y por lo tanto
 * ningún plan lo puede excluir.
 */
export async function mapaDeDominios(tx: Tx): Promise<ReadonlyMap<string, string>> {
  return (await catalogoDeFuncionalidades(tx)).dominios;
}

/**
 * Las funcionalidades que dejan de estar disponibles con la suscripción en mora.
 *
 * Sale de `product_features.sobrevive_la_mora` (0125) y **no del plan**: el CRM
 * del plan más caro se degrada igual que el del más barato. La lista completa y
 * el criterio están en esa migración.
 */
export async function funcionalidadesQueNoSobrevivenLaMora(
  tx: Tx,
): Promise<ReadonlySet<string>> {
  return (await catalogoDeFuncionalidades(tx)).noSobrevivenLaMora;
}

/**
 * Las funcionalidades que tiene contratadas una empresa, o `null` si no hay
 * nada que decir.
 *
 * `null` significa «esta empresa no tiene una suscripción con plan», y no
 * «no tiene ninguna funcionalidad». La diferencia decide si se deja pasar o no,
 * y devolver un conjunto vacío en ese caso dejaría a toda empresa sin plan sin
 * poder abrir el sistema.
 */
export async function funcionalidadesDe(
  tx: Tx,
  companyId: string,
): Promise<ReadonlySet<string> | null> {
  const ahora = Date.now();
  const previo = porEmpresa.get(companyId);
  if (previo !== undefined && previo.hasta > ahora) return previo.valor;

  const { rows } = await tx.query<{ feature_code: string }>(
    `SELECT pf.feature_code
       FROM company_subscriptions s
       JOIN plan_features pf ON pf.plan_id = s.plan_id
      -- MOROSA está en la lista, y omitirla habría recreado exactamente el
      -- defecto que cuenta el encabezado de este archivo: una morosa devolvería
      -- cero filas, cero filas se colapsa en "no hay suscripción con plan", y
      -- eso se deja pasar. Deber la cuota le habría abierto el producto entero.
      WHERE s.company_id = $1
        AND s.estado IN ('ACTIVA', 'PRUEBA', 'MOROSA')
        AND s.vigencia_desde <= CURRENT_DATE
        AND (s.vigencia_hasta IS NULL OR s.vigencia_hasta >= CURRENT_DATE)`,
    [companyId],
  );

  // Sin filas puede ser «sin suscripción» o «suscripción con un plan sin
  // funcionalidades cargadas». Los dos casos se dejan pasar, así que se
  // colapsan en `null` en vez de en un conjunto vacío que se leería como
  // «no tiene nada contratado».
  const valor = rows.length === 0 ? null : new Set(rows.map((r) => r.feature_code));
  porEmpresa.set(companyId, { valor, hasta: ahora + VIDA_DEL_CACHE });
  return valor;
}

/**
 * El estado de la suscripción vigente, o `null` si la empresa no tiene ninguna.
 *
 * **Se mira la última fila por `vigencia_desde`, sin filtrar por vigencia.** Es
 * la diferencia con `funcionalidadesDe` y no es un descuido: una prueba que
 * venció queda `SUSPENDIDA` con `vigencia_hasta` **en el pasado**, así que
 * cualquier condición de vigencia la haría desaparecer de la consulta — que es
 * exactamente cómo el defecto se escondía. Lo que se pregunta acá no es «¿está
 * vigente?» sino «¿cuál es su situación?», y una suscripción caída sigue
 * teniendo situación.
 */
export async function estadoComercialDe(
  tx: Tx,
  companyId: string,
): Promise<EstadoComercial | null> {
  const ahora = Date.now();
  const previo = estadoPorEmpresa.get(companyId);
  if (previo !== undefined && previo.hasta > ahora) return previo.valor;

  const { rows } = await tx.query<{ estado: EstadoComercial }>(
    `SELECT estado
       FROM company_subscriptions
      WHERE company_id = $1
      -- created_at desempata: dos filas con la misma fecha de inicio existen
      -- —convertir una prueba el mismo día que se dio de alta— y sin desempate
      -- el estado dependería del orden físico de las filas.
      ORDER BY vigencia_desde DESC, created_at DESC
      LIMIT 1`,
    [companyId],
  );

  const valor = rows[0]?.estado ?? null;
  estadoPorEmpresa.set(companyId, { valor, hasta: ahora + VIDA_DEL_CACHE });
  return valor;
}

export interface Veredicto {
  readonly permitido: boolean;
  /** La funcionalidad que gobierna el dominio, si alguna. */
  readonly feature: string | null;
  /**
   * Por qué no se permitió.
   *
   * `FUERA_DEL_PLAN` es «no lo contrataste» y `SUSCRIPCION_SUSPENDIDA` es «lo
   * contrataste y está cortado». Contestar lo mismo en los dos casos mandaría a
   * comprar un módulo que la empresa ya tiene al cliente que solo tiene que
   * ponerse al día.
   *
   * `DEGRADADA_POR_MORA` es el tercero y dice la cosa más precisa de los tres:
   * «lo contrataste, tenés una deuda, y **este** módulo es de los que se
   * apagan mientras dure». No es una suspensión —el resto del sistema anda— y
   * decirlo como suspensión asustaría a alguien que sigue pudiendo facturar,
   * asentar y presentar.
   */
  readonly motivo: 'FUERA_DEL_PLAN' | 'SUSCRIPCION_SUSPENDIDA' | 'DEGRADADA_POR_MORA' | null;
}

/**
 * ¿Puede esta empresa entrar a este dominio?
 *
 * `url` es la ruta completa: se toma su primer segmento. Se hace acá y no en
 * quien llama para que no haya dos formas de calcular el dominio.
 */
export async function alcanzaElPlan(
  tx: Tx,
  companyId: string,
  url: string,
): Promise<Veredicto> {
  const dominio = url.split('?')[0]?.split('/')[1] ?? '';
  const mapa = await mapaDeDominios(tx);
  const feature = mapa.get(dominio);

  // Dominio sin funcionalidad que lo cubra: ningún plan lo puede excluir, y
  // tampoco lo corta una suspensión. Es lo que deja abiertas `/suscripciones` y
  // `/companies/current` para el que viene a ponerse al día.
  if (feature === undefined) return { permitido: true, feature: null, motivo: null };

  // El estado se pregunta ANTES que las funcionalidades, y el orden es la
  // corrección: una suspendida no devuelve funcionalidades, así que preguntarlo
  // después la haría indistinguible de una empresa sin plan.
  const estado = await estadoComercialDe(tx, companyId);
  if (estado !== null && CORTAN_EL_ACCESO.has(estado)) {
    return { permitido: false, feature, motivo: 'SUSCRIPCION_SUSPENDIDA' };
  }

  /**
   * La mora: una sola rama, y va acá.
   *
   * **Antes de mirar lo contratado**, por el mismo motivo por el que el estado
   * se pregunta antes: `MOROSA` es información —dice que no— y lo contratado
   * puede ser silencio. Un plan sin funcionalidades cargadas devuelve `null`,
   * `null` deja pasar, y poner esta rama después haría que la degradación
   * dependiera de que el catálogo comercial estuviera completo.
   *
   * La consecuencia se acepta a sabiendas: a una empresa en mora que nunca
   * contrató el CRM se le contesta `DEGRADADA_POR_MORA` en vez de
   * `FUERA_DEL_PLAN`. Las dos son ciertas y la que se dice es la accionable —
   * la deuda vence antes que la decisión de comprar un módulo—, y en cuanto
   * pague pasa a recibir la otra, que es la exacta.
   *
   * **No mira el método.** No hay «leer sí, escribir no»: la puerta comercial
   * nunca supo de verbos y enseñarle uno ahora significaría dos reglas donde
   * hoy hay una, con la garantía de que en algún momento discrepen.
   */
  if (estado === 'MOROSA' && (await funcionalidadesQueNoSobrevivenLaMora(tx)).has(feature)) {
    return { permitido: false, feature, motivo: 'DEGRADADA_POR_MORA' };
  }

  const contratadas = await funcionalidadesDe(tx, companyId);
  if (contratadas === null) return { permitido: true, feature, motivo: null };

  const permitido = contratadas.has(feature);
  return { permitido, feature, motivo: permitido ? null : 'FUERA_DEL_PLAN' };
}

/**
 * Olvida lo cacheado para una empresa.
 *
 * Lo llama quien cambia una suscripción, para que un upgrade se vea enseguida
 * en vez de al minuto. No es correctitud —el cache vence solo—, es que la
 * persona que acaba de pagar no tenga que esperar mirando la pantalla.
 */
export function olvidarPlanDe(companyId: string): void {
  porEmpresa.delete(companyId);
  // El estado también, y este importa más: quien acaba de pagar para levantar
  // una suspensión no puede quedarse hasta un minuto mirando un 403.
  estadoPorEmpresa.delete(companyId);
}

/** Vacía todo. Existe para los tests, que cambian planes entre casos. */
export function olvidarTodosLosPlanes(): void {
  porEmpresa.clear();
  estadoPorEmpresa.clear();
  catalogo = undefined;
}
