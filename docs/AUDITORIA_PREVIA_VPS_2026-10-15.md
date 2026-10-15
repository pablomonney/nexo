# Auditoría previa del VPS y paquete para la autorización final (B1, zona horaria)

**Fecha:** 2026-10-15. **Estado: SIN AUTORIZACIÓN DE DESPLIEGUE.** Lo único que se ejecutó en el servidor fue la auditoría de solo lectura de §1. No se desplegó, no se migró, no se creó ninguna copia de resguardo, no se tocaron las bases `aai_restauracion_*` ni el `.env`.

Regla de este documento: lo **comprobado en el servidor** (§2) está separado de lo **probado en esta máquina** (§5). Lo que no se pudo comprobar figura como **NO VERIFICADO**.

## 1 · Qué se ejecutó contra el VPS

Un solo guion, `scripts/auditar-servidor.sh`, enviado por entrada estándar (no se copia nada al servidor):

```bash
ssh -i <clave-ssh> -o BatchMode=yes <usuario>@<servidor> 'bash -s' < scripts/auditar-servidor.sh
```

- **Solo lectura:** `tests/unit/auditar-servidor.test.ts` (15 pruebas) prohíbe en el guion cualquier verbo de escritura (`rm`, `mv`, `cp`, redirecciones a archivos, `docker run/build/tag/…`, `systemctl start/stop/…`, `git fetch/pull/merge/…`, instaladores, `curl -X POST`…), exige que cada consulta a la base sea un único `SELECT`/`SHOW`, que haya **una sola** llamada a `docker exec` (el `psql`), y que nunca se impriman valores secretos. 6 mutaciones del guion, todas detectadas.
- Se ejecutó **una vez**, el 2026-10-15 a las 04:53 UTC. Termina con «nada se modificó». Evidencia completa: `var/aud/auditoria-vps-2026-10-15.txt` (no se versiona: `var/` está fuera de Git).
- No leyó valores del `.env`: sólo si cada variable está presente, los permisos y el número de línea de la que tiene espacios sin comillas.

## 2 · Lo comprobado en el servidor (2026-10-15, solo lectura)

| Tema | Hallazgo |
|---|---|
| Servidor | `srv1971687` (kernel Linux 6.8), UTC, encendido hace 4 semanas y 6 días, carga 0; 6,8 GiB libres de 7,9 de memoria; `/` con 92,2 GiB libres (4 % usado) |
| Aplicación en servicio | contenedor `nexo-app`, imagen **`nexo:production`** (`sha256:efe7920a4e49…`, creada el 2026-10-06), `BUILD_ID` = **`b412b9e`**, `healthy`, `restart: unless-stopped`, sistema de archivos de sólo lectura, puerto sin publicar |
| Base | PostgreSQL 18.6, base `aai`, **130 migraciones aplicadas** (última: `0130_el_mapeo_tambien_apunta_a_una_cuenta_viva.sql`), 23 MB, 1 empresa, 17 filas de bitácora, `timezone` por defecto UTC |
| Funciones de hash de la bitácora | `audit_chain_link`, `normative_audit_chain_link` y `verify_audit_chain` **sin configuración fija** (es decir, aún sin 0131/0132: lo esperado antes del despliegue) |
| Rol de la aplicación | `nexo_app`: no superusuario, sin `bypassrls`; 0 tablas con `company_id` sin RLS forzado |
| 0133 | **No está aplicada** (correcto: no va en este despliegue) |
| Código en el servidor | rama `main` en **`e1b9007`**, ningún archivo versionado modificado; sólo un archivo sin versionar (`docker-compose.prod.yml.bak.20260915131651`). Hay 131 migraciones en disco y 130 aplicadas |
| `.env` | permisos `600 root:root`; `EMAIL_PROVIDER=resend`; `POSTGRES_PASSWORD`, `DATABASE_URL` y `EMAIL_API_KEY` presentes; **la línea 10 tiene espacios sin comillas** (el `EMAIL_FROM` ya conocido; **no se edita**: ver el runbook) |
| Copias de resguardo | 17 `.dump` automáticos en `/opt/nexo/var/backups` (25 MB); la última, `aai-20261015T023238Z-auto.dump`, de hace 2 h (1 437 898 bytes); **sin archivo `.sha256`**; en el **mismo disco** que los datos de Docker |
| Tareas agendadas | `nexo-respaldo` (última corrida 02:32 UTC, `success`), `nexo-diario` (`success`), `nexo-correo` y `nexo-pagos` activas |
| Despliegues previos con el guion nuevo | `/opt/nexo/var/despliegues` **vacío** |
| Bases de restauración | `aai_restauracion_predeploy_20261009` y `aai_restauracion_tz` (22 MB cada una). No se tocaron |
| Alcance externo | `nexointelligence.com.ar` → `2.24.94.71`; `/health` por HTTPS: **200**; certificado de Let's Encrypt hasta el 2026-12-15; `/health/db` interno: `{"status":"ok","migrations":130,"version":"b412b9e"}` |

