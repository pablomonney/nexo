# ROADMAP.md

> Entregable G del §51. Fases del §43, con criterios de salida verificables. Una fase no se cierra
> con "está hecho": se cierra cuando su criterio pasa en CI.

## Estado actual

| Fase | Estado |
|------|--------|
| **FASE 0 — Investigación normativa y arquitectura** | ✅ **Entregada** |
| **FASE 1a — Carga normativa `V1`** | ✅ **Entregada** — 32 documentos oficiales archivados con hash |
| **FASE 1b — Fundaciones técnicas** | ✅ **Entregada** — monorepo, esquema SQL con los candados, `@aai/shared`, puertas de CI |
| **FASE 2 — Empresas, usuarios, plan de cuentas** | ✅ **Entregada** — API con autenticación, MFA, RBAC y tenancy |
| **FASE 3 — Ingesta y lectura de comprobantes** | 🟡 **Construida** — ARCA, ingesta, extracción y duplicados operativos. El criterio de salida espera el corpus real |
| **FASE 4 — Motor de clasificación** | ✅ **Entregada** — la IA propone, la Validation Layer filtra, la persona aprueba |
| **FASE 5 — Motor contable** | ✅ **Entregada** — once validaciones, numeración sin huecos, contraasientos, balance |
| **FASE 5b — Motor normativo** | ✅ **Entregada** — no tenía fase asignada. Vigencia bitemporal, adopción jurisdiccional, citas |
| **FASE 6 — Libro Diario** | ✅ **Entregada** — siete controles de forma, cada uno citando su artículo del CCyC |
| **FASE 7 — Libro Mayor** | ✅ **Entregada** — proyección verificada contra el Diario, exportación canónica |
| **FASE 8 — IVA** | ✅ **Entregada** — alícuotas desde el art. 28 archivado; el crédito fiscal sigue sin decir `COMPUTABLE`, y ahora por el motivo correcto |
| **FASE 9 — Bancos** | ✅ **Entregada** — cero conciliaciones confirmadas sin intervención humana, con cinco candados en la base |
| **FASE 10 — Estados contables** | ✅ **Entregada** — ESP y ER transcriptos de los arts. 63 y 64, con la convención de plan de cuentas declarada |
| **FASE 11 — Notas** | ✅ **Entregada** — cada cifra referenciada al estado, ninguna escrita a mano |
| **FASE 12 — Invariantes** | ✅ **Entregada** — A-1..A-8 como puerta de CI que devuelve filas, no cuentas |
| **FASE 13 — Integraciones oficiales** | ✅ **Entregada** — habilitaciones que degradan sin romper; vigilancia que produce candidatos, nunca normas |
| **FASE 14 — IA avanzada** | ✅ **Entregada** — auditoría determinística y un respondedor que no puede inventar un número |
| **FASE 15 — Sandbox de simulación** | ✅ **Entregada** — el candado exige prueba de ser un sandbox en vez de sospechar de producción |

---

## FASE 0 — Investigación normativa y arquitectura ✅

Entregado: mapa de fuentes oficiales con niveles de verificación, mapa normativo, conflictos
detectados, relevamiento de APIs oficiales, arquitectura, modelo de datos, riesgos, estrategia de
seguridad y pruebas, propuesta de MVP.

---

## FASE 1a — Carga normativa `V1` ✅

32 documentos oficiales descargados, validados y archivados con SHA-256 en
`docs/normative-sources/originals/`, indexados en `registro-de-descargas.csv`.

Resultado sustantivo, más allá del archivado:

- **C-01 cerrado** — las fechas de la RG 5616/2024 no estaban en conflicto: eran hitos de dos
  normas distintas.
- **C-03 cerrado** — el art. 3° de la RT 54 enumera las derogaciones. No deroga RT 16 ni RT 26.
- **C-02 confirmado con texto oficial** — la IGJ remite a las RT adoptadas por el CPCECABA.
- **FASE 8 (IVA) desbloqueada** — RG 4597 (T.O.) y RG 5707/2025 archivadas; la Ley de IVA (t.o. 1997) se sumó el 2026-08-26.
- Dos hallazgos de método: el BO no sirve como fuente de texto; la documentación técnica de un
  organismo no prueba vigencia.

**Criterio de salida:** cumplido. `sha256sum -c ../checksums.sha256` verifica los 32 archivos.

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

**Verificado contra homologación real, con certificado de ARCA** (2026-08-26/27):

- `ComprobanteDummy` → `app=OK db=OK auth=OK`: el sobre SOAP se entiende y la respuesta se parsea.
- **La firma CMS del TRA la acepta el organismo.** Se mandó el mismo CMS íntegro y con ocho bytes
  de la firma invertidos: contestó `coe.notAuthorized` al primero y `cms.bad` al segundo. Que los
  distinga es la prueba — con un autofirmado de test eso no se podía saber.
