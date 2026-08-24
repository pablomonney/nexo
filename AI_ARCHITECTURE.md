# AI_ARCHITECTURE.md

> La IA acelera el trabajo repetitivo. **No es la autoridad contable.** Este documento define la
> frontera y cómo se hace cumplir.

## 1. Posición de la IA en el sistema

```
DOCUMENTO → extracción → contexto → AGENTE → PROPUESTA
                                                 │
                                        ┌────────▼────────┐
                                        │ VALIDATION LAYER│  ← única puerta
                                        └────────┬────────┘
                                                 │
                                    ACCOUNTING ENGINE → DATABASE
```

Ningún agente tiene:
- credenciales de escritura en la base;
- acceso al `accounting-engine`;
- capacidad de activar, editar o crear reglas normativas;
- capacidad de aprobar su propia propuesta.

Esto no es una política: es la topología de dependencias entre paquetes, verificada por lint de
arquitectura en CI (`ai-engine` no puede importar `accounting-engine` ni el cliente de base).

---

## 2. Agnosticismo de proveedor (§28)

```ts
interface LLMProvider {
  complete(req: {
    system: string;
    messages: Message[];
    schema: JSONSchema;      // salida estructurada obligatoria
    temperature: 0;          // determinismo por defecto en tareas contables
    maxTokens: number;
  }): Promise<{ output: unknown; usage: Usage; modelId: string }>;
}
```

Reglas:
- Toda la lógica contable vive en los paquetes de dominio, **nunca en el prompt**.
- Los prompts son artefactos versionados en `packages/ai-engine/prompts/`, con hash registrado en
  `ai_predictions.prompt_hash`. Cambiar un prompt es un cambio de versión auditable.
- La salida siempre es JSON validado contra schema. Una salida que no valida **se descarta**; no se
  "interpreta con buena voluntad".
- Cambiar de proveedor debe requerir cambiar una variable de entorno y una implementación de
  adaptador. Si requiere tocar lógica contable, el diseño está roto.

---

## 3. Los agentes (§29)

| Agente | Entrada | Salida | Nunca |
|--------|---------|--------|-------|
| **Document Agent** | Documento + OCR crudo | Campos estructurados con confianza por campo | Completar un campo ilegible con un valor plausible |
| **Accounting Classification Agent** | Comprobante + plan de cuentas + historial + reglas vigentes | Cuenta, tratamiento, confianza, razón, citas | Proponer una cuenta que no existe en el plan |
| **Tax Agent** | Comprobante + reglas fiscales vigentes | Tratamiento de IVA/percepciones/retenciones | Inventar una alícuota |
| **Normative Research Agent** | Consulta + corpus normativo local | Normas candidatas con cita y nivel de verificación | Citar una norma que no está en `norm_documents` |
| **Reconciliation Agent** | Movimientos bancarios + asientos | Propuestas de matching con score | Confirmar una conciliación |
| **Financial Analysis Agent** | Estados y mayores | Explicaciones de variaciones, con cifras enlazadas | Afirmar sin cifra respaldada |
| **Notes Agent** | Estados + mayores + políticas | Borradores de notas con cada cifra referenciada a su linaje | Redactar una cifra sin `lineage_id` |
| **Audit Agent** | Logs + asientos + alertas | Hallazgos priorizados | Cerrar un hallazgo |

Todos escriben en `ai_predictions`. Ninguno escribe en otro lado.

---

## 4. Anti-alucinación (§30) — controles concretos

La instrucción "no alucines" no es un control. Estos sí:

| Control | Implementación |
|---------|----------------|
| **Salida cerrada** | El agente elige de un **enum de cuentas del plan real** de esa empresa. No escribe texto libre para la cuenta |
| **Citas verificadas** | Toda `normative_source` devuelta se resuelve contra `norm_versions`. Si el ID no existe → propuesta **rechazada automáticamente** y logueada como alucinación detectada |
| **Aritmética fuera del LLM** | El agente propone tratamiento; los importes los calcula el `tax-engine` y los suma el `accounting-engine`. El modelo nunca es responsable de un total |
| **Grounding obligatorio** | El `Contador IA` (§23) responde solo con resultados de consultas ejecutadas contra la base de la empresa. Sin filas → `NO HAY INFORMACIÓN SUFICIENTE` |
| **Abstención barata** | El costo de decir "no sé" es cero; el de equivocarse escala a revisión. Los prompts y las métricas premian la abstención |
| **Doble pasada en baja confianza** | Si la confianza < umbral, se re-consulta con contexto ampliado antes de bloquear |
| **Detección de deriva** | Tasa de rechazo humano por agente monitoreada; si sube, se degrada el umbral automático |

