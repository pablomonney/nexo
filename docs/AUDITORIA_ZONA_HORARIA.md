# Auditoría integral de la zona horaria de negocio — 2026-10-07

Segunda auditoría, independiente de la primera, sobre los commits `6b20f86`,
`ddd8d58` y `e1b9007`. Se pidió **no confirmar**, sino buscar lo que todavía pueda romperse. Las correcciones de
esta auditoría quedaron en el commit `8d867d3` (publicado en `origin/main`); el ensayo A.4b se cerró el 2026-10-08
(§10).

> **Veredicto: PASS CON OBSERVACIONES — publicado (`8d867d3`); A.4b: PASS CON OBSERVACIÓN; NO cerrado, NO desplegado.**
> Se hicieron dos pasadas. La primera encontró y corrigió tres
> defectos P1 de interfaz, siete P2 y dos P3, incluido un falso PASS de un test
> que la auditoría anterior había dado por bueno. La segunda —la revisión técnica
> final del árbol local— encontró y corrigió otros cuatro P2 y tres P3 (hallazgos
> 18 a 25), la mayoría en los **propios controles** (S-37, S-45, el recálculo de la
> cadena y un test del parser de fechas que no detectaba su mutación). La suite completa
> da 202 archivos y 3272 pruebas verdes con la base de pruebas en UTC y en Argentina, y
> `npm run verify` sale con código 0 contra `aai_test`.
>
> **A.4b** (ensayo de la 0132 sobre `aai_restauracion_tz`) se ejecutó en el servidor el 2026-10-08 y quedó en
> **PASS CON OBSERVACIÓN**: la única observación es que la huella histórica pre-0132 no es reproducible
> (falta el algoritmo original); no es un fallo de la migración. Ver §10. **V2** (el script de zona dentro de la
> imagen de ensayo `nexo:ensayo-tz`) se ejecutó el 2026-10-09 y dio **PASS**; ver §11. Lo que **no** está hecho: el
> deploy, V1, V3–V6 en producción y **V7**. Nada de eso se simuló. Ver «Qué falta para decir cerrado».

## 1. Hallazgos

Severidad: **P0** integridad, auditoría, aislamiento o datos · **P1** fecha,
monto o estado incorrecto para usuarios reales · **P2** inconsistencia menor o
falso resultado · **P3** calidad, documentación, pruebas.

