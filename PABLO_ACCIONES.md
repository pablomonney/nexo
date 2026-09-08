# PABLO — ACCIONES PENDIENTES

Lo que **no puedo hacer yo**, ordenado por lo que destraba. Todo lo demás está
hecho o está en mi lista.

**Ninguna acción externa queda implícita.** Si algo no está acá, es porque lo
resuelvo yo dentro del repositorio.

---

## P0 — bloquean V1

### 1 · Aprobar la identidad visual

| | |
|---|---|
| **Acción** | Mirar la propuesta de logo, paleta y tipografía que voy a preparar, y aprobarla o pedir cambios |
| **Motivo** | Todo el sistema de diseño se construye encima. Si se aprueba después de aplicarla, se rehace |
| **Bloquea V1** | Sí |
| **Costo** | $0 si la hago yo. Un diseñador de marca: **PRECIO A CONFIRMAR** |
| **Qué tenés que decidir** | Si querés que la proponga yo o contratás a alguien. Y si tenés alguna preferencia de tono: sobrio/institucional, moderno/tecnológico, cálido/cercano |
| **Desbloquea** | El design system y el rediseño entero |

### 2 · Decidir el alcance de V1

| | |
|---|---|
| **Acción** | Elegir una de las tres opciones de `NEXO_V1_CIERRE.md` §4 |
| **Motivo** | Define si V1 son semanas o meses. No la puedo tomar yo |
| **Bloquea V1** | Sí — es lo primero |
| **Costo** | $0 |
| **Qué tenés que decidir** | (a) las 35 pantallas a calidad de producto, (b) el núcleo de 15 a calidad de producto y el resto consistente, o (c) vender solo Contable y Gestión en V1 |
| **Desbloquea** | Que yo pueda empezar y que el trabajo tenga final |

### 3 · Contratar proveedor de correo

| | |
|---|---|
| **Acción** | Contratar, verificar el dominio (SPF/DKIM), darme la credencial |
| **Motivo** | Sin esto el alta **no se completa sola** y no hay recuperación de contraseña. Es lo que tu §32 llama «sin intervención manual» |
| **Bloquea V1** | Sí |
| **Proveedor** | Resend, Postmark, Amazon SES o Brevo. **Sugerencia: Resend o Postmark** por simpleza |
| **Costo** | Rango habitual USD 0–20/mes en volumen bajo. **PRECIO A CONFIRMAR** |
| **Qué tenés que decidir** | Cuál, y desde qué dominio salen los mensajes |
| **Desbloquea** | Alta autoservicio completa, recuperación de contraseña, aviso de vencimiento de prueba, aviso de cobranza |

### 4 · Contratar pasarela de pago

| | |
|---|---|
| **Acción** | Crear la cuenta, completar el alta comercial, darme credenciales y la URL de webhook |
| **Motivo** | Hoy solo entra lo que se registra a mano |
| **Bloquea V1** | Sí |
| **Proveedor** | Mercado Pago o Stripe. **Para Argentina y cobro recurrente en pesos, Mercado Pago** |
| **Costo** | Comisión por transacción, **PRECIO A CONFIRMAR** (orden de 3–6 %). Es el costo variable más grande del modelo |
| **Qué tenés que decidir** | Cuál, y si vas a cobrar también por transferencia |
| **Desbloquea** | El ciclo comercial sin intervención manual, y el costo variable real del modelo |

### 5 · Contratar hosting, dominio y SSL

| | |
|---|---|
| **Acción** | Comprar el dominio, elegir proveedor, decidir **jurisdicción** |
| **Motivo** | Son datos contables de terceros: dónde viven no es un detalle técnico, es del documento de privacidad |
| **Bloquea V1** | Sí |
| **Proveedor** | Railway, Render, Fly.io o un VPS. **PostgreSQL 18 administrado** |
| **Costo** | Orden de USD 20–100/mes al principio. **PRECIO A CONFIRMAR** |
| **Qué tenés que decidir** | Jurisdicción (Argentina, Brasil, EE.UU., UE) y proveedor |
| **Desbloquea** | Que exista producción. Y los backups, el monitoreo y el SSL, que dependen de esto |

### 6 · Elegir gestor de secretos

