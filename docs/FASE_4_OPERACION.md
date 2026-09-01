# FASE_4_OPERACION.md — de navegar el circuito a trabajar una empresa

> **Estado: auditoría y diseño. Nada de lo que está acá está implementado.**
>
> Documento de FASE 4. Contesta una sola pregunta:
>
> > ¿Puede un profesional usar NEXO como herramienta diaria para llevar una
> > empresa, sin perder pendientes, sin decidir sin evidencia, sin romper la
> > trazabilidad y sin cruzar información entre empresas?
>
> **La respuesta hoy es NO**, y la sección 11 dice exactamente qué falta. La
> parte buena es que casi nada de lo que falta es motor: es superficie, y tres
> defectos de coherencia que este documento demuestra.
>
> No crea tablas, no toca migraciones, no activa reglas y no implementa nada.

---

## 1 · Estado inicial

Punto de partida verificado al cierre de la FASE 3:

| | |
|---|---|
| Tests | 1311 en 67 archivos |
| `npm run verify` · `ci:desde-cero` | 0 · 0 |
| `audit:estructura` | 84/84 |
| `audit:invariants` | 11 verificados · 0 violados · **0 no ejercitados** · 3 vacuos |
| Cobertura | 84,02 % |
| Rutas HTTP | **94** |
| Permisos declarados | **50**, de los cuales **11 sin consumidor** |
| Migraciones | 45 · 84 tablas + 14 vistas |
| `AR-IVA-CF-VINCULACION-001.v1` | DRAFT · ACTIVE reales = 0 |

La consola alcanza **22 de las 94 rutas (23 %)**.

---

## 2 · Inventario de acciones

Las 94 rutas, agrupadas por entidad. «UI» significa que la consola la invoca.
«Humano» significa que el sistema no puede resolverla solo, por diseño.

### 2.1 Empresa y estudio

| Acción | Backend | UI | Permiso | Auditoría | Humano | Estado |
|---|---|---|---|---|---|---|
| Listar mis empresas | `GET /companies` | **sí** | membresía + `company:read` | — | no | READY |
| Ver la empresa activa | `GET /companies/current` | sí | `company:read` | — | no | READY |
| Crear estudio | `POST /organizations` | no | nivel de organización | **no** | sí | GAP TÉCNICO (auditoría) |
| Crear empresa | `POST /organizations/:id/companies` | no | nivel de organización | **no** | sí | GAP TÉCNICO (auditoría) |
| Alta de usuario | `POST /organizations/:id/users` | no | nivel de organización | **no** | sí | GAP TÉCNICO (auditoría) |
| Asignar rol | `POST /companies/:id/roles` | no | nivel de organización | trigger | sí | READY |
| **Quitar un rol** | **no existe** | no | — | — | sí | **GAP TÉCNICO** |
| **Dar de baja un usuario** | **no existe** | no | `user:manage` (sin consumidor) | — | sí | **GAP TÉCNICO** |
| Ver usuarios de la empresa | `GET /companies/current/users` | no | `user:read` | — | no | GAP UI |
| Fijar marco contable | `POST /companies/current/reporting-framework` | no | `company:write` | sí | sí | GAP UI |

### 2.2 Documentos y extracción

| Acción | Backend | UI | Permiso | Auditoría | Humano | Estado |
|---|---|---|---|---|---|---|
| Subir | `POST /documents` | sí | `document:upload` | sí | no | READY |
| Listar (cursor) | `GET /documents` | sí | `document:read` | — | no | READY |
| Ver detalle y campos | `GET /documents/:id` | sí | `document:read` | — | no | READY |
| Descargar el original | `GET /documents/:id/content` | **no** | `document:download` | — | no | **GAP UI** — es la evidencia |
| Re-extraer | `POST /documents/:id/extract` | sí | `document:upload` | sí | no | READY |
| Corregir un campo leído | `POST /documents/:id/fields` | **no** | `document:upload` | sí | sí | **GAP UI + permiso** |
| Resolver un duplicado | `POST /documents/:id/duplicates/:dupId` | **no** | `document:upload` | sí | sí | **GAP UI + permiso** |
| Clasificar con IA | `POST /documents/:id/classify` | no | `prediction:run` | sí | no | FUERA DEL MVP (sin LLM) |

### 2.3 Operaciones fiscales, constatación y afectación

| Acción | Backend | UI | Permiso | Auditoría | Humano | Estado |
|---|---|---|---|---|---|---|
| Registrar operación | `POST /documents/:id/tax-transaction` | sí | `journal_entry:create` | sí | sí | READY |
| Listar operaciones (cursor) | `GET /tax-transactions` | sí | `journal_entry:read` | — | no | READY |
| Ver una operación | `GET /documents/:id/tax-transaction` | sí | `journal_entry:read` | — | no | READY |
| **Corregir una operación** | **no existe** | no | — | — | sí | **GAP DE PRODUCTO** |
| Constatar contra ARCA | `POST /tax-transactions/:id/constatar` | sí | `tax_transaction:constatar` | sí | no | GAP EXTERNO (sin certificado) |
| Declarar afectación | `POST /tax-transactions/:id/afectacion` | sí | `tax_affectation:declare` | trigger | **sí** | READY |
| Ver afectación | `GET /tax-transactions/:id/afectacion` | sí | `journal_entry:read` | — | no | READY |
| **Corregir una afectación** | **no existe** | no | — | — | sí | **GAP DE PRODUCTO** |

### 2.4 Decisiones y asientos

| Acción | Backend | UI | Permiso | Auditoría | Humano | Estado |
|---|---|---|---|---|---|---|
| Emitir decisión | `POST /comprobantes/:id/decision` | sí | `journal_entry:create` | trigger + ruta | sí | READY |
| Ver decisión vigente | `GET /comprobantes/:id/decision` | sí | `journal_entry:read` | — | no | READY |
| Ver historial | `GET /comprobantes/:id/decision/historial` | sí | `journal_entry:read` | — | no | READY |
| Corregir (supersede) | `POST /comprobantes/:id/decision/supersede` | sí | `decision:supersede` | sí | sí | READY |
| Crear asiento | `POST /journal-entries` | sí | `journal_entry:create` | sí | sí | READY |
| **Listar asientos (cursor)** | `GET /journal-entries` | **no** | `journal_entry:read` | — | no | **GAP UI** |
| Aprobar asiento | `POST /journal-entries/:id/approve` | sí | `journal_entry:approve` | sí | **sí** | READY |
| Anular por contraasiento | `POST /journal-entries/:id/reverse` | **no** | `journal_entry:reverse` | sí + motivo | **sí** | **GAP UI** |

### 2.5 Libros, IVA y bancos

| Acción | Backend | UI | Permiso | Auditoría | Humano | Estado |
|---|---|---|---|---|---|---|
| Diario / Mayor / Balance | `GET /books/*`, `/reports/trial-balance` | sí (JSON crudo) | `report:read` | — | no | GAP UI |
| Exportar CSV | `GET /books/diario.csv`, `/mayor.csv` | **no** | `report:read` | — | no | **GAP UI** |
| Emitir libro con hash | `POST /books/emissions` | **no** | `book:emit` | sí | **sí** | **GAP UI** |
| Ver emisiones | `GET /books/emissions` | no | `report:read` | — | no | GAP UI |
| Trazar un movimiento | `GET /books/trace/:id` | **no** | `report:read` | — | no | **GAP UI** |
| Verificar Mayor vs Diario | `POST /books/ledger-verification` | no | **`report:read`** | **no** | no | **GAP TÉCNICO (permiso)** |
| Libro de IVA (ver/generar) | `GET`/`POST /vat/books/:a/:m` | no | `vat_book:read` / `:generate` | sí | no | GAP UI |
| Subdiarios, crédito fiscal | `GET /vat/subdiarios/…`, `/credito-fiscal/:id` | no | `vat_book:read` | — | no | GAP UI |
| Presentar el libro de IVA | `POST /vat/books/:a/:m/present` | no | `vat_book:generate` | — | — | **FUERA DEL MVP, declarado (501)** |
| Archivo de importación ARCA | `GET /vat/books/export-file` | no | `vat_book:read` | — | — | **GAP EXTERNO, declarado (501)** |
| Bancos (7 rutas) | `banks.ts` | **no** | `bank:*` | parcial | sí | **GAP UI** |

### 2.6 Períodos, ejercicios y cierres

| Acción | Backend | UI | Permiso | Auditoría | Humano | Estado |
|---|---|---|---|---|---|---|
| Listar períodos / ejercicios | `GET /periods`, `/fiscal-years` | **no** | `period:read` | — | no | **GAP UI** |
| Crear ejercicio (+12 períodos) | `POST /fiscal-years` | no | `period:write` | sí | sí | GAP UI |
| Bloquear / cerrar / reabrir | `POST /periods/:id/{block,close,reopen}` | **no** | `period:block/close/reopen` | sí (+motivo y contrafirma) | **sí** | **GAP UI** |
| Pre-cierre (checklist) | `POST /fiscal-years/:id/pre-close` | **no** | `fiscal_year:close` | sí | sí | **GAP UI — es la pantalla de cierre** |
| Cerrar / abrir ejercicio | `POST /fiscal-years/:id/{close,opening}` | no | `fiscal_year:close` | sí | sí | GAP UI |
| Ver el expediente de cierre | `GET /fiscal-years/:id/closure` | no | `report:read` | — | no | GAP UI |

