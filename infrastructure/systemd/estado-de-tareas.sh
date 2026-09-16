#!/usr/bin/env bash
# ============================================================================
# ¿Corrieron las tareas de NEXO?
# ============================================================================
#
#   ./estado-de-tareas.sh            # el estado de los tres timers
#   ./estado-de-tareas.sh --json     # lo mismo, para una sonda externa
#
# ## Por qué esto existe
#
# `systemctl list-timers` contesta **cuándo va a correr**. La pregunta que hay
# que poder contestar es otra: *cuándo corrió por última vez, y salió bien*.
#
# No son lo mismo y la diferencia es exactamente el modo de falla que un
# agendador tiene. Un timer habilitado que dispara cada cinco minutos y falla
# cada vez se ve, en `list-timers`, idéntico a uno que anda: tiene su próxima
# corrida programada y su última activación reciente. Lo que lo distingue es el
# resultado de la unidad de servicio, que está en otro lado.
#
# El caso que más importa es el peor de leer: **la tarea diaria.** Si deja de
# correr, no pasa nada visible. La API responde, la consola anda, los clientes
# trabajan. Lo único que ocurre es que las pruebas de catorce días no vencen y
# la cobranza no avanza — y eso se descubre semanas después, contando plata que
# no entró.
#
# ## Los cuatro datos, y por qué son cuatro
#
#     última corrida       cuándo arrancó la última vez. Sin esto no se sabe si
#                          el timer está vivo.
#     última exitosa       cuándo terminó bien por última vez. Es el que
#                          contesta «¿hace cuánto que esto no funciona?», y es
#                          distinto del anterior en el caso que importa: una
#                          tarea que corre cada cinco minutos y falla siempre
#                          tiene «última corrida» de hace un minuto.
#     último error         el código de salida y el motivo de la última que
#                          falló. Un `exit 1` de la tarea y un timeout de
#                          systemd se arreglan distinto.
#     hace cuánto          en segundos. Es lo que una sonda compara contra un
#                          umbral; una fecha obliga a que el que mira haga la
#                          cuenta.
#
# ## Lo que este script NO hace
#
# **No alerta.** Imprime y sale. Decidir a quién se le avisa y con qué umbral es
# una decisión de operación que nadie tomó todavía, y ponerle un umbral
# inventado acá sería tomarla sin decirlo. Con `--json`, cualquier sonda puede
# leerlo y aplicar el suyo.
#
# **No arregla nada.** No reinicia timers ni relanza tareas: si algo hay que
# volver a correr, lo corre una persona que leyó por qué falló.
# ============================================================================

set -uo pipefail

readonly UNIDADES=(nexo-pagos nexo-correo nexo-diario)

JSON=0
[[ "${1:-}" == "--json" ]] && JSON=1

# `systemctl show` con una sola propiedad y `--value` devuelve el valor pelado.
# Es la forma estable de leer esto: parsear la salida de `status` depende del
# ancho de la terminal y del idioma.
prop() { systemctl show "$1" --property="$2" --value 2>/dev/null; }

# systemd devuelve microsegundos desde el epoch, o `0` cuando nunca pasó. Cero
# **no es una fecha**: es «nunca», y mostrarlo como 1970 haría que una tarea que
# jamás corrió se viera como una que corrió hace cincuenta y seis años.
segundos_desde() {
  local usec="$1"
  [[ -z "$usec" || "$usec" == "0" ]] && { echo ""; return; }
  echo $(( ( $(date +%s%6N) - usec ) / 1000000 ))
}

fecha_de() {
  local usec="$1"
  [[ -z "$usec" || "$usec" == "0" ]] && { echo "nunca"; return; }
  date -d "@$(( usec / 1000000 ))" '+%Y-%m-%d %H:%M:%S' 2>/dev/null || echo "?"
}

humano() {
  local s="$1"
  [[ -z "$s" ]] && { echo "—"; return; }
  if   (( s < 120 ));   then echo "hace ${s}s"
  elif (( s < 7200 ));  then echo "hace $(( s / 60 )) min"
  elif (( s < 172800 ));then echo "hace $(( s / 3600 )) h"
  else                       echo "hace $(( s / 86400 )) días"
  fi
}

[[ "$JSON" -eq 0 ]] && printf '\n\033[1m══ Tareas agendadas de NEXO ═════════════════════════════════════\033[0m\n'

primera=1
[[ "$JSON" -eq 1 ]] && printf '['

