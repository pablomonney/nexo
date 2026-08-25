# ROADMAP.md

> Entregable G del §51. Fases del §43, con criterios de salida verificables. Una fase no se cierra
> con "está hecho": se cierra cuando su criterio pasa en CI.

## Estado actual

| Fase | Estado |
|------|--------|
| **FASE 0 — Investigación normativa y arquitectura** | ✅ **Entregada** |
| **FASE 1a — Carga normativa `V1`** | ✅ **Entregada** — 21 documentos oficiales archivados con hash |
| **FASE 1b — Fundaciones técnicas** | ✅ **Entregada** — monorepo, esquema SQL con los candados, `@aai/shared`, puertas de CI |
| **FASE 2 — Empresas, usuarios, plan de cuentas** | ✅ **Entregada** — API con autenticación, MFA, RBAC y tenancy |
| **FASE 3 — Ingesta y lectura de comprobantes** | 🟡 **Construida** — ARCA, ingesta, extracción y duplicados operativos. El criterio de salida espera el corpus real |
| **FASE 4 — Motor de clasificación** | ✅ **Entregada** — la IA propone, la Validation Layer filtra, la persona aprueba |
| FASE 5 → 14 | ⬜ |

---

## FASE 0 — Investigación normativa y arquitectura ✅

Entregado: mapa de fuentes oficiales con niveles de verificación, mapa normativo, conflictos
detectados, relevamiento de APIs oficiales, arquitectura, modelo de datos, riesgos, estrategia de
seguridad y pruebas, propuesta de MVP.

---

## FASE 1a — Carga normativa `V1` ✅

21 documentos oficiales descargados, validados y archivados con SHA-256 en
`docs/normative-sources/originals/`, indexados en `registro-de-descargas.csv`.

Resultado sustantivo, más allá del archivado:

- **C-01 cerrado** — las fechas de la RG 5616/2024 no estaban en conflicto: eran hitos de dos
  normas distintas.
- **C-03 cerrado** — el art. 3° de la RT 54 enumera las derogaciones. No deroga RT 16 ni RT 26.
- **C-02 confirmado con texto oficial** — la IGJ remite a las RT adoptadas por el CPCECABA.
- **FASE 8 (IVA) desbloqueada** — RG 4597 (T.O.) y RG 5707/2025 archivadas.
- Dos hallazgos de método: el BO no sirve como fuente de texto; la documentación técnica de un
  organismo no prueba vigencia.

**Criterio de salida:** cumplido. `sha256sum -c ../checksums.sha256` verifica los 21 archivos.

**Deuda declarada:** actos de adopción de consejos fuera de CABA, ajuste por inflación,
percepciones/retenciones e IIBB. Ver `OFFICIAL_SOURCES.md` §8.

---

## FASE 1b — Fundaciones técnicas ✅

**Entregado:**

- Monorepo con npm workspaces (ADR-009), TypeScript en modo estricto con `noUncheckedIndexedAccess`
  y `exactOptionalPropertyTypes`, project references.
- `packages/shared`: `Money` sobre `bigint` en centavos con cuatro modos de redondeo y `allocate`
  que garantiza la propiedad P-7; `CalendarDate` sin zona horaria; validación de CUIT por módulo 11;
  `Result`; errores tipados con los códigos de `ACCOUNTING_ENGINE.md`.
- **9 migraciones SQL** (ADR-008) con los siete candados del Libro Diario, RLS en 25 tablas,
  bitácora encadenada por hash, motor normativo con la tabla `norm_adoptions`, y los cinco gaps
  normativos precargados.
- Contratos de `accounting-engine` y `ai-engine` — sin implementación, pero con la frontera ya
  puesta y verificada.
- Cuatro puertas de CI: typecheck, lint de arquitectura, prohibición de floats en importes,
  integridad del archivo normativo.

**Criterio de salida — cumplido y verificado contra PostgreSQL 18.6:**

| Criterio | Estado |
|----------|--------|
| Migraciones aplicadas | ✅ 10 migraciones, idempotentes (segunda corrida sin cambios) |
| Test de aislamiento entre dos empresas | ✅ 9 casos en verde |
| El lint de dependencias falla si alguien viola ADR-001 | ✅ S-8 introduce la violación y comprueba que el build se cae |
| Suite completa | ✅ **69/69** |