### 2.7 Estados contables y notas

| Acción | Backend | UI | Permiso | Auditoría | Humano | Estado |
|---|---|---|---|---|---|---|
| Listar / emitir estados | `GET`/`POST /statements[/issue]` | **no** | `statement:read` / `:issue` | sí | **sí** | **GAP UI** |
| Trazar un renglón | `GET /statements/trace/:lineId` | **no** | `statement:read` | — | no | **GAP UI — el criterio 8 del MVP** |
| Generar notas | `POST /statements/:id/notes/generate` | no | `note:write` | sí | no | GAP UI |
| Aprobar / versionar nota | `POST /notes/:id/{approve,revise}` | no | `note:write` | sí | **sí** | GAP UI |
| Verificar notas / paquete | `GET /statements/:id/notes/verify`, `/package` | no | `statement:read` | — | no | GAP UI |

### 2.8 Normativa, credenciales, IA y auditoría

| Acción | Backend | UI | Permiso | Auditoría | Humano | Estado |
|---|---|---|---|---|---|---|
| Ver huecos normativos | `GET /normative/gaps` | **no** | `rule:read` | — | no | **GAP UI** |
| **Cerrar un hueco** | **no existe** | no | — | — | sí | **GAP TÉCNICO** (§6) |
| **Cargar / aprobar una regla** | solo CLI | no | `rule:activate` (sin rol) | `normative_audit_logs` | **doble firma** | GAP DE PRODUCTO |
| Cargar / revocar certificado ARCA | `POST`/`POST …/revoke` | **no** | `arca_credential:manage` | sí | sí | **GAP UI** |
| Ver capacidades ARCA | `GET …/arca/capabilities` | no | `company:read` | — | no | GAP UI |
| **Habilitar un servicio ARCA** | solo CLI | no | — | — | sí | GAP TÉCNICO |
| Ver / revisar propuestas de IA | `GET /predictions`, `POST /:id/review` | **no** | `prediction:read` / `:review` | sí | **sí** | GAP UI |
| **Leer la bitácora** | **no existe** | no | `audit:read` (sin consumidor) | — | no | **GAP TÉCNICO CRÍTICO** |
| **Ver alertas / hallazgos** | **no existe** | no | `alert:*`, `audit_finding:*` (sin consumidor) | — | sí | GAP DE PRODUCTO |
| Ver la bandeja | `GET /work-queue` | sí | por rama | — | no | READY |

---

## 3 · Mapa de la bandeja

### 3.1 Qué hay hoy

Veinte ramas sobre trece entidades, todas **derivadas**. Cero ramas
**registradas** — `alerts` y `audit_findings` quedaron fuera de la FASE 3
porque nada las escribe.

| Categoría | Ramas | Qué pide |
|---|---|---|
| `BLOQUEADO` | 1 | resolver un hallazgo de lectura |
| `REQUIERE_REVISION` | 4 | mirar y decidir |
| `REQUIERE_DECLARACION` | 3 | una afirmación profesional |
| `REQUIERE_EVIDENCIA` | 1 | respaldo que falta |
| `REQUIERE_CORRECCION` | 3 | reemplazar algo por el mecanismo permitido |
| `REQUIERE_FUENTE_EXTERNA` | 1 | algo que nadie de adentro puede resolver |
| `REQUIERE_APROBACION` | 7 | una firma |

### 3.2 ¿Se pisan dos ramas?

Se revisó par por par. **No hay dos ramas que representen el mismo trabajo**, y
las exclusiones están en el SQL:

| Par | Por qué no se pisan |
|---|---|
| 5 y 6 (`SIN_CONSTATAR` / `SIN_PROCEDENCIA`) | valores distintos y disjuntos de `constatacion_origen` |
| 8 y 9 (`SIN_AFECTACION` / `SUGERIDA`) | 8 exige que **no** haya fila; 9 exige que la haya |
| 11 y 12 (decisión) | valores disjuntos de `resultado` |
| 10 y 12 | 10 exige que no haya decisión; 12 exige que la haya |
| 15 y 16 (notas) | ejes distintos: `status` y `evidencia`. **Pueden coincidir**, y son dos hechos distintos |

Lo que sí ocurre —y es correcto, no un defecto— es que **una misma entidad
produzca varios ítems**: una operación recién registrada aparece tres veces (sin
constatar, sin afectación, sin decisión). Son tres datos que faltan, no tres
copias del mismo. Fue exactamente el motivo de agregar `rama` a la vista.

**Consecuencia operativa, no de modelo:** cargar 200 comprobantes produce ~600
ítems. La bandeja necesita **agrupar por entidad** en la presentación. Es un
requisito de la pantalla, no de la vista.

### 3.3 Riesgo real: perder una tarea

Tres formas, en orden de gravedad.

**A. Un pendiente sin acción posible.** Un asiento `BORRADOR` cuyo período se
cerró después no se puede aprobar nunca —`assert_period_open` lo impide— y el
ítem 13 lo va a listar para siempre. El checklist de pre-cierre lo bloquea
(`SIN_BORRADORES` es `bloquea: true`), así que el camino normal no llega ahí;
pero un bloqueo de período (`BLOQUEADO`, que no corre checklist) sí puede
dejarlo. **La bandeja debería mostrar «no resoluble desde acá» en vez de un ítem
mudo.**

**B. Un ítem desaparece sin dejar rastro de que existió.** Es la contracara
deliberada del diseño derivado: se va cuando el hecho cambia. Quién lo resolvió
está en `audit_logs` —y **nadie puede leer `audit_logs`**, sección 8. Hasta que
exista esa ruta, la bandeja no puede contestar «¿qué pasó con lo de ayer?».

**C. Un pendiente de otra empresa.** No ocurre: cada rama filtra por
`company_id`, la vista es `security_invoker`, y hay tests. Sin riesgo.

### 3.4 Las cinco tablas desconectadas: quién debería escribirlas

No entran a la bandeja «porque existen». Cada una necesita un evento real.

| Tabla | Qué evento representaría | Quién lo escribiría | Falta |
|---|---|---|---|
| `alerts` | un hecho puntual que hay que reconocer aunque ya no se cumpla | **nadie definido** | **decisión de producto**: qué condición merece una alerta persistente y no una proyección |
| `audit_findings` | los cinco códigos que `packages/audit-engine` ya calcula (`IMPORTE_ATIPICO`, `IMPORTE_REDONDO`, `JUSTO_BAJO_UMBRAL`, `ASIENTO_TARDIO`, `VARIACION_SIGNIFICATIVA`) | un proceso que corra el motor sobre un ejercicio y persista | **decisión de producto**: ¿cuándo corre? ¿al cerrar? ¿bajo demanda? Es lo único que falta: el cálculo tiene 28 tests |
| `normative_conflicts` | dos reglas ACTIVE que chocan | el motor normativo | **imposible hoy**: hay una regla y está en DRAFT |
| `normative_updates` | el ciclo `DETECTADA → … → APROBADA` de mantenimiento normativo | un proceso que no existe | FUTURO |
| `norm_candidates` | «apareció la RG 5912/2026 y no la tenemos» | `npm run norms:watch`, que hoy **imprime y no persiste** | **gap técnico chico**: agregar el `INSERT`, con el límite ya escrito (un candidato no se puede citar) |

**Recomendación:** en FASE 4 solo `audit_findings` está lo bastante maduro para
conectarse, y aun así primero hay que decidir cuándo corre el motor. Las otras
cuatro esperan.

### 3.5 Dos definiciones de «pendiente»

`work_queue` no es la única. `packages/accounting-engine/src/periods.ts`
—`evaluarChecklist()`— define ocho controles de pre-cierre, tres **bloqueantes**:

| Control | ¿Bloquea el cierre? | ¿Rama equivalente en `work_queue`? |
|---|---|---|
| `BALANCE_CUADRA` | sí | **no existe rama** |
| `SIN_BORRADORES` | sí | rama 13 |
| `SIN_PROPUESTOS` | sí | rama 13 |
| `SIN_PROPUESTAS_IA` | sí | rama 14 |
| `COMPROBANTES_IMPUTADOS` | no | rama 12 (aproximada) |
| `SIN_HALLAZGOS` | no | rama 3 |
| `DUPLICADOS_RESUELTOS` | no | rama 4 |
| `BANCOS_CONCILIADOS` | no | rama 18 (aproximada) |

