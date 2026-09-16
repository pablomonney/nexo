# Las tareas agendadas de NEXO

Tres timers de systemd en el host, cada uno arrancando un contenedor que corre
una tarea y se borra.

```
sudo ./instalar.sh              instala, habilita y prueba una corrida
sudo ./instalar.sh --auditar    solo comprueba
sudo ./instalar.sh --quitar     deshabilita y borra
./estado-de-tareas.sh           cuándo corrió cada una y cómo salió
./estado-de-tareas.sh --json    lo mismo, para una sonda
```

| unidad | cada | qué hace |
|---|---|---|
| `nexo-pagos` | 5 min | aplica las notificaciones que dejó el webhook de la pasarela |
| `nexo-correo` | 5 min | entrega lo que está `PENDIENTE` en `email_outbox` |
| `nexo-diario` | 03:15 | vence pruebas, emite cargos, avanza la cobranza, verifica el libro y la cadena de auditoría |

## Por qué esto existe

La auditoría B-2 preguntó si una empresa cliente podía trabajar sin que el
equipo fundador tocara nada. La respuesta era que no, y no por un defecto del
código: las tareas periódicas existían, cada una andaba, y **ninguna estaba
agendada**.

El caso que lo vuelve grave es la prueba de catorce días. Solo termina si corre
el ciclo de facturación: `vencerPruebas` se llama desde `correrCiclo`,
`correrCiclo` desde `facturacion-ciclo.mjs`, y ese script desde `nexo-diario` y
desde ningún otro lado. Sin el timer, la prueba no vence, la suscripción nunca
pasa a `SUSPENDIDA` y el producto es gratis por tiempo indefinido — sin que
ninguna pantalla lo diga, porque desde adentro todo está funcionando bien.

Desde la 0124 pasa lo mismo con la cobranza entera. Los avisos, la mora y la
suspensión son pasos de `avanzarCobranza`, que corre en la misma llamada. Una
política de cobranza declarada y sin este timer agendado es una política que no
se ejecuta.

## Las decisiones, y por qué

**systemd y no cron.** Cron no sabe qué pasó con la corrida anterior: manda un
correo si hubo salida y no guarda estado. systemd sí — `Result`,
`ExecMainStatus`, el journal por unidad—, y es de ahí que sale
`estado-de-tareas.sh`. Un agendador que no puede contestar «¿corrió ayer?» no
sirve para lo único que hay que preguntarle.

**systemd y no un worker en la aplicación.** Un proceso residente tiene que
estar vivo, y comprobar que lo está es otra tarea. Además correría dentro del
contenedor que atiende pedidos: con dos réplicas, dos ciclos de facturación
sobre la misma base. Un `oneshot` no puede solaparse consigo mismo —systemd no
arranca una unidad que ya está activa— y eso sale gratis.

**Contenedor por corrida, no Node en el host.** El host no tiene Node ni el
repositorio: tiene Docker y la imagen desplegada. Correr las tareas desde la
misma imagen que sirve la API garantiza que ejecutan **exactamente el código
desplegado**, no lo que haya en un checkout que alguien dejó a medio actualizar.

Por eso `scripts/` entra a la imagen (ver el `Dockerfile`). No estaba, y la
ausencia era invisible mientras nadie las corriera: el despliegue monta el repo
para migrar y con eso alcanzaba. Un timer no puede depender de eso.

**La credencial es la del operador, no la de la aplicación.** El `DATABASE_URL`
de `/opt/nexo/.env` conecta como `nexo_app`, miembro de `aai_app`, que **no
tiene `SELECT`** sobre `email_outbox`, `payment_webhook_inbox` ni
`payment_events`. Eso no es algo que haya que corregir: es el candado que impide
que el administrador de una empresa cliente se marque un cargo como pagado o se
levante una suspensión.

Estas tareas son del operador, así que cada unidad arma su propia cadena de
conexión **dentro del contenedor**, con `POSTGRES_USER`, `POSTGRES_PASSWORD` y
`POSTGRES_DB`, pasando la contraseña por `encodeURIComponent` — el mismo patrón
que `scripts/desplegar.sh` usa para migrar, incluida la codificación que costó
un despliegue el 2026-09-15 porque la clave lleva `/` y `+`. La contraseña nunca
aparece en `argv` de un proceso del host, ni en `ps`, ni en el journal.

`MFA_ENCRYPTION_KEY` sigue viniendo del `--env-file`: `config.js` la exige al
cargarse con `NODE_ENV=production`, antes de tocar la base.

Lo encontró el ensayo aislado del 2026-09-16, con las tres tareas fallando en
`permission denied`. `instalar.sh` comprueba las dos mitades: que la tarea corra
con la credencial operatoria, **y que la de la aplicación siga sin poder**.

**`Persistent=true` en los tres.** Una máquina apagada entre las 03:00 y las
04:00 dejaría un día sin facturar que nadie notaría hasta la conciliación del
mes. Con `Persistent`, la corrida perdida se ejecuta al arrancar.

**Las tres son idempotentes, y eso es la condición para agendarlas.** Un período
ya facturado se informa omitido en vez de duplicarse; un paso de cobranza ya
registrado no se vuelve a ejecutar; una notificación ya aplicada no se
reprocesa. Correr cualquiera dos veces el mismo día no produce un cargo de más.

## Lo que hay que mirar, y cuándo

`estado-de-tareas.sh` da cuatro datos por unidad, y el que importa es el
segundo:

```
última corrida    2026-09-15 03:15:02   hace 7 h
última exitosa    2026-09-15 03:15:44   hace 7 h
último resultado  bien (salida 0)
próxima           2026-09-16 03:15:00
```

**Última corrida y última exitosa separadas es el modo de falla que hay que
poder ver.** Una tarea que dispara cada cinco minutos y falla siempre tiene
«última corrida» de hace un minuto y se ve sana en `systemctl list-timers`. Lo
que la delata es que la última exitosa sea de hace tres días.

Umbrales razonables para una sonda externa, con `--json`:

- `nexo-pagos` y `nexo-correo`: alertar si `segundosDesdeLaUltimaExitosa > 1800`
  (seis corridas perdidas).
- `nexo-diario`: alertar si `segundosDesdeLaUltimaExitosa > 129600` (día y
  medio: tolera una corrida saltada, no dos).

**Los umbrales no están puestos en ningún lado.** A quién se le avisa y con qué
tolerancia es una decisión de operación que nadie tomó todavía, y escribirla acá
como si fuera técnica sería tomarla sin decirlo.

## Lo que NO está agendado

**La copia de resguardo.** `npm run db:backup` existe y funciona, pero cada
cuánto correrlo, cuánto retener y dónde guardarlo tienen atrás una obligación
legal de conservación y un costo. Se agenda aparte, a sabiendas. Ver
`docs/DESPLIEGUE.md` §4.

## Si algo falla

```
journalctl -u nexo-diario.service -n 100      lo que dijo la última corrida
journalctl -u nexo-diario.service --since -7d lo de la semana
systemctl start nexo-diario.service           correrla ahora, a mano
```

Las tres tareas son seguras de correr a mano en cualquier momento.
