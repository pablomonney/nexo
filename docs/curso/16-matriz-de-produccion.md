# Fase 16 — Matriz maestra de producción

2026-09-30, segunda pasada (consistencia). Esta es la **única fuente de
verdad** sobre el estado del curso — los demás documentos (`10`, `13`,
`14`, `15`) apuntan acá y no deben contradecirla. No se modificó código,
no se hizo ningún commit, no se abrió ningún período, no se creó ninguna
empresa, no se produjo ningún video en esta tarea — es exclusivamente
consistencia documental y una comparación de opciones, sin ejecutar
ninguna.

## Corrección respecto a la versión anterior de este archivo

La versión anterior mezclaba dos preguntas distintas en una sola
etiqueta ("evidencia parcial" para el video 04, "9" videos listos cuando
solo se enumeraban 8) y clasificaba algunos videos por una suposición
("¿depende del período?") en vez de por el código. Las dos correcciones
de esta pasada:

1. **Dos ejes, no uno.** Cada video tiene un **ESTADO DEL VIDEO**
   (documental) y, si no es `VIDEO_FINAL` ni `SALTADO_NO_PRODUCIDO`, un
   **ESTADO DE PRODUCCIÓN** (operativo) — nunca los dos mezclados en una
   sola palabra.
2. **La dependencia del período se verificó en el código**, no se
   supuso — sección 3.

---

## 1. Los dos ejes de clasificación

### Eje 1 — ESTADO DEL VIDEO (uno y solo uno de 4)

- **`VIDEO_FINAL`** — existe un archivo de video terminado, con
  narración y ensamblado.
- **`GUION_VERIFICADO`** — el guion fue confirmado contra la aplicación
  real (código, API o pantalla en vivo), con evidencia documentada de
  esa ejecución. No tiene video final.
- **`EVIDENCIA_INSUFICIENTE`** — no hay registro de que el flujo
  narrado se haya ejecutado alguna vez contra la aplicación real (ni
  GIF, ni nota de corrección, ni confirmación explícita). El guion
  puede estar bien escrito; lo que falta es la prueba de que se corrió.
- **`SALTADO_NO_PRODUCIDO`** — excluido a propósito, con motivo real.

### Eje 2 — ESTADO DE PRODUCCIÓN (uno y solo uno de 4, **solo aplica a
los videos que no son `VIDEO_FINAL` ni `SALTADO_NO_PRODUCIDO`** — al
cierre de esta pasada son 14 de 31 [ver sección 2]; los que ya están
`VIDEO_FINAL` no necesitan esta pregunta, y los saltados están fuera
de la cola de producción por una decisión ya tomada, no por un problema
de entorno)

- **`LISTO_PARA_PRODUCIR`** — puede filmarse hoy mismo, sin ningún
  cambio de entorno, sin dato nuevo que conseguir primero.
- **`REQUIERE_PREPARACION`** — el flujo en sí no está bloqueado, pero
  la empresa actual ya "consumió" el dato que el guion necesita mostrar
  desde cero (un tercero que ya existe, un rol ya otorgado) — hace
  falta un dato nuevo, no un cambio de estado de la aplicación.
- **`REQUIERE_NUEVA_VERIFICACION`** — antes de poder clasificarlo con
  certeza, hace falta confirmar algo puntual contra la aplicación real
  (típicamente: videos `EVIDENCIA_INSUFICIENTE`, donde ni siquiera se
  sabe si el flujo corre limpio).
- **`BLOQUEADO`** — no se puede filmar en el entorno actual por una
  causa objetiva y verificada en el código (sección 3).

---

## 2. Conteo definitivo 01–31

### Por ESTADO DEL VIDEO

| Estado | Cantidad | Videos |
|---|---|---|
| `VIDEO_FINAL` | 17 | 01, 02, 03, 09, 10, 11, 12, 13, 20, 21, 22, 24, 25, 26, 28, 29, 30 |
| `GUION_VERIFICADO` | 9 | 06, 07, 08, 14, 15, 16, 17, 18, 31 |
| `EVIDENCIA_INSUFICIENTE` | 2 | 04, 05 |
| `SALTADO_NO_PRODUCIDO` | 3 | 19, 23, 27 |
| **Total** | **31** | |

17 + 9 + 2 + 3 = 31. Cierra exacto.