**No es una duplicación ilegítima**: el checklist se congela en
`accounting_closures.checklist` como constancia firmada de qué era cierto al
cerrar, y eso tiene que persistir. Pero **sí son dos lugares donde se decide qué
cuenta como pendiente**, y hoy pueden divergir sin que nada avise.

Además, `BALANCE_CUADRA` —el único control que el propio código llama «el que no
admite discusión»— **no tiene rama en la bandeja**: un balance que no cuadra es
invisible hasta que alguien intenta cerrar.

---

## 4 · Flujo de trabajo profesional

Reconstruido desde el código, no supuesto. Cinco recorridos reales.

### 4.1 La mañana: qué requiere atención

```
GET /companies              → elegir cliente
GET /work-queue?…           → resumen por categoría + lista
     ↓  (agrupada por entidad, no por ítem suelto)
abrir el ítem por su trazaRef
```

**Ve:** categoría, rama, motivo, entidad, desde cuándo, vencimiento si lo hay.
**No ve:** prioridad (no existe), severidad (solo la tendría `alerts`).
**Estado hoy:** la lista funciona; **la pantalla de destino existe para 2 de 13
entidades**.

### 4.2 Un comprobante que entra

| Paso | Pregunta que contesta la persona | Evidencia que necesita | Acción | Qué cambia | Cómo sabe NEXO que terminó |
|---|---|---|---|---|---|
| Documento | ¿qué es esto? | el archivo original (`GET /documents/:id/content`) | subir | `documents` + hash | aparece rama 1 |
| Importes | ¿cuánto dice el comprobante? | el documento al lado de los campos | `POST …/tax-transaction` | `tax_transactions` | rama 1 se apaga; se encienden 5, 8 y 10 |
| Constatación | ¿el organismo lo autorizó? | respuesta de ARCA archivada | `POST …/constatar` | `constatacion` + `constatacion_origen` + `arca_query_log` | rama 5 se apaga |
| Afectación | ¿se vincula con operaciones gravadas? | comprobante, cuentas, centro de costo | `POST …/afectacion` | `tax_affectations` con evidencia verificada por trigger | rama 8 se apaga |
| Decisión | ¿qué asiento corresponde y por qué? | la afectación y, si hubiera, la regla | `POST …/decision` | `accounting_decisions` | rama 10 se apaga; se enciende 12 |
| Asiento | ¿está bien imputado? | la decisión que lo funda | `POST /journal-entries` | `journal_entries` BORRADOR | rama 12 se apaga; se enciende 13 |
| Aprobación | ¿lo firmo? | todo lo anterior | `POST …/approve` | proyección al Mayor | rama 13 se apaga |

**Los siete pasos existen en backend y seis están en la consola.** El que falta
—descargar el original— es justamente *la evidencia*.

### 4.3 Corregir

| Qué está mal | Mecanismo | ¿Existe? |
|---|---|---|
| Un campo leído del documento | `POST /documents/:id/fields` (inserta, no pisa) | backend sí, UI **no** |
| Un duplicado mal detectado | `POST /documents/:id/duplicates/:dupId` | backend sí, UI **no** |
| La decisión | `POST …/decision/supersede` con motivo ≥30 | **sí, completo** |
| El asiento aprobado | `POST /journal-entries/:id/reverse` con motivo | backend sí, UI **no** |
| **Los importes de la operación fiscal** | — | **no existe** |
| **La afectación declarada** | — | **no existe** |

Las dos últimas son el hueco de corrección más grave: se declaran bajo
responsabilidad profesional y **no se pueden rectificar por ningún camino**.

### 4.4 Cerrar el mes

```
GET /periods → ver estado
POST /fiscal-years/:id/pre-close → checklist con 8 controles
   ↳ los bloqueantes se resuelven en la bandeja
POST /periods/:id/close
POST /vat/books/:a/:m/generate
POST /books/emissions (DIARIO y MAYOR, con hash)
```

Todo existe en backend. **Ninguno de los cinco pasos está en la consola.**

### 4.5 Comprobar qué ocurrió

```
GET /books/trace/:movementId        → del Mayor al comprobante
GET /statements/trace/:lineId       → del estado al comprobante
GET /comprobantes/:id/decision/historial → qué se decidió y qué lo reemplazó
GET /audit/…                        → NO EXISTE
```

Las tres primeras existen; solo la última del historial está en la consola. **La
bitácora no se puede consultar por ningún medio que no sea `psql`.**

---

## 5 · Calles sin salida

Barrido sistemático, con el número exacto en cada caso.

| # | Tipo | Cantidad | Detalle |
|---|---|---|---|
| C-1 | Endpoint sin UI | **72 de 94** | La consola alcanza 22 |
| C-2 | UI que apunta a endpoint inexistente | **0** | Corregido en FASE 3 |
| C-3 | `trazaRef` que la consola no sabe abrir | **11 de 13 entidades** | Solo sabe renderizar `documents`; el resto vuelca JSON |
| C-4 | Estado sin escritor productivo | **17 valores** | Sección 6 |
| C-5 | Permiso sin consumidor | **11 de 50** | Sección 7 |
| C-6 | Auditoría que no se puede consultar | **34 acciones + 3 triggers** | Ninguna ruta lee `audit_logs` |
| C-7 | Entidad que se crea y no se corrige | **2** | operación fiscal y afectación |
| C-8 | Entidad que se aprueba y no se revisa | **1** | propuestas de IA: hay `review` sin pantalla |
| C-9 | Acción que no genera pendiente cuando debería | **1** | un balance que no cuadra no aparece en la bandeja |
| C-10 | Pendiente sin acción posible | **1 caso** | asiento BORRADOR en período bloqueado (§3.3 A) |
| C-11 | Escritor que existe pero no persiste | **1** | `norms:watch` imprime candidatos y no los guarda |
| C-12 | Endpoint que devuelve 501 por diseño | **2** | `vat/books/export-file` y `…/present`. **No son defectos**: declaran una fuente y una credencial que el sistema no tiene |

---

## 6 · Inconsistencias: estados que dicen una cosa y hechos que dicen otra

Este es el hallazgo más importante de la fase. **Diecisiete valores de estado
declarados en el esquema no los escribe ningún código productivo.**

Método: para cada CHECK de catálogo se buscó el valor como `DEFAULT`, como
`SET <col> = 'X'` y como literal en `apps/`, `packages/`, `scripts/` e
`infrastructure/`, excluyendo tests.

### 6.1 Los que afectan la operación

| Estado | Escritor | Qué consecuencia tiene |
|---|---|---|
| **`documents.status = 'IMPUTADO'`** | ninguno | Un documento con operación fiscal queda `EXTRAIDO` para siempre. Y el guard `WHERE … status <> 'IMPUTADO'` del camino de anulación **nunca se activa**: hoy se puede anular un documento que funda una operación fiscal |
| **`accounting_decisions.estado = 'APLICADA'`** | ninguno | La migración `0034` diseñó `EMITIDA → APLICADA → SUPERSEDIDA` y hasta comenta cuándo marcar APLICADA. Nadie la marca: una decisión que ya fundó un asiento aprobado queda `EMITIDA` |
| **`normative_gaps.status = 'CERRADO'`** | ninguno | **Un hueco normativo no se puede cerrar por ningún camino.** Como `blocks_rule_key` impide activar la regla mientras el hueco esté `ABIERTO`, la regla de IVA no se puede desbloquear sin SQL directo |
| **`users.status` = `SUSPENDED` / `DISABLED`** | ninguno | No se puede dar de baja a una persona. `loadSession` ya rechaza a quien no esté `ACTIVE`: el candado está y **no hay forma de accionarlo** |
| **`companies.status = 'ARCHIVED'`** | ninguno | No se puede archivar un cliente que se fue |
| `documents.status = 'RECHAZADO'` | ninguno | El rechazo se audita **antes** de crear la fila, así que el estado sobra |
| `accounting_closures.status = 'ABORTADO'` | solo se lee en un `<>` | Un cierre empezado por error no se puede abandonar |
| `bank_reconciliations.status = 'ANULADA'` | solo se lee en un `<>` | Una conciliación mal hecha no se puede anular |
| `bank_accounts.status = 'CERRADA'` | ninguno | |
| `company_arca_credentials.status = 'EXPIRED'` | ninguno | El listado muestra `ACTIVE` una credencial vencida. **No es un agujero**: `DbCredentialStore` filtra por `now() BETWEEN not_before AND not_after` al usarla. Es un dato engañoso en pantalla |
| `accounting_rules.status` = `IN_REVIEW`, `SUPERSEDED` | ninguno | El paso intermedio de revisión y el reemplazo de versión no tienen camino |
| `alerts.*` (3 de 4) · `audit_findings.*` (2 de 3) · `normative_updates.*` (3 de 6) · `norm_candidates.*` (3 de 4) | ninguno | Tablas sin escritor (§3.4) |
| `vat_books.status = 'PRESENTADO_POR_TERCERO'` | ninguno | **Por diseño**: presentar exige Clave Fiscal Nivel 3 y el endpoint responde 501. El valor espera una declaración manual — decisión de producto |