- **El intercambio certificado → ticket de acceso funciona**, con un TA real parseado del servicio.

**El permiso del WSAA es por servicio, y eso cambia qué está verificado.** El certificado está
autorizado a `wsfe`; `wscdc` —el de constatación— es un trámite aparte en WSASS y sigue sin hacerse.
Tener uno no implica el otro: `npm run arca:check -- --servicio wsfe,wscdc` los informa por separado
justamente para que la diferencia no se pierda.

**El WSAA emite UN ticket por CUIT y servicio** y niega el segundo hasta que el primero venza, horas
después. Por eso `TicketCacheFs` guarda el TA en disco fuera del repositorio y los comandos comparten
la carpeta: sin eso, verificar la conexión deja sin ticket al comando que emite.

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
| Constatación en ARCA en homologación | 🟡 transporte, parseo y WSAA verificados con certificado real; falta autorizar `wscdc` en WSASS — el certificado hoy solo tiene `wsfe` |
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

**Consecuencia declarada:** desde FASE 5b la clasificación consulta al motor normativo, pero
`accounting_rules` está vacía, así que el estado es `FUENTE_NO_ENCONTRADA` —se preguntó y no hay
nada relevado— y funciona como disparador duro. **Toda propuesta cae hoy en 🔴 y ninguna se aprueba
en lote.** Es lo correcto: aprobar contabilidad en tanda sin reglas fundadas sería exactamente lo
que este diseño evita.

---

## FASE 5 — Motor contable ✅

**Entregado:**

- `packages/accounting-engine`: las once validaciones del §2, conversión de moneda extranjera con
  modo de redondeo como parámetro, contraasiento, máquina de estados del período, checklist de
  cierre y balance de sumas y saldos con sus tres igualdades.
- `convert()` en `@aai/shared`: conversión exacta entre monedas con distinta cantidad de decimales,
  reutilizando la misma división redondeada que `multiplyByRate` — dos implementaciones del
  redondeo son dos criterios que en algún momento divergen.
- API: alta de asientos, aprobación, contraasiento, listado y `GET /reports/trial-balance`.
- **Séptima puerta de CI**: cobertura. Estaba declarada en la configuración de vitest desde FASE 1b
  pero `@vitest/coverage-v8` no estaba instalado, así que el umbral del 95% para el motor contable
  era inaplicable. Ahora corre en `npm run verify`.

**Criterio de salida — cumplido:**

| Caso exigido por el §33 | Estado |
|---|---|
| Intento de descuadre | ✅ 422 con `E_UNBALANCED`, sin ajuste automático |
| Posteo en período cerrado | ✅ 422 con `E_PERIOD_CLOSED` |
| Borrado físico | ✅ prohibido por trigger, verificado |
| Suite de accounting tests | ✅ 48 unitarios + 12 de integración por HTTP |

**Cuatro decisiones que definen el comportamiento:**

1. **Ante un descuadre rechaza, no ajusta.** No hay cuenta de diferencias donde esconder el resto.
2. **El signo lo da la columna**: importes negativos rechazados, y el contraasiento **intercambia**
   Debe y Haber en vez de restar.
3. **El motor no numera.** Devuelve un asiento listo para numerar; el número lo toma el repositorio
   dentro de la transacción. Un test postea diez asientos en paralelo y verifica que la secuencia
   salga sin saltos. Un asiento anulado conserva su número.
4. **En la base van los importes originales** con su moneda y cotización; el convertido se
   recalcula. Guardar solo el convertido perdería la operación tal como ocurrió.

**Un caso que vale la pena mirar:** hay un test donde el mismo asiento en dólares cuadra con
`HALF_UP` y no cuadra con `DOWN`. Es la razón concreta por la que el modo de redondeo es un
parámetro normativo y no una constante del código (ADR-005).

---

## FASE 5b — Motor normativo ✅

> **Corrección de planificación.** El motor normativo no tenía fase asignada: sus tablas se crearon
> en FASE 1b y `NORMATIVE_ENGINE.md` lo describe desde FASE 0, pero ninguna fase lo implementaba. En
> FASE 4 lo referencié como "FASE 6", que en este roadmap es el Libro Diario. Queda como **5b**, entre
> el motor contable y los libros, porque es lo que los dos necesitan: sin él ninguna regla tiene
> fuente y ninguna propuesta se puede fundar.

**Entregado:**

- `packages/normative-engine`: aplicabilidad de cinco variables con adopción jurisdiccional,
  resolución bitemporal, intérprete cerrado de condiciones y render de citas.
- `npm run norms:seed`: el archivo de FASE 1 pasa a ser consultable.
- `docs/normative-sources/vigencias.csv`: las fechas de vigencia como dato citable, con el artículo
  del que surge cada una.
