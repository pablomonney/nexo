#!/usr/bin/env bash
# ============================================================================
# NEXO — desplegar, auditar y volver atrás, en el servidor
# ============================================================================
#
#   bash scripts/desplegar.sh --auditar                 → no cambia nada, solo informa
#   bash scripts/desplegar.sh --commit <sha>            → despliega EXACTAMENTE ese commit
#   bash scripts/desplegar.sh --revertir                → vuelve a la versión anterior de la aplicación
#   bash scripts/desplegar.sh --ayuda
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
# ## Lo que cambió el 2026-10-15 (y por qué)
#
# La versión anterior hacía lo correcto cuando todo salía bien y lo incorrecto
# cuando algo fallaba. Cuatro defectos, todos con el mismo origen: seguía adelante
# después de un error.
#
#   · **Desplegaba con cualquier argumento.** Solo reconocía `--auditar`; con
#     `--help` o un error de tipeo hacía el despliegue completo. Ahora un argumento
#     desconocido termina en 2, y un despliegue exige `--commit <sha>`: se dice qué
#     se quiere desplegar y el script se niega si el servidor no termina ahí.
#   · **No hacía copia de resguardo.** `docs/DESPLIEGUE.md` §3 la pide como primer
#     paso y nada la ejecutaba. Ahora corre `respaldar.sh` con una etiqueta
#     (`predeploy-<commit>`, que la poda nunca borra) y **prueba restaurarla** en
#     una base descartable. Si la copia no pasa, no se toca nada.
#   · **No se detenía ante un error de migración.** Anotaba un `✘` y seguía hasta
#     `docker compose up -d`: la imagen nueva se negaba a arrancar contra un
#     esquema viejo y producción quedaba abajo. Ahora cualquier `✘` antes de
#     levantar la imagen nueva corta el despliegue con la versión anterior
#     todavía sirviendo.
#   · **Pisaba `nexo:production` sin guardar la anterior.** `docker build -t
#     nexo:production` deja sin nombre a la imagen que estaba sirviendo. Ahora se
#     la etiqueta (`nexo:previo-<fecha>`) ANTES de construir, y `--revertir` vuelve a ella.
#
# Y dos más que no venían de seguir después de un error:
#
#   · **No se ejecuta el `.env`.** Antes `. .env` lo corría como shell; un valor
#     sin comillas con `<` (`EMAIL_FROM=NEXO <no-reply@…>`) es un error de sintaxis y
#     todo lo declarado después se perdía en silencio. Se leen solo las variables
#     que hacen falta, como texto. El archivo no se toca: lo leen también Compose y
#     `docker run --env-file`, que no tratan las comillas igual.
#   · **El script no se edita a sí mismo mientras corre.** Bash lee un script de a
#     pedazos; si el `git merge` cambia este archivo en medio de la ejecución, lo que
#     sigue es impredecible. Todo el cuerpo vive en una función, que bash lee entera
#     antes de ejecutarla.
#
# ## Lo que NO hace, y no es por olvido
#
#   · No borra volúmenes, ni bases, ni esquemas.
#   · No recrea PostgreSQL: el contenedor que ya corre se queda como está.
#   · No toca Traefik.
#   · No publica puertos.
#   · No imprime el contenido de `.env` ni ninguna credencial.
#   · No corre `npm audit fix`.
#   · **No revierte la base.** Las migraciones solo avanzan; una versión anterior de la
#     aplicación funciona contra el esquema nuevo (ninguna migración renombra ni borra
#     una columna en uso). Volver atrás es volver la imagen; si hiciera falta volver los
#     DATOS, hay una copia verificada y el procedimiento está en `docs/DESPLIEGUE.md` §7.5.
#
# ## El orden, y dónde empieza a haber riesgo
#
#   entorno → código (avanza al commit pedido) → etiqueta la imagen anterior → construye
#   → inspecciona la imagen → COPIA VERIFICADA → migraciones → levanta → verifica
#
# Hasta la copia, producción no cambió nada y cualquier fallo es gratis. Las
# migraciones corren **antes** de levantar la imagen nueva y desde un contenedor
# aparte, nunca desde el que atiende pedidos: con dos réplicas, cada una intentaría
# migrar contra la misma base.

set -uo pipefail

readonly RAIZ="${NEXO_RAIZ:-/opt/nexo}"
readonly IMAGEN="nexo:production"
readonly RED="nexo"
readonly CONTENEDOR_APP="nexo-app"
readonly CONTENEDOR_DB="nexo-postgres"
readonly COMPOSE="${RAIZ}/docker-compose.prod.yml"
readonly ENV_FILE="${RAIZ}/.env"
readonly REGISTRO="${RAIZ}/var/despliegues"
readonly SONDA_REINTENTOS="${NEXO_SONDA_REINTENTOS:-20}"
readonly SONDA_ESPERA="${NEXO_SONDA_ESPERA:-3}"

# ── Cómo se informa ─────────────────────────────────────────────────────────
#
# Cada comprobación deja una línea con su veredicto. Al final se cuentan. Un
# despliegue que dice «listo» sin decir qué miró no sirve para diagnosticar
# nada la próxima vez.

FALLOS=0
AVISOS=0
PRODUCCION_TOCADA=0   # pasa a 1 cuando empieza lo que ya no es gratis: las migraciones