**Métrica de calidad principal: no es la exactitud, es la tasa de error no detectado.** Un agente
que acierta 99% y falla en silencio el 1% es peor que uno que acierta 90% y marca el 10% restante.

---

## 5. Sistema de confianza (§13)

| Nivel | Umbral | Comportamiento |
|-------|--------|----------------|
| 🟢 **ALTA** | ≥ `auto_threshold` (configurable por empresa y agente) | Se propone para aprobación en lote. **Sigue requiriendo aprobación humana** |
| 🟡 **MEDIA** | entre umbrales | Revisión individual obligatoria |
| 🔴 **BAJA** | < `review_threshold`, o cualquier disparador duro | **Bloqueado.** Intervención profesional |

Disparadores duros que fuerzan 🔴 sin importar el score del modelo:

- `FUENTE NO ENCONTRADA` o `CONFLICTO NORMATIVO` del `normative-engine`
- Cita normativa no resoluble
- Proveedor nuevo, o marcado como apócrifo por `wsapoc`
- Constatación fiscal fallida en ARCA
- Importe fuera del rango histórico de la cuenta/proveedor (outlier estadístico)
- Período próximo a cierre
- Cuenta que nunca fue usada por esa empresa
- Operación en moneda extranjera sin cotización de fuente declarada

La confianza declarada por el modelo es **una señal entre varias**, no la decisión.

---

## 6. Aprendizaje por empresa (§14) — y su límite

Qué puede aprender: correlación `(proveedor, descripción, actividad) → cuenta` a partir de
decisiones **aprobadas** por el contador, acumuladas en `classification_preferences`.

Qué **no** puede tocar, por diseño estructural:

```
classification_preferences  ──✗──►  accounting_rules
classification_preferences  ──✗──►  tax_rules
classification_preferences  ──✗──►  norm_versions
```

No hay código que escriba de una a otra. El aprendizaje mueve la **sugerencia** y la **confianza**;
la norma es inmune. Si 100 veces el contador clasificó mal, el sistema aprenderá a sugerir mal —
pero jamás dirá que la norma dice otra cosa.

Además: el aprendizaje es **por empresa**. No se comparte entre clientes del estudio (secreto
profesional), salvo consentimiento explícito y anonimización, que hoy **no está en alcance**.

---

## 7. El asistente `Contador IA` (§23)

Arquitectura de recuperación, no de memoria:

```
Pregunta → planner → consultas SQL parametrizadas sobre la empresa activa (RLS)
        → resultados → redacción con cifras enlazadas al linaje → respuesta
```

- Nunca genera SQL libre: elige entre **consultas registradas y revisadas**, con parámetros.
- Cada número de la respuesta es un enlace navegable al asiento/comprobante que lo compone.
- Si las consultas no devuelven datos suficientes: `NO HAY INFORMACIÓN SUFICIENTE`. Sin adornos.
- No responde preguntas de asesoramiento normativo con criterio propio: deriva a la cita del
  `normative-engine` o declara el gap.

---

## 8. Privacidad y datos

- Los documentos contables de un estudio son **secreto profesional**. El adaptador de proveedor
  debe permitir: región de procesamiento, no-retención, y despliegue on-prem del OCR.
- Toda salida hacia un proveedor externo se registra en `audit_logs` con `actor_type = AI`,
  agente, modelo y hash del prompt: el estudio puede demostrar exactamente qué se envió y cuándo.
- Configuración por organización para deshabilitar por completo el envío externo (modo
  determinístico puro: el sistema funciona, sin sugerencias).

---

## 9. Regla de responsabilidad (§42)

La UI nunca presenta una salida de IA como asesoramiento profesional. Etiquetado obligatorio en
todo elemento generado por IA:

```
⚙ Sugerencia generada automáticamente · confianza 96% · requiere aprobación profesional
   [ver regla]  [ver fuente]  [ver documento]
```

Y en los estados contables: ninguna cifra emitida lleva marca de IA, porque **ninguna cifra emitida
proviene de la IA sin aprobación humana previa**. Esa es la promesa que sostiene el producto.