- La clasificación asistida ya consulta al motor en vez de declarar `NO_CONSULTADO`.

**Cuatro decisiones:**

1. **La vigencia no es `WHERE fecha <= now()`.** Se ata al inicio del ejercicio, depende del acto de
   adopción de la jurisdicción, y la aplicación anticipada a veces se ancla al cierre.
2. **Ser elegible no es haber optado.** La aplicación anticipada es una opción del ente que se
   registra; deducirla de que las fechas dan sería decidir por él.
3. **Un empate solo lo resuelve una derogación declarada.** Hay dos tests gemelos: la misma
   situación da `CONFLICTO` sin la relación y se resuelve con ella. "La más nueva gana" es una
   heurística razonable que se equivoca en silencio.
4. **Lo que el intérprete no puede evaluar, falla; nunca vale `false`.** Una regla que deja de
   aplicarse sin que nadie se entere es peor que una que rompe.

**Estado de los datos, declarado:** 14 de 25 documentos cargados —los que tienen fecha de emisión
verificada—, **1 adopción** (CABA, por la Res. P. N° 460/2024, archivada el 2026-08-26) y **0
reglas**. Para que haya reglas hay que transcribir articulado con revisión humana. Mientras tanto el
motor responde `FUENTE_NO_ENCONTRADA`, que es la verdad; y las jurisdicciones sin acto relevado
siguen respondiendo `ADOPCION_NO_RELEVADA`, que también lo es.

---
## FASE 6 — Libro Diario · FASE 7 — Libro Mayor ✅

Diario trazable con todos los campos del §15; Mayor como proyección reconstruible; balance de
sumas y saldos; exportaciones.

**Criterio:** el Mayor reconstruido desde el Diario coincide exactamente; el balance cierra en sus
tres igualdades; cada movimiento navega hasta el documento original. **Cumplido**, con un test por
cada una de las tres afirmaciones.

**Fuente que gobierna la fase:** Ley 26.994 — CCyC arts. 320 a 331, archivada con su sha256 y
cargada al motor normativo. Cada control de forma del Diario cita el inciso del que sale.
Documentado en [BOOKS.md](BOOKS.md).

**Las decisiones:**

1. **Un libro no es un reporte.** El Diario además de mostrar lo que hay declara si está bien
   llevado (art. 330: la contabilidad prueba en juicio *si* se lleva en la forma prescrita). Siete
   controles de forma, cada uno citando su artículo, ninguno bloqueante y todos grabados en la
   emisión.
2. **La aplicación no escribe el Mayor.** Lo escribe un trigger desde el Diario y a `aai_app` se le
   revoca el INSERT. Una proyección que se puede escribir a mano deja de ser una proyección.
3. **Un movimiento del Mayor no se borra nunca, ni al anular el asiento.** El contraasiento lo
   compensa; borrarlo además lo contaría dos veces — y borrar es lo que el art. 324 inc. c prohíbe.
4. **Resumir el Diario exige subdiario declarado** (art. 327). Agrupar por mes y sumar es trivial;
   lo que el artículo pide es que atrás haya un registro detallado. Sin él, el motor se niega.
5. **La exportación es canónica y hasheada**, con punto decimal y LF: un número formateado según el
   locale haría que el hash dependa de la máquina donde se corrió.

> **Defecto de la FASE 5 corregido acá.** `journal_entry_lines.debit` guardaba el importe
> *original* mientras la cabecera guardaba el *convertido*. Con todo en pesos coinciden y no se
> nota; con una línea en dólares el asiento se caía al COMMIT con `E_UNBALANCED`, el balance sumaba
> centavos de dólar como pesos, y el Mayor habría heredado la mezcla. La migración `0020` separa las
> dos cosas en columnas distintas: `debit`/`credit` es lo que el libro registra, `original_*` es la
> operación tal como ocurrió. Ninguna de las dos sobra.

**Lo que queda declarado como gap:** foliatura y rúbrica del art. 323 (es un trámite, no un dato que
el software produzca), política de retención del art. 328, subdiarios como libros propios (llegan en
FASE 8) y exportación a PDF con formato de libro.

---

## FASE 8 — IVA ✅

`tax-engine`: subdiarios IVA Compras / IVA Ventas, notas de crédito, evaluación del crédito fiscal
y Libro de IVA Digital.

**Bloqueantes previos, ambos cumplidos:** RG 4597 T.O. y RG 5707/2025 están archivadas y cargadas;
y el 2026-08-26 se archivó la **Ley de Impuesto al Valor Agregado (t.o. 1997)**, que era el gap más
caro del repositorio.