ok()    { printf '  \033[32m✔\033[0m %s\n' "$*"; }
mal()   { printf '  \033[31m✘\033[0m %s\n' "$*"; FALLOS=$((FALLOS+1)); }
aviso() { printf '  \033[33m!\033[0m %s\n' "$*"; AVISOS=$((AVISOS+1)); }
info()  { printf '    %s\n' "$*"; }
titulo(){ printf '\n\033[1m── %s %s\033[0m\n' "$*" "$(printf '─%.0s' $(seq 1 $((60 - ${#1}))))"; }

# ── Buscar en la salida de un comando SIN tubería ───────────────────────────
#
# Con `set -o pipefail`, `comando | grep -q X` da FALSO NEGATIVO cuando grep encuentra X y cierra la tubería antes de
# que `comando` termine de escribir: el productor muere por SIGPIPE (141) y el pipeline entero cuenta como fallido.
# Pasó de verdad: `docker ps | grep -qx nexo-postgres` dijo «NO está corriendo» de forma intermitente (probado con
# un `docker` que escribe despacio). Un despliegue que se corta por una carrera del propio script es un despliegue que
# nadie sabe si confiar. Por eso la salida se CAPTURA primero y se busca después, sobre la variable.
contenedor_corre() {
  local nombres
  nombres=$(docker ps --format '{{.Names}}' 2>/dev/null) || return 1
  grep -qx "$1" <<<"$nombres"
}

# ¿La salida del comando que se pasa contiene el patrón (expresión regular simple)? Sin tubería, por lo de arriba.
salida_contiene() {
  local patron="$1" salida
  shift
  salida=$("$@" 2>/dev/null) || return 1
  grep -q -- "$patron" <<<"$salida"
}

# Corta el despliegue. Dice, siempre, en qué estado queda producción: es lo
# primero que se necesita saber cuando algo sale mal.
abortar() {
  mal "$*"
  printf '\n'
  if [[ "$PRODUCCION_TOCADA" -eq 0 ]]; then
    printf '  \033[31mDESPLIEGUE CORTADO.\033[0m Producción: SIN CAMBIOS — la versión anterior sigue sirviendo.\n\n'
  else
    printf '  \033[31mDESPLIEGUE CORTADO.\033[0m Las migraciones ya corrieron (cada una en su transacción: la que falló no dejó nada).\n'
    printf '  La aplicación anterior sigue sirviendo y es compatible con el esquema nuevo. Nada que revertir en la aplicación.\n\n'
  fi
  exit 1
}

uso() {
  printf 'uso: bash scripts/desplegar.sh --auditar\n'
  printf '     bash scripts/desplegar.sh --commit <sha>\n'
  printf '     bash scripts/desplegar.sh --revertir\n'
  printf '  --auditar        no cambia nada; informa el estado del servidor (con --commit, compara contra ese commit)\n'
  printf '  --commit <sha>   despliega exactamente ese commit (7 a 40 caracteres hexadecimales)\n'
  printf '  --revertir       vuelve la imagen anterior que dejó el último despliegue; no toca la base\n'
}