### 6.2 El caso `IMPUTADO`: A, B o C

La consigna pide elegir por **cuál representación evita dos verdades sobre el
mismo hecho**.

- **A (corregir ahora, escribir `IMPUTADO`).** Deja dos verdades: la columna y la
  existencia de la fila en `tax_transactions`. Si una transacción futura falla a
  medias, o alguien inserta por otro camino, las dos discrepan — y la columna es
  la que mienten los reportes.
- **B (dejarlo y documentar).** Ya no alcanza: el guard de anulación depende de
  esa columna, así que hoy hay un candado apagado.
- **C (derivar del hecho).** Una sola verdad: la operación existe o no existe. Es
  lo que ya hace `work_queue`, y por eso la bandeja no miente.

**Recomendación: C, y con una corrección adicional que A y B no cubren.** El
`IMPUTADO` de la columna se reemplaza por una derivación, y **el guard de
anulación se reescribe para preguntar por el hecho**:

```sql
-- en vez de:  WHERE id = $1 AND status <> 'IMPUTADO'
-- preguntar:  AND NOT EXISTS (SELECT 1 FROM tax_transactions t
--                              WHERE t.document_id = documents.id
--                                AND t.company_id = documents.company_id)
```

Eso arregla el candado apagado sin crear la segunda verdad. Si además se quiere
un `IMPUTADO` visible, que sea una **columna generada o una vista**, nunca un
`UPDATE` que alguien tenga que acordarse de hacer.

**El mismo criterio aplica a `APLICADA`**: una decisión está aplicada si existe
un asiento aprobado que la cita. No hace falta escribirlo.

---

## 7 · Permisos

### 7.1 Sin consumidor (11 de 50)

| Permiso | Roles | Diagnóstico |
|---|---|---|
| `audit:read` | ADMIN, AUDITOR, CONTADOR | **falta la ruta** (§8) |
| `alert:read` · `alert:acknowledge` | 5 roles / 2 roles | esperan que algo escriba `alerts` |
| `audit_finding:read` · `audit_finding:review` | 3 / 2 | esperan el persistidor de hallazgos |
| `norm_watch:read` · `norm_watch:dismiss` | 3 / 1 | esperan que `norms:watch` persista |
| `assistant:ask` | CONTADOR | sin LLM, fuera del MVP |
| `company:create` · `user:manage` | ADMINISTRADOR | **coherente**: esas rutas autorizan por `organization_level()`, y al crear una empresa todavía no hay empresa sobre la cual tener un permiso |
| `rule:activate` | **ningún rol** | **deliberado**: el §32 exige la firma de un matriculado. El permiso espera el día en que exista la ruta y el rol |

### 7.2 Permisos mal aplicados

| Ruta | Exige | Debería | Por qué |
|---|---|---|---|
| `POST /books/ledger-verification` | `report:read` | un permiso de escritura | **Escribe** una fila en `ledger_verifications` con `ran_by`. Hoy SOLO_LECTURA y USUARIO_EMPRESA pueden dejar una constancia firmada con su nombre |
| `POST /documents/:id/duplicates/:dupId` | `document:upload` | juicio profesional | Decidir «esto no es un duplicado» es una afirmación. CARGADOR puede hacerlo |
| `POST /documents/:id/fields` | `document:upload` | discutible | Corregir un campo leído es carga de datos con autoría; queda registrado y no pisa la lectura. **Aceptable**, pero conviene decidirlo a propósito |
| `GET /companies/current/arca/capabilities` | `company:read` | `arca_credential:manage` | Qué servicios de ARCA tiene delegados una empresa es información de configuración fiscal, no de ficha |

### 7.3 Doble firma

Dos operaciones la exigen y las dos están en la base, no en el código:

- **Activar una regla** — CHECK `approved_by <> proposed_by` + `approved_by`/`approved_at` obligatorios para llegar a ACTIVE.
- **Reabrir un período cerrado** — `reopened_countersigned_by` y `reopen_reason` exigidos por `assert_period_transition` en la misma sentencia.

Ninguna tiene pantalla. **No se propone ningún permiso nuevo** salvo el de
escritura de `ledger-verification`, que es la única frontera real que los 50
actuales no expresan.

---

## 8 · Auditoría y responsabilidad profesional

### 8.1 El dato existe entero

`audit_logs` tiene exactamente lo que la consigna pide: `actor_type`
(`USER`/`SYSTEM`/`AI`), `actor_id`, `action`, `object_type`, `object_id`,
**`old_value`**, **`new_value`**, `motivo`, `occurred_at`, e `ip`/`user_agent`.
Encadenado por hash (`audit_logs_chain`) e inmutable (`audit_logs_immutable`).
Lo escriben 34 acciones desde 16 archivos de rutas y tres triggers de base.

### 8.2 Y no se puede leer

`grep -rn "FROM audit_logs" apps/api/src/` no devuelve **nada**. `audit:read`
está otorgado a tres roles y no se exige en ninguna ruta.

**Es el gap crítico de esta fase.** Sin él, «comprobar qué ocurrió después» —la
última mitad del objetivo— no tiene camino.

### 8.3 Cómo debería verse, sin mezclar lo que no se mezcla

La pantalla de bitácora tiene que mostrar el `actor_type` **como columna
propia**, no como un adorno del nombre:

| Lo que la consola debe distinguir | De dónde sale, ya |
|---|---|
| lo hizo una persona | `actor_type = 'USER'` |
| lo hizo el sistema | `actor_type = 'SYSTEM'` |
| lo propuso un modelo | `actor_type = 'AI'` + `ai_prediction_id` |
| es una declaración profesional | `tax_affectations.origen = 'DECLARACION_PROFESIONAL'` |
| es una sugerencia por precedente | `origen = 'SUGERIDA_POR_PRECEDENTE'` — la vista que el motor consulta la excluye |
| contestó ARCA | `constatacion_origen = 'ARCA'` + `arca_query_id` |
| lo afirmó una persona | `constatacion_origen = 'DECLARACION_PROFESIONAL'` + quién y cuándo |

**Las tres reglas que la pantalla no puede romper:**

1. Una sugerencia de IA nunca se presenta con el mismo tratamiento visual que una
   decisión profesional.
2. `DECLARACION_PROFESIONAL` nunca se rotula «constatado» a secas.
3. Una aprobación en lote —cuando exista— no puede operar sobre ítems con
   `origen = 'IA'` sin abrir cada uno.

### 8.4 Acciones auditadas sin ruta que las emita

`ACTIONS_REQUIRING_REASON` declara cinco acciones que la base obliga a acompañar
de un motivo. Dos no las emite nadie: **`ACTIVAR_REGLA`** (hoy va a
`normative_audit_logs` desde el CLI) y **`RECLASIFICAR_APROBADO`** (sin ruta).

### 8.5 Rutas que escriben sin auditar

| Ruta | Qué escribe |
|---|---|
| `POST /organizations/:id/users` | **crea un usuario** — y no queda registro |
| `POST /organizations` · `POST /organizations/:id/companies` | crea estudio / empresa |
| `POST /cost-centers` | centro de costo |
| `POST /banks/reconciliations/:id/matches` | filas de conciliación |
| `POST /books/ledger-verification` | constancia de verificación |

El alta de usuario es la más grave: es una operación de seguridad.

---

## 9 · Aislamiento

Cada recorrido nuevo tiene que demostrar las seis propiedades. Lo que ya existe
y lo que hay que agregar por acción:

| Propiedad | Cómo se cumple hoy | Qué hace falta por acción nueva |
|---|---|---|
| Aislamiento HTTP | `requireCompany` valida `X-Company-Id` contra `user_company_roles` bajo RLS | entra sola al barrido S-1 |
| Company scoping | `withCompany` fija `app.company_id`; el id nunca sale del cuerpo | — |
| RLS | 55 tablas con `FORCE`, rol `NOBYPASSRLS` | — |
| Vistas | `security_invoker`, verificado por S-9 **y** por `audit:estructura` | automático |
| Cursor sin `company_id` | contrato de `paginacion.ts` | — |
| **Abrir una entidad ajena** | RLS devuelve cero filas → 404, no 403 | **un test propio por entidad** |
| **Actuar sobre una entidad ajena por UUID en el cuerpo** | RLS | **un test propio por acción** |

**Límite conocido del barrido, que conviene tener escrito:** S-1 recorre las 94
rutas mandando la empresa ajena **en la cabecera**, y todas responden 403 porque
`requireCompany` corta antes. Eso prueba «no podés operar como una empresa en la
que no tenés rol» y **no dice nada** sobre «tenés rol en A y mandás un id de B en
el cuerpo». Ese segundo caso lo cubre `aislamiento-multiempresa.test.ts` entidad
por entidad (43 tests), y **cada acción nueva necesita su caso ahí**. Un flujo no
es seguro porque la UI oculte la otra empresa.

