# BORRADOR — Política de privacidad de NEXO

> **BORRADOR SIN REVISIÓN LEGAL. NO PUBLICAR.** Fecha: 2026-10-15. Marco de referencia a confirmar por el abogado: Ley 25.326 de Protección de los Datos Personales y su normativa complementaria (**[CONFIRMAR NORMATIVA VIGENTE Y SU REEMPLAZO, SI LO HUBIERA]**). Lo entre `[CORCHETES]` no se conoce y no se inventó. «*Verifica:*» dice dónde se comprueba cada hecho sobre el producto.

## 1. Quién es responsable y quién es encargado

- **Datos de las cuentas de NEXO** (quién usa el Servicio: nombre, correo, credenciales, uso): el **Prestador** (**[RAZÓN SOCIAL, CUIT, DOMICILIO]**) es **responsable** del tratamiento.
- **Datos contables y de terceros que el Cliente carga** (clientes, proveedores, comprobantes, asientos): el **Cliente es el responsable** y el Prestador es su **encargado del tratamiento**, que los trata sólo para prestar el Servicio y según sus instrucciones (ver `BORRADOR_ACUERDO_DE_ENCARGADO_DEL_TRATAMIENTO.md`). Un estudio contable que usa NEXO es responsable de los datos de **sus** clientes.
- Contacto para ejercer derechos y consultas de privacidad: **contacto@nexointelligence.com.ar** *(configurado y con entrega probada el 2026-10-16; reenvía al titular)*.

## 2. Qué datos se tratan, para qué, y por cuánto tiempo

| Dato | Para qué | Base | Cuánto se conserva |
|---|---|---|---|
| Nombre, correo, contraseña (guardada **sólo como hash Argon2id**, nunca en claro) y estado de la cuenta | Crear la cuenta, autenticar | Ejecución del contrato | Mientras la cuenta exista **[+ PLAZO POSTERIOR A LA BAJA]** |
| Segundo factor: secreto TOTP **cifrado** y códigos de recuperación **hasheados** | Seguridad de la cuenta | Ejecución del contrato / seguridad | Mientras el segundo factor esté activo |
| Sesiones: identificador **hasheado**, momento de creación y vencimiento (30 min de inactividad, 12 h absolutas por defecto) | Mantener la sesión | Ejecución del contrato | Hasta el vencimiento; el historial de sesiones se conserva **[PLAZO]** |
| **Dirección IP** | — | — | **No se guarda en la bitácora** por defecto (`AUDIT_RECORD_IP` no está definida en producción). Si se activara, requiere evaluación legal previa. *Verifica:* `config.ts`, `http/context.ts`. El servidor de aplicación y el proxy pueden registrar la IP en sus **logs técnicos** transitorios **[CONFIRMAR retención de los logs de Traefik y de Docker]** |
| Datos de la empresa del Cliente (razón social, CUIT, tipo de ente, plan de cuentas) | Prestar el Servicio | Ejecución del contrato | Mientras la cuenta exista **[+ PLAZO POSTERIOR A LA BAJA]** |
| Datos contables y de terceros cargados por el Cliente | Prestar el Servicio (contabilidad, IVA, trazabilidad) | Instrucción del Cliente | Según el Cliente y la obligación de conservación documental **[PLAZO POR LEY — REVISIÓN LEGAL]** |
| Bitácora de auditoría (quién hizo qué y cuándo, encadenada) | Integridad y trazabilidad contable | Interés legítimo / obligación de conservación | Igual que los datos contables a los que se refiere. **No se puede alterar**: está encadenada y verificada |
| Mensajes de correo del Servicio (alta, recuperación, avisos) | Comunicación operativa | Ejecución del contrato | **[PLAZO DE LA BANDEJA DE SALIDA]** |
| Datos de pago | Cobrar el Servicio | Ejecución del contrato | **Datos de tarjeta: nunca se almacenan.** Hoy se cobra por **transferencia bancaria**; el Servicio guarda el registro del cobro (importe, fecha, referencia) y no datos bancarios del Cliente. *Verifica:* `0073_suscripciones.sql`, `docs/COBRO_MANUAL_POR_TRANSFERENCIA.md` |

El Servicio **no usa cookies de seguimiento ni de publicidad.** Usa **una cookie de sesión** (`aai_session`: `httpOnly`, `sameSite=strict`) necesaria para mantener el ingreso, y una preferencia local de tema visual; si el usuario lo elige, la consola recuerda **su correo** en el navegador de ese dispositivo (nunca la contraseña, que sólo guarda el gestor de contraseñas del propio navegador). *Verifica:* `routes/auth.ts`, `tests/security/consola-recordar-dispositivo.test.ts`.

## 3. Con quién se comparten los datos (terceros)