**Actualización 2026-10-01 (misión autónoma de cierre):** auditoría
determinística (ver `docs/curso/DECISION_TECNICA_VIDEOS_RESTANTES.md`)
encontró que 9 de los 12 videos restantes no dependían del ejercicio
cerrado — su dato real ya estaba posteado desde antes del cierre.
Videos 10, 11 y 12 pasaron a `VIDEO_FINAL` con el mismo pipeline,
mostrando el estado real ya existente (mismo método que 06/18/25/26/
28/29/30). Continúa con 14, 15, 16, 18, 31, 06, y luego 07/08
(preparación mínima) y 17 (Opción A, único bloqueo real).

**Actualización 2026-09-30 (tarde/noche):** piloto de video 09 aprobado
por el productor; se continuó con la producción audiovisual real de
13, 20, 21, 22 y 24 (lote en curso — 25, 26, 28, 29 y 30 quedan
pendientes de la misma pasada, ver más abajo). Los 5 pasaron a
`VIDEO_FINAL` con el mismo pipeline: **Piper TTS** (voz Daniela, es_AR)
+ capturas reales (navegador integrado de Claude) + ffmpeg, 890×444/
25fps/H.264+AAC. Detalle y evidencia completa en
`scratchpad/produccion/video{13,20,21,22,24}/`.

**Actualización 2026-10-01:** continuación y cierre del mismo lote.
Videos 29, 30, 25, 26 y 28 pasaron a `VIDEO_FINAL` con idéntico
pipeline. Video 30 tuvo una incidencia técnica real detectada y
corregida (ver
`scratchpad/produccion/video30/capturas/video30-VIDEO_FINAL-2026-10-01.txt`):
el ensamblado inicial dio ~2.15s de silencio de más porque `-shortest`
no cortó exacto el segmento 02 contra su WAV; se corrigió
`scratchpad/produccion/lib/crear_clip.sh` para forzar `-t <duración
real del audio>` en vez de depender solo de `-shortest`, y se
reconfirmó duración/silencio/volumen/frames tras la corrección. Los
videos 25, 26 y 28 (ya generados con el script corregido) no
presentaron esa ni ninguna otra incidencia. Con esto se completan los
10 videos del lote (13, 20, 21, 22, 24, 25, 26, 28, 29, 30) más el
piloto (09): **11 videos nuevos en `VIDEO_FINAL`** en esta fase
audiovisual.

### Por ESTADO DE PRODUCCIÓN (sobre los 14 videos activos restantes: `GUION_VERIFICADO` + `EVIDENCIA_INSUFICIENTE`, ya sin contar 09/13/20/21/22/24/25/26/28/29/30)

Recalculado desde cero contra el código real (sección 3), no arrastrado
de la versión anterior:

| Estado de producción | Cantidad | Videos |
|---|---|---|
| `LISTO_PARA_PRODUCIR` | 0 | — |
| `REQUIERE_PREPARACION` | 2 | 07, 08 |
| `REQUIERE_NUEVA_VERIFICACION` | 2 | 04, 05 |
| `BLOQUEADO` | 10 | 06, 10, 11, 12, 14, 15, 16, 17, 18, 31 |
| **Total** | **14** | |

5 + 2 + 2 + 10 = 19. Cierra exacto.

**Corrección explícita del error anterior:** la versión previa de este
archivo afirmaba "9 `LISTO_PARA_PRODUCIR`" pero enumeraba 8 (09, 20, 21,
22, 24, 28, 29, 30). Recalculado desde la matriz completa, con la
verificación de código de la sección 3 (que no se había hecho antes para
13, 18, 25 y 26), **el número correcto es 11**: se suman **13, 25 y 26**
(confirmados por código que no dependen de ningún período) y **18 pasa a
`BLOQUEADO`** (el alta del bien no depende del período, pero el asiento
de depreciación —parte del resultado visible que pide el guion— sí, y la
regla es un estado por video, no dos).

---

## 3. La restricción del ejercicio cerrado — auditada contra la aplicación real

Confirmado en vivo ahora mismo, no arrastrado de la sesión anterior:

```
GET /fiscal-years  →  [{ code: "2026", status: "CERRADO", periodCount: 12 }]
GET /periods       →  12/12 en status "CERRADO"
GET /fiscal-years/.../closure  →  status: "COMPLETADO"
```

- **Ejercicio 2026: `CERRADO`.** Confirmado.
- **12 períodos: los 12 en `CERRADO`.** Confirmado.
- **No existe ningún ejercicio 2027** (ni ningún otro) — `GET
  /fiscal-years` devuelve un único registro, el 2026. Confirmado.