| # | Sev. | Dónde | Problema | Evidencia | Estado |
|---|---|---|---|---|---|
| 1 | **P1** | `apps/web/consola.html` (3 líneas) | Tres «hoy» salían de `new Date().toISOString().slice(0, 10)`: la **fecha por defecto de un asiento y de una operación**, el **período «actual»** del inicio y la **normativa «vigente hoy»**. De 21:00 a 24:00 ART mostraban mañana (y el último día del mes, el mes siguiente) | S-37 no leía los HTML. Test S-46 con instantes fijos | Corregido: `hoyEnArgentina()` |
| 2 | **P1** | `consola.html`, `prepararAltaDeEjercicio` | Comparaba el **instante** actual contra la medianoche **UTC** del cierre: el 31/12 a las 00:00 ART (03:00Z) ya proponía el ejercicio 2027, y no solo de noche sino **todo el día del cierre** | `hoy=2026-12-31T03:00:00Z → código 2027, 2027-01-01..2027-12-31` (reproducido). Propiedad sobre 366 cierres × 157 días | Corregido para cualquier cierre `MM-DD`, incluido 29/02 |
| 3 | **P1** | `consola.html` (6 campos) | Un `timestamptz` serializado como ISO con `Z` se recortaba a diez caracteres: `creadoEn`, `ocurridoEn` (×2, incluida la hora de la bitácora), `creadaEl`/`importadaEl`/`revertidaEl`, `detectadaEl`. Un evento de las 22:00 ART del día 5 aparecía como día 6, y la bitácora mostraba la hora UTC sin decirlo | Tipo de columna verificado en la base: los diez son `timestamptz` | Corregido: `diaDeUnInstante` / `momentoDeUnInstante` |
| 4 | **P2** | migración 0131 | Las funciones de hash fijaron la **zona**, pero `occurred_at::text` depende también de **`DateStyle`**. Con estilo SQL/Postgres/German se escribe otro hash y se verifica roto | Medido: 8 zonas (±medias horas, +14:00, −12:00, horario de verano) × estilo ISO = 0 roturas en 16 sesiones; un estilo no ISO rompe | Corregido: **migración 0132** |
| 5 | **P2** | `tests/integration/zona-horaria-y-cadena.test.ts` (P7) | **Falso PASS.** `tests/setup-env.ts` fija `PGOPTIONS` en hora argentina, así que el test pasaba aunque `initPool` no pidiera la zona | Mutación: sin la opción en `initPool`, el test viejo seguía en verde | Corregido: entorno hostil `PGOPTIONS=UTC`, 5 conexiones simultáneas |
| 6 | **P2** | `tests/security/zona-de-negocio-en-conexiones.test.ts` (S-45) | Aceptaba que un archivo **mencionara** `ZONA_DE_NEGOCIO` (un `import` sin uso alcanzaba) y no cubría escritores de roles/cuentas | Mutación y autoprueba | Corregido |
| 7 | **P2** | `scripts/fixtures-invariantes.mjs` | Crea empresas y roles por un cliente `pg` crudo: `valid_from DEFAULT CURRENT_DATE` en UTC deja el rol con la fecha de mañana y la API (en hora argentina) responde 403. La regla «usa CURRENT_DATE» no lo veía porque es un DEFAULT de tabla | La primera corrida de la suite con la base en UTC dio 100 pruebas rojas | Corregido y cubierto por regla de escritores |
| 8 | **P2** | `tests/security/fechas-en-hora-argentina.test.ts` (S-37) | Detectaba texto literal: **7 de 9** variantes peligrosas pasaban (variable intermedia, `substring`, `split('T')`, getters locales, `toLocaleDateString` sin zona…). No leía los HTML | Sonda con 11 casos | Corregido: detector propio con **autoprueba**, lee los HTML, anotación `s37-permite: motivo` |
| 9 | **P2** | `scripts/verificar-zona-de-negocio.mjs` | Su capacidad de distinguir UTC de Argentina **dependía de la hora a la que se corría**: la corrida de las 00:44 ART dio `distingue=false` | Reproducido | Corregido: matriz de 14 instantes fijos |
| 10 | **P2** | `packages/audit-engine/src/anomalias.ts`, `asientosTardios` | Restaba milisegundos contra la medianoche **UTC** del día contable: una carga de 21:00 a 24:00 ART sumaba un día y podía cruzar el umbral de 60 días sin haberlo cruzado. Un test existente codificaba esa semántica | `fecha 2026-03-01, carga 2026-05-01T00:00Z → 61 (debía ser 60)` | Corregido: días de calendario argentinos |
| 11 | P3 | `routes/arca.ts:88`, `secrets/proveedor.ts:100` | Mensajes al usuario con la fecha **UTC** de un instante | S-37 ampliado | Corregido: `hoyEnZonaDeNegocio(instante)` |
| 12 | P3 | `routes/audit.ts` | `cargado_el` salía como `created_at::text` (el texto de la sesión: ahora `…-03`) | `new Date()` lo interpreta igual con `+00` y `-03` (verificado) | Corregido: ISO UTC inequívoco |
| 13 | P3 | `scripts/comprobantes-sinteticos.mjs` | Fechas de comprobantes de homologación con getters locales (zona del proceso). Herramienta manual; ARCA acepta ±5/±10 días | — | **No corregido, documentado** (exención con motivo en S-37) |
| 14 | P3 | `packages/db/src/tenancy.ts` | El pool **no tiene `pool.on('error')`**: una conexión ociosa cortada (reinicio de PostgreSQL) emite un `error` sin oyente y tira el proceso. Anterior a este trabajo y sin relación con la zona | `grep` | **No corregido** (fuera de alcance); `restart: unless-stopped` lo levanta |
| 15 | P3 | funciones de hash | `audit_logs` y `digest()` se resuelven con el `search_path` de la sesión. Falla de forma visible, no cambia el hash | `pg_get_functiondef` | **No corregido**, anotado en la 0132 |
| 16 | P3 | `studio.ts:174` | `fiscalYearEnd` solo se valida con `^\d{2}-\d{2}$`: acepta `13-45`. La consola ahora lo trata como 31/12 y el servidor sigue siendo la autoridad | — | No corregido (API no relacionada) |
| 17 | P3 | imagen Docker | `hoyEnZonaDeNegocio` usa `Intl` con `timeZone`: necesita ICU completo (la imagen oficial `node:22-alpine` lo trae). **No se pudo comprobar dentro de la imagen** (esta máquina no tiene Docker) | — | **V2 PASS en la imagen de ensayo** (§11): `Intl` resolvió la zona y produjo la matriz. Evidencia funcional; ICU no auditado de forma exhaustiva |
| 18 | P2 | `consola.html`, `diaDeUnInstante` / `momentoDeUnInstante` | Sin guarda para una fecha `AAAA-MM-DD`: `new Date('2026-03-01')` es la medianoche UTC y pasaba al 28/02 en Argentina (**doble conversión**). Hoy se llaman solo con `timestamptz`, pero cualquier campo `date` mal cableado habría corrido un día | Test con mutación (sin la guarda → falla) | Corregido: una fecha sin hora se devuelve tal cual |
| 19 | P2 | `tests/security/helpers/fechas-en-utc.ts` (S-37) | Seguía sin ver el ISO guardado en una variable (`const iso = d.toISOString(); iso.slice(0, 10)`), `toJSON()`, `.replace('T', ' ')` y `getTimezoneOffset()`. Y `calendar-date.ts` estaba exceptuado **entero** por archivo: un `getUTC*` nuevo ahí pasaba sin mirarse | Mutación S37-M3: **no detectada** al principio | Corregido: detector ampliado, excepción por línea (`s37-permite`) y un test que comprueba que **cada** anotación tape algo real |
| 20 | P2 | `tests/security/zona-de-negocio-en-conexiones.test.ts` (S-45) | Aceptaba una zona equivocada escrita a mano (`-c timezone=UTC`), el helper `opcionesDeConexion()` pisado por otra `options:` y no tenía caso para una segunda conexión | Autopruebas nuevas; 8 mutaciones | Corregido |
| 21 | P2 | paso V5 del plan | El «recálculo de las últimas 50 filas fuera de las funciones» solo existía como texto: sin script, V5 seguía siendo circular | — | Corregido: `scripts/recalcular-cadena.mjs` + `scripts/lib/cadena.mjs`, con test y control negativo. **Al escribirlo apareció un defecto propio** (`ORDER BY seq` tomaba el alias de texto `seq::text` y ordenaba '9937' sobre '10121'): lo detectó la corrida contra `aai_test` (2 «enlaces rotos» en cadenas sanas), no la lectura |
| 22 | P3 | matriz de la cadena | La matriz era de 8 zonas × 5 estilos y no incluía `SQL, MDY`, Madrid ni Tokio; no cubría la cadena normativa con la matriz ni variables como `IntervalStyle` o `extra_float_digits` | — | Corregido: 10 zonas × 6 estilos (60 sesiones), cadena por empresa **y** normativa, recálculo independiente en SQL plano, y test P4c de otras variables de sesión |
| 23 | P3 | `scripts/verificar-zona-de-negocio.mjs` | `fechaOk` comparaba el `CURRENT_DATE` de la base con un «hoy» calculado **después**: falla un instante justo en la medianoche argentina | Razonamiento | Corregido: acepta el día de antes y el de después de la consulta |
| 24 | P3 | `packages/document-engine/src/parsers/fecha.ts` | El año de referencia ya usaba `hoyEnZonaDeNegocio()`, pero ningún test dinámico lo cubría: la mutación a `getUTCFullYear()` pasaba (solo la veía S-37) | Mutación AN-6: **no detectada** por los tests del motor | Corregido: test con reloj fijo en el 31/12 entre las 21:00 y las 24:00 ART |
| 25 | P3 | anotaciones `s37-permite` | Tres comentarios de dos líneas repetidos y un `);` suelto dentro de un comentario de `arca-check.mjs` | Lectura del diff | Corregido |
| 26 | P3 | procedimiento A.4b.1 del plan | La huella del historial se guardaba solo como un md5, sin el comando ni el contenido: la huella pre-0132 del ensayo (`03ad8399…`) **no se pudo reproducir** | Búsqueda en el repo, en la historia de git y en las sesiones: nada | **Observación abierta de A.4b** (§10.2); procedimiento corregido (§10.6). No invalida la conclusión |

### Lo que se revisó y está bien

- **Migración 0131 (Parte 1):** `ALTER FUNCTION … SET` no cambia el cuerpo. Propietario
  (`postgres`), `SECURITY INVOKER`, volatilidad (`v`/`s`), lenguaje (`plpgsql`) y ACL
  (`aai_app=X` en el disparador) **idénticos** entre la base en 130 y la base en 131
  (comparadas). Idempotente (repetirla es inocua). No toca datos. Sin dependencia
  circular. PostgreSQL 18.6 local. La fórmula sigue duplicada entre disparador y
  verificador (anterior, documentada en la 0025); la copia en los tests es solo de prueba.