---

## 10 · Arquitectura funcional de la consola

Doce pantallas. Ninguna decorativa: cada una existe porque hay trabajo que hoy no
tiene dónde hacerse.

| # | Pantalla | Muestra | **No** muestra | Acciones | Permisos | Endpoints |
|---|---|---|---|---|---|---|
| P1 | Selector de empresa | empresas con rol y CUIT | empresas sin rol | elegir | membresía + `company:read` | `GET /companies` |
| P2 | Inicio | resumen de la bandeja por categoría, período abierto, próximos vencimientos | indicadores inventados, gráficos | ninguna | por rama | `GET /work-queue`, `GET /periods` |
| P3 | Bandeja | ítems **agrupados por entidad**, con motivo, evidencia faltante y vencimiento | prioridad | abrir | por rama | `GET /work-queue` |
| P4 | Documentos | lista con cursor y semáforos; **detalle con el archivo original al lado de los campos** | — | subir, re-extraer, **corregir campo**, **resolver duplicado**, descargar | `document:*` | `GET/POST /documents`, `/:id`, `/content`, `/extract`, `/fields`, `/duplicates/:id` |
| P5 | Operación fiscal | el comprobante, sus dos sellos separados, afectación y decisión | un sello único | registrar, constatar, declarar afectación | `journal_entry:create`, `tax_transaction:constatar`, `tax_affectation:declare` | `GET /tax-transactions`, `POST …/constatar`, `…/afectacion` |
| P6 | Decisiones | vigente + historial completo con motivos | — | decidir, **supersede** | `journal_entry:create`, `decision:supersede` | `/comprobantes/:id/decision*` |
| P7 | Asientos | **lista con cursor y filtros**, detalle con líneas | — | crear, aprobar, **anular por contraasiento** | `journal_entry:*` | `GET/POST /journal-entries`, `/approve`, `/reverse` |
| P8 | Libros | Diario y Mayor **en tabla**, balance, emisiones con hash | JSON crudo | exportar CSV, **emitir con hash**, **trazar un movimiento** | `report:read`, `book:emit` | `/books/*`, `/reports/trial-balance` |
| P9 | Cierre | **checklist de pre-cierre con sus 8 controles**, estado de períodos y ejercicio | — | bloquear, cerrar, reabrir (con contrafirma), pre-cerrar, cerrar ejercicio, abrir | `period:*`, `fiscal_year:close` | `/periods/*`, `/fiscal-years/*` |
| P10 | Estados y notas | estados emitidos, **cada cifra clickeable**, notas con su evidencia | — | emitir, generar notas, aprobar, versionar | `statement:*`, `note:write` | `/statements/*`, `/notes/*` |
| P11 | Auditoría | bitácora filtrable con `actor_type` como columna, `old_value` → `new_value`, motivo | — | ninguna (solo lectura) | `audit:read` | **`GET /audit` — no existe** |
| P12 | Configuración | usuarios y roles, marco contable, certificados y capacidades de ARCA, huecos normativos | secretos | asignar rol, cargar/revocar certificado, fijar marco | `user:read`, `arca_credential:manage`, `company:write`, `rule:read` | `/companies/current/*`, `/arca/*`, `/normative/gaps` |

**Sin dashboards decorativos.** P2 muestra tres cosas y las tres son conteos de
hechos, no indicadores compuestos.

---

## 11 · Matriz de completitud operativa

| Capacidad | Modelo | Backend | UI | Tests | Auditoría | Producción |
|---|---|---|---|---|---|---|
| Elegir empresa | ✔ | ✔ | ✔ | ✔ | n/a | **READY** |
| Encontrar el trabajo (bandeja) | ✔ | ✔ | ✔ | ✔ | n/a | **READY** |
| Listar comprobantes | ✔ | ✔ | ✔ | ✔ | n/a | **READY** |
| Circuito documento → asiento | ✔ | ✔ | ✔ | ✔ | ✔ | **READY** |
| **Ver la evidencia original** | ✔ | ✔ | ✖ | ✔ | n/a | **GAP TÉCNICO** |
| Corregir una decisión | ✔ | ✔ | ✔ | ✔ | ✔ | **READY** |
| **Corregir campo / duplicado** | ✔ | ✔ | ✖ | ✔ | ✔ | **GAP TÉCNICO** |
| **Corregir operación / afectación** | ✖ | ✖ | ✖ | ✖ | — | **GAP DE PRODUCTO** |
| **Anular un asiento** | ✔ | ✔ | ✖ | ✔ | ✔ | **GAP TÉCNICO** |
| **Listar asientos** | ✔ | ✔ | ✖ | ✔ | n/a | **GAP TÉCNICO** |
| Libros y balance | ✔ | ✔ | parcial | ✔ | ✔ | **GAP TÉCNICO** |
| **Emitir libro con hash** | ✔ | ✔ | ✖ | ✔ | ✔ | **GAP TÉCNICO** |
| **Cerrar período / ejercicio** | ✔ | ✔ | ✖ | ✔ | ✔ | **GAP TÉCNICO** |
| **Estados contables y notas** | ✔ | ✔ | ✖ | ✔ | ✔ | **GAP TÉCNICO** |
| Trazabilidad hasta el hash | ✔ | ✔ | parcial | ✔ | n/a | **GAP TÉCNICO** |
| **Leer la bitácora** | ✔ | ✖ | ✖ | ✖ | n/a | **GAP TÉCNICO CRÍTICO** |
| **Cerrar un hueco normativo** | ✔ | ✖ | ✖ | ✖ | — | **GAP TÉCNICO** |
| **Dar de baja un usuario** | ✔ | ✖ | ✖ | ✖ | — | **GAP TÉCNICO** |
| Libro de IVA | ✔ | ✔ | ✖ | ✔ | ✔ | **GAP TÉCNICO** |
| Conciliación bancaria | ✔ | ✔ | ✖ | ✔ | parcial | **FUERA DE FASE 4** |
| Alertas y hallazgos | ✔ | ✖ | ✖ | ✖ | — | **GAP DE PRODUCTO** |
| Propuestas de IA | ✔ | ✔ | ✖ | ✔ | ✔ | FUERA DEL MVP |
| Constatación automática | ✔ | ✔ | ✔ | ✔ | ✔ | **GAP EXTERNO** (certificado) |
| Activar una regla | ✔ | CLI | ✖ | ✔ | ✔ | **GAP EXTERNO** (Decreto 280 + firma) |
| Presentar libro de IVA | ✔ | 501 | ✖ | ✔ | — | **FUERA DEL MVP, declarado** |
| OCR · sueldos · EEPN/EFE | parcial | ✖ | ✖ | — | — | **FUERA DEL MVP** |

**Cuenta:** 5 READY · 15 GAP TÉCNICO (uno crítico) · 3 GAP DE PRODUCTO ·
2 GAP EXTERNO · 5 FUERA DEL MVP.

---

## 12 · Decisiones de producto pendientes

Estas **no** las puedo tomar yo. Cada una bloquea una capacidad concreta.

| # | Decisión | Qué bloquea | Por qué no es técnica |
|---|---|---|---|
| D-1 | **¿Qué condición merece una `alerta` persistente** y no una proyección? | conectar `alerts` | Depende de qué quiere que le interrumpa el día un contador |
| D-2 | **¿Cuándo corre el motor de auditoría?** ¿Al cerrar, bajo demanda, en un lote nocturno? | conectar `audit_findings` | El cálculo ya existe con 28 tests; falta el disparador |
| D-3 | **¿Cómo se corrige una operación fiscal mal cargada?** ¿Anulación con contra-operación, versionado como las decisiones, o edición con bitácora? | corregir operación y afectación | Es una regla profesional: qué constancia queda de que los importes eran otros |
| D-4 | **¿Se registra que un tercero presentó el libro de IVA?** | `PRESENTADO_POR_TERCERO` | Es una declaración sobre un hecho externo |
| D-5 | **¿Baja de usuario: `SUSPENDED` o `DISABLED`?** ¿Se conservan sus roles? | dar de baja a una persona | Tiene consecuencias sobre la trazabilidad de lo que firmó |
| D-6 | **¿Quién cierra un hueco normativo y con qué constancia?** | desbloquear la regla de IVA | Es el mismo problema del §32: quién firma |
| D-7 | ¿La consola sigue sin framework con doce pantallas? | P1–P12 | Ver §14 |

---

## 13 · Gaps técnicos

Ordenados por gravedad. Ninguno depende de un tercero.

