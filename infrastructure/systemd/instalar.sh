#!/usr/bin/env bash
# ============================================================================
# Instala los timers de NEXO en el servidor
# ============================================================================
#
#   sudo ./instalar.sh              # comprueba, instala y habilita
#   sudo ./instalar.sh --auditar    # solo comprueba, no toca nada
#   sudo ./instalar.sh --quitar     # deshabilita y borra las unidades
#
# ## Qué instala
#
# Cuatro timers y sus servicios. Cada uno arranca un contenedor, corre una tarea
# y se borra. **No hay ningún proceso residente**: un worker vivo para tareas que
# duran segundos es un proceso más que se puede morir en silencio, y descubrirlo
# requiere mirar algo que nadie mira.
#
# Tres corren `nexo:production` porque ejecutan código de NEXO. El cuarto
# —`nexo-respaldo`— corre `pg_dump` desde la imagen de PostgreSQL, que es de
# donde sale esa herramienta. Ver `nexo-respaldo.service`.
#
# ## Por qué comprueba antes de habilitar
#
# Un timer habilitado que falla en cada corrida es peor que uno que no está: se
# ve verde en `list-timers`, llena el journal, y lo que no hace —vencer pruebas,
# avanzar la cobranza— no falla en ninguna pantalla. Las comprobaciones de abajo
# son las cuatro formas conocidas de que eso pase, y las cuatro se verifican
# corriendo la cosa de verdad, no leyendo un archivo de configuración.
# ============================================================================

set -uo pipefail

readonly ORIGEN="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
readonly DESTINO=/etc/systemd/system
readonly IMAGEN="nexo:production"
readonly RED="nexo"
readonly ENV_FILE=/opt/nexo/.env
readonly CONTENEDOR_DB="nexo-postgres"
# La misma version mayor que el servidor, que es lo que pg_dump exige.
readonly IMAGEN_PG="postgres:18-alpine"
# Solo para el mensaje final: la retencion de verdad la decide respaldar.sh.
readonly RETENER_DOC="14"
readonly UNIDADES=(nexo-pagos nexo-correo nexo-diario nexo-respaldo)

FALLOS=0
ok()    { printf '  \033[32m✔\033[0m %s\n' "$*"; }
mal()   { printf '  \033[31m✘\033[0m %s\n' "$*"; FALLOS=$((FALLOS+1)); }
aviso() { printf '  \033[33m!\033[0m %s\n' "$*"; }
info()  { printf '    %s\n' "$*"; }
titulo(){ printf '\n\033[1m── %s\033[0m\n' "$*"; }

MODO=instalar
[[ "${1:-}" == "--auditar" ]] && MODO=auditar
[[ "${1:-}" == "--quitar" ]]  && MODO=quitar

if [[ "$MODO" == "quitar" ]]; then
  titulo "Quitando los timers"
  for u in "${UNIDADES[@]}"; do
    systemctl disable --now "${u}.timer" 2>/dev/null && ok "${u}.timer deshabilitado" \
      || aviso "${u}.timer no estaba habilitado"
    rm -f "${DESTINO}/${u}.timer" "${DESTINO}/${u}.service"
  done
  systemctl daemon-reload
  ok "unidades borradas de ${DESTINO}"
  printf '\n  Las tareas dejaron de correr. La prueba de catorce días ya no vence sola\n'
  printf '  y la cobranza no avanza: es un modo degradado, no un apagado inocuo.\n\n'
  exit 0
fi

[[ "$EUID" -ne 0 && "$MODO" == "instalar" ]] && { echo "Hace falta root para escribir en ${DESTINO}."; exit 2; }

titulo "1 · Lo que tiene que estar en el servidor"

command -v systemctl >/dev/null && ok "systemd" || mal "no hay systemd en esta máquina"
command -v docker >/dev/null && ok "docker" || mal "no hay docker"
systemctl is-active docker >/dev/null 2>&1 && ok "docker corriendo" || mal "docker no está activo"

docker image inspect "$IMAGEN" >/dev/null 2>&1 \
  && ok "imagen $IMAGEN" || mal "no existe la imagen $IMAGEN — desplegá primero"

docker network inspect "$RED" >/dev/null 2>&1 \
  && ok "red $RED" || mal "no existe la red $RED"

if [[ -r "$ENV_FILE" ]]; then
  ok "$ENV_FILE legible"
  # El contenido NO se imprime. Lo único que se comprueba es que las variables
  # estén declaradas, por nombre.
  #
  # Son **dos**, y la segunda costó encontrarla. Las tareas importan
  # `apps/api/dist/config.js`, que con `NODE_ENV=production` exige
  # `MFA_ENCRYPTION_KEY` al cargarse —antes de tocar la base—. Es el único otro
  # `required()` del archivo. Sin ella el contenedor muere en la primera línea
  # con un error que habla de MFA, que no es donde nadie iría a buscar por qué
  # no se emitieron los cargos del día.
  for variable in DATABASE_URL MFA_ENCRYPTION_KEY; do
    grep -q "^${variable}=" "$ENV_FILE" \
      && ok "declara $variable" || mal "$ENV_FILE no declara $variable"
  done