- **`calendar-date.ts` (Parte 6):** su uso de `Date.UTC`/`getUTC*` es **correcto y
  necesario**: aritmética de calendario sobre año/mes/día explícitos, que nunca lee el reloj.
  No se modificó. `hoyEnZonaDeNegocio` (agregada) usa `Intl` con zona explícita.
- **Todas las conexiones (Parte 3):** `apps/api/src` no abre ninguna fuera de `initPool`;
  `pg` 8.23 respeta `options`, y una opción explícita le gana a `PGOPTIONS`. Ningún `RESET
  ALL`/`DISCARD ALL` en el código. De los 58 scripts, 41 abren una conexión `pg`: se clasificaron según escriban fechas de negocio, las comparen o solo verifiquen (ver S-45 y §3).

## 2. Clasificación de `CURRENT_DATE` / `current_date` (Parte 4)

**150 líneas de código** (sin comentarios ni tests): 102 en migraciones y vistas, 34 en
`apps/api` y `packages`, 14 en scripts.

| Cat. | Qué | Líneas | Dónde |
|---|---|---|---|
| **A** | Correctas: fecha de negocio. Vigencias de roles, precios, planes, listas, costos y reglas | 63 | `context.ts`, `auth.ts`, `precios.ts`, `suscripciones.ts`, `alcance.ts`, `studio.ts`, vistas 0011–0124 |
| **A** | Vencimiento, mora, antigüedad de saldos, cheques, flujo de fondos, días en etapa | 34 | vistas 0053, 0060, 0064–0066, 0069, 0080, 0083, 0096, 0120 |
| **A** | Mes corriente y ventanas móviles (`date_trunc`, `interval`) | 32 | analítica 0057, señales 0058, cupos 0073/0122, `intelligence/*` |
| **A** | «Hoy» como parámetro del ciclo, el onboarding y la normativa | 12 + 7 revisadas a mano | `facturacion-ciclo`, `onboarding.ts`, `intelligence.ts`, 0063, 0089 |
| **C** | `DEFAULT CURRENT_DATE`: depende de **quién escribe** | 2 | `user_company_roles.valid_from` (0002), `accounts.valid_from` (0003) |
| **B** | Incorrectas: deberían usar otra referencia | **0** | — |
| **D** | Dudosas | **0** (1 de control a propósito) | `verificar-zona-de-negocio.mjs` |

Con la sesión en hora argentina todas las A pasan a significar el día del negocio: la ventana de
error de 21:00 a 24:00 desaparece en vistas, aging, cupos mensuales y el cierre. Cambian de
significado, a propósito: la cuota diaria de IA (`date_trunc('day', now())` en `ai/cupo.ts`) y la
verificación previa al cierre (`received_at::date` en `closures.ts`) pasan a contar por día argentino.

Las dos C solo importan si escribe una sesión en otra zona: los escritores reales (API) están en
hora argentina; los scripts que crean roles/cuentas ahora la piden (§1.7, S-45). Un `psql` manual
debe empezar con `SET timezone = 'America/Argentina/Buenos_Aires';`.

## 3. Clasificación de UTC en JavaScript (Parte 5)

| Pregunta | Casos | Resolución |
|---|---|---|
| **Instante** (cuándo pasó algo) | tokens y tickets de ARCA (`wsaa.ts`, `ticket-cache-fs.ts`, `mock-client.ts`), `limite-de-intentos.ts`, TOTP, `locked_until`, `expira_el`, `Date.now()` de latencias, `asOf`, `declaradaAt` | UTC correcto. No se recortan a fecha. Sin cambios |
| **Fecha de negocio** (qué día es hoy) | consola (×4), `catalogo.ts:617`, `fecha.ts:154`, `onboarding.ts`, `intelligence.ts`, mensajes de `arca.ts`/`proveedor.ts`, `asientosTardios` | Corregidos: `hoyEnZonaDeNegocio` / `CURRENT_DATE` / `hoyEnArgentina` |
| **Fecha calendario** (AAAA-MM-DD) | `calendar-date.ts`, `bank-engine/matching.ts`, plan de cuotas de la consola | Aritmética con `Date.UTC` sobre partes explícitas: correcta. En la consola ahora es el helper `sumarDias` |
| **Columna `date` de pg que llega como `Date`** | `normativa/catalogo.ts`, `journal-entries.ts`, `predictions.ts`, `metricas-saas.mjs` | Correcta con el proceso en UTC (contenedor) o ART. Anotadas `s37-permite: motivo` |
| **Sellos de artefacto** | `backup-db.mjs`, `construir-landing.mjs`, `sincronizar-tipos-comprobante.mjs` | UTC a propósito (los nombres deben coincidir con los del servidor) |
| **Zona del proceso** | `comprobantes-sinteticos.mjs` | P3 documentado (§1.13) |

## 4. Matriz de borde (Parte 12) — sin depender del reloj

Todas son pruebas con instantes fijos. 21:00 ART = 00:00Z del día siguiente. Verificados en
`@aai/shared`, en la consola y **en PostgreSQL** (14 instantes convertidos por la sesión).

| Instante (ART) | UTC | Día argentino | Una sesión UTC diría |
|---|---|---|---|
| 20:59:59 | `2026-10-05T23:59:59Z` | 2026-10-05 | 2026-10-05 |
| 21:00:00 | `2026-10-06T00:00:00Z` | **2026-10-05** | 2026-10-06 ✗ |
| 21:00:01 | `2026-10-06T00:00:01Z` | **2026-10-05** | 2026-10-06 ✗ |
| 23:59:59 | `2026-10-06T02:59:59Z` | **2026-10-05** | 2026-10-06 ✗ |
| 00:00:00 | `2026-10-06T03:00:00Z` | 2026-10-06 | 2026-10-06 |
| 31/10 21:00 (fin de mes) | `2026-11-01T00:00:00Z` | **2026-10-31** | 2026-11-01 ✗ |
| 31/12 00:00 (el defecto del ejercicio) | `2026-12-31T03:00:00Z` | 2026-12-31 → ejercicio **2026** | — |
| 31/12 21:00 (fin de año) | `2027-01-01T00:00:00Z` | **2026-12-31** | 2027-01-01 ✗ |
| 01/01 00:00 | `2027-01-01T03:00:00Z` | 2027-01-01 → ejercicio 2027 | 2027-01-01 |
| 28/02 (año común) | `2027-03-01T02:59:59Z` | **2027-02-28** | 2027-03-01 ✗ |
| 29/02 (bisiesto) | `2028-03-01T02:59:59Z` | **2028-02-29** | 2028-03-01 ✗ |

