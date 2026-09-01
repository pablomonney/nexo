# OPERACIÓN.md — el modelo de trabajo diario

> **Estado: diseño. Nada de lo que está acá está implementado.**
>
> Documento de FASE 2. Describe cómo NEXO debería presentar el trabajo pendiente
> a una persona, partiendo **exclusivamente** de estructuras que ya existen en el
> repositorio. Cada afirmación sobre el estado actual se verificó contra el
> esquema o contra el código, no contra la memoria de nadie.
>
> No crea tablas, no modifica migraciones, no toca RLS y no activa ninguna regla.

---

## A · Estado actual

### A.1 Lo que existe

El motor está entero y verificado: 1266 tests, `verify` y `ci:desde-cero` en 0,
`audit:estructura` 82/82, `audit:invariants` 11 verificados · 0 violados · 0 no
ejercitados · 3 vacuos permitidos, 44 migraciones.

Una precisión sobre el conteo del esquema, porque este documento lo usa: las
**97 relaciones** del informe de cierre son **84 tablas y 13 vistas**
(`information_schema.tables` cuenta las dos cosas). De las 84 tablas, **55 llevan
`company_id` con RLS forzado y una política cada una**.

Las 29 restantes son de cuatro clases, y ninguna es un descuido:

- **corpus normativo** (`norms`, `norm_versions`, `norm_articles`,
  `norm_documents`, `normative_gaps`, `norm_candidates`, …): una norma no
  pertenece a una empresa. Esta clase decide el diseño de la sección D;
- **identidad y autorización** (`users`, `sessions`, `organizations`,
  `organization_members`, `roles`, `permissions`, `role_permissions`);
- **infraestructura** (`schema_migrations`, `tax_rates`, `taxes`,
  `arca_comprobante_types`, `arca_access_tickets`, `prompt_versions`);
- **`companies`**, que es el caso especial: tiene RLS forzado pero su política es
  `id = app_company_id()`, no `company_id = …`, porque la empresa **es** la fila.

### A.2 Lo que falta

La FASE 1 encontró que el problema no es la integridad sino la **operabilidad**.
Cuatro huecos concretos, y una familia de estructuras desconectadas.

| Hueco | Consecuencia |
|---|---|
| No hay listado de empresas del usuario | la consola no pasa del paso 01 (404 demostrado) |
| No hay listado de operaciones fiscales | solo se llega a una operación por el documento que la originó |
| No hay bandeja de pendientes | nadie sabe qué le falta |
| No hay paginación | `limite` sin cursor: no existe segunda página |

Y una observación que esta fase agrega a la anterior, porque apareció al mirar el
catálogo de permisos: **seis permisos declarados, asignados a roles reales, no los
exige ninguna ruta.**

```
alert:read            → ADMINISTRADOR, AUDITOR, CONTADOR, SOLO_LECTURA, USUARIO_EMPRESA
alert:acknowledge     → ADMINISTRADOR, CONTADOR
audit_finding:read    → ADMINISTRADOR, AUDITOR, CONTADOR
audit_finding:review  → AUDITOR, CONTADOR
norm_watch:read       → ADMINISTRADOR, AUDITOR, CONTADOR
norm_watch:dismiss    → CONTADOR
audit:read            → ADMINISTRADOR, AUDITOR, CONTADOR
```

Siete, contando `audit:read`. **El modelo de autorización ya previó la bandeja de
trabajo.** Alguien pensó qué rol puede reconocer una alerta y qué rol puede dar
por revisado un hallazgo, lo escribió en la base, y el camino nunca se recorrió.

Tres permisos más sin uso, con explicación distinta y legítima:

- `company:create` y `user:manage` — las rutas de estudio autorizan por
  `organization_level()`, no por permiso de empresa. Es coherente: crear una
  empresa es un acto del estudio, y todavía no hay empresa sobre la cual tener un
  permiso.
- `rule:activate` — **declarado y otorgado a ningún rol**. Es deliberado: el §32
  exige la firma de un matriculado y proponente ≠ aprobador. Hoy eso se resuelve
  por `npm run reglas:aprobar`. El permiso está esperando el día en que exista una
  ruta y un rol que lo tenga.

---

## B · Inventario de fuentes de trabajo

Entidad por entidad, verificado contra el catálogo. `RLS` significa
`ROW LEVEL SECURITY FORCE` con una política por `app_company_id()`.

### B.1 Ingreso documental

**`documents`** · `company_id` sí · RLS sí · endpoints `GET /documents`,
`GET/POST /documents/:id`, `POST /documents/:id/extract` · auditoría
`INGRESAR_DOCUMENTO`, `RECHAZAR_DOCUMENTO`, `REEXTRAER_DOCUMENTO` · trigger
`documents_no_delete`.

| Estado | Significado | Quién lo cambia | Acción humana |
|---|---|---|---|
| `RECIBIDO` | archivado con hash; todavía no produjo operación | el sistema al subir | leerlo o registrarlo |
| `EXTRAIDO` | se le leyó algo | el motor de extracción | revisar campos |
| `IMPUTADO` | ya produjo una operación fiscal | el sistema | ninguna |
| `RECHAZADO` | una persona lo descartó | CONTADOR / CARGADOR | ninguna |
| `ANULADO` | anulado con motivo | CONTADOR | ninguna |

**En bandeja: sí.** `RECIBIDO` y `EXTRAIDO` son trabajo pendiente por definición.

**Pero la vista existente no sirve tal cual, y conviene decir por qué.**
`documents_pendientes` filtra por exclusión:

```sql
WHERE d.status <> ALL (ARRAY['ANULADO', 'IMPUTADO'])
```

Con cinco estados posibles, excluir dos deja tres — e incluye **`RECHAZADO`**. Un
documento que una persona descartó explícitamente aparece hoy en una vista que se
llama «pendientes», y por lo tanto en `GET /documents`.

No es un defecto de integridad: no se corrompe nada y el dato que devuelve es
cierto. Es un desajuste entre el nombre de la vista y su filtro, del tipo que se
vuelve visible recién cuando alguien la usa para lo que el nombre promete.

**Consecuencia para el diseño:** la rama 1 de `work_queue` se escribe por
inclusión —`status IN ('RECIBIDO','EXTRAIDO')`— y no por exclusión. Un filtro por
inclusión no puede empezar a devolver de más cuando el catálogo crezca; uno por
exclusión sí. Es la misma inversión de «probá que es lo bueno» en vez de
«comprobá que no es lo malo» que el sistema ya aplica en otros lados.

**`document_extractions`** · RLS sí · sin endpoint propio (se lee dentro de
`GET /documents/:id`). No tiene estado: tiene `available` y
`unavailable_reason ∈ {SIN_MOTOR_OCR, TIPO_NO_SOPORTADO, MOTOR_FALLO,
DOCUMENTO_ILEGIBLE}`. **En bandeja: sí, como motivo**, no como ítem propio: lo
que está pendiente es el documento, y esto explica por qué.

**`document_findings`** · RLS sí · sin endpoint propio · `severidad ∈ {ERROR,
ADVERTENCIA, INFO}` y **`bloquea boolean`**. **En bandeja: sí**, y `bloquea` es la
señal, no `severidad`.

**`document_duplicates`** · RLS sí · `POST /documents/:id/duplicates/:dupId` ·
auditoría `RESOLVER_DUPLICADO` · `nivel ∈ {ARCHIVO_IDENTICO,
COMPROBANTE_REPETIDO, POSIBLE_DUPLICADO}`, `resolucion ∈ {ES_DUPLICADO,
NO_ES_DUPLICADO}` nullable, `bloquea boolean`. **En bandeja: sí** cuando
`bloquea AND resolucion IS NULL`. Es el caso más limpio de todos: la condición de
pendiente **es** la ausencia de un dato, y desaparece sola cuando se resuelve.

### B.2 Circuito fiscal

**`tax_transactions`** · RLS sí · endpoints solo por documento
(`GET/POST /documents/:id/tax-transaction`) y `POST /tax-transactions/:id/constatar`
· auditoría `OPERACION_FISCAL_REGISTRADA`, `CONSTATAR_COMPROBANTE` · triggers
`constatacion_coherente`, `constatacion_no_degrada`, `no_delete`.

Dos ejes de estado, y **no son el mismo**:

| Columna | Valores | Qué dice |
|---|---|---|
| `constatacion` | `OK`, `WARN`, `FAIL`, `NO_VERIFICABLE`, `NO_CONSULTADO` | el **resultado** |
| `constatacion_origen` | `NO_CONSULTADO`, `ARCA`, `DECLARACION_PROFESIONAL`, `ORIGEN_NO_REGISTRADO` | la **procedencia** |

**En bandeja: sí**, y hay que ser preciso sobre cuándo. `NO_CONSULTADO` es
trabajo pendiente. `ORIGEN_NO_REGISTRADO` —las filas anteriores a la `0043`— es
trabajo pendiente **de otra naturaleza**: no falta consultar, falta saber quién
consultó. Son dos ítems distintos y el modelo debe distinguirlos.

**`tax_affectations`** · RLS sí · `GET/POST /tax-transactions/:id/afectacion` ·
auditoría por trigger `tax_affectations_audit` · triggers `evidence_exists`,
`shape`, `tenant`, `no_delete`.

`afectacion ∈ {GRAVADAS, EXENTAS, NO_GRAVADAS, MIXTA, NO_DETERMINADA}`,
`origen ∈ {DECLARACION_PROFESIONAL, SUGERIDA_POR_PRECEDENTE}`.

**En bandeja: sí, por ausencia.** El pendiente no es una fila con estado
`NO_DETERMINADA`: es una operación **sin fila de afectación**. Y hay un segundo
caso: una fila con `origen = 'SUGERIDA_POR_PRECEDENTE'` no es una declaración —
la vista `tax_affectations_declaradas` la excluye explícitamente, y el motor solo
consulta esa vista. Una sugerencia pendiente de confirmación **sigue siendo
trabajo pendiente**.

### B.3 Decisión y asiento

**`accounting_decisions`** · RLS sí · `GET/POST /comprobantes/:id/decision`,
`/supersede`, `/historial` · auditoría por trigger + `DECISION_REGISTRADA`,
`DECISION_CORREGIDA` · triggers `inmutable`, `manual_sin_regla`,
`supersede_coherente`, `no_delete`.

| Columna | Valores |
|---|---|
| `estado` | `EMITIDA`, `APLICADA`, `SUPERSEDIDA` |
| `resultado` | `PROPUESTA_DE_ASIENTO`, `REQUIERE_REVISION`, `SIN_EFECTO` |
| `origen` | `DETERMINISTICA`, `PROPUESTA_IA`, `MANUAL` |
| `ambiente` | `PRODUCTIVO`, `PRUEBA` |

**En bandeja: sí, tres veces distintas.**
1. `estado = 'EMITIDA'` con `resultado = 'PROPUESTA_DE_ASIENTO'` → falta el asiento.
2. `resultado = 'REQUIERE_REVISION'` → **la categoría ya existe con este nombre en
   el dominio.** No hay que inventarla.
3. Una operación **sin decisión** → falta decidir.

**`journal_entries`** · RLS sí · `GET/POST /journal-entries`, `/approve`,
`/reverse` · auditoría `CREAR_ASIENTO`, `APROBAR_ASIENTO`, `ANULAR_ASIENTO` ·
siete triggers, entre ellos `je_period_guard` y `je_approved_immutable`.

`status ∈ {BORRADOR, PROPUESTO, APROBADO, ANULADO}`.

**En bandeja: sí.** `BORRADOR` y `PROPUESTO` son asientos que existen y todavía no
se proyectaron al Mayor. Solo `journal_entry:approve` (CONTADOR) los mueve.

### B.4 Cierre y estados

**`periods`** · RLS sí · `GET /periods`, `POST /periods/:id/{block,close,reopen}`
· auditoría completa · trigger `periods_transicion_valida`.
`status ∈ {ABIERTO, BLOQUEADO, CERRADO}`.

**En bandeja: con cuidado.** Un período `ABIERTO` no es un pendiente: es el estado
normal. Lo que sí es un hecho objetivo es que **`end_date` ya pasó y el período
sigue `ABIERTO`**. Eso es una fecha, no una opinión.

**`fiscal_years`** · `status ∈ {ABIERTO, EN_CIERRE, CERRADO}` · mismo criterio.

**`accounting_closures`** · RLS sí · rutas `/fiscal-years/:id/{pre-close,close,opening}`
· `status ∈ {EN_CURSO, COMPLETADO, ABORTADO}`. **En bandeja: sí**, `EN_CURSO` es
un cierre empezado y no terminado, que es exactamente un pendiente.

**`financial_statements`** · RLS sí · `status ∈ {BORRADOR, EMITIDO, ANULADO}`.
**En bandeja: marginal.** `BORRADOR` es un estado transitorio de la propia
transacción de emisión (la cabecera nace `BORRADOR` porque
`fsl_immutable_when_issued` rechaza líneas sobre un estado ya emitido). Un
`BORRADOR` que sobrevive a su transacción es una anomalía, no una tarea.

**`notes`** · RLS sí · `/statements/:id/notes/generate`, `/notes/:id/approve`,
`/revise`, `/verify` · auditoría completa.

`status ∈ {BORRADOR, APROBADA, SUPERSEDIDA}`,
`evidencia ∈ {VERIFIED, REQUIRES_REVIEW, INSUFFICIENT_EVIDENCE}`,
`generated_by ∈ {RULE, AI, HUMAN}`.

**En bandeja: sí, y es el caso más rico.** Una nota `BORRADOR` con
`evidencia = 'INSUFFICIENT_EVIDENCE'` y `generated_by = 'AI'` es simultáneamente:
pendiente de aprobación, con evidencia insuficiente, y propuesta por una máquina.
El CHECK de la tabla ya prohíbe que una nota `AI` salga de `BORRADOR` sin
`approved_by`. La bandeja no tiene que agregar ninguna regla: tiene que mostrarla.

**`vat_books`** · RLS sí · `/vat/books/:anio/:mes{,/generate,/present}` ·
`status ∈ {PENDIENTE, GENERADO, SIN_MOVIMIENTO, PRESENTADO_POR_TERCERO}` y
**`vencimiento date`**. **En bandeja: sí**, y es la única fuente con una fecha
límite explícita en el esquema.

**`bank_reconciliations`** · RLS sí · `status ∈ {BORRADOR, CONFIRMADA, ANULADA}`.
**En bandeja: sí**, `BORRADOR`.

### B.5 Las cinco estructuras desconectadas

Aquí está el hallazgo central de esta fase, y **no todas son lo mismo**.

| Tabla | `company_id` | RLS | Escritor en producción | Ruta | Permiso declarado |
|---|---|---|---|---|---|
| `alerts` | **sí** | **sí** | ninguno | ninguna | `alert:read`, `alert:acknowledge` |
| `audit_findings` | **sí** | **sí** | ninguno | ninguna | `audit_finding:read`, `:review` |
| `normative_conflicts` | no | no | ninguno | ninguna | — |
| `normative_updates` | no | no | ninguno | ninguna | — |
| `norm_candidates` | no | no | **ninguno** | ninguna | `norm_watch:read`, `:dismiss` |

**Las dos primeras son de empresa. Las tres últimas son del corpus normativo.**
Esa diferencia no es un detalle de implementación: decide en qué bandeja va cada
una, y la sección J la desarrolla.

Sobre `norm_candidates` hay que ser exacto, porque el código dice una cosa y hace
otra. El encabezado de `scripts/norms-watch.mjs` afirma que el script «abre
tareas». **No lo hace**: `vigilar()` es una función pura, el script imprime los
candidatos por pantalla y no ejecuta un solo `INSERT`. La tabla existe, tiene su
trigger `norm_candidates_no_delete`, y nunca recibió una fila.

No es un defecto de integridad —nada se corrompe, nada falso se afirma— pero es
una discrepancia entre el comentario y el comportamiento, y queda registrada.

### B.6 `audit_logs`: escrito por todos, leído por nadie

`audit_logs` · `company_id` sí · RLS sí · encadenado por hash con
`audit_logs_chain` e inmutable por `audit_logs_immutable`. Lo escriben
`recordAudit()` desde 16 archivos de rutas —34 acciones distintas— y tres
triggers de base (`accounting_decisions_audit`, `tax_affectations_audit`,
`user_company_roles_audit`).

**Ninguna ruta lo lee.** `grep -rn "FROM audit_logs" apps/api/src/` no devuelve
nada, y `audit:read` está otorgado a tres roles y no se exige en ningún lado.