La fase pasa a ✅. `tax_rates` tiene cinco filas sembradas desde el art. 28, cada una citando su
párrafo, y el art. 12 aportó un control que antes no se podía hacer: la **regla de tope**, medida
contra la alícuota más alta vigente y no contra la general — comparar contra el 21% convertiría en
hallazgo toda factura de energía eléctrica al 27%, que es el caso legítimo del segundo párrafo.

**Dos bordes que quedan, y son bordes reales, no pendientes de tiempo:**

1. Para hechos imponibles **anteriores al 18/11/2002** el motor sigue respondiendo
   `SIN_ALICUOTAS_RELEVADAS`. El texto archivado es un T.O. *actualizado*: lista sus antecedentes y
   no los transcribe. Lo único afirmable sobre el pasado es la ventana del Decreto 2312/2002 (19%
   hasta el 17/01/2003), que el propio art. 28 transcribe — y esa ventana cerrada es lo que ancla el
   21%. Es la misma lección que dio la RG 4597.
2. `EstadoCreditoFiscal` **sigue sin `COMPUTABLE`**, y el motivo mejoró. Ya no es que falte la ley:
   es que el art. 12 condiciona el cómputo a la vinculación con operaciones gravadas, que es un hecho
   del negocio. La misma factura de nafta es crédito para la empresa de fletes y no para el auto del
   socio, y los dos comprobantes son idénticos. Archivar la ley no trajo ese dato — trajo poder
   nombrarlo con precisión.

**Las decisiones:**

1. **No hay un `21` en el código.** Ni `0.21`, ni una constante `IVA_GENERAL`. Las alícuotas salen
   de `tax_rates`, con `norm_version_id NOT NULL`: ADR-005 hecho constraint. Suponer 21% acertaría
   casi siempre, y fallaría en silencio en carnes, medicina prepaga y bienes de capital.
2. **`EstadoCreditoFiscal` no tiene `COMPUTABLE`.** La computabilidad la deciden los arts. 12 y 13
   de la Ley 23.349. El motor verifica todo lo verificable —constatación, apócrifos, discriminación,
   alícuota, total— y devuelve `NO_DETERMINABLE` con esa lista y con lo que falta relevar.
3. **El signo de un comprobante lo decide el catálogo, no una lista de códigos.** Se resuelve contra
   `arca_comprobante_types` por la fecha del comprobante. Código desconocido = bloqueo, no "suma".
4. **El subdiario de IVA es el subdiario del art. 327 del CCyC.** `comoSubdiarioDeclarado()` devuelve
   la estructura que el motor contable exige para aceptar un asiento resumido, con hash.
5. **Tres negativas con su artículo**: no genera el archivo de importación (art. 8°: los diseños están
   en el micrositio, no en la norma), no presenta el libro (art. 6°: Clave Fiscal Nivel 3, que este
   sistema no pide ni guarda) y no dice quién estaba obligado antes del 01/12/2025 (el texto anterior
   del art. 2° lo puso la RG 5133/2021, no archivada).

Documentado en [TAX_ENGINE.md](TAX_ENGINE.md).

---

## FASE 9 — Bancos ✅

Importación de extractos, `bank-engine`, matching con score, acta de conciliación y partidas
conciliatorias.

**Criterio:** conciliación de un mes real con ≥ 80% de matching automático propuesto y 0
conciliaciones confirmadas sin intervención humana. **La segunda mitad está cumplida y es
inviolable**: son cinco candados en la base, no una validación de la aplicación, y hay un test que
intenta romper cada uno con SQL directo. La primera mitad es un indicador que el motor calcula
(`cobertura.porcentaje`) y que se verifica recién con un extracto real — como el corpus de FASE 3.

**Las decisiones:**

1. **El importe exacto es precondición, no un componente del puntaje.** Casi todo el software de
   conciliación pesa el importe y deja ganar a un match con cincuenta centavos de diferencia. Eso
   cierra una factura equivocada y deja el saldo del proveedor mal para siempre.
2. **El empate no se resuelve.** Dos líneas con el mismo puntaje vuelven las dos. Y un movimiento
   ambiguo **no cuenta como cubierto**: contarlo inflaría el indicador con los casos que más trabajo
   humano requieren.
3. **`ENTRADA`/`SALIDA`, nunca `DEBITO`/`CREDITO`.** En el extracto "débito" es plata que sale; en
   el libro es plata que entra. La traducción se hace una sola vez, en el importador.
4. **El acta cierra o dice cuánto falta.** `saldo extracto + partidas = saldo libro`, y es un
   constraint: una conciliación descuadrada no se puede confirmar.
5. **El motor no clasifica las partidas por concepto.** No dice "comisión" ni "impuesto Ley 25.413":
   esa ley no está archivada y la descripción del banco no es una fuente. Dice de qué lado quedó y
   dónde mirar.
