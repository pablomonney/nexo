#!/usr/bin/env bash
# ============================================================================
# NEXO — auditoría previa de SOLO LECTURA del servidor
# ============================================================================
#
#   ssh -i ~/.ssh/id_nexo_claude root@<servidor> 'bash -s' < scripts/auditar-servidor.sh > auditoria.txt
#
# Se manda por la entrada estándar: **no copia nada al servidor**.
#
# ## Qué garantiza
#
# Lee y no escribe. No construye, no etiqueta, no corre contenedores nuevos, no hace `git fetch` ni `git merge`,
# no toca `systemd`, no crea archivos ni copias. Las únicas consultas a la base son `SELECT` y `SHOW`. Una prueba
# estática (`tests/unit/auditar-servidor.test.ts`) vuelve a leer ESTE archivo y falla si aparece un verbo que escribe.
#
# ## Qué no imprime
#
# Nunca el contenido de `.env`: de cada variable sensible dice «presente/vacía»; de las que no lo son (proveedores,
# entorno) dice el valor. Nunca contraseñas, claves ni tokens. Si la URL del remoto de Git trae credenciales, las oculta.
#
# ## Qué deja afuera a propósito
#
# **No hace la copia de resguardo**: eso escribe en el disco del servidor y es parte del despliegue, que requiere
# autorización específica. Acá se informa el estado de las copias que YA existen.

set -uo pipefail

RAIZ="${NEXO_RAIZ:-/opt/nexo}"
ENV_FILE="$RAIZ/.env"
COPIAS="${NEXO_BACKUP_DIR:-$RAIZ/var/backups}"
CONTENEDOR_APP="nexo-app"
CONTENEDOR_DB="nexo-postgres"
DOMINIO="${NEXO_DOMINIO:-nexointelligence.com.ar}"

titulo() { printf '\n== %s ==\n' "$*"; }
dato()   { printf '  %-34s %s\n' "$1" "$2"; }

# La salida de un comando, o «(no disponible)». Nunca falla.
salida() { local s; s=$("$@" 2>/dev/null) && [[ -n "$s" ]] && printf '%s' "$s" || printf '(no disponible)'; }

