# Reconocimiento de faltantes de NEXO — 2026-10-14

> **Actualización 2026-10-15.** La lista vigente de bloqueos para el primer cliente es `docs/BLOQUEOS_PRIMER_CLIENTE.md`; este documento queda como inventario histórico. Desde que se escribió: el despliegue endurecido (§2), la idempotencia (§4.1) y la verificación visual de las 16 pantallas (§3) se **construyeron y probaron localmente** —ver `docs/DISENO_IDEMPOTENCIA.md` y `docs/VERIFICACION_VISUAL_16_PANTALLAS.md`—; **nada de eso está en producción ni se verificó en el VPS**. Apareció un faltante nuevo: los estados contables no se pueden armar para una SRL (sólo hay plantilla para SA).

Inventario para cerrar el proyecto esta semana (excluye la presentación de la UCA). Se armó leyendo
`FINAL_NEXO_STATUS.md`, `CIERRE_INTEGRAL_NEXO.md`, `ROADMAP_PRIORIZADO.md`, `NEXO_ROADMAP.md`,
`NEXO_RELEASE_READINESS.md`, `NEXO_LEGAL_Y_SOPORTE.md`, `NEXO_MERCADO_PAGO_STATUS.md`,
`NEXO_B2_5_4_*`, `DESPLIEGUE.md`, `BACKLOG_INTERFAZ_PENDIENTE.md` y el estado de git, y contrastándolos con
el código. **Son documentos de fechas distintas**: lo que figura abajo como pendiente puede haber avanzado en
el servidor sin que esté escrito (se marca `NO VERIFICADO`). Esta sesión no tiene acceso al VPS desde el 2026-10-09.

Quién: **[YO]** lo hace Claude · **[VOS]** solo vos (servidor, cuentas, decisiones, personas) · **[AMBOS]**.
Peso: **LANZAR** = sin esto no conviene abrir a un cliente real · **DESPUÉS** = se puede lanzar sin esto, pero hay que
decirlo · **OPCIONAL**.

## 0 · Estado de partida (verificado hoy)

| Hecho | Estado |
|---|---|
| Código: `main` = `origin/main` = `8d867d3`, 202 archivos / 3272 pruebas verdes en UTC y Argentina, `npm run verify` en verde | Verificado el 2026-10-08 |
| 5 archivos de documentación sin commit (auditoría, plan, cierre, estado final, runbook) | Verificado hoy |
| Producción: corría `b412b9e` el 2026-10-09. Si `8d867d3` se desplegó desde entonces | **NO VERIFICADO** |
| Resend, Mercado Pago, backup externo, estado del dominio | **NO VERIFICADO** (hay una línea `EMAIL_FROM` en el `.env` del servidor, así que el correo puede estar parcialmente configurado) |

## 1 · Cerrar la zona horaria (lo único construido que no está en producción)

| # | Faltante | Quién | Peso | Cierra con |
|---|---|---|---|---|
| 1.1 | Desplegar `8d867d3`: A1–A4, `desplegar.sh`, V1–V6 (runbook `docs/RUNBOOK_DESPLIEGUE_ZONA.md`) | VOS | LANZAR | Salidas del runbook sin `✘` |
| 1.2 | V7 entre las 21:00 y las 24:00 ART | VOS | LANZAR | `CODIGO=0` y `hoyEnUtc` = día siguiente |
| 1.3 | Documentar V1–V7 con las salidas reales | YO | LANZAR | `AUDITORIA_ZONA_HORARIA.md` actualizado |
| 1.4 | Commit de los 5 documentos pendientes | VOS ordena, YO hago | DESPUÉS | Árbol limpio |

## 2 · Endurecer el despliegue (código, fuera de alcance hasta ahora)

El runbook compensa a mano cuatro defectos de `scripts/desplegar.sh`. Corregirlos en el script evita depender de la
disciplina del operador.