else
  mal "no se puede leer $ENV_FILE"
fi

titulo "2 · Que la imagen sepa correr las tareas"

# Esto es lo que descubrió que `scripts/` no estaba en la imagen. Un timer que
# apunta a un archivo inexistente falla con «Cannot find module» cada cinco
# minutos, y en `list-timers` se ve exactamente igual que uno que anda.
for tarea in pagos-bandeja correo-bandeja tareas-diarias; do
  if docker run --rm --entrypoint sh "$IMAGEN" -c "[ -f /app/scripts/${tarea}.mjs ]" 2>/dev/null; then
    ok "scripts/${tarea}.mjs está en la imagen"
  else
    mal "scripts/${tarea}.mjs NO está en la imagen — reconstruila con el Dockerfile actual"
  fi
done

# `pg` es dependencia de producción de `@aai/db`, así que sobrevive al
# `npm prune --omit=dev`. Se comprueba y no se asume: si algún día se mueve a
# devDependencies, los tres scripts dejan de arrancar y el síntoma aparece en
# producción, de noche.
if docker run --rm --entrypoint node "$IMAGEN" -e "import('pg').then(()=>process.exit(0),()=>process.exit(1))" 2>/dev/null; then
  ok "el módulo pg está en la imagen"
else
  mal "la imagen no tiene pg: los scripts no van a poder conectarse"
fi

titulo "3 · Una tarea de verdad, con la credencial real del timer"

# La prueba de verdad: **una de las tareas**, en modo de solo lectura, con el
# mismo `docker run`, el mismo `--env-file`, la misma red, el mismo
# `NODE_ENV=production` y —lo que faltaba— **la misma cadena de conexión** que
# van a armar las unidades.
#
# Antes acá había un `pg.connect()` escrito a mano. Probaba menos de lo que
# parecía: no importaba `config.js`, así que una instalación a la que le faltara
# `MFA_ENCRYPTION_KEY` pasaba en verde y después fallaba en cada corrida.
#
# Y después probaba con la credencial equivocada. El `DATABASE_URL` del
# `--env-file` conecta como `nexo_app` —el rol de la aplicación— que no tiene
# `SELECT` sobre `email_outbox` ni sobre `payment_webhook_inbox`. Las tareas son
# del operador. Medido el 2026-09-16: las tres fallaban con `permission denied`.
#
# Por eso esta comprobación **repite el guion de las unidades**, con los dólares
# sin doblar porque acá no hay systemd en el medio. Que las cuatro copias digan
# lo mismo lo comprueba `tests/unit/tareas-agendadas.test.ts`, que es lo que
# impide que se separen.
#
# `--ver` no escribe nada y no llama a ninguna pasarela: lista lo que hay en la
# bandeja y sale. Es seguro correrlo en producción, y prueba cinco cosas de una
# vez: que el script está, que sus módulos resuelven, que la configuración
# carga, que la cadena se arma bien —incluida una contraseña con `/` o `+`— y
# que la base contesta a ese rol.
#
# `docker run --env-file` y el `env_file` de Compose **no parsean igual**
# —Compose saca las comillas y docker no—, así que una variable entrecomillada
# anda en la aplicación y falla acá. Leer el archivo no lo habría encontrado.
readonly GUION_CREDENCIAL='CLAVE=$(node -e "process.stdout.write(encodeURIComponent(process.env.POSTGRES_PASSWORD))"); export DATABASE_URL="postgresql://${POSTGRES_USER}:${CLAVE}@nexo-postgres:5432/${POSTGRES_DB}";'

salida=$(docker run --rm --network "$RED" --env-file "$ENV_FILE" \
           --env NODE_ENV=production --entrypoint sh "$IMAGEN" \
           -c "${GUION_CREDENCIAL} exec node scripts/pagos-bandeja.mjs --ver" 2>&1)
if [[ $? -eq 0 ]]; then
  ok "una tarea real corre con la credencial operatoria"
else
  mal "una tarea real NO corre con la credencial operatoria"
  # Se imprimen las últimas líneas del error. Ninguna tarea imprime
  # credenciales; lo que sale acá son nombres de variables y mensajes de pg.
  while IFS= read -r linea; do info "$linea"; done <<< "$(tail -5 <<< "$salida")"
fi

# Y la contracara: que la credencial de la **aplicación** siga sin poder. Si
# esto pasara en verde, significaría que alguien le amplió los privilegios a
# `aai_app` —o que el `.env` cambió de rol— y el candado que impide que una
# empresa cliente se marque un cargo como pagado ya no está.
if docker run --rm --network "$RED" --env-file "$ENV_FILE" \
     --env NODE_ENV=production "$IMAGEN" \
     node scripts/correo-bandeja.mjs --ver >/dev/null 2>&1; then
  mal "el rol de la aplicación PUEDE leer la bandeja de correo: se le ampliaron privilegios"
else
  ok "el rol de la aplicación sigue sin poder leer email_outbox (correcto)"
fi

