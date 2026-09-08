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

let dominios: Cacheado<ReadonlyMap<string, string>> | undefined;
const porEmpresa = new Map<string, Cacheado<ReadonlySet<string> | null>>();

/**
 * Dominio de ruta → funcionalidad que lo cubre.
 *
 * Un dominio que no está acá no lo cubre ninguna funcionalidad, y por lo tanto
 * ningún plan lo puede excluir.
 */
export async function mapaDeDominios(tx: Tx): Promise<ReadonlyMap<string, string>> {
  const ahora = Date.now();
  if (dominios !== undefined && dominios.hasta > ahora) return dominios.valor;

  const { rows } = await tx.query<{ code: string; dominios: string[] }>(
    'SELECT code, dominios FROM product_features',
  );
  const mapa = new Map<string, string>();
  for (const f of rows) {
    for (const d of f.dominios) mapa.set(d, f.code);
  }
  dominios = { valor: mapa, hasta: ahora + VIDA_DEL_CACHE };
  return mapa;
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
      WHERE s.company_id = $1
        AND s.estado IN ('ACTIVA', 'PRUEBA')
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

export interface Veredicto {
  readonly permitido: boolean;
  /** La funcionalidad que gobierna el dominio, si alguna. */
  readonly feature: string | null;
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

  // Dominio sin funcionalidad que lo cubra: ningún plan lo puede excluir.
  if (feature === undefined) return { permitido: true, feature: null };

  const contratadas = await funcionalidadesDe(tx, companyId);
  if (contratadas === null) return { permitido: true, feature };

  return { permitido: contratadas.has(feature), feature };
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
}

/** Vacía todo. Existe para los tests, que cambian planes entre casos. */
export function olvidarTodosLosPlanes(): void {
  porEmpresa.clear();
  dominios = undefined;
}
