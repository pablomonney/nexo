# Procedimiento de incidente (seguridad y disponibilidad)

**Estado: OPERATIVO, con una parte que REQUIERE ABOGADO (§6).** Fecha: 2026-10-15.
Cubre dos familias que se atienden distinto: **(A) el servicio no responde o responde mal** y **(B) sospecha de acceso indebido a datos**. Lo que se hace en los primeros minutos es parecido; lo que se le dice al cliente y a terceros, no.

## 0 · Principios

1. **Primero contener y entender; después arreglar.** Reiniciar «a ver si anda» destruye la evidencia (logs en memoria, sesiones).
2. **No se borra nada.** Ni logs, ni copias, ni filas de bitácora. Las copias `predeploy-*` y las manuales **nunca se podan**.
3. **No se modifica producción en caliente sin dejar registro** de qué se hizo, a qué hora y por qué (`/opt/nexo/var/despliegues/` y el registro de consultas).
4. **Lo que no se sabe se dice como «no sabemos todavía»**, nunca como «no pasó».
5. **Quien atiende no es quien decide si hay que notificar a terceros** (§6).

## 1 · Detectar y clasificar (primeros 15 minutos)

```bash
# ¿Está arriba? (desde cualquier lado)
curl -sS https://nexointelligence.com.ar/health        # liveness: el proceso responde
curl -sS https://nexointelligence.com.ar/health/db     # readiness: llega a la base; dice versión y migraciones
```

En el servidor (`ssh` con la clave de operador):

```bash
docker ps --format '{{.Names}} {{.Image}} {{.Status}}'          # nexo-app, nexo-postgres, traefik
docker logs --since 30m nexo-app 2>&1 | tail -100                # errores recientes (hay redacción de secretos)
bash /opt/nexo/infrastructure/systemd/estado-de-tareas.sh        # ¿corrieron las tareas diarias, la copia, los pagos, el correo?
df -h /opt/nexo ; free -m                                        # disco y memoria
```

| Lo que se ve | Es probable | Va al |
|---|---|---|
| `/health` no responde, el contenedor está caído o reiniciándose | disponibilidad | §2 |
| `/health` ok pero `/health/db` falla | base caída o sin conexiones | §2 |
| Todo responde pero un cliente reporta datos que no reconoce, una empresa que no es suya, o movimientos que no hizo | **sospecha de acceso indebido** | §3 |
| Inicios de sesión inusuales, bloqueos masivos, picos de 401/429 | intento de acceso / fuerza bruta | §3 |
| El disco se llenó o las copias dejaron de salir | operación | §2 y avisar |

Clasificar **como B ante la duda**: es más caro tratar como A algo que es B que al revés.

## 2 · (A) Disponibilidad

1. **Diagnóstico sin tocar:** logs (arriba), `docker inspect nexo-app --format '{{.State.Health.Status}}'`, espacio, conexiones.
2. **Si el contenedor de la aplicación cayó y la base está sana:** `docker compose -f /opt/nexo/docker-compose.prod.yml up -d` (levanta lo mismo, no reconstruye). `restart: unless-stopped` ya lo hace solo ante una caída; si no lo hizo, buscar por qué antes de forzar.
3. **Si el problema apareció después de un despliegue:** `bash /opt/nexo/scripts/desplegar.sh --revertir` (vuelve la imagen anterior; **no toca la base**; la versión anterior soporta el esquema nuevo). Ver `docs/DESPLIEGUE.md`.
4. **Si la base está dañada o hay corrupción:** **no restaurar apresuradamente.** Restaurar una copia pierde lo escrito desde que se sacó. La decisión es del titular, con la copia verificada más reciente (`/opt/nexo/var/backups/*.dump` + `.sha256`) y el procedimiento de `docs/DESPLIEGUE.md` §7.5.
5. **Comunicar** (§5) apenas se confirme que hay afectación, aunque no se sepa la causa.
6. **Cerrar** con la reconstrucción de la línea de tiempo (§7).

## 3 · (B) Sospecha de acceso indebido

### 3.1 Contener (en este orden)

1. **No apagar el servidor ni reiniciar contenedores** todavía: se pierde estado.
2. **Cortar el acceso de la cuenta sospechada** (no el servicio): cerrar sus sesiones y, si hace falta, desactivarla. Con la herramienta del operador se pueden ver las sesiones (`recuperar-cuenta.sh ver --email …`) y cualquier cambio queda en bitácora.
3. **Si se sospecha de la infraestructura** (el servidor mismo): rotar primero lo que da acceso — la clave SSH de operador, la contraseña de la base y `EMAIL_API_KEY`, `MFA_ENCRYPTION_KEY`/KEKs **con cuidado** (rotar la clave de cifrado del segundo factor deja a todos sin MFA: ver `docs/DESPLIEGUE.md` y el comentario de `routes/auth.ts`). **Coordinar antes de rotar.**
4. **Tomar una copia de la evidencia** (logs del contenedor y del sistema, `audit_logs` del período, lista de sesiones) hacia un lugar que no sea el mismo disco. **No** en `/tmp`.

