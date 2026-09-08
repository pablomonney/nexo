/**
 * El detector: convierte señales que cruzan su umbral en alertas.
 *
 * ## Qué hace y qué no
 *
 * **No detecta nada por su cuenta.** Las señales ya están calculadas —
 * `analysis_signals` es una vista determinística sobre los hechos, con la
 * metodología escrita en cada fila—. Lo que hace este módulo es lo que la vista
 * no puede: **recordar desde cuándo**.
 *
 * Una señal que cruza el umbral hoy y otra que lo cruzó hace tres semanas se ven
 * idénticas en la vista, y no lo son: la segunda es un problema que nadie miró.
 *
 * ## Sin umbral declarado no hay alerta
 *
 * `supera_umbral` viene en `null` cuando la empresa no declaró contra qué
 * comparar. Eso **no** es «no supera»: es que nadie dijo cuál es el límite, y
 * abrir una alerta ahí sería inventar la política. El detector las cuenta y las
 * informa aparte, que es lo que permite darse cuenta de que falta configurarlas.
 *
 * ## Una abierta por sujeto
 *
 * Correr esto cada hora no puede generar veinticuatro alertas por día del mismo
 * problema. Si el sujeto ya tiene una abierta, se actualiza el valor y la última
 * vez que se vio; no se abre otra. El índice único parcial de la 0102 lo hace
 * imposible además de improbable.
 *
 * Es la diferencia entre un sistema que avisa y uno que hace ruido, y el segundo
 * termina apagado.
 *
 * ## Lo que se corrige se cierra solo
 *
 * Si una alerta abierta ya no tiene señal que la sostenga, el detector la marca
 * `RESUELTA` con su fecha. No la borra: la alerta sigue diciendo que el problema
 * existió y cuánto duró, que es información que nadie más tiene.
 */

import { recordAudit, type Tx } from '@aai/db';

/** Una señal tal como la devuelve la vista. */
interface Senal {
  readonly tipo: string;
  readonly sujeto: string | null;
  readonly entity_id: string | null;
  readonly entidad: string | null;
  readonly valor: string | null;
  readonly unidad: string | null;
  readonly referencia: string | null;
  readonly umbral: string | null;
  readonly supera_umbral: boolean | null;
  readonly metodologia: string;
}

export interface InformeDeDeteccion {
  readonly abiertas: number;
  readonly actualizadas: number;
  readonly resueltas: number;
  /** Señales que no se pudieron juzgar porque nadie declaró el umbral. */
  readonly sinUmbral: number;
  readonly detalle: readonly string[];
}

/**
 * Con qué gravedad se abre una alerta.
 *
 * Sale de **cuánto** se pasó del umbral, no del tipo de señal: un margen un
 * punto abajo del mínimo y uno veinte puntos abajo no son el mismo problema, y
 * clasificarlos igual haría que la lista se ordenara por tipo en vez de por
 * importancia.
 *
 * Sin umbral no se llega acá —no se abre alerta—, y sin valor la gravedad no se
 * puede calcular: queda MEDIA, que es la única respuesta honesta cuando se sabe
 * que algo pasó y no cuánto.
 */
export function gravedadPorDesvio(valor: string | null, umbral: string | null): string {
  if (valor === null || umbral === null) return 'MEDIA';
  const v = Number(valor);
  const u = Number(umbral);
  if (!Number.isFinite(v) || !Number.isFinite(u) || u === 0) return 'MEDIA';

  // Cuánto se separó, en proporción al umbral. Es un porcentaje de desvío, no
  // un importe: no pasa por `check:no-float` porque no es dinero.
  const desvio = Math.abs((v - u) / u);
  if (desvio >= 1) return 'CRITICA';
  if (desvio >= 0.5) return 'ALTA';
  if (desvio >= 0.2) return 'MEDIA';
  return 'BAJA';
}

/**
 * Corre la detección para la empresa que esté en contexto.
 *
 * Recibe el `Tx` de quien la llama —igual que el ciclo de facturación— y por
 * eso corre bajo el RLS de la empresa: no puede tocar las alertas de otra
 * aunque quisiera.
 */