6. **La importación no adivina el formato.** Mapeo declarado por cuenta, y la cadena de saldos como
   control de integridad — una columna corrida la rompe en la primera fila afectada.

> **Defecto encontrado por un test durante la fase.** El acta tenía el signo invertido en dos de los
> cuatro casos de partida conciliatoria. Cerraba igual cuando los importes de las dos puntas
> coincidían, que es el caso de prueba que uno escribe primero. La causa de fondo no era el signo
> sino el vocabulario: `DEBITO`/`CREDITO` significan cosas opuestas según quién mire. Se corrigió
> renombrando el tipo, no ajustando los signos.

Documentado en [BANKS.md](BANKS.md).

---

## FASE 10 — Estados contables ✅

`statement_templates` versionadas por `(framework, entity_type, regulator, period)`; ESP y ER;
información comparativa.

**Criterio:** dos empresas con marcos distintos generan estructuras distintas **sin cambiar código**;
todo renglón tiene `lineage` no nulo. **Cumplido**: hay un test que arma el mismo balance con dos
plantillas y obtiene doce renglones contra siete, con los mismos totales; y el linaje no es opcional
ni en los tipos ni en la base.

`statement_templates` tiene el **ESP y el ER** transcriptos de los arts. 63 y 64, para SA / IGJ /
RT FACPCE. Cada rubro cita su inciso, en el orden del artículo y no en el que quedaba cómodo.

La transcripción obligó a una decisión que conviene tener a la vista: **el art. 63 pide separaciones
que `accounts.type` no da**. Créditos y bienes de cambio son los dos ACTIVO; corriente y no
corriente también. Así que los selectores usan prefijos de código, y eso ata las plantillas a una
convención de plan de cuentas — que queda declarada, se imprime al sembrar, y no es obligatoria para
nadie: una empresa con otra codificación carga la suya.

Lo que hace aceptable ese supuesto es cómo falla: `CUENTA_SIN_RUBRO` marca cada cuenta que ningún
renglón capturó y el estado sale con `emisible = false`. No hay forma de que un plan incompatible
produzca un balance que parezca correcto.

**Una corrección de transcripción no es un cambio de norma.** La v1 del ER tomaba `4.` entero y
excluía `4.9`, y `excluir` compara códigos exactos: la ganancia extraordinaria sumaba dos veces. Lo
encontró `CUENTA_EN_DOS_RUBROS`. Como la base no deja reescribir ni borrar una plantilla publicada,
la corrección entró como v2 y la v1 se cerró con `valid_to = valid_from` — una ventana de largo
cero, que dice exactamente lo que pasó: esa versión nunca tuvo un día aplicable. Cerrarla "desde
hoy" habría dejado que un estado de un ejercicio anterior volviera a tomarla.

**Las decisiones:**

1. **La estructura es dato, no código.** Un árbol declarativo, no un módulo por marco con un `if`
   por regulador. Y por eso se valida antes de usarla: viene de la base.
2. **El selector es cerrado**: prefijos, tipos, códigos, exclusiones. Un lenguaje de expresiones
   sería más flexible y nadie podría auditar qué cuentas caen en cada rubro.
3. **Ninguna cifra existe sin origen.** No hay ningún tipo ni columna donde escribir un importe;
   todo renglón se deriva de cuentas y sale con las que lo formaron.
4. **Una cuenta que ningún renglón captura bloquea la emisión.** Su saldo desaparece del estado, y a
   veces el estado igual cierra porque dos huérfanas se compensan: ahí nadie lo nota nunca.
5. **Un estado que no cierra no se emite** — a diferencia del Libro Diario, que sí se emite con sus
   observaciones. El Diario registra lo que pasó; el estado contable afirma.

> **Tres defectos que encontraron los tests durante la fase.** Un selector con solo `codigos`
> capturaba todo el plan, porque los otros criterios "no declarados" no filtraban y su conjunción era
> verdadera. El recorrido del árbol cortaba en el nivel 6, así que una plantilla más profunda quedaba
> truncada en silencio y el control que existía para rechazarla nunca corría. Y la ecuación
> patrimonial se desactivaba con un error de tipeo: un código inexistente daba "0 = 0 + 0" y pasaba.
>
> Además, `TipoEnte` tenía seis valores inventados desde la intuición en vez de los doce de
> `companies.entity_type`, y `Regulador` no contemplaba `PROVINCIAL` ni el `NULL` de la base.

Documentado en [STATEMENTS.md](STATEMENTS.md).

---

## FASE 11 — Notas ✅

Notas con cada cifra referenciada, remisiones cruzadas y borradores marcados como tales.

