# Plan exacto para desplegar `13dd381` (corrección de zona horaria) — para tu revisión

**Estado: PLAN, SIN AUTORIZACIÓN DE EJECUCIÓN.** Fecha: 2026-10-15. Nada de lo que sigue se ejecutó en el servidor. Separa siempre lo **probado en esta máquina** de lo **que sólo se verá en el servidor**.

Complementa a `docs/RUNBOOK_DESPLIEGUE_ZONA.md` (los comandos, de a un paso) y a `docs/AUDITORIA_PREVIA_VPS_2026-10-15.md` (el estado del servidor).

## 0 · Qué se despliega y qué no

| | |
|---|---|
| **Commit** | `13dd3818ee2d67cf4f026eda0c8c114d581da81b` (`13dd381`). Se pasa **completo** (40 caracteres) a `--commit` |
| **Contenido** | La corrección de zona horaria de `8d867d3` (sin cambios de código: `git diff 8d867d3 13dd381 -- apps packages infrastructure/db` está vacío) + guiones, pruebas y docs |
| **Migraciones que se aplican** | **0131** (`funciones_de_hash_en_utc`) y **0132** (`funciones_de_hash_en_formato_iso`): 130 → 132 |
| **Lo que NO entra** | La **0133** y toda la idempotencia (`229a7b6`), y las 11 correcciones de la consola (`aee8c2b`). Son lanzamientos aparte |
| **Prerrequisito pendiente** | El commit tiene que estar en el remoto para que el servidor lo traiga. **Hoy `origin/main` sigue en `8d867d3`: el *push* no se pudo ejecutar** (lo denegó el control de permisos de la sesión). Sin *push*, el servidor no puede obtener `13dd381` |

### Qué hacen 0131 y 0132 (leído del SQL, `infrastructure/db/migrations/`)

Son tres sentencias cada una, del tipo `ALTER FUNCTION audit_chain_link() SET timezone = 'UTC'` (0131) y `SET datestyle = 'ISO, MDY'` (0132), sobre `audit_chain_link`, `normative_audit_chain_link` y `verify_audit_chain`. **No reescriben tablas, no tocan filas, no cambian la fórmula del hash.** Los hashes ya escritos siguen siendo válidos. La propia 0131 declara que es compatible con la aplicación anterior.

## 1 · El procedimiento, paso por paso, y qué pasa si falla

`scripts/desplegar.sh --commit 13dd3818ee2d67cf4f026eda0c8c114d581da81b` (probado ejecutando el guion real contra un `docker` simulado; **nunca contra Docker real**).

Antes, y sin escribir nada: `bash scripts/desplegar.sh --auditar --commit <sha>` (informa el estado y compara contra el commit; no avanza el código, no construye, no copia, no migra).

