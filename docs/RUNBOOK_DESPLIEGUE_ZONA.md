# Runbook — despliegue de la corrección de zona horaria

Procedimiento para ejecutar **en el VPS** (`/opt/nexo`), de a un paso por vez. Versión 2 (2026-10-15): usa el
`scripts/desplegar.sh` endurecido (copia verificada, corte ante errores, imagen anterior conservada, `--revertir`).
Es la secuencia A1–A3, despliegue, V1–V7 de `docs/AUDITORIA_ZONA_HORARIA.md` y `docs/PLAN_ZONA_HORARIA.md`.
**Cada paso dice cuándo parar.** Si algo no da lo esperado: se detiene todo y se consulta; no se sigue "a ver qué pasa".

> **Corrección del 2026-10-15, tras la auditoría de solo lectura del servidor** (`docs/AUDITORIA_PREVIA_VPS_2026-10-15.md`): en el VPS hay **una sola** imagen `nexo:*` (`nexo:production`). **No existen** `nexo:rollback-pre-tz-20261009` ni `nexo:ensayo-tz`, que una versión anterior de este runbook daba por existentes. A1 y A2 y la reversión están ajustados a eso.

`<COMMIT>` es el commit que incluye la corrección de zona horaria **y** los guiones endurecidos. Se completa cuando el
commit esté publicado; hasta entonces este documento es un borrador. **El despliegue lo autoriza el responsable, por escrito,
después de revisar el diff, las pruebas y este procedimiento.** Horario: 09:00–18:00 ART. V7 va de noche.

> **No editar `/opt/nexo/.env`.** El error de sintaxis de `EMAIL_FROM` ya no afecta a los guiones: leen solo las variables
> que necesitan, como texto. Poner comillas rompería el remitente de los correos que mandan los timers (`docker run --env-file`
> no procesa comillas).

## 0 · Preparación de la sesión (una vez)

```bash
cd /opt/nexo
export PGUSER="$(docker exec nexo-postgres printenv POSTGRES_USER)"
export PGPASSWORD="$(docker exec nexo-postgres printenv POSTGRES_PASSWORD)"   # no se imprime
export PGHOST=nexo-postgres
psqlc() { docker exec -i -e PGPASSWORD nexo-postgres psql -U "$PGUSER" -v ON_ERROR_STOP=1 -X -q -At "$@"; }

# Corre un script de la imagen $IMG contra la base $1 (la URL se arma DENTRO del contenedor).
#   uso: IMG=nexo:ensayo-tz corrido <base> scripts/recalcular-cadena.mjs --ultimas 100000
corrido() { local base="$1"; shift
  PGDB="$base" docker run --rm --network nexo -e PGPASSWORD -e PGUSER -e PGDB -e PGHOST \
    --entrypoint sh "$IMG" -c 'CLAVE=$(node -e "process.stdout.write(encodeURIComponent(process.env.PGPASSWORD))"); export DATABASE_URL="postgresql://${PGUSER}:${CLAVE}@${PGHOST}:5432/${PGDB}"; exec node "$@"' sh "$@"; }

# Aplica las migraciones pendientes a la base $1 con la imagen $IMG. SOLO para el ensayo (A2): en producción las aplica
# `desplegar.sh`, con el mismo comando.
migrar_ensayo() { local base="$1"
  case "$base" in aai_restauracion_*) ;; *) echo "base no permitida para el ensayo: $base"; return 1;; esac
  [ "$(psqlc -d "$base" -c 'SELECT current_database()')" = "$base" ] || { echo "la conexión no llega a $base"; return 1; }
  echo "destino=$base imagen=$IMG · antes: $(psqlc -d "$base" -c 'SELECT count(*) FROM schema_migrations') migraciones"
  PGDB="$base" docker run --rm --network nexo -e PGPASSWORD -e PGUSER -e PGDB -e PGHOST \
    --entrypoint sh "$IMG" -c 'CLAVE=$(node -e "process.stdout.write(encodeURIComponent(process.env.PGPASSWORD))"); DATABASE_URL="postgresql://${PGUSER}:${CLAVE}@${PGHOST}:5432/${PGDB}" node scripts/migrate.mjs up'
  echo "después: $(psqlc -d "$base" -c 'SELECT count(*) FROM schema_migrations') migraciones"; }

verificar_migracion() { local base="$1"   # lo que tiene que haber después de la 0131 y la 0132
  psqlc -d "$base" -c "SELECT name, checksum FROM schema_migrations WHERE name LIKE '013%' ORDER BY name"
  psqlc -d "$base" -c "SELECT proname, array_to_string(proconfig, ',') FROM pg_proc WHERE proname IN ('audit_chain_link','normative_audit_chain_link','verify_audit_chain') ORDER BY 1"; }
```

