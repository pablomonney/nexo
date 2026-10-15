#!/usr/bin/env bash
# ============================================================================
# La copia de resguardo de NEXO
# ============================================================================
#
#   ./respaldar.sh                                  # copia diaria: la saca, la verifica y poda las viejas
#   ./respaldar.sh --ver                            # dice qué hay y qué haría, sin escribir ni borrar
#   ./respaldar.sh --etiqueta predeploy-8d867d3 --verificar-restauracion
#                                                   # copia a mano (nunca se poda) y PRUEBA restaurarla
#
# ## Por qué esto y no `npm run db:backup`
#
# `scripts/backup-db.mjs` existe y está bien escrito, pero necesita `pg_dump` en
# el PATH. En el host no está, y en la imagen de NEXO tampoco: es `node:22-alpine`
# y meterle el cliente de PostgreSQL la engordaría para un solo script.
#
# `pg_dump` es una herramienta de PostgreSQL, así que se la corre desde la imagen
# de PostgreSQL — la **misma versión mayor que el servidor**, que es la condición
# que `pg_dump` pide para poder leer el catálogo. De ahí que este sea el único de
# los cuatro timers que no usa `nexo:production`.
#
# ## Qué hace una copia de resguardo de verdad
#
# Cuatro cosas, y las dos últimas son las que suelen faltar:
#
#   1. escribir el volcado;
#   2. **abrirlo y comprobar que se puede leer**. Un archivo que `pg_dump` dejó a
#      medias —disco lleno, contenedor matado— pesa y existe, y se ve igual que
#      uno bueno hasta el día que hace falta. Acá se lo pasa por `pg_restore
#      --list`: si no se puede leer su índice, no es una copia, y el archivo se
#      borra en vez de quedar dando una seguridad que no da;
#   3. **dejar su huella**: un `.sha256` al lado, para poder demostrar después que
#      el archivo que se restaura es el que se sacó;
#   4. con `--verificar-restauracion`, **restaurarlo de verdad** en una base
#      descartable y comparar filas contra la base viva. Que el índice se lea no
#      prueba que los datos estén.
#
# ## La comparación de filas, y por qué es un rango y no una igualdad
#
# La base viva sigue recibiendo escrituras mientras se saca la copia. Se cuentan
# las filas de cada tabla **antes** y **después** del volcado; el volcado es una
# foto coherente tomada entre las dos, así que la restauración tiene que quedar
# entre ambos conteos. Exigir igualdad exacta daría falsos rojos en una base viva;
# no exigir nada daría una prueba que no prueba.
#
# La base descartable se llama `aai_restauracion_verif_<sello>`, se crea y se borra
# acá, y el borrado está protegido por ese nombre: nunca toca otra base.
#
# ## La poda solo toca lo automático
#
# Los archivos que saca la corrida diaria terminan en `-auto.dump`. Los que saca una
# persona antes de un despliegue llevan otra etiqueta —`-predeploy-8d867d3.dump`— y
# la poda **nunca los mira**. Es a propósito: el día del incidente, la copia que
# alguien tomó a mano antes de tocar algo es la más valiosa que hay, y sería la
# primera en caer bajo una retención por antigüedad.
#
# La retención se cuenta en **copias**, no en días: si el timer estuvo caído una
# semana, contar días borraría las que quedan justo cuando son lo único que hay.
#
# ## El `.env` no se ejecuta
#
# Antes este guion hacía `. .env`. Eso **ejecuta** el archivo como shell: un valor
# sin comillas con `<`, `>` o espacios (`EMAIL_FROM=NEXO <no-reply@…>`) es un error
# de sintaxis, y todo lo declarado después de esa línea se pierde en silencio. Acá
# se leen solo las tres variables que hacen falta, como texto, sin interpretar nada.
# El archivo no se toca: lo leen también Compose y `docker run --env-file`, que no
# procesan las comillas de la misma manera.
#
# Salida legible por máquina (las usa `scripts/desplegar.sh`): líneas
# `RESPALDO_ARCHIVO=…`, `RESPALDO_SHA256=…` y `RESPALDO_RESTAURACION=…`.
# ============================================================================