| Tercero | Qué recibe | Para qué | Ubicación |
|---|---|---|---|
| **Proveedor de infraestructura (VPS)** — **[NOMBRE DEL PROVEEDOR — CONFIRMAR]** | Todo lo que reside en el servidor (cifrado en tránsito; **hoy no hay cifrado del disco declarado**) | Alojar el Servicio | **[PAÍS / CENTRO DE DATOS — CONFIRMAR]** |
| **Resend** (envío de correo transaccional) | Dirección de destino, asunto y cuerpo del mensaje (incluye el código de verificación o de recuperación) | Enviar los correos del Servicio | **[CONFIRMAR: EE. UU. / región de Resend]** |
| **ARCA** (ex AFIP) | CUIT y datos fiscales necesarios para constatar comprobantes y consultar padrones | Funciones fiscales que el Cliente habilita | Argentina |
| **Pasarela de pago** | **Ninguna hoy** (no hay pasarela habilitada). Si se habilita Mercado Pago u otra, se actualiza esta política **antes** | Cobrar el Servicio | — |
| **Proveedor de IA para el asistente — Anthropic (Claude)** | **Ninguno hoy** (en producción no hay proveedor conectado). Cuando se conecte, **sólo recibe datos de las empresas que enciendan el asistente** (viene apagado; encenderlo exige un motivo y queda en la bitácora): los mensajes que la persona le escribe, los archivos (fotos, PDF) que adjunta en ese mensaje y los resultados de las consultas que el asistente hace al sistema para contestar (cifras, nombres y documentos de terceros de la empresa). **No recibe la base de datos completa.** Los archivos no se guardan en NEXO: se mandan en el momento y se descartan. El dictado por voz de la consola lo resuelve el servicio de voz del **navegador** de la persona, no NEXO | Contestar consultas, orientar y ayudar a cargar datos | **[CONFIRMAR: EE. UU. / región; política de retención y de no uso para entrenamiento del plan contratado]** |
| **Almacenamiento externo de copias** | **Hoy ninguno** (las copias están en el mismo servidor). Si se contrata, se actualiza esta política: serían copias **cifradas del lado del Prestador** con una clave que no tiene el proveedor | Resguardo | **[POR DEFINIR]** |

**Transferencias internacionales:** si algún tercero de la tabla procesa datos fuera de Argentina, hace falta el análisis de adecuación o las cláusulas correspondientes. **[REVISIÓN LEGAL OBLIGATORIA — ver B8]**.

## 4. Quién del Prestador puede ver los datos

- El diseño asume que **el operador del Servicio no debe poder leer la contabilidad de los clientes sin dejar rastro** (secreto profesional del contador): el aislamiento entre empresas es por diseño de base de datos (RLS forzado en todas las tablas con empresa), y las acciones de operación quedan en la bitácora de la empresa afectada.
- El acceso del personal a datos de un Cliente se limita a lo necesario para prestar soporte y se registra. **[DEFINIR el procedimiento y los roles reales — hoy una sola persona opera el servidor.]**

## 5. Seguridad

Medidas que el Servicio aplica (*Verifica:* `SECURITY.md`, `tests/security/`): contraseñas con Argon2id; segundo factor obligatorio por rol; sesiones con vencimiento y revocación; aislamiento entre empresas en la base; bitácora encadenada y verificable; límites de intentos de ingreso; redacción de secretos en los logs; copias de resguardo verificadas con restauración; ningún dato de tarjeta almacenado. **Lo que NO está aún:** copia fuera del servidor, monitoreo con aviso, cifrado de disco declarado. **No se promete lo que no existe.**

Ante un incidente que afecte datos personales, el Prestador seguirá su procedimiento y **[NOTIFICARÁ AL CLIENTE, AL RESPONSABLE Y A LA AUTORIDAD CUANDO CORRESPONDA, EN EL PLAZO QUE FIJE EL ABOGADO]** (`PROCEDIMIENTO_INCIDENTE_DE_SEGURIDAD.md`).

## 6. Derechos de las personas

Toda persona tiene derecho de **acceso, rectificación, actualización y supresión** de sus datos, y a ser informada de ellos. Para los datos de **cuenta**, se ejercen ante el Prestador en **[CORREO DE CONTACTO]**, con respuesta en **[PLAZO LEGAL — CONFIRMAR]**. Para los datos que un Cliente carga sobre **terceros**, se ejercen ante el **Cliente** (responsable), y el Prestador lo asiste (acuerdo de encargo).

**Una limitación que debe decirse:** los asientos contables **no se borran** (se anulan, y queda el rastro) porque la ley exige conservar la documentación y porque la integridad del libro depende de ello. La supresión de datos personales dentro de la contabilidad se **limita por esa obligación de conservación**. **[REVISIÓN LEGAL: cómo se concilia el derecho de supresión con la conservación obligatoria.]**

La autoridad de aplicación es la **Agencia de Acceso a la Información Pública**, ante la cual el titular puede presentar denuncias y reclamos. **[CONFIRMAR DATOS DE CONTACTO Y LA REDACCIÓN OBLIGATORIA DEL AVISO]**.

## 6 bis. Menores

El Servicio está dirigido a empresas y profesionales mayores de edad. No se recaban datos de menores de forma intencional.

## 7. Cambios a esta política

**[FORMA Y PREAVISO — por definir]**. Los cambios que amplíen la comunicación de datos a terceros se avisan **antes** de aplicarse.

---

## Lo que falta decidir o confirmar

1. Razón social, CUIT, domicilio y correo del responsable.
2. **Proveedor y ubicación del servidor**, y retención de los logs técnicos (Traefik, Docker).
3. Ubicación de **Resend** y régimen de transferencias internacionales.
4. Plazos de conservación posteriores a la baja y por la ley contable/fiscal (con abogado).
5. Cómo se concilia **supresión vs. conservación** (§6).
6. Procedimiento real de acceso del personal a datos de clientes (§4).
7. Plazo de respuesta a derechos y texto obligatorio del aviso ante la autoridad.
8. Si se activará el registro de IP (hoy **no**; requiere evaluación legal).
