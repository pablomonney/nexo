# FASE 1 — NEXO Intelligence desde Cero: estructura definitiva

Auditoría integral de los 23 puntos pedidos, corrección de lo corregible,
y cierre de la estructura antes de escribir un solo guion de producción.
No se tocó código, no se tocó producción, no se hizo commit.

## 1. Qué cambia respecto a la estructura anterior (`02-auditoria-31-videos.md`)

### 1.1 · Títulos: de descriptivos a literales

Ningún video se llama ya "Video 03" ni lleva un título que describa el
video en vez de nombrar lo que se ve. Regla aplicada uno por uno: **el
título es el nombre de la pantalla, la acción o el concepto que el
alumno va a ver en cámara** — nunca "Introducción a…", "Módulo…" ni
"Capítulo…". La numeración interna se conserva solo para ordenar, no es
parte del título visible.

### 1.2 · Fusión de "Asientos: propuesta y borrador" + "Aprobar y Mayor"

**Corregido, no marcado como decisión pendiente** — está directamente
autorizado por el punto 18 del brief ("repeticiones innecesarias") y el
punto 17 ("duración y densidad"). Los antiguos V15 y V16 mostraban el
mismo hecho —el mismo asiento, `01a0c725-bc0d-7eea-944c-8cd1cf0fe3be`—
partido en dos videos sin necesidad: ver la propuesta, cargarla, y
aprobarla es una sola acción continua de menos de 5 minutos en la
consola real. Se fusionan en **un solo video: "Asientos"**. El video
"Diario y Mayor" (más adelante en el curso) ya no repite el mismo
recorrido desde cero: arranca reconociendo que el alumno ya vio aparecer
un asiento en el Mayor, y enseña a **leerlo como herramienta**, no a
volver a generarlo.

### 1.3 · División de "Diario, Mayor y Balance" en dos videos

El antiguo V21 mezclaba tres libros bajo un solo título genérico. Como el
Balance es un concepto propio (verificación de que Debe = Haber, con sus
propias filas y su propio botón «Balance»), se separa: **"Diario y
Mayor"** por un lado, **"Balance"** por otro — cada uno con su nombre
literal.

### 1.4 · Corrección de contenido verificada contra el código real

Al revisar el recorrido exacto de cada pantalla contra `consola.html`
(no contra lo que decía la documentación anterior), encontré que el
guion de **"Caja, bancos y cheques"** (antes V13) **saltaba un paso
real**: decía "Abrir caja → monto inicial → confirmar", pero la pantalla
real exige primero **"Dar de alta una caja"** (código, nombre, cuenta
contable opcional → «Crear») y recién después **"Abrir una caja"**
(elegir la caja, fecha, saldo inicial → «Abrir»). Sin el alta previa, el
selector de "Abrir una caja" está vacío y el grabador se hubiera visto
obligado a improvisar en cámara — exactamente el punto 23 del checklist.
Corregido en el guion nuevo (sección de Fase 2).

### 1.5 · Terminología unificada

"Empresa demo", "dataset del curso" y "fixture" se usan de forma
intercambiable en los documentos anteriores. En los guiones nuevos se
usa un solo término: **"la empresa del curso"**, para que el hablado sea
natural y no técnico.

## 2. Verificación contra el estado real de NEXO

Antes de escribir un solo guion, se releyó el HTML real de las pantallas
que iban a aparecer (no se asumió nada de la documentación anterior):

| Pantalla | Verificado contra | Resultado |
|---|---|---|
| Caja | `apps/web/consola.html`, sección `v-caja` completa | Corrección real encontrada (§1.4) |
| Bancos | sección `v-bancos` | Confirma alta de cuenta; conciliación existe pero no se enseña en este video (ver §4) |
| Cheques | sección `v-cheques` | Confirma "Cargar un cheque" → «Cargar» |
| Ventas (Comercial) | botón `b-com-facturar` | Confirma «Registrar la operación fiscal» |
| Preguntar | botones `b-intel-panorama`, `b-intel-riesgos` | Confirma «Ver el panorama» / «Ver los riesgos» |
| Señales | botones `b-sen-aplicado`, `b-sen-resultado` | Confirma «Declarar aplicado» / «Ver el resultado» |
| Asientos (propuesta→borrador) | botones `b-prop`, `b-prop-cargar` | Confirma «Ver la propuesta» / «Cargar como asiento en borrador» |
| Solicitudes de compra | botones `b-sol-alta`, `b-sol-enviar`, `b-sol-aprobar` | Confirma «Crear la solicitud» / «Enviar a aprobar» / «Aprobar» |
| Recepciones | botón `b-rec-alta` | Confirma «Crear en borrador» |
| Cuentas | botón en `cta-alta` | Confirma «Dar de alta una cuenta» |

