# Plan de despliegue de la próxima versión (idempotencia + recuperación de cuenta + lo demás)

**Estado: ENSAYADO LOCALMENTE SOBRE DATOS REALES DE PRODUCCIÓN. NO DESPLEGADO.** Fecha: 2026-10-15. Producción corre hoy `bfbc3bb` (132 migraciones). Este es el **segundo lanzamiento**, separado del de zona horaria a propósito: la zona horaria se confirma con **V7 esta noche** (21:00–24:00 ART) y recién después conviene mover otra cosa.

## 1 · Qué trae (desde `bfbc3bb`)

| Cambio | Migración | Riesgo |
|---|---|---|
| **Idempotencia de caja y stock** + transiciones atómicas (órdenes de pago, recepciones, imputaciones), con las 11 correcciones visuales de la consola | **0133** (aditiva: columnas anulables, índices parciales, triggers de transición) | Medio: la API **exige** `Idempotency-Key` en caja y stock; la consola nueva ya la manda. Un cliente de la API que no la mande recibe `400` |
| **«Olvidé mi contraseña»** (`/auth/recuperar`, `/auth/restablecer`) | **0134** (sólo registra una acción de bitácora) | Bajo. Depende de que el correo salga (B6: sin verificar) |
| **Recuperar una cuenta a mano** (`scripts/recuperar-cuenta.sh`) | **0135** (dos acciones de bitácora) | Bajo (no corre solo) |
| El pool no cae por una conexión ociosa cortada | — | Bajo |
| Datos bancarios del cobro manual en avisos y en Suscripción | — | Bajo; **sin datos declarados no muestra nada** |
| El ingreso admite códigos de recuperación del segundo factor; «Recordar en este dispositivo» (ya estaba) | — | Bajo |
| Observaciones visuales O-3, O-4, O-7; `.dockerignore` con `**/*.tsbuildinfo` | — | Bajo |

## 2 · El ensayo que se hizo (local, sobre datos reales)

Se bajó la copia `predeploy-bfbc3bb` (verificada: `sha256 20575d38…`, 130 migraciones, 1 empresa, 18 filas de bitácora) y se restauró en una base local descartable. Sobre esa copia:

| Qué | Resultado |
|---|---|
| `migrate.mjs up` | **130 → 135**: 0131, 0132, 0133, 0134 y 0135 aplicadas sin error |
| `audit:estructura` | **456** objetos presentes |
| Cadena de auditoría (`verify-audit-chain`, `recalcular-cadena`) | íntegra: 18 entradas, 0 rotas |
| Libro mayor (`verify-ledger`) | 3 líneas, coinciden |
| La versión nueva contra esa base | arranca; `/health/db` dice 135 migraciones |
| «Olvidé mi contraseña» con la **cuenta real, dentro de la copia** | recuperar → código en la bandeja → restablecer (200) → el código otra vez (400) → login con la contraseña nueva (200, **sigue pidiendo segundo factor**) → bitácora `RESTABLECER_CONTRASENA` |
| Suite completa del repositorio | **222 archivos / 3566 pruebas verdes en hora de Argentina y en UTC**; `typecheck`, `lint`, `lint:arch`, `check:no-float` y `audit:estructura` (456) en verde |

La copia y la base descartable se **borraron** al terminar. **No probado:** nada de esto en el servidor, ni con Docker real, ni con un correo real saliendo.

## 3 · El procedimiento (el mismo que funcionó el 2026-10-15)

```bash
# 0 · desde tu máquina: confirmar que el servidor sigue como se espera (solo lectura)
ssh … 'bash -s' < scripts/auditar-servidor.sh

# 1 · en el servidor: traer el commit EXACTO (el clon del servidor sólo sigue `main`; si el commit está en `main`, alcanza con fetch)
cd /opt/nexo && git fetch origin && git merge --ff-only <SHA-DE-40-CARACTERES>
#    y comprobar que NO queden tsconfig.tsbuildinfo viejos (ya los cubre el .dockerignore de esta versión, pero se mira):
find /opt/nexo -name '*.tsbuildinfo' -not -path '*/node_modules/*' | wc -l

# 2 · desplegar (copia verificada y restaurada ANTES de migrar; imagen anterior etiquetada; sondas)
bash scripts/desplegar.sh --commit <SHA-DE-40-CARACTERES>
```

Qué hace y qué pasa si falla cada paso: **igual que** `docs/PLAN_DESPLIEGUE_ZONA_HORARIA.md` §1 (el guion es el mismo). La diferencia es lo que migra: 0133, 0134 y 0135.

## 4 · Verificación posterior

1. `/health/db`: `migrations: 135`, `version: <sha corto>`.
2. `audit:estructura` y `verify-audit-chain` / `recalcular-cadena` / `verify-ledger` (los mismos comandos de V3, V5, V6 del runbook).
3. Idempotencia (**necesita una sesión iniciada**, o sea, la hacés vos desde la consola o me pasás un token de prueba): abrir una sesión de caja y registrar un movimiento (tiene que andar: la consola manda la clave); repetir el pedido sin cambiar nada desde la red del navegador devuelve `200` con `Idempotent-Replayed: true` y **no** duplica el movimiento (`docs/DISENO_IDEMPOTENCIA.md` §11, V-I2…V-I5).
4. «Olvidé mi contraseña»: **no se prueba con una cuenta real en producción** sin tu aviso (manda un correo y, si el código se usa, cambia una contraseña). Se prueba **una vez**, con tu cuenta y tu permiso expreso, cuando el dominio de envío de Resend esté verificado.

## 5 · Reversión

`bash scripts/desplegar.sh --revertir` vuelve a `bfbc3bb`. **No toca la base**: las columnas de la 0133 son anulables y los índices parciales, y el código viejo no los toca; las filas de `audit_actions` de la 0134 y 0135 son inertes. Efecto de dejar la 0133 con el código viejo (triggers de transición activos): `docs/DISENO_IDEMPOTENCIA.md` §11. **No probado:** el código de `bfbc3bb` contra el esquema 135 (sólo razonado).

## 6 · Antes de dar el «sí»

- **V7 pasó** (esta noche). Si V7 falla, **no** se despliega esto: se arregla la zona horaria primero.
- Que decidas **cuándo** (ventana 09:00–18:00 ART) y que alguien pueda mirar la consola después.
- Opcional pero recomendado: cargar la cuenta bancaria (`NEXO_COBRO_*`) en el `.env` del servidor **antes**, para que los avisos de mora ya digan a dónde transferir. Editar el `.env` de producción es una acción tuya o con tu orden expresa.
