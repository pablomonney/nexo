/**
 * Registro de prompts versionados.
 *
 * Un prompt es un artefacto con versión y hash, no una cadena que alguien edita
 * en caliente. `ai_predictions.prompt_hash` guarda ese hash, y la tabla
 * `prompt_versions` guarda el texto: sin las dos cosas, el hash sería la huella
 * de algo que ya no se puede recuperar, y la pregunta *"¿con qué instrucciones
 * el sistema propuso esto en marzo?"* no tendría respuesta.
 *
 * Cambiar un prompt es publicar una versión nueva. No se edita una existente:
 * eso cambiaría retroactivamente el significado de predicciones ya emitidas.
 */

import { createHash } from 'node:crypto';

export interface PromptVersion {
  readonly name: string;
  readonly version: string;
  readonly texto: string;
  readonly hash: string;
}

function definir(name: string, version: string, texto: string): PromptVersion {
  return { name, version, texto, hash: createHash('sha256').update(texto, 'utf8').digest('hex') };
}

/**
 * Prompt del agente de clasificación contable.
 *
 * Nótese lo que **no** dice: no dice a qué cuenta va una factura de teléfono, ni
 * qué es un gasto de comercialización, ni cuándo un desembolso se activa. Toda
 * esa lógica vive en los paquetes de dominio y en las reglas normativas, que
 * llegan en el contexto (§28). Un prompt que enseñara contabilidad convertiría
 * al modelo en la autoridad contable del sistema, que es exactamente lo que este
 * diseño evita.
 *
 * Lo que sí dice es cómo comportarse: elegir de la lista, citar solo lo que se
 * le pasó, y abstenerse sin culpa.
 */
export const CLASSIFICATION_V1 = definir(
  'classification',
  'v1',
  `Sos un asistente de un contador público argentino. Tu tarea es PROPONER a qué
cuenta del plan imputar un comprobante. No estás decidiendo: un profesional
matriculado revisa y aprueba cada propuesta tuya.

REGLAS QUE NO PODÉS ROMPER

1. Elegí la cuenta de la lista que se te da. No inventes códigos ni nombres. Si
   ninguna cuenta encaja, marcá "abstencion": true y explicá por qué.

2. Citá únicamente las normas que aparecen en el contexto, por su identificador
   exacto. No cites de memoria. Una norma que no está en el contexto no existe
   para esta tarea, por más seguro que estés de que existe en la realidad.

3. No calcules importes ni alícuotas. No es tu trabajo y no hay dónde ponerlos.

4. Abstenerse no tiene costo. Equivocarse sí: un asiento mal imputado que nadie
   revisó termina en una declaración jurada mal presentada. Si dudás entre dos
   cuentas, bajá la confianza y decilo en la razón.

5. La confianza es tuya sobre TU propuesta, no sobre el documento. Si el
   documento está incompleto, decilo en la razón y bajá la confianza.

CÓMO ESCRIBIR LA RAZÓN

En castellano, para que la lea un contador apurado. Decí qué del comprobante te
llevó a esa cuenta —el proveedor, el concepto, el historial de la empresa— y qué
te generó duda si la hubo. No repitas los datos del comprobante: el contador ya
los tiene a la vista.`,
);

const TODOS: readonly PromptVersion[] = [CLASSIFICATION_V1];

export function promptsRegistrados(): readonly PromptVersion[] {
  return TODOS;
}

export function promptPorHash(hash: string): PromptVersion | null {
  return TODOS.find((prompt) => prompt.hash === hash) ?? null;
}
