#!/usr/bin/env bash
# ============================================================================
# NEXO — desplegar y auditar, en el servidor
# ============================================================================
#
#   bash scripts/desplegar.sh --auditar    → no cambia nada, solo informa
#   bash scripts/desplegar.sh              → construye, levanta y verifica
#
# ## Por qué existe
#
# Porque el despliegue venía haciéndose a mano, y eso ya costó caro: la
# corrección del Dockerfile del 2026-09-10 se aplicó **en el servidor y no en el
# repositorio**, así que durante horas la imagen que funcionaba no se podía
# reconstruir desde un clone limpio. Un despliegue que solo existe en la memoria
# de quien lo hizo no es reproducible.
#
# Este script es el despliegue escrito una vez. Hace lo mismo siempre, dice qué
# comprobó, y **falla ruidosamente** en vez de dejar el sistema a medias.
#
# ## Lo que NO hace, y no es por olvido
#
#   · No borra volúmenes, ni bases, ni esquemas.
#   · No recrea PostgreSQL: el contenedor que ya corre se queda como está.
#   · No toca Traefik.
#   · No publica puertos.
#   · No imprime el contenido de `.env` ni ninguna credencial.
#   · No corre `npm audit fix`.
#
# Las migraciones corren **antes** de levantar la imagen nueva y desde un
# contenedor aparte, nunca desde el que atiende pedidos: con dos réplicas, cada
# una intentaría migrar contra la misma base.

set -uo pipefail

readonly RAIZ="${NEXO_RAIZ:-/opt/nexo}"
readonly IMAGEN="nexo:production"
readonly RED="nexo"
readonly CONTENEDOR_APP="nexo-app"
readonly CONTENEDOR_DB="nexo-postgres"
readonly COMPOSE="${RAIZ}/docker-compose.prod.yml"

AUDITAR=0
[[ "${1:-}" == "--auditar" ]] && AUDITAR=1

# ── Cómo se informa ─────────────────────────────────────────────────────────
#
# Cada comprobación deja una línea con su veredicto. Al final se cuentan. Un
# despliegue que dice «listo» sin decir qué miró no sirve para diagnosticar
# nada la próxima vez.

FALLOS=0
AVISOS=0

ok()    { printf '  \033[32m✔\033[0m %s\n' "$*"; }
mal()   { printf '  \033[31m✘\033[0m %s\n' "$*"; FALLOS=$((FALLOS+1)); }
aviso() { printf '  \033[33m!\033[0m %s\n' "$*"; AVISOS=$((AVISOS+1)); }
info()  { printf '    %s\n' "$*"; }
titulo(){ printf '\n\033[1m── %s %s\033[0m\n' "$*" "$(printf '─%.0s' $(seq 1 $((60 - ${#1}))))"; }

# ── 1 · El entorno ──────────────────────────────────────────────────────────

titulo "1 · Entorno"

command -v docker >/dev/null || { mal "no hay docker"; exit 1; }
ok "docker $(docker --version | awk '{print $3}' | tr -d ,)"
docker compose version >/dev/null 2>&1 && ok "compose $(docker compose version --short)" || mal "no hay docker compose v2"

[[ -d "$RAIZ" ]] || { mal "no existe $RAIZ"; exit 1; }
cd "$RAIZ" || exit 1
ok "raíz $RAIZ"

# El archivo de secretos: se comprueba que **exista y esté cerrado**, nunca su
# contenido. Un despliegue que imprime `.env` para verificarlo lo filtra al log.
if [[ -f "${RAIZ}/.env" ]]; then
  perm=$(stat -c '%a' "${RAIZ}/.env")
  if [[ "$perm" == "600" || "$perm" == "400" ]]; then
    ok ".env presente, permisos $perm"
  else
    aviso ".env presente con permisos $perm — deberían ser 600"
  fi
else
  mal "falta ${RAIZ}/.env"
fi

docker network inspect "$RED" >/dev/null 2>&1 && ok "red $RED" || mal "no existe la red $RED"

libre=$(df -Pk "$RAIZ" | awk 'NR==2{printf "%.1f", $4/1048576}')
awk -v g="$libre" 'BEGIN{exit !(g<2)}' && aviso "quedan ${libre} GiB libres" || ok "espacio libre ${libre} GiB"

# ── 2 · El código ───────────────────────────────────────────────────────────

titulo "2 · Código"

