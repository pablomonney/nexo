# Lo que sólo puede hacer el titular — lista única y ordenada

**Actualizada el 2026-10-16.** Todo lo demás lo hace el equipo técnico (Claude) con las órdenes ya dadas. Cada ítem dice **qué**, **por qué sólo vos** y **qué pasa cuando esté hecho**.

## A · Hoy / mañana (lo que destraba lo inmediato)

| # | Qué | Por qué sólo vos | Cuando esté hecho |
|---|---|---|---|
| ~~A1~~ | ~~Pasar el CBU~~ **RECIBIDO (2026-10-16)**: constancia de **CVU de Mercado Pago** (titular, CUIT, CVU de 22 dígitos y alias). Validado con el validador del sistema (dígitos verificadores OK) y cargado en el `.env` **local**. Se carga en el `.env` del servidor con el segundo lanzamiento (con tu «dale»). Los avisos dicen «CBU/CVU» y el banco «Mercado Pago (CVU)». | — | Hecho. *(Ojo: el titular y su CUIT van a verse en los avisos a los clientes.)* |
| A2 | **Estar disponible el sábado 17 a las 10:00 ART** (o decir otro día) para el segundo lanzamiento y mirar la consola un rato. Decir **«dale»** ese día. | Es producción: el plan exige tu autorización específica y alguien mirando. Sólo si V7 (hoy 21:17) pasó. | Corren las migraciones 0133–0137: idempotencia, «olvidé mi contraseña», recuperación de cuenta, asistente (apagado), exportación completa. |
| A3 | **Mantener abierta esta sesión de Claude** hoy (o decirme «corré V7» a la noche, entre las 21:00 y las 24:00 ART). | V7 sólo prueba algo cuando la fecha UTC ya es un día posterior a la argentina. | Queda confirmada la corrección de zona horaria en producción. |

## B · Mercado Pago (cobrar las suscripciones)

| # | Qué | Por qué sólo vos | Cuando esté hecho |
|---|---|---|---|
| B1 | **Credenciales de PRODUCCIÓN:** entrar a la aplicación «Nexo intelligence» → **Credenciales de producción**. Mercado Pago pide un **código por SMS** (celular terminado en 4728): lo escribís vos. Si ve «Activar credenciales», completar rubro y sitio (`https://nexointelligence.com.ar`) y aceptar. Avisarme **si quedaron activadas** (no me pases las claves). | El código llega a tu teléfono; las claves de producción mueven plata. | Sé en qué estado está la cuenta y qué falta para cobrar. |
| B2 | **Activar la cuenta para cobrar** si Mercado Pago lo pide (identidad, datos fiscales, cuenta bancaria de retiro). | Es tu identidad ante Mercado Pago. | Sin esto no se puede cobrar con credenciales reales. |
| B3 | **Autorizar la tarjeta del comprador de prueba** en la pantalla de Mercado Pago (cuando lleguemos a la prueba de punta a punta). | Es un paso del navegador con un usuario de prueba. | Se prueba el webhook real en el servidor. |
| B4 | **Revisión legal** (política de privacidad y términos dicen hoy «pasarela: ninguna»; hay que actualizarlos **antes** de encender). | Un abogado. | Se puede encender el cobro automático. |

## C · Correo

| # | Qué | Por qué sólo vos | Cuando esté hecho |
|---|---|---|---|
| C1 | **Correo de contacto que reciba mensajes.** Hoy `nexointelligence.com.ar` está en Cloudflare pero **no tiene registros MX en la raíz**: un mensaje a `contacto@…` **rebota**. Opción simple: Cloudflare → el dominio → **Email → Email Routing** → activar → crear `contacto@nexointelligence.com.ar` que reenvíe a tu correo (te pide confirmar el destino). Cloudflare agrega los registros solo. | Es tu cuenta de Cloudflare. *(Si querés, puedo hacerlo desde tu Chrome con tu sesión abierta, con tu OK explícito para cambiar esa configuración.)* | Se puede poner esa dirección en la consola y en la página pública. |
| C2 | **Confirmar en Resend que el dominio figura «Verified»** (en DNS ya están DKIM, SPF y DMARC). | Es tu cuenta de Resend. | Salen los correos de mora y de «olvidé mi contraseña». |

## D · Facturación electrónica (NEXO emite) — ver `docs/EMISION_DE_FACTURAS_PLAN.md`

| # | Qué | Por qué sólo vos | Cuando esté hecho |
|---|---|---|---|
| D1 | **Preguntarle a tu contador: ¿quién emite y con qué condición de IVA?** (monotributo → Factura C; responsable inscripto → A/B). | Define el tipo de comprobante. | Se puede escribir E3. |
| D2 | **Decidir:** facturas con el **certificado de cada empresa** (más seguro, más trámite) o con el de NEXO delegado. | Decisión de producto y de responsabilidad. | Se diseña el alta de cada cliente (E10). |
| D3 | **Punto de venta de homologación** como «RECE para aplicaciones y web services» para el CUIT 20452148324 (sólo si ARCA rechaza la prueba de hoy). | Es tu clave fiscal en ARCA. | Se emite la primera factura de prueba. |
| D4 | **Producción:** certificado, delegación de `wsfe` y punto de venta para web services **en producción**. | Tu clave fiscal; yo no puedo ni debo usarla. | Se puede habilitar la emisión real (con tu orden). |
| D5 | **Un contador valida** el tratamiento contable de una factura emitida (E5). | Criterio profesional. | Se implementa el asiento. |

## E · Decisiones de negocio pendientes

| # | Qué | Nota |
|---|---|---|
| E1 | **Tipo de ente del primer cliente.** Si es una **SRL**, falta construir las plantillas de estados contables (hoy sólo SA). Si es un cliente de prueba nuestro, usamos una SA. | Decidido: «sin definir». No bloquea mientras sea SA. |
| E2 | **Destino y retención de los backups externos** y **canal de alertas** (B3/B4 de `docs/BLOQUEOS_PRIMER_CLIENTE.md`; propuestas en `docs/BACKUP_EXTERNO_Y_MONITOREO.md`). | Sin esto, las copias están en el mismo disco que la base. |
| E3 | **Saldo de la API de Anthropic** (USD 5 mínimo), cuando quieras activar el asistente de IA. | Pausado por tu decisión. Retomar: `npm run asistente:probar`. |

## F · Lo que ya está decidido (no hace falta volver a pedirlo)

Suspensión a **14 días** (se declara tras el segundo lanzamiento) · webhook de Mercado Pago probado **en el servidor real** · **NEXO emite facturas** (plan E1–E10) · **exportación completa** de cualquier empresa (hecha).
