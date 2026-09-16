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
# Tres timers y sus servicios. Cada uno arranca un contenedor, corre una tarea y
# se borra. **No hay ningún proceso residente**: un worker vivo para tareas que
# duran segundos es un proceso más que se puede morir en silencio, y descubrirlo
# requiere mirar algo que nadie mira.
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
readonly UNIDADES=(nexo-pagos nexo-correo nexo-diario)

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

titulo "3 · Una tarea de verdad, con el entorno real del timer"

# La prueba de verdad: **una de las tareas**, en modo de solo lectura, con el
# mismo `docker run`, el mismo `--env-file`, la misma red y el mismo
# `NODE_ENV=production` que van a usar las unidades.
#
# Antes acá había un `pg.connect()` escrito a mano. Probaba menos de lo que
# parecía: no importaba `config.js`, así que una instalación a la que le faltara
# `MFA_ENCRYPTION_KEY` pasaba esta comprobación en verde y después fallaba en
# cada corrida. Correr la tarea la importa entera.
#
# `--ver` no escribe nada y no llama a ninguna pasarela: lista lo que hay en la
# bandeja y sale. Es seguro correrlo en producción, y prueba las cuatro cosas de
# una vez: que el script está, que sus módulos resuelven, que la configuración
# carga y que la base contesta.
#
# `docker run --env-file` y el `env_file` de Compose **no parsean igual**
# —Compose saca las comillas y docker no—, así que una variable entrecomillada
# anda en la aplicación y falla acá. Leer el archivo no lo habría encontrado.
salida=$(docker run --rm --network "$RED" --env-file "$ENV_FILE" \
           --env NODE_ENV=production "$IMAGEN" \
           node scripts/pagos-bandeja.mjs --ver 2>&1)
if [[ $? -eq 0 ]]; then
  ok "una tarea real corre dentro de la imagen con --env-file"
else
  mal "una tarea real NO corre dentro de la imagen"
  # Se imprimen las últimas líneas del error. Ninguna tarea imprime
  # credenciales; lo que sale acá son nombres de variables y mensajes de pg.
  while IFS= read -r linea; do info "$linea"; done <<< "$(tail -5 <<< "$salida")"
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
printf '  La copia de resguardo NO está acá: se agenda aparte, a sabiendas.\n'
printf '  Ver docs/DESPLIEGUE.md §4.\n\n'
