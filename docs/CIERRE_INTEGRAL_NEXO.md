# Cierre integral de NEXO — 2026-10-01

Informe ejecutivo de esta sesión de trabajo autónomo. Es un resumen: la
evidencia completa, ítem por ítem, vive en
[`BACKLOG_INTERFAZ_PENDIENTE.md`](BACKLOG_INTERFAZ_PENDIENTE.md) (los 19 gaps
de interfaz) y [`FINAL_NEXO_STATUS.md`](FINAL_NEXO_STATUS.md) (el registro de
trabajo, con los bugs encontrados y corregidos). Este documento no repite esa
evidencia — la indexa.

> **NEXO no está listo para habilitar clientes solo porque esta sesión cierre
> en verde.** Lo que sí se puede decir con evidencia real: el backlog de
> interfaz que bloqueaba operar ciertos flujos desde la consola se cerró casi
> entero, se encontraron y corrigieron 8 defectos reales con prueba de
> regresión, y la suite completa (197 archivos, 3056 pruebas) pasa. Lo que
> **no** se puede decir: que las pantallas nuevas se vean bien (el navegador
> siguió desconectado toda la sesión), que la infraestructura de producción
> cambió de estado (el acceso SSH sigue denegado), ni que el curso avanzó.

---

## A. Qué se investigó

1. Los 19 ítems del backlog de interfaz (`capacidades-con-puerta.test.ts`),
   uno por uno, releyendo el backend real de cada uno — no el documento
   anterior.
2. El backend completo en busca de la misma clase de defecto que apareció al
   leer el primero (un `Money` sin convertir antes de responder): barrido
   dedicado de `apps/api/src/routes/*.ts`.
3. Duplicación de operaciones por doble clic o reintento en las escrituras de
   mayor riesgo (caja, stock, asientos, pagos, conciliación bancaria,
   emisión fiscal).
4. Manejo de fecha/huso horario fuera de `scripts/` (el control existente
   solo cubría ahí).
5. El estado real de la pantalla de cierre de ejercicio, porque un documento
   del repositorio decía que faltaba y era falso.
6. La guía de onboarding ya verificada en producción (pasos 1 a 12): se
   releyó para confirmar que nada de lo tocado hoy la afecta. No hizo falta
   repetirla — sigue siendo evidencia válida y vigente.

## B. Qué se corrigió (8 defectos reales, todos con prueba de regresión)

| # | Defecto | Impacto real |
|---|---|---|
| 1 | `GET /vat/credito-fiscal/:txId` — 500 siempre | Cualquier evaluación de crédito fiscal de una compra fallaba, el 100% de las veces |
| 2 | `POST /banks/.../reconciliations/propose` — 500 ante cualquier ambigüedad real | El caso normal de un movimiento con dos candidatos empatados rompía la conciliación |
| 3 | Prueba gratuita con fecha de inicio adelantada un día | Después de las 21h ART, toda empresa nueva |
| 4 | Pregunta por mes sin año resolvía año equivocado | Cerca de un fin de año/mes, después de las 21h ART |
| 5 | "Cómo voy este mes" consultaba el mes equivocado | Después de las 21h ART, cualquier consulta al panorama |
| 6 | Confirmar dos veces la misma coincidencia bancaria daba 500 crudo | Cualquier reintento sobre una coincidencia ya confirmada |
| 7 | Doble clic podía duplicar un movimiento de caja | Sin guardia de ningún tipo hasta hoy |
| 8 | Doble clic podía duplicar un movimiento de stock | Sin guardia de ningún tipo hasta hoy |

