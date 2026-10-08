# Plan — zona horaria de negocio (defectos de fechas #3, #4 y #5)

Estado (2026-10-07): **plan aprobado con dos modificaciones; implementado y
verificado localmente; commits `6b20f86`, `ddd8d58` y `e1b9007` en el remoto; P0–P2
y P3 (solo con la 0131) ejecutadas en el servidor por el usuario. La auditoría
integral del 2026-10-07 agregó la migración 0132 y otros cambios, SIN COMMITEAR
(ver el apartado «Actualización del 2026-10-07» al final de este documento y
`docs/AUDITORIA_ZONA_HORARIA.md`). Sin deploy.**

**Resultados de P0–P2 — informados por el usuario, no ejecutados ni verificados
por la sesión que escribió este plan**, sobre una copia aislada
(`aai_restauracion_tz`) del backup `aai-20261005T023159Z-auto.dump`:
- **P0: PASS** — restauración íntegra.
- **P1: PASS** — `verify_audit_chain()` bajo sesión UTC: 0 roturas.
- **P2: PASS** — bajo `America/Argentina/Buenos_Aires` aparece la rotura esperada
  (1): el control negativo funciona y confirma que el cambio ingenuo de zona
  rompía la cadena real de producción.
- La base real `aai` no se modificó, la migración 0131 no se aplicó en
  producción y no hubo deploy. La copia `aai_restauracion_tz` queda sin borrar
  hasta decidir la limpieza (A.6), posterior a P3.

Pendiente: **P3** (la 0131 sobre la copia, Anexo A.4), que exige que el commit
esté en el remoto; y el resto de P12 en el servidor (A.5).

**Decisiones del usuario sobre el plan original:**
1. **No se agregan campos a `/health/db`.** La sonda pública queda con el mínimo.
   La zona de las conexiones se verifica con pruebas y con un script interno de
   solo lectura (`scripts/verificar-zona-de-negocio.mjs`).
2. **V7 está separada del deploy.** El deploy puede hacerse entre 09:00 y 18:00
   ART; los bugs #3/#4/#5 **no** se marcan como definitivamente corregidos hasta
   ejecutar V7 en producción entre 21:00 y 24:00 ART. Estados permitidos:
   - antes de V7: *«Corrección implementada y desplegada; pendiente de
     confirmación en producción durante la franja 21:00–24:00 ART.»*
   - solo después de un V7 exitoso: *«Bugs #3/#4/#5 corregidos y verificados en
     producción.»*
3. Backup aprobado: `aai-20261005T023159Z-auto.dump`, restaurado de forma aislada
   en `aai_restauracion_tz`. La base real `aai` no se modifica durante el ensayo.
   La prueba negativa previa a la 0131 se mantiene (P2).

## 0 · Registro de estado

- **El despliegue `b412b9e` es correcto y permanece así.** Informado el
  2026-10-05: `/health` y `/health/db` responden `version: b412b9e`, 130
  migraciones, `nexo-app`, `nexo-postgres` y Traefik `healthy`, RLS correcto,
  deploy con 0 fallos y 1 aviso (el archivo
  `docker-compose.prod.yml.bak.20260915131651`, que no se toca).
- **Lo que este plan trata es un defecto funcional pendiente, no un fallo del
  despliegue:** los defectos de fechas #3, #4 y #5 (numeración de
  `CIERRE_INTEGRAL_NEXO.md`; #6, #7 y #8 en `FINAL_NEXO_STATUS.md`) **no están
  corregidos en producción.**
- Causa: sus arreglos consultan `CURRENT_DATE`, que depende de la zona de la
  sesión de PostgreSQL. Producción devuelve `UTC` (`SHOW timezone`, confirmado
  el 2026-10-05). El repositorio no configura la zona en ningún lado (0 usos de
  `AT TIME ZONE`, 0 de `SET TIME ZONE`, 0 de `Buenos_Aires`); la base de
  desarrollo local sí está en `America/Buenos_Aires`, y eso enmascaró el
  defecto en las pruebas.

## 1 · Qué se descartó, y por qué

| Alternativa | Veredicto | Motivo (con evidencia) |
|---|---|---|
| A · cambiar la zona del servidor PostgreSQL | **Descartada** | `audit_chain_link`, `normative_audit_chain_link` y `verify_audit_chain` incluyen `occurred_at::text` en el hash, y un `timestamptz` en texto sale distinto según la zona de la sesión. Mismo instante: UTC → `2026-10-05 21:30:00.123456+00` → hash `23acd960…`; Argentina → `…18:30:00.123456-03` → hash `a6b17a0c…`. Todo el historial de producción se hasheó en UTC: verificarlo en otra zona lo reportaría roto. Además `ALTER DATABASE` no está en el repositorio y no viaja en `pg_dump -Fc`. |
| B · reemplazar `CURRENT_DATE` consulta por consulta | **Descartada** | Hay unas 90 ocurrencias en vistas de migraciones inmutables (checksum) y ~37 en código. Mezclar fechas UTC y argentinas es peor que cualquiera de las dos (un precio con `vigente_desde` en UTC contra un «hoy» argentino queda sin vigencia unas horas: el incidente del 2026-09-09 al revés). |
| **C · zona de negocio en la sesión de la aplicación + funciones de hash fijadas a UTC** | **Recomendada** | Una sola definición de «hoy» para escritores y lectores, en el código y versionada. El hash no cambia porque las tres funciones quedan fijadas a UTC, que es la zona con la que se escribió todo el historial. |

## 2 · Cambios propuestos

### C1 · Migración `0131_funciones_de_hash_en_utc.sql` (nueva)

```sql
ALTER FUNCTION audit_chain_link()           SET timezone = 'UTC';
ALTER FUNCTION normative_audit_chain_link() SET timezone = 'UTC';
ALTER FUNCTION verify_audit_chain(uuid)     SET timezone = 'UTC';
```

`ALTER FUNCTION … SET` no redefine la fórmula: solo fija la zona mientras la
función corre, así que `occurred_at::text` se escribe igual que hoy
(`…+00`). Verificado en la base local con funciones temporales: sesión en
Argentina + función con `SET timezone='UTC'` → `2026-10-05 21:30:00.123456+00`.
Cabecera de la migración en el estilo de la 0130 (explica el porqué).

Complemento en `scripts/check-structure.mjs` (`audit:estructura`): comprobar que
`pg_proc.proconfig` de las tres funciones contiene `timezone=UTC` y `datestyle=ISO`
(éste último desde la 0132), para que una
reescritura futura que pierda el `SET` falle en la verificación.

### C2 · `packages/db/src/tenancy.ts` — `initPool`

