#!/usr/bin/env bash
# ============================================================================
# Cobro manual por transferencia, EN EL SERVIDOR
# ============================================================================
#
#   bash scripts/cobro-manual.sh pendientes
#   bash scripts/cobro-manual.sh conciliar --extracto /ruta/movimientos.csv
#   bash scripts/cobro-manual.sh registrar --documento 12 --importe 3000.00 --fecha 2026-11-03 --referencia 0123456789
#   bash scripts/cobro-manual.sh registrar … --confirmar
#   bash scripts/cobro-manual.sh comprobante --documento 12 > comprobante-12.txt
#
# Corre `scripts/cobro-manual.mjs` DENTRO de la imagen `nexo:production`, con el mismo patrón que las tareas diarias
# (`infrastructure/systemd/nexo-diario.service`): red de NEXO, `--env-file`, sistema de archivos de sólo lectura, sin
# privilegios nuevos. La contraseña de la base se arma dentro del contenedor y nunca aparece en los argumentos del proceso.
#
# Requiere que la imagen desplegada YA traiga `scripts/cobro-manual.mjs` (entra con el próximo despliegue).
# El único archivo que se monta es el extracto, y de sólo lectura.

set -uo pipefail

RAIZ="${NEXO_RAIZ:-/opt/nexo}"
IMAGEN="${NEXO_IMAGEN:-nexo:production}"

[[ $# -ge 1 ]] || { echo "uso: bash scripts/cobro-manual.sh pendientes|conciliar|registrar|comprobante [opciones]" >&2; exit 2; }
[[ -f "$RAIZ/.env" ]] || { echo "falta $RAIZ/.env" >&2; exit 2; }

args=()
montajes=()
while [[ $# -gt 0 ]]; do
  case "$1" in
    --extracto)
      [[ -f "${2:-}" ]] || { echo "no encuentro el extracto: ${2:-}" >&2; exit 2; }
      montajes+=(-v "$(realpath "$2"):/tmp/extracto.csv:ro")
      args+=(--extracto /tmp/extracto.csv)
      shift 2 ;;
    --salida)
      echo "--salida no se usa en el servidor: redirigí la salida (> archivo)." >&2; exit 2 ;;
    *) args+=("$1"); shift ;;
  esac
done

exec docker run --rm -i \
  --network nexo \
  --env-file "$RAIZ/.env" \
  --env NODE_ENV=production \
  --read-only --tmpfs /tmp:size=16m,mode=1777 \
  --security-opt no-new-privileges:true \
  ${montajes[@]+"${montajes[@]}"} \
  --entrypoint sh \
  "$IMAGEN" \
  -c 'CLAVE=$(node -e "process.stdout.write(encodeURIComponent(process.env.POSTGRES_PASSWORD))"); export DATABASE_URL="postgresql://${POSTGRES_USER}:${CLAVE}@nexo-postgres:5432/${POSTGRES_DB}"; exec node scripts/cobro-manual.mjs "$@"' \
  sh "${args[@]}"