export async function detectar(
  tx: Tx,
  companyId: string,
  actorId: string,
): Promise<InformeDeDeteccion> {
  const { rows: senales } = await tx.query<Senal>(
    `SELECT tipo, sujeto, entity_id, entidad,
            valor::text, unidad, referencia::text, umbral::text,
            supera_umbral, metodologia
       FROM analysis_signals
      WHERE company_id = $1`,
    [companyId],
  );

  const sinUmbral = senales.filter((s) => s.supera_umbral === null).length;
  const desvios = senales.filter((s) => s.supera_umbral === true);

  const detalle: string[] = [];
  let abiertas = 0;
  let actualizadas = 0;

  for (const s of desvios) {
    const gravedad = gravedadPorDesvio(s.valor, s.umbral);

    // `ON CONFLICT` sobre el índice parcial: si ya hay una abierta o reconocida
    // para este sujeto, se actualiza en vez de duplicar. Que lo resuelva la base
    // y no un `SELECT` previo evita la carrera entre dos corridas simultáneas.
    const r = await tx.query<{ id: string; nueva: boolean }>(
      `INSERT INTO alerts
         (company_id, kind, severity, object_type, object_id, sujeto,
          valor, unidad, umbral, referencia, metodologia, payload, status)
       VALUES ($1, $2, $3, $4, $5, $6, $7::numeric, $8, $9::numeric, $10::numeric, $11,
               jsonb_build_object('tipo', $2::text, 'sujeto', $6::text), 'ABIERTA')
       ON CONFLICT (company_id, kind, sujeto) WHERE status IN ('ABIERTA', 'RECONOCIDA')
       DO UPDATE SET valor = EXCLUDED.valor,
                     umbral = EXCLUDED.umbral,
                     referencia = EXCLUDED.referencia,
                     metodologia = EXCLUDED.metodologia,
                     severity = EXCLUDED.severity,
                     vista_el = now()
       RETURNING id, (xmax = 0) AS nueva`,
      [
        companyId,
        s.tipo,
        gravedad,
        s.entidad ?? 'signal',
        s.entity_id,
        s.sujeto,
        s.valor,
        s.unidad,
        s.umbral,
        s.referencia,
        s.metodologia,
      ],
    );

    const fila = r.rows[0]!;
    if (fila.nueva) {
      abiertas += 1;
      detalle.push(`ABIERTA ${gravedad} ${s.tipo} — ${s.sujeto ?? 'sin sujeto'}`);
      // Solo la apertura va a la bitácora. Registrar cada revisita llenaría la
      // bitácora de filas que dicen «esto sigue igual», y la bitácora es donde
      // se busca lo que cambió.
      await recordAudit(tx, companyId, {
        actorType: 'SYSTEM',
        actorId,
        action: 'ABRIR_ALERTA',
        objectType: 'alert',
        objectId: fila.id,
        newValue: {
          tipo: s.tipo,
          sujeto: s.sujeto,
          valor: s.valor,
          umbral: s.umbral,
          gravedad,
        },
      });
    } else {
      actualizadas += 1;
    }
  }

  // Lo que ya no tiene señal que lo sostenga se cierra. No se borra: la alerta
  // sigue diciendo que el problema existió y cuánto duró.
  // Lo vivo se compara por par (tipo, sujeto) con `unnest`, no concatenando los
  // dos en una cadena. La primera versión los unía con un separador y eso mete
  // un problema donde no lo había: cualquier separador que se elija puede
  // aparecer dentro de un sujeto, y ahí el detector cerraría una alerta viva.
  const tipos = desvios.map((s) => s.tipo);
  const sujetos = desvios.map((s) => s.sujeto);
  const cerradas = await tx.query<{ id: string; kind: string; sujeto: string | null }>(
    // `acknowledged_by` lleva quién la sacó de ABIERTA, y acá la sacó el
    // detector. El CHECK de la 0028 —escrito cuando toda transición era humana—
    // exige que alguien firme cualquier estado que no sea ABIERTA, y tenía
    // razón: una alerta que se cierra sin decir quién ni por qué es una alerta
    // que desaparece. El prefijo `system:` deja claro que no la miró una
    // persona.
    `UPDATE alerts
        SET status = 'RESUELTA', resuelta_el = now(),
            acknowledged_by = $4, acknowledged_at = now(),
            ack_reason = 'La señal dejó de cruzar el umbral: el problema se corrigió'
      WHERE company_id = $1
        AND status IN ('ABIERTA', 'RECONOCIDA')
        AND NOT EXISTS (
          SELECT 1 FROM unnest($2::text[], $3::text[]) AS viva(tipo, sujeto)
           WHERE viva.tipo = alerts.kind
             AND viva.sujeto IS NOT DISTINCT FROM alerts.sujeto
        )
      RETURNING id, kind, sujeto`,
    [companyId, tipos, sujetos, actorId],
  );

  for (const c of cerradas.rows) {
    detalle.push(`RESUELTA ${c.kind} — ${c.sujeto ?? 'sin sujeto'}`);
    await recordAudit(tx, companyId, {
      actorType: 'SYSTEM',
      actorId,
      action: 'RESOLVER_ALERTA',
      objectType: 'alert',
      objectId: c.id,
      newValue: { tipo: c.kind, sujeto: c.sujeto, motivo: 'La señal dejó de cruzar el umbral' },
    });
  }

  return {
    abiertas,
    actualizadas,
    resueltas: cerradas.rows.length,
    sinUmbral,
    detalle,
  };
}