| # | Faltante | Quién | Peso | Notas |
|---|---|---|---|---|
| 2.1 | `desplegar.sh` no hace backup antes de desplegar | YO (necesita tu OK) | DESPUÉS | `DESPLIEGUE.md` §3 ya lo exige como paso 1 |
| 2.2 | No se detiene si falla la migración (línea 275) y sigue a `up -d` | YO | DESPUÉS | La API se niega a arrancar, pero producción queda abajo |
| 2.3 | `docker build -t nexo:production` pisa la etiqueta sin guardar la anterior | YO | DESPUÉS | Etiquetar `nexo:previo-<id>` antes de construir |
| 2.4 | No comprueba que `HEAD` sea el commit esperado después del `git pull` | YO | DESPUÉS | Una línea |
| 2.5 | La migración del script monta `/opt/nexo:/repo` e importa `pg` desde allí; nunca se probó en este trabajo | YO | DESPUÉS | Usar el comando probado de A.4 |
| 2.6 | `. .env` falla con `EMAIL_FROM=NEXO <no-reply@…>` sin comillas (`respaldar.sh:79`, `desplegar.sh:218`); lo que va después de esa línea no se carga | YO | DESPUÉS | Leer solo las 3 variables necesarias, **sin** tocar el `.env` (los timers usan `--env-file`, que no procesa comillas) |
| 2.7 | El pool no tiene `pool.on('error')`: una conexión ociosa cortada tira el proceso | YO | DESPUÉS | Tarea ya registrada como chip; `restart: unless-stopped` lo levanta |

## 3 · Verificación visual de la interfaz

| # | Faltante | Quién | Peso | Notas |
|---|---|---|---|---|
| 3.1 | Confirmación visual de las 16 pantallas cerradas el 2026-10-01 (nunca se vieron en un navegador) | YO | LANZAR | Necesito tu OK para levantar la API contra `aai_test` y crear ahí un usuario de prueba. Hoy hay navegador integrado |
| 3.2 | Ítem 19 del backlog (`products/:id/movimientos`, posible enlace duplicado) e ítems 9 y 10 | YO | DESPUÉS | Se resuelve con 3.1 |
| 3.3 | Los 6 videos del curso (14, 15, 16, 18, 31, 06): audio y guion listos, falta la captura | YO | OPCIONAL | Se hace con 3.1 |

## 4 · Integridad financiera (la única deuda con riesgo de datos)

| # | Faltante | Quién | Peso | Notas |
|---|---|---|---|---|
| 4.1 | **Clave de idempotencia de punta a punta en caja y stock.** Un reintento de red (no un doble clic) puede duplicar un movimiento real | DECIDÍS VOS, IMPLEMENTO YO | LANZAR si el primer cliente va a operar caja o stock | Es una decisión de arquitectura. Implementarla es 1–2 días con pruebas; aceptarla es posible pero hay que decírselo al cliente |
| 4.2 | **Copia del backup fuera del VPS.** Hoy base y copias comparten disco | VOS elige destino, YO escribo el procedimiento | LANZAR | Un desastre de disco se lleva las dos |
| 4.3 | Prueba de restauración de la copia más reciente (no solo `pg_restore --list`) | AMBOS | DESPUÉS | La del 2026-10-09 ya se restauró y se comparó |
| 4.4 | Monitoreo con destino (alerta cuando `/health` cae). Hoy no hay | VOS elige servicio, YO configuro lo que sea código | DESPUÉS | Sin esto no se puede prometer disponibilidad |

## 5 · Lo que bloquea cobrar y dar de alta clientes (todo externo)

| # | Faltante | Quién | Peso | Notas |
|---|---|---|---|---|
| 5.1 | Dominio `nexointelligence.com.ar` resolviendo (trámite NIC) | VOS | LANZAR | Condiciona TLS real, webhook de pagos y correo |
| 5.2 | **Resend**: cuenta, dominio verificado, `EMAIL_API_KEY`. Sin esto no hay alta autoservicio ni recuperación de contraseña | VOS | LANZAR | El código está hecho; `docs/CORREO_RESEND.md` |
| 5.3 | **Mercado Pago**: cuenta, aplicación, token de prueba, secreto de firma del webhook, URL del webhook | VOS | LANZAR (o decidir cobro manual) | No falta una línea de código. Con los valores, YO corro `ensayo-de-pagos` en `sandbox` |
| 5.4 | **Decisión**: cobro manual al arrancar o esperar la pasarela | VOS | LANZAR | Condiciona el arranque del primer cliente |
| 5.5 | Decisión de cancelaciones y reembolsos | VOS, después un abogado | LANZAR | `NEXO_LEGAL_Y_SOPORTE.md` |

## 6 · Lo legal y de soporte mínimo antes del primer cliente

`NEXO_LEGAL_Y_SOPORTE.md` §1 lista cuatro cosas mínimas. Hoy `landing.html` y `consola.html` **no contienen**
"Términos", "Privacidad" ni una dirección de correo.