| # | Gap | Impacto |
|---|---|---|
| T-1 | **No hay ruta para leer `audit_logs`** | «Qué ocurrió» no tiene camino. `audit:read` otorgado a 3 roles, sin consumidor |
| T-2 | **El guard de anulación de documentos está apagado** | Se puede anular un documento que funda una operación fiscal (§6.2) |
| T-3 | **Un hueco normativo no se puede cerrar** | La única regla del sistema no se puede desbloquear sin SQL |
| T-4 | **No se puede dar de baja a un usuario** | `loadSession` rechaza a quien no esté ACTIVE, y nada puede sacarlo de ACTIVE |
| T-5 | **El alta de usuario no se audita** | Operación de seguridad sin registro |
| T-6 | 11 de 13 tipos de pendiente no tienen pantalla de destino | Se encuentra el trabajo y no se puede hacer |
| T-7 | `POST /books/ledger-verification` escribe con permiso de lectura y no audita | Un SOLO_LECTURA deja una constancia con su nombre |
| T-8 | `BALANCE_CUADRA` no tiene rama en la bandeja | Un libro roto es invisible hasta que alguien cierra |
| T-9 | Ítem sin acción posible (borrador en período bloqueado) | Ruido permanente en la bandeja |
| T-10 | `decisiones.estado = 'APLICADA'` sin escritor | Estado muerto; el ciclo diseñado no ocurre |
| T-11 | `norms:watch` no persiste candidatos | El comentario dice «abre tareas» y no abre ninguna |
| T-12 | `EXPIRED` nunca se escribe | El listado muestra ACTIVE una credencial vencida (el uso sí filtra) |
| T-13 | Sin arranque scriptado ni remoto git | Arrastrado de FASE 1 |

---

## 14 · Propuesta de implementación

**Principio:** primero cerrar lo que hace que un dato mienta, después dar
destino al trabajo que la bandeja ya encuentra, y recién entonces ampliar.

**Sobre el framework (D-7).** La consola tiene ~700 líneas y cubre 6 pantallas.
Doce pantallas con listas, filtros y detalle maestro-detalle son otra escala. La
recomendación es **partirla en módulos por pantalla, sin build y sin framework,
y volver a decidir después de P7**: si a esa altura hay estado compartido entre
pantallas que se vuelve difícil de sostener a mano, ese es el argumento concreto
para una SPA. Antes, sería adoptar una dependencia por si acaso.

---

## FASE 4 — LISTA PARA IMPLEMENTAR

Diecisiete tareas, en orden. Cada una es verificable por su cuenta y **ninguna
depende de una decisión de producto pendiente**.

---

### Bloque A · Coherencia (primero, porque hoy algo miente)

**A-1 · Reparar el guard de anulación de documentos**
- **Objetivo:** que no se pueda anular un documento que funda una operación fiscal.
- **Archivos:** `apps/api/src/routes/documents.ts`.
- **Tablas:** `documents`, `tax_transactions` (solo lectura).
- **Endpoints:** ninguno nuevo; cambia el `UPDATE` interno de `POST /documents/:id/duplicates/:dupId`.
- **Permisos:** sin cambios.
- **Auditoría:** ya audita `RESOLVER_DUPLICADO`.
- **Tests:** un documento con operación fiscal no se anula ni marcándolo duplicado; uno sin operación sí.
- **Riesgo:** bajo. No toca migraciones.
- **Aceptación:** el intento devuelve un error de dominio nombrado, no un 500 ni un éxito silencioso.

**A-2 · Retirar del esquema los estados sin camino, o darles uno**
- **Objetivo:** que el catálogo no prometa transiciones que no existen.
- **Archivos:** migración nueva (`0046`), `docs/OPERACION.md`.
- **Tablas:** `documents` (`IMPUTADO`, `RECHAZADO`), `accounting_decisions` (`APLICADA`).
- **Endpoints:** ninguno.
- **Permisos:** ninguno.
- **Auditoría:** n/a.
- **Tests:** el CHECK rechaza el valor retirado; `work_queue` sigue dando lo mismo.
- **Riesgo:** **medio — toca un CHECK de una tabla central.** Requiere confirmar que ninguna fila existente los usa (hoy ninguna, porque nadie los escribe).
- **Aceptación:** `audit:invariants` sin `NOT_EXERCISED`, `ci:desde-cero` en 0, y un comentario en la migración explicando por qué derivar es mejor que actualizar.

**A-3 · Rama `BALANCE_NO_CUADRA` en la bandeja**
- **Objetivo:** que un libro roto se vea antes de intentar cerrar.
- **Archivos:** migración `0046`, `apps/api/src/routes/work-queue.ts`.
- **Tablas:** `journal_entries`, `journal_entry_lines` (lectura).
- **Permisos:** `report:read`.
- **Tests:** con Debe ≠ Haber aparece un ítem `BLOQUEADO`; cuadrado, no aparece.
- **Riesgo:** medio — es la rama más cara de la vista. Medir antes de fijarla.
- **Aceptación:** el ítem aparece y desaparece con el hecho, sin tabla nueva.

**A-4 · Marcar los ítems no resolubles**
- **Objetivo:** que un asiento en borrador de un período bloqueado no sea ruido mudo.
- **Archivos:** migración `0046` (columna `resoluble boolean` derivada), `work-queue.ts`.
- **Tests:** con el período `ABIERTO` es resoluble; con `BLOQUEADO`, no, y el motivo lo dice.
- **Riesgo:** bajo.
- **Aceptación:** la bandeja distingue «hacelo» de «no se puede desde acá».

---

### Bloque B · La bitácora (el gap crítico)

**B-1 · `GET /audit`**
- **Objetivo:** poder contestar «quién hizo qué, cuándo, sobre qué y por qué».
- **Archivos:** `apps/api/src/routes/audit.ts` (nuevo), `server.ts`.
- **Tablas:** `audit_logs` (solo lectura).
- **Endpoints:** `GET /audit` con filtros `objectType`, `objectId`, `actorType`, `action`, `desde`/`hasta`, y **cursor keyset por `(occurred_at, id)`**.
- **Permisos:** **`audit:read`** — existe, otorgado a ADMINISTRADOR, AUDITOR y CONTADOR. No se crea ninguno.
- **Auditoría:** ninguna. Leer la bitácora no se audita.
- **Tests:** aislamiento HTTP y SQL directo; un `objectId` de otra empresa devuelve vacío; el cursor no cambia de empresa; `actor_type` viene como columna propia.
- **Riesgo:** bajo, pero **es dato sensible**: `old_value`/`new_value` pueden traer importes y nombres. Solo los tres roles que ya lo tienen.
- **Aceptación:** desde un asiento se llega a su historia completa, con `old_value` y `new_value` visibles, sin `psql`.

**B-2 · Auditar el alta de usuario, estudio y empresa**
- **Objetivo:** que crear una persona con acceso deje registro.
- **Archivos:** `apps/api/src/routes/studio.ts`.
- **Tablas:** `audit_logs`.
- **Permisos:** sin cambios.
- **Auditoría:** acciones nuevas `ALTA_USUARIO`, `ALTA_EMPRESA`, `ALTA_ESTUDIO`.
- **Riesgo:** bajo. Cuidado: **nunca** registrar la contraseña ni su hash en `new_value`.
- **Tests:** el alta deja una entrada; la entrada no contiene el hash.
- **Aceptación:** `GET /audit` muestra el alta con su actor.

**B-3 · Permiso de escritura para `ledger-verification`**
- **Objetivo:** que una constancia firmada no la deje un rol de solo lectura.
- **Archivos:** `books.ts`, migración `0046` (catálogo de permisos).
- **Permisos:** **uno nuevo, `ledger:verify`**, otorgado a CONTADOR y AUDITOR. Es la única frontera real que los 50 actuales no expresan: verificar el Mayor produce una constancia con autor.
- **Auditoría:** agregar `recordAudit`.
- **Tests:** un SOLO_LECTURA recibe 403; un AUDITOR, 200.
- **Riesgo:** bajo. Rompe compatibilidad para SOLO_LECTURA y USUARIO_EMPRESA, que es el objetivo.

---

### Bloque C · Dar destino al trabajo (el grueso)

Cada tarea cierra un `trazaRef` que hoy vuelca JSON.

**C-1 · P4 Documentos completa** — detalle con **el archivo original al lado de los campos**, corrección de campo, resolución de duplicado. Endpoints: `/content`, `/fields`, `/duplicates/:id`. Permisos existentes. Tests: la corrección no pisa la lectura del motor y queda con autor. **Es la pantalla del §41 del pliego.**

**C-2 · P7 Asientos** — lista con cursor y filtros, detalle con líneas, **anulación por contraasiento con motivo**. Endpoints existentes (`GET /journal-entries`, `/reverse`). Tests: el contraasiento conserva el número del anulado.

**C-3 · P8 Libros** — Diario y Mayor en tabla (no JSON), exportación CSV, **emisión con hash**, y el **clic de trazabilidad** desde un movimiento hasta el comprobante. Endpoints existentes. Aceptación: el criterio 8 del `MVP.md` deja de necesitar `curl`.

**C-4 · P9 Cierre** — estado de períodos y ejercicio, **checklist de pre-cierre con sus ocho controles**, bloquear/cerrar/reabrir con contrafirma. Endpoints existentes. Tests: la reapertura sin contrafirma se rechaza y la pantalla lo explica.