**En bandeja: no.** La bitácora no es trabajo pendiente: es el registro de lo ya
hecho. Pero sí es un hueco de operabilidad de la misma familia, y le corresponde
un endpoint propio en una fase posterior.

### B.7 Observación menor sobre la nomenclatura de auditoría

De las 34 acciones auditadas, 29 usan `MAYUSCULA_CON_GUION_BAJO`
(`APROBAR_ASIENTO`, `DECLARAR_AFECTACION`) y 5 usan `punto.minuscula`
(`book.emit`, `vat_book.generate`, `financial_statement.issue`,
`bank_reconciliation.confirm`, `bank_statement.import`).

No afecta a nada hoy —nadie filtra por `action`— pero un lector de bitácora
tendrá que conocer las dos convenciones. `DEUDA TÉCNICA`, sin urgencia.

---

## C · Definición formal de «pendiente»

### C.1 La distinción que decide el diseño

Hay **dos clases de pendiente**, y confundirlas es lo que lleva a inventar una
tabla `tasks`.

**Pendiente derivado.** La condición **es** el estado de una fila de dominio.
`documents.status = 'RECIBIDO'` no *tiene* un pendiente asociado: *es* el
pendiente. Cuando el estado cambia, el pendiente deja de existir, y no queda ni
debe quedar rastro de que existió — el rastro de que alguien lo resolvió ya está
en `audit_logs`.

**Pendiente registrado.** La condición **ocurrió** en un momento y alguien tiene
que hacerse cargo aunque ya no se cumpla. «El importe de este asiento es atípico»
sigue mereciendo respuesta después de que el asiento se aprobó. Estos necesitan
persistencia propia, con quién los reconoció y por qué.

**El sistema ya tiene las dos.** Los derivados son los estados inventariados en la
sección B. Los registrados son `alerts` y `audit_findings`, que existen, tienen
`company_id`, RLS, permisos asignados y un CHECK que impide cerrarlos sin nombre
y sin motivo:

```sql
CHECK (status = 'ABIERTA'
       OR (acknowledged_by IS NOT NULL
           AND acknowledged_at IS NOT NULL
           AND ack_reason IS NOT NULL))
```

No hace falta modelar nada nuevo. Hace falta **conectar** lo registrado y
**proyectar** lo derivado.

### C.2 Las categorías

Se evaluaron las siete propuestas contra la semántica que el repositorio ya tiene.
**Cinco existen literalmente en el dominio y se reutilizan sin cambiarles el
nombre. Una se renombra por precisión. Una se acepta con una restricción.**

| Categoría | ¿Ya existe en el dominio? | Referentes verificados |
|---|---|---|
| **`BLOQUEADO`** | sí, como columna `bloquea` | `document_findings.bloquea`, `document_duplicates.bloquea`, `vat_books.bloqueos`, `normative_gaps.blocks_rule_key` |
| **`REQUIERE_REVISION`** | **sí, textual** | `accounting_decisions.resultado = 'REQUIERE_REVISION'`, `notes.evidencia = 'REQUIRES_REVIEW'` |
| **`REQUIERE_DECLARACION`** | sí, por ausencia | operación sin `tax_affectations`; `constatacion_origen = 'NO_CONSULTADO'`; afectación con `origen = 'SUGERIDA_POR_PRECEDENTE'` |
| **`REQUIERE_EVIDENCIA`** | **sí, textual** | `notes.evidencia = 'INSUFFICIENT_EVIDENCE'` |
| **`REQUIERE_CORRECCION`** | sí | `audit_findings.estado = 'ABIERTO'`, `document_duplicates` con `bloquea AND resolucion IS NULL`, `tax_transactions.constatacion IN ('FAIL','WARN')` |
| **`REQUIERE_FUENTE_EXTERNA`** | sí | `normative_gaps.status = 'ABIERTO'`, `unavailable_reason = 'SIN_MOTOR_OCR'`, `company_arca_capabilities.last_probe_result = 'NO_DELEGADO'` |
| **`REQUIERE_APROBACION`** | sí — **reemplaza a `INFORMATIVO`** | `journal_entries.status IN ('BORRADOR','PROPUESTO')`, `notes.status = 'BORRADOR'`, `bank_reconciliations.status = 'BORRADOR'`, `accounting_closures.status = 'EN_CURSO'` |

**Por qué se cambia `INFORMATIVO` por `REQUIERE_APROBACION`.** `INFORMATIVO` no
tiene referente propio: lo único que le correspondería es
`document_findings.severidad = 'INFO'` y las alertas de severidad `BAJA`, y ambas
ya se muestran como *motivo* del ítem que las contiene, no como ítem. Una bandeja
que lista cosas que no requieren acción entrena a la gente a ignorarla.

En cambio **falta** una categoría con referente masivo y sin nombre: el trabajo
que existe, está bien, y espera una firma. Cuatro tablas la producen. Es la
categoría más frecuente de un estudio y no estaba en la lista.

`INFORMATIVO` se descarta. Si más adelante aparece un caso real que no encaje en
las siete, se agrega entonces y con su referente a la vista.

### C.3 Lo que una categoría **no** es

Una categoría **no dice qué hacer**. Dice **qué falta**. La acción disponible se
deriva del permiso del usuario (sección I), no de la categoría.

---

## D · Modelo conceptual de la cola de trabajo

### D.1 Veredicto sobre la tesis

> **NEXO no necesita una tabla `tasks`. Confirmado, y no por preferencia
> estética.**

Tres razones, en orden de peso:

1. **Sería una segunda fuente de verdad sobre la misma pregunta.** Si
   `tasks.status = 'PENDING'` y `tax_affectations` dice que la afectación ya se
   declaró, ¿cuál manda? La única respuesta correcta es «la tabla de dominio», y
   entonces la fila de `tasks` no aportaba nada excepto la posibilidad de estar
   equivocada.

2. **La sincronización necesitaría triggers sobre las tablas críticas.** Cada
   `INSERT` en `tax_affectations`, cada `UPDATE` de `journal_entries.status`
   tendría que mantener una fila espejo. Eso es agregar escritura a las tablas
   más protegidas del sistema para alimentar una vista. El §17 de la FASE 1 las
   declara intocables, y con razón.

3. **La cola tiene que poder cambiar de opinión.** El criterio de qué merece
   atención va a evolucionar con el primer piloto. Una vista se reescribe; una
   tabla materializada obliga a un backfill y a decidir qué pasa con las filas
   que ya no aplican.

### D.2 La forma: dos vistas, no una

El modelo es **`work_queue`**, una vista `UNION ALL` de ramas de proyección, más
las dos tablas registradas que ya existen.

Pero hay una restricción del esquema que obliga a partirla en dos, y conviene
entenderla antes que el resto:

> `normative_gaps`, `normative_conflicts`, `normative_updates` y
> `norm_candidates` **no tienen `company_id` y no tienen RLS**, porque una norma
> no pertenece a ninguna empresa.

Meterlas en `work_queue` obligaría a inventarles un `company_id` —típicamente
`app_company_id()`— y eso **afirmaría algo falso**: que el hueco del Decreto
280/1997 es un pendiente de *esta* empresa. Es un pendiente del estudio, y afecta
a todas por igual.

| Vista | Alcance | Ámbito | Se consulta con |
|---|---|---|---|
| `work_queue` | por empresa, `company_id NOT NULL` | trabajo del cliente | `X-Company-Id` + RLS |
| `normative_queue` | global, sin `company_id` | trabajo del corpus | permiso de estudio, sin empresa |

Separarlas no es una comodidad: es la única forma de que ninguna de las dos
mienta sobre a quién le corresponde el trabajo.

### D.3 Columnas de `work_queue`

Cada una con su justificación. **Las que no se pueden derivar objetivamente no
están.**