| # | Faltante | Quién | Peso |
|---|---|---|---|
| 6.1 | Dirección de contacto visible en la aplicación y la página pública | VOS elige la dirección, YO la agrego | LANZAR |
| 6.2 | Términos y condiciones y política de privacidad: borrador | YO redacto | LANZAR |
| 6.3 | Revisión legal de esos textos (responsabilidad sobre determinaciones fiscales, uso de IA, IP en la bitácora, conservación documental, datos personales) | VOS con abogado | LANZAR |
| 6.4 | Procedimientos escritos de recuperación de cuenta y de incidente (hoy recuperar una contraseña es manual) | YO redacto sobre `OPERACION.md` | LANZAR |
| 6.5 | Registro de consultas respondidas a clientes | AMBOS | DESPUÉS |

## 7 · Producto: decisiones abiertas (no se resuelven escribiendo código)

| # | Faltante | Quién | Peso | Notas |
|---|---|---|---|---|
| 7.1 | **¿NEXO emite comprobantes fiscales?** Hoy la emisión está cerrada a propósito (`EMISION_HABILITADA = false`, paquete fuera del grafo). Constatar sí | VOS | DESPUÉS | Si se decide emitir: certificado de producción, delegación de servicios y reconciliación `FECompConsultar` |
| 7.2 | Certificado ARCA de producción y delegar `wscdc` y padrones | VOS (trámite) | DESPUÉS | Hoy anda homologación |
| 7.3 | Gestor de secretos (KMS) y unificar las dos KEK | VOS elige, YO conecto (4 pasos) | DESPUÉS | Solo hace falta para ARCA de producción **multiempresa** |
| 7.4 | Proveedor de modelo de IA real (hoy todo es determinístico) | VOS (credencial) | OPCIONAL | Ítem 12 del backlog |
| 7.5 | Facturación parcial | VOS (decisión de producto) | OPCIONAL | Ítem 13 |
| 7.6 | Hosting y jurisdicción de los datos: ya hay VPS; falta decidir si es el definitivo | VOS | DESPUÉS | Datos contables de terceros |

## 8 · Deuda técnica menor (se puede declarar como roadmap)

Trazar un renglón de estado contable ya emitido y un match bancario confirmado en otra sesión (faltan endpoints) ·
reordenar etapas del CRM · 17 estados muertos en `CHECK` · `alerts` y `audit_findings` sin escritores · dos series `S-*`
que se pisan · documentos en disco local (no sirve con más de una réplica) · contadores en memoria por proceso (idem) ·
NEXO no lleva su propia contabilidad (sin CAC, LTV ni burn reales) · RRHH inexistente · la consola no es la interfaz
definitiva.

## 9 · Lo que NO falta

Seguridad multiempresa y RLS · núcleo contable y Mayor · bitácora encadenada y su verificación independiente · backup y restauración
(ensayada dos veces) · MFA · ARCA en homologación (WSAA y constatación) · corrección de fechas (código y ensayo, a falta de
desplegar) · 202 archivos / 3272 pruebas.

## 10 · Secuencia propuesta para la semana

| Día | Mío | Tuyo |
|---|---|---|
| Miércoles 14 | 1.3 y 3.1 (si das OK), 6.2 y 6.4 (borradores), 2.1–2.7 (si das OK) | 1.1 (A1–A4 + deploy), 5.4 (decisión de cobro), contestar §11 |
| Miércoles noche | — | 1.2 (V7) |
| Jueves 15 | 3.2 y 3.3, 4.1 si se decide, 5.3 (`ensayo-de-pagos`) con los valores | 5.2 y 5.3 (cuentas), 5.1 (NIC), 6.1 |
| Viernes 16 | 1.3, 1.4 y cierre del inventario; resumen de lo declarado como roadmap | 4.2 (destino del backup), 6.3 (abogado), 4.4 |

Lo que **no** va a estar terminado el viernes por razones ajenas al código: 5.1 y 5.3 si los trámites externos se demoran,
6.3 (revisión legal), 7.1–7.4 (decisiones y trámites).

## 11 · Cinco respuestas para empezar

1. ¿Se desplegó `8d867d3` desde el 9/10? Si sí, pasame las salidas de V1–V6; si no, hoy.
2. ¿Resend y Mercado Pago: en qué estado están hoy?
3. ¿Dominio NIC: resuelve?
4. ¿Aceptás el riesgo de idempotencia para el primer cliente, o la implemento? (4.1)
5. ¿Me das OK para: levantar la API contra `aai_test` (3.1) y corregir `desplegar.sh`/`respaldar.sh` (§2)?