**Criterio:** el invariante A-2 pasa — no existe cifra en nota sin respaldo. **Cumplido**, y no por
validación sino por construcción: `note_figures.statement_line_id` es `NOT NULL` y una
`CifraDeNota` solo se puede obtener de `cifraDeRenglon()`, que la deriva de un renglón del estado.

**Las decisiones:**

1. **Una cifra de nota no se escribe: se referencia.** No hay constructor que acepte un importe. La
   alternativa —dejar escribir el número y validar después que coincida— falla la primera vez que el
   estado se recalcula: la nota queda con el número viejo y lo dice con toda naturalidad.
2. **Un trigger verifica que el importe de la cifra sea el del renglón.** Una nota que informa un
   número distinto del estado del que sale es peor que una nota sin cifras.
3. **Se controlan las dos direcciones de la remisión.** `REMISION_SIN_NOTA` lo revisa todo el mundo;
   `NOTA_NO_REFERIDA` casi nadie, y es el que delata la nota que quedó del ejercicio anterior — con
   las cifras del ejercicio anterior adentro.
4. **Un borrador de IA no llega a un estado emitido** (§42). La nota es una afirmación profesional:
   tiene que pasar a HUMANO antes. Es el mismo candado que `je_ai_requires_human_approval`.
5. **El sistema no redacta.** Arma la estructura y pega las cifras con su origen; el texto lo escribe
   quien firma.

---

## FASE 12 — Auditoría ✅

Los ocho invariantes de `AUDIT_TRAIL.md` como puerta de CI.

**Criterio:** A-1..A-8 corren en CI y **fallan el build** al violarse. Cumplido:
`npm run audit:invariants` es parte de `npm run verify`, devuelve las filas que violan cada uno —no
un conteo— y sale con código distinto de cero.

**Dos decisiones:**

1. **Un invariante vacuo no es un invariante verde.** A-2 y A-4 hoy no tienen filas sobre las que
   fallar, y se informan aparte. Un tablero que los pinta iguales acompaña una base vacía con la
   misma cara que una base sana.
2. **Donde el invariante puede ser un candado, se vuelve candado.** A-3 —todo asiento aprobado tiene
   comprobante o justificación— pasó a ser un CHECK: un invariante que solo se verifica después ya
   se violó cuando se detecta.

> **El invariante A-5 encontró un defecto serio de la FASE 1b: la cadena de auditoría se bifurcaba.**
>
> `audit_chain_link()` buscaba el eslabón anterior con `ORDER BY occurred_at DESC`, y `occurred_at`
> es `now()` — la hora de **inicio de la transacción**, no la del INSERT. Con transacciones
> concurrentes sobre la misma empresa, sus horas de inicio se intercalan con el orden real de
> inserción, y tres entradas terminaban con el mismo `prev_hash`. En la base de desarrollo había 19
> bifurcaciones sobre 204 entradas.
>
> Importa más que un bug común: una cadena de hashes existe para que agregar, borrar o reordenar una
> entrada sea detectable, y en una bifurcación esa propiedad se pierde **en silencio** — dos ramas
> paralelas admiten que se borre una entera sin que ningún eslabón quede colgando. El control que
> protege la bitácora estaba roto justo bajo carga, que es cuando hace falta.
>
> La migración `0025` encadena por un `seq` de secuencia —el orden en que las entradas entraron— y
> mete `seq` en el payload, así reordenar la bitácora también rompe la cadena. El candado de
> serialización estaba bien; lo que estaba mal era la pregunta.

**Lo que queda de la fase, declarado:** reportes de auditoría y modo Auditor como pantallas; las
alertas del §22 más allá de las ya implementadas.

---

## FASE 13 — Integraciones oficiales ✅

Relevamiento de habilitaciones de ARCA y vigilancia normativa.

**La advertencia del roadmap —"se diseña para degradar sin romper"— se convirtió en una distinción
que atraviesa toda la fase:**

    NO ESTÁ DELEGADO  ≠  NO SE PUDO AVERIGUAR

Un servicio que el contribuyente no delegó es un hecho estable. Uno que no respondió porque el
organismo estaba caído es un hecho de hace treinta segundos. Tratarlos igual hace que **una caída de
veinte minutos deje el sistema creyendo, para siempre, que el estudio no tiene habilitado el
padrón**: nadie vuelve a intentarlo porque la tabla dice que no está.

**Las decisiones:**

1. **`NO_VERIFICABLE` no se persiste.** `esPersistible()` devuelve `false`, y la base lo refuerza:
   `enabled = false` exige `verified_at`, y una caída no tiene fecha.
2. **Una habilitación vence a los 30 días.** Un relevamiento viejo no es evidencia sobre hoy — las
   delegaciones se revocan. `VENCIDO` es una tercera respuesta, no un `NO_DELEGADO`.