if [[ -d .git ]]; then
  rama=$(git rev-parse --abbrev-ref HEAD)
  sucio=$(git status --porcelain | wc -l)
  ok "rama $rama"
  if [[ "$sucio" -gt 0 ]]; then
    # Es exactamente el defecto del 2026-09-10: una corrección viva solo acá.
    aviso "hay $sucio archivo(s) modificados en el servidor y no en Git"
    git status --porcelain | sed 's/^/      /'
  else
    ok "árbol limpio"
  fi

  if [[ "$AUDITAR" -eq 0 ]]; then
    info "trayendo cambios..."
    git pull --ff-only 2>&1 | sed 's/^/      /'
  fi
  ok "HEAD $(git rev-parse --short HEAD) — $(git log -1 --format=%s)"
else
  mal "$RAIZ no es un repositorio git"
fi

BUILD_ID=$(git rev-parse --short HEAD 2>/dev/null || echo desconocido)
export BUILD_ID

# ── 3 · La imagen ───────────────────────────────────────────────────────────

titulo "3 · Imagen"

if [[ "$AUDITAR" -eq 0 ]]; then
  info "construyendo $IMAGEN (esto tarda)..."
  if docker build -t "$IMAGEN" -t "nexo:${BUILD_ID}" . > /tmp/nexo-build.log 2>&1; then
    ok "construida y etiquetada nexo:${BUILD_ID}"
  else
    mal "la construcción falló — últimas líneas:"
    tail -20 /tmp/nexo-build.log | sed 's/^/      /'
    exit 1
  fi
fi

docker image inspect "$IMAGEN" >/dev/null 2>&1 || { mal "no existe la imagen $IMAGEN"; exit 1; }
info "creada $(docker image inspect "$IMAGEN" --format '{{.Created}}' | cut -c1-19)"

# **La comprobación que faltaba el 2026-09-10.**
#
# El preflight lee `infrastructure/db/migrations` al arrancar y se niega si no
# está. Confiar en que el Dockerfile lo copia no alcanzó: hay que mirar adentro
# de la imagen.
titulo "3.1 · Contenido real de la imagen"

for ruta in /app/apps /app/packages /app/node_modules /app/package.json /app/infrastructure; do
  if docker run --rm --entrypoint sh "$IMAGEN" -c "[ -e '$ruta' ]" 2>/dev/null; then
    ok "$ruta"
  else
    mal "$ruta — FALTA en la imagen"
  fi
done

n_mig=$(docker run --rm --entrypoint sh "$IMAGEN" -c 'ls /app/infrastructure/db/migrations/*.sql 2>/dev/null | wc -l' 2>/dev/null || echo 0)
if [[ "$n_mig" -gt 100 ]]; then
  ok "/app/infrastructure/db/migrations — $n_mig archivos .sql"
else
  mal "migraciones en la imagen: $n_mig (se esperaban más de 100)"
fi

usuario=$(docker run --rm --entrypoint sh "$IMAGEN" -c 'id -un' 2>/dev/null)
[[ "$usuario" == "node" ]] && ok "corre como '$usuario', no root" || mal "corre como '$usuario'"

if docker run --rm --entrypoint sh "$IMAGEN" -c '[ -e /app/.env ]' 2>/dev/null; then
  mal "la imagen CONTIENE un .env — es una filtración de credenciales"
else
  ok "la imagen no lleva .env"
fi

# ── 4 · PostgreSQL ──────────────────────────────────────────────────────────

titulo "4 · PostgreSQL"

if docker ps --format '{{.Names}}' | grep -qx "$CONTENEDOR_DB"; then
  ok "$CONTENEDOR_DB corriendo"
  estado=$(docker inspect "$CONTENEDOR_DB" --format '{{if .State.Health}}{{.State.Health.Status}}{{else}}sin healthcheck{{end}}')
  info "salud: $estado"

  # Que no salga al host. Es la propiedad más importante de esta sección: una
  # base contable de terceros no se expone a internet.
  puertos=$(docker inspect "$CONTENEDOR_DB" --format '{{json .NetworkSettings.Ports}}')
  if [[ "$puertos" == *"HostPort"* ]]; then
    mal "PostgreSQL publica un puerto en el host: $puertos"
  else
    ok "no publica puertos en el host"
  fi

  docker inspect "$CONTENEDOR_DB" --format '{{range $k,$v := .NetworkSettings.Networks}}{{$k}} {{end}}' \
    | grep -q "$RED" && ok "conectado a la red $RED" || mal "no está en la red $RED"

  vol=$(docker inspect "$CONTENEDOR_DB" --format '{{range .Mounts}}{{.Name}}:{{.Destination}} {{end}}')
  [[ -n "$vol" ]] && ok "volumen $vol" || mal "sin volumen: los datos se pierden al recrear"