set -uo pipefail

readonly DESTINO="${NEXO_BACKUP_DIR:-/opt/nexo/var/backups}"
readonly ENV_FILE="${NEXO_ENV_FILE:-/opt/nexo/.env}"
readonly CONTENEDOR_DB="${NEXO_DB_CONTAINER:-nexo-postgres}"

# La imagen tiene que ser la MISMA versión mayor que el servidor: `pg_dump` se
# niega a volcar una base de un servidor más nuevo que él.
readonly IMAGEN_PG="${NEXO_PG_IMAGE:-postgres:18-alpine}"

# Cuántas copias automáticas se conservan. Dos semanas de copias diarias.
#
# El número está acá y no en una variable de entorno sin declarar porque es una
# decisión de conservación, y una decisión que vive solo en el entorno del
# servidor no se puede revisar leyendo el repositorio.
readonly RETENER="${NEXO_BACKUP_RETENER:-14}"

ok()   { printf '  \033[32m✔\033[0m %s\n' "$*"; }
mal()  { printf '  \033[31m✘\033[0m %s\n' "$*"; }
info() { printf '    %s\n' "$*"; }

uso() {
  printf 'uso: respaldar.sh [--ver] [--etiqueta <texto>] [--verificar-restauracion]\n'
  printf '  --ver                      dice qué hay y qué haría; no escribe ni borra\n'
  printf '  --etiqueta <texto>         copia a mano: [a-z0-9.-], se guarda como …-<texto>.dump y nunca se poda\n'
  printf '  --verificar-restauracion   la restaura en una base descartable y compara filas con la viva\n'
}

SOLO_VER=0
ETIQUETA=auto
VERIFICAR_RESTAURACION=0
while (( $# > 0 )); do
  case "$1" in
    --ver) SOLO_VER=1 ;;
    --etiqueta) shift; ETIQUETA="${1:-}" ;;
    --etiqueta=*) ETIQUETA="${1#--etiqueta=}" ;;
    --verificar-restauracion) VERIFICAR_RESTAURACION=1 ;;
    --ayuda|-h|--help) uso; exit 0 ;;
    *) printf 'argumento desconocido: %s\n' "$1" >&2; uso >&2; exit 2 ;;
  esac
  shift
done

# La etiqueta termina dentro de un nombre de archivo y de un patrón de poda: se
# acepta solo lo que no puede escapar de ahí.
if ! [[ "$ETIQUETA" =~ ^[a-z0-9][a-z0-9.-]{0,60}$ ]]; then
  printf 'etiqueta no válida: «%s» (se permite [a-z0-9.-], hasta 61 caracteres)\n' "$ETIQUETA" >&2
  exit 2
fi

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

printf '\n══ Copia de resguardo de NEXO ═══════════════════════════════\n\n'

# ── 1 · Lo que tiene que estar ──────────────────────────────────────────────

command -v docker >/dev/null || { mal "no hay docker"; exit 1; }
docker inspect "$CONTENEDOR_DB" >/dev/null 2>&1 || { mal "no existe $CONTENEDOR_DB"; exit 1; }
[[ -r "$ENV_FILE" ]] || { mal "no se puede leer $ENV_FILE"; exit 1; }

# El contenido NO se imprime nunca. Solo la contraseña se exporta, y se pasa a
# Docker **por nombre** (`-e PGPASSWORD`), no por valor.
POSTGRES_USER=$(leer_env POSTGRES_USER)
POSTGRES_DB=$(leer_env POSTGRES_DB)
PGPASSWORD=$(leer_env POSTGRES_PASSWORD)
export PGPASSWORD
for variable in POSTGRES_USER POSTGRES_DB PGPASSWORD; do
  [[ -n "${!variable:-}" ]] || { mal "$ENV_FILE no declara ${variable/PGPASSWORD/POSTGRES_PASSWORD}"; exit 1; }
