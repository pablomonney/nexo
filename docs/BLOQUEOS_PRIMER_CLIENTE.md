# Bloqueos para el primer cliente — lista actualizada (2026-10-15, segunda pasada)

Reemplaza la lista de `docs/FALTANTES_NEXO_2026-10-14.md` (se mantiene como inventario histórico). La regla de este documento:
**lo probado localmente no se mezcla con lo comprobado en el VPS, y producción no figura como verificada sin evidencia obtenida allí.**

## 0 · Qué es cada columna

- **Local** — se ejecutó en esta máquina (PostgreSQL local, `aai_test`, scripts con *shims*). No dice nada del servidor.
- **VPS** — evidencia obtenida en el servidor. Hay **dos fuentes**: (a) la **auditoría de solo lectura del 2026-10-15** que ejecutó esta sesión por SSH con autorización (`docs/AUDITORIA_PREVIA_VPS_2026-10-15.md`, evidencia en `var/aud/auditoria-vps-2026-10-15.txt`; no modificó nada), y (b) lo que ejecutó el titular el 2026-10-08/09 (A.4b y V2, **sobre una restauración de la copia, nunca sobre producción**), informado a esta sesión.
- **Producción** — lo que está sirviendo a clientes. Lo único comprobado hoy es lo que mostró la auditoría de solo lectura (estado, no comportamiento): ver §1.

## 1 · Estado de lo construido

