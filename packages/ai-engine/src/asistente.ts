/**
 * El control del texto que dice el asistente conversacional. Puro: sin base, sin proveedor.
 *
 * El asistente conversa y consulta herramientas; lo que le dice a la persona es texto libre, y el texto libre es donde un
 * modelo inventa. El control es el mismo que ya protege al respondedor (§41, ADR-017): **cada cifra de tres dígitos o más
 * que aparezca en el texto tiene que estar en algo que el sistema le entregó en esta conversación**:
 *
 *   · lo que devolvieron las herramientas en este turno;
 *   · lo que escribió la persona (si ella dice «el CUIT 20-12345678-6», el asistente puede repetirlo);
 *   · lo que el propio asistente ya dijo y pasó el control en turnos anteriores.
 *
 * Lo que NO hace: no entiende el texto. No sabe si «ventas bajaron» es cierto, ni si un consejo es un consejo. Eso lo
 * atajan el prompt y la advertencia que acompaña toda respuesta; este control atrapa la cifra que no salió de ningún lado,
 * que es la falla más cara y la única que se puede verificar mecánicamente.
 *
 * Una respuesta que no pasa el control se descarta ENTERA (el modelo tiene una oportunidad de corregirse): tachar el número
 * dejaría la frase que lo rodeaba, y esa frase afirmaba algo.
 */

import { ADVERTENCIA_OBLIGATORIA, verificarCifras } from './answering.js';
import type { LlamadaEjecutada, VeredictoDeTexto } from './chat.js';

/** La advertencia que acompaña toda respuesta del asistente (§42). */
export const ADVERTENCIA_DEL_ASISTENTE = ADVERTENCIA_OBLIGATORIA;

export interface EntradaDelControl {
  readonly texto: string;
  readonly llamadas: readonly LlamadaEjecutada[];
  /** El mensaje de la persona en este turno. */
  readonly mensajeDelUsuario: string;
  /** Lo dicho antes en la conversación (de ambos lados), en texto. */
  readonly historial: readonly string[];
}

/**
 * Los guiones entre dígitos se quitan de los dos lados antes de comparar: un CUIT es `20-12345678-6` o `20123456786` según
 * quién lo escriba, y el control tiene que tratarlos como la misma cifra (las fechas ISO también: `2026-10-15`).
 */
const sinGuiones = (texto: string): string => texto.replace(/(?<=\d)-(?=\d)/gu, '');

export function revisarTextoDelAsistente(entrada: EntradaDelControl): VeredictoDeTexto {
  if (entrada.texto.trim() === '') {
    return { ok: false, motivo: 'La respuesta está vacía. Respondé con texto.' };
  }

  const datos = [
    ...entrada.llamadas.map((l) => ({ etiqueta: l.nombre, valor: sinGuiones(l.resultado.contenido), origen: 'herramienta' })),
    // Lo que escribió la persona: los numerales que ella misma dio no son una invención del modelo.
    { etiqueta: 'mensaje de la persona', valor: sinGuiones(entrada.mensajeDelUsuario), origen: 'persona' },
    ...entrada.historial.map((h) => ({ etiqueta: 'conversación previa', valor: sinGuiones(h), origen: 'historial' })),
  ];

  const rechazos = verificarCifras(
    { texto: sinGuiones(entrada.texto), datosUsados: [], normasCitadas: [], abstencion: false },
    { companyId: '', pregunta: entrada.mensajeDelUsuario, datos, normas: [], periodo: null },
  );

  if (rechazos.length === 0) return { ok: true };
  return {
    ok: false,
    motivo:
      `${rechazos.map((r) => r.detalle).join(' ')} ` +
      'Reescribí la respuesta usando SOLO cifras que devolvió una herramienta o que escribió la persona, ' +
      'o decí que no tenés ese dato.',
  };
}