El resto de las pantallas (Documentos, Mapeo contable, Terceros,
Productos, Períodos y cierre, Bienes de uso, IVA, Libros, Estados,
Auditoría, Migraciones, Plan) ya habían sido verificadas botón por botón
en sesiones anteriores de este mismo proyecto (auditoría integral,
verificación E2E de producción, y la auditoría de 31 videos) — no se
repitió esa lectura porque no hubo ningún cambio de código entre
sesiones que la pudiera haber invalidado.

## 3. Consistencia y afirmaciones no demostrables

Se revisaron los 31 videos anteriores buscando afirmaciones que no
pudieran demostrarse hoy en NEXO. Se confirma lo ya sabido de sesiones
previas (nada nuevo apareció):

- **Propuestas de IA con confianza alta**: `accounting_rules` sigue
  vacía. El guion nuevo de ese video ya no promete mostrar ese camino —
  lo nombra y explica por qué no ocurre, en vez de simularlo.
- **"Preguntar" como asistente conversacional**: sigue siendo un
  catálogo cerrado de preguntas, no un chat libre. El guion lo aclara
  antes de mostrar la pantalla, para no generar una expectativa que la
  demostración no puede cumplir.

## 3.1 · Corrección post-ensayo de grabación (2026-09-24)

Al ensayar la grabación real del video 01 contra una instancia local de
NEXO, con una cuenta nueva de verdad (registro real, código de
confirmación leído desde `email_outbox`, sin inventar nada), encontré
que el guion tenía un error de secuencia que ninguna revisión documental
anterior había detectado: la configuración del segundo factor **no**
ocurre justo después del login, como decía el guion — ocurre recién
**después de crear la empresa**, porque es el rol ADMINISTRADOR el que
la exige, y una cuenta sin empresa todavía no tiene ningún rol.

Corregido en `14-guiones-definitivos.md`: el segmento de MFA se movió
del video 01 al video 02. Los títulos y el objetivo general de ambos
videos no cambian — solo el punto exacto donde ocurre cada paso.

## 4. DECISIONES PENDIENTES

Ninguna decisión pendiente detiene el resto del trabajo — se siguió con
todo lo demás.

### DECISIÓN PENDIENTE 1 — Conciliación bancaria, ¿video propio?

**Problema:** la pantalla de Bancos tiene una conciliación completa
(mapeos de extracto, importar, proponer, abrir por período) que no
tiene video propio en la estructura de 31. Hoy queda mencionada de
pasada en "Caja, bancos y cheques", sin demostrarse.
**Alternativas:** (a) dejarla mencionada, sin video propio, como está
ahora; (b) agregar un video nuevo "Conciliación bancaria" en el Nivel 5.
**Qué parte del curso afecta:** el conteo total de videos (pasaría de 31
a 32) y el Nivel 5 (Gestión/Reportes).
**Qué recomiendo revisar:** si la conciliación es algo que un cliente
nuevo necesita ver en las primeras semanas, o si es un tema de mes 2-3
que puede esperar a una segunda tanda de videos.

### DECISIÓN PENDIENTE 2 — Las otras 5 decisiones ya registradas

Las decisiones 1, 2, 3, 4, 5 y 6 de la sesión anterior (`10-master-plan.md`
§19: nombre de playlist, grabar o esperar el gap del plan de cuentas,
separar Precios, dataset definitivo, autorizar la corrección de código,
orden manual-vs-guiones) **siguen exactamente igual**, sin resolver.
No se repiten acá en detalle — ya están documentadas con los 12 campos
pedidos en el informe de la sesión anterior. Se listan solo para que no
se pierdan de vista en este cierre.

## 5. Estructura definitiva — 31 videos

