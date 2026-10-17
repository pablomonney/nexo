# Registro del despliegue del 2026-10-15 — corrección de zona horaria (`bfbc3bb`)

**Estado: DESPLEGADO EN PRODUCCIÓN. V1–V7 pasaron** (V7 el 2026-10-16 a las 21:17 ART).
Autorizado por el titular el 2026-10-15 («autorizo el despliegue de `bfbc3bb`»). Ejecutado desde esta sesión por SSH.
Lo comprobado **en producción** está marcado como tal; lo demás es local.

## 1 · Qué se desplegó

| | |
|---|---|
| Commit | `bfbc3bb00ae1b45ede41e02836e81eb1ece0ebd8` (rama `release/zona-y-login`, publicada en GitHub) = `13dd381` (corrección de zona horaria + guiones endurecidos) + el login con «Recordar en este dispositivo» |
| Migraciones aplicadas | **0131** y **0132** (130 → 132). **No** la 0133 |
| Imagen en servicio | `nexo:production` = `nexo:bfbc3bb`. La anterior (`b412b9e`, `sha256:efe7920a4e49…`) quedó como `nexo:previo-20261015203329` (y `nexo:previo-20261015203047`, del primer intento, apunta a la misma imagen) |
| Copia previa | `/opt/nexo/var/backups/aai-20261015T203400Z-predeploy-bfbc3bb.dump`, `sha256 20575d38197af8f172f6b8b745369d5566bc0bbb98c6c2432eb62959cb6a8028`. Se **restauró de verdad** en una base descartable y se cotejó: 169 tablas, 1251 filas, dentro del rango de la viva. La base descartable se borró |
| Registro del despliegue | `/opt/nexo/var/despliegues/ultimo.env` (lo lee `--revertir`) |
| Resultado del guion | `fallos: 0   avisos: 0` («Todo lo verificable pasó») |

## 2 · Cronología (UTC; ART = UTC−3)

| Hora | Hecho |
|---|---|
| 20:29 | *Push* de `release/zona-y-login` (`bfbc3bb`). `main` sigue en `8d867d3` |
| ~20:30 | Auditoría de solo lectura previa: el servidor idéntico al de la mañana (imagen `efe7920a4e49`, `b412b9e`, 130 migraciones, árbol limpio, 92 GiB libres) |
| ~20:30 | Código del servidor avanzado a `bfbc3bb` con `git merge --ff-only` (132 migraciones en disco, ninguna 0133) |
| 20:30:47 | **Primer intento: el guion se cortó solo** en `npm run build` (§3). Producción **sin cambios** (imagen, base y servicio intactos; no se llegó a la copia ni a las migraciones) |
| 20:33:29 | **Segundo intento**, tras mover los restos de compilación: construcción 24 s, copia verificada, migraciones, reinicio, sonda `healthy`, ruteo de punta a punta |

## 3 · El incidente del primer intento

`desplegar.sh` construyó la imagen y falló en `npm run build` con **1073 errores TS** («Cannot find module '@aai/shared'…»).

- **Causa (comprobada con un contenedor descartable, sin tocar nada del servicio):** el árbol de `/opt/nexo` tenía **17 `tsconfig.tsbuildinfo` de una compilación del 2026-10-07** (ignorados por Git). El `.dockerignore` excluía `dist` pero **no** esos archivos: dentro del build, `tsc --build` leyó «ya está compilado», no emitió ningún `.d.ts` y todo lo que importa un paquete del monorrepo falló. Con los `tsbuildinfo` viejos: 1073 errores; sin ellos: 0 errores y código 0.
- **Lo que se hizo en el servidor:** se **movieron** (no se borraron) a `/opt/nexo/var/tsbuildinfo-previos-20261015/`. Son artefactos regenerables; no se usan en ejecución.
- **Lo que se hizo en el repositorio:** `**/*.tsbuildinfo` en `.dockerignore` + una prueba en S-43 (`tests/security/imagen-de-produccion.test.ts`), con mutación comprobada. **Esta corrección está en un commit local de `main` y NO está en `bfbc3bb`** (la imagen desplegada se construyó con el árbol limpio de esos archivos).
- **Por qué el guion cortó bien:** falló antes de la copia y de las migraciones («Producción: SIN CAMBIOS»), que es exactamente para lo que está escrito así.

### Otros hallazgos del despliegue

1. **El clon del servidor sólo sigue `main`** (`remote.origin.fetch = +refs/heads/main:refs/remotes/origin/main`): `git fetch origin` no baja una rama del release. Se resolvió con `git fetch origin release/zona-y-login` (explícito) antes del `--ff-only`. Si se vuelve a desplegar desde una rama, hay que repetirlo o publicar en `main`.
2. **`docker exec -i` dentro de un script enviado por `ssh … 'bash -s'` se come el resto del script** (lee la entrada estándar). Le pasó al primer envío de las verificaciones V1–V6 (sólo se ejecutó V1 y parte de V4, todo de lectura). Se corrigió quitando `-i`.
3. El runbook daba por hechos `nexo:rollback-pre-tz-20261009` y `nexo:ensayo-tz`: **no existían** (ya figuraba en la auditoría previa). Ahora sí hay una imagen anterior etiquetada.