| Pieza | Local | VPS | Producción |
|---|---|---|---|
| **Corrección de zona horaria** (`8d867d3`, migraciones 0131/0132) | Suite completa verde en UTC y en hora de Argentina | A.4b **PASS con observación** y V2 **PASS** sobre una restauración (`aai_restauracion_tz`, `nexo:ensayo-tz`) — evidencia del titular, `docs/AUDITORIA_ZONA_HORARIA.md` §10–11 | **No desplegada. Verificado el 2026-10-15 (solo lectura): corre la imagen `b412b9e`, 130 migraciones aplicadas, y las tres funciones de hash de la bitácora no fijan zona horaria** (es decir, sin 0131/0132) |
| **`desplegar.sh` y `respaldar.sh` endurecidos** (Y1) | 34 pruebas del despliegue + 16 del respaldo, ejecutando los guiones reales con un `docker` simulado y PostgreSQL local; incluye la corrección de una carrera propia (`docker ps | grep -q` con `pipefail`) | Nunca ejecutados en el servidor (`/opt/nexo/var/despliegues` está vacío) | **No desplegados** |
| **`auditar-servidor.sh`** (auditoría de solo lectura) | 15 pruebas estáticas (prohíbe cualquier verbo de escritura; una sola consulta a la base, sólo `SELECT`/`SHOW`); 6 mutaciones, todas detectadas | **Ejecutada una vez, el 2026-10-15**: no modificó nada | — |
| **Idempotencia de caja y stock + transiciones concurrentes** (Y3, migración 0133) | 38 pruebas de idempotencia + 8 de transiciones + las ampliadas de cheques, órdenes de pago, recepciones e imputaciones; **38 mutaciones (28 de código y 10 de base), todas detectadas**; migración aplicada **sólo a `aai_test`** | Verificado que la 0133 **no** está aplicada | **No desplegada.** Diseño y plan: `docs/DISENO_IDEMPOTENCIA.md` |
| **Consola: 16 pantallas de detalle** (Y2) | 15 verificadas abriéndolas en un navegador (con 11 defectos hallados y corregidos); 1 bloqueada (#3, ver B10); capturas en `var/visual/capturas/` | — | — |
| **Cobro manual por transferencia** (registro, conciliación, comprobante) | 30 pruebas unitarias + 10 de integración que ejecutan el script real; 9 mutaciones detectadas. `docs/COBRO_MANUAL_POR_TRANSFERENCIA.md` | Nunca ejecutado en el servidor (entra con la próxima imagen) | **No habilitado.** Sin Mercado Pago ni cobros automáticos |
| **`.claude/launch.json`** | Sólo existe `nexo-pruebas`; S-48 lo controla (5 pruebas) | — | — |
| Suite completa (árbol final, 2026-10-15) | **214 archivos / 3497 pruebas verdes**, en hora de Argentina y en UTC; `typecheck`, `lint`, `lint:arch`, `check:no-float` y `audit:estructura` (**456** objetos) en verde | — | — |

## 1 bis · Actualización del 2026-10-16 (lo que cambió desde las tablas de abajo)

> Las filas de abajo se escribieron el 2026-10-15; esta sección manda donde las contradiga.

- **B9 (push): HECHO.** `main` está publicado (último commit de esta actualización en `origin/main`).
- **B1 / V7:** agendada **hoy 21:17 ART** (sólo lectura; necesita la sesión abierta). Si pasa, B1 queda cerrado. Verificación previa del servidor (solo lectura, 2026-10-16 ~02:25): `bfbc3bb`, 132 migraciones, `nexo-app` healthy, tareas `success`, HTTPS 200.
- **B2 (segundo lanzamiento):** ahora incluye la **0136** (asistente). Ensayo **repetido el 2026-10-16** sobre la copia de las 02:32 (132 → 136, 462/462 candados, cadena íntegra): `docs/PLAN_DESPLIEGUE_PROXIMA_VERSION.md`. Propuesta: **sábado 2026-10-17 10:00 ART**, con tu OK ese día y si V7 pasó.
- **B7 (cobro):** Mercado Pago **iniciado**: aplicación creada, credencial de **prueba** comprobada, webhook de prueba y secreto cargados (`docs/MERCADO_PAGO_PASO_A_PASO.md`). Falta: política de cobranza (propuesta lista: `docs/POLITICA_DE_COBRANZA_PROPUESTA.md`), usuarios de prueba, prueba de punta a punta tras el despliegue, y para producción: activar la cuenta, credenciales reales y revisión legal. **Los datos bancarios del cobro manual siguen sin cargarse.**
- **M10 (exportación completa): HECHA y probada localmente** (migración 0137; `docs/EXPORTACION_COMPLETA.md`), para empresas nuevas y migradas. **No desplegada.**
- **Asistente de IA (Claude Haiku 5.5):** construido y en `main`, **apagado y sin proveedor**; en pausa por decisión del titular (no se carga saldo de API todavía). Retomarlo: `npm run asistente:probar` (`docs/ASISTENTE.md`). MCP diferido (`docs/MCP_FUTURO.md`).

## 2 · Bloqueos — sin esto no conviene abrir a un cliente real

### Los que dependen de vos (el servidor, las cuentas, las decisiones)

| # | Bloqueo | Qué hace falta | Estado |
|---|---|---|---|
| B1 | **Desplegar la corrección de zona horaria** (`bfbc3bb` = `13dd381` + login) y correr V1–V7 | **DESPLEGADO el 2026-10-15 (~20:34 UTC).** V1–V6 **pasaron en producción**; **V7 pendiente** (franja 21:00–24:00 ART). Registro, copia, reversión y hallazgos: `docs/DESPLIEGUE_2026-10-15_ZONA_HORARIA.md` | Desplegado; **falta V7** |
| B2 | **Segundo lanzamiento**: idempotencia (0133) + «olvidé mi contraseña» (0134) + recuperación a mano (0135) + pool + datos de cobro + correcciones visuales | Tu autorización específica y la ventana. **Ensayado sobre una copia de los datos reales de producción** (130 → 135, cadena íntegra, flujo de recuperación con la cuenta real dentro de la copia): `docs/PLAN_DESPLIEGUE_PROXIMA_VERSION.md`. Conviene **después de V7** | Listo para desplegar; **no desplegado** |
| B3 | **Copia del backup fuera del VPS** (verificado: base y copias comparten `/dev/sda1`; 17 `.dump`, 25 MB; sin archivos `.sha256`) | Elegir destino. Alternativas, costos y restauración en `docs/BACKUP_EXTERNO_Y_MONITOREO.md` §3. **No contrato nada** | Propuesta escrita; **sin decidir** |
| B4 | **Monitoreo con destino** (alerta cuando `/health` cae y cuando una tarea agendada no corre) | Elegir servicio y canal de aviso (`docs/BACKUP_EXTERNO_Y_MONITOREO.md` §5) | Propuesta escrita; **sin decidir** |
| B5 | **Dominio** `nexointelligence.com.ar` resolviendo | — | **Verificado el 2026-10-15 desde esta máquina:** resuelve a `2.24.94.71`, `/health` responde 200 por HTTPS, certificado de Let's Encrypt hasta el 2026-12-15 |
| B6 | **Resend**: cuenta, dominio verificado, `EMAIL_API_KEY` y corregir la línea `EMAIL_FROM` sin comillas del `.env` del servidor | La cuenta y el `.env` | Verificado en el servidor: `EMAIL_PROVIDER=resend`, `EMAIL_API_KEY` **presente** (no se leyó el valor). **No verificado:** que el dominio de envío esté verificado en Resend y que lleguen correos. La línea 10 del `.env` tiene espacios sin comillas (pendiente de corregir) |
| B7 | **Cobro:** cobro manual por transferencia **preparado**; Mercado Pago **no habilitado** a pedido tuyo | Los datos bancarios de NEXO (CBU/alias/titular) no están en ningún lado del sistema: hay que decidir dónde viven y cuáles son (`docs/COBRO_MANUAL_POR_TRANSFERENCIA.md` §5) | Flujo probado **localmente**; sin datos bancarios; no ejecutado en el servidor |
| B8 | **Revisión legal** de los textos (responsabilidad sobre determinaciones fiscales, uso de IA, IP en la bitácora, conservación documental, datos personales —incluye la copia externa cifrada de §B3—) y decisión de cancelaciones y reembolsos | Un abogado | Sin avanzar |
| B9 | **Ordenar el commit** del árbol de trabajo | Autorizado el 2026-10-15 **sin *push* ni despliegue** | Hecho (local). El *push* se autorizó el 2026-10-15 pero **no se ejecutó**: el control de permisos de la sesión lo denegó (publicación fuera de lo previsto). `origin/main` sigue en `8d867d3`. Hay que ejecutarlo vos (`git push origin main`) o habilitar el permiso en la configuración de la herramienta |

### Los que dependen de una decisión de producto o de una norma

| # | Bloqueo | Detalle | Estado |
|---|---|---|---|
| B10 | **Estados contables para una SRL** | El catálogo trae plantillas sólo para **SA** (Ley 19.550, IGJ, RT FACPCE). Una SRL recibe «FUENTE NO ENCONTRADA». Análisis, inventario real de plantillas (2 globales, ambas SA/IGJ/RT_FACPCE; sin EEPN ni EFE), qué falta y criterios de aceptación: `docs/ESTADOS_CONTABLES_SRL.md`. **La capacidad no se declara disponible hasta verificarla** | Bloquea si el primer cliente es una SRL. Necesito saber qué tipo de ente es |
| B11 | **¿NEXO emite comprobantes?** Hoy la emisión está cerrada a propósito; sólo se constata | Decisión de producto. Si se decide emitir: certificado de producción, delegación de servicios, reconciliación `FECompConsultar` | No bloquea si el primer cliente sólo constata. El comprobante del cobro manual **no es fiscal** y lo dice |

### Hallazgos nuevos de la auditoría del VPS (2026-10-15)

| # | Hallazgo | Consecuencia | Qué hacer |
|---|---|---|---|
| H1 | **No existe ninguna imagen anterior etiquetada** en el servidor (sólo `nexo:production`) | Hoy no habría a qué volver sin reconstruir | El `desplegar.sh` nuevo etiqueta la imagen vigente como `nexo:previo-<fecha>` **antes** de construir; ver la reversión en la auditoría previa |
| H2 | Las copias automáticas **no tienen `.sha256`** y están en el mismo disco | No se puede probar que una copia esté íntegra; un fallo de disco se lleva todo | El `respaldar.sh` nuevo escribe la suma y restaura en una base descartable; la copia externa es B3 |
| H3 | El servidor está en `e1b9007`, `origin/main` local en `8d867d3` | Hay 131 migraciones en disco y 130 aplicadas: el despliegue aplica la 0131 (ya en disco) y trae la 0132 | Esperado; el despliegue lo hace con `--commit` explícito |
| H4 | Hay dos bases de restauración (`aai_restauracion_predeploy_20261009`, `aai_restauracion_tz`) y un `.bak` del Compose | No son producción; **no se tocaron** | Decidir cuándo borrarlas (tuyo) |
| H5 | Una sola empresa y 17 filas de bitácora | El riesgo del despliegue es bajo en volumen; el costo de equivocarse sigue siendo el de un cliente real | — |

### Los que son míos (no están hechos)

| # | Qué | Estado |
|---|---|---|
| M1 | **Borradores** de términos y condiciones, política de privacidad, acuerdo de encargado, recuperación de cuenta e incidente de seguridad. Sin publicar | **Escritos (2026-10-15)** en `docs/legal/`, **sin revisión legal** y con los datos que no se conocen marcados `[ENTRE CORCHETES]`. Los procedimientos son operativos; los textos legales esperan al abogado (B8) |
| M2 | **Dirección de contacto** visible en la consola y en la página pública | Necesito que elijas la dirección |
| M3 | `pool.on('error')` (una conexión ociosa cortada tira el proceso; `restart: unless-stopped` lo levanta) | **Hecho y probado localmente** (commit `1431107`); **no desplegado** |
| M4 | Verificación visual **completa**: otros anchos, tema claro, otros navegadores | Pendiente; hoy sólo 800×560, tema oscuro |
| M5 | Corregir las observaciones O-1…O-7 de la verificación visual | **O-3, O-4 y O-7 hechas y probadas** (no desplegadas). Quedan **O-1, O-2, O-5, O-6** (necesitan cambios de API) |
| M7 | **«Olvidé mi contraseña»**: NEXO no lo tenía y los scripts de reseteo servían sólo para una cuenta de demostración | **Hecho y probado localmente** (migración 0134, rutas `/auth/recuperar` y `/auth/restablecer`, consola). **No desplegado.** Depende de que el correo salga (B6) |
| M8 | **Recuperar a mano** el segundo factor perdido o el correo perdido | **Hecho y probado localmente** (migración 0135, `scripts/recuperar-cuenta.sh`); procedimiento en `docs/legal/PROCEDIMIENTO_RECUPERACION_DE_CUENTA.md`. **No desplegado** |
| M9 | El ingreso **no dejaba escribir un código de recuperación** del segundo factor (el campo cortaba en 6 caracteres) | **Corregido y probado** localmente; no desplegado |
| M10 | **No existe una exportación completa de la empresa** (sólo informes CSV); los borradores legales no la prometen | **Decisión tuya:** construirla antes del primer cliente o declarar entrega a pedido |
| M6 | Unidades `systemd` de la copia externa y de los avisos | Esperan tu decisión en B3/B4 |

## 3 · Decisiones que necesito de vos

1. **¿Qué tipo de ente es el primer cliente?** (decide B10).
2. **¿Autorizás desplegar B1?** Con la auditoría previa, el backup, el commit objetivo y la reversión ya presentados. Hasta ese «sí» específico no se ejecuta nada en producción.
3. **¿Autorizás el *push*** de los commits locales? Sin él el servidor no puede traer los guiones nuevos.
4. **Datos bancarios** para el cobro manual (B7) y cuándo se arranca con ese flujo.
5. **Destino del backup externo, canal de alertas y política de retención** (B3, B4, B8).

## 4 · El árbol de trabajo

Se ordenó en **commits locales por alcance** (sin *push* y sin despliegue): scripts y runbook; correcciones visuales de la consola; idempotencia con la migración 0133. Los hashes están en la auditoría previa (`docs/AUDITORIA_PREVIA_VPS_2026-10-15.md`).

La migración 0133 **no puede ir a producción antes que la imagen** (el código nuevo necesita las columnas) ni sin un ensayo previo sobre una restauración; el orden y la reversión están en `docs/DISENO_IDEMPOTENCIA.md` §11. **No se despliega junto con la zona horaria.**

## 5 · Lo que no cambió

El resto de §4–§8 de `docs/FALTANTES_NEXO_2026-10-14.md` sigue vigente: certificado ARCA de producción, gestor de secretos (sólo para ARCA multiempresa), proveedor de IA real, facturación parcial, hosting definitivo, y la deuda técnica menor declarada como roadmap.