## A1 · Identidad (solo lectura) — parar si algo no coincide

```bash
git status --porcelain=v1          # solo puede aparecer el archivo no versionado docker-compose.prod.yml.bak.*
git rev-parse --short HEAD         # hoy: e1b9007
docker inspect nexo-app --format 'imagen={{.Image}} salud={{.State.Health.Status}}'
docker image inspect nexo:production --format '{{index .RepoTags 0}} {{.Id}}'   # única imagen nexo:* hoy; NO hay imagen anterior
docker exec nexo-app sh -c 'cd /app && sha256sum packages/db/src/tenancy.ts packages/shared/src/calendar-date.ts apps/web/consola.html'
docker exec nexo-app node -e "fetch('http://127.0.0.1:3001/health/db').then(r=>r.text()).then(console.log)"
df -h /opt/nexo | tail -1
bash infrastructure/systemd/estado-de-tareas.sh
```

**Pasa si:** el ID de `nexo:production` es el mismo que `nexo-app` está usando y coincide con el medido el 2026-10-15 (`sha256:efe7920a4e49ec53239ead645340cf370464fa857b310b83a2c18f90df29bb82`, `BUILD_ID` `b412b9e`); los hashes empiezan con `31caa715…` (`tenancy.ts`), `c693aa1d…`
(`calendar-date.ts`), `57cfb75b…` (`consola.html`), que son los de `b412b9e`; `/health/db` dice `migrations` = 130; hay espacio
libre (≥ 2 GiB); las tareas diarias figuran con última corrida exitosa.

## A2 · Ensayo del ejecutor oficial en la copia de hoy — parar si falla

La base `aai_restauracion_predeploy_20261009` tiene las 130 migraciones de producción. Es la primera vez que `migrate.mjs up`
aplica estas dos migraciones a una copia real, con el mismo comando que usará `desplegar.sh`.

```bash
# PRERREQUISITO: la imagen `nexo:ensayo-tz` NO existe hoy en el servidor (auditoría del 2026-10-15). Hay que construirla desde <COMMIT>
# (`docker build -t nexo:ensayo-tz .`): es una escritura (una imagen), que forma parte de lo que autoriza el responsable. No se hizo.
export IMG=nexo:ensayo-tz
migrar_ensayo aai_restauracion_predeploy_20261009
verificar_migracion aai_restauracion_predeploy_20261009
corrido aai_restauracion_predeploy_20261009 scripts/recalcular-cadena.mjs --ultimas 100000
```

**Pasa si:** pasó de 130 a **132**; los checksums de `0131…` y `0132…` son
`67534b7e3b0d6ffeef78c21a79ba6d7514e2e99206bcd8cd40ec4bfab66eed99` y
`fd1546d9b9eba6e5784d16f2a9d486ea5222266dac318795bfb22168dcdfd5ff`; las tres funciones muestran
`TimeZone=UTC,DateStyle=ISO, MDY`; el recálculo termina con `"ok": true` y `"rotas": 0`.

## A3 · Traer el código al servidor (no cambia producción) — parar si no queda exacto

El `desplegar.sh` endurecido llega con el propio commit. Mientras el servidor esté en `e1b9007`, **se usa el guion viejo**
solo hasta este paso. Avanzar el árbol no cambia lo que está sirviendo:

```bash
git fetch origin
git merge --ff-only <COMMIT>
git rev-parse HEAD                 # tiene que ser <COMMIT>
git status --porcelain=v1          # sin archivos versionados modificados
```