Además: barrido de las 366 medianoches de 2028 (cambia de día exactamente a las 00:00 ART),
cierres fiscales de los 12 meses y 29/02 (propiedades: contiene hoy, contiguos, 365/366 días),
y `asientosTardios` en el borde de los 60 días.

## 5. V1–V7 (Parte 14): segunda evaluación

**Aclaración necesaria.** En `PLAN_ZONA_HORARIA.md`, V1–V7 son verificaciones
**posteriores a un deploy** que **todavía no ocurrió**. Ninguna se ejecutó. Lo que existe son
equivalentes locales y las pruebas P0–P3 en el servidor, informadas por el usuario. La corrida
de las 00:44 ART del script de verificación también la informó el usuario; esta auditoría no la
ejecutó ni la puede verificar.

| Control | Qué afirma | Evidencia hoy | ¿Puede dar falso PASS? | Estado |
|---|---|---|---|---|
| **V1** versión y migraciones | Lo que corre es lo publicado y el esquema está al día | Ninguna en producción (sin deploy) | `version` sale de `BUILD_ID`, que se pasa al desplegar: una imagen vieja con un `BUILD_ID` nuevo daría el hash correcto. `migrations` cuenta filas: es sólido | **No ejecutado.** Ahora espera 132 (131 + 0132) |
| **V2** zona de las conexiones | `initPool` compilado entrega la zona de negocio | Local: matriz de 14 instantes fijos, exit 0 con el cliente crudo en UTC y en Argentina; mutaciones (sin la opción, con otra zona) → exit 1 | La versión anterior **sí**: dependía del reloj. La actual no: ningún test depende de estar entre las 21:00 y las 24:00, y `fechaOk` tolera la medianoche | **PASS en la imagen de ensayo** (2026-10-09, §11): `desdeLaAplicacion.zona` = `America/Argentina/Buenos_Aires`, `conexionCruda.zona` = `UTC`, `zonaOk`/`matrizOk`/`fechaOk`/`distingue` = `true`. Base: `aai_restauracion_tz`. Falta repetirlo con la imagen desplegada (**pendiente, deploy**) |
| **V3** cadena íntegra | El historial verifica desde cualquier sesión | P1–P3 sobre la copia del backup real (informado): UTC 0, Argentina 1 antes de la 0131 y 0 después. Local: 10 zonas × 6 estilos, cadena por empresa y normativa | Si la base real tuviera 0 filas. Tiene 17. **No hay función verificadora de `normative_audit_logs`**: ahora la cubre `recalcular-cadena.mjs` | **Reforzado**. En la copia del backup real: 0131 y 0132 aplicadas, matriz 24/24 y recálculo en Node sin roturas (**A.4b, PASS CON OBSERVACIÓN, §10**). Sigue sin ejecutarse en producción |
| **V4** funciones fijadas | Las tres tienen `TimeZone=UTC` y `DateStyle=ISO` | `check-structure` y `pg_proc` locales | No | Reforzado: exige las dos fijaciones y una sola función por nombre |
| **V5** filas nuevas | Lo que escribe la API (Argentina) verifica | Local: `scripts/recalcular-cadena.mjs` (SHA-256 en Node, fórmula propia) sobre las últimas 50 filas de las 1 875 cadenas de `aai_test`: 21 429 filas, 0 rotas; control negativo con campo, hash y enlace alterados; 7 mutaciones detectadas | Era **circular** (trigger y verificador fijados igual); el recálculo en Node ya no lo es. Sigue sin probar la fila **real** de producción | **Resuelto en local**; correrlo en producción tras el deploy (**pendiente**) |
| **V6** otros verificadores | `ledger:verify` etc. siguen verdes | Local: `npm run verify` exit 0 | **No demuestra nada de zona**: pasarían igual con la zona rota. Solo descarta regresión | Aclarado en el plan |
| **V7** confirmación nocturna | `CURRENT_DATE` es el día argentino a la hora del defecto | Pendiente | Confirma el mecanismo, no cada endpoint (prueba gratuita, panorama): esos los cubren los tests unitarios y de integración | **Pendiente a propósito, separada del deploy** |

## 6. Verificaciones finales

Todas ejecutadas en esta máquina, contra `aai_test` (132 migraciones), el 2026-10-07 de madrugada.

| Control | Resultado |
|---|---|
| `npm run typecheck`, `lint`, `lint:arch`, `check:no-float` | verdes |
| S-37, S-45, S-46, pruebas de zona (P4–P8), `verificar-zona-de-negocio`, `recalcular-cadena` | verdes |
| `audit:estructura` | 442 objetos declarados presentes (exige `timezone=UTC` **y** `datestyle=ISO` en las tres funciones) |
| `audit:invariants` | 11 verificados, 0 violados |
| `audit:cadena` | 2 cadenas íntegras |
| `ledger:verify` | 2 empresas, sin discrepancias |
| `npm run verify` completo (base de pruebas en hora argentina, su valor por defecto) | **exit 0 — 202 archivos, 3272 pruebas** |
| Suite completa con la base de pruebas fijada en **UTC** (`ALTER DATABASE aai_test SET timezone`, ya restablecida) | **202 archivos, 3272 pruebas, verdes** |
| Mutaciones de esta pasada | 49 aplicadas; las 49 detectadas — **2 solo después de reforzar el control** (S37-M3, AN-6), ver §9 |

Los números cambiaron respecto de la primera pasada (201 archivos, 3216 pruebas) por los tests
nuevos: +1 archivo (`recalcular-cadena`) y +56 pruebas.

`npm run verify` **literal** contra la base de desarrollo `aai` sigue fallando en
`audit:estructura`: esa base está en 130 migraciones a propósito, porque sus 240 filas de
auditoría se escribieron en hora argentina y la 0131 las haría ver rotas en 8 empresas.
Producción, escrita en UTC, no tiene ese problema (P1 = 0 roturas).

## 7. Riesgos restantes

1. **Sin deploy y sin V7.** Los tres bugs siguen presentes en producción hasta desplegar.
2. **A.4b: PASS CON OBSERVACIÓN** (§10). La copia de ensayo tiene la 0131 y la 0132 y verifica. Queda abierta una observación: la huella histórica pre-0132 no es reproducible (se sustituyó por la comparación backup/restauración). La 0132 **no** está aplicada en producción.
3. **Imagen Docker**: V2 dio PASS en la imagen de ensayo (§11). Queda como limitación que el ICU no se auditó de forma exhaustiva (no hay un indicador propio) y que la imagen se identificó por SHA-256 de cinco archivos, no por metadatos. Si un ICU reducido no tuviera la zona, `@aai/shared` falla **al importarse** (`RangeError`), de forma visible y antes de servir tráfico. La imagen que importa para producción es la que se construya al desplegar.
4. **Escritores manuales en UTC** (`psql`) siguen pudiendo dejar `valid_from` de mañana. Decisión
   pendiente del usuario: fijar también la zona por defecto de la base (ahora segura para la cadena).
