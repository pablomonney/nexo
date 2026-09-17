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
# ## Los datos, y por qué son estos
#
#     última corrida       cuándo arrancó la última vez. Sin esto no se sabe si
#                          el timer está vivo.
#     última exitosa       cuándo terminó bien por última vez. Es el que
#                          contesta «¿hace cuánto que esto no funciona?», y es
#                          distinto del anterior en el caso que importa: una
#                          tarea que corre cada cinco minutos y falla siempre
#                          tiene «última corrida» de hace un minuto.
#     último resultado     el motivo del fallo y el código de salida de la
#                          última. Un `exit 1` de la tarea y un timeout de
#                          systemd se arreglan distinto.
#     hace cuánto          en segundos, para las dos fechas. Es lo que una sonda
#                          compara contra un umbral; una fecha obliga a que el
#                          que mira haga la cuenta.
#     próxima              cuándo vuelve a dispararse.
#
# ## De dónde sale cada uno, que no es obvio
#
# **systemd no devuelve las fechas en un solo formato**, y asumir que sí fue un
# defecto real de este script: con systemd 255, `systemctl show --value` de
# `NextElapseUSecRealtime` contesta `Wed 2026-09-16 03:25:13 UTC` —texto— y no
# microsegundos, pese al nombre de la propiedad. El campo salía vacío con un
# `unbound variable` en el medio.
#
# Así que:
#
#   · la **próxima** sale de `systemctl list-timers --output=json`, que sí
#     devuelve microsegundos numéricos y es la fuente más estable para esto;
#   · las **fechas de la unidad** salen de `systemctl show` y pasan por
#     `microsegundos_de`, que acepta las dos formas y no supone ninguna;
#   · la **última exitosa** sale del journal, porque systemd no la guarda como
#     propiedad: `Result` describe solo la última corrida, buena o mala.
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

readonly UNIDADES=(nexo-pagos nexo-correo nexo-diario nexo-respaldo)

JSON=0
[[ "${1:-}" == "--json" ]] && JSON=1

# `systemctl show` con una sola propiedad y `--value` devuelve el valor pelado.
# Es la forma estable de leer esto: parsear la salida de `status` depende del
# ancho de la terminal y del idioma.
prop() { systemctl show "$1" --property="$2" --value 2>/dev/null; }

# ---------------------------------------------------------------------------
# Microsegundos desde el epoch, venga como venga
# ---------------------------------------------------------------------------
#
# systemd usa **tres** representaciones para lo mismo y no avisa cuál:
#
#     1789529412529554              microsegundos, que es lo que el nombre
#                                   `...USec...` promete;
#     Wed 2026-09-16 03:25:13 UTC   texto legible, que es lo que esa MISMA
#                                   propiedad devuelve con `show --value`
#                                   en systemd 255;
#     (vacío) o 0                   nunca pasó.
#
# Cero y vacío **no son fechas**: son «nunca», y traducirlos a 1970 haría que
# una tarea que jamás corrió se viera como una que corrió hace cincuenta y seis
# años. Se devuelve vacío y lo interpreta quien llama.
microsegundos_de() {
  local valor="${1:-}"
  [[ -z "$valor" || "$valor" == "0" || "$valor" == "n/a" ]] && { echo ""; return; }

  # Ya numérico: viene en microsegundos.
  if [[ "$valor" =~ ^[0-9]+$ ]]; then
    echo "$valor"
    return
  fi

  # Texto: lo traduce `date`, que entiende el formato de systemd. Si tampoco
  # puede, se devuelve vacío en vez de un número inventado.
  local epoch
  epoch=$(date -d "$valor" +%s 2>/dev/null) || { echo ""; return; }
  [[ -z "$epoch" ]] && { echo ""; return; }
  echo "$(( epoch * 1000000 ))"
}

segundos_desde() {
  local usec="${1:-}"
  [[ -z "$usec" ]] && { echo ""; return; }
  echo $(( ( $(date +%s%6N) - usec ) / 1000000 ))
}

fecha_de() {
  local usec="${1:-}"
  [[ -z "$usec" ]] && { echo "nunca"; return; }
  date -d "@$(( usec / 1000000 ))" '+%Y-%m-%d %H:%M:%S %Z' 2>/dev/null || echo "?"
}

# Solo para fechas pasadas: la próxima corrida se imprime con su propio texto,
# porque «hace» y «en» no son la misma pregunta.
humano() {
  local s="${1:-}"
  [[ -z "$s" ]] && { echo "—"; return; }
  if   (( s < 120 ));    then echo "hace ${s}s"
  elif (( s < 7200 ));   then echo "hace $(( s / 60 )) min"
  elif (( s < 172800 )); then echo "hace $(( s / 3600 )) h"
  else                        echo "hace $(( s / 86400 )) días"
  fi
}