**C-5 · P10 Estados y notas** — emitir, **cada cifra clickeable** hasta el comprobante, notas con su evidencia y su aprobación. Endpoints existentes.

**C-6 · P11 Auditoría** — consume B-1. `actor_type` como columna, `old_value → new_value`, motivo, filtro por objeto.

**C-7 · P12 Configuración** — usuarios y roles, marco contable, certificados de ARCA, huecos normativos. Endpoints existentes.

**C-8 · P2 Inicio y P3 Bandeja agrupada** — la bandeja agrupa por entidad; el inicio muestra el resumen por categoría, el período abierto y los vencimientos reales. Sin indicadores compuestos.

---

### Bloque D · Cerrar calles sin salida menores

**D-1 · Baja de usuario** — `POST /organizations/:id/users/:userId/disable` con motivo, permiso `user:manage` (existe, sin consumidor), auditado. **Bloqueado por D-5 de §12**: hay que decidir `SUSPENDED` vs `DISABLED` y qué pasa con los roles. *No implementar hasta que esté decidido.*

**D-2 · Cierre de un hueco normativo** — `POST /normative/gaps/:id/close` con motivo y constancia en `normative_audit_logs`. **Bloqueado por D-6 de §12**: quién firma. *No implementar hasta que esté decidido.*

**D-3 · Persistir los candidatos de `norms:watch`** — agregar el `INSERT` que el script no hace, conservando el límite ya escrito: un candidato no tiene `norm_version_id`, no se puede citar y no entra al motor. Tests: un candidato no habilita ninguna cita.

**D-4 · `arca_credential:manage` para las capacidades** — cambiar el permiso de `GET /companies/current/arca/capabilities`. Riesgo bajo.

---

### Lo que la FASE 4 NO hace

No implementa sueldos, OCR, LLM, WSASS, KMS, padrón, conciliación bancaria,
EEPN/EFE ni aprobación masiva. No activa reglas. No crea `tasks` ni
`work_items`. No conecta `alerts` ni `audit_findings` —esperan D-1 y D-2 de la
§12—. No toca RLS, ni los candados contables, ni ADR-001, ni ADR-012.

---

## 15 · Orden de las próximas fases

| Fase | Qué | Criterio de salida |
|---|---|---|
| **4** | Bloques A, B y C de esta lista | Un profesional recorre el día entero sin `curl` ni `psql` |
| **5** | Infraestructura de piloto: `npm start`, remoto git, CI corriendo, respaldo de base y documentos, exportación PDF | El sistema se enciende y se respalda sin un desarrollador |
| **6** | Decisiones de producto D-1 a D-6, y lo que habiliten (alertas, hallazgos, corrección de operaciones) | Cada decisión, tomada y con su implementación |
| **7** | Ensayo con un mes real de un cliente real, cronometrado | Una lista de faltantes con números en vez de impresiones |
| **8+** | OCR · sueldos (ADR-012) · EEPN/EFE · reglas ACTIVE | Cada uno con su dependencia externa resuelta |

---

## Criterio de aceptación de la FASE 4

La fase termina cuando se puedan contestar las cinco preguntas, cada una con un
test que lo demuestre:

1. **¿Encuentra el trabajo?** La bandeja lista todo lo pendiente de la empresa, agrupado, y ningún ítem queda sin destino.
2. **¿Puede resolverlo?** Los trece tipos de pendiente tienen pantalla, y las acciones exigen el permiso que ya declaraba el modelo.
3. **¿Decide con evidencia?** El documento original se ve al lado de los campos antes de declarar un importe.
4. **¿Puede comprobar qué pasó?** Desde cualquier asiento se llega a su historia completa —quién, cuándo, qué había antes y qué quedó— sin salir de la consola.
5. **¿Sigue aislado?** Cada acción nueva tiene su caso en el barrido HTTP y en el de entidades, y ninguna se apoya en que la UI oculte la otra empresa.

Y el sistema **no debe poder** mentir: ningún estado que diga una cosa mientras
los hechos dicen otra, y ninguna sugerencia de máquina presentada como decisión
profesional.

---

# IMPLEMENTACIÓN FASE 4 — CERRADA

## 1 · Qué se hizo

Los bloques A, B, C y D de la lista. **Ninguna tabla nueva, ninguna acción
inventada, ningún permiso creado salvo el que la auditoría justificó.**

## 2 · Archivos

**Nuevos (5)**

| Archivo | Qué es |
|---|---|
| `infrastructure/db/migrations/0046_coherencia_y_bitacora.sql` | el candado de anulación, `created_by`, `ledger:verify`, la vista `work_queue` v2 |
| `apps/api/src/routes/audit.ts` | `GET /audit` |
| `tests/security/coherencia-fase4.test.ts` | A1, A3, A4, B3 y el contrato de campos — 17 tests |
| `tests/integration/bitacora.test.ts` | B1 y B2 — 15 tests |
| `tests/security/consola-contrato.test.ts` | S-12: la consola no puede llamar a una ruta que no existe — 4 tests |

**Modificados (6)**

| Archivo | Cambio |
|---|---|
| `apps/web/consola.html` | reescrita: 12 pantallas, navegación, migas, permisos |
| `apps/api/src/routes/documents.ts` | el candado de anulación pasa al trigger; error de dominio nombrado |
| `apps/api/src/routes/books.ts` | `ledger:verify` + auditoría de la verificación |
| `apps/api/src/routes/studio.ts` | `created_by` en el alta de usuario y de miembro |
| `apps/api/src/routes/accounts.ts` | auditoría del alta de centro de costo |
| `apps/api/src/routes/work-queue.ts` | filtro y columna `disponibilidad`, rama `fiscal_years` |
| `apps/api/src/server.ts` · `scripts/check-structure.mjs` | registro de la ruta y del trigger nuevo |

## 3 · Migración

Una: **0046**. Un trigger, dos columnas, un permiso y la vista rehecha. **No
toca ninguna política de RLS, ningún CHECK existente, ningún catálogo cerrado.**

## 4 · Endpoints

Uno nuevo: **`GET /audit`** (95 rutas). Ninguno eliminado, ninguna firma rota.

## 5 · Permisos

Uno nuevo: **`ledger:verify`**, para CONTADOR y AUDITOR. Es la única frontera que
los 50 anteriores no expresaban: entre mirar un reporte y dejar una constancia
firmada con tu nombre. Un `SOLO_LECTURA` que antes podía crearla ahora recibe
403, y sigue pudiendo leer el balance — hay un test de cada mitad.

`audit:read`, `document:download`, `journal_entry:reverse`, `book:emit`,
`statement:issue`, `note:write`, `period:block/close/reopen` y
`fiscal_year:close` pasaron de estar declarados a **exigirse de verdad**: la
consola los consulta antes de ofrecer el botón.

## 6 · Auditoría

| Qué | Cómo |
|---|---|
| `GET /audit` | actor, tipo de actor, acción, objeto, motivo, **antes** y **después**, con cursor keyset |
| `VERIFICAR_MAYOR` | acción nueva sobre `ledger_verifications` |
| `CREAR_CENTRO_DE_COSTO` | acción nueva |
| Alta de usuario | `users.created_by` y `organization_members.created_by` — **no** un evento duplicado: el acceso a la contabilidad ya lo registra `ROL_OTORGADO` con su empresa |
| Hashes | `prev_hash` y `hash` **no se exponen**: verificar la cadena es un gate, no una columna |

## 7 · Pantallas

Doce, con navegación, migas y contexto de empresa persistente.

| Pantalla | Qué resuelve |
|---|---|
| Empresa | elegir cliente; cambiar limpia el trabajo en curso |
| Inicio | resumen por categoría + estado de los períodos |
| Pendientes | **agrupada por entidad**, con `disponibilidad` visible |
| Documentos | **el original al lado de los campos**, corrección de campo, resolución de duplicado, re-extracción, descarga |
| Operaciones | los dos sellos separados, registro, constatación, afectación, historial de decisiones |
| Asientos | lista con cursor, detalle con traza, aprobar, **anular por contraasiento** |
| Libros | Diario por folios, Mayor y balance **en tabla**, emisión con hash, verificación del Mayor |
| Estados y notas | armar, cada renglón clickeable, emitir, generar y verificar notas |
| Períodos y cierre | bloquear, cerrar, reabrir con contrafirma, **checklist de pre-cierre con sus ocho controles** |
| Auditoría | la bitácora, con `actor_type` como columna y antes/después |
| Configuración | empresa, marco, personas, certificados de ARCA, huecos normativos |

**La evidencia, antes de la acción.** El original se pide con la sesión —una
etiqueta `img` no puede mandar la cabecera de empresa— y se muestra según lo que
la política de la página admite: imágenes y texto se ven ahí mismo; un PDF se
descarga, porque `object-src` es `none` y **no se aflojó por una vista previa**.
En el alcance del MVP —XML y carga manual— la evidencia es visible.