5. **`normative_audit_logs`** no tiene verificador en la base; `recalcular-cadena.mjs` lo cubre, pero **todavía no se corrió contra producción**. En `aai_test` esa tabla está vacía: la fórmula normativa se prueba con filas escritas dentro de una transacción.
6. Los timestamps que la API entrega como texto (`…_at::text`) ahora terminan en `-03` en vez de `+00`:
   la consola solo los muestra y `new Date()` los interpreta igual, pero un consumidor externo
   que recortara `+00` se rompería. No se conoce ninguno.
7. Hallazgos 13 a 17 de la tabla.

## 8. Qué falta para decir «cerrado»

1. ~~Revisar y commitear estos cambios~~ **Hecho**: commit `8d867d3`, publicado en `origin/main`.
2. ~~A.4b sobre la copia~~ **Hecho: PASS CON OBSERVACIÓN** (2026-10-08, §10).
3. ~~V2 dentro de la imagen~~ **Hecho: V2 PASS** (2026-10-09, §11) con `nexo:ensayo-tz`, construida desde `8d867d3` (identificada por SHA-256 de cinco archivos).
4. Deploy de día (09:00–18:00 ART), con `scripts/desplegar.sh`.
5. V7 entre 21:00 y 24:00 ART. Solo entonces: *«Bugs #3/#4/#5 corregidos y verificados en producción.»*
   Hasta entonces: *«Corrección implementada y desplegada; pendiente de confirmación en producción
   durante la franja 21:00–24:00 ART.»* — y antes del deploy, **no corregidos en producción**.

## 9. Revisión final del árbol local (segunda pasada)

### 9.1 Los archivos, clasificados

Medido sobre el árbol: 26 archivos modificados + 8 nuevos (el conteo exacto está en el informe de cierre).
Un diff sin commitear que mezcla tests, scripts, documentación y una migración no cabe en nueve archivos;
la cifra citada en el pedido («9 archivos, +1268 −299») no corresponde a este árbol.

| Clase | Archivos |
|---|---|
| **Necesario** | `consola.html`; `anomalias.ts`; `arca.ts` y `proveedor.ts` (mensajes); `0132`; `check-structure.mjs`; `fixtures-invariantes.mjs`; `verificar-zona-de-negocio.mjs`; `recalcular-cadena.mjs` y `lib/cadena.mjs`; `calendar-date.ts` (solo una anotación de línea, en lugar de la excepción de archivo); los tests S-37 / S-45 / S-46 / zona / verificar / recalcular / motor / parsers / catálogo / `calendar-date` |
| **Necesario pero mejorable** | `audit.ts` (`to_char(… AT TIME ZONE 'UTC')`: no es imprescindible —`new Date()` interpreta igual `+00` y `-03`— pero hace al motor independiente del formato de la sesión; el campo es interno y **no sale en la respuesta**); anotaciones `s37-permite` de `catalogo.ts`, `journal-entries.ts`, `predictions.ts`, `metricas-saas.mjs`, `arca-check.mjs` (solo comentarios, ya acortados); `package.json` (un script nuevo) |
| **Innecesario** | ninguno encontrado |
| **Sospechoso** | tres hallados y corregidos: texto suelto `);` dentro de un comentario (`arca-check.mjs`), comentarios de dos líneas repetidos, y una excepción de archivo entera para `calendar-date.ts` |

**Contratos de la API:** los seis archivos de la API (`arca.ts`, `audit.ts`, `proveedor.ts`, `catalogo.ts`,
`journal-entries.ts`, `predictions.ts`) cambiaron **solo la representación temporal**: dos mensajes de error, un campo
interno del motor y tres comentarios. Sin cambios de rutas, permisos, códigos de estado, serialización, nombres de
campo, filtros ni lógica de negocio (diff revisado línea por línea).

### 9.2 `consola.html`

Revisada contra: doble conversión, corrimientos de un día, pérdida de hora y de segundos, horario de verano,
bisiestos y cierres que no son 31/12. Todo con instantes fijos, ejecutando el **código real** del archivo en `node:vm`
(S-46, 69 pruebas) y, además, **cargado en el navegador del escritorio** (Chrome): el `<script>` completo se
analiza sin errores, y los helpers dan en el navegador los mismos resultados que en Node (incluido `hourCycle: 'h23'`:
00:00:00, nunca 24:00:00). Incluye la función `prepararAltaDeEjercicio` completa, con reloj congelado y una pantalla de
mentira, y el horario de verano que Argentina tuvo hasta 2009 (UTC−2). 9 mutaciones, 9 detectadas.

### 9.3 Mutaciones de esta pasada

| Control | Mutaciones | Detectadas | Notas |
|---|---|---|---|
| S-46 (consola) | 9 | 9 | reloj UTC en el pegamento, sin guarda de fecha, recorte UTC, `h24`, borde del cierre, zona UTC, 29/02, fecha del asiento, campo `timestamptz` |
| S-37 | 10 | 10 | `getUTCFullYear()` inyectado en el HTML y la API, variable intermedia, anotación quitada / vacía / sobrante, `getTimezoneOffset`, `toLocaleDateString`, el detector sin un patrón. **S37-M3 (variable intermedia) no se detectaba**: se amplió el detector |
| S-45 + P7 | 8 | 8 | `initPool` sin la opción y con otra zona, segundo `Pool`, cliente crudo sin zona o con el helper pisado, constante de scripts distinta, `setup-env` |
| Migraciones 0131 / 0132 | 6 | 6 | cada una de las tres funciones, un estilo no ISO, la zona equivocada |
| Recálculo de la cadena | 7 | 7 | separador, `COALESCE`, sesión sin UTC / sin ISO, **el `ORDER BY` sin calificar**, enlace sin comparar, fórmula normativa |
| Motor y API | 7 + 2 | 9 | `asientosTardios` en UTC, `>=`, doble conversión, `/audit` de vuelta a `::text`. **AN-6 (año de referencia del parser) no se detectaba** con tests dinámicos: se agregó el test con reloj fijo |

Todos los archivos se restauraron byte a byte tras cada mutación (verificado en cada una). Con los 12 de la primera
pasada, son 61 mutaciones.