| Columna | Tipo | De dónde sale |
|---|---|---|
| `company_id` | `uuid NOT NULL` | de la tabla que conduce la rama. Nunca fabricado |
| `categoria` | `text` | una de las siete de C.2 |
| `entidad` | `text` | nombre de la tabla de origen: `documents`, `tax_transactions`, … |
| `entity_id` | `uuid` | la PK de la fila de origen |
| `estado` | `text` | **el estado real de la fila**, sin traducir: `RECIBIDO`, `EMITIDA`, `BORRADOR` |
| `motivo` | `text` | frase corta derivada de la condición, no un texto libre almacenado |
| `bloquea` | `boolean` | `true` solo donde el dominio ya tiene un `bloquea` o un candado equivalente |
| `evidencia_faltante` | `text[]` | qué evidencia concreta falta, cuando la condición lo sabe |
| `origen` | `text` | `SISTEMA`, `IA`, `PROFESIONAL`, `ARCA` — de dónde vino el dato que está pendiente |
| `creado_en` | `timestamptz` | timestamp de la fila de origen (`received_at`, `created_at`, `detectado_el`) |
| `actualizado_en` | `timestamptz` | `updated_at` donde existe; si no, igual a `creado_en` |
| `fecha_limite` | `date` **nullable** | **solo** donde el esquema tiene una fecha real |
| `severidad` | `text` **nullable** | **solo** para `alerts`, que ya la tiene declarada |
| `traza_ref` | `text` | ruta HTTP que lleva a la entidad original |

### D.4 Lo que deliberadamente NO tiene

**No hay columna `prioridad`.** No existe fundamento objetivo para ordenar un
documento sin extraer contra una nota sin evidencia. Inventar `alta/media/baja`
sería exactamente el tipo de dato que después alguien cita como si significara
algo.

Lo que sí existe se expone tal cual:

- **`fecha_limite`** solo tiene tres orígenes reales en el esquema:
  `vat_books.vencimiento`, `periods.end_date` y `fiscal_years.end_date`. En el
  resto es `NULL`, y `NULL` significa «no hay plazo», no «plazo desconocido».
- **`severidad`** solo la tiene `alerts`, porque `alerts.severity` es una columna
  con CHECK de cuatro valores que alguien ya decidió. Copiarla a las demás ramas
  sería inventarla.

**El orden por defecto es cronológico**: `creado_en DESC`. Lo más viejo sin
resolver es lo que más tiempo lleva sin resolverse, y eso es un hecho.

**No hay estado propio de la cola.** No hay `work_queue.status`, no hay
`resuelto_en`, no hay `asignado_a`. Un ítem desaparece cuando su condición deja
de cumplirse. Asignación de trabajo entre personas es un producto distinto y no
está en el alcance.

### D.5 Las ramas

Veintidós ramas identificadas, todas sobre estructura existente. Se enumeran con
su condición para que el día de la implementación no haya que redescubrirlas.

| # | Entidad | Condición | Categoría |
|---|---|---|---|
| 1 | `documents` | `status = 'RECIBIDO'` | `REQUIERE_REVISION` |
| 2 | `documents` + `document_extractions` | última extracción con `available = false` | `REQUIERE_FUENTE_EXTERNA` |
| 3 | `document_findings` | `bloquea` sobre la extracción vigente | `BLOQUEADO` |
| 4 | `document_duplicates` | `bloquea AND resolucion IS NULL` | `REQUIERE_CORRECCION` |
| 5 | `tax_transactions` | `constatacion_origen = 'NO_CONSULTADO'` | `REQUIERE_DECLARACION` |
| 6 | `tax_transactions` | `constatacion_origen = 'ORIGEN_NO_REGISTRADO'` | `REQUIERE_CORRECCION` |
| 7 | `tax_transactions` | `constatacion IN ('FAIL','WARN')` | `REQUIERE_CORRECCION` |
| 8 | `tax_transactions` | sin fila en `tax_affectations` | `REQUIERE_DECLARACION` |
| 9 | `tax_affectations` | `origen = 'SUGERIDA_POR_PRECEDENTE'` | `REQUIERE_DECLARACION` |
| 10 | `tax_transactions` | sin decisión no supersedida | `REQUIERE_REVISION` |
| 11 | `accounting_decisions` | `resultado = 'REQUIERE_REVISION' AND estado <> 'SUPERSEDIDA'` | `REQUIERE_REVISION` |
| 12 | `accounting_decisions` | `estado = 'EMITIDA'` con propuesta y sin asiento | `REQUIERE_APROBACION` |
| 13 | `journal_entries` | `status IN ('BORRADOR','PROPUESTO')` | `REQUIERE_APROBACION` |
| 14 | `ai_predictions` | vía `predictions_pendientes` (sin `ai_reviews`) | `REQUIERE_REVISION` |
| 15 | `notes` | `status = 'BORRADOR'` | `REQUIERE_APROBACION` |
| 16 | `notes` | `evidencia = 'INSUFFICIENT_EVIDENCE'` | `REQUIERE_EVIDENCIA` |
| 17 | `vat_books` | `status = 'PENDIENTE'` | `REQUIERE_APROBACION` + `fecha_limite` |
| 18 | `bank_reconciliations` | `status = 'BORRADOR'` | `REQUIERE_APROBACION` |
| 19 | `accounting_closures` | `status = 'EN_CURSO'` | `REQUIERE_APROBACION` |
| 20 | `periods` | `status = 'ABIERTO' AND end_date < current_date` | `REQUIERE_APROBACION` + `fecha_limite` |
| 21 | `alerts` | `status = 'ABIERTA'` | según `kind`, con `severidad` |
| 22 | `audit_findings` | `estado = 'ABIERTO'` | `REQUIERE_CORRECCION` |

Las ramas 21 y 22 son las **registradas**; las otras veinte son proyecciones.

Las ramas 21 y 22 devolverán cero filas el día uno, porque nada las escribe. **Eso
es correcto y hay que dejarlo así**: conectar la lectura no autoriza a inventar
escritores. Qué las escribe es una decisión de producto, y está en la sección J.

### D.6 El costo, dicho de frente

Veintidós ramas de `UNION ALL` sobre tablas con RLS no es gratis. Dos mitigaciones,
las dos apoyadas en lo que ya existe:

- **Filtro obligatorio de categoría o entidad.** El endpoint no admite «traeme
  todo»: pide al menos un eje. Cada rama se puede podar antes de ejecutarse.
- **Los índices parciales que ya están.** `alerts (company_id, severity) WHERE
  status = 'ABIERTA'`, `journal_entries (company_id, fiscal_year_id) WHERE kind =
  … AND status = …`, `accounting_decisions (tax_transaction_id) WHERE estado <>
  'SUPERSEDIDA'`. Varias ramas ya tienen su índice esperándolas.

Si con el primer piloto la vista no rinde, la salida **no** es materializarla en
una tabla `tasks`: es una `MATERIALIZED VIEW` con refresco explícito, que sigue
teniendo una sola fuente de verdad. Esa decisión se toma con números, no ahora.

---

## E · Mapa de endpoints faltantes

Cuatro. Ninguno se implementa en esta fase.

### E.1 `GET /companies` — las empresas del usuario

| | |
|---|---|
| **Qué falta** | no existe ninguna ruta que enumere empresas. La consola llama a `GET /organizations/:id/companies`, que devuelve **404** |
| **Entidad** | `companies` ⋈ `user_company_roles` ⋈ `organizations` |
| **Contexto** | **sin `X-Company-Id`** — es la ruta que uno usa *antes* de tener empresa |
| **Autorización** | `requireAuth` + pertenencia real: `user_company_roles.user_id = actor`. **No** `requirePermission`: no hay empresa en contexto sobre la cual resolver un permiso |
| **Devuelve** | `id`, `legalName`, `cuit`, `entityType`, `jurisdiction`, `regulator`, `status`, `roles[]` del usuario en esa empresa |
| **Filtros** | `organizationId` opcional, `soloActivas` por defecto `true` |
| **Oculta** | empresas `ARCHIVED` salvo pedido explícito; empresas donde el usuario no tiene rol, **siempre** |
| **Sin resultados** | `200` con `{ companies: [] }`. Un usuario sin empresas no es un error |
| **Aislamiento** | es la ruta más delicada de las cuatro: corre sin empresa en contexto, así que **RLS no la protege**. El filtro es el `JOIN` con `user_company_roles` por `user_id`, igual que hace hoy `GET /organizations` con `organization_members` |
| **Tests** | (a) A y B en el mismo estudio, sin rol cruzado, no se ven; (b) A con rol en dos empresas ve exactamente dos; (c) sin sesión → 401; (d) el `organizationId` de otro estudio no filtra hacia adentro |

> **Nota de diseño.** `withoutCompany` no es un modo permisivo: es el modo en que
> las tablas con RLS devuelven **cero filas**. Por eso la consulta se apoya en
> `user_company_roles`, que tiene RLS por `company_id` y sin contexto devuelve
> vacío. La implementación tiene que resolver esto igual que ADR-011 —
> probablemente una función `SECURITY DEFINER` acotada, en la línea de
> ADR-010, o consultando `organization_members` que no tiene RLS. **Esta es la
> única decisión de la FASE 3 que roza la superficie privilegiada y debe
> revisarse de a una.**

