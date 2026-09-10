# Integración con ARCA — trámite y configuración

> **Nada de lo que sigue hace falta para desarrollar.** El sistema funciona
> completo con `ARCA_ENVIRONMENT=mock`. Este documento es para el día que se
> quiera constatar comprobantes de verdad.
>
> Los pasos marcados `V1` salen de documentación oficial archivada con hash en
> `docs/normative-sources/originals/`. Los marcados `V2` son la operatoria de los
> portales de ARCA, que no está en un documento archivado: verificar en pantalla
> al hacerlos, porque los portales cambian.

## 0. Antes de empezar: qué se pide y qué no

| | |
|---|---|
| ✅ Se necesita | Un **certificado digital X.509 emitido por la Autoridad Certificante de ARCA** y su clave privada |
| ❌ **No** se pide nunca | La **Clave Fiscal** del contribuyente |

La distinción importa. La Clave Fiscal da acceso a todo lo que el contribuyente
puede hacer ante el organismo y se revoca solo cambiándola. Un certificado se
emite para un uso concreto, se puede revocar de forma independiente y se delega
servicio por servicio. Por eso el sistema **no tiene** dónde guardar una Clave
Fiscal: no es una omisión, es el diseño (ADR-004, `SECURITY.md` §5).

Quien opera el portal para hacer el trámite sos vos. El sistema nunca se loguea
a un portal.

---

## 1. Generar el par de claves y el pedido de certificado

En tu máquina, no en el servidor. La clave privada no debería viajar.

```bash
openssl genrsa -out aai-privada.key 2048
```

```bash
openssl req -new -key aai-privada.key -subj "/C=AR/O=NOMBRE DEL ESTUDIO/CN=contabilidad-ai/serialNumber=CUIT 30123456789" -out aai-pedido.csr
```

Reemplazá `NOMBRE DEL ESTUDIO` y el CUIT por los reales. El `CN` es un alias
libre; conviene que identifique al sistema.

**Cuidá `aai-privada.key`.** Quien la tenga junto con el certificado puede
operar ante ARCA en nombre del contribuyente. No se commitea, no se manda por
mail, no se deja en Descargas.

---

## 2. Obtener el certificado

El trámite es **distinto** en cada ambiente, y los certificados **no son
intercambiables**. `V1`

### Homologación (para probar)

Se gestiona por **WSASS — Autoservicio de Acceso a APIs de Homologación**, al que
se entra con Clave Fiscal. `V1`

1. Ingresar a WSASS con Clave Fiscal. `V2`
2. Crear un DN y adjuntar el CSR del paso 1. `V2`
3. Descargar el certificado emitido. `V2`
4. **En el mismo WSASS**, asociar el certificado al servicio **`wscdc`**
   (constatación de comprobantes). `V1` — que el certificado exista no alcanza:
   sin la asociación al servicio, WSAA lo rechaza.

### Producción

1. En el portal de ARCA con Clave Fiscal, entrar a **Administrador de
   Certificados Digitales**. `V1`
2. Crear un alias y adjuntar el CSR. Descargar el `.crt`. `V2`
3. Entrar a **Administrador de Relaciones de Clave Fiscal**. `V1`
4. Crear una relación: **Nuevo servicio → seleccionar `wscdc` → asignar el
   certificado (computador fiscal) creado en el paso 2**. `V2`

> **Si el sistema va a operar para empresas clientes**, el trámite del paso 3–4 lo
> hace **cada contribuyente** desde *su* Clave Fiscal, delegando el servicio al
> CUIT del estudio. Es el paso que suele demorar el onboarding de un cliente
> nuevo, así que conviene pedirlo temprano.

---

## 3. Verificar antes de configurar nada

```bash
npm run build && node scripts/arca-check.mjs --env homologacion --cert ./aai.crt --key ./aai-privada.key --cuit 30123456789
```