for unidad in "${UNIDADES[@]}"; do
  timer="${unidad}.timer"
  servicio="${unidad}.service"

  habilitado=$(systemctl is-enabled "$timer" 2>/dev/null || echo "no-instalado")
  activo=$(systemctl is-active "$timer" 2>/dev/null || echo "inactive")

  # `ExecMainStartTimestamp` es cuándo arrancó el proceso de la última corrida.
  # Se usa el de arranque y no el de salida porque una tarea colgada todavía no
  # tiene salida, y es justo el caso que hay que poder ver.
  #
  # systemd lo devuelve como texto («Mon 2026-09-15 03:15:02 -03») y no como
  # número, así que se lo pasa por `date`. Vacío o sin parsear es `0`, que
  # `fecha_de` muestra como «nunca» — y nunca como 1970.
  inicio_usec=$(date -d "$(prop "$servicio" ExecMainStartTimestamp)" +%s%6N 2>/dev/null || echo 0)

  # `Result` es `success` o el motivo del fallo (`exit-code`, `timeout`,
  # `signal`…). `ExecMainStatus` es el código de salida del proceso. Los dos:
  # un `exit 1` de la tarea y un timeout de systemd se arreglan distinto.
  resultado=$(prop "$servicio" Result)
  codigo=$(prop "$servicio" ExecMainStatus)

  # `NextElapseUSecRealtime` sí viene en microsegundos desde el epoch.
  proxima=$(prop "$timer" NextElapseUSecRealtime)

  # systemd no guarda «la última corrida exitosa» como propiedad: `Result` solo
  # describe la última, buena o mala. Queda en el journal, y de ahí se saca: la
  # última entrada de la unidad que informó `JOB_RESULT=done`. Con el journal
  # rotado se contesta «no consta», que es lo honesto, y no «nunca».
  ultima_ok=$(journalctl -u "$servicio" --output=json --no-pager -n 400 2>/dev/null \
    | grep '"JOB_RESULT":"done"' \
    | grep -o '"__REALTIME_TIMESTAMP":"[0-9]*"' \
    | grep -o '[0-9]\{10,\}' | tail -1)

  desde_ultima=$(segundos_desde "$inicio_usec")
  desde_ok=$(segundos_desde "${ultima_ok:-0}")

  if [[ "$JSON" -eq 1 ]]; then
    [[ "$primera" -eq 0 ]] && printf ','
    primera=0
    printf '{"unidad":"%s","habilitado":"%s","activo":"%s","ultimaCorrida":"%s",' \
      "$unidad" "$habilitado" "$activo" "$(fecha_de "$inicio_usec")"
    printf '"segundosDesdeLaUltima":%s,"ultimaExitosa":"%s","segundosDesdeLaUltimaExitosa":%s,' \
      "${desde_ultima:-null}" "$(fecha_de "${ultima_ok:-0}")" "${desde_ok:-null}"
    printf '"resultado":"%s","codigoDeSalida":%s,"proxima":"%s"}' \
      "${resultado:-desconocido}" "${codigo:-null}" "$(fecha_de "${proxima:-0}")"
    continue
  fi

  printf '\n\033[1m%s\033[0m\n' "$unidad"

  if [[ "$habilitado" == "no-instalado" ]]; then
    printf '  \033[31m✘ el timer no está instalado.\033[0m Ver instalar.sh\n'
    continue
  fi

  if [[ "$habilitado" != "enabled" || "$activo" != "active" ]]; then
    printf '  \033[31m✘ timer %s / %s — NO va a correr\033[0m\n' "$habilitado" "$activo"
  else
    printf '  \033[32m✔\033[0m timer activo y habilitado\n'
  fi

  printf '    última corrida    %s   %s\n' "$(fecha_de "$inicio_usec")" "$(humano "$desde_ultima")"
  if [[ -n "${ultima_ok:-}" ]]; then
    printf '    última exitosa    %s   %s\n' "$(fecha_de "$ultima_ok")" "$(humano "$desde_ok")"
  else
    printf '    última exitosa    no consta en el journal disponible\n'
  fi

  if [[ "$resultado" == "success" ]]; then
    printf '    último resultado  \033[32mbien\033[0m (salida %s)\n' "${codigo:-0}"
  else
    printf '    último resultado  \033[31m%s\033[0m (salida %s)\n' "${resultado:-desconocido}" "${codigo:-?}"
    printf '                      journalctl -u %s -n 50\n' "$servicio"
  fi
  printf '    próxima           %s\n' "$(fecha_de "${proxima:-0}")"
done

if [[ "$JSON" -eq 1 ]]; then
  printf ']\n'
else
  printf '\n  El detalle de cualquiera:  journalctl -u <unidad>.service -n 100\n\n'
fi
