/**
 * Del catálogo modelo a las cuentas de una empresa.
 *
 * ## La copia es por valor, y eso es la decisión
 *
 * No se guarda una referencia viva a la plantilla: se insertan 185 filas en
 * `accounts` que **son de la empresa**. Desde el segundo cero se pueden
 * renombrar, archivar y usar sin que nada de eso afecte a nadie más, y una
 * versión 2 del modelo no le cambia el plan a quien ya empezó a trabajar.
 *
 * Lo único que queda apuntando al modelo es su nombre y su número de versión, en
 * `account_charts` (migración 0127). Sirve para una sola cosa: saber a quién
 * ofrecerle el diff cuando exista una versión nueva.
 *
 * ## Por qué no hay tabla de plantillas
 *
 * La definición vive en `@aai/shared`, tipada y con sus controles. Sembrarla
 * además en la base sería una segunda copia de la misma definición — el defecto
 * que este repositorio viene corrigiendo desde la lista de organismos de
 * contralor. Acá se lee el catálogo y se escribe la empresa; no hay paso
 * intermedio que pueda desincronizarse.
 *
 * ## El orden de inserción no es un detalle
 *
 * Las cuentas se insertan **por nivel**, de la raíz hacia las hojas, porque
 * `parent_id` referencia una fila que tiene que existir. Y hay un segundo
 * motivo, menos evidente: el trigger `accounts_parent_not_postable` de la 0003
 * vuelve no imputable a la cuenta que recibe una hija. Insertar una hoja antes
 * que su padre no solo falla por la FK — invertiría quién termina siendo
 * imputable.
 *
 * ## Una sola vez, y sobre una empresa vacía
 *
 * Si la empresa ya tiene una cuenta, no se materializa nada. No es una
 * optimización: mezclar el modelo con un plan existente produciría códigos
 * repetidos, rubros duplicados y un plan que no es ni el suyo ni el nuestro.
 * Quien ya tiene plan importa el suyo o lo edita; el modelo es para quien
 * arranca sin nada.
 */

import type { Tx } from '@aai/db';
import {
  CUENTAS,
  naturalezaDe,
  nivelDe,
  padreDe,
  PLANTILLA,
  type CuentaDelPlan,
} from '@aai/shared';

export type ResultadoDeMaterializacion =
  | { readonly estado: 'MATERIALIZADO'; readonly chartId: string; readonly cuentas: number }
  | { readonly estado: 'YA_TIENE_PLAN'; readonly cuentas: number };

/**
 * Crea el plan de cuentas modelo dentro de una empresa.
 *
 * Corre dentro de la transacción de quien la llama: o entran las 185 cuentas o
 * no entra ninguna. Un plan a medias es peor que no tener plan, porque parece
 * uno.
 */
export async function materializarPlanModelo(
  tx: Tx,
  companyId: string,
): Promise<ResultadoDeMaterializacion> {
  const existentes = await tx.query<{ n: string }>(
    'SELECT count(*)::text AS n FROM accounts WHERE company_id = $1',
    [companyId],
  );
  const cuantas = Number(existentes.rows[0]!.n);
  if (cuantas > 0) return { estado: 'YA_TIENE_PLAN', cuentas: cuantas };

  const chart = await tx.query<{ id: string }>(
    `INSERT INTO account_charts (company_id, name, template_id, template_version)
     VALUES ($1, $2, $3, $4) RETURNING id`,
    [companyId, PLANTILLA.nombre, PLANTILLA.templateId, PLANTILLA.version],
  );
  const chartId = chart.rows[0]!.id;

  // De la raíz a las hojas. Ver el encabezado: no es solo la clave foránea.
  const enOrden = [...CUENTAS].sort((a, b) => nivelDe(a.codigo) - nivelDe(b.codigo));
  const idPorCodigo = new Map<string, string>();

  for (const cuenta of enOrden) {
    const padre = padreDe(cuenta.codigo);
    const parentId = padre === null ? null : (idPorCodigo.get(padre) ?? null);

    const fila = await tx.query<{ id: string }>(
      `INSERT INTO accounts
         (company_id, chart_id, code, name, parent_id, type, nature, is_postable,
          currency, tax_role, closing_role, requires_cost_center, requires_third_party)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, 'ARS', $9, $10, false, false)
       RETURNING id`,
      [
        companyId,
        chartId,
        cuenta.codigo,
        cuenta.nombre,
        parentId,
        cuenta.tipo,
        naturalezaDe(cuenta),
        cuenta.imputable,
        cuenta.taxRole ?? null,
        cuenta.closingRole ?? null,
      ],
    );
    idPorCodigo.set(cuenta.codigo, fila.rows[0]!.id);
  }

  return { estado: 'MATERIALIZADO', chartId, cuentas: idPorCodigo.size };
}

/** Las cuentas del modelo, para mostrarlo antes de crear nada. */
export function cuentasDelModelo(): readonly CuentaDelPlan[] {
  return CUENTAS;
}