El script comprueba, en orden: que los endpoints respondan, que el servicio esté
arriba, y que WSAA acepte la autenticación. Si algo falla, dice **cuál** de los
tres pasos falló y las causas habituales — en vez de dejar el sistema
devolviendo `NO_VERIFICABLE` sin explicación.

Ejecutalo primero contra **homologación**. Recién cuando pase, repetir el trámite
para producción.

---

## 4. Cargar la credencial en el sistema

La clave privada se guarda **cifrada** en `company_arca_credentials`
(`private_key_encrypted`), con la DEK de la empresa envuelta por la KEK del
gestor de secretos. Nunca se escribe en disco de la aplicación ni aparece en
logs.

Variables de entorno:

```bash
ARCA_ENVIRONMENT=homologacion   # mock | homologacion | produccion
ARCA_KMS_KEY_ID=...             # referencia a la KEK, no la clave
```

Sobre `ARCA_ENVIRONMENT` hay una decisión deliberada que conviene conocer:

**El mock se usa si y solo si el ambiente es `mock`.** No existe un
"si no hay credencial, mockeá". Esa comodidad haría que una configuración
incompleta en producción produjera validaciones fiscales inventadas informadas
como reales. Sin credencial en producción, el sistema responde
`NO_VERIFICABLE / SIN_CREDENCIAL` y lo muestra como tal.

---

## 5. Habilitar el servicio por empresa

Tener certificado no implica tener el servicio habilitado: el catálogo oficial
advierte que ciertos servicios requieren *"autorizaciones y acuerdos especiales
con ARCA"*. `V1`

Por eso hay una tabla `company_arca_capabilities`: la UI muestra qué
validaciones están disponibles para cada empresa, en lugar de fallar sin
explicación. Cuando `arca-check` pasa para un CUIT, se marca `enabled = true` con
su `verified_at`.

---

## 6. Qué hace el sistema cuando algo falla

Nunca inventa un "OK". Cada situación tiene su motivo, y todos bloquean la
aprobación automática:

| Situación | Resultado | Qué ve el contador |
|---|---|---|
| Sin certificado cargado | `NO_VERIFICABLE / SIN_CREDENCIAL` | "No hay certificado digital configurado para esta empresa" |
| Servicio no habilitado para el CUIT | `NO_VERIFICABLE / SERVICIO_NO_HABILITADO` | "El CUIT no tiene habilitado el servicio de constatación" |
| ARCA caído | `NO_VERIFICABLE / SERVICIO_CAIDO` | "El servicio de ARCA no respondió" |
| Timeout | `NO_VERIFICABLE / TIMEOUT` | "La consulta excedió el tiempo de espera" |
| Respuesta ininteligible | `NO_VERIFICABLE / RESPUESTA_INESPERADA` | "ARCA devolvió una respuesta que no se pudo interpretar" |
| Ambiente mock | `NO_VERIFICABLE / AMBIENTE_MOCK` | "Simulación: no tiene valor probatorio" |
| ARCA responde `R` | `FAIL` | El código y mensaje de observación, textual |
| ARCA responde `A` con observaciones | `WARN` | "Autorizado, con observaciones" + detalle |
| ARCA responde `A` limpio | `OK` | "ARCA confirma que el comprobante está autorizado" |

La última fila tiene un límite que conviene tener presente: **`OK` significa que
el comprobante fue autorizado, no que la operación existió.** Una factura
apócrifa perfectamente autorizada es exactamente el caso que interesa detectar, y
por eso la validación fiscal es un sello separado de la contable y de la
económica (§11 del pliego).

---

## 7. Renovación

Los certificados vencen —duran dos años— y hasta B2.5.4 eso pasaba en silencio.
`company_arca_credentials_public` calculaba `dias_restantes` desde la 0015 y no
lo miraba nadie: el día del vencimiento, `credencialVigente()` deja de devolver
fila y la constatación empieza a contestar `NO_VERIFICABLE / SIN_CREDENCIAL`.
Es la respuesta correcta, y no hay error ni log que lo anuncie.

**Ahora aparece en la bandeja de pendientes** (`work_queue`, migración 0116):

