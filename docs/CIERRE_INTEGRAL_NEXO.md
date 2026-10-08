# Cierre integral de NEXO — 2026-10-01

Informe ejecutivo de esta sesión de trabajo autónomo. Es un resumen: la
evidencia completa, ítem por ítem, vive en
[`BACKLOG_INTERFAZ_PENDIENTE.md`](BACKLOG_INTERFAZ_PENDIENTE.md) (los 19 gaps
de interfaz) y [`FINAL_NEXO_STATUS.md`](FINAL_NEXO_STATUS.md) (el registro de
trabajo, con los bugs encontrados y corregidos). Este documento no repite esa
evidencia — la indexa.

> **CORRECCIÓN 2026-10-05 — leer primero.** Este informe decía que los 8
> defectos de la tabla B estaban corregidos. **No es así para los #3, #4 y
> #5 (los de fechas): NO están corregidos en producción.** Su arreglo
> consulta `CURRENT_DATE` a PostgreSQL y asume que la base está en hora
> argentina; la base de producción está en **UTC** (confirmado en el servidor
> el 2026-10-05), así que sigue devolviendo la fecha de mañana entre las
> 21:00 y las 24:00 ART. Los tests pasaban porque la base de desarrollo está
> en `America/Buenos_Aires`. Los otros 5 defectos (#1, #2, #6, #7, #8) sí
> están corregidos. El despliegue `b412b9e` **es correcto**: este es un
> defecto funcional pendiente, no un fallo del despliegue. Ver la sección I
> y `docs/PLAN_ZONA_HORARIA.md`.

> **NEXO no está listo para habilitar clientes solo porque esta sesión cierre
> en verde.** Lo que sí se puede decir con evidencia real: el backlog de
> interfaz que bloqueaba operar ciertos flujos desde la consola se cerró casi
> entero, se encontraron 8 defectos reales (5 corregidos con prueba de
> regresión; 3 de fechas pendientes, ver arriba), y la suite completa (197
> archivos, 3056 pruebas) pasa. Lo que
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

## B. Qué se encontró (8 defectos reales: 5 corregidos, 3 de fechas NO corregidos en producción)

| # | Defecto | Impacto real |
|---|---|---|
| 1 | `GET /vat/credito-fiscal/:txId` — 500 siempre | Cualquier evaluación de crédito fiscal de una compra fallaba, el 100% de las veces |
| 2 | `POST /banks/.../reconciliations/propose` — 500 ante cualquier ambigüedad real | El caso normal de un movimiento con dos candidatos empatados rompía la conciliación |
| 3 | **NO CORREGIDO EN PRODUCCIÓN** — Prueba gratuita con fecha de inicio adelantada un día | Después de las 21h ART, toda empresa nueva (el fix usa `CURRENT_DATE`; producción está en UTC) |
| 4 | **NO CORREGIDO EN PRODUCCIÓN** — Pregunta por mes sin año resolvía año equivocado | Cerca de un fin de año/mes, después de las 21h ART (mismo motivo) |
| 5 | **NO CORREGIDO EN PRODUCCIÓN** — "Cómo voy este mes" consultaba el mes equivocado | Después de las 21h ART, cualquier consulta al panorama (mismo motivo) |
| 6 | Confirmar dos veces la misma coincidencia bancaria daba 500 crudo | Cualquier reintento sobre una coincidencia ya confirmada |
| 7 | Doble clic podía duplicar un movimiento de caja | Sin guardia de ningún tipo hasta hoy |
| 8 | Doble clic podía duplicar un movimiento de stock | Sin guardia de ningún tipo hasta hoy |

Detalle completo, causa raíz y el test que prueba cada uno:
[`FINAL_NEXO_STATUS.md`](FINAL_NEXO_STATUS.md#bugs-corregidos-con-test-de-regresión).

También se extendió el control S-37 (fechas en UTC) para que mire
`apps/api/src` y `packages/*/src`, no solo `scripts/`. **Límite que se
descubrió después (2026-10-05):** S-37 solo lee el código TypeScript. No ve que
`CURRENT_DATE` dependa de la zona de la sesión de PostgreSQL, y tampoco
detecta `toISOString().slice(0, 7)` ni `getUTCFullYear`.

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
- **Salvedad (2026-10-05):** la prueba de los bugs #3, #4 y #5 corrió contra una
  base local en `America/Buenos_Aires`, que no es la zona de producción (UTC);
  por eso pasaba sin que el defecto estuviera corregido allá.
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
  movimiento financiero real. **Cinco están corregidos en producción desde
  `b412b9e`. Los tres de fechas (#3, #4, #5) siguen presentes** porque la
  base de producción está en UTC (ver sección I).
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

- **Actualizado 2026-10-05:** el trabajo se commiteó en dos commits sobre
  `main` — `9fc4652` (16 pantallas, 8 defectos, informes) y `b412b9e`
  (alta de personas en el estudio, manual de Pendientes, curso, scripts de
  reseteo) — y se desplegó `b412b9e` a producción.
- Sin conflictos. Sin ninguna migración de base de datos en esos commits.

## I. Corrección del 2026-10-05 — los defectos de fechas #3, #4 y #5

- **Estado del despliegue:** `b412b9e` quedó correctamente desplegado
  (`/health` y `/health/db` responden `version: b412b9e`, 130 migraciones,
  RLS correcto, contenedores healthy). **Esto no es un fallo del despliegue:**
  es un defecto funcional pendiente.
- **Qué pasó:** los tres arreglos reemplazaron una fecha calculada en
  JavaScript (UTC) por `SELECT CURRENT_DATE`, asumiendo que la base está en
  hora argentina. Producción devuelve `UTC` (`SHOW timezone`, confirmado el
  2026-10-05), así que `CURRENT_DATE` entre las 21:00 y las 24:00 ART sigue
  siendo la fecha de mañana. No hay ninguna configuración de zona en el
  repositorio; la base local de desarrollo sí está en `America/Buenos_Aires`,
  y eso enmascaró el defecto en las pruebas.
- **Qué sigue ocurriendo hoy en producción** (solo entre las 21:00 y las
  24:00 ART): la prueba gratuita nueva arranca un día adelantada; "cómo voy
  este mes" y el panorama pueden consultar el mes siguiente a fin de mes;
  la pregunta por un mes sin año puede resolver el año equivocado en
  diciembre/enero; la cuota diaria de IA se reinicia a las 21:00.
- **Por qué no se resuelve cambiando la zona de PostgreSQL:** el hash de la
  cadena de auditoría incluye `occurred_at::text`, que depende de la zona de
  la sesión. Cambiarla haría que `audit:cadena` reporte rota la cadena de
  todo el historial. Se verificó con el mismo instante: hash `23acd960…`
  en UTC y `a6b17a0c…` en hora argentina.
- **Solución propuesta:** ver `docs/PLAN_ZONA_HORARIA.md` (commits `6b20f86`, `ddd8d58` y `e1b9007` en el remoto, sin deploy).
- **Ampliación del 2026-10-07:** Auditoría integral del 2026-10-07 (`docs/AUDITORIA_ZONA_HORARIA.md`): la misma clase de defecto apareció además en la **interfaz** (fecha por defecto de un asiento, período «actual» del inicio, normativa «vigente hoy», el ejercicio propuesto durante todo el día del cierre y seis campos `timestamptz` mostrados con el día de UTC), en el motor de auditoría (`asientosTardios`) y en una brecha de las funciones de hash (`DateStyle`, migración 0132). Todo está corregido en el árbol local, **sin commitear ni desplegar**: en producción siguen presentes.
- **Otros restos de UTC detectados y no corregidos:**
  `apps/api/src/intelligence/catalogo.ts:617`,
  `packages/document-engine/src/parsers/fecha.ts:154`.
