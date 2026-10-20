/**
 * A qué empresas del estudio puede llegar el asistente de una persona.
 *
 * Un estudio contable lleva muchas empresas, y el asistente tiene que poder contestar sobre todas las que la persona lleva sin que ella
 * cambie de empresa a mano. Lo que **no** cambia es de quién son los permisos: el asistente nunca tiene permisos propios, y en cada empresa
 * vale exactamente lo que esa persona puede en esa empresa.
 *
 * Una empresa entra en la lista sólo si se cumplen **todas** estas condiciones, evaluadas en la propia empresa:
 *
 *   1. Es del mismo estudio que la empresa en la que está conversando y la persona tiene acceso a ella (un rol vigente o un puesto propio).
 *   2. Está activa.
 *   3. **El asistente está encendido para ella.** Encenderlo es la decisión de que los datos de esa empresa salgan hacia el proveedor del
 *      modelo, y esa decisión es por empresa: que esté encendido en otra no la toma.
 *   4. El plan de la empresa incluye el asistente y no está suspendida (la misma puerta comercial que cierra cualquier otro módulo).
 *   5. La persona puede usarlo ahí (`intelligence:ask`) y, si lo que puede hacer en esa empresa exige segundo factor, lo tiene. Es la regla
 *      de `requireCompany`: el segundo factor no se esquiva entrando por el asistente.
 *
 * Se resuelve una vez por turno y se recuerda: son varias consultas por empresa y el turno puede pedir la lista más de una vez.
 */

import { withCompany, withoutCompany } from '@aai/db';
import { ROLES_REQUIRING_MFA } from '../http/context.js';
import { alcanzaElPlan, funcionalidadesDe } from '../planes/alcance.js';
import { permisoSensible } from '../puestos/catalogo-de-permisos.js';

/** Hasta cuántas empresas mira el asistente en un turno. Un estudio más grande se avisa, no se recorta en silencio. */
export const MAXIMO_DE_EMPRESAS = 25;

export interface EmpresaAccesible {
  readonly id: string;
  readonly razonSocial: string;
  readonly cuit: string;
  /** Lo que esta persona puede en ESA empresa. */
  readonly permisos: ReadonlySet<string>;
  /** Los módulos que tiene contratados ESA empresa (`null` = sin suscripción con plan: no se restringe). */
  readonly funcionalidades: ReadonlySet<string> | null;
}

export interface AccesoDelEstudio {
  readonly empresas: readonly EmpresaAccesible[];
  /** El estudio tiene más empresas accesibles de las que se miran en un turno. */
  readonly hayMas: boolean;
  /** Empresas del estudio a las que la persona llega pero donde el asistente no está disponible para ella (apagado, plan, permiso). */
  readonly sinAsistente: number;
}

export interface QuienPregunta {
  /** La empresa en la que está conversando. */
  readonly companyId: string;
  readonly usuarioId: string;
  /** `users.mfa_enabled`: sin segundo factor no se entra a una empresa donde el rol lo exige. */
  readonly mfaActivado: boolean;
}

interface Candidata {
  id: string;
  legal_name: string;
  cuit: string;
  status: string;
  organization_id: string;
  roles: string[];
}