Agregar `options: '-c timezone=America/Argentina/Buenos_Aires'` al
`new pg.Pool({...})` (línea 33), con la zona como constante exportada
(`ZONA_DE_NEGOCIO`, definida **una sola vez en `@aai/shared`**, de la que ya
dependen `db` y `document-engine`; ajuste respecto del plan original, que la
ponía en `packages/db`). Verificado en la base local: `Pool` con `options` fija la zona de
cada conexión; un `SET LOCAL timezone` dentro de una transacción la pisa solo
hasta el `ROLLBACK`/`COMMIT`. Es el único lugar donde la API crea un pool.
Argentina no tiene horario de verano desde 2009 (UTC−3 fijo).

Limitación a dejar escrita en el código: el parámetro de arranque `options` no
lo admite un pooler en modo transacción; hoy la conexión es directa a
`nexo-postgres:5432`.

### C3 · Verificación interna de la zona (reemplaza al campo en `/health/db`)

**No se toca `/health/db`** (decisión del usuario: la sonda pública se queda con
el mínimo). En su lugar, `scripts/verificar-zona-de-negocio.mjs`, de **solo
lectura** (tres `SELECT`; no escribe ni imprime la conexión): abre una conexión
con el mismo `initPool` compilado que usa la API y otra cruda, sin zona, como
control; informa `SHOW timezone` y `CURRENT_DATE` de las dos, y sale con
código 1 si la de la aplicación no es la zona del negocio o su `CURRENT_DATE`
no coincide con el día argentino calculado fuera de la base. Su resultado
incluye `distingue`: si esa corrida pudo ver alguna diferencia entre las dos
zonas (de día no puede). Se ejecuta dentro de un contenedor de la imagen
desplegada.

### C4 · Scripts que deben fijar la zona de negocio

Se agrega `scripts/lib/zona.mjs` (misma constante, más
`opcionesDeConexion()`), y un test que exige que valga lo mismo que
`ZONA_DE_NEGOCIO`.

| Script | ¿Fija la zona? | Motivo |
|---|---|---|
| `facturacion-ciclo.mjs` | **Sí** | Su `hoy` sale de `CURRENT_DATE::text` (línea 69) y decide cargos, vencimiento de pruebas y mora. Lo lanza `tareas-diarias.mjs` a las 03:15 UTC (00:15 ART), hora a la que ambas fechas coinciden: hoy no falla, pero depende de la hora del timer. |
| `sembrar-comercial-b1.mjs` | **Sí** | Escribe `vigente_desde` con `CURRENT_DATE::text` (línea 80): es el escritor de la vigencia de precios, el origen del incidente del 2026-09-09. |
| `declarar-plan-de-pasarela.mjs`, `ensayo-de-pagos.mjs` | **Sí** | Leen el precio vigente contra `CURRENT_DATE`. |
| `metricas-saas.mjs` | **Sí** | `date_trunc('month', CURRENT_DATE)` define la ventana del informe. |
| `factura-demo.mjs` | **Sí** (corrección al plan original, que lo daba por automático) | Usa `initPool` para la aplicación **y** un cliente `pg` crudo `db` para su `hoy` (`CURRENT_DATE::text`): con el cliente crudo en UTC, el comprobante de demostración caería en un día que el período —evaluado por la API en hora argentina— todavía no cubre. |
| `bench-migracion.mjs`, `construir-landing.mjs`, `fixtures-invariantes.mjs`, `verify-primer-arranque.mjs` | No hace falta | Usan `initPool` para la aplicación y no consultan `CURRENT_DATE` con sus clientes crudos. La regla general (S-45) los vigila: si alguno empezara a usar la fecha de la base, el test exige zona o justificación. |
| `verificar-zona-de-negocio.mjs` | Justificado | Es la comprobación de la zona; abre a propósito una conexión cruda de control. |
| `declarar-precio-de-plan.mjs`, `declarar-precio-de-modelo.mjs`, `declarar-politica-de-cobranza.mjs` | No | La fecha `desde` entra como argumento explícito `AAAA-MM-DD`. |
| `verify-ledger.mjs`, `verify-audit-chain.mjs`, `check-structure.mjs`, `check-invariants.mjs` | No | Verificadores. Tras la 0131 el resultado de la cadena no depende de la zona. |
| `migrate.mjs`, `db-create.mjs`, `restaurar-backup.mjs`, `test-db.mjs`, `norms-watch.mjs`, `register-prompts.mjs` | No | DDL, administración o sin fechas de negocio. |
| `backup-db.mjs` | **No, a propósito** | El sello del archivo (`new Date().toISOString()`) debe seguir en UTC para coincidir con los nombres `aai-…Z-auto.dump` del servidor. |
| `pagos-bandeja.mjs`, `correo-bandeja.mjs` | No | Solo imprimen instantes (`toISOString()`) en el log. |
| `bench-vistas.mjs` | No | Genera datos sintéticos de benchmark. |

Cambio en cada uno de los 6 scripts con **Sí**: `new pg.Client({ connectionString })`
→ `new pg.Client({ connectionString, ...opcionesDeConexion() })`. Un test
estático (S-45) exige que ninguno de los seis quede sin la opción, y que todo script
nuevo que use `CURRENT_DATE` la pida o figure justificado.

### C5 · Restos de UTC

1. `apps/api/src/intelligence/catalogo.ts:617` — `periodo: new Date().toISOString().slice(0, 7)`.
   La tarjeta lee `analytics_resumen`, cuyas columnas «del mes» usan
   `date_trunc('month', current_date)` (migración 0057). La etiqueta tiene que
   salir del mismo reloj: agregar `to_char(current_date, 'YYYY-MM') AS periodo`
   a la consulta de las líneas 600-609 y usar `f?.periodo`.
2. `packages/document-engine/src/parsers/fecha.ts:154` —
   `opciones.anioReferencia ?? new Date().getUTCFullYear()`. Agregar a
   `packages/shared/src/calendar-date.ts` (la única excepción legítima de S-37)
   `hoyEnZonaDeNegocio(ahora = new Date()): CalendarDate`, implementada con
   `Intl.DateTimeFormat('en-CA', { timeZone: 'America/Argentina/Buenos_Aires' })`
   y probada con instantes fijos; `fecha.ts` usa `yearOf(hoyEnZonaDeNegocio())`.
   `@aai/shared` ya es dependencia de `document-engine`.

### C6 · Extensión de S-37 (`tests/security/fechas-en-hora-argentina.test.ts`)

Agregar a `EN_UTC`:
- `/new Date\(\)\s*\.\s*toISOString\(\)\s*\.\s*slice\(\s*0\s*,\s*7\s*\)/`
- `/getUTCFullYear\(\)/` (con `calendar-date.ts` como excepción ya existente)