## Despliegue (09:00–18:00 ART) — solo con autorización específica

```bash
bash scripts/desplegar.sh --auditar --commit <COMMIT>      # 1 · solo informa: tiene que decir que el servidor ya está en <COMMIT>
bash scripts/desplegar.sh --commit <COMMIT> 2>&1 | tee /tmp/desplegar-$(date +%Y%m%d-%H%M).log
```

El guion: etiqueta la imagen que sirve (`nexo:previo-<fecha>`) → construye → inspecciona la imagen → **hace la copia de
resguardo `predeploy-<commit>` y la prueba restaurándola** → migra desde la imagen → levanta → verifica. Se detiene ante
cualquier `✘` y dice en qué estado queda producción. Termina con `fallos: 0`. Deja el registro en
`/opt/nexo/var/despliegues/ultimo.env`.

### Reversión

```bash
bash scripts/desplegar.sh --revertir
```

Vuelve la imagen anterior a `nexo:production` y levanta la versión anterior. **No toca la base** (las migraciones no se
revierten: la aplicación anterior es compatible con el esquema nuevo). Si hiciera falta volver también los datos: la copia
`predeploy-<commit>.dump` y su `.sha256` (ver `docs/DESPLIEGUE.md` §7.5). **No hay un segundo respaldo por etiqueta:** el 2026-10-15 la auditoría comprobó que `nexo:rollback-pre-tz-20261009` ya no
existe. El único camino de vuelta sin reconstruir es la etiqueta `nexo:previo-<fecha>` que crea el guion antes de construir;
si se perdiera, habría que reconstruir `b412b9e`.

## Verificaciones posteriores (inmediatamente después)

```bash
export IMG=nexo:production
docker exec nexo-app node -e "fetch('http://127.0.0.1:3001/health/db').then(r=>r.text()).then(console.log)"   # V1
corrido aai scripts/verificar-zona-de-negocio.mjs ; echo "CODIGO=$?"                                           # V2
verificar_migracion aai                                                                                         # V4
```

- **V1:** `version` = el commit desplegado y `migrations` = 132.
- **V2:** `CODIGO=0`; `desdeLaAplicacion.zona` = `America/Argentina/Buenos_Aires`; `conexionCruda.zona` = `UTC`; `zonaOk`,
  `matrizOk`, `fechaOk`, `distingue` = `true`.
- **V4:** las tres funciones con `TimeZone=UTC` y `DateStyle=ISO, MDY`.

**V3 y V5** (hacer **después** de iniciar sesión en la consola, que escribe una fila de auditoría):

```bash
corrido aai scripts/verify-audit-chain.mjs --observacional
corrido aai scripts/recalcular-cadena.mjs --ultimas 50
```

Pasa si no hay roturas y la salida **nombra a la empresa y sus entradas**. Un "Nada que verificar" no es un pase: significa que
el script no llegó a la base.

**V6:** `corrido aai scripts/verify-ledger.mjs --observacional` (escribe en `ledger_verifications`, igual que la tarea diaria) y
revisar `/health` y el log del contenedor.

## V7 — entre las 21:00 y las 24:00 ART

La única comprobación que depende del reloj real. Es lo que permite decir "bugs #3/#4/#5 corregidos y verificados en producción".

```bash
date -u +%F ; TZ=America/Argentina/Buenos_Aires date +%F
export IMG=nexo:production
corrido aai scripts/verificar-zona-de-negocio.mjs ; echo "CODIGO=$?"
```

**Pasa si:** `CODIGO=0`, la fecha UTC es **un día posterior** a la argentina, `hoyEnUtc` (en el informe) es esa fecha posterior y
`desdeLaAplicacion.currentDate` es la de hoy en Argentina. Hasta que esto pase, el estado oficial es *«Corrección implementada y
desplegada; pendiente de confirmación en producción durante la franja 21:00–24:00 ART.»*

## Después

Pegar las salidas de cada bloque en el chat para que se documenten V1–V7 en `docs/AUDITORIA_ZONA_HORARIA.md` (no se escribe
nada en la documentación por adelantado).