export async function accesoDelEstudio(quien: QuienPregunta): Promise<AccesoDelEstudio> {
  const actorId = `user:${quien.usuarioId}`;
  // `user_companies()` deriva la persona de `app.actor_id`: no se le puede preguntar por la cartera de otro.
  const todas = await withoutCompany(actorId, async (tx) =>
    (await tx.query<Candidata>('SELECT id, legal_name, cuit, status, organization_id, roles FROM user_companies()')).rows,
  );
  const actual = todas.find((c) => c.id === quien.companyId);
  if (actual === undefined) return { empresas: [], hayMas: false, sinAsistente: 0 };

  const delEstudio = todas
    .filter((c) => c.organization_id === actual.organization_id && c.status === 'ACTIVE')
    .sort((a, b) => a.legal_name.localeCompare(b.legal_name, 'es'));

  const empresas: EmpresaAccesible[] = [];
  let sinAsistente = 0;
  let hayMas = false;

  for (const c of delEstudio) {
    const veredicto = await withCompany({ companyId: c.id, actorId }, async (tx) => {
      const habilitado = (await tx.query<{ habilitado: boolean }>('SELECT habilitado FROM assistant_settings WHERE company_id = $1', [c.id])).rows[0]?.habilitado === true;
      if (!habilitado) return null;
      const permisos = new Set((await tx.query<{ code: string }>('SELECT code FROM user_permissions($1, $2)', [quien.usuarioId, c.id])).rows.map((f) => f.code));
      if (!permisos.has('intelligence:ask')) return null;
      const plan = await alcanzaElPlan(tx, c.id, '/asistente/mensajes');
      if (!plan.permitido) return null;
      // El segundo factor, con el mismo criterio que `requireCompany`: por rol, o por lo que puede hacer quien tiene un puesto propio o ajustes.
      const personalizado = (
        await tx.query<{ n: string }>(
          `SELECT ((SELECT count(*) FROM asignaciones_de_puesto_propio a JOIN puestos_propios pp ON pp.id = a.puesto_id AND pp.archivado_el IS NULL
                     WHERE a.user_id = $1 AND a.company_id = $2 AND (a.valid_to IS NULL OR a.valid_to >= CURRENT_DATE))
                   + (SELECT count(*) FROM ajustes_de_permisos WHERE user_id = $1 AND company_id = $2))::text AS n`,
          [quien.usuarioId, c.id],
        )
      ).rows[0]!.n;
      const exigeSegundoFactor =
        c.roles.some((r) => ROLES_REQUIRING_MFA.has(r)) || (Number(personalizado) > 0 && [...permisos].some(permisoSensible));
      if (exigeSegundoFactor && !quien.mfaActivado) return null;
      return { permisos, funcionalidades: await funcionalidadesDe(tx, c.id) };
    });
    if (veredicto === null) {
      if (c.id !== quien.companyId) sinAsistente += 1;
      continue;
    }
    if (empresas.length >= MAXIMO_DE_EMPRESAS) {
      hayMas = true;
      continue;
    }
    empresas.push({ id: c.id, razonSocial: c.legal_name, cuit: c.cuit, permisos: veredicto.permisos, funcionalidades: veredicto.funcionalidades });
  }

  return { empresas, hayMas, sinAsistente };
}

/** Encuentra una empresa de la lista por id, por CUIT (con o sin guiones) o por parte de la razón social. `null` si no hay una sola. */
export function resolverEmpresa(
  empresas: readonly EmpresaAccesible[],
  referencia: string,
): { readonly empresa: EmpresaAccesible } | { readonly error: string } {
  const ref = referencia.trim();
  if (ref === '') return { error: 'Falta indicar la empresa.' };
  const exacta = empresas.find((e) => e.id === ref);
  if (exacta !== undefined) return { empresa: exacta };

  const digitos = ref.replace(/\D/gu, '');
  if (digitos.length >= 8) {
    const porCuit = empresas.filter((e) => e.cuit.replace(/\D/gu, '') === digitos);
    if (porCuit.length === 1) return { empresa: porCuit[0]! };
  }

  const normal = (s: string): string => s.toLowerCase().normalize('NFD').replace(/[̀-ͯ]/gu, '').replace(/\s+/gu, ' ').trim();
  const buscada = normal(ref);
  const parecidas = empresas.filter((e) => normal(e.razonSocial).includes(buscada));
  if (parecidas.length === 1) return { empresa: parecidas[0]! };
  if (parecidas.length > 1) {
    return { error: `"${ref}" coincide con varias empresas: ${parecidas.map((e) => e.razonSocial).join('; ')}. Pedile a la persona que aclare cuál.` };
  }
  return {
    error:
      `No hay una empresa "${ref}" a la que puedas llegar. Puede no ser de este estudio, no tener el asistente encendido o no estar al alcance de ` +
      'esta persona. Usá empresas_del_estudio para ver las disponibles.',
  };
}
