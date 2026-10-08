/**
 * El cálculo del hash de las dos bitácoras encadenadas, **fuera de PostgreSQL**.
 *
 * Es la copia independiente de la fórmula de los triggers `audit_chain_link`
 * (0025) y `normative_audit_chain_link` (0041). Existe para poder comprobar una
 * cadena sin pasar por las funciones que la escribieron: el verificador de la
 * base (`verify_audit_chain`) y el trigger están fijados igual y podrían
 * equivocarse juntos; este cálculo, hecho en JavaScript con SHA-256 de Node, no.
 *
 * Las columnas se leen desde una sesión canónica (UTC y `DateStyle` ISO), que es
 * la forma en que se escribió todo el historial: `occurred_at::text` es lo único
 * del payload que depende de la sesión.
 */

import { createHash } from 'node:crypto';

export const GENESIS = '0'.repeat(64);

/** `concat_ws('|', …)` de PostgreSQL: salta los NULL y une el resto. */
const concatWs = (partes) => partes.filter((p) => p !== null && p !== undefined).join('|');

/** Payload de `audit_logs` (por empresa). `COALESCE(…, '')` solo en las tres columnas opcionales. */
export function payloadDeAuditoria(f) {
  return concatWs([
    f.prev_hash, f.seq, f.company_id, f.actor_type, f.actor_id, f.action,
    f.object_type, f.object_id,
    f.old_value ?? '', f.new_value ?? '', f.motivo ?? '', f.occurred_at,
  ]);
}

/** Payload de `normative_audit_logs` (global, sin `company_id`; `motivo` no se rellena). */
export function payloadNormativo(f) {
  return concatWs([
    f.prev_hash, f.seq, f.actor_type, f.actor_id, f.action,
    f.object_type, f.object_id,
    f.old_value ?? '', f.new_value ?? '', f.motivo, f.occurred_at,
  ]);
}

export const sha256 = (texto) => createHash('sha256').update(texto, 'utf8').digest('hex');

/**
 * Revisa una ventana de filas **en orden ascendente de `seq`** de una misma cadena.
 *
 * - Recalcula el hash de cada fila y lo compara con el guardado.
 * - Comprueba el enlace: el `prev_hash` de cada fila es el `hash` de la anterior
 *   (la primera de la ventana no tiene anterior a la vista, salvo que sea la
 *   génesis, que tiene que traer 64 ceros).
 *
 * Los saltos de `seq` no son una rotura: la secuencia es global y la comparten
 * todas las empresas.
 */
export function revisarVentana(filas, payloadDe, { desdeElPrincipio = false } = {}) {
  const hashesRotos = [];
  const enlacesRotos = [];
  filas.forEach((fila, i) => {
    const recalculado = sha256(payloadDe(fila));
    if (recalculado !== String(fila.hash).trim()) {
      hashesRotos.push({ id: fila.id, seq: fila.seq, guardado: String(fila.hash).trim(), recalculado });
    }
    const previo = String(fila.prev_hash).trim();
    if (i > 0) {
      if (previo !== String(filas[i - 1].hash).trim()) enlacesRotos.push({ id: fila.id, seq: fila.seq, prevHash: previo });
    } else if (desdeElPrincipio && previo !== GENESIS) {
      // La ventana arranca en la primera fila de la cadena: su enlace es la génesis.
      enlacesRotos.push({ id: fila.id, seq: fila.seq, prevHash: previo });
    }
  });
  return { revisadas: filas.length, hashesRotos, enlacesRotos };
}
