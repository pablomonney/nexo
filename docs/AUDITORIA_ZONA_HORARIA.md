# Auditoría integral de la zona horaria de negocio — 2026-10-07

Segunda auditoría, independiente de la primera, sobre los commits `6b20f86`,
`ddd8d58` y `e1b9007` (HEAD y `origin/main` coinciden en `e1b9007`). Se pidió
**no confirmar**, sino buscar lo que todavía pueda romperse.

> **Veredicto: PASS LISTO PARA COMMIT (árbol local) — NO cerrado, NO listo para deploy.**
> Se hicieron dos pasadas. La primera encontró y corrigió, **sin commitear**, tres
> defectos P1 de interfaz, siete P2 y dos P3, incluido un falso PASS de un test
> que la auditoría anterior había dado por bueno. La segunda —la revisión técnica
> final del árbol local— encontró y corrigió otros cuatro P2 y tres P3 (hallazgos
> 18 a 25), la mayoría en los **propios controles** (S-37, S-45, el recálculo de la
> cadena y un test del parser de fechas que no detectaba su mutación). La suite completa
> da 202 archivos y 3272 pruebas verdes con la base de pruebas en UTC y en Argentina, y
> `npm run verify` sale con código 0 contra `aai_test`.
>
> Lo que **no** está hecho, porque requiere el servidor: **A.4b** (ensayo de la 0132 sobre
> `aai_restauracion_tz`), el build de la imagen Docker, el deploy y **V7**. Nada de eso
> se simuló. Ver «Qué falta para decir cerrado».

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
| 17 | P3 | imagen Docker | `hoyEnZonaDeNegocio` usa `Intl` con `timeZone`: necesita ICU completo (la imagen oficial `node:22-alpine` lo trae). **No se pudo comprobar dentro de la imagen** (esta máquina no tiene Docker) | — | **Requiere prueba en el servidor** (V2 la cubre) |
| 18 | P2 | `consola.html`, `diaDeUnInstante` / `momentoDeUnInstante` | Sin guarda para una fecha `AAAA-MM-DD`: `new Date('2026-03-01')` es la medianoche UTC y pasaba al 28/02 en Argentina (**doble conversión**). Hoy se llaman solo con `timestamptz`, pero cualquier campo `date` mal cableado habría corrido un día | Test con mutación (sin la guarda → falla) | Corregido: una fecha sin hora se devuelve tal cual |
| 19 | P2 | `tests/security/helpers/fechas-en-utc.ts` (S-37) | Seguía sin ver el ISO guardado en una variable (`const iso = d.toISOString(); iso.slice(0, 10)`), `toJSON()`, `.replace('T', ' ')` y `getTimezoneOffset()`. Y `calendar-date.ts` estaba exceptuado **entero** por archivo: un `getUTC*` nuevo ahí pasaba sin mirarse | Mutación S37-M3: **no detectada** al principio | Corregido: detector ampliado, excepción por línea (`s37-permite`) y un test que comprueba que **cada** anotación tape algo real |
| 20 | P2 | `tests/security/zona-de-negocio-en-conexiones.test.ts` (S-45) | Aceptaba una zona equivocada escrita a mano (`-c timezone=UTC`), el helper `opcionesDeConexion()` pisado por otra `options:` y no tenía caso para una segunda conexión | Autopruebas nuevas; 8 mutaciones | Corregido |
| 21 | P2 | paso V5 del plan | El «recálculo de las últimas 50 filas fuera de las funciones» solo existía como texto: sin script, V5 seguía siendo circular | — | Corregido: `scripts/recalcular-cadena.mjs` + `scripts/lib/cadena.mjs`, con test y control negativo. **Al escribirlo apareció un defecto propio** (`ORDER BY seq` tomaba el alias de texto `seq::text` y ordenaba '9937' sobre '10121'): lo detectó la corrida contra `aai_test` (2 «enlaces rotos» en cadenas sanas), no la lectura |
| 22 | P3 | matriz de la cadena | La matriz era de 8 zonas × 5 estilos y no incluía `SQL, MDY`, Madrid ni Tokio; no cubría la cadena normativa con la matriz ni variables como `IntervalStyle` o `extra_float_digits` | — | Corregido: 10 zonas × 6 estilos (60 sesiones), cadena por empresa **y** normativa, recálculo independiente en SQL plano, y test P4c de otras variables de sesión |
| 23 | P3 | `scripts/verificar-zona-de-negocio.mjs` | `fechaOk` comparaba el `CURRENT_DATE` de la base con un «hoy» calculado **después**: falla un instante justo en la medianoche argentina | Razonamiento | Corregido: acepta el día de antes y el de después de la consulta |
| 24 | P3 | `packages/document-engine/src/parsers/fecha.ts` | El año de referencia ya usaba `hoyEnZonaDeNegocio()`, pero ningún test dinámico lo cubría: la mutación a `getUTCFullYear()` pasaba (solo la veía S-37) | Mutación AN-6: **no detectada** por los tests del motor | Corregido: test con reloj fijo en el 31/12 entre las 21:00 y las 24:00 ART |
| 25 | P3 | anotaciones `s37-permite` | Tres comentarios de dos líneas repetidos y un `);` suelto dentro de un comentario de `arca-check.mjs` | Lectura del diff | Corregido |

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
| **V2** zona de las conexiones | `initPool` compilado entrega la zona de negocio | Local: matriz de 14 instantes fijos, exit 0 con el cliente crudo en UTC y en Argentina; mutaciones (sin la opción, con otra zona) → exit 1 | La versión anterior **sí**: dependía del reloj. La actual no: ningún test depende de estar entre las 21:00 y las 24:00, y `fechaOk` tolera la medianoche | **Mejorado**; falta correrlo dentro de la imagen y contra la base real (**pendiente, servidor**) |
| **V3** cadena íntegra | El historial verifica desde cualquier sesión | P1–P3 sobre la copia del backup real (informado): UTC 0, Argentina 1 antes de la 0131 y 0 después. Local: 10 zonas × 6 estilos, cadena por empresa y normativa | Si la base real tuviera 0 filas. Tiene 17. **No hay función verificadora de `normative_audit_logs`**: ahora la cubre `recalcular-cadena.mjs` | **Reforzado**. Falta la 0132 en la copia (A.4b, **pendiente, servidor**) |
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
2. **A.4b está PENDIENTE y no se simuló**: la copia de ensayo no tiene la 0132. Hay que correr el procedimiento del plan (estado previo, huella del historial, control negativo, migrar, matriz de 24 sesiones, recálculo en Node).
3. **Imagen Docker no probada** (sin Docker ni WSL local): ICU completo para `Intl` y el script dentro de la imagen. Análisis estático en §9: `node:22-alpine` trae ICU completo; si no lo trajera, `@aai/shared` falla **al importarse** (`RangeError`), de forma visible y antes de servir tráfico.
4. **Escritores manuales en UTC** (`psql`) siguen pudiendo dejar `valid_from` de mañana. Decisión
   pendiente del usuario: fijar también la zona por defecto de la base (ahora segura para la cadena).