Detalle completo, causa raíz y el test que prueba cada uno:
[`FINAL_NEXO_STATUS.md`](FINAL_NEXO_STATUS.md#bugs-corregidos-con-test-de-regresión).

También se extendió el control S-37 (fechas en UTC) para que mire
`apps/api/src` y `packages/*/src`, no solo `scripts/` — así una cuarta
instancia del defecto #3/#4/#5 no vuelva a pasar inadvertida.

## C. Qué se implementó (16 de 19 gaps de interfaz)

Pantallas/botones nuevos para: desimputar cobros y pagos; ver y anular
correcciones de comprobantes; editar un vendedor; trazar un renglón de estado
contable (para el caso alcanzable); trazar una conciliación bancaria (para el
caso alcanzable); evaluar crédito fiscal IVA; ver y editar los renglones de
un comprobante; vincular un comprobante a un tercero; corregir una decisión
de afectación; lista de precios y roles de un tercero; movimientos
facturados de un producto; editar etapas del CRM; editar renglones de
órdenes de pago y solicitudes de compra en borrador.

**Tres quedan sin implementar, correctamente:** uno porque ya tiene una
alternativa real y usada (cargar el asiento a mano); dos porque dependen de
una cuenta de un proveedor de IA real o de una decisión de producto sobre
facturación parcial — ninguno de los dos se resuelve con código.

Detalle, evidencia de cierre y por qué cada uno quedó así:
[`BACKLOG_INTERFAZ_PENDIENTE.md`](BACKLOG_INTERFAZ_PENDIENTE.md).

## D. Pruebas que corrieron, y resultado

- `npm run typecheck`: verde.
- `npm run lint`: verde.
- `npx vitest run` (suite completa): **197 archivos, 3056 pruebas, todas
  verdes** — incluye seguridad multiempresa, aislamiento, integración
  end-to-end, y los 4 archivos de test nuevos de esta sesión.
- Cada bug de la tabla B se probó dos veces: contra el código con el defecto
  (falla, reproduciendo el síntoma real) y contra el código corregido
  (pasa) — no se declaró ningún arreglo sin esa comprobación.

## E. Lo que sigue pendiente, y por qué

**Bloqueado por algo que no cambió esta sesión, no por falta de trabajo:**

- **Navegador (Claude-in-Chrome) desconectado toda la sesión.** Ninguna de
  las 16 pantallas nuevas tiene confirmación visual. Las 15 capturas
  pendientes del curso (videos 14, 15, 16, 18, 31, 06 con narración y audio
  ya listos) siguen sin poder filmarse.
- **Acceso SSH a producción denegado por el sandbox** (categoría
  "Production Reads"), sin reintentar por instrucción del propio sistema.
  No se pudo re-verificar el estado real del servidor, de Resend, ni de los
  backups desde esta sesión — lo que ya se sabía de sesiones anteriores
  (producción viva y respondiendo por HTTPS pública, confirmado sin SSH)
  sigue siendo lo último verificado.
- **IA real y facturación parcial**, sin cuenta de proveedor ni decisión de
  producto respectivamente — ver ítems 12 y 13 del backlog.

**Sin una solución limpia disponible, documentado y no forzado:**

- El riesgo de duplicar un movimiento de caja o de stock por un **reintento
  de red** (no un doble clic) sigue abierto. Cerrarlo del todo pide una
  clave de idempotencia de punta a punta — una decisión de arquitectura, no
  un bug fix.
- Trazar un renglón de estado contable **ya emitido**, o una coincidencia
  bancaria confirmada en **otra sesión**, necesitan un endpoint que hoy no
  existe (listar lo persistido con su id).
- Reordenar etapas del CRM: el backend no lo soporta.

## F. Riesgos que no deben ignorarse

Ninguno de los riesgos reales encontrados hoy queda sin mitigar al nivel que
el código permite:

- Los 8 bugs de la tabla B estaban **en producción** hasta esta sesión (no
  son hipótesis): dos rompían una ruta siempre, tres daban una fecha
  incorrecta en una ventana horaria real y diaria (después de las 21h
  Argentina), uno daba un error confuso, y dos podían duplicar un
  movimiento financiero real.
- Lo que sigue en pie: el reintento de red en caja/stock (arriba), y que
  nada de lo nuevo tiene confirmación visual.

## G. Próximos cinco pasos, en orden

1. **Reconectar el navegador** (el usuario, desde su lado) — destraba la
   verificación visual de las 16 pantallas y las 6 capturas de curso
   pendientes. Sin esto, ningún paso siguiente de UI se puede cerrar con
   evidencia completa.
2. **Revisar y mergear estos cambios** (trabajo de equipo) — 12 archivos de
   producto modificados, 4 archivos de test nuevos, ninguna migración, cero
   commits hechos por esta sesión.
3. **Decidir** si se resuelve la clave de idempotencia para caja/stock ahora
   o se acepta el riesgo documentado (founder/equipo técnico).
4. **Decidir** los dos bloqueos de producto que quedan (IA real, facturación
   parcial) cuando haya cuenta o criterio (founder).
5. **Retomar el curso** una vez reconectado el navegador: 6 videos con
   narración y audio listos, solo falta la captura.

## H. Estado de git

- Rama: `main`. Sin commits hechos por esta sesión (ninguno pedido).
- Working tree: cambios sin commitear en 12 archivos de producto/test y 2
  documentos históricos con una nota agregada (no reescritos); 6 archivos
  nuevos sin trackear (2 documentos, 2 scripts de sesiones anteriores sin
  tocar hoy, 2 tests de integración nuevos).
- Sin conflictos. Sin ninguna migración de base de datos.
