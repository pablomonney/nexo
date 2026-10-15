# Copia de resguardo fuera del VPS y monitoreo — alternativas concretas

**Estado: PROPUESTA para tu decisión. No se contrató, no se activó ni se instaló nada.** Fecha: 2026-10-15.
Precios de lista consultados hoy en las páginas de cada proveedor (enlaces al final); no incluyen impuestos y pueden cambiar. Lo que no pude confirmar figura como **no verificado**.

## 1 · Punto de partida (auditoría de solo lectura del VPS, 2026-10-15)

Evidencia: `var/aud/auditoria-vps-2026-10-15.txt`.

| Hecho | Valor |
|---|---|
| Copias automáticas | 17 `.dump` en `/opt/nexo/var/backups`, 25 MB en total; la última de hoy 02:32 UTC; el timer `nexo-respaldo` terminó en `success` |
| Tamaño de la base | **23 MB** (una copia pesa ~1,4 MB) |
| Dónde viven las copias | **`/dev/sda1`, el mismo disco que los datos de Docker** (4 % usado). Un fallo de disco, de cuenta del proveedor o un borrado con `root` se lleva base y copias |
| Sumas de verificación | Las copias automáticas **no tienen archivo `.sha256`** (el `respaldar.sh` nuevo sí las escribe, pero no está desplegado) |
| Ventana de pérdida | Hasta 24 h (una copia diaria a las 02:30) |
| Alertas | Ninguna: si el timer falla o la API cae, nadie se entera hasta que alguien mira |

**Consecuencia del tamaño:** la base es chica. El costo de guardar copias externas es **de centavos al mes**; lo caro es la operación (credenciales, cifrado, probar la restauración), no el almacenamiento.

## 2 · Requisitos que cualquier alternativa tiene que cumplir

1. **Fuera del VPS y de la cuenta del proveedor del VPS.**
2. **Cifrada antes de salir** (clave en tus manos, **no en el servidor**): son datos contables de terceros.
3. **Credenciales de sólo escritura/anexado** en el servidor: quien entre al VPS no puede borrar ni leer las copias externas.
4. **Verificación**: suma de control al subir y **prueba de restauración periódica** (no sólo `pg_restore --list`).
5. **Retención declarada**, con la política a la vista.
6. **Alerta si no corrió** (el modo de falla silencioso).

## 3 · Destino de las copias (alternativas)

| | A · Cloudflare R2 | B · Backblaze B2 | C · Hetzner Storage Box | D · Una máquina tuya |
|---|---|---|---|---|
| **Qué es** | Almacenamiento de objetos compatible con S3 | Almacenamiento de objetos compatible con S3 | Disco remoto por SFTP / Borg / Restic / rsync | Un NAS o una PC con SSH |
| **Costo (lista)** | **USD 0,015 / GB-mes**; nivel gratuito de **10 GB**, 1 M de operaciones de escritura y 10 M de lectura por mes; **salida de datos gratis** | **desde USD 6,95 / TB-mes**; salida gratis hasta 3× lo almacenado y después USD 0,01 / GB; sin cargo mínimo por tiempo de guardado | **Precio no verificado** (la página no lo muestra). Planes de 1 / 5 / 10 / 20 TB, tráfico ilimitado, 10 *snapshots* en el menor | Sin costo directo |
| **Costo para NEXO hoy** | **USD 0** (25 MB caben 400 veces en el nivel gratuito) | **≈ USD 0,0002 / mes** por los 25 MB (hay que verificar si aplica un mínimo de facturación) | Una cuota fija de un plan que es 40 000 veces más grande que lo que se necesita | 0 |
| **Cifrado del lado del cliente** | Con `restic` o `rclone crypt` | Con `restic` o `rclone crypt` | `restic`/`borg` lo traen | Idem |
| **Credencial de sólo escritura** | Tokens por bucket con permisos acotados | Claves de aplicación acotadas a un bucket | Subcuenta SFTP | Usuario sin shell |
| **Inmutabilidad / bloqueo contra borrado** | **No verificado** en la documentación consultada: confirmar antes de depender de ella | *Object Lock*: **no figura en la página de precios consultada**; confirmar | Snapshots del lado del proveedor | No |
| **Ubicación y jurisdicción** | EE. UU. / red global | EE. UU. y UE (a elegir, **no verificado**) | UE (Alemania/Finlandia) | La tuya |
| **Pro** | Gratis a esta escala; sin costo de salida (la restauración no cuesta) | Barato y maduro; costo previsible | Un solo lugar, protocolos simples | Control total |
| **Contra** | Cuenta nueva + tarjeta; proveedor de EE. UU. | Idem | Cuota fija; proveedor de la UE | **Disponibilidad y seguridad dependen de vos**; no es un servicio |