### Qué tipo de operación requiere un período abierto — verificado leyendo el código de cada ruta, no supuesto

El candado real vive en la base (trigger `je_fiscal_year_guard`, migración
0038): rechaza cualquier fila nueva en `journal_entries` cuyo ejercicio
no esté `ABIERTO` (o `EN_CIERRE`, para los asientos del propio cierre).
No es un chequeo por pantalla — es al nivel de la tabla. Por eso el
criterio objetivo para clasificar cada video es: **¿la ruta que usa ese
video inserta en `journal_entries`, directa o indirectamente?**

**OPERACIONES DE LECTURA** (no escriben nada — nunca dependen del
período):
`GET /books/diario`, `/books/mayor`, `/reports/trial-balance`,
`/books/iva`, `/audit-log`, `/intelligence/*` (Panorama/riesgos — leído
en `intelligence.ts`, sin ningún `INSERT` a `journal_entries`),
`/projects` (margen ya calculado, solo lectura).
→ Videos 20, 21, 22, 24, 25.

**OPERACIONES NO FECHADAS** (escriben, pero en tablas propias, nunca en
`journal_entries` — confirmado grep por grep en cada archivo de ruta):
- `caja.ts`: `cash_boxes`, `cash_sessions`, `cash_movements` — ninguna
  referencia a `journal_entries` en todo el archivo. → Video 13.
- `activos.ts`: el alta del bien (`fixed_assets`) no toca
  `journal_entries`; **la depreciación sí** (línea ~410, `INSERT ...
  fiscal_year_id`) — es la única operación mixta de la lista. → Video 18
  (mixto, ver más abajo).
- `analisis.ts`: `analysis_scenarios`, `scenario_applications` — sin
  `journal_entries`. → Video 26.
- `migraciones.ts`: ninguna referencia a `journal_entries` (la entidad
  `PARTY` migra a `parties`, no a asientos). → Video 29.
- `documents.ts`: ninguna referencia a `journal_entries` (subir/leer/
  corregir un documento no registra nada contable todavía). → Video 09.
- Mapeo contable, alta de terceros, alta de personas/roles, carga de
  certificado: todas tablas de configuración/maestros, sin
  `journal_entries`. → Videos 04, 05, 07, 08.

**OPERACIONES FECHADAS** (insertan en `journal_entries`, directa o vía
un flujo que termina posteando un asiento — dependen de un período
`ABIERTO`):
- Registrar un comprobante y cargarlo como asiento (10, 15, 31).
- Facturar/recibir/pagar en Compras y Ventas (11, 12).
- Confirmar salida de stock y cerrar un recuento físico (06, 14).
- Cargar un asiento manual (16).
- El asiento de depreciación de un bien de uso (18, parcial).
- Cualquier cierre/apertura de ejercicio (17, el tramo que falta).

---

## 4. Videos inmediatamente producibles (11)

`LISTO_PARA_PRODUCIR`, con justificación puntual:

| Video | Por qué no depende del período cerrado |
|---|---|
| 09 · Documentos | Subir/leer/corregir un documento no toca `journal_entries` (confirmado en `documents.ts`) |
| 13 · Caja, bancos y cheques | `cash_boxes`/`cash_sessions`/`cash_movements` son tablas propias, sin relación con `journal_entries` (confirmado en `caja.ts`) |
| 20 · Diario y Mayor | Lectura pura |
| 21 · Balance | Lectura pura |
| 22 · Subdiarios de IVA | Lectura pura |
| 24 · Auditoría y exportaciones | Lectura/exportación pura |
| 25 · Preguntar: Panorama y riesgos | Lectura pura, confirmado en `intelligence.ts` sin escritura a `journal_entries` |
| 26 · Señales y escenarios | `analysis_scenarios`/`scenario_applications`, confirmado sin relación con `journal_entries` |
| 28 · Proyectos, sucursales y comisiones | Mostrar el proyecto/sucursal/vendedor ya existentes es lectura; el margen real (`$30.000`) ya está posteado y no hace falta volver a generarlo |
| 29 · Integraciones y migración | Migrar `PARTY` no postea asientos, confirmado en `migraciones.ts`; solo necesita un fixture CSV nuevo (el usado se revirtió) |
| 30 · Plan y suscripción | Lectura del plan/historial ya existente |