## 4 · Verificaciones posteriores (en producción, 2026-10-15 ~20:36 UTC)

Evidencia completa: `var/aud/verificacion-despliegue-bfbc3bb.txt` (local, fuera de Git).

| | Resultado |
|---|---|
| **V1** | `/health/db` público: `{"status":"ok","migrations":132,"version":"bfbc3bb"}` |
| **V4** | 0131 = `67534b7e…` y 0132 = `fd1546d9…` (los esperados). Las tres funciones de hash: `TimeZone=UTC,DateStyle=ISO, MDY` |
| **V2** | `verificar-zona-de-negocio.mjs`: `CODIGO=0`; zona de la aplicación `America/Argentina/Buenos_Aires`; conexión cruda `UTC`; matriz de 14 instantes correcta; `zonaOk`, `matrizOk`, `fechaOk`, `distingue` = `true` |
| **V3** | `verify-audit-chain --observacional`: «prueba (30712345671) — 18 entrada(s), cadena íntegra». **Nombra a la empresa y sus entradas** (no es un «Nada que verificar») |
| **V5** | `recalcular-cadena --ultimas 50`: 18 revisadas, `"ok": true`, `"rotas": 0` |
| **V6** | `verify-ledger --observacional`: 3 líneas proyectadas, coinciden. `/health` ok, sin errores en el log del contenedor |
| Consola | `/consola` en producción ya trae el formulario con «Recordar en este dispositivo» (HTTP 200) |
| Suscripción | La cuenta «prueba» sigue `ACTIVA` hasta 2099-12-31 |

## 5 · Lo que NO está verificado

- **V7** (la única comprobación que depende del reloj real): hay que correr `verificar-zona-de-negocio.mjs` **entre las 21:00 y las 24:00 ART** (00:00–03:00 UTC), cuando la fecha UTC ya es un día posterior a la argentina. En V2 de hoy `hoyEnUtc` y la fecha argentina coinciden (2026-10-15), por lo que **no distingue el defecto real**. Hasta V7, el estado oficial es *«corrección implementada y desplegada; pendiente de confirmación en producción durante la franja 21:00–24:00 ART»*.
- El inicio de sesión **de punta a punta con «Recordar en este dispositivo»** en producción: sólo se vio que la casilla está en el HTML; no se inició sesión con una cuenta real (no se usaron credenciales).
- Si los usuarios que ya estaban conectados tuvieron que volver a iniciar sesión tras el reinicio: no se midió.

## 6 · Cómo volver atrás

```bash
bash scripts/desplegar.sh --revertir      # vuelve a nexo:previo-20261015203329 (b412b9e); NO toca la base
```
La base queda en 132 migraciones y la versión anterior la soporta (0131/0132 sólo fijan la zona y el formato de fecha de tres funciones; comprobado localmente con el código de `b412b9e`, `docs/PLAN_DESPLIEGUE_ZONA_HORARIA.md` §3). Para volver también los **datos**: restaurar la copia `predeploy-bfbc3bb` (con su `.sha256`) según `docs/DESPLIEGUE.md` §7.5; se perdería lo escrito desde las 20:34 UTC. Sólo con decisión expresa del titular.

## V7 — PASÓ (2026-10-16, 21:17 ART)

Corrida de sólo lectura en producción dentro de la franja (`verificar-zona-de-negocio.mjs` desde la imagen `nexo:production`). Cabecera: `UTC=2026-10-17 ART=2026-10-16 hora_ART=21:17:08` (la fecha UTC ya era un día posterior a la argentina, así que la prueba distingue el defecto).

- Desde la aplicación: `zona = America/Argentina/Buenos_Aires`, `currentDate = 2026-10-16` (= fecha ART de hoy).
- Conexión cruda: `zona = UTC`, `currentDate = 2026-10-17` (el día que habría usado el código sin la corrección).
- `hoyEnArgentinaCalculadoFueraDeLaBase = 2026-10-16`, `hoyEnUtc = 2026-10-17`.
- Funciones de hash (`audit_chain_link`, `normative_audit_chain_link`, `verify_audit_chain`) fijadas con `TimeZone=UTC | DateStyle=ISO, MDY`.
- `zonaOk`, `matrizOk`, `fechaOk` y `distingue`: **true**. Código de salida 0.

Conclusión: la corrección de zona horaria queda **confirmada en producción**. Estado oficial: *corrección implementada, desplegada y verificada con la fecha UTC un día adelante*.
