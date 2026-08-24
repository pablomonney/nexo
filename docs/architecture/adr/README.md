# Architecture Decision Records

Decisiones tomadas en FASE 0. Formato: contexto → decisión → consecuencias. Las nuevas ADR van en
archivos `NNNN-titulo.md`; estas siete se agrupan por ser el conjunto fundacional.

---

## ADR-001 — La IA no escribe en la base de datos

**Contexto.** El pliego exige (§29) que ningún agente modifique la base sin pasar por servicios de
validación. La vía fácil sería confiar en la disciplina del equipo.

**Decisión.** La restricción se implementa como **topología de dependencias**: `packages/ai-engine`
no puede importar `accounting-engine` ni el cliente de base. Los agentes escriben únicamente en
`ai_predictions`. La dirección de la FK es `journal_entries → ai_predictions`, nunca al revés.

**Consecuencias.** Un lint de arquitectura en CI falla el build si alguien viola la regla. El
invariante A-6 (`AUDIT_TRAIL.md`) lo verifica también sobre los datos. Apagar el proveedor de IA
deja un software contable funcional.

---

## ADR-002 — La vigencia se resuelve por `(norma, jurisdicción, fecha del hecho)`

**Contexto.** Verificado en FASE 0: la RT 54 rige desde 01/07/2024 según FACPCE y desde 01/01/2025
según CPCECABA. Además, la vigencia se ata al inicio del ejercicio, no a la fecha del hecho.

**Decisión.** El `normative-engine` recibe `factDate` y `periodStartDate`; **no consulta el reloj
del sistema** para decidir aplicabilidad. Se agrega `norm_adoptions` y modelo bitemporal (tiempo de
vigencia + tiempo de sistema).

**Consecuencias.** Se puede recontabilizar 2024 con el derecho de 2024 y reproducir la decisión de
una fecha pasada con el conocimiento que el sistema tenía entonces. Costo: mayor complejidad de
consulta e ingreso de datos.

---

## ADR-003 — Los asientos no se borran ni se editan: se anulan por contraasiento

**Contexto.** §15 y §38. El Libro Diario debe poder reproducirse idéntico años después.

**Decisión.** `DELETE` revocado por regla de base de datos. Un asiento aprobado erróneo se corrige
con `kind = REVERSION` + asiento correcto. El número del asiento anulado se conserva.

**Consecuencias.** El Diario tiene más renglones y muestra los errores. Es lo correcto: un libro
que oculta las correcciones no es auditable.

---

## ADR-004 — Sin scraping de portales con Clave Fiscal

**Contexto.** No existe web service oficial de "Mis Comprobantes". Los SDK comerciales automatizan
la navegación del portal con las credenciales del contribuyente.

**Decisión.** No se implementa. El sistema **no pide, no almacena y no usa la Clave Fiscal**. Solo
opera con certificados X.509 delegados por el Administrador de Relaciones.

**Consecuencias.** Menos automatismo en la ingesta de compras: el usuario exporta del portal y sube
el archivo. A cambio, no se custodia una credencial de alcance total ni se depende de la estructura
HTML de un portal oficial. Debe comunicarse con honestidad en la propuesta comercial.

---

## ADR-005 — Ninguna alícuota, monto o plazo se escribe en el código

**Contexto.** Alícuotas, mínimos, categorías por ingresos y plazos cambian con frecuencia y
dependen de la fecha, la jurisdicción y el tipo de ente.

**Decisión.** Son filas en `tax_rates`, `accounting_rules` y parámetros normativos, con
`norm_version_id NOT NULL` y vigencia temporal.

**Consecuencias.** Actualizar normativa es carga de datos con aprobación, no un despliegue. Una
puerta de CI falla si existe una regla activa sin norma, hash o aprobador.

---

## ADR-006 — Estructuras de estados contables como plantillas versionadas

**Contexto.** §19 lo pide, y la RG IGJ 9/2026 lo confirma: el marco admitido puede ser RT FACPCE,
NIIF o NIIF para PyMES, a opción del ente.

**Decisión.** `statement_templates` seleccionadas por `(framework, entity_type, regulator, period)`.
No existe una estructura universal hardcodeada.

**Consecuencias.** Dos empresas con marcos distintos generan estructuras distintas sin cambiar
código. Requiere que la opción normativa se registre explícitamente por empresa y período.

---

## ADR-007 — El aprendizaje por empresa no toca la normativa

**Contexto.** §14 permite que el sistema aprenda de las decisiones aprobadas por el contador, pero
prohíbe que ese aprendizaje modifique una regla normativa.

**Decisión.** El aprendizaje vive en `classification_preferences` y solo afecta la cuenta sugerida
y el nivel de confianza. No existe código que escriba desde ahí hacia `accounting_rules`,
`tax_rules` o `norm_versions`.

**Consecuencias.** Si el contador clasifica sistemáticamente mal, el sistema sugerirá mal — pero
nunca afirmará que la norma dice otra cosa. El aprendizaje además es por empresa: no se comparte
entre clientes del estudio (secreto profesional).

---

## ADR-008 — Migraciones SQL-first; el ORM no es dueño del esquema

*Decidido en FASE 1b, corrige lo previsto en `DATABASE.md`.*

**Contexto.** El plan original era Prisma como ORM y herramienta de migración, con SQL crudo solo
para las restricciones críticas. Al escribir el esquema quedó claro que **casi todo lo que
sostiene el producto es inexpresable en Prisma**: constraint diferido de `Debe = Haber`, triggers
de guardia de período, prohibición de borrado, encadenamiento por hash de la bitácora, políticas
RLS, constraints de exclusión con `daterange`, y el trigger que impide activar una regla sin norma
V1 con documento archivado.

Un esquema mitad-ORM mitad-SQL crea dos verdades: la que declara el modelo y la que aplica el
motor. En un sistema cuya premisa es que la base impide lo prohibido, esa ambigüedad es
inaceptable.

**Decisión.** Las migraciones son archivos SQL numerados en `infrastructure/db/migrations/`,
aplicados por `scripts/migrate.mjs`, con checksum registrado: una migración ya aplicada que cambia
de contenido hace fallar el runner. El cliente tipado se deriva **desde la base** (`prisma db pull`
o equivalente), no al revés.

**Consecuencias.** Se escribe más SQL a mano y se pierde el scaffolding automático del ORM. A
cambio, el esquema es exactamente lo que dice el archivo, revisable en un diff, y no hay forma de
que una restricción crítica desaparezca porque alguien regeneró el modelo.

---

## ADR-009 — npm workspaces en lugar de pnpm

*Decidido en FASE 1b, corrige lo previsto en `ARCHITECTURE.md`.*

**Contexto.** El diseño mencionaba pnpm. En el entorno de desarrollo disponible había npm 11 y no
pnpm.

**Decisión.** npm workspaces. El monorepo no necesita nada que npm no dé, y una dependencia de
tooling menos es una barrera de entrada menos para un equipo que incluye perfiles no
desarrolladores (el contador que carga normativa también clona el repositorio).

**Consecuencias.** Instalación algo más lenta y sin almacén global compartido. Ninguna consecuencia
sobre el diseño del producto. Migrar a pnpm más adelante es un cambio local si hiciera falta.