| | |
|---|---|
| **Acción** | Elegir uno y crear la cuenta |
| **Motivo** | Un secreto **por empresa** no se puede resolver hoy. Sin esto no hay ARCA de producción multiempresa |
| **Bloquea V1** | Sí, si V1 promete manejar certificados de varias empresas |
| **Proveedor** | AWS Secrets Manager, Google Secret Manager, Infisical o Doppler |
| **Costo** | Orden de USD 0–40/mes. **PRECIO A CONFIRMAR** |
| **Qué tenés que decidir** | Cuál. Conviene que sea del mismo proveedor que el hosting |
| **Desbloquea** | Certificados de ARCA por empresa; y unificar la incoherencia de KEK entre ARCA y MFA |

### 7 · Abogado

| | |
|---|---|
| **Acción** | Contratar redacción y revisión de términos, privacidad, tratamiento de datos, cancelaciones y uso de IA |
| **Motivo** | Un SaaS que maneja contabilidad de terceros sin términos es un riesgo que no se cubre con buena fe |
| **Bloquea V1** | Sí |
| **Costo** | **PRECIO A CONFIRMAR** |
| **Qué tenés que darle** | `NEXO_LEGAL_Y_SOPORTE.md` — está escrito para eso: cada afirmación sobre el producto dice dónde se verifica |
| **Desbloquea** | Poder cobrarle a alguien legalmente |

### 8 · Casilla de contacto

| | |
|---|---|
| **Acción** | Crear una dirección de soporte y decirme cuál |
| **Motivo** | Hoy un cliente con un problema **no tiene a dónde escribir**. Es lo más barato de la lista y lo más grave si falta |
| **Bloquea V1** | Sí |
| **Costo** | $0 |
| **Desbloquea** | Que un cliente no quede solo |

### 9 · Backups agendados y una restauración probada

| | |
|---|---|
| **Acción** | Agendar el backup en el hosting y **restaurar una vez** para comprobar que sirve |
| **Motivo** | Un backup no probado no cuenta como backup |
| **Bloquea V1** | Sí |
| **Costo** | Suele venir con el hosting |
| **Desbloquea** | Poder decir que los datos del cliente están a salvo sin estar mintiendo |

---

## P1 — importantes, no bloquean V1

### 10 · Condición de IVA de NEXO

| | |
|---|---|
| **Acción** | Decirme la condición fiscal de la empresa NEXO |
| **Motivo** | Sin eso los cargos no discriminan impuestos |
| **Bloquea V1** | No — se puede cobrar sin discriminar |
| **Desbloquea** | Facturar correctamente |

### 11 · Confirmar la matriz de planes y los topes

| | |
|---|---|
| **Acción** | Revisar `NEXO_COMERCIAL.md` §2 y §3 y confirmar o corregir |
| **Motivo** | Están cargados como **hipótesis**, con `declarado_por = 'hipotesis-b1'` |
| **Bloquea V1** | No, pero conviene antes del primer cliente |
| **Desbloquea** | Que lo que el cliente compra sea lo que decidiste |

### 12 · Datos de NEXO como empresa

| | |
|---|---|
| **Acción** | Darme los gastos reales: infraestructura, herramientas, servicios |
| **Motivo** | Sin la contabilidad propia no hay CAC, LTV, margen, burn ni runway |
| **Bloquea V1** | No |
| **Costo** | $0 — el ERP ya lo hace |
| **Desbloquea** | Todas las métricas del negocio, y la demostración de «NEXO administra NEXO» |

### 13 · Destino de logs y alertas

| | |
|---|---|
| **Acción** | Elegir dónde van los logs y quién recibe una alerta |
| **Proveedor** | Sentry, Better Stack, Axiom |
| **Costo** | Suele haber capa gratuita. **PRECIO A CONFIRMAR** |
| **Bloquea V1** | No, pero operar a ciegas es caro |

---

## P2 — después de V1

| | |
|---|---|
| Proveedor de modelo de IA | Nada de lo que NEXO promete hoy lo necesita |
| Certificado de ARCA de producción | Solo cuando NEXO prometa emitir |
| Función de preferencia para las recomendaciones | Cuando haya decisiones revisadas que la calibren |
| Periodicidad anual y su descuento | La estructura ya lo soporta |

---

## Resumen: lo mínimo para que yo pueda terminar

Si solo hacés cuatro cosas, que sean:

1. **Decidir el alcance de V1** (§2) — es lo primero y no cuesta nada
2. **Aprobar la identidad visual** (§1) — todo se construye encima
3. **Correo** (§3) — cierra el alta
4. **Hosting con jurisdicción** (§5) — sin eso no hay producción

Con esas cuatro, todo lo demás que bloquea V1 es trabajo mío.
