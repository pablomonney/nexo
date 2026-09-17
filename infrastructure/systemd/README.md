# Las tareas agendadas de NEXO

Cuatro timers de systemd en el host, cada uno arrancando un contenedor que
corre una tarea y se borra.

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
| `nexo-respaldo` | 02:30 | saca la copia de la base, **la verifica**, y poda las automáticas viejas |

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

**`Persistent=true` en los cuatro.** Una máquina apagada entre las 02:00 y las
04:00 dejaría un día sin facturar **y sin copia**, que nadie notaría hasta la
conciliación del mes o hasta el incidente. Con `Persistent`, la corrida perdida
se ejecuta al arrancar.

**Las cuatro son idempotentes, y eso es la condición para agendarlas.** Un
período ya facturado se informa omitido en vez de duplicarse; un paso de
cobranza ya registrado no se vuelve a ejecutar; una notificación ya aplicada no
se reprocesa; y cada copia escribe su propio archivo con su sello, sin pisar la
anterior. Correr cualquiera dos veces el mismo día no produce un cargo de más ni
destruye una copia.

## La copia de resguardo

`nexo-respaldo` es el cuarto timer y el único que **no** usa `nexo:production`:
corre `pg_dump` desde `postgres:18-alpine`, que es de donde sale esa herramienta
y tiene que ser la misma versión mayor que el servidor. Meter el cliente de
PostgreSQL en la imagen que atiende los pedidos la engordaría por un script que
corre una vez al día.

```
./respaldar.sh          saca la copia, la verifica y poda
./respaldar.sh --ver    dice qué hay y qué podaría, sin escribir ni borrar
```

**Hace tres cosas, y la segunda es la que suele faltar:**

1. escribe el volcado en `/opt/nexo/var/backups`;
2. **lo abre con `pg_restore --list` para comprobar que se puede leer.** Un
   archivo que `pg_dump` dejó a medias —disco lleno, contenedor matado— pesa y
   existe, y se ve igual que uno bueno hasta el día que hace falta. Si no se
   puede leer su índice, el archivo se borra: una copia ilegible que parece una
   copia es peor que no tenerla;
3. poda las viejas.

### Retención

**Se conservan las últimas 14 copias automáticas** (`NEXO_BACKUP_RETENER`). Con
cadencia diaria son dos semanas.

Se cuenta en **copias y no en días**: si el timer estuvo caído una semana,
contar días borraría las que quedan justo cuando son lo único que hay.

**La poda solo toca los archivos que terminan en `-auto.dump`.** Los que saca
una persona antes de un despliegue terminan en otra cosa —`-pre0124.dump`— y la
poda nunca los mira. El día del incidente, la copia que alguien tomó a mano
antes de tocar algo es la más valiosa que hay, y sería la primera en caer bajo
una retención por antigüedad.

### Por qué a las 02:30 y no después del ciclo

Cuarenta y cinco minutos **antes** de `nexo-diario`. El ciclo de facturación es
lo único agendado que modifica el estado comercial de un cliente —emite cargos,
vence pruebas, degrada accesos—, así que si una corrida hace algo mal, la copia
que sirve es la de antes. Con la copia después, el día del incidente la única
reciente ya tendría el daño adentro.

El costo es que la copia no incluye lo que el ciclo escribió esa madrugada. Con
cadencia diaria la ventana de pérdida es la misma en los dos órdenes, así que se
elige por el escenario que se puede deshacer.

### Lo que sigue sin estar

**La copia vive en el mismo disco que la base.** Protege contra un error de
software o una migración mala, no contra la pérdida del VPS. Sacarla fuera del
servidor es una decisión aparte, con su costo.

**Una copia que nunca se restauró es una hipótesis.** El ensayo de restauración
se hace aparte y está en `docs/OPERACION.md`.

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
- `nexo-diario` y `nexo-respaldo`: alertar si
  `segundosDesdeLaUltimaExitosa > 129600` (día y medio: tolera una corrida
  saltada, no dos).

**Los umbrales no están puestos en ningún lado.** A quién se le avisa y con qué
tolerancia es una decisión de operación que nadie tomó todavía, y escribirla acá
como si fuera técnica sería tomarla sin decirlo.

## Lo que NO está agendado

**Sacar la copia fuera del servidor.** `nexo-respaldo` la escribe en el mismo
disco que la base: alcanza para deshacer un error de software y no para perder
el VPS. Dónde guardarla afuera y cuánto pagar por eso es una decisión que nadie
tomó todavía.

## Si algo falla

```
journalctl -u nexo-diario.service -n 100      lo que dijo la última corrida
journalctl -u nexo-diario.service --since -7d lo de la semana
systemctl start nexo-diario.service           correrla ahora, a mano
```

Las tres tareas son seguras de correr a mano en cualquier momento.