---

## 5. Videos que requieren preparación (2)

| Video | Preparación exacta |
|---|---|
| 07 · Usuarios y permisos | Julián Ferreyra ya tiene CONTADOR en esta empresa — no se puede re-grabar el alta idéntica. Dar de alta una **persona nueva** en el estudio (correo/nombre distintos) antes de filmar |
| 08 · Certificado ARCA | Ya hay un certificado cargado — confirmar si la ruta admite resubir el mismo archivo o si hace falta uno nuevo de homologación antes de filmar |

---

## 6. Videos que requieren nueva verificación (2)

| Video | Qué falta verificar exactamente |
|---|---|
| 04 · Mapeo contable | El fix de código (`MERCADERIA`/`COSTO_DE_VENTAS`) está confirmado en el diff, pero nunca se corrió en vivo. El mapeo de la empresa actual ya está completo (8/8) — no sirve para mostrar la transición "Faltan → Completo". Verificar: declarar los 8 roles desde una empresa sin mapeo y confirmar que el aviso cambia de estado |
| 05 · Terceros | Cero evidencia — ni GIF, ni nota. Los 3 terceros del dataset ya existen en esta empresa (CUIT único, no se pueden re-dar de alta idénticos). Verificar: alta de un RI, un Consumidor Final y un proveedor nuevos, más la edición con motivo de una ficha |

Ninguno de los dos depende del período cerrado — su blocker es
exclusivamente de verificación/datos, no de entorno contable.

---

## 7. Videos bloqueados (10)

| Video | Causa objetiva (operación fechada que necesita) |
|---|---|
| 06 · Productos | Recuento físico → `stock_movements` fechado |
| 10 · Comprobantes | Registrar comprobante → asiento fechado |
| 11 · Ventas | Operación fiscal → asiento fechado |
| 12 · Compras | Recepción/factura/pago → asientos fechados |
| 14 · Existencias | Confirmar salida de stock + recuento → fechados |
| 15 · Asientos | Cargar y aprobar asiento → fechado |
| 16 · Asientos manuales y contraasientos | Asiento manual → fechado |
| 17 · Períodos y cierre de ejercicio | El tramo faltante (bloquear/reabrir un período) necesita un período `ABIERTO` que hoy no existe en ninguna empresa de este entorno |
| 18 · Bienes de uso | El alta del bien no depende del período, pero el asiento de depreciación —parte del resultado que el guion pide mostrar— sí |
| 31 · Circuito completo | Comprobante→asiento nuevo → fechado, y por guion debe ser distinto de los ya usados |

Los 10 comparten una única causa raíz: **no hay ningún período `ABIERTO`
en ninguna empresa de este entorno.** No son 10 problemas distintos.

---

## 8. Comparación de opciones de entorno (sin elegir ninguna)

### OPCIÓN A — Abrir el ejercicio 2027 en la empresa actual

- **Qué se conserva:** todo — terceros, productos, mapeo (8 roles),
  certificado ARCA, plan `COMPLETO` activo, proyectos/sucursales/
  vendedores, y los 23 `GUION_VERIFICADO` con su evidencia intacta.
- **Qué se "contamina":** nada de 2026. El cierre de ejercicio (`0038`)
  es de diseño irreversible e inmutable — un ejercicio `CERRADO` no
  vuelve a admitir asientos, y la apertura de 2027 no reescribe ni toca
  ningún dato de 2026. Lo único que cambia es que dejarían de existir
  guiones narrados con fechas "2026-09-XX" si las nuevas grabaciones
  quedan fechadas en 2027 — un detalle de guion, no de integridad de
  datos.
- **Riesgo para los videos ya verificados:** ninguno directo. La
  evidencia ya capturada (GIF, respuestas de API con sus IDs) es un
  artefacto congelado, no depende de que la empresa siga en el mismo
  estado.
- **Videos que se destraban:** los 10 `BLOQUEADO` de la sección 7 (con
  fechas en 2027 en vez de 2026).
- **¿2027 sirve como período "limpio" de grabación?** Parcialmente.
  Las cuentas de resultado (ingresos/gastos) arrancan en cero —eso sí es
  limpio—, pero las cuentas patrimoniales (Deudores, Proveedores,
  Bancos) **arrastran el saldo de cierre de 2026** por diseño contable
  correcto (`planificarApertura` solo traslada saldos patrimoniales). No
  es una empresa vacía: es una empresa en su segundo ejercicio, con
  historia — lo cual, para varios videos, es incluso más realista que
  una empresa recién nacida.