### E.2 `GET /tax-transactions` — las operaciones fiscales

| | |
|---|---|
| **Entidad** | `tax_transactions`, con `LEFT JOIN` a `tax_affectations` y a la decisión vigente |
| **Permiso** | **no existe `tax_transaction:read`.** Hay que decidir: crearlo (migración de catálogo, sin tocar candados) o reutilizar `document:read`. **Recomendación: crearlo**, porque una operación fiscal no es un documento y los roles no coinciden — `USUARIO_EMPRESA` tiene `document:read` y no debería ver el libro de compras |
| **Filtros** | `direccion`, `desde`/`hasta` sobre `cbte_fecha`, `cuitContraparte`, `constatacion`, `constatacionOrigen`, `conAfectacion`, `conDecision`, `periodo` |
| **Índice** | `tax_transactions (company_id, direction, cbte_fecha)` ya existe y cubre el caso principal |
| **Devuelve** | identificación del comprobante, importes, `constatacion` **y** `constatacion_origen` — los dos, nunca fundidos en uno |
| **Oculta** | nada de la propia empresa. Un contador ve todo lo suyo |
| **Sin resultados** | `200` con lista vacía y el eco de los filtros aplicados |
| **Tests** | los `JOIN` llevan `AND x.company_id = y.company_id`; una operación de otra empresa no aparece ni con su `id` exacto en el filtro |

### E.3 `GET /work-queue` — la bandeja

| | |
|---|---|
| **Entidad** | la vista `work_queue` de la sección D |
| **Permiso** | `report:read` para leer. Las **acciones** siguen exigiendo su permiso propio: `alert:acknowledge` para reconocer, `journal_entry:approve` para aprobar |
| **Filtros** | `categoria`, `entidad`, `bloquea`, `desde`/`hasta`. **Al menos uno de `categoria` o `entidad` es obligatorio** (sección D.6) |
| **Devuelve** | las catorce columnas de D.3, más un `resumen` con el conteo por categoría |
| **Oculta** | todo lo de otras empresas, por RLS; y lo normativo, que va por su propia ruta |
| **Sin resultados** | `200` con `{ items: [], resumen: {} }`. **Bandeja vacía es una respuesta valiosa**, no un 404 |
| **Tests** | (a) cada rama devuelve solo filas de la empresa en contexto; (b) el barrido S-9 exige `security_invoker` — automático; (c) una rama nueva sin `company_id` en su `SELECT` debe romper el test; (d) el conteo del resumen coincide con el largo de la lista |

Y por separado, **`GET /normative-queue`**: sin empresa en contexto, permiso
`norm_watch:read` (ya declarado, ya asignado a tres roles, hoy sin uso).

### E.4 Paginación en los listados existentes

Se agrega a `GET /documents`, `GET /journal-entries`, `GET /tax-transactions` y
`GET /work-queue`. Ver sección G.

---

## F · Modelo de aislamiento

### F.1 Las cinco reglas

**1. La vista declara `security_invoker`.**

```sql
CREATE VIEW work_queue WITH (security_invoker = true) AS …
```

Sin esto la vista corre con los privilegios de su dueño y **el RLS de las tablas
que consulta no se evalúa**: la tabla protege y la vista reparte. Es el defecto
que tenía `documents_pendientes` desde la `0016`.

Esto **no necesita un test nuevo**: `tests/security/vistas-rls.test.ts` le
pregunta al catálogo cuáles son todas las vistas y cuáles tocan tablas con RLS
forzado, así que una vista nueva entra al barrido sola. Es el ejemplo de un gate
que ya paga su costo.

**2. Cada `JOIN` lleva la igualdad de empresa explícita.**

```sql
JOIN tax_transactions t ON t.id = a.tax_transaction_id
                       AND t.company_id = a.company_id   -- ← imprescindible
```

Es el patrón que ya usa `tax_affectations_declaradas`. Cinturón y tiradores: RLS
filtra, y aunque no filtrara, la condición del `JOIN` hace imposible una fila
cruzada. Con veinte ramas, la disciplina de escribirlo siempre vale más que el
razonamiento caso por caso.

**3. Ninguna rama fabrica un `company_id`.** Si la tabla no lo tiene, la rama no
va en `work_queue`. Sin excepciones. Es la razón de `normative_queue`.

**4. El cursor no transporta la empresa.** Ver G.4.

**5. Los `id` de otra empresa se comportan como inexistentes.** Ya es el
comportamiento del sistema —RLS devuelve cero filas y las rutas responden 404, no
403— y las rutas nuevas lo heredan por construcción.

### F.2 Relaciones indirectas: dónde puede filtrarse

Tres uniones del inventario **no** tienen FK compuesta con `company_id`, y son las
que hay que mirar:

| Unión | Riesgo | Mitigación |
|---|---|---|
| `document_findings.extraction_id → document_extractions` | ambas tienen `company_id` y RLS, pero la FK es solo por `id` | agregar `AND f.company_id = e.company_id` |
| `alerts.object_id` (polimórfico, sin FK) | apunta a cualquier tabla vía `object_type`; **no hay integridad referencial** | la rama nunca hace `JOIN` por `object_id`: expone `object_type`/`object_id` como referencia opaca y el cliente navega por su ruta, que revalida |
| `audit_findings.entry_id → journal_entries` | FK simple | `AND af.company_id = je.company_id` |

El caso de `alerts.object_id` es el único que **no se resuelve con una condición
de `JOIN`**, porque no hay FK que reforzar. La decisión de diseño es no seguirlo
desde la vista: la bandeja dice «hay una alerta sobre el asiento X» y el clic va a
`GET /journal-entries` con su propio control. Un puntero sin FK no se dereferencia
dentro de una vista de seguridad.

### F.3 Quién ejecuta

Todo corre como `aai_app`, que tiene `NOBYPASSRLS`. `withCompany` fija
`app.company_id` y `app.actor_id` para la transacción; la política de cada tabla
compara contra `app_company_id()`. **La empresa nunca sale del cuerpo del
pedido**: sale de `X-Company-Id`, que `requireCompany` valida contra
`user_company_roles` —bajo RLS, con la empresa ya fijada, según ADR-011— antes de
resolver un solo permiso.

Ninguna de las cuatro rutas nuevas cambia nada de esto. `GET /companies` es la
única que corre fuera de ese marco, y por eso se marca como la que hay que
revisar de a una.

---

## G · Modelo de cursor

### G.1 Por qué no `OFFSET`

`OFFSET` sobre una lista ordenada por fecha descendente **salta y repite** filas
cuando llegan inserciones concurrentes: si entran tres documentos mientras el
usuario mira la página 1, la página 2 empieza tres filas más atrás y tres se
pierden. En un sistema donde no ver un comprobante tiene consecuencias, eso es
inaceptable. Además, el costo crece linealmente: la base lee y descarta todo lo
salteado.

### G.2 La clave

Cursor por **keyset** sobre `(campo_de_negocio, id)`.

| Endpoint | Orden | Por qué ese campo |
|---|---|---|
| `GET /documents` | `(received_at DESC, id DESC)` | es el orden que ya usa el endpoint |
| `GET /tax-transactions` | `(cbte_fecha DESC, id DESC)` | la fecha del comprobante es lo que el contador lee |
| `GET /journal-entries` | `(entry_date DESC, id DESC)` | ídem, y ya está ordenado así |
| `GET /work-queue` | `(creado_en DESC, entity_id DESC)` | lo más viejo sin resolver primero |

**Por qué el `id` como desempate.** Todos los `id` son **UUIDv7**: 48 bits de
timestamp en milisegundos más aleatoriedad. Eso da dos propiedades que el cursor
necesita:

- **Totalidad.** `received_at` puede empatar; `(received_at, id)` no puede,
  porque `id` es único. Sin empates no hay filas repetidas ni saltadas.
- **Correlación temporal.** El desempate no es arbitrario: ordena aproximadamente
  por inserción, así que la página siguiente es la continuación natural.

Lo que **no** hay que suponer: que UUIDv7 ordena estrictamente por inserción
dentro del mismo milisegundo. No lo hace —la cola es aleatoria— y no hace falta.
Lo que el cursor necesita es un orden **total y estable**, y la comparación de dos
uuid lo es.