| # | Paso (lo que hace) | ¿Escribe en el servidor? | Si falla |
|---|---|---|---|
| 1 | **Entorno**: docker, compose v2, `/opt/nexo`, `.env` (existe y permisos 600; **no se lee su contenido**), red `nexo`, espacio libre (avisa si hay menos de 2 GiB) | No | Corta. **Producción sin cambios** |
| 2 | **Código**: rechaza si hay archivos *versionados* modificados en el servidor. `git fetch origin` y `git merge --ff-only 13dd381…` (**sólo ese commit**, no la punta del remoto) | **Sí, el árbol de archivos** de `/opt/nexo` pasa de `e1b9007` a `13dd381`. No cambia lo que está sirviendo | Commit inexistente, no avance rápido, `fetch` o `merge` fallidos: corta, **sin cambios**. Si más adelante otro paso falla, el árbol queda en `13dd381` (inocuo: lo que sirve es la imagen) |
| 3 | **Imagen anterior conservada**: `docker tag <imagen en servicio> nexo:previo-<fecha>` **antes** de construir; verifica que la etiqueta apunta a esa imagen | Sí (una etiqueta) | Corta. Sin cambios |
| 4 | **Construcción**: `docker build -t nexo:production -t nexo:13dd381 .` | Sí (imagen nueva; CPU y disco durante minutos) | Corta; `nexo:production` **no cambió**. El contenedor sigue con la imagen anterior |
| 5 | **Inspección de la imagen**: existen `/app/apps`, `packages`, `node_modules`, `infrastructure`, `scripts`; los 6 scripts de los timers; **132 migraciones**; usuario `node`; **sin `.env` adentro** | No (contenedores efímeros) | Corta. **Atención:** en este punto `nexo:production` ya apunta a la imagen nueva (mala) aunque no sirva. Si alguien ejecutara `docker compose up -d` a mano, la levantaría: recuperación = `docker tag nexo:previo-<fecha> nexo:production` |
| 6 | **PostgreSQL y esquema** (sólo `SELECT`): contenedor sano, sin puertos publicados, rol `nexo_app` sin superusuario ni `bypassrls`, 0 tablas con `company_id` sin RLS forzado, y **migraciones en el repositorio = migraciones en la imagen (132)** | No | Corta (también si el repositorio y la imagen no coinciden: «la imagen no es la de este commit»). Sin cambios |
| 7 | **Documentos**: `mkdir -p`, `chown 1000:1000`, `chmod 750` sobre `/opt/nexo/var/documents` | Sí (idempotente; ya está con ese dueño) | Aviso o corte; sin efecto sobre lo que sirve |
| — | **Puerta**: si hay **cualquier** `✘` hasta acá, no se hace la copia, no se migra, no se levanta nada | | Corta. **Producción sin cambios** |
| 8 | **Copia de resguardo `predeploy-13dd381`**, `respaldar.sh --verificar-restauracion` (§2) | Sí (un archivo `.dump` + `.sha256` en `/opt/nexo/var/backups`; una base **descartable** `aai_restauracion_verif_<sello>` que se crea, se compara y se **borra**) | `pg_dump` falla, el índice no se lee, `pg_restore` falla, **la restauración trae menos filas que la viva** o falta una tabla: se **descarta la copia**, se limpia la base descartable y **el despliegue se corta antes de migrar**. Producción sin cambios |
| 9 | **Registro** del despliegue en `/opt/nexo/var/despliegues/ultimo.env` (imagen anterior, versión anterior, copia, huella, migraciones antes) — **antes** de lo irreversible | Sí | Corta si no se puede escribir |
| 10 | **Migraciones** (0131, 0132) desde un **contenedor aparte** con la imagen nueva: `node scripts/migrate.mjs up`. Cada migración corre en **su propia transacción** | **Sí: es el primer cambio en la base** | Falla la 0131: no se aplicó nada. Falla la 0132: queda aplicada la 0131. En ambos casos **la aplicación anterior sigue sirviendo y es compatible** con ese esquema, y el guion lo dice. No se levanta la imagen nueva. Si «anduvo» pero el conteo no es 132: corta |
| 11 | **Levantar**: `docker compose up -d` (recrea `nexo-app` con la imagen nueva) y espera a la sonda `healthy` (hasta 20 × 3 s = 60 s) | **Sí: el reinicio de la aplicación** (corte de segundos a ~1 minuto) | La sonda no pasa: el guion termina en **rojo** y ofrece `--revertir`. **No revierte solo**: el contenedor nuevo queda arriba sin pasar la sonda hasta que se ejecute la reversión (§3) |
| 12 | **Verificación posterior** (sólo lectura, más una escritura de prueba en el volumen de documentos): sonda, política de reinicio, usuario, puertos, sistema de archivos de sólo lectura, `/health/db` desde la red, Traefik: redirección HTTP, HTTPS de punta a punta, certificado | Una marca de archivo que se borra | Cada `✘` suma un fallo; el resumen termina en rojo y ofrece `--revertir` |

**Qué imagen se conserva para la reversión:** `nexo:previo-<fecha>` (la que sirve hoy: `nexo:production`, `sha256:efe7920a4e49…`, `BUILD_ID` `b412b9e`), creada en el paso 3 y anotada en `ultimo.env`. **Hoy no existe ninguna otra** (auditoría del 2026-10-15): sin ese paso no habría a qué volver sin reconstruir.

## 2 · La copia `predeploy` se restaura y se coteja **antes** de migrar (verificado localmente)

Orden del guion (`tests/unit/desplegar.test.ts`, «hace las cosas EN ORDEN»): etiquetar → construir → **copia verificada** → migrar → levantar. La copia (`infrastructure/systemd/respaldar.sh --etiqueta predeploy-13dd381 --verificar-restauracion`):

1. `pg_dump` en formato custom; escribe el `.sha256`; lee el índice del volcado (`pg_restore --list`).
2. **Restaura de verdad** en `aai_restauracion_verif_<sello>` (una base nueva, de nombre único; el borrado está protegido por una expresión regular y nunca toca otra base: no alcanza a `aai_restauracion_tz` ni a `aai_restauracion_predeploy_20261009`).
3. **Coteja**: cuenta las filas de **cada tabla** en la base viva antes y después del volcado, y exige que la restauración quede **dentro de ese rango** (la base viva sigue recibiendo escrituras; una igualdad exacta daría falsos rojos). Falta una tabla o hay menos filas → falla.
4. Borra la base descartable y emite `RESPALDO_RESTAURACION=ok`. **`desplegar.sh` exige esa línea:** sin `ok` aborta («una copia sin restaurar es una hipótesis»).