done

mkdir -p "$DESTINO"

# ── 2 · Qué hay hoy ─────────────────────────────────────────────────────────

automaticas=$(find "$DESTINO" -maxdepth 1 -name '*-auto.dump' -type f 2>/dev/null | wc -l)
manuales=$(find "$DESTINO" -maxdepth 1 -name '*.dump' -type f 2>/dev/null | grep -vc -- '-auto.dump$' || true)
info "destino     $DESTINO"
info "retención   $RETENER copias automáticas (las manuales no se podan nunca)"
info "hay         $automaticas automática(s) y $manuales manual(es)"
info "etiqueta    $ETIQUETA$([[ "$ETIQUETA" != auto ]] && printf ' (copia manual: no entra en la poda)')"
libre=$(df -h "$DESTINO" | tail -1 | awk '{print $4}')
info "libre       $libre"
printf '\n'

if [[ "$SOLO_VER" -eq 1 ]]; then
  sobran=$(( automaticas + 1 - RETENER ))
  (( sobran > 0 )) && info "una corrida real podaría $sobran copia(s)" || info "una corrida real no podaría ninguna"
  find "$DESTINO" -maxdepth 1 -name '*.dump' -type f -printf '    %TY-%Tm-%Td %TH:%TM  %8s  %f\n' 2>/dev/null | sort | tail -8
  printf '\n  Modo --ver: no se escribió ni se borró nada.\n\n'
  exit 0
fi

# Las filas de cada tabla pública, una línea `tabla|n`. `query_to_xml` ejecuta el
# `count(*)` de cada una sin tener que escribir ciento sesenta consultas.
readonly SQL_CONTEO="SELECT table_name || '|' || (xpath('/row/c/text()', query_to_xml(format('SELECT count(*) AS c FROM %I.%I', table_schema, table_name), false, true, '')))[1]::text FROM information_schema.tables WHERE table_schema = 'public' AND table_type = 'BASE TABLE' ORDER BY 1"

contar_filas() {   # $1 = base
  docker exec -e PGPASSWORD "$CONTENEDOR_DB" \
    psql -U "$POSTGRES_USER" -d "$1" -X -q -At -v ON_ERROR_STOP=1 -c "$SQL_CONTEO"
}

TRABAJO=$(mktemp -d)
DESCARTABLE=""
DESCARTABLE_CREADA=0
PRUEBA_PENDIENTE=0
ARCHIVO=""

limpiar() {
  local estado=$?
  # Si se pidió probar la restauración y la corrida termina mal, la copia NO queda:
  # un archivo que se pidió verificar y no pasó la verificación no puede seguir
  # pareciendo una copia buena.
  if [[ "$PRUEBA_PENDIENTE" -eq 1 && "$estado" -ne 0 && -n "$ARCHIVO" ]]; then
    rm -f "$ARCHIVO" "$ARCHIVO.sha256"
    info "se borra la copia: se pidió probar la restauración y no pasó"
  fi
  # La base descartable se borra SIEMPRE que esta corrida la haya creado, y solo
  # esa: el nombre tiene que cumplir el patrón y no ser la base viva.
  if [[ "$DESCARTABLE_CREADA" -eq 1 && "$DESCARTABLE" =~ ^aai_restauracion_verif_[0-9a-z]+$ \
        && "$DESCARTABLE" != "$POSTGRES_DB" ]]; then
    docker exec -e PGPASSWORD "$CONTENEDOR_DB" \
      psql -U "$POSTGRES_USER" -d postgres -X -q -c "DROP DATABASE IF EXISTS \"$DESCARTABLE\" WITH (FORCE)" \
      >/dev/null 2>&1 && info "base descartable $DESCARTABLE borrada" || info "NO se pudo borrar $DESCARTABLE: borrarla a mano"
  fi
  # Los temporales se borran de a uno y por nombre: ningún borrado recursivo en este guion.
  rm -f "$TRABAJO"/antes.txt "$TRABAJO"/despues.txt "$TRABAJO"/restaurada.txt "$TRABAJO"/indice.txt \n        "$TRABAJO"/err.txt "$TRABAJO"/pg_dump.err "$TRABAJO"/restore.err
  rmdir "$TRABAJO" 2>/dev/null || true
}
trap limpiar EXIT