y un control nuevo, **S-45** (`tests/security/zona-de-negocio-en-conexiones.test.ts`),
estático: todo `new pg.Pool(` / `new pg.Client(` en `apps/api/src` y
`packages/*/src` pasa la zona de negocio, y los scripts de la tabla C4 también. Se confirma, como se hizo en S-37, revirtiendo cada arreglo y
viendo el test fallar.

### C7 · Pruebas nuevas (vitest)

- `tests/integration/zona-horaria-y-cadena.test.ts`: ver P4–P7 abajo.
- `packages/shared/src/calendar-date.test.ts`: `hoyEnZonaDeNegocio` con
  instantes fijos (ver P8).
- Los tests de `mesDe` y de panorama ya reciben `hoy` explícito; no cambian.

### C8 · Qué NO se cambia

`.env`, la configuración de PostgreSQL de producción, `docker-compose.prod.yml`,
ninguna migración existente, ningún dato. Tampoco se agrega `PGOPTIONS` a
`/opt/nexo/.env`: sería configuración de servidor fuera del repositorio.

## 3 · Pruebas obligatorias y criterios

Cada prueba tiene un criterio objetivo. **Una prueba en rojo detiene el
proceso.** Las P1–P3 corren en el servidor, sobre una copia restaurada; el resto
corre localmente.

### Backup y restauración sin tocar la base real (P1–P3)

**Backup elegido:** `/opt/nexo/var/backups/aai-20261005T023159Z-auto.dump` —
el automático de las 02:31 UTC del 2026-10-05, verificado correctamente esa
mañana. Se fija por nombre y **nunca** con `ls -t | head -1`, para que otro
backup más nuevo no cambie el experimento. Es de producción real (contabilidad
de terceros): **no sale del servidor.** La restauración se hace dentro de
`nexo-postgres`, en una base descartable con el prefijo exigido por el candado
del proyecto (`aai_restauracion…`), siguiendo `docs/DESPLIEGUE.md` §7.7:

```bash
cd /opt/nexo && set -a; . ./.env; set +a; export PGPASSWORD="$POSTGRES_PASSWORD"
BACKUP=/opt/nexo/var/backups/aai-20261005T023159Z-auto.dump
DESCARTABLE=aai_restauracion_tz
case "$DESCARTABLE" in aai_restauracion*) ;; *) echo "nombre no permitido"; exit 1;; esac

ls -l "$BACKUP"; sha256sum "$BACKUP" | tee /tmp/tz-backup.sha256     # guardar para comparar al final
df -h /opt/nexo | tail -1                                            # libre >= 3x el tamaño del dump
docker exec -i nexo-postgres pg_restore --list < "$BACKUP" | head -5 # lectura: el archivo es un dump válido
docker exec -e PGPASSWORD nexo-postgres psql -U "$POSTGRES_USER" -d postgres -tAc \
  "SELECT count(*) FROM pg_database WHERE datname='$DESCARTABLE'"    # debe dar 0
docker exec -e PGPASSWORD nexo-postgres psql -U "$POSTGRES_USER" -d postgres -c "CREATE DATABASE $DESCARTABLE"
docker exec -e PGPASSWORD -i nexo-postgres pg_restore -U "$POSTGRES_USER" -d "$DESCARTABLE" \
  --no-owner --no-password < "$BACKUP"                               # SIN --clean y SIN --create
sha256sum "$BACKUP" | diff - /tmp/tz-backup.sha256 && echo "backup intacto"
```

La imagen para correr la migración se construye aparte, **sin tocar
`nexo:production` ni recrear `nexo-app`**: `git fetch origin` y
`git archive <commit> | tar -x -C /tmp/nexo-ensayo-tz`, y
`docker build -t nexo:ensayo-tz /tmp/nexo-ensayo-tz`. La migración corre en un
contenedor aparte contra la copia, con la contraseña pasada por nombre y
codificada dentro del contenedor, igual que en `scripts/desplegar.sh`.

| # | Prueba | Cómo | Aprueba si | Falla si |
|---|---|---|---|---|
| **P0** | La copia es completa | Contar filas de `schema_migrations`, `companies`, `audit_logs` y `journal_entries` en la copia y en la base viva (para `audit_logs`, solo filas con `seq` ≤ el máximo de la copia) | `schema_migrations` = 130 y los demás conteos coinciden | Cualquier diferencia: la restauración es incompleta, se corta |
| **P0b** | La prueba tiene potencia | `SELECT count(*) FROM audit_logs` en la copia | > 0 filas en al menos una empresa. Si es 0, P1/P2 no prueban nada: se exige P5 (sintética) como sustituto | — |
| **P1** | Cadena íntegra, sesión UTC, **antes** de la 0131 | `SET timezone='UTC'; SELECT c.id, count(*) filter … FROM companies c, LATERAL verify_audit_chain(c.id)` por empresa | 0 roturas en todas las empresas | ≥ 1 rotura: producción ya tiene la cadena rota, se corta y se investiga antes de seguir |
| **P2** | Control negativo: misma verificación en sesión Argentina, antes de la 0131 | idem con `SET timezone='America/Argentina/Buenos_Aires'` | **Debe dar roturas** en toda empresa con filas (confirma que la prueba detecta el problema y que el cambio ingenuo de zona habría roto la cadena) | 0 roturas con filas > 0: el supuesto es falso y hay que revisar el plan |
| **P3** | Migración 0131 sobre la copia, y verificación en ambas zonas | `migrate up` desde `nexo:ensayo-tz`; repetir la consulta de P1 con sesión UTC y con sesión Argentina; `diff` de las dos salidas | `schema_migrations` pasa a 131 (solo 0131) o a 132 (con la 0132); ambas sesiones dan 0 roturas; las salidas son idénticas byte a byte | Cualquier rotura o diferencia |

### Pruebas locales (P4–P12)