Esquema resultante: 43 tablas, **25 con RLS forzado** y su política, 78 constraints `CHECK`,
3 de exclusión temporal, 21 triggers, 5 gaps normativos precargados.

**Dos defectos reales que aparecieron recién al correr contra la base:**

1. `CHECK ... DEFERRABLE` no existe en PostgreSQL — solo `UNIQUE`, `PK`, `FK` y `EXCLUDE` pueden
   diferirse. El invariante `Debe = Haber` quedó mejor repartido: `CHECK` inmediato sobre los
   totales de la cabecera, y `CONSTRAINT TRIGGER` diferido para la coherencia entre esos totales y
   la suma real de las líneas, que es lo único que necesitaba esperar al `COMMIT`.
2. PL/pgSQL no cortocircuita las condiciones de un `IF`: compila la expresión entera como una sola
   sentencia SQL. El guardia de período referenciaba `NEW.kind` protegido por
   `TG_TABLE_NAME = 'journal_entries'`, y fallaba igual al correr sobre `journal_entry_lines`.
   Corregido en `0010_fix_period_guard.sql`.

Ninguno de los dos era detectable leyendo el SQL. Es el argumento a favor de que los candados
tengan tests de integración y no solo revisión.

---

## FASE 2 — Estudio, empresas, usuarios, plan de cuentas ✅

**Entregado:**

- `apps/api` sobre Fastify: autenticación con Argon2id, sesiones con expiración doble (inactividad
  y absoluta) y token guardado hasheado, bloqueo progresivo por intentos fallidos.
- **TOTP propio** (RFC 6238) en `@aai/shared`, verificado contra los cinco vectores del estándar.
  Secreto cifrado en reposo con AES-256-GCM y códigos de recuperación de un solo uso.
- **26 permisos granulares** repartidos entre los seis roles del §26. El Administrador
  deliberadamente **no** puede aprobar asientos: administrar el sistema y aprobar contabilidad son
  responsabilidades distintas (§42).
- Tenancy en tres capas efectivas: RLS en la base, `withCompany` en `@aai/db` —que no expone un
  cliente crudo— y resolución de empresa por cabecera en la API.
- Plan de cuentas por empresa, centros de costo, ejercicios con generación automática de períodos
  mensuales recortados al ejercicio, cierre y reapertura con doble firma.
- Dos tablas nuevas por huecos del modelo detectados al implementar: `organization_members`
  (pertenencia al estudio) y `mfa_recovery_codes`.

**Criterio de salida — cumplido:**

| Criterio | Estado |
|----------|--------|
| Un estudio con 3 empresas y planes de cuentas distintos | ✅ |
| Cero fugas verificadas **sobre todos los endpoints** | ✅ el barrido recorre el inventario de rutas del propio servidor, no una lista a mano |
| Suite completa | ✅ **104/104** |

**Tres defectos que solo aparecieron al ejecutar:**

1. `requireCompany` resolvía permisos sin contexto de empresa. Como `user_company_roles` está bajo
   RLS, devolvía cero filas siempre y **nadie tenía acceso a nada**. En un esquema con RLS, "no
   fijar el contexto" no es neutro: es un filtro que devuelve nada (ADR-011).
2. `grant_company_role` declaraba una variable `role_id` homónima de la columna. PL/pgSQL falla en
   ejecución, no al crear la función: sin un test que la invocara, el bug quedaba latente hasta el
   primer alta de rol en producción.
3. Las políticas RLS hacían imposible crear una empresa. Se resolvió con puntos de entrada
   privilegiados nominados en vez de aflojar la política (ADR-010).

---

## FASE 3 — Ingesta y lectura de comprobantes 🟡

### 3a — Integración con ARCA ✅

Entregada y **desacoplada**: el certificado X.509 no bloquea el desarrollo del resto del sistema.

- `packages/arca` con contrato de dominio, `MockArcaClient` determinístico (con escenarios de
  falla) y `SoapArcaClient` para homologación y producción.
- Modelo de degradación explícito: `NO_VERIFICABLE` con motivo, nunca un `OK` por omisión.
- Mapeo al sello de validación **FISCAL**, separado de la contable y la económica (§11).
- Credenciales cifradas, capacidades por empresa y bitácora de consultas
  (`0015_arca_integration.sql`).
- `npm run arca:check` diagnostica en qué paso está la configuración.