# ---------------------------------------------------------------------------
# La próxima corrida, del listado de timers
# ---------------------------------------------------------------------------
#
# `--output=json` devuelve `next` en microsegundos numéricos, que es la forma
# que no hay que adivinar. Se lee **una vez** para las tres unidades: llamar a
# `systemctl` por unidad multiplica el trabajo sin ganar nada.
#
# Si esta versión de systemd no soporta `--output=json`, la variable queda vacía
# y cada unidad cae a `NextElapseUSecRealtime`, que `microsegundos_de` sabe leer
# en cualquiera de sus dos formas. Degradar así es preferible a depender de una
# bandera que no todas las versiones tienen.
LISTADO=$(systemctl list-timers 'nexo-*' --all --output=json --no-pager 2>/dev/null || echo "")

proxima_de() {
  local timer="$1" desde_el_listado=""
  if [[ -n "$LISTADO" ]]; then
    # Un objeto por línea, y de la línea de este timer se saca `next`. Sin `jq`,
    # que no tiene por qué estar en el servidor.
    desde_el_listado=$(printf '%s' "$LISTADO" \
      | tr '{' '\n' \
      | grep -F "\"unit\":\"${timer}\"" \
      | grep -oE '"next":[0-9]+' \
      | head -1 | cut -d: -f2)
  fi
  [[ -n "$desde_el_listado" ]] && { microsegundos_de "$desde_el_listado"; return; }
  microsegundos_de "$(prop "$timer" NextElapseUSecRealtime)"
}

# ---------------------------------------------------------------------------

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
  inicio_usec=$(microsegundos_de "$(prop "$servicio" ExecMainStartTimestamp)")

  # `Result` es `success` o el motivo del fallo (`exit-code`, `timeout`,
  # `signal`…). `ExecMainStatus` es el código de salida del proceso. Los dos:
  # un `exit 1` de la tarea y un timeout de systemd se arreglan distinto.
  resultado=$(prop "$servicio" Result)
  codigo=$(prop "$servicio" ExecMainStatus)

  proxima_usec=$(proxima_de "$timer")

  # systemd no guarda «la última corrida exitosa» como propiedad: `Result` solo
  # describe la última, buena o mala. Queda en el journal, y de ahí se saca: la
  # última entrada de la unidad que informó `JOB_RESULT=done`. Con el journal
  # rotado se contesta «no consta», que es lo honesto, y no «nunca».
  ultima_ok=$(journalctl -u "$servicio" --output=json --no-pager -n 400 2>/dev/null \
    | grep '"JOB_RESULT":"done"' \
    | grep -oE '"__REALTIME_TIMESTAMP":"[0-9]*"' \
    | grep -oE '[0-9]{10,}' | tail -1)

  desde_ultima=$(segundos_desde "$inicio_usec")
  desde_ok=$(segundos_desde "${ultima_ok:-}")

  # `segundos_desde` cuenta hacia atrás, así que sobre una fecha futura da
  # negativo. Se invierte una sola vez, acá, para que el nombre del campo diga
  # la verdad en las dos salidas.
  faltan=$(segundos_desde "${proxima_usec:-}")
  para_la_proxima=""
  [[ -n "$faltan" ]] && para_la_proxima=$(( -faltan ))

  if [[ "$JSON" -eq 1 ]]; then
    [[ "$primera" -eq 0 ]] && printf ','
    primera=0
    printf '{"unidad":"%s","habilitado":"%s","activo":"%s"' "$unidad" "$habilitado" "$activo"
    printf ',"ultimaCorrida":"%s","segundosDesdeLaUltima":%s' \
      "$(fecha_de "$inicio_usec")" "${desde_ultima:-null}"
    printf ',"ultimaExitosa":"%s","segundosDesdeLaUltimaExitosa":%s' \
      "$(fecha_de "${ultima_ok:-}")" "${desde_ok:-null}"
    printf ',"resultado":"%s","codigoDeSalida":%s' \
      "${resultado:-desconocido}" "${codigo:-null}"
    printf ',"proxima":"%s","segundosParaLaProxima":%s}' \
      "$(fecha_de "${proxima_usec:-}")" "${para_la_proxima:-null}"
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

  if [[ -n "${proxima_usec:-}" ]]; then
    printf '    próxima           %s   en %ss\n' "$(fecha_de "$proxima_usec")" "$para_la_proxima"
  else
    printf '    próxima           \033[31mno se pudo leer\033[0m\n'
  fi
done

if [[ "$JSON" -eq 1 ]]; then
  printf ']\n'
else
  printf '\n  El detalle de cualquiera:  journalctl -u <unidad>.service -n 100\n\n'
fi