### 3.2 Entender (qué datos, de quién, desde cuándo)

- **La bitácora de auditoría es encadenada y verificable:** `verify-audit-chain.mjs --observacional` dice si hay entradas alteradas. Una cadena rota es un hallazgo en sí mismo.
- `audit_logs` de la empresa: qué hizo la cuenta, a qué hora. **La IP no se guarda por defecto** (`AUDIT_RECORD_IP` no está definida en el servidor; ver política de privacidad): sin ella, el rastro es por usuario y hora, no por origen.
- Las sesiones: `sessions` (creación, expiración, revocación). El inicio de sesión inusual se reconstruye con ellas.
- Qué empresas están en el mismo servidor (hoy 1) y cuáles pudo tocar la cuenta: el aislamiento es por empresa (RLS forzado en todas las tablas con `company_id`).

### 3.3 Erradicar y recuperar

- Cambiar credenciales comprometidas, cerrar sesiones, corregir la causa (una cuenta con contraseña débil no es la misma causa que una vulnerabilidad).
- Si hubo modificación de datos: **no se corrige a mano en la base.** Se corrige con operaciones normales del sistema (anular y reasentar), que dejan rastro; o, si es grave, con restauración decidida por el titular (§2.4).
- Verificar después: cadena de auditoría (`verify-audit-chain`), libro mayor (`verify-ledger`), `/health/db`.

## 4 · Qué se mira siempre al cerrar

`audit:cadena` íntegra · `ledger:verify` sin discrepancias · copia del día presente y verificable · nadie con acceso que no deba tenerlo (usuarios y roles de la empresa afectada).

## 5 · Qué se le dice al cliente

Regla: **rápido, concreto, sin adivinar, sin culpar.** Un primer mensaje en las **primeras horas** desde que se confirma la afectación (aunque sea «estamos investigando»), y actualizaciones con hora comprometida.

Plantilla:

> **Asunto:** Incidente en NEXO — [fecha y hora]
> Detectamos [qué se ve, en una frase: «que el servicio no responde» / «actividad que no reconocemos en la cuenta de X»] a las [hora]. Estamos [qué se está haciendo]. **Lo que sabemos:** [hechos]. **Lo que todavía no sabemos:** [lo que falta]. **Qué te afecta:** [datos / servicio / nada confirmado]. **Qué podés hacer vos:** [cambiar contraseña, revisar movimientos de tal fecha]. Próxima novedad: [hora]. Contacto: [CORREO / TELÉFONO DE CONTACTO — por definir].

Nunca: afirmar «no hubo acceso a datos» sin evidencia; dar detalles técnicos que ayuden a repetir un ataque; prometer plazos de resolución no controlables.

## 6 · Notificaciones a terceros — **REQUIERE ABOGADO**

NEXO trata datos contables y personales de terceros. **Si un incidente de tipo B afectó datos personales**, hay que decidir con asesoramiento legal, **dentro de las primeras horas**:

- si corresponde **notificar a la autoridad de protección de datos** (Agencia de Acceso a la Información Pública) y en qué plazo;
- si corresponde **notificar a los titulares afectados** y cómo;
- si NEXO es **encargado** (los datos son del estudio) y entonces debe avisar **al estudio responsable** en el plazo del acuerdo de encargo (`BORRADOR_ACUERDO_DE_ENCARGADO_DEL_TRATAMIENTO.md`);
- si hay obligación de denuncia penal o comunicación a ARCA por el uso de certificados o claves fiscales.

**Este documento no responde esas preguntas**: no se sabe cuál es el plazo vigente ni cuál es la exigencia aplicable a esta situación concreta sin asesoramiento. Mientras el abogado no esté definido (B8), **el primer paso ante un incidente B es contactarlo**.

## 7 · Después: la reconstrucción

En los 5 días hábiles siguientes, un documento corto: **línea de tiempo** (qué se vio, cuándo; qué se hizo, cuándo), **causa raíz** (comprobada, no supuesta), **qué se le dijo a quién**, **qué cambia** para que no se repita (con una prueba automática si se puede, como se hizo con el resto de los defectos de este repositorio). Se guarda en `docs/` y se registra en `REGISTRO_DE_CONSULTAS.md`.

## 8 · Lo que no está resuelto

- **No hay guardia ni horario de atención definidos**: hoy un incidente de madrugada espera a que alguien lo vea. Sin monitoreo con destino (`BACKUP_EXTERNO_Y_MONITOREO.md`, B4) **nadie se entera solo**.
- **No hay copia fuera del servidor** (B3): un incidente que afecte al disco afecta también a las copias.
- Un SLA no se puede prometer con esto (`NEXO_LEGAL_Y_SOPORTE.md`).