Probado con PostgreSQL local real (`tests/integration/respaldar.test.ts`) y con el guion de despliegue contra un `docker` simulado: «la copia de resguardo falla: no se migra ni se levanta», «la copia salió pero NO se probó restaurándola: no alcanza», y los casos con menos filas y con una tabla faltante. **No probado:** en el servidor (otra versión de PostgreSQL cliente/servidor, otro volumen).

## 3 · Reversión, y que la aplicación anterior arranca con el esquema resultante

**Aplicación:** `bash scripts/desplegar.sh --revertir` → vuelve a etiquetar `nexo:previo-<fecha>` como `nexo:production`, `docker compose up -d`, espera la sonda. **No toca la base.** Si la imagen etiquetada ya no existe, se niega y lo dice.

**¿La aplicación anterior (`b412b9e`) arranca con el esquema de 132 migraciones? Comprobado localmente así:**

1. El arranque de `b412b9e` sólo exige que **no falte** ninguna migración de las suyas (`migracionesFaltantes(enDisco, aplicadas)`, una diferencia de conjuntos): tener migraciones *de más* no lo frena.
2. Ensayo con un clon local de la base de desarrollo (130 migraciones, igual que producción): se aplicó `migrate.mjs up` del árbol de `13dd381` → **130 → 132**, con los checksums esperados (`0131…` = `67534b7e…`, `0132…` = `fd1546d9…`, idénticos a los del runbook) y las tres funciones con `TimeZone=UTC,DateStyle=ISO, MDY`. Un clon de control quedó en 130 y sin configuración en las funciones (el estado de producción hoy).
3. Se compiló `b412b9e` en un *worktree* aparte (con su propio `npm ci`: no usa los paquetes del árbol actual) y **se arrancó contra el clon de 132**: `GET /health/db` → `{"status":"ok","migrations":132,"version":"b412b9e"}`.
4. **La suite completa del código viejo (`b412b9e`) contra el clon de 132 migraciones:** 3056 pruebas, **2977 pasaron, 73 omitidas y 6 fallaron** (5 archivos). Para saber si esas 6 vienen de la 0131/0132, se corrieron **los mismos 5 archivos contra el clon de control de 130 migraciones** (sin las dos migraciones): **fallan exactamente las mismas 6**. Son pruebas que esperan encontrar la regla de IVA `AR-IVA-CF-VINCULACION-001` en `DRAFT` y una guarda que exige que el nombre de la base termine en `_test`; fallan igual sin las migraciones, así que **no son atribuibles a ellas** (el clon sale de la base de desarrollo, que no es una base de pruebas limpia; no se investigó más allá de comprobar que el control falla igual). Es una comparación 132 contra 130, no una prueba de que la suite vieja esté verde en general.

**No probado:** la imagen Docker anterior sobre el esquema nuevo (no hay Docker local); sólo su código. Ni nada de esto en el servidor.

**Datos:** si hiciera falta volver también los datos: restaurar `predeploy-13dd381.dump` (con su `.sha256`) según `docs/DESPLIEGUE.md` §7.5. **Se pierde lo escrito desde la copia.** Sólo con tu decisión expresa.

## 4 · Que desplegar `13dd381` no arrastre la 0133 aunque `origin/main` tenga commits posteriores

- El guion nunca despliega «lo último»: hace `git merge --ff-only <sha>` con el commit que se le pasa, y se niega si el servidor no termina exactamente ahí. `git fetch` trae también los commits posteriores (`229a7b6` con la 0133), pero el árbol y la imagen se construyen sólo con lo que hay hasta `13dd381`.
- **Prueba agregada:** `tests/unit/desplegar.test.ts`, «despliega EXACTAMENTE el commit pedido aunque el origen ya tenga commits posteriores con una migración nueva (la 0133)»: arma un origen con un commit posterior que agrega `0133_*.sql`, despliega el commit anterior y comprueba que el servidor termina en ese commit, que el archivo de la 0133 **no** está en el árbol, que `origin/main` sí lo ve, que la base queda en 132 y que el registro no menciona el commit posterior. **Mutación:** si el guion hiciera `merge --ff-only origin/main`, la prueba falla (comprobado).
- Doble red de seguridad: el guion compara las migraciones del árbol con las de la imagen (132 = 132); y el paso 10 sólo migra hasta lo que trae esa imagen. La imagen de `13dd381` **no contiene** el archivo de la 0133.
- Además `--auditar --commit 13dd381…` antes del despliegue tiene que decir «el servidor ya está en…» o avisar la diferencia, sin avanzar.

## 5 · Las verificaciones V1–V7, y cuándo abortar

Los comandos exactos están en `docs/RUNBOOK_DESPLIEGUE_ZONA.md`. Resumen con los criterios:

| | Qué mide | Pasa si | Si no pasa |
|---|---|---|---|
| **A1** (antes) | Identidad del servidor: imagen = `sha256:efe7920a4e49…`, `BUILD_ID` `b412b9e`, 130 migraciones, espacio ≥ 2 GiB, tareas con última corrida `success` | Todo coincide | **No se despliega.** Algo cambió desde la auditoría: se vuelve a auditar |
| **A2** (antes, opcional) | `migrate.mjs up` sobre una **copia** de producción | 130 → 132, mismos checksums, funciones con `UTC` e `ISO`, `recalcular-cadena` con `"ok": true` y `"rotas": 0` | No se despliega. **No se ejecutó** (ver §6) |
| **V1** | `/health/db` | `version` = `13dd381` y `migrations` = 132 | Revertir la aplicación |
| **V2** | `verificar-zona-de-negocio.mjs` | `CODIGO=0`, zona de la aplicación `America/Argentina/Buenos_Aires`, conexión cruda `UTC`, `zonaOk`/`matrizOk`/`fechaOk`/`distingue` = `true` | La aplicación anda pero la corrección no está activa: **no se declara corregido**; se investiga. Revertir sólo si hay errores visibles |
| **V3** | `verify-audit-chain --observacional` (después de iniciar sesión en la consola) | Sin roturas, y la salida **nombra a la empresa y sus entradas** («Nada que verificar» **no** es un pase) | **Abortar:** cadena rota. Revertir la aplicación, no escribir más, y decidís vos si hay que volver los datos |
| **V4** | Las 3 funciones | `TimeZone=UTC` y `DateStyle=ISO, MDY` | Investigar antes de seguir |
| **V5** | `recalcular-cadena --ultimas 50` | Sin roturas | Igual que V3 |
| **V6** | `verify-ledger --observacional`, `/health`, log del contenedor | Verde, sin errores nuevos | Investigar; revertir si hay errores de servicio |
| **V7** | **Entre las 21:00 y las 24:00 ART**: la fecha UTC es un día posterior a la argentina | `CODIGO=0` y `desdeLaAplicacion.currentDate` = hoy en Argentina | Hasta que pase, el estado oficial es «implementada y desplegada; **pendiente de confirmación en producción**» |

### Criterios para ABORTAR (resumen)

1. **Cualquier `✘` antes de la copia** → el guion corta solo. No hay nada que revertir.
2. **La copia no se restaura o no coteja** → corta solo, antes de migrar.
3. **Una migración falla** → corta solo; la aplicación anterior sigue sirviendo. No se vuelve a intentar en caliente: se revisa el mensaje.
4. **La sonda no pasa a `healthy`** en ~1 minuto → `--revertir` **de inmediato**; no se depura en producción mientras está caída.
5. **V1, V3, V5 en rojo, o errores 5xx / inicio de sesión que no funciona** → `--revertir`. V3/V5 además detienen todo uso hasta decidir.
6. **Regla general:** ante un resultado que no está en esta lista, **se detiene y se consulta**; no se sigue «a ver qué pasa».
7. **Volver los datos** (restaurar la copia) es una decisión separada y tuya; implica perder lo escrito desde la copia.

## 6 · A2: por qué no se ejecutó en el servidor

Pediste ejecutarlo «únicamente si podés garantizar que no modifica producción». **No puedo garantizarlo**, así que no lo ejecuté:

- Necesita una imagen de ensayo (`nexo:ensayo-tz`) que **no existe** en el servidor: construirla es escribir en el Docker del servidor de producción (CPU, disco, etiquetas).
- Escribe en `aai_restauracion_predeploy_20261009`, dentro del **mismo servidor PostgreSQL** que atiende a producción (carga y disco compartidos), y esa base es de las que acordamos no tocar sin autorización.
- No hay forma de demostrar «cero efecto en producción» desde acá.

**Lo que sí hice, sin tocar el servidor:** el mismo ensayo sobre un clon local de una base con las 130 migraciones (§3, punto 2), con los mismos checksums y los mismos resultados esperados. Es evidencia **local**: no sustituye a A2 sobre la copia real. Si querés A2 igual, lo autorizás expresamente y con las acciones que implica.

## 7 · Qué necesito de vos para pasar a la autorización final

1. **Autorizar el *push*** de los commits (o ejecutarlo vos): sin él, el servidor no puede traer `13dd381`.
2. Decidir sobre **A2** en el servidor (§6) y sobre bajar la copia `predeploy` a tu máquina antes de migrar.
3. La **ventana** (09:00–18:00 ART) y que alguien esté disponible para V7 entre las 21:00 y las 24:00.
4. Tu **autorización específica** del despliegue de `13dd381` con las acciones de la tabla del §1.