| # | Prueba | Aprueba si | Falla si |
|---|---|---|---|
| **P4** | Las tres funciones, bajo ambas zonas (vitest de integración): insertar filas de auditoría y de `normative_audit_logs` con sesión UTC y con sesión Argentina | El hash guardado de cada fila coincide con el recalculado en JavaScript a partir del texto UTC de `occurred_at`; `verify_audit_chain` da 0 roturas sobre filas escritas en cualquiera de las dos zonas | Algún hash difiere según la zona de escritura |
| **P5** | Filas «heredadas»: volver al estado previo a las migraciones, escribir filas con sesión UTC/ISO, aplicar **los archivos reales** de la 0131 y de la 0132 una por una y verificar desde 10 zonas × 6 estilos de fecha | Antes de la 0131: Argentina da rotura (control negativo). Tras la 0131: 0 roturas en todas las zonas y rotura con estilo SQL (control negativo de `DateStyle`). Tras la 0132: 0 roturas en las 60 sesiones y las tres funciones con ambas fijaciones | Cualquier rotura donde no se espera, o falta de rotura donde se espera |
| **P6** | `proconfig` de las tres funciones | Contiene `timezone=UTC` y `datestyle=ISO` en las tres | Falta en alguna (y `audit:estructura` lo confirma) |
| **P7** | Las conexiones de la aplicación | Con el entorno **hostil** (`PGOPTIONS=-c timezone=UTC`): `SHOW timezone` dentro de `withCompany` y de `withoutCompany` devuelve `America/Argentina/Buenos_Aires`; **las 5 conexiones simultáneas del pool** (≥ 3 backends distintos) la reciben; un `SET LOCAL` deshecho no la contamina; `CURRENT_DATE::text` es igual a `(now() AT TIME ZONE …)::date::text` | Cualquier otra zona o fecha. Independiente de la hora. (La versión anterior de este test pasaba aunque `initPool` no pidiera la zona, porque `setup-env.ts` ya fijaba `PGOPTIONS`: falso PASS, corregido) |
| **P8** | `hoyEnZonaDeNegocio` con instantes fijos | `2026-10-06T01:00:00Z`→`2026-10-05`; `2026-10-06T03:00:00Z`→`2026-10-06`; `2026-12-31T23:30:00Z`→`2026-12-31`; `2027-01-01T02:59:59Z`→`2026-12-31`; `2027-01-01T03:00:00Z`→`2027-01-01` | Cualquier valor distinto |
| **P9** | S-37 extendido | Pasa con el código corregido y **falla** al revertir `catalogo.ts:617`, `fecha.ts:154` o la opción de un script de la tabla C4 | No falla al revertir (el control no sirve) |
| **P10** | Suite completa con la base de pruebas en **UTC** (como producción) | Ver comando abajo. 197 archivos, todas las pruebas verdes | Cualquier prueba roja: se investiga si es una dependencia oculta de la zona |
| **P11** | Suite completa con la base de pruebas en **Argentina** (como hoy) | Ídem | Ídem |
| **P12** | `npm run verify` sobre la copia restaurada | Ver abajo | Cualquier paso en rojo |

**P10/P11 — cómo se fija la zona de la base de pruebas** (solo la base local
`aai_test`; la reconstrucción de la base la devuelve al valor por defecto, así
que se aplica después de `npm run test:db`):

```bash
psql … -c "ALTER DATABASE aai_test SET timezone = 'UTC'"                          # P10
psql … -c "ALTER DATABASE aai_test SET timezone = 'America/Argentina/Buenos_Aires'" # P11
# Antes de cada corrida: SHOW timezone contra aai_test debe devolver lo esperado.
npx vitest run
```

El pool de la aplicación fuerza la zona argentina en ambos casos; lo que cambia
es la zona de las conexiones crudas de los tests y de los valores por defecto de
la base. Eso es lo que distingue una dependencia oculta de la zona.

**P12 — qué significa «sobre la copia restaurada».** `npm run verify` encadena
typecheck, lint, `lint:arch`, `check:no-float`, `norms:verify`, `verify:arranque`
(arma su propia base vacía), `ledger:verify`, `audit:cadena`,
`audit:estructura`, `audit:invariants` y `test:coverage`. Los pasos que leen una
base (`ledger:verify`, `audit:cadena`, `audit:estructura`, `audit:invariants`)
se corren contra la copia con `nexo:ensayo-tz` y en modo `--observacional`
(`docs/DESPLIEGUE.md` §7.7: `audit:invariants` conductual no corre dentro del
contenedor). Los demás pasos corren localmente, sin base de producción.
Aprueba si todos salen con código 0; `ledger:verify` y `audit:cadena` pueden
informar `NO EJERCITADO` solo si P0b dio 0 filas.

## 4 · Orden de implementación, commit y deploy

1. **Plan aprobado** (este documento). Nada se implementa antes.
2. **Implementación local**, en este orden:
   C1 → C2 → C5 → C6 → C4 → C3 → C7. Cada paso con su test en rojo antes del
   arreglo (donde el test pueda fallar sin él).
3. **Verificación local:** P4–P11 y `typecheck`, `lint`, `lint:arch`.
4. **Dos commits** en `main`, sin `--amend`, sin force:
   - Commit 1 — «Fijar a UTC las funciones de hash y la zona de negocio en la
     conexión»: C1, C2, C3 y sus tests (P4–P7).
   - Commit 2 — «Cerrar los restos de UTC y extender S-37»: C4, C5, C6 y sus
     tests (P8, P9).
5. **Push** (lo ejecuta el usuario: mi `git push` fue bloqueado por el
   clasificador de permisos de Claude Code el 2026-10-05).
6. **Ensayo en el servidor sobre la copia restaurada** (P0–P3 y P12), ejecutado
   por el usuario. **Puerta de aprobación:** se revisan las salidas contra los
   criterios de arriba. Con cualquier rojo, no hay deploy.
7. **Deploy** con `scripts/desplegar.sh`, en horario diurno argentino
   (09:00–18:00 ART): fuera de 21:00–24:00 ART para no desfasar los
   `valid_from DEFAULT CURRENT_DATE` (migraciones 0002/0003) de filas creadas
   esa noche. Antes: backup fresco verificado, `--auditar` limpio y la imagen
   actual anotada para el rollback. `desplegar.sh` ya migra **antes** de
   levantar la imagen nueva: la 0131 es compatible con la versión vieja (que
   sigue en UTC y no cambia de comportamiento), así que el orden es seguro.
8. **Limpieza del ensayo**, solo después de aprobar: `DROP DATABASE
   aai_restauracion_tz` (el nombre pasa por el mismo `case` del candado) y
   `docker rmi nexo:ensayo-tz`. No se borra ningún backup.

## 5 · Verificación posterior al deploy