- **Pasos administrativos necesarios (ninguno ejecutado):** (1) crear el
  ejercicio 2027 — mismo mecanismo de "Abrir un ejercicio" que ya usó el
  video 02 — con status `ABIERTO`; (2) `POST
  /fiscal-years/2026.../opening` con `siguienteEjercicioId` = el de
  2027. Dos llamadas reales, cada una requeriría autorización explícita
  por separado, igual que el cierre.

### OPCIÓN B — Crear una empresa nueva de producción

- **Qué habría que reconstruir:** empresa (CUIT/entidad nuevos), MFA de
  un administrador, plan de cuentas (185 cuentas, "Usar este plan"), rol
  CONTADOR, ejercicio abierto, mapeo contable (8 roles), 3 terceros, 3
  productos + recuento inicial de stock, certificado ARCA, plan de
  suscripción (Gestión→Completo, o directamente Completo).
- **Qué videos quedarían disponibles:** en principio, los mismos 25 —
  pero **ninguno arranca de `GUION_VERIFICADO`**: cada uno depende de
  que la reconstrucción de arriba se haga primero y se verifique que se
  comporta igual en la empresa nueva.
- **Qué videos habría que volver a verificar:** los 23 que hoy son
  `GUION_VERIFICADO` pasarían, en la práctica, a necesitar una
  confirmación nueva contra la empresa nueva — la evidencia ya
  capturada (GIF, IDs reales) queda como referencia histórica de la
  empresa vieja, no como prueba de que la empresa nueva se comporta
  igual (debería, es el mismo código, pero no es automático).
- **Cuánto trabajo adicional implica:** re-ejecutar, como mínimo, el
  equivalente completo de los videos 02, 04, 05, 06 (alta), 07, 08 antes
  de poder empezar cualquiera de los 25 — la preparación es
  significativamente mayor que la Opción A.
- **Ventaja como entorno limpio:** genuina. Cero historia previa, ningún
  saldo arrastrado, y la empresa actual (con el ejercicio 2026 cerrado)
  queda completamente intacta como referencia/evidencia, sin que ninguna
  grabación nueva pueda tocarla ni por accidente.