**Verificado contra homologación real** (2026-08-24): los endpoints del manual archivado responden
y `ComprobanteDummy` devolvió `app=OK db=OK auth=OK` — el sobre SOAP que arma el cliente lo entiende
ARCA y la respuesta se parsea bien. La firma CMS del TRA se verificó con un certificado autofirmado
generado en el test. **Falta únicamente** el intercambio certificado → ticket de acceso, que
requiere el trámite.

Trámite documentado paso a paso en [`docs/api/arca-onboarding.md`](docs/api/arca-onboarding.md).

### 3b — Ingesta y OCR 🟡

**Entregado:**

- `packages/document-engine`: detección de tipo por contenido, almacenamiento con hash y prefijo
  por empresa, lectura de XML / CSV / XLSX (lector de ZIP propio, sin dependencias), OCR tras
  adaptador, extracción con las cuatro dimensiones del §10, controles de coherencia y duplicados en
  tres niveles.
- Migraciones `0016` y `0017`: `documents`, `document_versions`, `document_extractions`,
  `document_extraction_fields`, `document_findings`, `document_duplicates` y
  `arca_comprobante_types`, con RLS y borrado prohibido.
- API: subida multipart, bandeja de revisión, descarga del original, corrección manual de campos y
  resolución de duplicados.
- `npm run metrics:extraction`: mide la extracción contra un corpus y **falla si hay algún error
  silencioso**.

**Cuatro decisiones que definen el comportamiento:**

1. **Se archiva antes de interpretar**, y se archiva aunque la interpretación falle por completo.
2. **Ante ambigüedad real, se abstiene.** `1.234` puede ser 1234 o 1,234 —mil veces de diferencia—
   y `12/25/2026` no es una fecha argentina. El sistema no elige por el contador.
3. **La lectura nunca se sobrescribe.** La corrección del contador inserta una fila `MANUAL`; lo
   impide un trigger y, desde la `0017`, también la falta del privilegio.
4. **Sin motor de OCR configurado no se cae al simulado.** Informa `SIN_MOTOR_OCR`.

**Hallazgo normativo:** la tabla de tipos de comprobante de ARCA no es una constante sino normativa
versionada en el tiempo. Ver `OFFICIAL_SOURCES.md` §8.1.

**Criterio de salida — estado:**

| | |
|---|---|
| Métricas de extracción por campo publicadas | ✅ instrumento listo y probado |
| Constatación en ARCA en homologación | 🟡 transporte y parseo verificados; falta el certificado |
| 100 comprobantes reales anonimizados procesados | ⬜ **requiere el corpus** |

El tercero no se puede cerrar desde acá: un conjunto de facturas sintéticas mide la calidad del
generador, no la del sistema. El instrumento está construido y probado; los documentos los aporta
quien los tiene. Ver [`corpus/README.md`](corpus/README.md).

---

## FASE 4 — Motor de clasificación ✅

**Entregado:**

- `packages/ai-engine`: `ClassificationAgent`, Validation Layer, sistema de confianza con
  disparadores duros, aprendizaje por empresa y proveedor agnóstico con modo sin IA externa.
- Migración `0018`: `prompt_versions` (con FK desde `ai_predictions` y prompts inmutables),
  `ai_rejections`, triage persistido con la predicción, preferencias con cuentas compitiendo.
- API: `POST /documents/:id/classify`, bandeja `GET /predictions`, revisión y métricas de deriva.

**Criterio de salida — cumplido:**

| | |
|---|---|
| Ninguna propuesta puede postearse sin aprobación | ✅ `je_ai_requires_human_approval`, con test |
| Toda cita resuelve o la propuesta se rechaza | ✅ y se registra como alucinación detectada |

**Cinco decisiones que definen el comportamiento:**

1. **La salida es cerrada y no tiene dónde poner un importe.** La cuenta es un `enum` con el plan
   real; los importes no existen en el schema. No es una regla a recordar: es que no hay lugar.
2. **Solo se cita lo que vino en el contexto.** Una norma que el modelo "recuerda" pero que nadie
   le pasó no está fundada en nada verificable.
3. **Inventar ≠ equivocarse.** Una cuenta inexistente es alucinación; una cuenta de agrupación mal
   elegida es criterio. Se registran por separado porque no se corrigen igual.
4. **Los disparadores duros se calculan de hechos**, nunca se le preguntan al modelo. El importe
   atípico usa mediana y MAD sobre `bigint`, no media y desvío: la media se deja arrastrar
   justamente por el outlier que se busca.