| # | Qué se comprueba | Cómo | Aprueba si |
|---|---|---|---|
| **V1** | Versión y migraciones | `curl -fsS https://nexointelligence.com.ar/health/db` | `version` = el nuevo commit y `migrations` = 132 (131 + 0132) |
| **V2** | Las conexiones de la aplicación usan la zona de negocio | `scripts/verificar-zona-de-negocio.mjs` dentro de un contenedor de la imagen desplegada (ver C3) | Código 0; `desdeLaAplicacion.zona` = `America/Argentina/Buenos_Aires`; `conexionCruda.zona` = `UTC` (la base sigue en UTC); `matrizOk` = true y `distingue` = true **a cualquier hora**, porque la prueba principal convierte 14 instantes fijos (20:59:59, 21:00:00, 21:00:01, 23:59:59 y 00:00:00 ART, fin de mes, fin de año y los dos febreros) y no depende del reloj |
| **V3** | El historial de auditoría sigue íntegro | `audit:cadena --observacional` desde la imagen nueva contra la base real, con `PGOPTIONS='-c timezone=UTC'` y otra vez con `PGOPTIONS='-c timezone=America/Argentina/Buenos_Aires'` (`pg` respeta `PGOPTIONS`; verificado) | 0 roturas en ambas corridas, salidas idénticas. Reforzar con `PGOPTIONS='-c datestyle=SQL,DMY'` y `-c timezone=Pacific/Kiritimati`: también 0 roturas (la brecha de `DateStyle` la cierra la 0132) |
| **V4** | Las funciones de hash usan UTC | `SELECT proname, proconfig FROM pg_proc WHERE proname IN ('audit_chain_link','normative_audit_chain_link','verify_audit_chain')` | `TimeZone=UTC` **y** `DateStyle=ISO, MDY` en las tres |
| **V5** | Las filas nuevas (escritas por la API en zona Argentina) verifican | Tras una acción real que escriba auditoría (un inicio de sesión), repetir V3 **y** correr `scripts/recalcular-cadena.mjs --ultimas 50` dentro de la imagen (`npm run audit:recalcular`): recalcula en Node, con SHA-256 y su propia copia de la fórmula, el hash de las últimas 50 filas de cada empresa y de la bitácora normativa, y comprueba el enlace `prev_hash` → `hash`. Solo lee y fija su propia sesión en UTC/ISO | Código 0, `ok: true`, `rotas: 0`. (Verificar solo con `verify_audit_chain` es circular para las filas nuevas: trigger y verificador están fijados igual y podrían equivocarse juntos; el recálculo en Node no. Verificado en local sobre las últimas 50 filas de cada una de las 1 875 cadenas de `aai_test` (21 429 filas): 0 rotas) |
| **V6** | Resto de verificadores | `ledger:verify --observacional`, `/health` y logs del contenedor | Verde, sin errores |
| **V7** | **Confirmación de los bugs #3/#4/#5 en producción** — *separada del deploy* | Entre las 21:00 y las 23:59 ART: `date -u +%F` (ya es mañana) y `scripts/verificar-zona-de-negocio.mjs` en un contenedor de la imagen desplegada | Código 0 **y** `distingue: true`: `conexionCruda.currentDate` = el día de mañana (UTC) y `desdeLaAplicacion.currentDate` = el día de **hoy en Argentina**. Es la comprobación decisiva: demuestra que `CURRENT_DATE`, de lo que dependen los tres arreglos, ya es la argentina en las conexiones de la API |

**V7 está expresamente separada del deploy** (decisión del usuario, 2026-10-05).
El deploy puede hacerse entre 09:00 y 18:00 ART; V7 solo puede hacerse de noche.
Hasta que V7 dé verde, el estado oficial de los tres defectos es:

> *Corrección implementada y desplegada; pendiente de confirmación en producción
> durante la franja 21:00–24:00 ART.*

Solo después de un V7 exitoso se puede escribir:

> *Bugs #3/#4/#5 corregidos y verificados en producción.*

Esto vale para todos los documentos (`CIERRE_INTEGRAL_NEXO.md`,
`FINAL_NEXO_STATUS.md`, el Mapa Maestro, el roadmap).

## 6 · Riesgos y reversibilidad

### Escritores en otra zona (hallazgo de la implementación, P10)

La primera corrida de la suite completa con la base de pruebas en UTC dio **100
pruebas en rojo** (con la hora en Argentina pasadas las 21:00). Casi todas eran
**403 «No tenés acceso a esta empresa»**, y la causa es un riesgo real para
producción, no un problema de los tests:

- `user_company_roles.valid_from` es `DEFAULT CURRENT_DATE` (migración 0002) y la
  API exige `valid_from <= CURRENT_DATE` (`apps/api/src/http/context.ts:150`).
- Si **quien escribe la fila** está en una sesión UTC y **quien la lee** (la
  API) en hora argentina, entre las 21:00 y las 24:00 ART el rol queda con la
  fecha de mañana y la API le niega el acceso a una persona que acaba de
  recibirlo, hasta la medianoche argentina.
- Hoy el escritor normal es la propia aplicación (zona argentina), así que no
  pasa. Pasa con cualquier **escritor manual en UTC**: `psql` o un script sin la
  zona. Los scripts del repositorio quedan cubiertos por S-45; el `psql` manual,
  no.
- Los tests lo mostraron porque abren clientes `pg` crudos: se corrigió fijando
  `PGOPTIONS` en `tests/setup-env.ts`. Con eso la suite pasa con la base de
  pruebas en UTC y en Argentina, pero **P10 deja de poder detectar otras
  dependencias de la zona por defecto de la base**, porque ya ninguna sesión de
  test la usa.

**Mitigación pendiente de decisión, no implementada:** una vez aplicada la 0131 las
tres funciones de hash ya no dependen de la sesión, así que fijar además la
zona **por defecto de la base** (`ALTER DATABASE aai SET timezone`) sería seguro
para la cadena y cerraría el hueco para todo escritor manual. Se descarta
como solución principal —no está en el repositorio ni en `pg_dump -Fc`— pero sí
sirve como endurecimiento, con `desplegar.sh` comprobándolo. Requiere tu
aprobación aparte; este plan no la ejecuta.

Mientras tanto: toda sesión manual que cree o modifique filas con fechas por
defecto debe empezar con `SET timezone = 'America/Argentina/Buenos_Aires';`.


- **Rollback:** desplegar la imagen anterior. La 0131 no necesita revertirse:
  fijar la zona de una función a UTC es inocuo para el código viejo, que ya
  corría en UTC.
- **Efecto sobre datos existentes:** ninguno sobre `timestamptz` ni sobre `date`
  guardados. Las filas creadas entre las 21:00 y las 24:00 ART con
  `valid_from DEFAULT CURRENT_DATE` en UTC quedaron con la fecha de mañana: de
  ahí el horario de deploy.
- **Formato de texto de timestamps en la API:** varias rutas devuelven
  `…_at::text` (`afectaciones`, `analisis`, `arca`, `audit`, `decisions`,
  `recepciones`). Pasarán de `…+00` a `…-03`. Son valores calculados al leer,
  no guardados. Pendiente en la implementación: buscar en `tests/` y en
  `consola.html` cualquier comparación o recorte (`slice`) que dependa del
  sufijo `+00`.
- **Cambia el significado de «el día» en vistas y jobs** entre las 21:00 y las
  24:00 ART (aging, mora, cheques, flujo de fondos, cuota diaria de IA,
  pre-cierre por `received_at::date`): pasa a ser el día argentino, que es el
  que el negocio espera. El job diario (03:15 UTC = 00:15 ART) no cambia.
- **Los otros dos «hoy» fuera de la base** (`new Date()` para instantes de
  ARCA, auditoría y expiraciones) son instantes, no fechas de calendario: no se
  tocan.

## 7 · Qué necesito para empezar