### G.3 El predicado

```sql
WHERE company_id = app_company_id()
  AND (received_at, id) < ($cursor_fecha, $cursor_id)
ORDER BY received_at DESC, id DESC
LIMIT $limite + 1
```

Se pide una fila de más para saber si hay página siguiente sin contar el total.
La comparación de tuplas de PostgreSQL es exactamente la semántica que hace falta.

### G.4 El cursor no lleva la empresa

**Regla dura.** El cursor codifica `received_at` e `id`, y **nada más**. Si
llevara `company_id`, existirían dos canales para decir a qué empresa pertenece un
pedido —la cabecera y el cursor— y algún día no van a coincidir. La empresa sale
de `X-Company-Id` y la filtra RLS, siempre.

Se transmite como base64url de `<iso8601>|<uuid>`, opaco para el cliente. No se
firma: un cursor manipulado solo puede pedir otra posición **dentro de la misma
empresa**, porque el `WHERE` de empresa lo pone el servidor y RLS lo refuerza. Un
cursor mal formado se rechaza con 400.

### G.5 Índices

| Índice | Estado |
|---|---|
| `documents (company_id, received_at DESC)` | **existe** — cubre las columnas líderes; el keyset por `(received_at, id)` funciona pero ordena el desempate fuera del índice |
| `tax_transactions (company_id, direction, cbte_fecha)` | **existe** — óptimo filtrando por `direction`; sin ese filtro, la base salta el segundo nivel |
| `journal_entries (company_id, entry_date)` | **existe** — mismo caso que `documents` |

**Recomendación para FASE 3:** extender los tres a incluir `id` como última
columna del índice. Es una migración **que solo agrega índices**: no toca una
constraint, un trigger, una política ni una columna. Es el único cambio de esquema
que la FASE 3 necesita, y conviene medir con datos del piloto antes de hacerlo:
con volúmenes de un estudio chico, el orden fuera del índice puede ser
irrelevante.

### G.6 Contrato de respuesta

```
{
  "items":   [ … ],
  "cursor":  "MjAyNi0wOC0yOVQx…" | null,   // null = no hay más
  "limite":  50
}
```

**No se devuelve `total`.** Contarlo exige un segundo barrido de la tabla en cada
página y, en una lista que crece mientras se la mira, es un número que envejece
antes de llegar al cliente. Si el piloto lo pide, se agrega como campo opcional
detrás de un parámetro explícito.

---

## H · Flujo humano

### H.1 Derivado del modelo, no supuesto

```
INGRESA
   │  POST /auth/login  →  MFA
   ▼
ELIGE EMPRESA                          ← hoy IMPOSIBLE: falta GET /companies
   │  la empresa queda en X-Company-Id y viaja en cada pedido
   ▼
VE SU BANDEJA                          ← hoy IMPOSIBLE: falta work_queue
   │  GET /work-queue?categoria=…
   │  cada ítem dice: qué entidad, qué estado, por qué aparece
   ▼
ABRE UN ÍTEM
   │  traza_ref lleva a la entidad real, que revalida permiso y empresa
   ▼
ENTIENDE POR QUÉ ESTÁ PENDIENTE
   │  el motivo sale de la condición, no de un texto guardado
   ▼
MIRA LA EVIDENCIA
   │  GET /documents/:id/content · el PDF original con su hash
   ▼
HACE LO QUE SU ROL PERMITE
   │  declarar · decidir · corregir · aprobar · reconocer
   ▼
QUEDA AUDITADO
   │  recordAudit() o el trigger de la tabla. audit_logs encadenado por hash
   ▼
EL ÍTEM DESAPARECE DE LA BANDEJA
   │  porque la condición dejó de cumplirse — no porque alguien lo marcó
   ▼
LA OPERACIÓN SIGUE
```

**El eslabón que hace correcto a este flujo es el penúltimo.** El ítem no se
«cierra»: deja de existir porque el hecho cambió. Nadie puede sacar algo de la
bandeja sin resolverlo, porque no hay un botón que lo saque.

Las dos excepciones son las registradas: una alerta se reconoce y un hallazgo se
marca revisado, y en ambos casos **la base exige nombre y motivo** — no es un
«marcar como leído».

### H.2 Qué puede resolver una persona

Todo lo que dependa de un dato o de un juicio que ya tiene: registrar la
operación, declarar la afectación con su evidencia, decidir a mano con
justificación escrita, corregir con `supersede` y motivo, aprobar el asiento,
resolver un duplicado, reconocer una alerta, dar por revisado un hallazgo,
bloquear y cerrar un período.

### H.3 Qué no puede resolver nadie desde adentro

| Pendiente | Qué falta | Categoría |
|---|---|---|
| Documento con `SIN_MOTOR_OCR` | un motor de OCR | `REQUIERE_FUENTE_EXTERNA` |
| Comprobante que exige constatación de ARCA | autorización de `wscdc` en WSASS | `REQUIERE_FUENTE_EXTERNA` |
| Regla en `DRAFT` bloqueada por un hueco | el articulado del Decreto 280/1997 | `REQUIERE_FUENTE_EXTERNA` |
| Empresa fuera de CABA | el acto de adopción de su consejo | `REQUIERE_FUENTE_EXTERNA` |

La bandeja **debe mostrarlos igual**, con la fuente que falta nombrada. Un
pendiente que no se puede resolver sigue siendo información: lo que no se puede
es hacerlo desaparecer fingiendo que se resolvió.

### H.4 Qué exige doble firma

Dos cosas, y las dos ya están en la base:

- **Activar una regla normativa.** Para llegar a `ACTIVE`, `accounting_rules`
  exige `approved_by` y `approved_at`; y un segundo CHECK
  —`approved_by <> proposed_by`— impide que el aprobador sea el proponente. Es el
  §32 escrito en la base. `rule:activate` no lo tiene ningún rol.
- **Reabrir un período cerrado.** `periods.reopened_countersigned_by` y
  `reopen_reason`, exigidos por el trigger `periods_transicion_valida` en la misma
  sentencia que la reapertura.

### H.5 Qué exige evidencia

`tax_affectations` no admite una fila sin evidencia verificable: el trigger
`tax_affectations_evidence_exists` resuelve por `CASE tipo` sobre seis catálogos
—`COMPROBANTE`, `CUENTA`, `CENTRO_DE_COSTO`, `DOCUMENTO`, `ASIENTO`,
`DECLARACION_PROFESIONAL`— y en **cada uno** comprueba que el `id` citado exista
`AND company_id = NEW.company_id`: la evidencia no puede cruzar de empresa ni
aunque quien la escriba conozca el `id` ajeno. Una decisión `MANUAL`
exige `justificacion` y la base le prohíbe citar reglas. Una corrección de
decisión exige un motivo de 30 caracteres.

---

## I · Fronteras IA / humano

**ADR-001 se aplica sin excepción y sin matices.** La bandeja es una superficie de
lectura; no puede convertirse en el lugar donde una sugerencia se vuelve un hecho.

### I.1 Lo que la bandeja puede mostrar

- una predicción de `ai_predictions`, con su `confidence`, su `triage_band`, su
  `model_provider`, su `model_id` y su `prompt_hash`;
- una extracción, con el valor crudo al lado del interpretado y el `method` de
  cada campo;
- una afectación con `origen = 'SUGERIDA_POR_PRECEDENTE'`, **etiquetada como
  sugerencia**;
- una nota con `generated_by = 'AI'` en estado `BORRADOR`.

### I.2 Lo que no puede hacer, nunca

| Prohibido | Qué lo impide hoy |
|---|---|
| Convertir una sugerencia en declaración profesional | `tax_affectations_declaradas` excluye `SUGERIDA_POR_PRECEDENTE`, y el motor solo lee esa vista |
| Convertir una predicción en decisión | `origen = 'PROPUESTA_IA'` exige `ai_prediction_id NOT NULL`, y a la inversa |
| Que la IA apruebe un asiento | CHECK: con `ai_prediction_id`, el asiento solo puede estar `BORRADOR`/`PROPUESTO` salvo que tenga `approved_by` |
| Que la IA apruebe una nota | CHECK: `generated_by = 'AI'` obliga a `BORRADOR` o a tener `approved_by` |
| Que la IA escriba en el motor contable | ADR-001, verificado por `depcruise` y por tres tests que rompen el lint a propósito |
| Que el aprendizaje toque la normativa | ADR-007: `classification_preferences` solo afecta cuenta sugerida y confianza |