titulo "3.1 · La copia de resguardo"

# El cuarto timer no usa la imagen de NEXO ni la red `nexo`: usa la imagen de
# PostgreSQL y `docker exec` contra el contenedor de la base. Tiene sus propias
# condiciones, y todas se comprueban corriendo algo, no leyendo un archivo.

[[ -x "${ORIGEN}/respaldar.sh" || -r "${ORIGEN}/respaldar.sh" ]] \
  && ok "respaldar.sh está en ${ORIGEN}" \
  || mal "falta ${ORIGEN}/respaldar.sh — la unidad apunta ahí"

# La imagen tiene que ser la misma versión mayor que el servidor: `pg_dump` se
# niega a volcar una base de un servidor más nuevo que él, y el error aparecería
# a las 02:30 sin que nadie lo mire.
mayor_servidor=$(docker exec "$CONTENEDOR_DB" postgres --version 2>/dev/null | grep -oE '[0-9]+' | head -1)
mayor_imagen=$(docker run --rm "$IMAGEN_PG" pg_dump --version 2>/dev/null | grep -oE '[0-9]+' | head -1)
if [[ -n "$mayor_servidor" && "$mayor_servidor" == "$mayor_imagen" ]]; then
  ok "pg_dump $mayor_imagen coincide con el servidor $mayor_servidor"
else
  mal "pg_dump ${mayor_imagen:-?} contra servidor ${mayor_servidor:-?}: no coinciden"
fi

for variable in POSTGRES_USER POSTGRES_PASSWORD POSTGRES_DB; do
  grep -q "^${variable}=" "$ENV_FILE" 2>/dev/null \
    && ok "declara $variable" || mal "$ENV_FILE no declara $variable"
done

# Y la prueba de verdad, que no escribe ni borra: el propio script en `--ver`.
if bash "${ORIGEN}/respaldar.sh" --ver >/dev/null 2>&1; then
  ok "respaldar.sh --ver corre (destino accesible, credenciales legibles)"
else
  mal "respaldar.sh --ver falló"
  while IFS= read -r linea; do info "$linea"; done \
    <<< "$(bash "${ORIGEN}/respaldar.sh" --ver 2>&1 | tail -4)"
fi

if [[ "$FALLOS" -gt 0 ]]; then
  printf '\n\033[31m%s comprobación(es) fallaron. No se instaló nada.\033[0m\n' "$FALLOS"
  printf 'Un timer que falla en cada corrida se ve igual que uno que anda.\n\n'
  exit 1
fi

if [[ "$MODO" == "auditar" ]]; then
  printf '\n\033[32mTodo en orden.\033[0m Para instalar: sudo %s\n\n' "$0"
  exit 0
fi

titulo "4 · Instalando"

for u in "${UNIDADES[@]}"; do
  install -m 0644 "${ORIGEN}/${u}.service" "${DESTINO}/${u}.service"
  install -m 0644 "${ORIGEN}/${u}.timer"   "${DESTINO}/${u}.timer"
  ok "${u}.service y ${u}.timer copiados"
done

systemctl daemon-reload
ok "daemon-reload"

for u in "${UNIDADES[@]}"; do
  # Se habilita el **timer**, no el servicio: el servicio es lo que el timer
  # dispara. Habilitar el servicio lo haría correr en cada arranque, que no es
  # lo mismo y en `nexo-diario` sería un ciclo de facturación por reinicio.
  systemctl enable --now "${u}.timer" >/dev/null 2>&1 \
    && ok "${u}.timer habilitado y activo" || mal "no se pudo habilitar ${u}.timer"
done

titulo "5 · Una corrida de verdad, ahora"

# Se dispara una vez cada tarea y se mira el resultado. Instalar y no probar
# deja el descubrimiento del primer fallo para dentro de cinco minutos, cuando
# quien instaló ya cerró la sesión.
#
# Las tres son idempotentes: correrlas ahora no emite nada de más.
for u in "${UNIDADES[@]}"; do
  systemctl start "${u}.service"
  resultado=$(systemctl show "${u}.service" --property=Result --value)
  [[ "$resultado" == "success" ]] && ok "${u} corrió bien" \
    || mal "${u} terminó en '$resultado' — journalctl -u ${u}.service -n 50"
done

printf '\n'
if [[ "$FALLOS" -gt 0 ]]; then
  printf '\033[31mInstalado con %s problema(s).\033[0m Miralos antes de irte.\n\n' "$FALLOS"
  exit 1
fi

printf '\033[32mListo.\033[0m El estado, cuando quieras:  %s/estado-de-tareas.sh\n\n' "$ORIGEN"
printf '  La copia de resguardo SÍ está acá ahora: nexo-respaldo, a las 02:30, con\n'
printf '  verificación y retención de %s copias. Lo que sigue sin estar es sacarla\n' "$RETENER_DOC"
printf '  fuera del servidor: vive en el mismo disco que la base.\n\n'
printf '  Y una copia que nunca se restauró es una hipótesis. El ensayo está en\n'
printf '  docs/DESPLIEGUE.md §7.7.\n\n'