1. Aprobación de este plan (o los cambios que pidas).
2. Que confirmes que el ensayo de P0–P3 se ejecuta en el servidor por vos, con
   el backup fijado arriba, y que la restauración puede usar el espacio y la
   carga de `nexo-postgres` (idealmente de madrugada).
3. Que el push de los commits lo hagas vos.

## Anexo A · Comandos exactos del ensayo en el servidor (P0–P3 y parte de P12)

**Los ejecuta el usuario, en el servidor, en `/opt/nexo`. No se ejecutaron todavía.**
Ninguno modifica la base real `aai`: todo lo que escribe va a
`aai_restauracion_tz` (el candado exige el prefijo `aai_restauracion`). Ninguno
usa `--clean`, `--create`, `DROP` ni `ALTER DATABASE` sobre la base real, y
ninguno toca `.env` ni `nexo:production`. Ninguno imprime la contraseña.

**Requisito previo:** el commit con la migración 0131 tiene que estar en el
remoto (`git push`, a cargo del usuario).

### A.0 · Variables y candados

```bash
cd /opt/nexo
set -a; . ./.env; set +a
export PGPASSWORD="$POSTGRES_PASSWORD"          # por nombre: nunca aparece en argv
BACKUP=/opt/nexo/var/backups/aai-20261005T023159Z-auto.dump
DESCARTABLE=aai_restauracion_tz
VIVA="${POSTGRES_DB:-aai}"
COMMIT=<hash del commit que contiene la 0131>   # se completa al pushear

case "$DESCARTABLE" in aai_restauracion*) ;; *) echo "nombre no permitido"; exit 1;; esac
[ "$DESCARTABLE" != "$VIVA" ] || { echo "la descartable no puede ser la viva"; exit 1; }
psqlc() { docker exec -i -e PGPASSWORD nexo-postgres psql -U "$POSTGRES_USER" -v ON_ERROR_STOP=1 -X -q "$@"; }
```

### A.1 · El backup, fijado por nombre, y la copia aislada

```bash
ls -l "$BACKUP"; sha256sum "$BACKUP" | tee /tmp/tz-backup.sha256
df -h /opt/nexo | tail -1                                          # libre >= 3x el dump
docker exec -i nexo-postgres pg_restore --list < "$BACKUP" | head -5  # solo lectura
psqlc -d postgres -At -c "SELECT count(*) FROM pg_database WHERE datname='$DESCARTABLE'"   # debe dar 0
psqlc -d postgres -c "CREATE DATABASE $DESCARTABLE"
docker exec -i -e PGPASSWORD nexo-postgres pg_restore -U "$POSTGRES_USER" -d "$DESCARTABLE" \
  --no-owner --no-password < "$BACKUP"                             # SIN --clean y SIN --create
sha256sum "$BACKUP" | diff - /tmp/tz-backup.sha256 && echo "backup intacto"
```

### A.2 · P0 y P0b — la copia es completa y la prueba tiene potencia

```bash
MAXSEQ=$(psqlc -d "$DESCARTABLE" -At -c "SELECT coalesce(max(seq),0) FROM audit_logs")
echo "copia:"; psqlc -d "$DESCARTABLE" -At -c "SELECT (SELECT count(*) FROM schema_migrations),
  (SELECT count(*) FROM companies), (SELECT count(*) FROM audit_logs), (SELECT count(*) FROM journal_entries)"
echo "viva (solo lectura; audit_logs acotada al máximo de la copia):"
psqlc -d "$VIVA" -At -c "SELECT (SELECT count(*) FROM schema_migrations),
  (SELECT count(*) FROM companies), (SELECT count(*) FROM audit_logs WHERE seq <= $MAXSEQ),
  (SELECT count(*) FROM journal_entries)"
```

- **P0 aprueba si:** `schema_migrations` es igual (130) y `audit_logs` coincide
  exacto; `companies` y `journal_entries` de la copia son ≤ a los de la viva y
  la diferencia se explica por actividad posterior a las 02:31 UTC.
- **P0b:** la copia tiene > 0 filas de `audit_logs`. Si da 0, P1/P2 no prueban
  nada y vale P5 (sintética) como sustituto.

### A.3 · P1 y P2 — la cadena, antes de la 0131, bajo cada zona

```bash
verificar() {   # $1 = zona, $2 = base
psqlc -d "$2" -At <<SQL
SET timezone = '$1';
SELECT c.id, (SELECT count(*) FROM audit_logs a WHERE a.company_id = c.id) AS filas,
       (SELECT count(*) FROM verify_audit_chain(c.id)) AS roturas
  FROM companies c ORDER BY c.id;
SQL
}
verificar UTC                             "$DESCARTABLE" | tee /tmp/tz-p1.txt   # P1
verificar America/Argentina/Buenos_Aires  "$DESCARTABLE" | tee /tmp/tz-p2.txt   # P2
```

- **P1 aprueba si** todas las empresas dan `roturas = 0`. Con cualquier rotura:
  **se corta todo** — producción ya tendría la cadena inconsistente.
- **P2 aprueba si** toda empresa con `filas > 0` da `roturas > 0` (control negativo:
  confirma que el cambio ingenuo de zona rompía la cadena y que la prueba lo ve).

### A.4 · P3 — la migración 0131 sobre la copia

```bash
git fetch origin                                   # no toca el árbol de trabajo
rm -rf /tmp/nexo-ensayo-tz && mkdir /tmp/nexo-ensayo-tz
git archive "$COMMIT" | tar -x -C /tmp/nexo-ensayo-tz
docker build -t nexo:ensayo-tz /tmp/nexo-ensayo-tz # no cambia la etiqueta nexo:production

PGUSER="$POSTGRES_USER" PGDB="$DESCARTABLE" PGHOST=nexo-postgres \
docker run --rm --network nexo -e PGPASSWORD -e PGUSER -e PGDB -e PGHOST --entrypoint sh nexo:ensayo-tz \
  -c 'CLAVE=$(node -e "process.stdout.write(encodeURIComponent(process.env.PGPASSWORD))"); DATABASE_URL="postgresql://${PGUSER}:${CLAVE}@${PGHOST}:5432/${PGDB}" node scripts/migrate.mjs up'

psqlc -d "$DESCARTABLE" -At -c "SELECT count(*) FROM schema_migrations"          # 131 con el commit e1b9007; 132 con la 0132
verificar UTC                            "$DESCARTABLE" > /tmp/tz-p3-utc.txt
verificar America/Argentina/Buenos_Aires "$DESCARTABLE" > /tmp/tz-p3-ar.txt
diff /tmp/tz-p3-utc.txt /tmp/tz-p3-ar.txt && echo "idénticas"
awk -F'|' '$3 != 0' /tmp/tz-p3-utc.txt /tmp/tz-p3-ar.txt | wc -l                  # 0
psqlc -d "$DESCARTABLE" -At -c "SELECT proname, coalesce(array_to_string(proconfig, ','), '')
  FROM pg_proc WHERE proname IN ('audit_chain_link','normative_audit_chain_link','verify_audit_chain') ORDER BY 1"
```