### 9.4 Hash, matriz y representación canónica

El payload usa `occurred_at::text`, `seq::text`, uuid, texto y `jsonb::text` (canónico). De todo eso solo
`occurred_at` depende de la sesión (`TimeZone`, `DateStyle`); `IntervalStyle`, `extra_float_digits`, `bytea_output` y
`lc_monetary` no lo mueven (P4c). Las tres funciones fijan UTC e ISO, así que la representación es la misma
que escribió todo el historial (sin cambiar ningún hash). Matriz probada, escribiendo y verificando: **10 zonas**
(UTC, Argentina, Kolkata, St. John's, Chatham, Kiritimati, Nueva York, Madrid, Tokio, `Etc/GMT+12`) × **6 estilos**
(`ISO, MDY`, `ISO, DMY`, `SQL, MDY`, `SQL, DMY`, `Postgres, MDY`, `German, DMY`) = 60 sesiones, para la cadena por
empresa y la normativa, más un recálculo independiente en SQL plano. Sin la 0132, un estilo SQL rompe (control negativo).

### 9.5 Docker

No hay Docker ni WSL en esta máquina: **no se pudo construir ni probar la imagen**. Análisis estático del
`Dockerfile`: base `node:22-alpine` (Node con ICU completo según la documentación de la imagen oficial, **no verificado aquí**; la zona sale de los datos de ICU, no del paquete `tzdata`
del sistema), `npm ci` + `npm run build` + `npm prune --omit=dev`, y `scripts/` e `infrastructure/` se copian enteros, así que
`recalcular-cadena.mjs` y la 0132 llegan a la imagen sin tocar el `Dockerfile`. Localmente se corrió con Node 24.19 /
ICU 78.3 / tz 2026b, no con la versión de la imagen: eso, y que `initPool` compilado entregue la zona, requería
la prueba en el servidor (hecha después: V2 PASS, ver abajo y §11). No se instaló ninguna dependencia.

**Actualización del 2026-10-08.** En el servidor se construyó la imagen de ensayo `nexo:ensayo-tz` desde `8d867d3`
y `recalcular-cadena.mjs` se ejecutó correctamente dentro de ella: el *build* y la inclusión de `scripts/` quedaron
probados.

**Actualización del 2026-10-09.** `verificar-zona-de-negocio.mjs` (V2) se ejecutó en esa imagen y dio **PASS**
(§11): la zona de la aplicación fue `America/Argentina/Buenos_Aires` y la matriz de 14 instantes coincidió entera.
Es evidencia **funcional** de que el ICU de la imagen resuelve la zona; no una auditoría exhaustiva del ICU.

## 10. A.4b — cierre formal (2026-10-08)

### Veredicto: **A.4b — PASS CON OBSERVACIÓN**

La única observación pendiente es que **no se pudo reproducir la huella histórica pre-0132**, porque no se
recuperó el algoritmo exacto con el que se calculó. **No es un fallo de la migración**, y no invalida las pruebas
deterministas de integridad que sí se hicieron (ver «Por qué la limitación no invalida la conclusión»).

**Alcance.** Ensayo de las migraciones 0131 y 0132 sobre `aai_restauracion_tz`, la copia descartable del backup
`aai-20261005T023159Z-auto.dump`, con la imagen de ensayo `nexo:ensayo-tz` construida desde el commit
`8d867d3f9e4e88fb40fbe2cd054862aa18877a19`.

**Procedencia de la evidencia.** La ejecutó el usuario en el servidor (SSH) y la informó a la sesión que escribe
este documento. Esa sesión **no tiene acceso al servidor y no pudo verificarla por su cuenta**; la única parte que
sí comprobó es que los checksums de las dos migraciones coinciden con los archivos del commit `8d867d3`
(`sha256sum` sobre `git show`). No se tocó `aai`, ni la imagen `nexo:production`, ni `/opt/nexo` (que sigue en
`e1b9007` a propósito), y no hubo deploy, reinicio ni migración en producción.

### 10.1 Evidencia cerrada

| # | Evidencia | Resultado |
|---|---|---|
| 1 | **Migración 0131** (`0131_funciones_de_hash_en_utc.sql`): `ALTER FUNCTION … SET timezone = 'UTC'` en `audit_chain_link()`, `normative_audit_chain_link()` y `verify_audit_chain(uuid)` | Registrada en `schema_migrations`. Checksum `67534b7e3b0d6ffeef78c21a79ba6d7514e2e99206bcd8cd40ec4bfab66eed99` (coincide con el commit) |
| 2 | **Migración 0132** (`0132_funciones_de_hash_en_formato_iso.sql`): `ALTER FUNCTION … SET datestyle = 'ISO, MDY'` en las mismas tres funciones | Registrada en `schema_migrations`. Checksum `fd1546d9b9eba6e5784d16f2a9d486ea5222266dac318795bfb22168dcdfd5ff` (coincide con el commit) |
| 3 | **Configuración final** de las tres funciones, comprobada **después** del `ROLLBACK` del control negativo | `{TimeZone=UTC,"DateStyle=ISO, MDY"}` en las tres. El `ROLLBACK` no dejó cambios persistentes |
| 4 | **Verificador oficial** `scripts/recalcular-cadena.mjs --ultimas 100000` dentro de `nexo:ensayo-tz`, empresa `01a0b566-f889-79b1-945b-091397ce9b85` | `ok: true`, **17 filas revisadas** (toda la historia), 0 hashes rotos, 0 enlaces rotos, `rotas: 0`. La bitácora normativa tiene 0 filas: no aporta evidencia sobre esa cadena |
| 5 | **Matriz determinista**: 4 zonas (UTC, `America/Argentina/Buenos_Aires`, `Asia/Kolkata`, `Pacific/Kiritimati`) × 6 estilos (`ISO, MDY`; `ISO, DMY`; `SQL, MDY`; `SQL, DMY`; `Postgres, MDY`; `German, DMY`), con `verify_audit_chain` sobre la empresa real | **24 combinaciones, 24 PASS, 0 FAIL, máximo de roturas 0.** Es la evidencia principal de independencia respecto de la sesión |
| 6 | **Dependencia real de `DateStyle`**: un mismo `timestamptz` de `audit_logs` convertido a texto | `ISO, MDY` y `ISO, DMY` → `2026-09-18 16:43:39.517235+00`; `SQL, DMY` → `18/09/2026 16:43:39.517235 UTC`; `Postgres, DMY` → `Fri 18 Sep 16:43:39.517235 2026 UTC`; `German, DMY` → `18.09.2026 16:43:39.517235 UTC`. El texto que entra al payload del hash **depende** de `DateStyle` |
| 7 | **Control negativo causal.** Con la función fijada: `DateStyle = ISO, MDY`, 0 roturas. Luego, dentro de una transacción: `ALTER FUNCTION public.verify_audit_chain(uuid) RESET datestyle;` y `SET LOCAL datestyle = 'SQL, DMY'` (`funcion_fija = f`) | **1 rotura** (la única empresa con filas). Después, `ROLLBACK` y la configuración volvió a la del punto 3. Demuestra que la fijación dentro de la función es lo que evita la rotura |
| 8 | **Backup contra restauración**: `audit_logs` extraído del dump y de la copia, comparando `id`, `seq`, `prev_hash` y `hash` con el mismo algoritmo en ambos lados | Backup: 17 filas, `d6a79573a700842489d0c496f852b8ea`. Restauración: 17 filas, `d6a79573a700842489d0c496f852b8ea`. **Diferencias backup-no-restauración: 0**. Es la evidencia independiente de que el historial conserva la cadena original |
| 9 | **No reescritura** (auxiliar): `xmin` de las 17 filas de `audit_logs` | `xmin_min = xmin_max = 10597`; las migraciones quedaron después: 0131 → `xmin` 12500, 0132 → `xmin` 12501. Ninguna fila se creó ni reescribió después de la restauración. (`ctid` se miró solo como dato auxiliar; **no se presenta como prueba de integridad**) |

La prueba fuerte es la combinación de 8 (el historial es el del backup), 4 (cada hash es el SHA-256 de su payload
canónico y la cadena es continua), 5 (da lo mismo desde 24 sesiones) y 7 (la fijación importa).

### 10.2 Observación pendiente: la huella histórica pre-0132 no es reproducible

Antes de la 0132 se guardó `/tmp/tz-huella-canónica-pre-0132.txt`:

```text
audit_logs           | 17 | 03ad8399d3e7643b68383df6a509f9ac
normative_audit_logs |  0 | d41d8cd98f00b204e9800998ecf8427e
```

**No se recuperó el algoritmo exacto que la produjo.** Se buscó en el historial de la shell del servidor, en el
repositorio (árbol y historia de git), en `docs/PLAN_ZONA_HORARIA.md` y en las sesiones de trabajo conservadas; el
único `md5(string_agg(…))` del repositorio es el que escribió el propio plan para A.4b.1 y no coincide (devuelve
`'-'` para una tabla vacía; la huella perdida devolvió `md5('')`). Existen otras dos huellas que **no son una
referencia válida**: `425efe94bcf6e58f6d8b53186da7b63f` (`/tmp/tz-huella-antes-0131.txt`, de un procedimiento que
después resultó no reproducible) y `e23f5bb5664527dc3a2616af315ea91d` (posterior a la 0132, con otro algoritmo, por
lo tanto **no comparable** con `03ad8399…`). Ninguna de las tres se usa como comparación.

> La comparación contra la huella histórica pre-0132 no pudo reproducirse porque no se recuperó el algoritmo
> original de cálculo. Esta limitación no invalida las pruebas deterministas actuales de integridad, que incluyen
> comparación independiente backup/restauración, verificación criptográfica de la cadena, matriz 24/24 y negative
> control causal.

### 10.3 Por qué la limitación no invalida la conclusión técnica

1. La huella respondía a una sola pregunta: *¿cambió algún hash histórico?* Esa pregunta tiene respuesta por otra
   vía, y más fuerte: el testigo es el **propio backup** (punto 8), no un valor guardado a mano. Los cuatro campos
   que determinan la cadena (`id`, `seq`, `prev_hash`, `hash`) son idénticos en las 17 filas.
2. `ALTER FUNCTION … SET` modifica solo el catálogo (`pg_proc.proconfig`), nunca las filas de una tabla; además
   `audit_logs` tiene el disparador `audit_logs_immutable` (`BEFORE UPDATE OR DELETE`) que impide modificarlas.
   El punto 9 confirma por otro camino que no hubo reescritura.
3. El recálculo en Node (punto 4) parte de las columnas crudas y no usa ninguna función de la base: cada hash
   almacenado es hoy el SHA-256 de su payload en la representación canónica. Si algún hash histórico hubiera
   cambiado, o ya no sería el del backup (punto 8) o no sería el de su payload (punto 4).
4. La matriz y el control negativo prueban la propiedad que importa a futuro: el resultado no depende de la sesión.

### 10.4 Desvíos respecto del criterio escrito en el plan (A.4b)

Se dejan a la vista, para que «PASS CON OBSERVACIÓN» no se lea como «PASS».

| Criterio del plan | Lo que se hizo | Efecto |
|---|---|---|
| 2 · `diff` de huellas antes/después | No fue posible (observación 10.2). Se sustituyó por backup contra restauración, recálculo en Node y `xmin` | **Desvío, compensado** |
| 3 · matriz con una línea por empresa y contador 24 | 24 combinaciones, 24 PASS, sobre la única empresa con auditoría de la copia | Cumplido en sustancia |
| 4 · control negativo **antes** de la 0132 | Se hizo **después**, devolviendo la función `verify_audit_chain` al estado sin `DateStyle` dentro de una transacción con `ROLLBACK`. Solo sobre el verificador (no sobre los dos disparadores) | **Desvío, equivalente en lo esencial.** La rotura al *escribir* con otro estilo (los disparadores) se demuestra en local (P4b, P5), no en la copia |
| 5 · recálculo en Node sobre toda la historia | `--ultimas 100000` → 17 de 17 filas | Cumplido |
| 6 · `audit_logs > 0` | 17 | Cumplido |

### 10.5 Lo que A.4b **no** demuestra

- Que la 0132 esté en producción: **no está aplicada en `aai`** y no hubo deploy.
- Nada sobre la bitácora normativa (0 filas en la copia).
- Nada sobre empresas distintas de la única con auditoría en la copia (17 filas).
- Que `initPool` compilado entregue la zona de negocio dentro de la imagen, ni el ICU de la imagen: eso es V2, que se cerró aparte (§11).

### 10.6 Corrección del procedimiento

La huella de A.4b.1 se guardaba solo como un md5, sin el comando que la generó ni el contenido que resumía, y por eso
no pudo repetirse. En una próxima corrida hay que guardar **el contenido** y no solo su resumen:

```bash
# Contenido del historial (id|seq|prev_hash|hash) + su sha256, con el comando en la cabecera del archivo.
psqlc -d "$DESCARTABLE" -At -c "SELECT id, seq, prev_hash, hash FROM audit_logs ORDER BY seq" > /tmp/tz-historia-antes.txt
sha256sum /tmp/tz-historia-antes.txt | tee /tmp/tz-historia-antes.sha256
# después: la misma orden a /tmp/tz-historia-despues.txt y `diff` de los dos archivos
```

### 10.7 Siguiente control pendiente

En el momento de cerrar A.4b era V2 dentro de la imagen; V2 se ejecutó después y dio PASS (§11). El siguiente
control pendiente está en §11.3.

## 11. V2 — resultado en la imagen de ensayo (2026-10-09)

### Veredicto: **V2 — PASS**

**Qué es.** El control V2 del plan: `scripts/verificar-zona-de-negocio.mjs` ejecutado **dentro de la imagen**, con el
mismo `initPool` compilado que usa la API, para comprobar que las conexiones de la aplicación cuentan los días en la
zona de negocio aunque la base esté en UTC.

**Procedencia.** Lo ejecutó el usuario en el servidor y lo informó a la sesión que escribe este documento; esa sesión
no tiene acceso al servidor y no volvió a correrlo ni pudo verificarlo por su cuenta. Los SHA-256 esperados sí se
calcularon aquí (`git show 8d867d3:<archivo> | sha256sum`).

| Dato | Valor |
|---|---|
| Imagen | `nexo:ensayo-tz` |
| Identificación de la imagen | **Por contenido, no por metadatos de Docker.** El `Dockerfile` no tiene `LABEL` ni `ARG` de commit, así que la imagen no dice de qué commit salió. Se compararon los SHA-256 de cinco archivos con los de `8d867d3` y **coincidieron los cinco**: `scripts/verificar-zona-de-negocio.mjs` (`1753047e…8555`), `scripts/recalcular-cadena.mjs` (`898dc567…537b`), `packages/db/src/tenancy.ts` (`e34dbca3…ed6c`), `packages/shared/src/calendar-date.ts` (`da9563c4…22fd`) y `infrastructure/db/migrations/0132_funciones_de_hash_en_formato_iso.sql` (`fd1546d9…d5ff`) |
| Script | `scripts/verificar-zona-de-negocio.mjs` (el oficial, sin sustituirlo por una prueba manual) |
| Base utilizada | `aai_restauracion_tz`, indicada de forma explícita en la conexión. **Producción (`aai`) no se usó como base de V2.** El script solo ejecuta `SELECT` |
| `zonaDeNegocio` | `America/Argentina/Buenos_Aires` |
| `desdeLaAplicacion.zona` | `America/Argentina/Buenos_Aires` (la conexión abierta con `initPool`) |
| `conexionCruda.zona` | `UTC` (el control: una conexión sin la opción de zona, como la del clúster de producción) |
| `zonaOk`, `matrizOk`, `fechaOk`, `distingue` | `true`, `true`, `true`, `true` |
| `funcionesDeHash` | las tres con `TimeZone=UTC \| DateStyle=ISO, MDY` |
| Cierre del script | Terminó con `OK` y confirmó que la conexión cruda y la de la aplicación difieren en al menos un instante de prueba |

### 11.1 Qué prueba la matriz (muestra de los límites)

La matriz del script son 14 instantes fijos, definidos en el repositorio, que no dependen del reloj. El informe del
servidor dio `matrizOk: true`: **en los 14, el día que devolvió la conexión de la aplicación es igual al día argentino
calculado fuera de la base**. La tabla muestra una muestra de esos instantes. La segunda columna es la que debe devolver
la aplicación (y devolvió, por `matrizOk`); la tercera es lo que daría una sesión en UTC por definición de la zona —no es
un valor leído del informe, que a esta sesión no se le pasó instante por instante—, y es donde `distingue` mide la
diferencia.

| Instante (UTC) | Hora argentina | Día argentino (aplicación) | Día que daría una sesión UTC |
|---|---|---|---|
| `2026-10-05T23:59:59Z` | 20:59:59 | 2026-10-05 | 2026-10-05 |
| `2026-10-06T00:00:00Z` | 21:00:00 | **2026-10-05** | 2026-10-06 |
| `2026-10-06T02:59:59Z` | 23:59:59 | **2026-10-05** | 2026-10-06 |
| `2026-10-06T03:00:00Z` | 00:00:00 | 2026-10-06 | 2026-10-06 |
| `2026-11-01T00:00:00Z` | 21:00 del 31/10 (fin de mes) | **2026-10-31** | 2026-11-01 |
| `2027-01-01T00:00:00Z` | 21:00 del 31/12 (fin de año) | **2026-12-31** | 2027-01-01 |
| `2027-01-01T03:00:00Z` | 00:00 del 01/01 | 2027-01-01 | 2027-01-01 |
| `2027-03-01T02:59:59Z` | 23:59:59 del 28/02 (año común) | **2027-02-28** | 2027-03-01 |
| `2028-03-01T02:59:59Z` | 23:59:59 del 29/02 (bisiesto) | **2028-02-29** | 2028-03-01 |

### 11.2 Limitaciones que deben quedar claras

1. **ICU no se auditó de forma exhaustiva.** El script **no** informa un indicador `ICU: PASS` independiente. Lo que
   hay es evidencia funcional: con el ICU de Node de la imagen, `Intl` resolvió `America/Argentina/Buenos_Aires` y
   produjo la matriz de 14 instantes (si el ICU no tuviera la zona, `@aai/shared` habría fallado al importarse). No se
   revisaron otras zonas, otras versiones de datos de zona ni otros usos de `Intl`.
2. **El commit de la imagen no se verificó con metadatos de Docker**, sino comparando el SHA-256 de cinco archivos
   relevantes. Es una identificación fuerte para esos archivos; no es una prueba de que **todo** el contenido de la
   imagen sea el de `8d867d3`.
3. **La base de V2 fue la copia del backup**, no producción. V2 prueba el mecanismo de la imagen (zona del pool y
   conversión de instantes); **no** prueba que la aplicación desplegada, con su `.env` real, se comporte así. Eso
   es V1 y V7 en producción.
4. V2 corrió con la imagen **de ensayo**, no con `nexo:production`: esa imagen no se tocó y todavía tiene el código
   anterior.

### 11.3 Siguiente control pendiente

Según el §8 de esta auditoría (ya sin los puntos 1 a 3): el **deploy de día (09:00–18:00 ART)** con
`scripts/desplegar.sh`, que requiere autorización expresa. Después, en este orden y sin saltear ninguno: V1 y V3–V6 en
producción con la imagen desplegada, y **V7** entre las 21:00 y las 24:00 ART. Hasta que V7 pase, los bugs #3/#4/#5
siguen **no corregidos y verificados en producción**.