3. **No saber no es motivo para no intentar.** `VENCIDO`, `NO_RELEVADO` y `NO_VERIFICABLE` permiten
   la llamada; `NO_DELEGADO` y `SIN_CREDENCIAL` la frenan. Insistir contra un servicio no delegado
   es cómo un CUIT termina bloqueado por el organismo.
4. **El relevamiento informa consecuencias, no servicios.** "Falta el A13" no le dice nada a nadie;
   "no vas a poder verificar la condición del emisor frente al IVA" sí.
5. **La vigilancia produce candidatos, nunca normas.** `norm_candidates` no tiene `norm_version_id`
   ni texto, y no hay FK ni trigger que promueva. El camino de candidato a norma pasa por bajar el
   documento oficial, calcular su sha256 y registrarlo a mano.
6. **El Boletín Oficial se trata como un aviso, no como una fuente** (R-22). Se detecta que un
   número apareció; sacar de ahí el articulado es adivinar con buena presentación.
7. **La identificación es conservadora.** Sin organismo en el título no se identifica: la RG 9/2026
   de ARCA y la de IGJ son normas distintas, y un identificador equivocado manda a alguien a buscar
   la que no es.

```bash
npm run arca:capabilities -- --cert … --key … --cuit … --company <uuid>
npm run norms:watch
```

**Lo que queda declarado:** las exportaciones a formatos de organismos siguen bloqueadas por lo que
encontró la FASE 8 — los diseños de registro del Libro de IVA Digital no están en la norma (RG 4597
art. 8°). Y `norm_watch_sources` queda vacía: activar un vigilante contra una URL que nadie miró
llena la bandeja de candidatos que nadie revisa.

---

## FASE 14 — IA avanzada ✅

Análisis de variaciones, detección de anomalías y el respondedor sobre datos reales.

**La decisión de fondo: dos de las cuatro piezas no usan IA, y usarla sería peor.**

Un hallazgo de auditoría tiene que poder explicarse ante un tercero. *Este gasto subió 340%*, *este
asiento se cargó seis meses después de su fecha*: son afirmaciones aritméticas sobre datos que el
sistema tiene, y un modelo que las produzca agrega una capa no auditable a cambio de nada. El
`audit-engine` es determinístico entero.

**El respondedor y su control central.** Es la pieza más peligrosa del producto: un clasificador que
se equivoca produce una propuesta que alguien revisa contra un comprobante; un respondedor que se
equivoca produce **una frase con un número adentro** que se lee, se copia a un mail y se manda al
cliente. Nadie la revisa contra nada, porque no se ve como una propuesta.

El control no es una instrucción del prompt —"no inventes cifras" no es un control— sino una
verificación mecánica: **se extraen todos los numerales de la respuesta y se comparan con los que se
le pasaron al modelo**. Cualquiera que no esté es una alucinación y la respuesta se rechaza
**entera** — tachar el número dejaría la frase que lo rodeaba, y esa frase afirmaba algo.

Un número de artículo inventado se rechaza igual que un importe: citar el "art. 471" de una norma de
doce artículos es inventar lo mismo.

**Otras decisiones:**

1. **Una anomalía dice qué se observó y qué mirar, nunca qué significa.** Sin severidad ni puntaje:
   priorizar exigiría un número de riesgo que el software no puede fundar.
2. **El análisis de variaciones no elige entre porcentaje e importe.** Y el cero no es un porcentaje
   muy grande: una cuenta que pasó de cero a saldo **apareció**.
3. **Sin umbrales configurados, el detector de "justo bajo el tope" no inventa ninguno.** Los
   umbrales salen de normas que este repositorio no tiene archivadas.
4. **El auditor no recibe `assistant:ask`.** Un auditor que consulta al asistente sobre los datos
   que audita mete en su papel de trabajo una afirmación generada (§42).
5. **Las respuestas rechazadas se guardan.** Son el insumo de la métrica de alucinación; borrarlas
   haría que el indicador se vea mejor de lo que es.

---

## FASE 15 — Sandbox de simulación (§34)

**Estado: ✅**

Era la última pieza de código pendiente, y quedó separada de la FASE 14 con razón: simular sobre un
esquema aislado es infraestructura, no IA.

### La decisión: el candado pregunta al revés

La forma intuitiva de garantizar *"una simulación nunca escribe en el esquema real"* es preguntar si
el destino **es** producción: compararlo con `DATABASE_URL`, mantener una lista de bases prohibidas,
mirar si el nombre dice `prod`.

Todas esas comprobaciones fallan abiertas. La base nueva que nadie agregó a la lista pasa. La de otro
cliente pasa. La que alguien renombró pasa. Y lo que pasa cuando fallan no es un error visible: es
una simulación escribiendo asientos en la contabilidad real de alguien, con la etiqueta de "prueba"
puesta en la interfaz y en ningún otro lado.

