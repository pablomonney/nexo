# Fase 6 — "NO GRABAR TODAVÍA"

Lista explícita de funcionalidades que no deberían enseñarse en un curso
público de YouTube en su estado actual, con motivo, evidencia y qué
tendría que pasar antes.

| Funcionalidad | Motivo | Evidencia | Qué tendría que ocurrir antes |
|---|---|---|---|
| Emitir factura con CAE | Cerrado a propósito, no es un bug | `EMISION_HABILITADA=false` (matriz, sección 10) | Decisión de producto de habilitarlo — no es una corrección, es una decisión de Pablo |
| Retenciones | Sin implementar | Matriz: "Falta decidir qué regímenes" | Decisión de producto + implementación |
| Libro IVA Digital | Bloqueado por tercero | Matriz: "Diseños de registro sin publicar" | ARCA publique el diseño de registro |
| Propuestas de IA con confianza alta | Nunca ocurre en la práctica hoy | `accounting_rules` vacía → todo cae en revisión profesional (matriz, sección 11) | Cargar reglas contables reales y activarlas — trabajo de producto, no de curso |
| "Preguntar" como IA generativa | Es un catálogo cerrado de preguntas, no un chat libre | `AI_PROVIDER=none` por defecto (matriz) | Decisión de producto: contratar/configurar un proveedor de modelo |
| Recuperar contraseña | No existe flujo en la UI | Matriz, sección 1: "No existe flujo desde la UI" | Implementarlo — fuera de esta sesión |
| Regenerar códigos de recuperación de MFA | No existe flujo en la UI | Matriz, sección 1 | Implementarlo — fuera de esta sesión |
| Conectar medio de pago (suscripción) | Sin pasarela contratada | Matriz, sección 12 | Contratar la pasarela — decisión comercial |
| Fijar umbrales de confianza por empresa | Tabla sin endpoint | Matriz, sección 11 | Exponer el endpoint |
| Las 17 filas "NO EXPUESTO EN CONSOLA" | No hay una sola pantalla que mostrar | Control S-25, matriz completa | Construir la pantalla, si se decide que corresponde |
| Plan de cuentas al entrar a Configuración por el menú | Aparece vacío la primera vez (§05 de este proyecto) | Lectura de `cargarConfig()` línea 12796 | Un clic en "Buscar" lo resuelve — **grabable si el guion incluye ese clic como parte del flujo normal**, no oculta el defecto |
| Doble clic en botones de acción | Solo 1 de ~150 botones se autodesactiva mientras el pedido está en vuelo | Auditoría integral 2026-09-21 | Patrón general de `disabled` — trabajo de producto, documentado y no ejecutado a propósito |

## Restricciones de mecánica de grabación / demo

*(Reclasificado el 2026-09-23 — no pertenece a la tabla de arriba: no es
que NEXO le falte madurez, es que la acción es irreversible en el dataset
de grabación y por eso exige una precaución de producción, no una espera
de producto.)*

| Acción | Por qué es una restricción de grabación, no de producto | Qué hacer al grabar |
|---|---|---|
| Reabrir un período ya cerrado | El cierre de período es correcto y funciona como debe — la reapertura existe y pide **contrafirma de otra persona** a propósito (norma de doble control). Lo que no existe es una forma de "deshacer" un cierre sobre el mismo dataset de grabación para repetir la toma | No cerrar el período de la empresa demo hasta tener la toma final aceptada. Si hace falta regrabar, usar una copia nueva del dataset (`npm run factura:demo` vuelve a generar una empresa desde cero), no la misma empresa ya cerrada |

Esta reclasificación **no cambia la conclusión**: sigue sin grabarse un
segundo intento de cierre sobre la misma empresa demo. Solo separa el
motivo — mecánica de grabación, no inmadurez de NEXO — para que quien lea
esta tabla no interprete que el cierre de ejercicio es una función a
medio terminar.

## Funciones con documentación contradictoria (ya resueltas, mencionadas por trazabilidad)

Estas **ya se corrigieron** en la sesión anterior (commits `7dde83c` /
`39eec2c`) — se listan para que quien grabe sepa que si ve una versión vieja
de la documentación, está desactualizada:

- Permiso `journal_entry:write` → corregido a `journal_entry:create` en
  código y en los 4 documentos que lo citaban.
- 18 entidades de Pendientes sin ruta desde "abrir" → las 33 tienen ruta
  real hoy.
- Afirmaciones de "todavía no se ejecutó en producción" sobre el tramo
  documento→Mayor → corregidas con evidencia real del 2026-09-22.