**Una consideración que va con tu abogado, no con este documento:** enviar datos de terceros a un proveedor en otra jurisdicción tiene implicancias de protección de datos personales. Cifrar del lado del cliente con una clave que sólo tenés vos reduce lo que el proveedor puede ver, **pero no es una conclusión legal**. Entra en la revisión legal pendiente (B8).

**Recomendación técnica: A (R2) o B (B2) con `restic`.** Cualquiera de los dos resuelve el requisito a costo casi nulo; la diferencia que decide es la jurisdicción y si ofrecen bloqueo contra borrado (hay que confirmarlo en la documentación de cada uno antes de elegir). C es razonable si preferís la UE; D no es una alternativa de producción.

### Cómo se haría (sin ejecutarlo)

- Una unidad `systemd` nueva, **después** de `nexo-respaldo` (02:30) y **antes** de `nexo-diario`, que corre `restic backup /opt/nexo/var/backups` hacia el destino elegido.
- Contraseña del repositorio `restic` **fuera del VPS** (la guardás vos, en dos lugares); en el servidor sólo la credencial de sólo escritura.
- Al terminar, un *ping* de «terminé bien» al monitor de §5 (si no llega, alerta).
- Retención externa sugerida: **14 diarias + 8 semanales + 12 mensuales** (`restic forget --keep-daily 14 --keep-weekly 8 --keep-monthly 12`) — a validar con la política de conservación que defina el abogado.
- **Procedimiento de restauración** (a ensayar **mensualmente** y registrar el resultado):
  1. `restic restore latest --target /tmp/restauracion` desde una máquina limpia (con la contraseña guardada fuera del VPS).
  2. `bash infrastructure/systemd/respaldar.sh --verificar-restauracion` o `pg_restore` a una base descartable `aai_restauracion_<fecha>`.
  3. Comparar tablas y filas contra la base viva (el `respaldar.sh` nuevo ya hace ese cotejo con rangos) y la cadena de auditoría (`scripts/recalcular-cadena.mjs`).
  4. Borrar la base descartable. Anotar tiempo total (**RTO medido**) y fecha de la copia usada (**RPO real**).
- **Lo que esto no cubre:** la ventana de 24 h entre copias. Bajarla (archivado de WAL o copias más frecuentes) es una decisión de costo de operación, no de almacenamiento.

## 4 · Mientras tanto, sin contratar nada

Dos mejoras que no necesitan ningún servicio externo y que ya están hechas en el repositorio (no desplegadas): el `respaldar.sh` nuevo escribe `.sha256`, restaura la copia en una base descartable y la compara con la viva; y `infrastructure/systemd/estado-de-tareas.sh --json` informa *cuándo corrió por última vez cada tarea y si salió bien*, pensado para una sonda externa.

## 5 · Monitoreo y alertas

Hay **dos** preguntas distintas y conviene cubrir las dos:

1. **¿Está arriba?** — una sonda externa que pide `https://nexointelligence.com.ar/health` (hoy responde `HTTP 200`; certificado de Let's Encrypt vigente hasta el 2026-12-15).
2. **¿Corrieron las tareas?** — un *dead-man's switch*: cada tarea (copia, diario, externa) avisa «terminé bien» y el monitor alerta si **no** llega. Es el modo de falla que importa y que ningún chequeo HTTP ve.

| | Qué cubre | Costo (lista) | Límites relevantes | Notas |
|---|---|---|---|---|
| **Healthchecks.io** | (2) | **Gratis**: 20 trabajos. De pago: USD 5/mes (mismos 20 trabajos), USD 20/mes (100 trabajos, créditos de SMS, WhatsApp y llamadas) | 100 entradas de historial por trabajo en el gratuito | Recibe pings; no ve el contenido. **Canales de aviso: no verificados en la página consultada** |
| **UptimeRobot** | (1) | **Gratis**: 50 monitores, intervalo de **5 min**, 5 integraciones, alertas por correo. De pago: Solo USD 9–10/mes, Team 35–41, Scale 65–77 | El plan gratuito se describe como «bueno para proyectos personales y sin fines de lucro»; **si el uso comercial está permitido no figura**: asumir que para un producto con clientes hace falta el plan de pago | Intervalo de 5 min |
| **Better Stack** | (1) y (2) | **Gratis**: 10 monitores y *heartbeats*, 1 página de estado, alertas por Slack y correo («para proyectos personales»). De pago: asiento de respondedor USD 29–34/mes + extras | Frecuencia del gratuito: no indicada | Más completo; más caro para este tamaño |
| **Uptime Kuma** (autoalojado) | (1) y (2) | Sin licencia; **necesita OTRO servidor** (no el mismo VPS: si cae, el monitor cae con él) | — | Costo = un host adicional + mantenerlo |
| **Lo propio** | (2) | 0 | `estado-de-tareas.sh --json` ya existe | Alguien tiene que consultarlo; no avisa solo |

**Destino de las alertas.** Hay que decidir **a quién y por qué canal**. NEXO no sirve como canal de su propia alerta (si cae, no avisa); el correo de Resend ya está configurado en el servidor (`EMAIL_PROVIDER=resend`) pero depende del mismo VPS. Un canal independiente (correo personal, Telegram, Slack) es lo que cierra el círculo.

**Combinación mínima razonable:** *Healthchecks.io* gratuito para (2) + una sonda HTTP externa para (1) (*UptimeRobot* de pago o el plan gratuito de *Better Stack*, según cómo se interprete el uso comercial). **Costo estimado: de USD 0 a USD 10 por mes.**

## 6 · Resumen de costos (lista de hoy)

| Opción | USD / mes |
|---|---|
| R2 o B2 para las copias (25 MB hoy; a 100× sigue siendo centavos) | 0 – 0,01 |
| Healthchecks.io (20 trabajos) | 0 |
| Sonda HTTP: gratuita (con la salvedad de uso comercial) / UptimeRobot Solo | 0 / 9–10 |
| **Total mínimo** | **0 – 10** |

## 7 · Qué necesito de vos

1. Destino de las copias: **R2, B2, Hetzner u otro** (y la región, si aplica).
2. Quién guarda la contraseña de cifrado y dónde (**dos copias, fuera del VPS**).
3. A quién y por qué canal llegan las alertas, y si aceptás el plan de pago de la sonda HTTP.
4. La política de retención (con tu abogado, §3).

Con esas cuatro respuestas escribo las unidades `systemd`, el procedimiento de restauración probado y las pruebas. **Nada se instala ni se activa sin tu aprobación.**

## Fuentes (consultadas el 2026-10-15)

- Backblaze B2: https://www.backblaze.com/cloud-storage/pricing
- Cloudflare R2: https://developers.cloudflare.com/r2/pricing/
- Hetzner Storage Box: https://www.hetzner.com/storage/storage-box/
- Healthchecks.io: https://healthchecks.io/pricing/
- UptimeRobot: https://uptimerobot.com/pricing/
- Better Stack: https://betterstack.com/pricing