### I.3 La regla de diseño de la bandeja

> **Un ítem propuesto por una máquina y uno declarado por una persona nunca
> comparten fila, nunca comparten color y nunca comparten verbo.**

La columna `origen` de la vista existe para esto. Una acción de aprobación en lote
—cuando exista— **no puede** operar sobre ítems con `origen = 'IA'` sin abrir cada
uno: lo que se aprueba en lote son cosas ya revisadas, y revisar es mirar.

---

## J · Alerts, findings y normativa

Cinco estructuras, **cuatro destinos distintos**. Se evalúan contra las opciones
planteadas (A directo en bandeja · B vista derivada · C herramienta interna ·
D fase futura · E requiere decisión de producto).

### `alerts` → **A, con E previa**

Va **directo a la bandeja**: tiene `company_id`, RLS, severidad declarada,
permisos asignados y un CHECK que impide cerrarla sin nombre y motivo. Es un
pendiente registrado en el sentido de C.1 y no hay que modelar nada.

**Pero requiere una decisión de producto antes de conectarla: ¿qué la escribe?**
Hoy nada. Candidatos que el sistema ya podría detectar —el asiento tardío, la
variación significativa, el hash de un documento que no coincide— **ya los calcula
`packages/audit-engine`**. Conectar la lectura sin decidir la escritura deja una
bandeja siempre vacía; decidir la escritura sin cuidado convierte la bandeja en
ruido. Esa decisión no es técnica.

### `audit_findings` → **A, con E previa**

Mismo caso, con una diferencia importante: **su catálogo de códigos ya está
cerrado y es específico** — `IMPORTE_ATIPICO`, `IMPORTE_REDONDO`,
`JUSTO_BAJO_UMBRAL`, `ASIENTO_TARDIO`, `VARIACION_SIGNIFICATIVA` — y
`packages/audit-engine` los produce hoy en memoria, con 28 tests. Lo único que
falta es persistirlos y leerlos.

Va a la bandeja como `REQUIERE_CORRECCION`, con su `estado ∈ {ABIERTO,
REVISADO_SIN_ACCION, CORREGIDO}`, que **ya distingue** «lo miré y está bien» de
«lo corregí». Los permisos `audit_finding:read` y `audit_finding:review` existen y
están otorgados.

### `normative_gaps` → **B**

Vista derivada, en **`normative_queue`**, no en `work_queue`. No tiene
`company_id` y no debe tenerlo. Es el único de los cinco que **ya tiene endpoint**
(`GET /normative/gaps`) y ya se usa.

### `normative_conflicts` y `normative_updates` → **D**

**Fase futura.** Ambas sin `company_id`, sin RLS y sin escritor. `normative_updates`
tiene un ciclo de seis estados —`DETECTADA → DESCARGADA → ANALIZADA → EN_REVISION
→ APROBADA | RECHAZADA`— que describe un proceso de mantenimiento normativo
completo que **todavía no existe**. Conectarlo ahora sería exponer una máquina de
estados que nadie hace avanzar.

`normative_conflicts` tiene un problema anterior: para que haya un conflicto entre
la regla A y la regla B hacen falta dos reglas. Hay una, y está en `DRAFT`.

### `norm_candidates` → **C, hoy; B, después**

**Herramienta interna** por ahora. `npm run norms:watch` funciona, compara lo
publicado contra lo archivado y **lo imprime por pantalla**. La tabla existe y no
recibe filas.

El día que se persistan, van a `normative_queue` con los permisos que ya están
declarados (`norm_watch:read`, `norm_watch:dismiss`) y con la garantía que el
propio motor escribió y que hay que preservar entera:

> Un candidato no tiene `norm_version_id`, no se puede citar, no entra al motor de
> resolución y no aparece en ningún contexto de IA.

### Resumen

| Estructura | Destino | Qué falta |
|---|---|---|
| `alerts` | bandeja de empresa | decidir qué la escribe |
| `audit_findings` | bandeja de empresa | persistir lo que `audit-engine` ya calcula |
| `normative_gaps` | bandeja normativa | nada: ya tiene ruta |
| `normative_conflicts` | fase futura | dos reglas activas para poder chocar |
| `normative_updates` | fase futura | el proceso de mantenimiento normativo |
| `norm_candidates` | interna hoy | persistir la salida de `norms:watch` |

---

## K · Dependencias externas

Separadas por naturaleza, porque se destraban de formas distintas.

### K.1 Bloqueantes técnicos — dependen solo de nosotros

| | |
|---|---|
| `GET /companies` | FASE 3, paso 1 |
| `GET /tax-transactions` | FASE 3, paso 3 |
| `work_queue` + `GET /work-queue` | FASE 3, paso 4 |
| Cursor en los listados | FASE 3, paso 2 |
| Persistir `audit_findings` desde `audit-engine` | después de J |
| Lector de `audit_logs` (`audit:read`) | fase posterior |

### K.2 Decisiones de producto — dependen de una elección

| | Pregunta abierta |
|---|---|
| Escritores de `alerts` | ¿qué condiciones merecen una alerta persistente y no una proyección? |
| Aprobación en lote | ¿sobre qué categorías, y con qué umbral? Nunca sobre `origen = 'IA'` sin abrir |
| Permiso `tax_transaction:read` | crearlo o reutilizar `document:read` |
| Motor de OCR | cuál |
| Exportación PDF / Excel | alcance |

### K.3 Trámites externos — dependen de un tercero

Autorización de `wscdc` en WSASS · certificado X.509 productivo · contratación de
un KMS · remoto git y runner de CI.

### K.4 Fuentes normativas — dependen de un documento y de una firma

Decreto 280/1997 completo · actos de adopción de los consejos fuera de CABA ·
RT 6 e índices · juego obligatorio de notas · normativa de los otros tipos de ente
· firma de un matriculado (§32).

**Ninguna de las cuatro clases bloquea a las otras.** Los seis ítems de K.1 se
pueden hacer hoy sin esperar a nada.

---

## L · Plan de FASE 3

Orden exacto. Cada paso termina con sus tests y **no avanza solo**.

### Paso 1 · `GET /companies`

Primero porque **desbloquea todo lo demás**: sin elegir empresa no hay contexto y
sin contexto no hay nada que listar.

Es también el más delicado: corre sin empresa en contexto, así que RLS no lo
protege y el filtro tiene que ser la pertenencia. Se resuelve en la línea de
ADR-010/ADR-011 y **se revisa de a uno**. Cuatro tests de aislamiento (E.1).

**Riesgo:** si se resuelve aflojando una política en vez de acotando la consulta,
se reabre exactamente la fuga que ADR-010 evitó. Es el punto donde hay que
detenerse a mirar.

### Paso 2 · Cursor en `GET /documents` y `GET /journal-entries`

Antes de agregar listados nuevos, porque el contrato de paginación tiene que
existir una sola vez y aplicarse igual en todos. Sin migración: los índices
actuales alcanzan para empezar (G.5).

**Riesgo:** bajo. Cambia una respuesta existente; los tests que hoy leen
`documentos` siguen leyendo `documentos`, y `cursor` es aditivo.

### Paso 3 · `GET /tax-transactions`

Con el cursor del paso 2 desde el primer día. Requiere decidir el permiso (K.2).

**Riesgo:** los `JOIN` a afectación y decisión son el primer lugar donde una
consulta nueva puede cruzar empresas. Regla 2 de F.1, y un test que lo pruebe con
dos empresas que tengan operaciones con los mismos importes y fechas.

### Paso 4 · La vista `work_queue` y su endpoint

El más grande, y va último porque **consume todo lo anterior**. Se implementa por
tramos: primero las ramas de documento y circuito fiscal (1–14), después las de
cierre (15–20), y las registradas (21–22) al final —devolviendo cero filas, que es
la respuesta correcta hasta que J se decida.

**Riesgo:** que una rama nueva no filtre por empresa. El barrido S-9 cubre
`security_invoker` automáticamente; hace falta un test propio que recorra las
ramas y verifique que cada una devuelve solo filas de la empresa en contexto.

### Paso 5 · `GET /normative-queue`

Chico y desacoplado. Envuelve `normative_gaps` con el permiso `norm_watch:read`
que ya está declarado.

### Lo que la FASE 3 NO hace

