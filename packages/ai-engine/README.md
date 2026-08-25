# @aai/ai-engine

Agentes detrás de una interfaz agnóstica de proveedor. **La IA propone; nunca escribe.**

## La frontera, y cómo se hace cumplir

```
DOCUMENTO → contexto resuelto → AGENTE → PROPUESTA
                                            │
                                   ┌────────▼────────┐
                                   │ VALIDATION LAYER│  ← única puerta
                                   └────────┬────────┘
                                            │
                              revisión humana → motor contable
```

No es una política del equipo. Son tres cosas verificadas mecánicamente:

1. **Lint de arquitectura** (`npm run lint:arch`): este paquete no puede importar
   `accounting-engine`, `tax-engine`, `document-engine`, `arca` ni un cliente de
   base. Hay un test que introduce la violación a propósito y comprueba que el
   lint se cae.
2. **Constraint en la base**: `je_ai_requires_human_approval` impide que un
   asiento con `ai_prediction_id` llegue a `APROBADO` sin `approved_by`.
3. **La dirección de la FK**: `journal_entries → ai_predictions`. No existe la
   inversa, así que una predicción no tiene dónde apuntar para crear un asiento.

## Controles anti-alucinación

La instrucción "no alucines" no es un control. Estos sí:

| Control | Cómo |
|---|---|
| **Salida cerrada** | La cuenta es un `enum` con los códigos del plan real de *esa* empresa |
| **Sin lugar para importes** | El schema no tiene campo donde ponerlos. No hay regla que recordar |
| **Citas acotadas al contexto** | Solo se puede citar lo que se le pasó. Una norma "de memoria" se rechaza |
| **Doble validación** | La Validation Layer no confía en que el schema haya hecho su trabajo |
| **Abstención barata** | `abstencion: true` es una salida prevista, no un error |
| **Doble pasada** | Confianza baja → se repregunta con contexto ampliado antes de bloquear |

Y una distinción que atraviesa todo el módulo: **inventar no es lo mismo que
equivocarse**. Una cuenta que no existe en el plan es una alucinación; una cuenta
de agrupación elegida por error es un problema de criterio. Se registran por
separado en `ai_rejections.es_alucinacion` porque no se corrigen igual.

## Los disparadores duros no se le preguntan al modelo

Se calculan de hechos: qué dijo ARCA, si el proveedor es nuevo, si el importe se
sale del historial, si el período está por cerrar. Cualquiera de ellos fuerza 🔴
por más que el modelo declare 0.99.

La confianza del modelo es **una señal entre varias**, no la decisión.

Para el importe atípico se usan **mediana y desviación absoluta mediana**, no
media y desvío estándar: la MAD no se deja arrastrar por un único valor extremo,
y en contabilidad los valores extremos son justamente lo que se busca detectar.
Todo el cálculo es con `bigint` — un estadístico sobre importes tampoco puede
pasar por punto flotante.

## 🟢 no significa contabilizado

| Banda | Qué habilita |
|---|---|
| 🟢 ALTA | Proponer **en lote** para que un profesional apruebe |
| 🟡 MEDIA | Revisión individual |
| 🔴 BAJA | Intervención profesional |

Las tres requieren aprobación humana. Lo que cambia es si se puede aprobar en
tanda o hay que abrir cada una.

Una propuesta sin citas, o con citas que no llegan a `V1`, **no llega a 🟢** por
más confianza que tenga: es la diferencia entre "el sistema cree esto" y "el
sistema puede mostrarte de dónde lo saca".

## Hoy, todo cae en 🔴

El motor normativo llega en FASE 6. Hasta entonces el estado normativo es
`NO_CONSULTADO` — que **no** es lo mismo que `FUENTE_NO_ENCONTRADA`: el sistema no
preguntó, y decir "no hay norma" cuando nadie buscó sería afirmar de más.

`NO_CONSULTADO` es un disparador duro, así que ninguna propuesta se aprueba en
lote todavía. Es lo correcto: aprobar contabilidad en tanda sin motor normativo
sería exactamente lo que este diseño existe para no hacer. La sugerencia igual
sirve — el contador la ve con su razón y su cuenta, y aprueba de a una.

## Sin proveedor de IA el sistema sigue sugiriendo

`AI_PROVIDER=none` es el valor por defecto y **es un modo de operación**, no un
estado degradado: los documentos de un estudio son secreto profesional, y para
muchos clientes mandarlos a un tercero es una conversación que no quieren tener.

En ese modo las sugerencias salen de `classification_preferences`: lo que la
propia empresa ya aprobó. Sin red, sin proveedor, sin enviar nada.

Igual que con ARCA y con el OCR: **el simulado se usa si y solo si está pedido
explícitamente**. No hay caída automática al mock.

## El aprendizaje mueve la sugerencia, no la norma

```
classification_preferences  ──✗──►  accounting_rules
classification_preferences  ──✗──►  norm_versions
```

Si cien veces el contador clasificó mal, el sistema va a aprender a sugerir mal.
Nunca va a decir que la norma dice otra cosa. Lo primero es un error del estudio
que se corrige revisando; lo segundo sería el sistema fabricando derecho.

Además: una preferencia no llega a 🟢 nunca. "Lo hiciste 50 veces" explica por
qué se sugiere, no por qué corresponde. Y no puede levantar un disparador duro —
hay un test que lo fija.

El aprendizaje es **por empresa**. No se comparte entre clientes del estudio.

## Los prompts son artefactos versionados

`ai_predictions.prompt_hash` tiene FK a `prompt_versions`: un prompt no
registrado no puede usarse, y uno archivado es inmutable. Sin el texto guardado,
el hash sería la huella de algo que ya no se puede leer.

```bash
npm run prompts:register
```

Lo que el prompt **no** dice también importa: no enseña contabilidad. No dice a
qué cuenta va una factura de teléfono. Toda esa lógica vive en el dominio y en
las reglas normativas (§28). Un prompt que enseñara contabilidad convertiría al
modelo en la autoridad contable del sistema.