else
  mal "$CONTENEDOR_DB NO está corriendo"
fi

# ── 5 · La base ─────────────────────────────────────────────────────────────
#
# Se consulta con el usuario administrativo del `.env`, sin imprimirlo. `psql`
# corre **dentro** del contenedor de la base: no hace falta cliente en el host.

titulo "5 · Esquema, roles y aislamiento"

set -a; . "${RAIZ}/.env" 2>/dev/null; set +a
DB="${POSTGRES_DB:-aai}"
ADMIN="${POSTGRES_USER:-nexo_admin}"

# La contraseña se pasa **por nombre**, no por valor.
#
# `docker exec -e PGPASSWORD=secreto` deja el secreto en los argumentos del
# proceso, y `ps` los muestra a cualquiera que pueda leerlos. Con `-e PGPASSWORD`
# a secas, Docker la toma del entorno de este script y nunca aparece en argv.
export PGPASSWORD="${POSTGRES_PASSWORD:-}"

consulta() {
  docker exec -e PGPASSWORD "$CONTENEDOR_DB" \
    psql -U "$ADMIN" -d "$DB" -tAc "$1" 2>/dev/null
}

if [[ "$(consulta 'SELECT 1')" == "1" ]]; then
  ok "conexión administrativa a «$DB»"

  aplicadas=$(consulta 'SELECT count(*) FROM schema_migrations')
  disco=$(ls infrastructure/db/migrations/*.sql 2>/dev/null | wc -l)
  if [[ "$aplicadas" == "$disco" ]]; then
    ok "migraciones al día: $aplicadas de $disco"
  else
    aviso "aplicadas $aplicadas, en disco $disco"
    if [[ "$AUDITAR" -eq 0 ]]; then
      info "migrando (contenedor aparte, nunca el que sirve)..."
      # Mismo cuidado que arriba: la cadena de conexión **se arma adentro** del
      # contenedor a partir de variables pasadas por nombre. Construirla acá la
      # dejaría, con contraseña incluida, en los argumentos de `docker run`.
      PGPASSWORD="$PGPASSWORD" PGUSER="$ADMIN" PGDB="$DB" PGHOST="$CONTENEDOR_DB" \
      docker run --rm --network "$RED" \
        -e PGPASSWORD -e PGUSER -e PGDB -e PGHOST \
        -v "${RAIZ}:/repo" -w /repo --entrypoint sh "$IMAGEN" \
        -c 'DATABASE_URL="postgresql://${PGUSER}:${PGPASSWORD}@${PGHOST}:5432/${PGDB}" node scripts/migrate.mjs up' \
        2>&1 | tail -8 | sed 's/^/      /'
      aplicadas=$(consulta 'SELECT count(*) FROM schema_migrations')
      [[ "$aplicadas" == "$disco" ]] && ok "migraciones al día: $aplicadas" || mal "siguen faltando: $aplicadas de $disco"
    fi
  fi

  # El rol con el que conecta la aplicación. Un superusuario acá haría que RLS
  # no se aplique a ninguna consulta escrita fuera de los envoltorios.
  attrs=$(consulta "SELECT rolcanlogin||' '||rolsuper||' '||rolbypassrls FROM pg_roles WHERE rolname='nexo_app'")
  if [[ "$attrs" == "t f f" ]]; then
    ok "nexo_app: LOGIN, NOSUPERUSER, NOBYPASSRLS"
  else
    mal "nexo_app tiene atributos inesperados: '$attrs' (se esperaba 't f f')"
  fi

  miembro=$(consulta "SELECT pg_has_role('nexo_app','aai_app','MEMBER')")
  [[ "$miembro" == "t" ]] && ok "nexo_app es miembro de aai_app (SET LOCAL ROLE funciona)" \
                          || mal "nexo_app NO es miembro de aai_app: SET LOCAL ROLE va a fallar"

  bypass=$(consulta "SELECT rolbypassrls FROM pg_roles WHERE rolname='aai_app'")
  [[ "$bypass" == "f" ]] && ok "aai_app no puede saltear RLS" || mal "aai_app puede saltear RLS"

  sin_rls=$(consulta "SELECT count(*) FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace WHERE n.nspname='public' AND c.relkind='r' AND NOT c.relforcerowsecurity AND c.relname IN (SELECT table_name FROM information_schema.columns WHERE table_schema='public' AND column_name='company_id')")
  [[ "$sin_rls" == "0" ]] && ok "0 tablas con company_id sin RLS forzado" \
                          || mal "$sin_rls tabla(s) con company_id SIN RLS forzado"

  info "políticas RLS: $(consulta 'SELECT count(*) FROM pg_policies')"
else
  mal "no se pudo consultar la base con el usuario administrativo"
fi

# ── 6 · Documentos ──────────────────────────────────────────────────────────

titulo "6 · Almacén de documentos"

DOCS="${RAIZ}/var/documents"
if [[ "$AUDITAR" -eq 0 ]]; then
  mkdir -p "$DOCS"
  # `node` es uid 1000 en la imagen oficial. Sin esto, el contenedor no puede
  # escribir y la subida de un comprobante falla con EACCES.
  chown -R 1000:1000 "$DOCS" 2>/dev/null || aviso "no se pudo cambiar el dueño de $DOCS"
  chmod 750 "$DOCS"
fi
if [[ -d "$DOCS" ]]; then
  ok "$DOCS ($(stat -c '%U:%G %a' "$DOCS"), $(find "$DOCS" -type f 2>/dev/null | wc -l) archivo(s))"
else
  mal "no existe $DOCS"
fi

# ── 7 · Levantar ────────────────────────────────────────────────────────────

titulo "7 · Servicio"

[[ -f "$COMPOSE" ]] || { mal "falta $COMPOSE"; exit 1; }

# ¿Se pide certificado real? Solo si el dominio resuelve.
#
# Con NXDOMAIN, el desafío HTTP de ACME no puede pasar y cada intento cuenta
# contra el cupo de validaciones fallidas de Let's Encrypt. Detectarlo acá evita
# gastarlo y evita tener que acordarse de nada el día que el dominio exista.
DOMINIO="${NEXO_DOMAIN:-nexointelligence.com.ar}"
ARCHIVOS=(-f "$COMPOSE")
if getent hosts "$DOMINIO" >/dev/null 2>&1; then
  ok "$DOMINIO resuelve — se pide certificado real"
  [[ -f "${RAIZ}/docker-compose.tls.yml" ]] && ARCHIVOS+=(-f "${RAIZ}/docker-compose.tls.yml")
else
  aviso "$DOMINIO no resuelve (NXDOMAIN) — sin resolvedor ACME, se sirve el certificado por defecto"
fi

if [[ "$AUDITAR" -eq 0 ]]; then
  info "levantando..."
  BUILD_ID="$BUILD_ID" docker compose "${ARCHIVOS[@]}" up -d 2>&1 | sed 's/^/      /'
  info "esperando a que la sonda pase..."
  for _ in $(seq 1 20); do
    s=$(docker inspect "$CONTENEDOR_APP" --format '{{if .State.Health}}{{.State.Health.Status}}{{end}}' 2>/dev/null)
    [[ "$s" == "healthy" ]] && break
    sleep 3
  done
fi

if docker ps --format '{{.Names}}' | grep -qx "$CONTENEDOR_APP"; then
  ok "$CONTENEDOR_APP corriendo"
  salud=$(docker inspect "$CONTENEDOR_APP" --format '{{if .State.Health}}{{.State.Health.Status}}{{else}}sin healthcheck{{end}}')
  [[ "$salud" == "healthy" ]] && ok "sonda: healthy" || mal "sonda: $salud"

  pol=$(docker inspect "$CONTENEDOR_APP" --format '{{.HostConfig.RestartPolicy.Name}}')
  [[ "$pol" == "unless-stopped" || "$pol" == "always" ]] && ok "restart: $pol" || mal "restart: $pol"

  u=$(docker exec "$CONTENEDOR_APP" id -un 2>/dev/null)
  [[ "$u" == "node" ]] && ok "corre como '$u'" || mal "corre como '$u'"

  p=$(docker inspect "$CONTENEDOR_APP" --format '{{json .NetworkSettings.Ports}}')
  [[ "$p" == *"HostPort"* ]] && mal "publica un puerto en el host: $p" || ok "no publica puertos"

  ro=$(docker inspect "$CONTENEDOR_APP" --format '{{.HostConfig.ReadonlyRootfs}}')
  [[ "$ro" == "true" ]] && ok "sistema de archivos de solo lectura" || aviso "rootfs escribible"

  # La sonda desde dentro de la red, que es como llega Traefik.
  cuerpo=$(docker run --rm --network "$RED" --entrypoint sh "$IMAGEN" \
    -c "node -e \"fetch('http://${CONTENEDOR_APP}:3001/health/db').then(r=>r.text()).then(t=>console.log(t)).catch(e=>console.log('ERROR '+e.message))\"" 2>/dev/null)
  if [[ "$cuerpo" == *'"status":"ok"'* ]]; then
    ok "/health/db desde la red: $cuerpo"
  else
    mal "/health/db no responde bien: $cuerpo"
  fi
else
  mal "$CONTENEDOR_APP NO está corriendo"
  docker compose -f "$COMPOSE" logs --tail 25 nexo 2>&1 | sed 's/^/      /'
fi

# ── 8 · Traefik ─────────────────────────────────────────────────────────────

titulo "8 · Traefik y publicación"

if docker ps --format '{{.Names}}\t{{.Image}}' | grep -qi traefik; then
  nombre=$(docker ps --format '{{.Names}}\t{{.Image}}' | grep -i traefik | head -1 | cut -f1)
  ok "Traefik corriendo ($nombre)"
  docker inspect "$nombre" --format '{{range $k,$v := .NetworkSettings.Networks}}{{$k}} {{end}}' \
    | grep -q "$RED" && ok "Traefik está en la red $RED" \
                     || mal "Traefik NO está en la red $RED: no puede llegar a NEXO"
else
  mal "no se encontró un contenedor de Traefik"
fi

info "dominio: $DOMINIO"

# El ruteo se prueba **sin depender del DNS**, con la cabecera `Host`.
#
# Es la comprobación que faltaba: sin dominio no se puede pedir la URL, pero sí
# se puede pedirle a Traefik, en el propio servidor, que enrute como si el
# nombre resolviera. Eso ejercita la cadena entera —entrypoint, enrutador,
# servicio, red, contenedor— y deja afuera solo el DNS y el certificado, que es
# exactamente lo que falta.
titulo "8.1 · Ruteo de punta a punta"

redir=$(curl -sS -o /dev/null -w '%{http_code}' --max-time 15 \
  -H "Host: ${DOMINIO}" http://127.0.0.1/health 2>/dev/null || echo 000)
if [[ "$redir" == "301" || "$redir" == "302" || "$redir" == "308" ]]; then
  ok "HTTP → redirección $redir (la global de Traefik)"
else
  mal "HTTP contestó $redir, se esperaba una redirección a HTTPS"
fi

# `-k` porque mientras no haya dominio el certificado es el de por defecto de
# Traefik, autofirmado. No se disimula: se informa cuál se presentó.
cuerpo=$(curl -sSk --max-time 15 -H "Host: ${DOMINIO}" https://127.0.0.1/health 2>/dev/null)
if [[ "$cuerpo" == *'"status":"ok"'* ]]; then
  ok "HTTPS → Traefik → NEXO: $cuerpo"
else
  mal "HTTPS no llegó a NEXO: ${cuerpo:-sin respuesta}"
fi

db=$(curl -sSk --max-time 15 -H "Host: ${DOMINIO}" https://127.0.0.1/health/db 2>/dev/null)
if [[ "$db" == *'"status":"ok"'* ]]; then
  ok "HTTPS → NEXO → PostgreSQL: $db"
else
  mal "/health/db por Traefik: ${db:-sin respuesta}"
fi

emisor=$(echo | openssl s_client -connect 127.0.0.1:443 -servername "$DOMINIO" 2>/dev/null \
  | openssl x509 -noout -issuer 2>/dev/null)
info "certificado: ${emisor:-no se pudo leer}"
[[ "$emisor" == *"TRAEFIK DEFAULT CERT"* ]] && \
  aviso "es el certificado por defecto: no hay certificado real mientras el dominio no resuelva"

# ── Resumen ─────────────────────────────────────────────────────────────────

titulo "Resumen"
printf '  fallos: %s   avisos: %s\n\n' "$FALLOS" "$AVISOS"

if [[ "$FALLOS" -gt 0 ]]; then
  printf '  \033[31mHay %s comprobación(es) en rojo.\033[0m Cada una dice qué falta.\n\n' "$FALLOS"
  exit 1
fi
printf '  \033[32mTodo lo verificable pasó.\033[0m\n\n'
exit 0