`verificarAislamiento` pregunta lo contrario: **¿hay prueba de que esto es un sandbox?** La prueba es
una tabla que solo existe si alguien corrió, a propósito, la migración de sandbox sobre esa base.
Producción es rechazada no porque esté en una lista, sino porque no puede demostrar lo que se le pide.

El detalle que sostiene todo: `0001_marca_de_sandbox.sql` **no vive en el directorio de migraciones**.
Si viviera, producción recibiría la marca en el próximo deploy y el control se habría autodestruido
sin que nadie escribiera una línea de más.

### Lo que se construyó

1. **`@aai/sandbox`** — el candado y el corredor de escenarios, funciones puras. El lint de
   arquitectura le prohíbe abrir conexiones: el módulo que juzga el aislamiento no puede escribir en
   el destino que juzga.
2. **`simular()` pide el aislamiento probado en su firma.** El tipo no se puede construir desde
   afuera del candado, así que la garantía no depende de que alguien se acuerde de llamarlo primero.
3. **Las mismas migraciones y los mismos motores.** `sandbox:create` invoca el runner de producción;
   `simular` importa `@aai/accounting-engine` y `@aai/tax-engine` tal cual los usa la aplicación. Un
   sandbox con esquema propio deriva hasta que "anduvo en el sandbox" deja de significar algo.
4. **El sello viaja en el dato**, no solo en la pantalla: un resultado copiado a un mail sigue
   diciendo qué es.
5. **El escenario de fábrica muestra una negativa.** La compra pasa todos los controles de forma y
   el crédito fiscal igual sale `NO_DETERMINABLE`. Mostrar "crédito computable: $ 21.000" sería más
   lindo de demostrar y estaría enseñando a confiar en una afirmación que el sistema no hace.

Un hallazgo del camino: `construirLibroMayor` no filtra por estado —confía en que quien llama le pase
los registrables— mientras el Diario sí. El paso MAYOR del simulador compara los totales de los dos y
lo dice. En producción esa divergencia se descubre meses después, cuando el balance no cierra.

---

## Orden de trabajo recomendado

Fases 1 → 2 → 3 → 5 → 6 → 7 → 4 → 8 → 9 → 10 → 11 → 12 → 13 → 14 → 15.

---

## Fuera de fase — Generación de datos de prueba contra ARCA

No es una fase del pliego: es la herramienta que la FASE 3 necesitaba para poder medirse.

`npm run comprobantes:generar` autentica con el WSAA que ya existía, pide CAE al WSFEv1 en
**homologación** y arma un PDF por comprobante con el layout de ARCA, su transcripción `.txt` y
un `ground-truth.json`. Homologación existe para esto: CAE real, numeración correlativa real,
sin efecto fiscal.

**Emitir es distinto de consultar, y por eso vive aparte.** `@aai/arca` solo lee —constata,
consulta padrón, revisa apócrifos—. `@aai/arca-emision` pide CAE, y con un certificado de
producción eso es un acto fiscal a nombre del contribuyente. El lint de arquitectura prohíbe
que `apps/` lo alcance: la separación es una arista que no existe en el grafo, no una decisión
que alguien recuerde.

El candado repite la inversión del §34: no comprueba que el destino no sea producción,
comprueba que **sea exactamente** el endpoint de homologación que el repositorio declara. Y
declara lo que no prueba —con qué certificado se emite—, que se imprime para que lo mire una
persona.

**Dos hallazgos del camino, los dos sobre lecturas mías equivocadas:**

1. Declaré que el PDF de especificaciones del QR era un escaneo. No lo era: usa códigos de
   glifo de un byte y mi extractor los leía de a dos. Una herramienta que falla en silencio
   produjo una conclusión sobre el mundo que quedó escrita en el registro de fuentes.
2. El revisor de comprobantes marcaba toda Factura A emitida a un monotributista. Al archivar
   la RG 1415 resultó que su art. 15 inc. a) —desde el 2021-07-01— la habilita expresamente.
   El control no solo pasó a tener fundamento: cambió de contenido.

**Diferencia con el pliego, deliberada y explicada:** conviene construir el motor contable (5) y
los libros (6, 7) **antes** del clasificador de IA (4). Motivo: el clasificador necesita un destino
válido y verificable para sus propuestas. Construirlo primero obliga a validarlo contra algo que
todavía no existe, y crea la tentación de dejar que la IA escriba directamente — exactamente lo
que el §29 prohíbe. Con el motor listo, el clasificador nace ya encajonado detrás de la
`Validation Layer`.

Si preferís seguir el orden literal del pliego, es viable: requiere que la FASE 4 entregue solo
propuestas persistidas en `ai_predictions`, sin destino contable, y se valide contra fixtures.