### Lo que la auditoría desmintió (importa para el despliegue)

1. **No existe ninguna imagen anterior etiquetada.** En el servidor hay una sola imagen `nexo:*`: `nexo:production`. **No están** `nexo:rollback-pre-tz-20261009` ni `nexo:ensayo-tz`, que el runbook v2 daba por existentes. Hoy, si algo saliera mal, **no habría a qué volver sin reconstruir**. Esto ya está corregido en el runbook (ver §4); el guion nuevo etiqueta la imagen vigente antes de construir.
2. **Las copias automáticas no se pueden verificar** (sin `.sha256`) y **no salen del disco**.
3. Que las tres funciones de hash no tengan configuración fija **confirma** que producción todavía no tiene la corrección de zona horaria (no se había comprobado nunca desde el 2026-10-09).

## 3 · Commit objetivo

| Commit | Contenido | ¿Entra en el despliegue de zona horaria? |
|---|---|---|
| `8d867d3` | La corrección de zona horaria (migraciones 0131/0132). **Ya está en `origin/main`** | Es el código de la corrección |
| **`13dd381`** | **Guiones, pruebas y runbook** (`desplegar.sh`/`respaldar.sh` endurecidos, auditoría, cobro manual, `servir-contra-pruebas`, `launch.json`). **No toca `apps/`, `packages/` ni las migraciones**: `git diff 8d867d3 13dd381 -- apps packages infrastructure/db` está vacío | **Sí: es el commit objetivo propuesto.** Mismo código en ejecución que `8d867d3`, con el despliegue endurecido |
| `aee8c2b` | 11 correcciones de la consola + 2 campos de lectura en la API | **No** (alcance aparte) |
| `229a7b6` | Idempotencia + **migración 0133** | **No. Se despliega después y por separado** |

Estado de publicación: **`13dd381`, `aee8c2b` y `229a7b6` están sólo en esta máquina** (`origin/main` sigue en `8d867d3`). El servidor hace `git fetch` desde `https://github.com/pablomonney/nexo.git`; **para que pueda traer `13dd381` hace falta un *push*, que no está autorizado**. Si se prefiere desplegar `8d867d3` tal cual, el servidor usaría el `desplegar.sh` viejo (el de `e1b9007`), **sin** la etiqueta de la imagen anterior ni la copia restaurada y cotejada: no se recomienda.

Un detalle que conviene conocer: la imagen construida desde `13dd381` incluye `scripts/` e `infrastructure/`, así que contendrá `scripts/cobro-manual.mjs`. Está **inactivo** (no lo invoca ningún timer ni la aplicación) y no habilita ningún cobro.

## 4 · Copia de resguardo y reversión

### Copia de resguardo

- **Hoy existe** la copia automática de las 02:32 UTC (§2), en el mismo disco y sin suma de control.
- **No se creó ninguna copia nueva** en esta pasada (no estaba autorizado).
- Durante el despliegue, el guion nuevo hace **su propia copia `predeploy-<commit>`, escribe su `.sha256`, la restaura en una base descartable y la coteja con la viva (tablas, filas y rangos) antes de migrar**; si cualquiera de esos pasos falla, no migra ni levanta nada.
- **Recomendación para la autorización final:** además, copiar esa `predeploy-<commit>.dump` **fuera del VPS** (a tu máquina) antes de migrar. Es un paso adicional que necesita tu aprobación expresa; el destino permanente es B3 (`docs/BACKUP_EXTERNO_Y_MONITOREO.md`).

### Reversión, en capas