5. **Sin proveedor de IA el sistema sigue sugiriendo**, con la historia de la empresa y sin mandar
   nada afuera. Es un modo previsto (§8), no un estado degradado.

**Consecuencia declarada:** mientras el motor normativo no exista (FASE 6), el estado normativo es
`NO_CONSULTADO` —que no es `FUENTE_NO_ENCONTRADA`: nadie preguntó— y funciona como disparador duro.
**Toda propuesta cae hoy en 🔴 y ninguna se aprueba en lote.** Es lo correcto: aprobar contabilidad
en tanda sin motor normativo sería exactamente lo que este diseño evita.

---

## FASE 5 — Motor contable

`accounting-engine` completo con las 11 validaciones, constraints en base, numeración, períodos,
contraasientos, `Validation Layer`.

**Criterio:** la suite de *accounting tests* (§33) pasa al 100%, incluidos los casos de intento de
descuadre, de posteo en período cerrado y de borrado físico.

---

## FASE 6 — Libro Diario · FASE 7 — Libro Mayor

Diario trazable con todos los campos del §15; Mayor como proyección reconstruible; balance de
sumas y saldos; exportaciones.

**Criterio:** el Mayor reconstruido desde el Diario coincide exactamente; el balance cierra en sus
tres igualdades; cada movimiento navega hasta el documento original.

---

## FASE 8 — IVA

`tax-engine`: crédito y débito fiscal, notas de crédito y débito, percepciones, retenciones,
saldos, ajustes, subdiarios IVA Compras / IVA Ventas, base para el Libro de IVA Digital.

**Bloqueante previo:** descarga y carga oficial de RG 4597 T.O. y RG 5707/2025. Sin eso, esta fase
no arranca — es exactamente el caso en que el sistema debe decir "no tengo fuente".

---

## FASE 9 — Bancos

Importación de extractos, `Bank Reconciliation Engine`, matching automático con score, detección de
diferencias, transferencias internas, comisiones e impuestos bancarios.

**Criterio:** conciliación de un mes real con ≥ 80% de matching automático propuesto y 0
conciliaciones confirmadas sin intervención humana.

---

## FASE 10 — Estados contables

`statement_templates` versionadas por `(framework, entity_type, regulator, period)`; ESP, ER, EEPN,
EFE; información comparativa; anexos.

**Criterio:** dos empresas con marcos distintos generan estructuras distintas **sin cambiar código**;
todo renglón tiene `lineage_id` no nulo.

---

## FASE 11 — Notas

`Notes Engine`, notas con cada cifra referenciada, políticas contables, borradores del `Notes Agent`.

**Criterio:** invariante A-2 (`AUDIT_TRAIL.md`) pasa: no existe cifra en nota sin respaldo.

---

## FASE 12 — Auditoría

Bitácora encadenada, verificador de cadena, reportes de auditoría, alertas completas del §22,
modo Auditor.

**Criterio:** los 8 invariantes A-1..A-8 corren en CI y fallan el build al violarse.

---

## FASE 13 — Integraciones oficiales

Ampliación de servicios ARCA según habilitaciones reales, `Normative Update Service` con CKAN de
datos.gob.ar, monitoreo del Boletín Oficial, exportaciones a formatos de organismos.

**Advertencia:** el alcance real depende de qué servicios tenga habilitado cada CUIT. Se diseña
para degradar sin romper.

---

## FASE 14 — IA avanzada

`Contador IA` conversacional sobre datos reales, análisis de variaciones, `Audit Agent`, detección
de anomalías, sandbox de simulación (§34) completo.

---

## Orden de trabajo recomendado

Fases 1 → 2 → 3 → 5 → 6 → 7 → 4 → 8 → 9 → 10 → 11 → 12 → 13 → 14.

**Diferencia con el pliego, deliberada y explicada:** conviene construir el motor contable (5) y
los libros (6, 7) **antes** del clasificador de IA (4). Motivo: el clasificador necesita un destino
válido y verificable para sus propuestas. Construirlo primero obliga a validarlo contra algo que
todavía no existe, y crea la tentación de dejar que la IA escriba directamente — exactamente lo
que el §29 prohíbe. Con el motor listo, el clasificador nace ya encajonado detrás de la
`Validation Layer`.

Si preferís seguir el orden literal del pliego, es viable: requiere que la FASE 4 entregue solo
propuestas persistidas en `ai_predictions`, sin destino contable, y se valide contra fixtures.