# ── 3 · El volcado ──────────────────────────────────────────────────────────

SELLO=$(date -u +%Y%m%dT%H%M%SZ)
ARCHIVO="$DESTINO/${POSTGRES_DB}-${SELLO}-${ETIQUETA}.dump"

# Un archivo con el mismo nombre solo puede venir de dos corridas en el mismo
# segundo. No se sobrescribe: una copia de resguardo que pisa otra es lo
# contrario de una copia de resguardo.
[[ -e "$ARCHIVO" ]] && { mal "ya existe $ARCHIVO — no se sobrescribe"; exit 1; }

if [[ "$VERIFICAR_RESTAURACION" -eq 1 ]]; then
  if ! contar_filas "$POSTGRES_DB" > "$TRABAJO/antes.txt" 2>"$TRABAJO/err.txt"; then
    mal "no se pudieron contar las filas de la base viva antes del volcado"
    info "$(tail -3 "$TRABAJO/err.txt")"
    exit 1
  fi
fi

# `-e PGPASSWORD` sin valor pasa la del entorno: con `PGPASSWORD=secreto` el
# secreto quedaría en los argumentos del proceso, que `ps` muestra.
if ! docker exec -e PGPASSWORD "$CONTENEDOR_DB" \
       pg_dump -U "$POSTGRES_USER" -d "$POSTGRES_DB" -Fc --no-owner --no-password \
       > "$ARCHIVO" 2>"$TRABAJO/pg_dump.err"; then
  mal "pg_dump falló"
  info "$(tail -3 "$TRABAJO/pg_dump.err")"
  rm -f "$ARCHIVO"
  exit 1
fi
chmod 600 "$ARCHIVO"

tamano=$(stat -c '%s' "$ARCHIVO")
ok "volcado: $(( tamano / 1024 )) KB en $(basename "$ARCHIVO")"

# ── 4 · Que se pueda leer ───────────────────────────────────────────────────
#
# El paso que convierte un archivo en una copia. Se lee el índice del volcado
# con la imagen de PostgreSQL: si `pg_restore --list` no puede, no hay nada que
# restaurar el día que haga falta. Y tiene que figurar el contenido de
# `schema_migrations`: un índice sin datos de ninguna tabla es un esquema vacío.

docker run --rm -i "$IMAGEN_PG" pg_restore --list < "$ARCHIVO" > "$TRABAJO/indice.txt" 2>/dev/null
entradas=$(wc -l < "$TRABAJO/indice.txt")
if [[ "${entradas:-0}" -lt 100 ]] || ! grep -q 'TABLE DATA public schema_migrations' "$TRABAJO/indice.txt"; then
  mal "el volcado no se puede leer (${entradas:-0} entradas en el índice)"
  info "se borra: un archivo ilegible que parece una copia es peor que no tenerla"
  rm -f "$ARCHIVO" "$ARCHIVO.sha256"
  exit 1
fi
ok "verificado: $entradas entradas en el índice, con los datos de schema_migrations"

# ── 5 · Su huella ───────────────────────────────────────────────────────────
#
# El archivo y su suma, juntos. Sin ella no hay forma de saber, el día que haga
# falta, si el que se restaura es el que se sacó o uno que se dañó en el disco.