No crea `tasks`. No escribe `alerts` ni `audit_findings`. No conecta un LLM. No
activa reglas. No toca RLS, triggers, constraints ni catálogos cerrados. No
implementa OCR, sueldos, WSASS, KMS ni padrón. No construye frontend: la consola
consumirá estas rutas en la FASE 4.

### Criterio de terminación

`ci:desde-cero` en 0, cobertura sin caer, `audit:invariants` sin ningún invariante
en `NOT_EXERCISED`, y **un test que pruebe que la consola puede elegir una empresa
y listar una bandeja** — que es lo que hoy no puede hacer.

---

## Apéndice · Liquidación de sueldos

**No se implementa nada, y ADR-012 no se modifica.** Se contrastó punto por punto
contra el esquema en la FASE 1 y no hay contradicción: los tres puntos de contacto
que el ADR anticipa siguen siendo tres valores en catálogos cerrados
(`source_type` necesitaría `PAYROLL`, la evidencia necesitaría `LIQUIDACION`,
`accounting_decisions.origen` necesitaría `LIQUIDACION`), y `journals` ya prevé el
libro `SUELDOS` desde la migración `0004`.

Lo único que este documento agrega es una consecuencia del modelo de acá:

> Cuando exista, el dominio de sueldos **producirá pendientes**, y encajan sin
> tocar nada: «liquidación calculada sin aprobar» es `REQUIERE_APROBACION`,
> «sin escala salarial archivada a la fecha» es `REQUIERE_FUENTE_EXTERNA`, y
> «liquidación corregida por otra que la supersede» es `REQUIERE_CORRECCION`.
> Serían ramas nuevas de `work_queue` sobre tablas del esquema `payroll.*`, con su
> propio `company_id` y su propio RLS.

Que las tres categorías ya existan sin haber pensado en sueldos es evidencia a
favor de que se derivaron del dominio y no de una abstracción. **Y no autoriza a
escribir una línea de sueldos**: reutilizar la bandeja no es reutilizar el motor
fiscal, y la separación de ADR-012 §3 se mantiene entera.

---

---

## Addenda · Qué cambió al implementarlo (FASE 3)

Este documento se escribió antes de escribir el código. Cinco cosas resultaron
distintas al hacerlo, y quedan acá porque un diseño que no registra sus
correcciones es una ficción prolija.

### 1. `tax_transaction:read` no se creó — se reutilizó `journal_entry:read`

§E.2 recomendaba crear el permiso. **Estaba mal.** Al implementar apareció que
todas las lecturas de una operación fiscal ya exigen `journal_entry:read`:
`GET /documents/:id/tax-transaction`, `GET /tax-transactions/:id/afectacion`,
`GET /comprobantes/:id/decision` y su historial. En este esquema ese permiso
significa «leer la cadena contable y fiscal».

Y da exactamente el corte que se buscaba: lo tienen ADMINISTRADOR, AUDITOR,
CONTADOR y SOLO_LECTURA, y **no** USUARIO_EMPRESA ni CARGADOR. Crear uno nuevo
habría dejado dos permisos para la misma pregunta y una ruta incoherente con las
otras cuatro.

### 2. La clave del ítem necesitaba la rama, no la categoría

§D.3 daba por sentado que `(entidad, categoría, entity_id)` identificaba un ítem.
**Lo rompió un test**: las ramas 5 y 8 —«sin constatar» y «sin afectación»— son
las dos `REQUIERE_DECLARACION` sobre `tax_transactions`, así que dos pendientes
distintos de la misma operación colapsaban en un solo `item_id` y el cursor
perdía filas.

La vista lleva ahora una columna `rama` con un código estable por rama
(`OPERACION_SIN_CONSTATAR`, `OPERACION_SIN_AFECTACION`, …) e `item_id` es el hash
de `(rama, entity_id)`. La categoría dice *qué falta en general*; la rama
identifica *cuál* pendiente es.

### 3. `alerts` y `audit_findings` no son ramas todavía

§D.5 las listaba como ramas 21 y 22. No se implementaron, y no por olvido: hoy no
las escribe nada en producción (§B.5). Una rama que solo puede devolver cero
filas afirma que la bandeja cubre las alertas, y no las cubre. Entran el día que
exista un escritor, con su test.

Por lo mismo, la vista **no tiene columna `severidad`**: su única fuente sería
`alerts`. Una columna siempre en `NULL` es una promesa que el dato no cumple.

### 4. `GET /normative-queue` no se implementó

§E.3 lo proponía como superficie separada. La separación que el diseño exige
—que lo normativo no entre en `work_queue`— **está cumplida**: `work_queue` solo
tiene ramas con `company_id`. Pero el contenido de esa cola es hoy
`normative_gaps`, y ya tiene endpoint: `GET /normative/gaps`, con `rule:read`.

Agregar un segundo nombre para los mismos datos habría sido exactamente la
duplicación que este documento argumenta en contra. Se conecta el endpoint que ya
existe.

### 5. Defecto encontrado y **no** corregido: nadie escribe `IMPUTADO`

**Qué pasa.** `documents.status` admite cinco valores desde la migración `0016`, y
uno de ellos —`IMPUTADO`, «este documento ya produjo su operación fiscal»— **no lo
escribe nada**. `grep -rn "SET status = 'IMPUTADO'"` sobre el repositorio entero
no devuelve una sola línea. Lo único que lo menciona es un guard del camino de
anulación (`WHERE ... status <> 'IMPUTADO'`) y `documents_pendientes`, que lo
excluye.

**Impacto.** Un documento que ya produjo su operación fiscal se queda en
`EXTRAIDO` para siempre. Consecuencias medidas:

- `documents_pendientes` —y por lo tanto `GET /documents`— lo sigue tratando como
  no imputado;
- el guard `status <> 'IMPUTADO'` del camino de anulación nunca se activa: hoy se
  puede anular un documento que ya funda una operación fiscal;
- si la bandeja hubiera confiado en el estado, habría afirmado «documento sin
  operación fiscal registrada» sobre documentos que **sí la tienen**.

**Causa.** `POST /documents/:id/tax-transaction` crea la operación y no toca el
documento. El estado se pensó y no se conectó — el mismo patrón que este
repositorio ya nombró: estructura correcta, regla escrita, nadie recorriendo el
trecho.

**Cómo se evitó acá.** Las ramas 1 y 2 preguntan por el **hecho**
—`NOT EXISTS (SELECT 1 FROM tax_transactions …)`— y no por el rótulo. Un
pendiente falso es peor que uno que falta: enseña a no mirar la bandeja.

**Solución propuesta, no implementada.** Marcar `IMPUTADO` al crear la operación
fiscal, dentro de la misma transacción. Es un cambio del camino de **escritura** y
esta fase es de lectura; además hay que revisar antes qué hace el guard de
anulación cuando empiece a activarse de verdad, que es justamente la parte que
hoy nadie ejercitó. **No bloquea esta fase.**

### 6. Un permiso por rama, y no un permiso de bandeja

§E.3 proponía `report:read` como permiso de la ruta. Al mirar los roles se vio
que dejaba al CARGADOR sin ver sus propios documentos pendientes. La bandeja
consulta **solo las ramas cuyo permiso de lectura el usuario ya tiene**, con el
mismo permiso que exige la ruta que muestra esa entidad de a una. Un CARGADOR ve
documentos y no ve asientos; un usuario sin ningún permiso de lectura recibe una
bandeja vacía, que es la respuesta correcta y no un 403.

---

## Qué se decidió acá

1. **No hay tabla `tasks`.** La cola es una proyección; las dos piezas que
   necesitan persistencia ya existen y se llaman `alerts` y `audit_findings`.
2. **Dos bandejas, no una.** Lo que no tiene `company_id` no entra en la bandeja
   de empresa, porque asignarle una empresa sería afirmar algo falso.
3. **Sin prioridades inventadas.** Solo `fecha_limite` donde el esquema tiene una
   fecha y `severidad` donde la fila ya la trae. Orden cronológico.
4. **`INFORMATIVO` se descarta; `REQUIERE_APROBACION` se agrega.** La primera no
   tiene referente; la segunda es la categoría más frecuente de un estudio y
   faltaba.
5. **Cursor por keyset `(fecha, id)`, sin `company_id` adentro.** Un solo canal
   para decir de qué empresa es un pedido.
6. **Un ítem desaparece porque el hecho cambió**, no porque alguien lo marcó.