**La bandeja no ganó acciones propias.** Dirige; cada acción vive en la pantalla
de su entidad, que revalida empresa y permiso.

## 8 · Tests

**+36**: 17 de coherencia, 15 de bitácora, 4 de contrato de consola.
**1311 → 1347**, en 70 archivos.

Cubren lo que el bloque F pedía: camino feliz, autorización, empresa incorrecta,
estado incorrecto, validación; **SQL directo** (el candado de anulación se prueba
como `aai_app` y como dueño del esquema); integridad transaccional (el duplicado
no queda resuelto si la anulación falla); y la frontera IA/humano.

## 9 · Cobertura

**84,02 % → 84,33 %.** Ningún umbral reducido. `apps/api/src/http` sigue por
encima del 95 que exige su umbral.

## 10 · Gates

| Gate | Resultado |
|---|---|
| `npm run ci:desde-cero` | **0** · 173 s · 12/12 |
| `npm run verify` (a continuación, sin resetear) | **0** |
| `npm test` / `test:coverage` | 1347 en 70 archivos |
| `audit:estructura` | **85/85** (84 → 85: el trigger nuevo) |
| `audit:invariants` | 11 · 0 · **0 no ejercitados** · 3 vacuos |
| `ledger:verify` | 2 empresas con movimientos reales |
| ARCA | WSAA y WSCDC 200 · `app=OK db=OK auth=OK` |
| `AR-IVA-CF-VINCULACION-001.v1` | **DRAFT** · ACTIVE reales = **0** |

Las dos corridas fueron consecutivas y sobre la misma base: `verify` corre
después de `ci:desde-cero` sin resetear, que es donde aparecen los defectos de
acumulación.

## 11 · Problemas encontrados durante la implementación

| # | Qué apareció | Cómo se resolvió |
|---|---|---|
| P-1 | El candado de anulación estaba apagado: `status <> 'IMPUTADO'` nunca era falso | Trigger que pregunta por el hecho. Probado por HTTP, por `aai_app` y **como dueño del esquema** |
| P-2 | `BALANCE_NO_CUADRA` parecía imposible de ejercitar: cada asiento cuadra por CHECK | `je_balanced` es inmediato sobre la cabecera y `jel_entry_consistent` es **diferido**: dentro de una transacción las líneas pueden no sumar. Se prueba así, sin desactivar nada, y con `ROLLBACK` |
| P-3 | `GET /statements` **no lista**: arma el estado desde el Mayor | La pantalla se rehizo. Lo encontró el test de contrato de campos, no una lectura |
| P-4 | El Mayor no devuelve `saldo` sino `saldoFinal`; el Diario viaja **por folios** | Ídem. Sin ese test la pantalla habría mostrado columnas vacías sin que nada fallara |
| P-5 | La consola armaba `'/periods/' + id + '/' + accion` | Se escribieron las tres rutas enteras: una URL que el barrido no puede reconstruir es una que nadie verifica hasta que falla |
| P-6 | Un byte NUL se coló en un archivo de test al escribirlo | Detectado por `no-control-regex` de ESLint y reemplazado |

## 12 · Problemas corregidos

`documents.status = 'IMPUTADO'` sin escritor (candado apagado) · balance
descuadrado invisible hasta el cierre · pendientes sin acción posible, mudos ·
`audit_logs` sin lector · alta de usuario sin constancia · verificación del Mayor
escribiendo con permiso de lectura y sin auditar · alta de centro de costo sin
auditar · 11 de 13 tipos de pendiente sin pantalla de destino · la consola sin
gate que compruebe que sus llamadas existen.

## 13 · Problemas deliberadamente no corregidos

| Qué | Por qué |
|---|---|
| **No se retiraron los 17 estados sin escritor** | El barrido está en §6. Ninguno miente por sí solo: lo que mentía era el guard que dependía de `IMPUTADO`, y eso se arregló. Sacar un valor de un CHECK de `documents` o de `accounting_decisions` es tocar una tabla central por una prolijidad de catálogo. Clasificados: `MUERTO` (IMPUTADO, RECHAZADO, APLICADA, IN_REVIEW, SUPERSEDED, ABORTADO, ANULADA, CERRADA, EXPIRED), `GAP_DE_PRODUCTO` (CERRADO de huecos, SUSPENDED/DISABLED de usuarios, ARCHIVED de empresas, PRESENTADO_POR_TERCERO), `DERIVADO` (los de `alerts`, `audit_findings`, `norm_candidates`, `normative_updates`, que esperan escritor) |
| `POST /organizations` y `/organizations/:id/companies` sin auditoría | `audit_logs` exige `company_id NOT NULL` y al crear un estudio o una empresa todavía no hay empresa. La salida sería `created_by` en esas tablas, como en `users`; queda anotado |
| `POST /banks/...` sin auditoría | Bancos está fuera del alcance de esta fase |
| Revisión de propuestas de IA sin pantalla | Sin LLM conectado no hay propuestas. La bandeja las muestra etiquetadas y dice que no se convierten en decisión sin revisión |
| Sin lista de estados contables emitidos | No existe la ruta. Crearla es trabajo de backend, no de consola |
| Vista previa de PDF | Exigiría `object-src` en la CSP. No se afloja un encabezado de seguridad por una comodidad |

## 14 · Decisiones de producto pendientes

Las siete de §12 siguen abiertas. Dos tareas quedaron **BLOQUEADAS POR DECISIÓN
DE PRODUCTO** y no se implementaron:

- **D-1 (baja de usuario)** — bloqueada por **D-5**: `SUSPENDED` vs `DISABLED` y
  qué pasa con los roles que la persona firmó.
- **D-2 (cierre de hueco normativo)** — bloqueada por **D-6**: quién firma y con
  qué constancia. Sin eso, `AR-IVA-CF-VINCULACION-001` no se puede desbloquear
  aunque aparezca el Decreto 280/1997.

`alerts` y `audit_findings` siguen sin conectarse: esperan **D-1** y **D-2** de
§12 (qué condición merece una alerta, cuándo corre el motor de auditoría).

## 15 · Gaps restantes

Sin lista de estados emitidos · sin corrección de operación fiscal ni de
afectación (**D-3**) · sin exportación PDF/Excel · sin aprobación en lote ·
bancos sin pantalla · `POST /organizations*` sin auditoría · sin arranque
scriptado ni remoto git · OCR, WSASS, KMS, padrón, sueldos y EEPN/EFE sin
cambios.

---

## Criterios de aceptación

| Criterio | Resultado | Evidencia |
|---|---|---|
| **Encuentra** | ✔ | `GET /work-queue` con 21 ramas, agrupada por entidad, con resumen. `navegacion-e2e` y `coherencia-fase4` |
| **Entiende** | ✔ | cada ítem trae rama, motivo, evidencia faltante y **`disponibilidad`**; los tres valores se prueban en `coherencia-fase4` A4 |
| **Evidencia** | ✔ *en el alcance del MVP* | el original se muestra al lado de los campos (imagen y texto inline; PDF por descarga, sin aflojar la CSP). `coherencia-fase4` C |
| **Resuelve** | ✔ | 12 pantallas; las acciones aparecen solo con su permiso y con el estado que las admite. S-12 comprueba que la consola consulta permisos y que sus 30+ llamadas existen |
| **No miente** | ✔ | el candado de anulación pregunta por el hecho —probado por HTTP, por `aai_app` y como dueño—; `BALANCE_NO_CUADRA` deja de ser invisible; los ítems sin camino lo dicen |
| **Audita** | ✔ | `GET /audit` con actor, tipo de actor, acción, objeto, motivo, antes y después. 15 tests, incluidos aislamiento y SQL directo |
| **Traza** | ✔ | pendiente → entidad → decisión → asiento → libro → origen: `abrirPendiente()` cubre las 13 entidades y el detalle del asiento llama a `/books/trace/:id` |
| **Aísla** | ✔ | S-1 (95 rutas), S-10, S-11 y S-12; el candado nuevo probado también por SQL directo; el cursor de `/audit` no cambia de empresa |
| **No inventa** | ✔ | ninguna norma, ninguna evidencia, ningún dato. `AR-IVA-CF-VINCULACION-001` sigue **DRAFT**, ACTIVE reales = **0**, y dos tareas quedaron bloqueadas por decisión de producto en vez de resolverse inventando |
| **Gates** | ✔ | `verify` 0 · `ci:desde-cero` 0 · 1347 tests · cobertura 84,33 % (subió) · `audit:estructura` 85/85 · **0 invariantes no ejercitados** |

**Respuesta a la pregunta de la fase:** un profesional puede entrar, elegir
empresa, ver qué requiere atención, abrir cada caso, entender por qué está
pendiente, ver la evidencia, ejecutar la acción que el sistema permite, y
después consultar quién hizo qué, cuándo y por qué — sin `curl` y sin `psql`.

Lo que **no** puede hacer todavía está en §15, y ninguna de esas cosas hace que
el sistema afirme algo falso.