( cd "$DESTINO" && sha256sum "$(basename "$ARCHIVO")" > "$(basename "$ARCHIVO").sha256" )
chmod 600 "$ARCHIVO.sha256"
if ! ( cd "$DESTINO" && sha256sum -c "$(basename "$ARCHIVO").sha256" >/dev/null 2>&1 ); then
  mal "la suma sha256 no coincide con el archivo recién escrito"
  rm -f "$ARCHIVO" "$ARCHIVO.sha256"
  exit 1
fi
SUMA=$(cut -d' ' -f1 "$ARCHIVO.sha256")
ok "sha256 $SUMA"

# ── 6 · Que se pueda restaurar ──────────────────────────────────────────────

RESTAURACION=omitida
if [[ "$VERIFICAR_RESTAURACION" -eq 1 ]]; then
  PRUEBA_PENDIENTE=1
  DESCARTABLE="aai_restauracion_verif_$(printf '%s' "$SELLO" | tr 'A-Z' 'a-z')"
  if ! [[ "$DESCARTABLE" =~ ^aai_restauracion_verif_[0-9a-z]+$ ]] || [[ "$DESCARTABLE" == "$POSTGRES_DB" ]]; then
    mal "nombre de base descartable no permitido: $DESCARTABLE"
    exit 1
  fi

  # Segunda toma de filas: el volcado es una foto tomada entre `antes` y `después`.
  if ! contar_filas "$POSTGRES_DB" > "$TRABAJO/despues.txt" 2>"$TRABAJO/err.txt"; then
    mal "no se pudieron contar las filas de la base viva después del volcado"
    exit 1
  fi

  existe=$(docker exec -e PGPASSWORD "$CONTENEDOR_DB" \
    psql -U "$POSTGRES_USER" -d postgres -X -q -At -c "SELECT count(*) FROM pg_database WHERE datname = '$DESCARTABLE'" 2>/dev/null)
  [[ "$existe" == "0" ]] || { mal "ya existe la base $DESCARTABLE (o no se pudo consultar)"; exit 1; }

  if ! docker exec -e PGPASSWORD "$CONTENEDOR_DB" \
         psql -U "$POSTGRES_USER" -d postgres -X -q -v ON_ERROR_STOP=1 -c "CREATE DATABASE \"$DESCARTABLE\"" >/dev/null 2>"$TRABAJO/err.txt"; then
    mal "no se pudo crear la base descartable"
    info "$(tail -3 "$TRABAJO/err.txt")"
    exit 1
  fi
  DESCARTABLE_CREADA=1

  if ! docker exec -i -e PGPASSWORD "$CONTENEDOR_DB" \
         pg_restore -U "$POSTGRES_USER" -d "$DESCARTABLE" --no-owner --no-password < "$ARCHIVO" >/dev/null 2>"$TRABAJO/restore.err"; then
    mal "pg_restore terminó con errores"
    info "$(tail -5 "$TRABAJO/restore.err")"
    exit 1
  fi
  ok "restaurada en $DESCARTABLE"

  if ! contar_filas "$DESCARTABLE" > "$TRABAJO/restaurada.txt" 2>"$TRABAJO/err.txt"; then
    mal "no se pudieron contar las filas de la restauración"
    info "$(tail -3 "$TRABAJO/err.txt")"
    exit 1
  fi

  # Cada tabla de la viva tiene que estar en la restauración, con una cantidad de
  # filas entre las dos tomas. Cualquier otra cosa es una copia que no es la base.
  informe=$(
    { sed 's/^/A|/' "$TRABAJO/antes.txt"; sed 's/^/B|/' "$TRABAJO/despues.txt"; sed 's/^/R|/' "$TRABAJO/restaurada.txt"; } \
    | awk -F'|' '
      $1 == "A" { a[$2] = $3 + 0 }
      $1 == "B" { b[$2] = $3 + 0 }
      $1 == "R" { r[$2] = $3 + 0; presente[$2] = 1 }
      END {
        tablas = 0; filas = 0; malas = 0
        for (t in a) {
          tablas++
          lo = (a[t] < b[t]) ? a[t] : b[t]; hi = (a[t] > b[t]) ? a[t] : b[t]
          if (!(t in presente))            { printf "falta en la restauración: %s\n", t; malas++; continue }
          filas += r[t]
          if (r[t] < lo || r[t] > hi)      { printf "filas fuera de rango en %s: viva %d-%d, restaurada %d\n", t, lo, hi, r[t]; malas++ }
        }
        for (t in presente) if (!(t in a)) { printf "sobra en la restauración: %s\n", t; malas++ }
        printf "RESUMEN %d %d %d\n", tablas, filas, malas
      }')
  resumen=$(printf '%s\n' "$informe" | grep '^RESUMEN ')
  read -r _ n_tablas n_filas n_malas <<< "$resumen"

  if [[ "${n_malas:-1}" -ne 0 ]] || [[ "${n_tablas:-0}" -lt 100 ]] || [[ "${n_filas:-0}" -le 0 ]]; then
    mal "la restauración NO coincide con la base viva (${n_tablas:-0} tablas, ${n_filas:-0} filas, ${n_malas:-?} diferencias)"
    printf '%s\n' "$informe" | grep -v '^RESUMEN ' | head -10 | sed 's/^/      /'
    rm -f "$ARCHIVO" "$ARCHIVO.sha256"
    info "se borra: una copia que no reproduce la base no es una copia"
    exit 1
  fi
  ok "restauración comprobada: $n_tablas tablas y $n_filas filas, todas dentro del rango de la base viva"
  RESTAURACION=ok
  PRUEBA_PENDIENTE=0
fi

# ── 7 · La poda ─────────────────────────────────────────────────────────────
#
# Por nombre exacto y en un solo directorio. Nada de `find -delete` sobre un
# patrón amplio: el día que `DESTINO` esté vacío por un error de configuración,
# un patrón amplio borra otra cosa. Y solo si esta corrida es la automática: una
# copia a mano no poda nada.

if [[ "$ETIQUETA" == auto ]]; then
  borradas=0
  while IFS= read -r viejo; do
    [[ -z "$viejo" ]] && continue
    rm -f -- "$viejo" "$viejo.sha256" && borradas=$(( borradas + 1 ))
    info "podada $(basename "$viejo")"
  done < <(find "$DESTINO" -maxdepth 1 -name '*-auto.dump' -type f -printf '%T@ %p\n' 2>/dev/null \
             | sort -rn | tail -n "+$(( RETENER + 1 ))" | cut -d' ' -f2-)

  if [[ "$borradas" -eq 0 ]]; then
    ok "nada que podar: $(find "$DESTINO" -maxdepth 1 -name '*-auto.dump' -type f | wc -l) de $RETENER"
  else
    ok "$borradas copia(s) automática(s) podada(s); quedan $(find "$DESTINO" -maxdepth 1 -name '*-auto.dump' -type f | wc -l)"
  fi
else
  ok "copia manual «$ETIQUETA»: no se poda nada y esta copia nunca se poda"
fi

printf '\n'
ok "copia lista"
info "$ARCHIVO"
printf 'RESPALDO_ARCHIVO=%s\nRESPALDO_SHA256=%s\nRESPALDO_RESTAURACION=%s\n' "$ARCHIVO" "$SUMA" "$RESTAURACION"
if [[ "$RESTAURACION" == ok ]]; then
  printf '\n  Esta copia se restauró de verdad en una base descartable y se comparó contra la viva.\n\n'
else
  printf '\n  Una copia que nunca se restauró sigue siendo una hipótesis.\n'
  printf '  Para probarla: --verificar-restauracion (o el ensayo de docs/DESPLIEGUE.md §7.7)\n\n'
fi