| Capa | Cómo | Qué cubre | Qué NO cubre |
|---|---|---|---|
| 1 · Aplicación | `bash scripts/desplegar.sh --revertir` | Vuelve la imagen anterior (`nexo:previo-<fecha>`, etiquetada por el guion **antes** de construir) y la versión anterior. **No toca la base**: las migraciones 0131/0132 sólo redefinen las tres funciones de hash y la aplicación anterior es compatible con el esquema nuevo | Si la imagen etiquetada se borrara, se niega y lo dice |
| 2 · Datos | Restaurar `predeploy-<commit>.dump` (con su `.sha256`) según `docs/DESPLIEGUE.md` §7.5 | Estado de la base de antes del despliegue | **Los datos escritos después de la copia se pierden.** Con 1 empresa y 17 filas de bitácora el volumen es chico, pero es un cliente real |
| 3 · Reconstrucción | Construir de nuevo `b412b9e` | Sólo si se perdiera la imagen etiquetada | Tarda; es el camino que hoy sería el **único** (hallazgo 1) |

La capa 1 **se probó** ejecutando el guion real con un `docker` simulado (3 pruebas de `--revertir`: vuelve a la imagen anterior sin tocar la base; sin despliegue previo no hay a qué volver; si la imagen anterior ya no existe, se niega). **No se probó contra un Docker real ni en el servidor** (no hay Docker en esta máquina).

### Correcciones al runbook que salen de la auditoría

- A1: ya no compara contra `nexo:rollback-pre-tz-20261009` (no existe); compara contra la identidad medida el 2026-10-15 (`sha256:efe7920a4e49…`, `BUILD_ID` `b412b9e`).
- A2: el ensayo sobre `aai_restauracion_predeploy_20261009` necesita una imagen de ensayo que **no está** en el servidor: construirla es una escritura (imagen), incluida en el pedido de autorización, no hecha.
- Reversión: no hay más «segundo respaldo» por etiqueta; el único camino de vuelta es la etiqueta que crea el guion.

## 5 · Lo probado localmente (no dice nada del servidor)

| Qué | Resultado |
|---|---|
| Commit objetivo aislado (compila y sus pruebas; verificado antes de un ajuste sólo de documentación del runbook, que le dio el hash actual `13dd381`) | `tsc --build --force` verde; 69 archivos / 938 pruebas verdes (`tests/security`, `tests/unit`, cobro manual, órdenes de pago e imputación) |
| Commit de correcciones visuales (`aee8c2b`) aislado, sin la 0133 | `tsc --build --force` verde; 70 archivos / 958 pruebas verdes (`tests/security`, `tests/unit`, cobro manual, órdenes de pago e imputación) |
| `desplegar.sh` | 34 pruebas ejecutando el guion real con `docker` simulado y PostgreSQL local (incluye fallas en cada paso previo a levantar, sonda en rojo, `--revertir`) |
| `respaldar.sh` | 16 pruebas contra PostgreSQL local (suma, restauración en base descartable, cotejo) |
| Suite completa sobre el árbol final (`229a7b6`) | **214 archivos / 3497 pruebas verdes en hora de Argentina y otra vez con la base en UTC**; `typecheck`, `lint`, `lint:arch`, `check:no-float` y `audit:estructura` (**456** objetos) en verde. La verificación de cada commit por separado encontró y corrigió un fallo real: la prueba estática S-45 exigía registrar `cobro-manual.mjs` como script que pide la zona de negocio |

**No probado:** nada de lo anterior contra un Docker real, ni en el VPS, ni con una imagen construida de verdad. El primer contacto real de `desplegar.sh` con el servidor será el propio despliegue; por eso el runbook lo hace por pasos, con `--auditar` antes y con el simulacro de copia restaurada.

## 6 · Qué necesito de vos para la autorización final

1. **Autorización del *push*** de los commits locales (o indicarme otra vía para que el servidor obtenga `13dd381`).
2. **Autorización explícita del despliegue de `13dd381`**, con las acciones que incluye en el servidor: `git fetch`/`merge --ff-only` del commit, `docker tag` de la imagen vigente, `docker build`, **crear la copia `predeploy-<commit>`** y una base descartable para restaurarla, aplicar 0131/0132, reiniciar el contenedor de la aplicación (corte breve), sondas.
3. Si querés el ensayo previo A2: autorización para **construir la imagen de ensayo** y escribir en `aai_restauracion_predeploy_20261009`.
4. Si querés la copia fuera del VPS antes de migrar: el destino (tu máquina u otro).
5. La ventana: 09:00–18:00 ART para el despliegue; **V7** entre las 21:00 y las 24:00 ART.

Hasta recibir esas autorizaciones **no se ejecuta ninguna operación productiva**.