5. **`normative_audit_logs`** no tiene verificador en la base; `recalcular-cadena.mjs` lo cubre, pero **todavía no se corrió contra producción**. En `aai_test` esa tabla está vacía: la fórmula normativa se prueba con filas escritas dentro de una transacción.
6. Los timestamps que la API entrega como texto (`…_at::text`) ahora terminan en `-03` en vez de `+00`:
   la consola solo los muestra y `new Date()` los interpreta igual, pero un consumidor externo
   que recortara `+00` se rompería. No se conoce ninguno.
7. Hallazgos 13 a 17 de la tabla.

## 8. Qué falta para decir «cerrado»

1. Revisar y commitear estos cambios (**listo para commit; no para deploy**). Hace falta pushearlos: A.4b necesita la 0132 en el remoto.
2. **A.4b** sobre la copia (`aai_restauracion_tz`): estado previo, huella del historial antes y después, control negativo, 0132, matriz de 24 sesiones con una sola línea por empresa, `recalcular-cadena.mjs` en 0. **Pendiente: requiere el servidor.**
3. Construir la imagen en el servidor y correr V2 adentro (ICU completo, `initPool` compilado). **Pendiente.**
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
ICU 78.3 / tz 2026b, no con la versión de la imagen: eso, y que `initPool` compilado entregue la zona, **requiere
la prueba en el servidor**. No se instaló ninguna dependencia.