| Cuándo | Qué muestra |
|---|---|
| Faltan más de 30 días | Nada. Un pendiente que no se puede resolver todavía es ruido |
| Faltan 30 días o menos | `ARCA_CERTIFICADO_POR_VENCER`, con la fecha límite. No bloquea |
| Ya venció | `ARCA_CERTIFICADO_VENCIDO`, **bloquea**: la capacidad ya se perdió |

Renovar es repetir los pasos 1 y 2. La asociación al servicio del paso 5 hay que
rehacerla con el certificado nuevo.

> ⚠ **La renovación no se puede solapar, y conviene saberlo antes.**
> `company_arca_credentials_active` (0015) permite **una sola** credencial
> `ACTIVE` por empresa y ambiente, porque dos certificados vigentes a la vez
> hacen impredecible con cuál se firmó cada consulta.
>
> La consecuencia: **no se puede pre-cargar el reemplazo**. Hay que revocar el
> viejo y recién ahí cargar el nuevo, con una ventana sin credencial en el
> medio. Es corta si se hace de una sentada —y es exactamente para eso que sirve
> el aviso a treinta días: permite elegir cuándo abrirla, en vez de que la abra
> el vencimiento en pleno cierre.

---

## Estado de la implementación

| Componente | Estado |
|---|---|
| Contrato `ArcaClient`, tipos de dominio, modelo de degradación | ✅ implementado y testeado |
| `MockArcaClient` con fixtures del manual oficial | ✅ 27 tests |
| Mapeo a los tres sellos de validación (§11) | ✅ testeado |
| **Endpoints de homologación** | ✅ **verificados contra el servicio real** (2026-08-24) |
| **Transporte SOAP y parseo de respuesta** | ✅ **verificados**: `ComprobanteDummy` respondió `app=OK db=OK auth=OK` desde homologación |
| Construcción y firma CMS del TRA | ✅ verificado con un certificado autofirmado generado en el test: el PKCS#7 es válido y contiene el TRA |
| **Autenticación WSAA de punta a punta** | ✅ **verificada contra el servicio real** (2026-08-27, homologación): el certificado quedó autorizado a `wsfe` en WSASS y el WSAA devolvió tickets reales. `buildTra`, `signTra` y `parseLoginResponse` se ejercitaron contra el organismo |
| `ComprobanteConstatar` real | ⚠️ no verificado: falta autorizar `wscdc` en WSASS, que es un trámite aparte del de `wsfe` |
| Padrón A13 y A100 | ⬜ no implementados. Sus manuales **sí** están archivados con hash (`ARCA_manual_ws_sr_padron_a13_v1.4.pdf`, `..._a100_v2.1.pdf`); lo que no está es el código |

> **El ticket de WSAA no se pide dos veces.** El organismo emite **uno solo por
> (CUIT, servicio)** y niega el siguiente mientras el primero viva
> —`coe.alreadyAuthenticated`, «El CEE ya posee un TA valido»—. Los TA duran
> horas y reintentar no ayuda: cada pedido de más acerca un bloqueo.
>
> Por eso `TicketCacheFs` guarda el TA en `~/.arca/tickets/<ambiente>/` (o
> `ARCA_TA_CACHE`), **fuera del repositorio**, porque `token` y `sign` son
> credenciales. No es una optimización: sin caché en disco, dos comandos
> seguidos no funcionan. Medido el 2026-08-27, `arca:check` sacó el ticket y
> `comprobantes:generar` —un minuto después— se quedó afuera hasta la noche.

El alcance de lo verificado es más amplio de lo que parecía posible sin
certificado: los endpoints salieron del manual archivado y **responden**, el
sobre SOAP que arma el cliente **lo entiende ARCA**, y la respuesta **se parsea
bien**. Lo que falta comprobar es exclusivamente el intercambio del certificado
por un ticket de acceso.

Las filas con ⚠️ son deuda declarada, no supuestos, y están anotadas también en
el encabezado de `soap-client.ts` y `wsaa.ts`.
