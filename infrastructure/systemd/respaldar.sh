#!/usr/bin/env bash
# ============================================================================
# La copia de resguardo diaria de NEXO
# ============================================================================
#
#   ./respaldar.sh              # saca la copia, la verifica y poda las viejas
#   ./respaldar.sh --ver        # dice qué hay y qué haría, sin escribir ni borrar
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
# Tres cosas, y la segunda es la que suele faltar:
#
#   1. escribir el volcado;
#   2. **abrirlo y comprobar que se puede leer**. Un archivo que `pg_dump` dejó a
#      medias —disco lleno, contenedor matado— pesa y existe, y se ve igual que
#      uno bueno hasta el día que hace falta. Acá se lo pasa por `pg_restore
#      --list`: si no se puede leer su índice, no es una copia, y el archivo se
#      borra en vez de quedar dando una seguridad que no da;
#   3. podar las viejas, con una regla escrita.
#
# ## La poda solo toca lo automático
#
# Los archivos que saca este script terminan en `-auto.dump`. Los que saca una
# persona antes de un despliegue terminan en otra cosa —`-pre0124.dump`— y la
# poda **nunca los mira**. Es a propósito: el día del incidente, la copia que
# alguien tomó a mano antes de tocar algo es la más valiosa que hay, y sería la
# primera en caer bajo una retención por antigüedad.
#
# La retención se cuenta en **copias**, no en días: si el timer estuvo caído una
# semana, contar días borraría las que quedan justo cuando son lo único que hay.
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

SOLO_VER=0
[[ "${1:-}" == "--ver" ]] && SOLO_VER=1

ok()   { printf '  \033[32m✔\033[0m %s\n' "$*"; }
mal()  { printf '  \033[31m✘\033[0m %s\n' "$*"; }
info() { printf '    %s\n' "$*"; }

printf '\n══ Copia de resguardo de NEXO ═══════════════════════════════\n\n'

# ── 1 · Lo que tiene que estar ──────────────────────────────────────────────

command -v docker >/dev/null || { mal "no hay docker"; exit 1; }
docker inspect "$CONTENEDOR_DB" >/dev/null 2>&1 || { mal "no existe $CONTENEDOR_DB"; exit 1; }
[[ -r "$ENV_FILE" ]] || { mal "no se puede leer $ENV_FILE"; exit 1; }

# El contenido NO se imprime nunca. `set -a` las exporta para el `docker exec`.
set -a
# shellcheck disable=SC1090
. "$ENV_FILE"
set +a

for variable in POSTGRES_USER POSTGRES_PASSWORD POSTGRES_DB; do
  [[ -n "${!variable:-}" ]] || { mal "$ENV_FILE no declara $variable"; exit 1; }
done

mkdir -p "$DESTINO"

# ── 2 · Qué hay hoy ─────────────────────────────────────────────────────────

automaticas=$(find "$DESTINO" -maxdepth 1 -name '*-auto.dump' -type f 2>/dev/null | wc -l)
manuales=$(find "$DESTINO" -maxdepth 1 -name '*.dump' -type f 2>/dev/null | grep -vc -- '-auto.dump$' || true)
info "destino     $DESTINO"
info "retención   $RETENER copias automáticas (las manuales no se podan nunca)"
info "hay         $automaticas automática(s) y $manuales manual(es)"
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

# ── 3 · El volcado ──────────────────────────────────────────────────────────

SELLO=$(date -u +%Y%m%dT%H%M%SZ)
ARCHIVO="$DESTINO/${POSTGRES_DB}-${SELLO}-auto.dump"

# Un archivo con el mismo nombre solo puede venir de dos corridas en el mismo
# segundo. No se sobrescribe: una copia de resguardo que pisa otra es lo
# contrario de una copia de resguardo.
[[ -e "$ARCHIVO" ]] && { mal "ya existe $ARCHIVO — no se sobrescribe"; exit 1; }

# `-e PGPASSWORD` sin valor pasa la del entorno: con `PGPASSWORD=secreto` el
# secreto quedaría en los argumentos del proceso, que `ps` muestra.
if ! docker exec -e PGPASSWORD "$CONTENEDOR_DB" \
       pg_dump -U "$POSTGRES_USER" -d "$POSTGRES_DB" -Fc --no-owner --no-password \
       > "$ARCHIVO" 2>/tmp/nexo-respaldo.err; then
  mal "pg_dump falló"
  info "$(tail -3 /tmp/nexo-respaldo.err)"
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
# restaurar el día que haga falta.

if ! entradas=$(docker run --rm -i "$IMAGEN_PG" pg_restore --list < "$ARCHIVO" 2>/dev/null | wc -l) \
     || [[ "$entradas" -lt 100 ]]; then
  mal "el volcado no se puede leer (${entradas:-0} entradas en el índice)"
  info "se borra: un archivo ilegible que parece una copia es peor que no tenerla"
  rm -f "$ARCHIVO"
  exit 1
fi
ok "verificado: $entradas entradas en el índice"

# ── 5 · La poda ─────────────────────────────────────────────────────────────
#
# Por nombre exacto y en un solo directorio. Nada de `find -delete` sobre un
# patrón amplio: el día que `DESTINO` esté vacío por un error de configuración,
# un patrón amplio borra otra cosa.

borradas=0
while IFS= read -r viejo; do
  [[ -z "$viejo" ]] && continue
  rm -f -- "$viejo" && borradas=$(( borradas + 1 ))
  info "podada $(basename "$viejo")"
done < <(find "$DESTINO" -maxdepth 1 -name '*-auto.dump' -type f -printf '%T@ %p\n' 2>/dev/null \
           | sort -rn | tail -n "+$(( RETENER + 1 ))" | cut -d' ' -f2-)

if [[ "$borradas" -eq 0 ]]; then
  ok "nada que podar: $(find "$DESTINO" -maxdepth 1 -name '*-auto.dump' -type f | wc -l) de $RETENER"
else
  ok "$borradas copia(s) automática(s) podada(s); quedan $(find "$DESTINO" -maxdepth 1 -name '*-auto.dump' -type f | wc -l)"
fi

printf '\n'
ok "copia del día lista"
info "$ARCHIVO"
printf '\n  Una copia que nunca se restauró sigue siendo una hipótesis.\n'
printf '  El ensayo de restauración se hace aparte: docs/OPERACION.md\n\n'