# Lee `NOMBRE=valor` del archivo de entorno **como texto**. Quita un par de
# comillas si envuelve el valor completo; no expande `$`, no ejecuta nada.
leer_env() {
  local linea valor
  linea=$(grep -m1 -E "^[[:space:]]*(export[[:space:]]+)?$1=" "$ENV_FILE" 2>/dev/null) || return 0
  valor="${linea#*=}"
  valor="${valor%$'\r'}"
  if [[ "$valor" =~ ^\"(.*)\"$ ]] || [[ "$valor" =~ ^\'(.*)\'$ ]]; then
    valor="${BASH_REMATCH[1]}"
  fi
  printf '%s' "$valor"
}

# Lee `CLAVE=valor` de un registro de despliegue (texto, sin ejecutarlo).
leer_registro() {
  local linea
  linea=$(grep -m1 "^$1=" "$REGISTRO/ultimo.env" 2>/dev/null) || return 0
  printf '%s' "${linea#*=}"
}

# Los archivos de Compose: el de producción, y el de TLS solo si el dominio resuelve
# (con NXDOMAIN el desafío ACME no puede pasar y cada intento cuenta contra el cupo
# de validaciones fallidas de Let's Encrypt).
ARCHIVOS_COMPOSE=()
armar_archivos_compose() {
  DOMINIO="$(leer_env NEXO_DOMAIN)"
  DOMINIO="${DOMINIO:-${NEXO_DOMAIN:-nexointelligence.com.ar}}"
  ARCHIVOS_COMPOSE=(-f "$COMPOSE")
  if getent hosts "$DOMINIO" >/dev/null 2>&1; then
    ok "$DOMINIO resuelve — se pide certificado real"
    [[ -f "${RAIZ}/docker-compose.tls.yml" ]] && ARCHIVOS_COMPOSE+=(-f "${RAIZ}/docker-compose.tls.yml")
  else
    aviso "$DOMINIO no resuelve (NXDOMAIN) — sin resolvedor ACME, se sirve el certificado por defecto"
  fi
}

# Espera a que la sonda de la aplicación diga `healthy`.
esperar_sonda() {
  local s intento
  for ((intento = 1; intento <= SONDA_REINTENTOS; intento++)); do
    s=$(docker inspect "$CONTENEDOR_APP" --format '{{if .State.Health}}{{.State.Health.Status}}{{end}}' 2>/dev/null)
    [[ "$s" == "healthy" ]] && return 0
    sleep "$SONDA_ESPERA"
  done
  return 1
}

# ── La reversión ────────────────────────────────────────────────────────────

revertir() {
  titulo "Reversión de la aplicación"

  command -v docker >/dev/null || abortar "no hay docker"
  [[ -f "$REGISTRO/ultimo.env" ]] || abortar "no hay registro del último despliegue en $REGISTRO/ultimo.env: no hay a qué volver"

  local tag version desde
  tag=$(leer_registro IMAGEN_ANTERIOR_TAG)
  version=$(leer_registro VERSION_ANTERIOR)
  desde=$(leer_registro FECHA)
  [[ -n "$tag" && -n "$version" ]] || abortar "el registro está incompleto (falta la imagen o la versión anterior)"
  docker image inspect "$tag" >/dev/null 2>&1 || abortar "la imagen anterior $tag ya no existe en este servidor"

  info "último despliegue    $desde"
  info "vuelve a             $tag (versión $version)"
  info "migraciones antes    $(leer_registro MIGRACIONES_ANTES) · después $(leer_registro MIGRACIONES_DESPUES)"
  info "copia previa         $(leer_registro RESPALDO_ARCHIVO)"

  docker tag "$tag" "$IMAGEN" || abortar "no se pudo etiquetar $tag como $IMAGEN"
  ok "$IMAGEN apunta otra vez a $tag"

  armar_archivos_compose
  info "levantando la versión $version..."
  BUILD_ID="$version" docker compose "${ARCHIVOS_COMPOSE[@]}" up -d 2>&1 | sed 's/^/      /'
  if esperar_sonda; then
    ok "sonda: healthy"
  else
    mal "la sonda no pasó a healthy: mirar el log del contenedor"
  fi

  printf '\n'
  if [[ "$FALLOS" -gt 0 ]]; then
    printf '  \033[31mLa reversión no quedó sana.\033[0m\n\n'
    exit 1
  fi
  printf '  \033[32mAplicación revertida a %s.\033[0m\n' "$version"
  printf '  La base NO se tocó. El esquema es el nuevo y la versión anterior lo soporta.\n'
  printf '  Si además hiciera falta volver los DATOS: restaurar %s\n' "$(leer_registro RESPALDO_ARCHIVO)"
  printf '  (verificar su .sha256 y seguir docs/DESPLIEGUE.md §7.5). Eso pierde lo escrito desde la copia.\n\n'
  exit 0
}

# ── El despliegue ───────────────────────────────────────────────────────────
#
# Todo el cuerpo está en una función: bash la lee ENTERA antes de ejecutarla, así
# que el `git merge` de más abajo puede reemplazar este archivo sin que la
# ejecución en curso lea un pedazo de la versión nueva.

principal() {
  local MODO=desplegar ESPERADO=""
  while (( $# > 0 )); do
    case "$1" in
      --auditar) MODO=auditar ;;
      --revertir) MODO=revertir ;;
      --commit) shift; ESPERADO="${1:-}" ;;
      --commit=*) ESPERADO="${1#--commit=}" ;;
      --ayuda|-h|--help) uso; return 0 ;;
      *) printf 'argumento desconocido: %s\n\n' "$1" >&2; uso >&2; return 2 ;;
    esac
    shift
  done

  if [[ -n "$ESPERADO" ]] && ! [[ "$ESPERADO" =~ ^[0-9a-f]{7,40}$ ]]; then
    printf 'el commit «%s» no es válido: 7 a 40 caracteres hexadecimales en minúscula\n\n' "$ESPERADO" >&2
    uso >&2
    return 2
  fi
  if [[ "$MODO" == desplegar && -z "$ESPERADO" ]]; then
    printf 'falta --commit <sha>: un despliegue dice QUÉ se despliega, y el script se niega si el servidor no termina ahí.\n\n' >&2
    uso >&2
    return 2
  fi

  [[ "$MODO" == revertir ]] && revertir

  local AUDITAR=0
  [[ "$MODO" == auditar ]] && AUDITAR=1

  # ── 1 · El entorno ────────────────────────────────────────────────────────

  titulo "1 · Entorno"

  command -v docker >/dev/null || { mal "no hay docker"; exit 1; }
  ok "docker $(docker --version | awk '{print $3}' | tr -d ,)"
  docker compose version >/dev/null 2>&1 && ok "compose $(docker compose version --short)" || mal "no hay docker compose v2"

  [[ -d "$RAIZ" ]] || { mal "no existe $RAIZ"; exit 1; }
  cd "$RAIZ" || exit 1
  ok "raíz $RAIZ"

  # El archivo de secretos: se comprueba que **exista y esté cerrado**, nunca su
  # contenido. Un despliegue que imprime `.env` para verificarlo lo filtra al log.
  if [[ -f "$ENV_FILE" ]]; then
    local perm
    perm=$(stat -c '%a' "$ENV_FILE")
    if [[ "$perm" == "600" || "$perm" == "400" ]]; then
      ok ".env presente, permisos $perm"
    else
      aviso ".env presente con permisos $perm — deberían ser 600"
    fi
  else
    mal "falta $ENV_FILE"
  fi

  docker network inspect "$RED" >/dev/null 2>&1 && ok "red $RED" || mal "no existe la red $RED"

  local libre
  libre=$(df -Pk "$RAIZ" | awk 'NR==2{printf "%.1f", $4/1048576}')
  awk -v g="$libre" 'BEGIN{exit !(g<2)}' && aviso "quedan ${libre} GiB libres" || ok "espacio libre ${libre} GiB"

  [[ "$AUDITAR" -eq 0 && "$FALLOS" -gt 0 ]] && abortar "el entorno no está en condiciones de desplegar"

  # ── 2 · El código ─────────────────────────────────────────────────────────

  titulo "2 · Código"

  [[ -d .git ]] || abortar "$RAIZ no es un repositorio git"

  local rama sucios sin_versionar
  rama=$(git rev-parse --abbrev-ref HEAD)
  ok "rama $rama"

  # Solo cuentan los archivos VERSIONADOS modificados: son el defecto del
  # 2026-09-10, una corrección viva solo en el servidor. Un archivo sin versionar
  # (una copia `.bak`, por ejemplo) no entra en la imagen por Git y no se toca.
  sucios=$(git status --porcelain --untracked-files=no | wc -l)
  sin_versionar=$(git status --porcelain --untracked-files=normal | grep -c '^??' || true)
  if [[ "$sucios" -gt 0 ]]; then
    git status --porcelain --untracked-files=no | sed 's/^/      /'
    if [[ "$AUDITAR" -eq 1 ]]; then
      aviso "hay $sucios archivo(s) versionados modificados en el servidor y no en Git"
    else
      abortar "hay $sucios archivo(s) versionados modificados en el servidor y no en Git: un despliegue los perdería o los mezclaría"
    fi
  else
    ok "árbol limpio (archivos versionados)"
  fi
  [[ "$sin_versionar" -gt 0 ]] && info "$sin_versionar archivo(s) sin versionar (no se tocan)"

  local HEAD_ANTES
  HEAD_ANTES=$(git rev-parse HEAD)

  if [[ -n "$ESPERADO" ]]; then
    if [[ "$HEAD_ANTES" == "$ESPERADO"* ]]; then
      ok "el servidor ya está en el commit pedido ($ESPERADO)"
    elif [[ "$AUDITAR" -eq 1 ]]; then
      aviso "el servidor está en $(git rev-parse --short HEAD) y se pidió $ESPERADO (--auditar no avanza)"
    else
      info "avanzando de $(git rev-parse --short HEAD) a $ESPERADO..."
      git fetch origin --quiet 2>&1 | sed 's/^/      /'
      [[ "${PIPESTATUS[0]}" -eq 0 ]] || abortar "git fetch falló: sin el remoto no se puede traer $ESPERADO"
      git cat-file -e "${ESPERADO}^{commit}" 2>/dev/null || abortar "el commit $ESPERADO no existe en el repositorio ni en el remoto"
      git merge-base --is-ancestor HEAD "$ESPERADO" || abortar "$ESPERADO no desciende de lo que hay en el servidor: no es un avance rápido y no se fuerza"
      git merge --ff-only "$ESPERADO" >/dev/null 2>&1 || abortar "git merge --ff-only $ESPERADO falló"
      [[ "$(git rev-parse HEAD)" == "$ESPERADO"* ]] || abortar "después de avanzar, el servidor quedó en $(git rev-parse --short HEAD) y no en $ESPERADO"
    fi
  fi
  ok "HEAD $(git rev-parse --short HEAD) — $(git log -1 --format=%s)"

  local BUILD_ID
  BUILD_ID=$(git rev-parse --short HEAD 2>/dev/null || echo desconocido)
  export BUILD_ID

  # ── 3 · La imagen ─────────────────────────────────────────────────────────

  titulo "3 · Imagen"

  local VERSION_ANTERIOR="desconocida" IMAGEN_ANTERIOR_ID="" IMAGEN_ANTERIOR_TAG=""
  if contenedor_corre "$CONTENEDOR_APP"; then
    IMAGEN_ANTERIOR_ID=$(docker inspect "$CONTENEDOR_APP" --format '{{.Image}}' 2>/dev/null)
    VERSION_ANTERIOR=$(docker inspect "$CONTENEDOR_APP" --format '{{range .Config.Env}}{{println .}}{{end}}' 2>/dev/null \
                         | grep -m1 '^BUILD_ID=' | cut -d= -f2)
    VERSION_ANTERIOR="${VERSION_ANTERIOR:-desconocida}"
    info "sirviendo ahora      versión $VERSION_ANTERIOR, imagen ${IMAGEN_ANTERIOR_ID:0:19}"
  else
    aviso "$CONTENEDOR_APP no está corriendo: no hay imagen en servicio que conservar"
  fi

  if [[ "$AUDITAR" -eq 0 ]]; then
    # **La imagen anterior se etiqueta ANTES de construir.** `docker build -t
    # nexo:production` deja sin nombre a la que está sirviendo; sin una etiqueta no
    # hay a qué volver el día que haga falta.
    if [[ -n "$IMAGEN_ANTERIOR_ID" ]]; then
      IMAGEN_ANTERIOR_TAG="nexo:previo-$(date +%Y%m%d%H%M%S)"
      docker tag "$IMAGEN_ANTERIOR_ID" "$IMAGEN_ANTERIOR_TAG" || abortar "no se pudo etiquetar la imagen en servicio como $IMAGEN_ANTERIOR_TAG"
      [[ "$(docker image inspect "$IMAGEN_ANTERIOR_TAG" --format '{{.Id}}' 2>/dev/null)" == "$IMAGEN_ANTERIOR_ID" ]] \
        || abortar "la etiqueta $IMAGEN_ANTERIOR_TAG no apunta a la imagen en servicio"
      ok "imagen anterior conservada como $IMAGEN_ANTERIOR_TAG"
    fi

    info "construyendo $IMAGEN (esto tarda)..."
    if docker build -t "$IMAGEN" -t "nexo:${BUILD_ID}" . > /tmp/nexo-build.log 2>&1; then
      ok "construida y etiquetada nexo:${BUILD_ID}"
    else
      mal "la construcción falló — últimas líneas:"
      tail -20 /tmp/nexo-build.log | sed 's/^/      /'
      abortar "no se pudo construir la imagen; $IMAGEN no cambió"
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

  local ruta tarea
  for ruta in /app/apps /app/packages /app/node_modules /app/package.json /app/infrastructure \
              /app/scripts; do
    if docker run --rm --entrypoint sh "$IMAGEN" -c "[ -e '$ruta' ]" 2>/dev/null; then
      ok "$ruta"
    else
      mal "$ruta — FALTA en la imagen"
    fi
  done

  # `/app/scripts` entró en la 0124–0126 y su ausencia es **invisible desde la
  # aplicación**: la API arranca y sirve igual sin él. Lo que no funciona son los
  # timers, que fallan cada cinco minutos con «Cannot find module» y que en
  # `systemctl list-timers` se ven idénticos a unos que andan.
  #
  # Se comprueban los archivos por nombre, no solo el directorio: un `.dockerignore`
  # que excluyera uno dejaría el directorio presente y la tarea rota.
  for tarea in pagos-bandeja correo-bandeja tareas-diarias migrate recalcular-cadena verificar-zona-de-negocio; do
    if docker run --rm --entrypoint sh "$IMAGEN" -c "[ -f '/app/scripts/${tarea}.mjs' ]" 2>/dev/null; then
      ok "/app/scripts/${tarea}.mjs"
    else
      mal "/app/scripts/${tarea}.mjs — FALTA: lo que depende de ese script no va a correr"
    fi
  done

  local n_mig
  n_mig=$(docker run --rm --entrypoint sh "$IMAGEN" -c 'ls /app/infrastructure/db/migrations/*.sql 2>/dev/null | wc -l' 2>/dev/null || echo 0)
  if [[ "$n_mig" -gt 100 ]]; then
    ok "/app/infrastructure/db/migrations — $n_mig archivos .sql"
  else
    mal "migraciones en la imagen: $n_mig (se esperaban más de 100)"
  fi

  local usuario
  usuario=$(docker run --rm --entrypoint sh "$IMAGEN" -c 'id -un' 2>/dev/null)
  [[ "$usuario" == "node" ]] && ok "corre como '$usuario', no root" || mal "corre como '$usuario'"

  if docker run --rm --entrypoint sh "$IMAGEN" -c '[ -e /app/.env ]' 2>/dev/null; then
    mal "la imagen CONTIENE un .env — es una filtración de credenciales"
  else
    ok "la imagen no lleva .env"
  fi

  [[ "$AUDITAR" -eq 0 && "$FALLOS" -gt 0 ]] && abortar "la imagen nueva no pasó la inspección"

  # ── 4 · PostgreSQL ────────────────────────────────────────────────────────

  titulo "4 · PostgreSQL"

  if contenedor_corre "$CONTENEDOR_DB"; then
    ok "$CONTENEDOR_DB corriendo"
    local estado puertos vol
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

    salida_contiene "$RED" docker inspect "$CONTENEDOR_DB" --format '{{range $k,$v := .NetworkSettings.Networks}}{{$k}} {{end}}' \
      && ok "conectado a la red $RED" || mal "no está en la red $RED"

    vol=$(docker inspect "$CONTENEDOR_DB" --format '{{range .Mounts}}{{.Name}}:{{.Destination}} {{end}}')
    [[ -n "$vol" ]] && ok "volumen $vol" || mal "sin volumen: los datos se pierden al recrear"
  else
    mal "$CONTENEDOR_DB NO está corriendo"
  fi

  # ── 5 · La base ───────────────────────────────────────────────────────────
  #
  # Se consulta con el usuario administrativo del `.env`, sin imprimirlo. `psql`
  # corre **dentro** del contenedor de la base: no hace falta cliente en el host.

  titulo "5 · Esquema, roles y aislamiento"

  local DB ADMIN
  DB="$(leer_env POSTGRES_DB)";     DB="${DB:-aai}"
  ADMIN="$(leer_env POSTGRES_USER)"; ADMIN="${ADMIN:-nexo_admin}"

  # La contraseña se pasa **por nombre**, no por valor.
  #
  # `docker exec -e PGPASSWORD=secreto` deja el secreto en los argumentos del
  # proceso, y `ps` los muestra a cualquiera que pueda leerlos. Con `-e PGPASSWORD`
  # a secas, Docker la toma del entorno de este script y nunca aparece en argv.
  PGPASSWORD="$(leer_env POSTGRES_PASSWORD)"
  export PGPASSWORD

  consulta() {
    docker exec -e PGPASSWORD "$CONTENEDOR_DB" \
      psql -U "$ADMIN" -d "$DB" -tAc "$1" 2>/dev/null
  }

  local aplicadas disco MIGRACIONES_ANTES="" ULTIMA_ANTES=""
  if [[ "$(consulta 'SELECT 1')" == "1" ]]; then
    ok "conexión administrativa a «$DB»"

    aplicadas=$(consulta 'SELECT count(*) FROM schema_migrations')
    MIGRACIONES_ANTES="$aplicadas"
    ULTIMA_ANTES=$(consulta 'SELECT name FROM schema_migrations ORDER BY name DESC LIMIT 1')
    disco=$(ls infrastructure/db/migrations/*.sql 2>/dev/null | wc -l)
    info "migraciones aplicadas $aplicadas (última: ${ULTIMA_ANTES:-ninguna}); en el repositorio $disco; en la imagen $n_mig"

    if [[ "$AUDITAR" -eq 1 ]]; then
      if [[ "$aplicadas" == "$disco" ]]; then
        ok "migraciones al día: $aplicadas de $disco"
      else
        aviso "aplicadas $aplicadas, en disco $disco"
      fi
    elif [[ "$disco" != "$n_mig" ]]; then
      abortar "el repositorio tiene $disco migraciones y la imagen $n_mig: la imagen no es la de este commit"
    fi

    # El rol con el que conecta la aplicación. Un superusuario acá haría que RLS
    # no se aplique a ninguna consulta escrita fuera de los envoltorios.
    # Se piden como enteros y no como booleanos, a propósito.
    #
    # `psql -tA` imprime `t`/`f` cuando la columna sale sola, y `true`/`false`
    # cuando se la concatena —porque ahí PostgreSQL la castea a texto—. Comparar
    # contra una de las dos formas hace que el control falle sobre un sistema
    # sano, que es la peor clase de rojo: enseña a ignorarlo. Con `::int` hay una
    # sola representación posible.
    #
    # Con `concat()` y no con `||`: PostgreSQL **no tiene** operador `integer ||
    # integer`, así que la consulta erraba, el error se iba por stderr y el
    # control informaba «no existe el rol nexo_app» sobre un rol que estaba ahí.
    # Un control que se equivoca de diagnóstico es peor que uno que no existe.
    local attrs miembro bypass sin_rls
    attrs=$(consulta "SELECT concat(rolcanlogin::int, rolsuper::int, rolbypassrls::int) FROM pg_roles WHERE rolname='nexo_app'")
    if [[ "$attrs" == "100" ]]; then
      ok "nexo_app: LOGIN, NOSUPERUSER, NOBYPASSRLS"
    elif [[ -z "$attrs" ]]; then
      mal "no existe el rol nexo_app"
    else
      mal "nexo_app: login/super/bypassrls = $attrs (se esperaba 100)"
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

  # ── 6 · Documentos ────────────────────────────────────────────────────────

  titulo "6 · Almacén de documentos"

  local DOCS="${RAIZ}/var/documents"
  if [[ "$AUDITAR" -eq 0 && "$FALLOS" -eq 0 ]]; then
    mkdir -p "$DOCS"
    # `node` es uid 1000 en la imagen oficial. Sin esto, el contenedor no puede
    # escribir y la subida de un comprobante falla con EACCES.
    chown -R 1000:1000 "$DOCS" 2>/dev/null || aviso "no se pudo cambiar el dueño de $DOCS"
    chmod 750 "$DOCS"
  fi
  if [[ -d "$DOCS" ]]; then
    # El dueño se informa **numérico**: `%U` intenta resolver el uid contra los
    # usuarios del host y muestra `UNKNOWN` para el 1000 del contenedor, que es
    # correcto y se lee como un problema.
    ok "$DOCS (uid:gid $(stat -c '%u:%g' "$DOCS"), permisos $(stat -c '%a' "$DOCS"), $(find "$DOCS" -type f 2>/dev/null | wc -l) archivo(s))"
    [[ "$(stat -c '%u' "$DOCS")" == "1000" ]] && ok "pertenece al uid 1000, que es 'node' en la imagen" \
                                              || mal "el uid no es 1000: el contenedor no va a poder escribir"
  else
    mal "no existe $DOCS"
  fi

  # ── 7 · Servicio ──────────────────────────────────────────────────────────

  titulo "7 · Servicio"

  [[ -f "$COMPOSE" ]] || { mal "falta $COMPOSE"; exit 1; }
  armar_archivos_compose

  if [[ "$AUDITAR" -eq 0 ]]; then
    # ── La puerta: nada de lo que sigue es gratis ───────────────────────────
    [[ "$FALLOS" -gt 0 ]] && abortar "hay $FALLOS comprobación(es) en rojo: no se hace la copia, no se migra y no se levanta la imagen nueva"

    titulo "7.1 · Copia de resguardo, verificada, antes de tocar nada"

    local salida_respaldo estado_respaldo RESPALDO_ARCHIVO RESPALDO_SHA256 RESPALDO_PRUEBA
    salida_respaldo=$(NEXO_ENV_FILE="$ENV_FILE" NEXO_BACKUP_DIR="${RAIZ}/var/backups" \
                        bash "${RAIZ}/infrastructure/systemd/respaldar.sh" --etiqueta "predeploy-${BUILD_ID}" --verificar-restauracion 2>&1)
    estado_respaldo=$?
    printf '%s\n' "$salida_respaldo" | grep -v '^RESPALDO_' | sed 's/^/    /'
    [[ "$estado_respaldo" -eq 0 ]] || abortar "la copia de resguardo falló (código $estado_respaldo): sin copia verificada no se toca producción"

    RESPALDO_ARCHIVO=$(printf '%s\n' "$salida_respaldo" | grep '^RESPALDO_ARCHIVO=' | tail -1 | cut -d= -f2-)
    RESPALDO_SHA256=$(printf '%s\n' "$salida_respaldo" | grep '^RESPALDO_SHA256=' | tail -1 | cut -d= -f2-)
    RESPALDO_PRUEBA=$(printf '%s\n' "$salida_respaldo" | grep '^RESPALDO_RESTAURACION=' | tail -1 | cut -d= -f2-)
    [[ -n "$RESPALDO_ARCHIVO" && -n "$RESPALDO_SHA256" ]] || abortar "la copia no informó su archivo y su huella"
    [[ "$RESPALDO_PRUEBA" == "ok" ]] || abortar "la copia no se probó restaurándola (estado: ${RESPALDO_PRUEBA:-ninguno}): una copia sin restaurar es una hipótesis"
    ok "copia verificada y restaurada: $RESPALDO_ARCHIVO"

    # ── El registro, ANTES de lo irreversible ───────────────────────────────
    mkdir -p "$REGISTRO"
    local sello
    sello=$(date -u +%Y%m%dT%H%M%SZ)
    {
      printf 'FECHA=%s\n' "$sello"
      printf 'COMMIT_NUEVO=%s\n' "$(git rev-parse HEAD)"
      printf 'COMMIT_SERVIDOR_ANTES=%s\n' "$HEAD_ANTES"
      printf 'VERSION_ANTERIOR=%s\n' "$VERSION_ANTERIOR"
      printf 'IMAGEN_ANTERIOR_TAG=%s\n' "$IMAGEN_ANTERIOR_TAG"
      printf 'IMAGEN_ANTERIOR_ID=%s\n' "$IMAGEN_ANTERIOR_ID"
      printf 'RESPALDO_ARCHIVO=%s\n' "$RESPALDO_ARCHIVO"
      printf 'RESPALDO_SHA256=%s\n' "$RESPALDO_SHA256"
      printf 'MIGRACIONES_ANTES=%s\n' "$MIGRACIONES_ANTES"
      printf 'ULTIMA_MIGRACION_ANTES=%s\n' "$ULTIMA_ANTES"
    } > "$REGISTRO/ultimo.env"
    chmod 600 "$REGISTRO/ultimo.env"
    cp "$REGISTRO/ultimo.env" "$REGISTRO/${sello}.env"
    ok "registro del despliegue en $REGISTRO/ultimo.env"

    # ── Migraciones ─────────────────────────────────────────────────────────
    titulo "7.2 · Migraciones (contenedor aparte, nunca el que sirve)"

    aplicadas=$(consulta 'SELECT count(*) FROM schema_migrations')
    if [[ "$aplicadas" == "$n_mig" ]]; then
      ok "migraciones al día: $aplicadas de $n_mig"
    elif [[ "$aplicadas" =~ ^[0-9]+$ && "$aplicadas" -gt "$n_mig" ]]; then
      aviso "la base tiene $aplicadas migraciones y la imagen $n_mig: la imagen es más vieja que la base; no se migra"
    else
      PRODUCCION_TOCADA=1
      # Mismo cuidado que arriba: la cadena de conexión **se arma adentro** del
      # contenedor a partir de variables pasadas por nombre. Construirla acá la
      # dejaría, con contraseña incluida, en los argumentos de `docker run`.
      #
      # ## La contraseña se codifica, y esto costó un despliegue
      #
      # Una contraseña se pega en una URL y una URL tiene sintaxis. La de esta
      # instalación es de 48 caracteres en base64 y contiene `/` y `+`; pegada
      # cruda produce `postgresql://usuario:cla/ve@host:5432/base`, donde la
      # barra corta el `userinfo` y `pg-connection-string` contesta
      # `ERR_INVALID_URL` sin poder decir por qué —el `input` viene redactado,
      # justamente porque lleva la credencial—.
      #
      # Medido el 2026-09-15: el paso de migraciones falló, la imagen nueva
      # levantó contra un esquema viejo, el arranque se negó a servir —lo
      # correcto— y producción quedó abajo.
      #
      # ## Desde la imagen, no desde un montaje del repositorio
      #
      # Antes se montaba `/opt/nexo` como `/repo` y se ejecutaba `migrate.mjs` desde
      # ahí: el `import pg` se resuelve desde el directorio del script, y en el host
      # no hay `node_modules`. Ahora corre el `migrate.mjs` de la propia imagen, con
      # las migraciones de la propia imagen: el mismo comando que se ensayó contra la
      # copia de producción, y lo que se migra es exactamente lo que se despliega.
      info "migrando de $aplicadas a $n_mig..."
      local salida_migra estado_migra
      salida_migra=$(PGUSER="$ADMIN" PGDB="$DB" PGHOST="$CONTENEDOR_DB" \
        docker run --rm --network "$RED" \
          -e PGPASSWORD -e PGUSER -e PGDB -e PGHOST \
          --entrypoint sh "$IMAGEN" \
          -c 'CLAVE=$(node -e "process.stdout.write(encodeURIComponent(process.env.PGPASSWORD))"); DATABASE_URL="postgresql://${PGUSER}:${CLAVE}@${PGHOST}:5432/${PGDB}" node scripts/migrate.mjs up' 2>&1)
      estado_migra=$?
      printf '%s\n' "$salida_migra" | tail -8 | sed 's/^/      /'
      [[ "$estado_migra" -eq 0 ]] || abortar "las migraciones fallaron (código $estado_migra)"
      aplicadas=$(consulta 'SELECT count(*) FROM schema_migrations')
      [[ "$aplicadas" == "$n_mig" ]] || abortar "después de migrar hay $aplicadas de $n_mig migraciones"
      ok "migraciones al día: $aplicadas de $n_mig"
    fi
    printf 'MIGRACIONES_DESPUES=%s\n' "$aplicadas" >> "$REGISTRO/ultimo.env"

    # ── Levantar ────────────────────────────────────────────────────────────
    [[ "$FALLOS" -gt 0 ]] && abortar "hay comprobaciones en rojo: no se levanta la imagen nueva"
    PRODUCCION_TOCADA=1
    info "levantando la versión ${BUILD_ID}..."
    BUILD_ID="$BUILD_ID" docker compose "${ARCHIVOS_COMPOSE[@]}" up -d 2>&1 | sed 's/^/      /'
    info "esperando a que la sonda pase..."
    esperar_sonda || true
  fi

  if contenedor_corre "$CONTENEDOR_APP"; then
    ok "$CONTENEDOR_APP corriendo"
    local salud pol u p ro marca cuerpo
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

    # La persistencia, probada y no supuesta.
    #
    # Que el directorio exista y esté montado no prueba que el contenedor pueda
    # escribir: corre como `node` con el rootfs de solo lectura, así que una
    # escritura mal permisada falla con EACCES y una ruta fuera del volumen falla
    # con EROFS. Las dos aparecerían recién al subir el primer comprobante.
    marca="/app/var/documents/.escritura-$(date +%s)"
    if docker exec "$CONTENEDOR_APP" sh -c "printf ok > '$marca'" 2>/dev/null; then
      if [[ -f "${DOCS}/$(basename "$marca")" ]]; then
        ok "el contenedor escribe en el volumen, y el archivo aparece en el host"
        rm -f "${DOCS}/$(basename "$marca")"
      else
        mal "el contenedor escribió pero el archivo no está en $DOCS: el montaje no es el que se cree"
      fi
    else
      mal "el contenedor NO puede escribir en /app/var/documents (permisos o rootfs)"
    fi

    # Y que el resto del sistema de archivos siga cerrado: es lo que promete
    # `read_only`, y de eso depende que una escritura mal dirigida se note acá y
    # no en producción.
    if docker exec "$CONTENEDOR_APP" sh -c 'printf x > /app/prueba-rofs' 2>/dev/null; then
      mal "el contenedor pudo escribir fuera del volumen: read_only no está aplicando"
      docker exec "$CONTENEDOR_APP" rm -f /app/prueba-rofs 2>/dev/null
    else
      ok "fuera del volumen no se puede escribir (read_only aplicando)"
    fi

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

  # ── 8 · Traefik ───────────────────────────────────────────────────────────

  titulo "8 · Traefik y publicación"

  local nombre modo ip redir db emisor
  local lista_contenedores
  lista_contenedores=$(docker ps --format '{{.Names}}\t{{.Image}}' 2>/dev/null) || lista_contenedores=""
  if grep -qi traefik <<<"$lista_contenedores"; then
    nombre=$(grep -i traefik <<<"$lista_contenedores" | head -1 | cut -f1)
    ok "Traefik corriendo ($nombre)"

    # Cómo llega Traefik a NEXO depende de su modo de red, y las dos formas son
    # válidas. La primera versión de este control exigía que Traefik estuviera
    # **en** la red `nexo` y daba rojo sobre un sistema que funcionaba: este
    # Traefik corre con `network_mode: host`, así que no está en ninguna red de
    # Docker y alcanza los contenedores por su IP del puente.
    #
    # Lo que importa no es dónde está, es si llega. Así que se comprueba eso.
    modo=$(docker inspect "$nombre" --format '{{.HostConfig.NetworkMode}}')
    info "modo de red: $modo"

    if [[ "$modo" == "host" ]]; then
      ip=$(docker inspect "$CONTENEDOR_APP" --format "{{.NetworkSettings.Networks.${RED}.IPAddress}}" 2>/dev/null)
      local sonda_traefik=""
      [[ -n "$ip" ]] && sonda_traefik=$(curl -sS --max-time 8 "http://${ip}:3001/health" 2>/dev/null)
      if [[ -n "$ip" ]] && grep -q '"status":"ok"' <<<"$sonda_traefik"; then
        ok "Traefik llega a NEXO por la IP del puente ($ip)"
      else
        mal "Traefik está en modo host y NO alcanza a NEXO en ${ip:-sin IP}:3001"
      fi
    else
      salida_contiene "$RED" docker inspect "$nombre" --format '{{range $k,$v := .NetworkSettings.Networks}}{{$k}} {{end}}' \
        && ok "Traefik está en la red $RED" \
        || mal "Traefik NO está en la red $RED ni en modo host: no puede llegar"
    fi
  else
    mal "no se encontró un contenedor de Traefik"
  fi

  info "dominio: $DOMINIO"

  # El ruteo se prueba **sin depender del DNS**, con la cabecera `Host`.
  #
  # Es la comprobación que faltaba: sin dominio no se puede pedir la URL, pero sí
  # se puede pedirle a Traefik, en el propio servidor, que enrute como si el
  # nombre resolviera. Eso ejercita la cadena entera —entrypoint, enrutador,
  # servicio, red, contenedor— y deja afuera solo el DNS y el certificado.
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

  # ── Resumen ───────────────────────────────────────────────────────────────

  titulo "Resumen"
  printf '  fallos: %s   avisos: %s\n\n' "$FALLOS" "$AVISOS"

  if [[ "$FALLOS" -gt 0 ]]; then
    printf '  \033[31mHay %s comprobación(es) en rojo.\033[0m Cada una dice qué falta.\n' "$FALLOS"
    if [[ "$AUDITAR" -eq 0 ]]; then
      printf '  Para volver a la versión anterior de la aplicación:  bash scripts/desplegar.sh --revertir\n'
    fi
    printf '\n'
    return 1
  fi
  printf '  \033[32mTodo lo verificable pasó.\033[0m\n'
  if [[ "$AUDITAR" -eq 0 ]]; then
    printf '  Versión desplegada: %s · anterior conservada como %s\n' "$BUILD_ID" "${IMAGEN_ANTERIOR_TAG:-(ninguna)}"
    printf '  Para volver atrás:  bash scripts/desplegar.sh --revertir\n'
  fi
  printf '\n'
  return 0
}

principal "$@"; exit $?