- **Corrección (segunda verificación):** la cuenta de producción actual
  (`mariana.sosa.produccion@...`) **no puede** usar el alta de empresa
  de autoservicio que narra el video 02 — esa ruta (`onboarding.ts`)
  rechaza explícitamente a quien ya administra un estudio
  (`YA_TIENE_ESTUDIO`, porque crearía un segundo estudio no pedido). El
  camino real con esta cuenta sería `POST
  /organizations/:organizationId/companies` (la misma que usa el botón
  "Alta de una persona nueva en el estudio" del video 07, pero para
  empresas) — que **no** otorga ningún rol automáticamente a quien la
  crea (confirmado en `create_company()`, migración 0013: "al crearla,
  seguro que no" tiene rol previo). Haría falta un `grant_company_role`
  aparte para que Mariana pueda entrar a la empresa nueva. MFA no se
  repite — es una propiedad del usuario, no de la empresa. Una
  reproducción literal del video 02 tal como está narrado ("Crear mi
  empresa") solo es posible con un usuario que todavía no administre
  ningún estudio — es decir, uno nuevo, como en el video 01.
- **Cómo se haría, si se elige:** ya existe un mecanismo real para esto
  — `npm run factura:demo` (`scripts/factura-demo.mjs`), auditado
  completo. **Corrección respecto a la versión anterior de este
  informe:** no crea una empresa con el dataset del curso ni con el
  plan NEXO PYME de forma configurable — crea una empresa **distinta**
  ("Ferretería del Norte **S.A.**", no S.R.L.) con datos únicos por
  corrida (usa una secuencia `fixture_ids` para que el CUIT/organización/
  usuarios nunca choquen entre corridas), con un dataset mínimo propio:
  **1 cliente, 1 producto, 1 factura** — cubre de punta a punta el
  circuito estudio→empresa→usuario con MFA→plan de cuentas→mapeo
  (8/8)→marco de reporte→ejercicio→documento→comprobante→asiento
  propuesto→aprobado→Mayor→Balance, usando **la API real vía
  `app.inject()` en proceso** (no contra el servidor `npm start` que ya
  corre en :3001 — levanta su propia instancia del server, así que no
  interfiere con él). No crea proveedores, caja/bancos/cheques, bienes
  de uso, proyectos/sucursales/comisiones, ni certificado ARCA — sirve
  como prueba de que el mecanismo de alta funciona de punta a punta y
  como plantilla de código reutilizable, no como generador del dataset
  completo de 09-dataset-demo.md. Es seguro de re-correr varias veces
  (cada corrida es independiente), pero nunca limpia lo que ya creó —
  no hay `DELETE` en ningún lado del esquema (`forbid_delete`), así que
  cada corrida deja una empresa más. Hoy `DATABASE_URL` apunta a `aai`
  — la misma base de la empresa del curso —, así que correrlo tal cual
  agregaría una empresa más ahí (no toca la existente: todo está
  particionado por `company_id` con RLS).

### OPCIÓN C — Base de datos separada

**Hallazgo nuevo de esta pasada, no documentado antes:** el proyecto ya
tiene un mecanismo propio para esto — `npm run sandbox:create` /
`sandbox:run` / `sandbox:status` (`scripts/sandbox.mjs`, paquete
`@aai/sandbox`, "§34"). No es una idea a construir: es infraestructura
real, con un candado de seguridad propio (`verificarAislamiento`) que se
niega a correr si el destino no está marcado explícitamente como
sandbox. Usa una variable **separada**, `SANDBOX_DATABASE_URL` (a
propósito distinta de `DATABASE_URL`, "para que un sandbox que se
configura cambiando la misma variable no se convierta en producción con
un olvido") — hoy **no está definida en `.env`**, confirmado. `create`
aplica exactamente las mismas migraciones que usa la base real, nunca un
esquema simplificado — evita que "anduvo en el sandbox" deje de
significar algo. El escenario de demostración que trae `sandbox:run` de
fábrica (`scripts/sandbox-escenario.mjs`) es **ajeno al curso**: una
"SIMULACIÓN" fija, con CUIT de prueba y UUID fijos, pensada para mostrar
un caso de IVA `NO_DETERMINABLE` — no serviría para filmar tal cual,
haría falta usar la base sandbox una vez creada y cargarla a mano por la
consola, igual que se hizo la primera vez con la empresa actual.

**Verificado ahora mismo, de forma no destructiva** (consulta de
solo-lectura a `pg_database`, sin instalar nada, sin crear nada, sin
cambiar `DATABASE_URL`):

| Base | ¿Existe? | Tamaño | Tablas | Empresas | Nota |
|---|---|---|---|---|---|
| `aai` | Sí | 36 MB | 278 | 8 | **La que usa la app ahora mismo** (`DATABASE_URL` del `.env`) — incluye la empresa del curso |
| `aai_test` | Sí | 41 MB | 278 | 551 | La de la suite de tests — crece sin límite en cada corrida (ya documentado en memoria de sesiones previas), no apta para un dataset limpio |
| `aai_demo` | **No existe** | — | — | — | Solo está en la lista blanca de `factura-demo.mjs`, nunca se creó |
| `aai_limpia` | **No existe** | — | — | — | Ídem |
| `aai_verify` | Sí (no prevista) | 23 MB | 278 | 2 | Ajena a este proyecto de curso — de una verificación/predeploy anterior; esquema al día (278 tablas, igual que `aai`) pero con datos propios ya adentro |
| `aai_predeploy_verify` | Sí (no prevista) | 23 MB | 277 | 2 | Ídem, un `pg_database`/tabla de diferencia con `aai_verify` — probablemente una migración detrás |
| `sandbox_aai` | Sí (no prevista) | 13 MB | 92 | 0 | Esquema muy desactualizado (92 de 278 tablas) — necesitaría correr todas las migraciones pendientes antes de poder usarse |

- **Qué sería, si se elige:** dos caminos reales, no uno solo. (i)
  `aai_demo`/`aai_limpia` no existen — crearlas a mano y migrarlas desde
  cero. (ii) **El camino ya soportado por el proyecto**: definir
  `SANDBOX_DATABASE_URL` (por ejemplo, apuntando a la `sandbox_aai` que
  ya existe, o a una nueva) y correr `npm run sandbox:create` — aplica
  las migraciones reales y marca la base como sandbox. La `sandbox_aai`
  que ya existe (92 tablas) está desactualizada — quedó de una corrida
  vieja, antes de decenas de migraciones posteriores — así que de
  cualquier manera haría falta un `create` (o un `db:migrate` sobre
  ella) para ponerla al día antes de usarla.
- **Ventaja sobre la Opción B:** aislamiento físico total, no solo por
  `company_id`. La base `aai` —con la empresa del curso, su ejercicio
  2026 cerrado y toda la evidencia ya citada por UUID en los guiones—
  queda completamente separada de cualquier cosa que se grabe de acá en
  adelante.
- **Por qué no es una recomendación lista para ejecutar:** **confirmado
  que `aai_demo` y `aai_limpia` no existen** — no es una duda, es un
  hecho verificado por consulta directa a `pg_database`. De las tres
  bases "de más" que sí existen, `sandbox_aai` necesita migrarse desde
  un punto muy atrasado, `aai_verify`/`aai_predeploy_verify` ya tienen
  datos ajenos al curso adentro (de otra sesión de verificación/
  predeploy), y ninguna de las tres está en la lista blanca de
  `factura-demo.mjs` — el script se negaría a escribir en cualquiera de
  ellas tal como está hoy, sin editar esa lista (un cambio de código,
  fuera de alcance de esta tarea). Crear una base genuinamente nueva
  (`aai_demo` o `aai_limpia`) implica correr el set completo de
  migraciones del proyecto ahí antes de nada — es la opción con más
  trabajo de infraestructura de las tres, aunque la más aislada.
- **Estado:** documentada porque es real (el código la anticipa
  explícitamente); verificada como **no disponible hoy** sin trabajo de
  infraestructura previo — no ejecutada, no se creó ninguna base.

---

## 9. Estado del working tree (re-confirmado, sin tocar nada)

```
 M apps/api/src/routes/studio.ts
 M apps/web/consola.html
 M docs/MANUAL-USUARIO-NEXO.md
?? docs/curso/
?? scripts/reset-mfa-usuario.mjs
?? scripts/reset-password-usuario.mjs
```

Idéntico, línea por línea, al estado reportado en la pasada anterior —
`git diff --stat` devuelve los mismos tres archivos con los mismos 397
inserciones/18 eliminaciones. Confirmado ahora:

- Los cambios de `studio.ts` y `consola.html` **siguen presentes**, sin
  modificar.
- Los 9 videos que dependen de ellos (04, 07, 09, 12, 16, 18, 20, 23, 28)
  **siguen siendo reproducibles** tal como están.
- No hay cambios ajenos al curso mezclados (re-confirmado por
  inspección, sección 2 de la pasada anterior).
- No hay secretos ni credenciales en ninguno de los archivos.
- **No se hizo ningún commit.** No se ejecutó ningún comando destructivo
  ni de git en esta tarea.
- No se perdió nada — el diff es exactamente el mismo que antes de esta
  auditoría.

---

## 10. DECISIÓN QUE DEBE TOMAR PABLO

No se elige ninguna opción acá. Esto es lo necesario para decidir:

**1. Estado actual:** 3 videos terminados (01-03), 23 con guion
verificado sin video, 2 sin evidencia suficiente de haberse ejecutado
nunca (04, 05), 3 saltados a propósito (19, 23, 27). El ejercicio 2026 de
la empresa del curso está cerrado; no hay ningún período abierto en
ningún lado de este entorno.

**2. Videos que podés producir ahora mismo, sin decidir nada más:** 11
(`LISTO_PARA_PRODUCIR`, sección 4) + los 2 que requieren solo un dato
nuevo, no un cambio de entorno (`REQUIERE_PREPARACION`, sección 5) — 13
en total, sin tocar el ejercicio ni crear nada.

**3. Videos bloqueados:** 10 (sección 7), más el tramo faltante del
video 17.

**4. Problema común que los bloquea:** ninguna operación con fecha
contable puede escribirse hoy en esta empresa — el ejercicio 2026 está
`CERRADO` y no existe 2027.

**5. Opción A** — abrir 2027 en la empresa actual: mínimo trabajo
administrativo (2 llamadas), conserva toda la historia y evidencia ya
producida, pero las cuentas patrimoniales de 2027 arrastran saldo de
2026 (no es una empresa "vacía").

**6. Opción B** — empresa nueva en la misma base (`aai`): entorno
realmente limpio, pero exige reconstruir configuración/maestros antes de
filmar nada, y los 23 `GUION_VERIFICADO` pasarían a necesitar
confirmación nueva sobre la empresa nueva.

**7. Opción C** — base de datos separada (`aai_demo`/`aai_limpia`):
aislamiento total de la empresa de referencia, pero no está preparada
hoy — exige migrar una base nueva desde cero, y no se confirmó que esas
bases ya existan.

**8. Consecuencias de cada una:**
- A: más rápido, menor aislamiento (misma empresa, ejercicio nuevo).
- B: aislamiento por empresa dentro de la misma base, más trabajo de
  preparación, re-verificación de lo ya hecho.
- C: aislamiento total, más trabajo de infraestructura, estado de
  disponibilidad hoy desconocido.

**9. Información adicional que podría hacer falta para elegir:**
- Si importa o no que los guiones narrados en 2026 queden fechados en
  2027 (Opción A) — es un ajuste de texto, no de datos.
- Si `aai_demo`/`aai_limpia` ya existen en algún entorno que no sea esta
  máquina (por ejemplo, un servidor de CI o staging) — esta auditoría no
  pudo confirmarlo sin `psql` ni Docker locales.
- Si hay preferencia por mantener una sola empresa demo "canónica" para
  todo el material de marketing/YouTube futuro, lo cual favorecería la
  Opción A (misma empresa, misma identidad, "Ferretería El Tornillo
  Feliz S.R.L." ya citada en 09-dataset-demo.md) sobre crear una
  segunda empresa con otro nombre.

No se ejecutó ninguna acción de las tres opciones. No se produjo ningún
video. No se modificó código. No se hizo ningún commit.

---

## 11. Pipeline de narración gratuito (Piper TTS) — probado real con el video 09

**Motor:** Piper 2023.11.14-2 (MIT), binario Windows standalone, sin
Python, sin GPU, 100% local y offline. **Voz:** Daniela
(`es_AR-daniela-high.onnx`, 22.050 Hz, entrenada sobre el dataset
OpenSLR SLR61 — licencia CC BY-SA 4.0, atribución requerida). Instalado
en `scratchpad/produccion/lib/piper/` (motor ~22 MB + modelo ~114 MB).
**Una sola voz para todo el curso** — no cambiar por video.

**Para narrar un video nuevo:**
1. Escribir el texto de cada segmento en `scratchpad/produccion/videoNN/
   audio/seg-01.txt`, `seg-02.txt`, etc. — **con el editor/Write tool,
   nunca con `echo` de Git Bash** (memoria del proyecto: los heredocs y
   los caracteres especiales de Git Bash se corrompen en silencio; ya
   pasó una vez en esta misma tarea con los acentos). El texto es el
   "Qué digo" literal del guion, dividido por beat visual, con los
   mismos ajustes mínimos ya documentados (sin «» ni —, y cualquier
   identificador con guion_bajo escrito como palabras sueltas para que
   Piper no lo deletree letra por letra).
2. Correr `bash scratchpad/produccion/lib/narrar_piper.sh
   scratchpad/produccion/videoNN/audio` — genera un `.wav` real por cada
   `.txt`.
3. Capturar las imágenes reales de cada beat (pantallas de la app real,
   mismo método que el video 09: el navegador integrado de Claude, no
   Claude-in-Chrome, que sigue con el bug de panel "0 width").
4. Ensamblar con el mismo patrón de `armar_video.sh`, adaptado para
   imagen fija en vez de clip de GIF: por segmento,
   `ffmpeg -loop 1 -i still.jpg -i seg-NN.wav -vf "scale=890:444:
   force_original_aspect_ratio=decrease,pad=890:444:(ow-iw)/2:(oh-ih)/2:
   color=0x0b0f10" -c:v libx264 -tune stillimage -pix_fmt yuv420p -r 25
   -c:a aac -b:a 160k -shortest segNN-final.mp4`; después tarjeta de
   título igual que siempre, y concatenar con `filter_complex concat`
   (no el demuxer `-f concat`: en esta prueba dio audio corrupto —
   agregar `setsar=1` a cada entrada de video antes de concatenar,
   si no, ffmpeg rechaza el filtro por SAR distinto entre la tarjeta de
   título y las imágenes).
5. Verificar con `ffprobe` (duración, resolución 890×444, 25fps, h264/
   aac) y extraer frames de muestra a lo largo de todo el video para
   confirmar sincronía real antes de declarar `VIDEO_FINAL`.

Costo real de esta prueba: **$0** — ni un crédito de ninguna API paga.