- **P3 aprueba si:** `schema_migrations` = 131 (o 132 con la 0132); `diff` sin
  diferencias; 0 filas con roturas en ambas zonas; las tres funciones muestran
  `TimeZone=UTC` (y `DateStyle=ISO, MDY` desde la 0132).

### A.4b · Llevar la copia a la 0132 y comprobar las 24 sesiones — **PENDIENTE (no ejecutado)**

> **Estado:** no se ejecutó. Requiere acceso al servidor (`docker`, `nexo-postgres`),
> que esta auditoría no tiene, y **no se simuló**. Todo lo de abajo es el
> procedimiento exacto que hay que correr, con su criterio de aprobación. Las
> pruebas locales equivalentes (P4b, P5, P4c) son evidencia sobre `aai_test`, no
> reemplazan este ensayo sobre la copia del backup real.

La P3 que ya se ejecutó aplicó solo la 0131 (131 migraciones). Cuando la 0132
esté en el remoto, **sobre la misma copia** `aai_restauracion_tz` (sin tocar `aai`):

**A.4b.1 · Estado previo y huella del historial (solo lectura).** Se anota antes de
migrar para poder demostrar después que **ninguna fila histórica cambió**.

```bash
huella() {   # $1 = base. Una línea por bitácora: tabla|filas|md5 de (id:hash) en orden de seq
psqlc -d "$1" -At <<'SQL'
SELECT 'audit_logs', count(*), coalesce(md5(string_agg(id::text || ':' || hash, ',' ORDER BY seq)), '-') FROM audit_logs
UNION ALL
SELECT 'normative_audit_logs', count(*), coalesce(md5(string_agg(id::text || ':' || hash, ',' ORDER BY seq)), '-') FROM normative_audit_logs;
SQL
}
psqlc -d "$DESCARTABLE" -At -c "SELECT count(*) FROM schema_migrations"          # 131: la 0131 está aplicada y la 0132 no
psqlc -d "$DESCARTABLE" -At -c "SELECT proname, coalesce(array_to_string(proconfig, ','), '')
  FROM pg_proc WHERE proname IN ('audit_chain_link','normative_audit_chain_link','verify_audit_chain') ORDER BY 1"
                                                                                  # solo TimeZone=UTC (sin DateStyle todavía)
huella "$DESCARTABLE" | tee /tmp/tz-huella-antes.txt
```

**A.4b.2 · Control negativo previo a la 0132 (se espera ROTURA).** Con solo la 0131, un
estilo no ISO tiene que dar roturas: confirma que la prueba tiene potencia.

```bash
verificar_estilo() {   # $1 = zona, $2 = DateStyle, $3 = base
psqlc -d "$3" -At <<SQL
SET timezone = '$1';
SET datestyle = '$2';
SELECT c.id, (SELECT count(*) FROM audit_logs a WHERE a.company_id = c.id) AS filas,
       (SELECT count(*) FROM verify_audit_chain(c.id)) AS roturas
  FROM companies c ORDER BY c.id;
SQL
}
verificar_estilo UTC 'SQL, DMY' "$DESCARTABLE" | awk -F'|' '$2 > 0 && $3 == 0' | wc -l   # 0: toda empresa con filas rompe
```

**A.4b.3 · Aplicar la 0132 sobre la copia.** Repetir el `git fetch`, el `git archive` y el
`docker build` de A.4 con el nuevo `$COMMIT` y correr de nuevo el `migrate up`
(aplica solo la pendiente).

**A.4b.4 · Después.**

```bash
psqlc -d "$DESCARTABLE" -At -c "SELECT count(*) FROM schema_migrations"   # 132
psqlc -d "$DESCARTABLE" -At -c "SELECT proname, coalesce(array_to_string(proconfig, ','), '')
  FROM pg_proc WHERE proname IN ('audit_chain_link','normative_audit_chain_link','verify_audit_chain') ORDER BY 1"
                                                                           # las tres: TimeZone=UTC y DateStyle=ISO, MDY
huella "$DESCARTABLE" | tee /tmp/tz-huella-despues.txt
diff /tmp/tz-huella-antes.txt /tmp/tz-huella-despues.txt && echo "HISTORIAL SIN CAMBIOS"

for ESTILO in 'ISO, MDY' 'ISO, DMY' 'SQL, MDY' 'SQL, DMY' 'Postgres, MDY' 'German, DMY'; do
  for ZONA in UTC America/Argentina/Buenos_Aires Asia/Kolkata Pacific/Kiritimati; do
    verificar_estilo "$ZONA" "$ESTILO" "$DESCARTABLE"
  done
done | sort | uniq -c
corrido "scripts/recalcular-cadena.mjs --ultimas 100000"                    # (`corrido` se define en A.5) recálculo en Node, independiente de las funciones
```

**Aprueba si, y solo si, se cumplen las seis:**

1. `schema_migrations` pasó de 131 a 132 y las tres funciones muestran `TimeZone=UTC` **y** `DateStyle=ISO, MDY`.
2. `diff` de las huellas sin diferencias (`HISTORIAL SIN CAMBIOS`): mismas filas, mismos hashes, mismo orden, en las dos bitácoras.
3. La matriz imprime, **por cada empresa, una sola línea** con el contador 24
   (`24 <id>|<filas>|0`): las 24 combinaciones de zona y estilo dan 0 roturas y el mismo resultado.
   Una línea con un contador menor, o con roturas distintas de 0, es un fallo.
4. El control negativo de A.4b.2 dio 0 (sin la 0132 un estilo SQL rompía todas las empresas con filas).
5. `recalcular-cadena.mjs` termina con código 0 (`ok: true`, `rotas: 0`) **sobre todas las filas**.
6. `audit_logs` de la copia tiene > 0 filas (P0b); si da 0, nada de lo anterior prueba algo.

Con cualquier otro resultado: **se corta**, no se despliega, y la copia queda para análisis.

### A.5 · P12 (parte servidor) — verificadores sobre la copia

```bash
# La URL se arma DENTRO del contenedor, con la clave codificada: no pasa por argv.
URL_ENS='CLAVE=$(node -e "process.stdout.write(encodeURIComponent(process.env.PGPASSWORD))"); export DATABASE_URL="postgresql://${PGUSER}:${CLAVE}@${PGHOST}:5432/${PGDB}";'
corrido() {   # $1 = script y argumentos
  PGUSER="$POSTGRES_USER" PGDB="$DESCARTABLE" PGHOST=nexo-postgres   docker run --rm --network nexo -e PGPASSWORD -e PGUSER -e PGDB -e PGHOST --entrypoint sh nexo:ensayo-tz     -c "$URL_ENS node $1"
}
corrido "scripts/verify-ledger.mjs --observacional"
corrido "scripts/verify-audit-chain.mjs --observacional"
corrido "scripts/check-structure.mjs"
corrido "scripts/check-invariants.mjs --observacional"
```

