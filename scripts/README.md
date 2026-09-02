# scripts

Treinta y siete utilidades de línea de comandos. Casi todas se invocan por su
alias de `npm`; el nombre del archivo aparece solo cuando hace falta un modo que
el alias no expone.

Este archivo se anunciaba a sí mismo como una carpeta todavía sin escribir, y
listaba cuatro utilidades de las que tres nunca existieron. Es la clase de
documento que manda a alguien a buscar algo que no está, y este proyecto promete
lo contrario: `PROJECT_STATUS.md` dice dónde está el proyecto **de verdad**.

## Las puertas

Son los que verifican algo y fallan si no se cumple. Los cinco corren dentro de
`npm run verify` y de `npm run ci`, y un test comprueba que esas dos listas y la
de `ci.yml` no se separen.

| Comando | Qué contesta |
|---|---|
| `npm run audit:estructura` | ¿Están puestos los candados? No necesita datos: mira el esquema. |
| `npm run audit:invariants` | ¿Las filas que hay cumplen la propiedad? Se crea su base y sus fixtures. |
| `npm run ledger:verify` | ¿El Mayor coincide con el Diario, reconstruido desde cero? |
| `npm run audit:cadena` | ¿La bitácora no fue adulterada? Antes de mirar, **adultera una entrada a propósito** y falla si el verificador no la detecta. |
| `npm run verify:arranque` | ¿Se puede empezar a usar NEXO sobre una base vacía? Crea la base, la recorre y la destruye. |
| `npm run norms:verify` | ¿Los documentos oficiales archivados siguen teniendo su hash? |
| `npm run check:no-float` | ¿Alguien calculó plata en punto flotante? |

Los cuatro primeros informan **cuatro estados y no dos**: verificado, violado,
no ejercitado y vacuo permitido. «No encontré nada» y «no miré» no se ven igual,
que es cómo un control deja de controlar sin que nadie se entere.

## Las bases

| Comando | Qué hace |
|---|---|
| `npm run db:setup` | Crea la base de desarrollo, migra y siembra los catálogos. |
| `npm run db:migrate` / `db:status` / `db:reset` | Migraciones, con guarda de checksum (ADR-008). |
| `npm run test:db` | La base de los tests, que **no** es la de desarrollo. `-- --reset` la rehace. |
| `npm run verify:db` | La base aislada de los verificadores conductuales. |
| `npm run db:backup` | Copia de resguardo en formato custom. |
| `npm run db:restaurar` | La restaura en una base descartable y **comprueba que sirva**: candados, Mayor y conteo fila por fila contra la base viva. |

Los tres scripts que crean y destruyen bases —`test-db`, `verification-db` y
`restaurar-backup`— tienen el mismo candado: el nombre de la base tiene que
terminar en un sufijo suyo. No es convención, es la condición para poder tocarla.

## Los catálogos

`catalog:seed`, `norms:seed`, `tax:seed`, `statements:seed`, `prompts:register`,
`reglas:cargar`, `reglas:aprobar`, `comprobantes:tipos`.

Las reglas contables entran como `DRAFT`: ninguna se activa sin norma verificada,
documento archivado y firma (§32). `reglas:aprobar` es esa firma.

## ARCA

`arca:check` y `arca:capabilities` consultan el estado de la integración y qué
servicios tiene habilitado el certificado. `comprobantes:generar` produce
comprobantes contra homologación.

Los certificados **no viven en el repositorio** (§27). El WSAA entrega un solo
ticket por CUIT y servicio, y no hay caché en disco: dos comandos seguidos
fallan por eso y no por un error.

## El resto

`ci` corre la secuencia completa; `ci -- --secuencia` la imprime sin ejecutarla.
`circuito:demo` recorre el circuito contable de punta a punta. `sandbox:*`
prepara escenarios aislados. `cuit:anonimizar` y `comprobantes:revisar` son
utilidades de datos. `metrics:extraction` mide la lectura de comprobantes.
`norms:watch` vigila cambios en las fuentes normativas.