leer_env() {
  local linea valor
  linea=$(grep -m1 -E "^[[:space:]]*(export[[:space:]]+)?$1=" "$ENV_FILE" 2>/dev/null) || return 0
  valor="${linea#*=}"; valor="${valor%$'\r'}"
  if [[ "$valor" =~ ^\"(.*)\"$ ]] || [[ "$valor" =~ ^\'(.*)\'$ ]]; then valor="${BASH_REMATCH[1]}"; fi
  printf '%s' "$valor"
}

printf 'AUDITORÍA DE SOLO LECTURA — %s UTC\n' "$(date -u +%Y-%m-%dT%H:%M:%S)"

titulo "1 · El servidor"
dato "nombre"            "$(hostname)"
dato "kernel"            "$(uname -sr)"
dato "hora (UTC)"        "$(date -u +%Y-%m-%dT%H:%M:%SZ)"
dato "zona del sistema"  "$(salida timedatectl show -p Timezone --value)"
dato "encendido hace"    "$(salida uptime -p)"
dato "carga"             "$(cut -d' ' -f1-3 /proc/loadavg)"
dato "memoria libre"     "$(free -m | awk '/^Mem:/{printf "%s MiB de %s MiB", $7, $2}')"
printf '  discos:\n'
df -Pk -x tmpfs -x devtmpfs -x overlay 2>/dev/null | awk 'NR>1{printf "    %-28s %6.1f GiB libres de %6.1f GiB (%s usado)\n", $6, $4/1048576, $2/1048576, $5}'

titulo "2 · Docker"
dato "docker"            "$(salida docker --version)"
printf '  contenedores:\n'
docker ps --format '{{.Names}}  imagen={{.Image}}  estado={{.Status}}' 2>/dev/null | sed 's/^/    /'
printf '  imágenes de NEXO (para volver atrás):\n'
docker images --format '{{.Repository}}:{{.Tag}}  id={{.ID}}  creada={{.CreatedAt}}  tamaño={{.Size}}' 2>/dev/null | grep -E '^nexo:' | sed 's/^/    /' | head -20
[[ -z "$(docker images --format '{{.Repository}}:{{.Tag}}' 2>/dev/null | grep -E '^nexo:(previo|rollback)')" ]] && printf '    (NO hay ninguna imagen anterior etiquetada: hoy no habría a qué volver sin reconstruir)
'
dato "app: imagen en servicio"    "$(salida docker inspect "$CONTENEDOR_APP" --format '{{.Image}}')"
dato "app: versión (BUILD_ID)"    "$(docker inspect "$CONTENEDOR_APP" --format '{{range .Config.Env}}{{println .}}{{end}}' 2>/dev/null | grep -m1 '^BUILD_ID=' | cut -d= -f2)"
dato "app: salud"                 "$(salida docker inspect "$CONTENEDOR_APP" --format '{{if .State.Health}}{{.State.Health.Status}}{{else}}sin healthcheck{{end}}')"
dato "app: reinicio"              "$(salida docker inspect "$CONTENEDOR_APP" --format '{{.HostConfig.RestartPolicy.Name}}')"
dato "app: sólo lectura"          "$(salida docker inspect "$CONTENEDOR_APP" --format '{{.HostConfig.ReadonlyRootfs}}')"
dato "app: puertos publicados"    "$(salida docker inspect "$CONTENEDOR_APP" --format '{{json .NetworkSettings.Ports}}')"
dato "db: salud"                  "$(salida docker inspect "$CONTENEDOR_DB" --format '{{if .State.Health}}{{.State.Health.Status}}{{else}}sin healthcheck{{end}}')"
dato "db: puertos publicados"     "$(salida docker inspect "$CONTENEDOR_DB" --format '{{json .NetworkSettings.Ports}}')"
dato "db: volúmenes"              "$(salida docker inspect "$CONTENEDOR_DB" --format '{{range .Mounts}}{{.Name}}:{{.Destination}} {{end}}')"

titulo "3 · El código en el servidor"
if cd "$RAIZ" 2>/dev/null && [[ -d .git ]]; then
  dato "rama"                  "$(git rev-parse --abbrev-ref HEAD)"
  dato "HEAD"                  "$(git rev-parse HEAD)"
  dato "último commit"         "$(git log -1 --format='%ad · %s' --date=short)"
  dato "origin/main (local)"   "$(salida git rev-parse origin/main) — referencia local, sin consultar al remoto"
  dato "remoto (sin credencial)" "$(git remote get-url origin 2>/dev/null | sed -E 's#//[^/@]+@#//<oculto>@#')"
  printf '  archivos VERSIONADOS modificados en el servidor:\n'
  git status --porcelain --untracked-files=no | sed 's/^/    /'
  [[ -z "$(git status --porcelain --untracked-files=no)" ]] && printf '    (ninguno)\n'
  dato "archivos sin versionar" "$(git status --porcelain --untracked-files=normal | grep -c '^??')"
  git status --porcelain --untracked-files=normal | grep '^??' | head -10 | sed 's/^/    /'
  dato "migraciones en disco"  "$(ls infrastructure/db/migrations/*.sql 2>/dev/null | wc -l)"
else
  dato "repositorio" "no existe $RAIZ o no es un repositorio"
fi

titulo "4 · Configuración (.env: SIN valores secretos)"
if [[ -f "$ENV_FILE" ]]; then
  dato "permisos / dueño"      "$(stat -c '%a %U:%G' "$ENV_FILE")"
  for k in NODE_ENV PAYMENTS_PROVIDER EMAIL_PROVIDER AI_PROVIDER ARCA_ENV ARCA_AMBIENTE TRUST_PROXY; do
    v="$(leer_env "$k")"; [[ -n "$v" ]] && dato "$k" "$v"
  done
  for k in POSTGRES_PASSWORD DATABASE_URL JWT_SECRET SESSION_SECRET EMAIL_API_KEY MP_ACCESS_TOKEN MERCADOPAGO_ACCESS_TOKEN MP_WEBHOOK_SECRET MASTER_KEY ARCA_KEK; do
    if grep -qE "^[[:space:]]*(export[[:space:]]+)?$k=" "$ENV_FILE" 2>/dev/null; then
      [[ -n "$(leer_env "$k")" ]] && dato "$k" "presente" || dato "$k" "declarada pero VACÍA"
    fi
  done
  # El defecto conocido: un valor con espacios sin comillas rompe `. .env` en bash.
  malas=$(grep -nE '^[[:space:]]*[A-Z_]+=[^"'"'"'#]*[[:space:]][^"'"'"'#]*$' "$ENV_FILE" 2>/dev/null | cut -d: -f1 | tr '\n' ' ')
  dato "líneas con espacios sin comillas" "${malas:-(ninguna)} (número de línea)"
else
  dato ".env" "no existe"
fi

titulo "5 · Base de datos (sólo SELECT y SHOW)"
DB="$(leer_env POSTGRES_DB)"; DB="${DB:-aai}"
ADMIN="$(leer_env POSTGRES_USER)"; ADMIN="${ADMIN:-nexo_admin}"
PGPASSWORD="$(leer_env POSTGRES_PASSWORD)"; export PGPASSWORD
consulta() { docker exec -e PGPASSWORD "$CONTENEDOR_DB" psql -U "$ADMIN" -d "$DB" -tAc "$1" 2>/dev/null; }
if [[ "$(consulta 'SELECT 1')" == "1" ]]; then
  dato "base"                    "$DB"
  dato "versión de PostgreSQL"   "$(consulta 'SHOW server_version')"
  dato "migraciones aplicadas"   "$(consulta 'SELECT count(*) FROM schema_migrations')"
  dato "última migración"        "$(consulta 'SELECT name FROM schema_migrations ORDER BY name DESC LIMIT 1')"
  dato "timezone por defecto"    "$(consulta 'SHOW timezone')"
  dato "datestyle por defecto"   "$(consulta 'SHOW datestyle')"
  dato "tamaño de la base"       "$(consulta "SELECT pg_size_pretty(pg_database_size('$DB'))")"
  dato "filas de bitácora"       "$(consulta 'SELECT count(*) FROM audit_logs')"
  dato "empresas"                "$(consulta 'SELECT count(*) FROM companies')"
  printf '  funciones de hash de la bitácora (deben fijar UTC e ISO tras 0131/0132):\n'
  consulta "SELECT '    ' || proname || ' → ' || coalesce(array_to_string(proconfig, ', '), '(sin configuración fija)') FROM pg_proc WHERE proname IN ('audit_chain_link','normative_audit_chain_link','verify_audit_chain') ORDER BY proname"
  dato "rol de la aplicación"    "$(consulta "SELECT rolname || ' superusuario=' || rolsuper::int || ' bypassrls=' || rolbypassrls::int FROM pg_roles WHERE rolname = 'nexo_app'")"
  dato "tablas con company_id sin RLS forzado" "$(consulta "SELECT count(*) FROM pg_class c JOIN pg_attribute a ON a.attrelid = c.oid AND a.attname = 'company_id' WHERE c.relkind = 'r' AND c.relnamespace = 'public'::regnamespace AND NOT c.relforcerowsecurity")"
  dato "¿ya tiene la 0133?"      "$(consulta "SELECT CASE WHEN EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name = 'cash_movements' AND column_name = 'idempotency_key') THEN 'SÍ (columnas de idempotencia presentes)' ELSE 'no' END")"
  printf '  bases de restauración (copias descartables):\n'
  consulta "SELECT '    ' || datname || '  ' || pg_size_pretty(pg_database_size(datname)) FROM pg_database WHERE datname LIKE 'aai_restauracion_%' ORDER BY datname"
else
  dato "conexión" "NO se pudo consultar la base con el usuario administrativo"
fi
unset PGPASSWORD

titulo "6 · Copias de resguardo que YA existen"
dato "carpeta"           "$COPIAS"
dato "mismo disco que la base" "carpeta en $(df -Pk "$COPIAS" 2>/dev/null | awk 'NR==2{print $1}'); datos de Docker en $(df -Pk /var/lib/docker 2>/dev/null | awk 'NR==2{print $1}')"
if [[ -d "$COPIAS" ]]; then
  dato "cantidad de .dump"  "$(ls "$COPIAS"/*.dump 2>/dev/null | wc -l)"
  dato "espacio que ocupan" "$(du -sh "$COPIAS" 2>/dev/null | cut -f1)"
  printf '  las más recientes:\n'
  ls -lt --time-style=long-iso "$COPIAS"/*.dump 2>/dev/null | head -8 | awk '{printf "    %s %s  %10d bytes  %s\n", $6, $7, $5, $8}'
  ultima=$(ls -t "$COPIAS"/*.dump 2>/dev/null | head -1)
  if [[ -n "$ultima" ]]; then
    dato "la más reciente"   "$(basename "$ultima")"
    dato "edad"              "$(( ($(date +%s) - $(stat -c %Y "$ultima")) / 3600 )) horas"
    if [[ -f "$ultima.sha256" ]]; then
      (cd "$COPIAS" && sha256sum -c "$(basename "$ultima").sha256" 2>&1 | sed 's/^/    suma: /')
    else
      dato "suma sha256"     "SIN archivo .sha256 junto a la copia"
    fi
  fi
else
  dato "carpeta" "no existe"
fi
printf '  tareas agendadas de NEXO:\n'
systemctl list-timers --all --no-pager 2>/dev/null | grep -i nexo | sed 's/^/    /'
dato "respaldo: última corrida" "$(salida systemctl show nexo-respaldo.service -p ExecMainStartTimestamp --value)"
dato "respaldo: resultado"      "$(salida systemctl show nexo-respaldo.service -p Result --value)"
dato "diario: resultado"        "$(salida systemctl show nexo-diario.service -p Result --value)"

titulo "7 · Para volver atrás"
dato "registro de despliegues"  "$RAIZ/var/despliegues"
ls -1t "$RAIZ/var/despliegues" 2>/dev/null | head -5 | sed 's/^/    /'
[[ -z "$(ls -A "$RAIZ/var/despliegues" 2>/dev/null)" ]] && printf '    (vacío: ningún despliegue con el guion nuevo)\n'
printf '  archivos de respaldo del Compose / .env:\n'
ls -1 "$RAIZ"/docker-compose.prod.yml* "$RAIZ"/.env.* 2>/dev/null | sed 's/^/    /'

titulo "8 · Alcance desde afuera"
dato "DNS de $DOMINIO"   "$(salida getent hosts "$DOMINIO")"
dato "salud (HTTPS)"     "$(salida curl -sS -m 10 -o /dev/null -w 'HTTP %{http_code}' "https://$DOMINIO/health")"
dato "certificado"       "$(echo | openssl s_client -servername "$DOMINIO" -connect "$DOMINIO:443" 2>/dev/null | openssl x509 -noout -issuer -enddate 2>/dev/null | tr '\n' ' ')"
ip_app="$(salida docker inspect "$CONTENEDOR_APP" --format '{{.NetworkSettings.Networks.nexo.IPAddress}}')"
dato "salud interna (/health/db)" "$(salida curl -sS -m 8 "http://$ip_app:3001/health/db")"

printf '\nFIN — nada se modificó.\n'