Aprueba si los cuatro terminan con código 0. `NO EJERCITADO` solo es aceptable
si P0b dio 0 filas. (`check-structure` incluye el control nuevo de las tres
funciones con `TimeZone=UTC` y `DateStyle=ISO, MDY`.)

### A.6 · Limpieza (solo con P0–P3 y P12 aprobados)

```bash
case "$DESCARTABLE" in aai_restauracion*) psqlc -d postgres -c "DROP DATABASE $DESCARTABLE";; esac
docker rmi nexo:ensayo-tz; rm -rf /tmp/nexo-ensayo-tz
```

No se borra ningún backup.

## Anexo B · V2 y V7 — verificación interna de la zona

Dentro de un contenedor de la imagen **ya desplegada** (solo lectura; no imprime la
conexión):

```bash
PGUSER="$POSTGRES_USER" PGDB="${POSTGRES_DB:-aai}" PGHOST=nexo-postgres \
docker run --rm --network nexo -e PGPASSWORD -e PGUSER -e PGDB -e PGHOST --entrypoint sh nexo:production \
  -c 'CLAVE=$(node -e "process.stdout.write(encodeURIComponent(process.env.PGPASSWORD))"); DATABASE_URL="postgresql://${PGUSER}:${CLAVE}@${PGHOST}:5432/${PGDB}" node scripts/verificar-zona-de-negocio.mjs'
date -u +%F
```

- **V2 (de día, tras el deploy):** código 0, `desdeLaAplicacion.zona` =
  `America/Argentina/Buenos_Aires`, `conexionCruda.zona` = `UTC`.
- **V7 (de noche, 21:00–24:00 ART):** además `hoyEnUtc` es el día **siguiente** a
  `desdeLaAplicacion.currentDate` (el mismo de `date -u +%F`) y `fechaOk` es `true`: es la
  única parte que depende del reloj real. `distingue` ya no la prueba: sale de 14 instantes
  fijos y da lo mismo a cualquier hora.

Evidencia local del mismo mecanismo (2026-10-05, 22:49 ART, base de pruebas en
UTC): aplicación `2026-10-05`, conexión cruda `2026-10-06`.


## Actualización del 2026-10-07 — auditoría integral

Informe completo, con severidades, matriz V1–V7 y clasificaciones:
`docs/AUDITORIA_ZONA_HORARIA.md`. Lo que cambió respecto del plan original, y que
**está sin commitear**:

| Cambio | Por qué |
|---|---|
| **Migración 0132** (`SET datestyle = 'ISO, MDY'` en las tres funciones) | `occurred_at::text` depende también de `DateStyle`: con SQL/Postgres/German el hash cambia. Medido: 10 zonas × 6 estilos de fecha (60 sesiones) escribiendo y verificando, para la cadena por empresa y la normativa, con recálculo independiente en SQL plano desde la sesión canónica; un estilo no ISO rompe la cadena antes de la 0132 |
| `scripts/recalcular-cadena.mjs` (+ `scripts/lib/cadena.mjs`, `npm run audit:recalcular`) | El paso V5 pedía un recálculo «fuera de las funciones» que solo existía como texto. Ahora es un script de solo lectura con test propio y control negativo (campo alterado, hash alterado, enlace roto). Al escribirlo apareció un defecto propio (`ORDER BY seq` tomaba el alias de texto): lo detectó la corrida contra `aai_test` |
| `prepararAltaDeEjercicio` y 3 fechas «hoy» en `consola.html` | La consola calculaba «hoy» en UTC: fecha por defecto de un asiento, período «actual» y normativa «vigente hoy» mostraban mañana de 21:00 a 24:00; y el ejercicio propuesto saltaba al año siguiente **todo el día del cierre**. `diaDeUnInstante` / `momentoDeUnInstante` ya no convierten dos veces una fecha `AAAA-MM-DD` |
| Seis campos `timestamptz` de la consola | Se recortaban en UTC (`slice(0, 10)`): un evento de las 22:00 ART aparecía con el día siguiente. Ahora `diaDeUnInstante` / `momentoDeUnInstante` |
| `asientosTardios` (motor de auditoría) | Contaba días contra la medianoche UTC: el borde de los 60 días se corría hasta un día para cargas de 21:00 a 24:00 ART. Ahora con casos de borde para 59/60/61 días, año nuevo, bisiesto, otros plazos de gracia y el texto de PostgreSQL con otros desfases |
| Año de referencia del parser de fechas (`fecha.ts`) | Ya estaba corregido, pero ningún test dinámico lo cubría: la mutación a `getUTCFullYear()` pasaba. Ahora hay un test con reloj fijo en el 31/12 entre las 21:00 y las 24:00 ART |
| Dos mensajes con un instante como día (`arca.ts`, `secrets/proveedor.ts`) | Mostraban la fecha UTC del vencimiento |
| `/audit`: `cargado_el` | Entrega ISO inequívoco en UTC en vez del texto de la sesión (campo interno: no sale en la respuesta). Test P8: idéntico desde 60 sesiones |
| `fixtures-invariantes.mjs` con zona | Crea empresas y roles por un cliente crudo (`valid_from DEFAULT CURRENT_DATE`) |
| S-37 reescrito, S-45 reforzado, S-46 nuevo, test P7 corregido | S-37 dejaba pasar 7 de 9 variantes (y ahora también sigue una variable que guarda el ISO, `toJSON`, `.replace('T', …)` y `getTimezoneOffset`); la excepción de archivo para `calendar-date.ts` pasó a una anotación en su única línea y cada anotación `s37-permite` se comprueba que tape algo real. S-45 aceptaba un `import` sin uso y ahora rechaza una zona equivocada, el helper pisado por otra `options` y una segunda conexión sin zona; P7 daba falso PASS por `PGOPTIONS` y ahora prueba también el reciclaje de conexiones |
| `verificar-zona-de-negocio.mjs` determinístico | La corrida de las 00:44 ART dio `distingue=false`: dependía del reloj. Ahora convierte 14 instantes fijos, y `fechaOk` acepta el día de antes y el de después de la consulta (no falla justo en la medianoche argentina) |

Pasos nuevos para llevar esto a producción (**no se hicieron**): commit y push de
estos cambios; **A.4b sobre la copia, que sigue PENDIENTE** (necesita el servidor y la
0132 en el remoto); recién entonces el deploy, de día, y V7 de noche.