| # | Título | Nivel | Fusión/cambio respecto a la versión anterior |
|---|---|---|---|
| 01 | Crear tu cuenta | Conocer NEXO | — |
| 02 | Crear una empresa | Conocer NEXO | — |
| 03 | Pendientes | Conocer NEXO | — |
| 04 | Mapeo contable | Configuración | — |
| 05 | Terceros | Configuración | — |
| 06 | Productos | Configuración | — |
| 07 | Usuarios y permisos | Configuración | — |
| 08 | Certificado ARCA | Configuración | — |
| 09 | Documentos | Operación | — |
| 10 | Comprobantes | Operación | — |
| 11 | Ventas | Operación | — |
| 12 | Compras | Operación | — |
| 13 | Caja, bancos y cheques | Operación | Guion corregido (§1.4) |
| 14 | Existencias | Operación | — |
| 15 | Asientos | Contabilidad | **Fusión** de "Asientos: propuesta y borrador" + "Aprobar y Mayor" |
| 16 | Asientos manuales y contraasientos | Contabilidad | — |
| 17 | Períodos y cierre de ejercicio | Contabilidad | — |
| 18 | Bienes de uso | Contabilidad | — |
| 19 | Costo de lo vendido y valuación de existencias | Contabilidad | — |
| 20 | Diario y Mayor | Reportes | **Dividido** de "Diario, Mayor y Balance"; ya no repite el recorrido de #15 |
| 21 | Balance | Reportes | **Dividido** de "Diario, Mayor y Balance" |
| 22 | Subdiarios de IVA | Reportes | — |
| 23 | Estados contables | Reportes | — |
| 24 | Auditoría y exportaciones | Reportes | — |
| 25 | Preguntar: Panorama y riesgos | Intelligence | — |
| 26 | Señales y escenarios | Intelligence | — |
| 27 | Propuestas de IA | Intelligence | Guion ajustado (§3) |
| 28 | Proyectos, sucursales y comisiones | Gestión | — |
| 29 | Integraciones y migración | Gestión | — |
| 30 | Plan y suscripción | Gestión | — |
| 31 | Circuito completo: de un documento a un balance | Cierre | — |

**31 videos** (30 de la lista anterior, menos 1 por la fusión #15, más 1
por la división #20/#21 — el conteo total no cambia, la composición sí).

## 6. FASE 1B — Control final

Verificación explícita de los 10 puntos pedidos, contra la tabla de
arriba y contra los guiones de la sección de Fase 2:

| Verificación | Resultado |
|---|---|
| El índice coincide con los capítulos reales | Sí — la tabla de §5 es el índice único; no hay otro índice en paralelo |
| Cada capítulo tiene un objetivo claro | Sí — cada guion de Fase 2 declara un objetivo en una frase |
| Cada guion corresponde con pantallas que existen | Sí — verificado botón por botón donde había duda (§2); heredado de verificaciones previas donde no |
| Las demostraciones son ejecutables | Sí, con una salvedad: los videos que dependen de dataset con datos ya cargados (Nivel 5 en adelante) requieren que el dataset se prepare **antes** de grabar, en el orden del curso — no son ejecutables en una empresa recién creada de un salto |
| No hay funcionalidades inventadas | Confirmado — ninguna pantalla ni botón citado en Fase 2 es hipotético |
| No hay información contradictoria | Corregida la única contradicción real encontrada (§1.4) |
| No hay capítulos duplicados | Corregida la única duplicación real (§1.2) |
| No faltan conceptos necesarios | Los ocho conceptos básicos (ejercicio, período, cuenta imputable, mapeo, comprobante, asiento, Debe/Haber, Mayor) siguen cubiertos en el video 02 y reforzados en el 15 — no se agregó ni sacó ninguno |
| El orden tiene sentido para alguien que empieza desde cero | Sí — mismo orden pedagógico ya validado en `03-orden-pedagogico.md`, con los ajustes de §1.2/§1.3 |
| El curso puede grabarse sin improvisar decisiones estructurales | Sí, con la salvedad de la Decisión Pendiente 1 (conciliación bancaria) — no afecta a ningún video de los 31 ya definidos |

**Fase 1 cerrada.** Se pasa a Fase 2.

---

**Nota de estado (2026-09-30):** esta tabla define la estructura y los
títulos — no el estado de producción de cada video (eso no era su
objetivo ni lo fue nunca). El estado real, video por video —cuáles tienen
video final, cuáles solo guion verificado, cuáles están saltados— está en
[`16-matriz-de-produccion.md`](16-matriz-de-produccion.md).
