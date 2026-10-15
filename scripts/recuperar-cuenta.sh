#!/usr/bin/env bash
# ============================================================================
# Recuperar una cuenta a mano, EN EL SERVIDOR
# ============================================================================
#
#   bash scripts/recuperar-cuenta.sh ver --email persona@empresa.com
#   bash scripts/recuperar-cuenta.sh segundo-factor --email … --motivo "…" --verificacion "…"            (simulacro)
#   bash scripts/recuperar-cuenta.sh segundo-factor --email … --motivo "…" --verificacion "…" --confirmar
#   bash scripts/recuperar-cuenta.sh correo --email actual@… --nuevo nuevo@… --motivo "…" --verificacion "…" [--confirmar]
#
# Corre `scripts/recuperar-cuenta.mjs` DENTRO de la imagen `nexo:production`, con el mismo patrón que `cobro-manual.sh` y las
# tareas diarias: red de NEXO, `--env-file`, sistema de archivos de sólo lectura, sin privilegios nuevos. La contraseña de la
# base se arma dentro del contenedor y nunca aparece en los argumentos del proceso. No monta ningún archivo del servidor.
#
# Qué hace y cuándo se usa: docs/legal/PROCEDIMIENTO_RECUPERACION_DE_CUENTA.md. La verificación de identidad la hace una
# persona ANTES de correr esto; acá sólo se escribe cómo.
#
# Requiere que la imagen desplegada YA traiga `scripts/recuperar-cuenta.mjs`.

set -uo pipefail

RAIZ="${NEXO_RAIZ:-/opt/nexo}"
IMAGEN="${NEXO_IMAGEN:-nexo:production}"

[[ $# -ge 1 ]] || { echo "uso: bash scripts/recuperar-cuenta.sh ver|segundo-factor|correo [opciones]" >&2; exit 2; }
[[ -f "$RAIZ/.env" ]] || { echo "falta $RAIZ/.env" >&2; exit 2; }

exec docker run --rm -i \
  --network nexo \
  --env-file "$RAIZ/.env" \
  --env NODE_ENV=production \
  --read-only --tmpfs /tmp:size=16m,mode=1777 \
  --security-opt no-new-privileges:true \
  --entrypoint sh \
  "$IMAGEN" \
  -c 'CLAVE=$(node -e "process.stdout.write(encodeURIComponent(process.env.POSTGRES_PASSWORD))"); export DATABASE_URL="postgresql://${POSTGRES_USER}:${CLAVE}@nexo-postgres:5432/${POSTGRES_DB}"; exec node scripts/recuperar-cuenta.mjs "$@"' \
  sh "$@"
