# Despliegue

Qué hace falta para que NEXO corra fuera de una máquina de desarrollo, qué ya
está preparado y **qué decisiones siguen sin tomarse**. La auditoría integral lo
dejó como P1: nada de lo construido sirve si no corre en ningún lado.

Este documento no elige proveedor de hosting, ni orquestador, ni gestor de
secretos. Elegirlos es una decisión con costo y con contrato detrás.

---

## 1 · Lo que ya está

| Pieza | Estado |
|---|---|
| Imagen de la aplicación | `Dockerfile`, dos etapas, sin compilador en la imagen final, usuario no root, `HEALTHCHECK` contra `/health/db` |
| Sondas | `GET /health` (proceso) y `GET /health/db` (llega a la base y cuántas migraciones aplicó) |
| Métricas | `GET /metrics` en formato de exposición estándar, **apagado** salvo que se declare `METRICS_TOKEN` |
| Migraciones | `npm run db:migrate`, con guarda de checksum: una migración editada después de aplicada no pasa |
| Verificación de arranque | `npm run verify:arranque` recorre el primer arranque sobre una base vacía que crea y destruye |
| Copias | `npm run db:backup` y `npm run db:restaurar`, con restauración **verificada** contra una base descartable |
| Integridad | `npm run ledger:verify`, `npm run audit:cadena`, `npm run audit:estructura`, `npm run audit:invariants` |

## 2 · Variables de entorno

**Obligatorias en producción**

| Variable | Para qué | Si falta |
|---|---|---|
| `DATABASE_URL` | La base | El servidor no arranca |
| `MFA_ENCRYPTION_KEY` | Cifra el secreto TOTP en reposo. 32 bytes en base64 | El servidor no arranca |
| `NODE_ENV=production` | Endurece varios comportamientos | Corre en modo desarrollo |

**Opcionales, y cada una con su consecuencia**

| Variable | Por defecto | Qué pasa con el valor por defecto |
|---|---|---|
| `PORT` | `3001` | — |
| `DOCUMENT_STORAGE_PATH` | `./var/documents` | Los documentos viven adentro del contenedor y se pierden al redesplegar. **En producción tiene que ser un volumen.** |
| `METRICS_TOKEN` | sin declarar | `GET /metrics` contesta 404: no existe |
| `SESSION_IDLE_MINUTES` | `30` | — |
| `SESSION_ABSOLUTE_HOURS` | `12` | — |
| `LOGIN_MAX_FAILED` | `5` | — |
| `LOGIN_LOCK_MINUTES` | `15` | — |
| `LOGIN_RATE_PER_MINUTE` | `30` | Intentos **fallidos** por minuto y por origen sobre las rutas de autenticación. Es por proceso: con varias réplicas el límite efectivo se multiplica por la cantidad de réplicas |
| `AUDIT_RECORD_IP` | `false` | La bitácora no guarda IP. Activarlo tiene consecuencias legales (§21) |
| `EMAIL_PROVIDER` | `none` | No sale ningún correo: lo encolado queda `SIN_PROVEEDOR` en `email_outbox` y **el alta autoservicio no se completa sola**. Admite `none` y `resend`; cualquier otro valor **no arranca** |
| `EMAIL_API_KEY` (o `EMAIL_API_KEY_REF`), `EMAIL_FROM` | vacías | Con `EMAIL_PROVIDER=resend` y alguna vacía: **preparado, no conectado**. El arranque lo dice y nombra la que falta, y el alta sigue funcionando contra la bandeja |
| `EMAIL_TIMEOUT_MS` | `10000` | Timeout por intento |
| `EMAIL_MAX_RETRIES` | `2` | Reintentos **además** del primero, solo para 429, 5xx y fallos de red. Un **timeout no se reintenta**: no dice que el mensaje haya sido rechazado, y reintentarlo podría mandarlo dos veces |
| `ARCA_ENVIRONMENT` | `mock` | La constatación no consulta al organismo: informa `NO_VERIFICABLE` |
| `ARCA_TIMEOUT_MS` | `15000` | — |
| `ARCA_LOCAL_KEK` | una al azar por arranque | Envuelve las claves privadas de ARCA: 32 bytes en base64. Si se deriva al azar, **las credenciales cargadas dejan de abrirse al reiniciar**. En producción no se usa en ningún caso: `desenvolver()` se niega a abrir un sobre `local:` con `NODE_ENV=production` (ver §4.1) |
| `OCR_ENGINE` | `none` | Los documentos se archivan y la extracción informa `SIN_MOTOR_OCR` |
| `AI_PROVIDER` | `none` | Las sugerencias salen del historial de la empresa, sin mandar nada afuera |
| `AI_API_KEY`, `AI_MODEL_ID`, `AI_BASE_URL` | vacías | Con `AI_PROVIDER=http` y alguna vacía: **preparado, no conectado**. El arranque lo dice y nombra la que falta |
| `AI_TIMEOUT_MS` | `30000` | Timeout por intento. No existe una llamada al modelo sin límite |
| `AI_MAX_RETRIES` | `2` | Reintentos **además** del primero, solo para 429, 5xx y fallos de red |
| `AI_PREGUNTAS_POR_MINUTO` | `20` | Tope técnico por usuario contra el bucle. El gasto lo gobierna el cupo diario, que declara cada empresa |

Ninguna de las últimas cuatro es un estado degradado disfrazado: son modos de
operación previstos, y cada uno **dice** en qué modo está en vez de contestar
como si hubiera mirado.

> ⚠ **`AI_PROVIDER` admite exactamente `none`, `mock` o `http`.** Cualquier otro
> valor —el nombre de un proveedor real, un typo— **hace que el servidor no
> arranque**. Antes degradaba en silencio y el banner informaba `real: true`
> mientras el sistema no usaba ningún modelo: decía tener una capacidad que no
> tenía, y nadie iba a buscar por qué no aparecían las sugerencias.
>
> Que haya credencial cargada tampoco significa «conectado». Lo único que
> prueba una conexión es una llamada que volvió, y eso lo dice
> `ai_predictions`, no una variable de entorno.

El procedimiento completo del correo —qué hay que hacer en Resend, dónde van las
tres variables, cómo se comprueba que quedaron bien y qué prueba end-to-end se
corre después— está en `docs/CORREO_RESEND.md`.

## 3 · El orden de un despliegue

Las migraciones **no corren al arrancar el contenedor**. Con dos réplicas, cada
una intentaría migrar y las dos correrían contra la misma base. El orden es:

1. Backup verificado de la base (`npm run db:backup`).
2. Migrar, **una sola vez**, desde un trabajo aparte: `npm run db:migrate`.
3. Desplegar la imagen nueva.
4. Comprobar `GET /health/db`: informa cuántas migraciones aplicó.
5. Correr `npm run ledger:verify` y `npm run audit:cadena` contra la base
   productiva. Los dos son de solo lectura.

El paso 2 antes del 3 exige que cada migración sea compatible con la versión
anterior del código mientras las dos conviven. Es la razón por la que ninguna
migración de este repositorio renombra ni borra una columna en uso.

### 3.1 · Lo que hay que agendar

```bash
npm run diario              # todos los días
npm run diario -- --ensayo  # dice qué haría, sin escribir nada
```

Corre, en orden y sin cortarse ante un fallo: el **ciclo de facturación**, la
**verificación del libro** y la **cadena de auditoría**. Sale con código 1 si
alguna falló, y el resumen final dice cuál.

**Correrlo dos veces el mismo día es inocuo**, y no por casualidad: cada paso ya
era idempotente por su cuenta, que es la condición para poder agendar algo sin
miedo.

> ⚠ **No es opcional.** La prueba de catorce días **solo termina cuando corre el
> ciclo de facturación**: `vencerPruebas` se llama desde `correrCiclo` y desde
> ningún otro lado. Sin esto agendado, ninguna prueba vence, ninguna suscripción
> pasa a `SUSPENDIDA` y el producto queda gratis por tiempo indefinido — sin que
> nada lo indique, porque desde adentro todo funciona. Lo encontró la auditoría
> B-2 siguiendo la cadena de llamadas.

**Esto ya está agendado** desde el 2026-09-16: `nexo-diario`, a las 03:15 UTC.
Las cuatro unidades y su instalador están en `infrastructure/systemd/`, con su
propio README.

La **copia de resguardo también**, desde el 2026-09-17: `nexo-respaldo`, a las
02:30 UTC, cuarenta y cinco minutos antes del ciclo. Durante meses quedó afuera
a propósito —cada cuánto correrla y cuánto retener tienen atrás una obligación
legal de conservación— y la decisión finalmente se tomó: **catorce copias**,
verificadas al escribirlas, con la poda limitada a las automáticas. El
razonamiento completo está en `infrastructure/systemd/README.md`.

Lo que **sigue** sin decidirse es sacar la copia fuera del servidor: hoy vive en
el mismo disco que la base, lo que alcanza para deshacer un error de software y
no para perder el VPS.

## 3.2 · La forma del despliegue, y por qué es la que es

Decidido en B2.5.2, después de medir la aplicación. **Un proceso, un volumen y
una base administrada.** No hay más piezas, y no es minimalismo: es lo que la
arquitectura pide.

Lo que se midió, y lo que cada medición descarta:

| Hecho medido | Consecuencia |
|---|---|
| **Un solo proceso escucha** (`apps/api/src/index.ts`, puerto 3001) | No hay servicios que orquestar |
| **La API sirve el frontend** — `GET /` y `GET /consola` leen `apps/web/*.html` con `readFile` | **No hay front separado que desplegar.** Un hosting estático (Vercel, Netlify, Pages) no tiene qué alojar, y partirlo en dos agregaría CORS y un origen más para nada |
| **Sin websockets, sin workers, sin `setInterval`** | Nada exige un proceso especial ni una cola |
| **Los documentos van al disco** (`FilesystemDocumentStore`) | **Hace falta un volumen persistente.** Esto descarta serverless: en un sistema de archivos efímero, el comprobante que un cliente sube se pierde en el próximo despliegue |
| **Contadores y límite de intentos viven en memoria del proceso** | Con varias réplicas, las métricas se dividen y el límite se multiplica. **Una sola instancia** hasta que haya motivo medido para más |
| **7 dependencias de producción**, imagen Alpine de dos etapas | Cabe en la máquina más chica de cualquier proveedor |

**Entonces: un contenedor con disco + PostgreSQL 18 administrado.** Lo que hoy
justificaría algo más grande —varias réplicas, una cola, un balanceador— no
existe todavía, y agregarlo ahora sería pagar y mantener piezas que no resuelven
ningún problema que tengamos.

Lo que **no** se elige acá es el proveedor, y sigue sin elegirse por el mismo
motivo de siempre: tiene costo, contrato y jurisdicción. Lo que cambió es que la
forma ya está decidida, así que la pregunta pendiente es «cuál» y no también
«cómo».

## 3.3 · El dominio y sus registros

El dominio del proyecto es **`nexointelligence.com.ar`**, tramitado ante NIC
Argentina. **Mientras el trámite no esté aprobado no hay ninguna zona DNS que
configurar**, y nada de esta sección se puede ejecutar todavía.

Los valores concretos —a qué dirección apunta el `A`, qué host da el proveedor
para el `CNAME`, qué clave publica el proveedor de correo— **los da el proveedor
al contratarlo**. Acá está qué registros van a hacer falta y para qué; poner
valores de ejemplo sería inventar la mitad del trabajo.

| Registro | Nombre | Para qué | De dónde sale el valor |
|---|---|---|---|
| `A` (o `ALIAS`/`CNAME` plano) | `nexointelligence.com.ar` | El dominio principal, que es donde vive la aplicación | La IP o el host que da el proveedor de hosting |
| `CNAME` | `www` | Redirige al principal | El mismo host del proveedor |
| `TXT` | `nexointelligence.com.ar` | SPF: qué servidores pueden mandar correo con este dominio | El proveedor de correo publica el suyo. Con Resend, un `include:` propio |
| `CNAME` × 3 | los que indique Resend | DKIM: firma los mensajes para que no caigan como falsificados | Los da Resend al verificar el dominio |
| `TXT` | `_dmarc` | DMARC: qué hacer con un mensaje que no pasa SPF/DKIM | Se declara. Conviene empezar en `p=none` y endurecer con los informes en la mano |
| `MX` | — | **No hace falta para que NEXO mande.** Solo si además se quiere *recibir* correo en el dominio | El proveedor de casillas, si se contrata uno |
| `CAA` | `nexointelligence.com.ar` | Limita qué autoridad puede emitir certificados del dominio | La que use el proveedor de TLS |

**El principal es el desnudo —`nexointelligence.com.ar`— y `www` redirige.** Es
la decisión que hay que tomar antes de emitir el certificado y antes de que
alguien comparta un enlace, porque cambiarla después parte los enlaces que ya
circulan. La cookie de sesión es `sameSite: 'strict'` y sin `domain`, así que
queda atada al host exacto que sirvió la respuesta: dos hosts activos serían dos
sesiones distintas.

TLS lo termina el proveedor. La aplicación **no** habla HTTPS: por eso, y solo
cuando haya un proxy delante, hay que declarar `TRUST_PROXY=true` (§6).

## 4 · Lo que falta, y por qué no se decidió acá

| Decisión | Por qué no la toma este documento |
|---|---|
| **Proveedor de hosting** | Tiene costo, contrato y jurisdicción. La jurisdicción no es un detalle: los datos son contabilidad de terceros. La **forma** ya está decidida en §3.2. |
| **Terminación TLS** | Depende del proveedor. La aplicación **no** termina TLS; el proxy que la exponga tiene que reescribir `X-Forwarded-For` y no dejar pasar la de afuera, y entonces se declara `TRUST_PROXY=true` (§6). |
| **Gestor de secretos** | `MFA_ENCRYPTION_KEY` y las credenciales de ARCA no pueden vivir en un `.env` de producción. Cuál gestor es una decisión de infraestructura — **la única que falta**: el código ya está del otro lado de la interfaz (ver §4.1). |
| ~~**Programación de copias**~~ | **Decidido el 2026-09-17**: `nexo-respaldo`, diaria a las 02:30 UTC, catorce copias, verificadas al escribirlas. Lo que sigue abierto es **dónde guardarlas afuera del servidor**: hoy comparten disco con la base. |
| ~~**Agendador de las tareas diarias**~~ | **Decidido el 2026-09-16**: timers de systemd en el host, arrancando la imagen desplegada. Ver `infrastructure/systemd/README.md`. |
| **Destino de los logs** | Hoy salen por la salida estándar, que es lo correcto para un contenedor. A dónde van después lo decide el proveedor. |
| **Escalado horizontal** | La aplicación guarda dos cosas en memoria y las dos son por proceso: los contadores de métricas y la ventana del límite de intentos. Con varias réplicas, el recolector tiene que sumar las primeras, y el límite efectivo de la segunda se multiplica por la cantidad de réplicas. Contarlo en la base agregaría una escritura por intento fallido en el camino más caliente del sistema, así que la decisión es del tamaño del despliegue. |

### 4.1 · Secretos: qué hay que hacer el día que se elija el gestor

Lo que falta es **una cuenta y una credencial de infraestructura**, no
arquitectura. El sistema ya guarda la referencia y no el valor: `secret_refs`
no tiene columna donde poner material, y `SECRETS_PROVIDER=kms` **hace fallar el
arranque a propósito**, con el motivo escrito, en vez de degradar en silencio a
`env`.

Conectar uno son cuatro pasos, y ninguno toca el dominio:

1. Escribir un adaptador en `apps/api/src/secrets/` que implemente
   `SecretProvider` (dos métodos: `get` y `existe`). El SDK del proveedor vive
   ahí y **solo ahí**: el lint de arquitectura impide que un paquete de
   `packages/` lo importe.
2. Devolverlo desde `crearProveedorDeSecretos` para el nombre `kms`, en lugar
   del error que hoy tira.
3. Cargar el material en el gestor y declarar la referencia por
   `POST /companies/current/secrets` con el prefijo `kms:`. **Las filas
   existentes no se migran**: cambia el prefijo de la referencia, no la tabla.
4. Rotar una vez y comprobar en la bitácora que quedó
   `ROTAR_REFERENCIA_DE_SECRETO` sin el valor.

Hasta el paso 1, `env:` resuelve los secretos del despliegue y **se niega** a
resolver uno por empresa. Es el bloqueo real: sin gestor no hay ARCA de
producción para varias empresas. Ver SECURITY.md §5.

### 4.2 · Qué gestor, y con qué criterio elegirlo

**Ninguno está contratado y este documento no elige.** Lo que sí hace es dejar
escrito el criterio, porque la decisión tiene una trampa: el gestor más completo
no es el mejor para NEXO hoy.

| | Cuándo tiene sentido | Qué cuesta de verdad |
|---|---|---|
| **El del propio hosting** (Railway, Render, Fly) | Si los secretos son **solo del despliegue**. Es una variable de entorno cifrada en reposo, gestionada donde ya está todo lo demás | Nada extra. Pero **no resuelve secretos por empresa**: sigue siendo el entorno del proceso |
| **AWS Secrets Manager / KMS** | Si hacen falta secretos **por empresa**, rotación automática y auditoría de cada lectura. Es el más completo | Cuenta de AWS, IAM, y una dependencia de nube que hoy no existe. **PRECIO A CONFIRMAR** — se cobra por secreto y por llamada |
| **Google Secret Manager** | Lo mismo, con un modelo de permisos más simple | Cuenta de GCP. **PRECIO A CONFIRMAR** |
| **Azure Key Vault** | Lo mismo. Conviene si el hosting termina siendo Azure | Cuenta de Azure. **PRECIO A CONFIRMAR** |
| **Infisical / Doppler** | Gestores dedicados, más simples de operar que los de nube, con capa gratuita | Un proveedor más en la cadena de confianza. **PRECIO A CONFIRMAR** |

**El criterio que decide es uno solo: ¿hace falta un secreto por empresa?** Todo
lo demás —costo, rotación, auditoría— es secundario frente a eso, porque es lo
único que el entorno del despliegue **no puede hacer de ninguna manera** (ver
§4.3). Mientras la respuesta sea que no, el gestor del hosting alcanza y es el
más barato de operar. Cuando sea que sí, hace falta uno de los otros.

Conviene además que sea del **mismo proveedor que el hosting**: una credencial
de nube guardada para leer secretos es, ella misma, un secreto que hay que
guardar en algún lado, y el que lo resuelve sin recursión es el proveedor donde
el proceso ya corre con una identidad.

### 4.3 · Qué es del despliegue y qué es de cada empresa

La distinción no es de tamaño: es de **quién sufre si se filtra**.

| | Ejemplos | Dónde vive hoy | Dónde va |
|---|---|---|---|
| **Del despliegue** | `DATABASE_URL`, `MFA_ENCRYPTION_KEY`, `EMAIL_API_KEY`, `AI_API_KEY`, `METRICS_TOKEN` | Entorno del proceso | El gestor del hosting alcanza |
| **De cada empresa** | El **certificado y la clave privada de ARCA** de cada contribuyente | `company_arca_credentials`, con sobre propio y RLS | Un gestor con secretos por empresa |

**Hoy existe exactamente un secreto por empresa, y es el de ARCA.** No hay
credenciales de proveedores por empresa, ni claves de API propias del cliente,
ni integraciones externas con material del cliente. Por eso `secret_refs`
—que **sí** soporta `company_id`— está preparada y no tiene material de nadie:
`reference` guarda dónde está el secreto y la tabla **no tiene columna donde
poner el valor**.

Y por eso `DbSecretProvider` se niega con el prefijo `db:` en vez de crear una
tabla de material genérica: guardar un secreto de una empresa con la llave del
entorno sería el mismo sobre aparente en un lugar más. La KEK viviría junto al
ciphertext, que es exactamente contra lo que un sobre debería proteger.

**Lo que esto significa para la decisión:** hasta que NEXO opere ARCA de
producción para más de una empresa, no hace falta un gestor con secretos por
empresa. El día que haga falta, lo que cambia es el prefijo de la referencia
—`kms:` en lugar de `env:`— y ninguna fila se migra.

## 5 · Lo que hay que mirar antes de la primera empresa real

- **Certificado de ARCA de producción.** Hoy el repositorio solo tiene el de
  homologación, y vive fuera del árbol (`C:\ARCA\`). El de producción emite a
  nombre del contribuyente: es una credencial con consecuencias fiscales.
- **Conservación.** La documentación respaldatoria tiene plazos legales de
  guarda. El almacén de documentos y las copias tienen que cumplirlos, y eso
  condiciona dónde pueden estar alojados.
- **La consola no es la interfaz definitiva.** Está declarado en
  `apps/web/README.md` y en la auditoría integral: es una consola técnica.
  Ponerla frente a un usuario no técnico sin la capa de producto es una decisión
  que conviene tomar a sabiendas.

---

## 6 · Las dos cosas que fallan sin dar síntoma

Agregadas en B2.5.2. Las dos tienen la misma forma —**el sistema anda igual de
bien mal configurado**— y por eso el arranque las imprime siempre y una de ellas
directamente impide levantar.

### 6.1 · El rol de PostgreSQL

Todo el aislamiento entre empresas se apoya en RLS, y **RLS se evalúa contra el
rol que ejecuta la consulta**. Un superusuario no ve las políticas: las
atraviesa. No falla nada, no hay error, no hay log — una empresa ve los datos de
otra y el sistema se comporta como si estuviera bien.

`packages/db/src/tenancy.ts` hace `SET LOCAL ROLE aai_app` en cada transacción,
así que el rol **efectivo** es el correcto aunque se conecte con otro. Eso es lo
que permite que la base de desarrollo conecte como dueña sin romper nada.

En producción no alcanza: si el rol de la conexión es superusuario, **cualquier
consulta escrita fuera de `withCompany`/`withoutCompany` corre sin políticas**.
Hoy no hay ninguna; el candado está para el día que alguien agregue una.

Por eso, con `NODE_ENV=production`, el arranque **se niega** si el rol de
conexión es superusuario o si el efectivo puede saltear RLS, y dice cómo
arreglarlo. El control es `tests/security/produccion-endurecida.test.ts`.

**`aai_app` no sirve como rol de conexión: es `NOLOGIN`.** Y es correcto que lo
sea — es el rol al que baja cada transacción, no uno con el que se entra. Hace
falta un rol de conexión que sea **miembro** suyo, y se crea una sola vez, con
el rol administrador de la base:

```sql
CREATE ROLE nexo_app LOGIN PASSWORD '…' NOSUPERUSER NOBYPASSRLS NOCREATEDB;
GRANT aai_app TO nexo_app;
```

`DATABASE_URL` de producción apunta a `nexo_app`. Con eso, `SET LOCAL ROLE
aai_app` funciona —un rol solo puede bajar a otro del que es miembro— y ninguna
consulta, dentro o fuera de los envoltorios, puede saltear una política.

Comprobado el 2026-09-10 contra la base de desarrollo: la conexión es `postgres`
(superusuario), el rol efectivo dentro de la transacción es `aai_app` y **no**
puede saltear RLS. Con `NODE_ENV=production` esa misma configuración **se niega
a arrancar**, que es lo que se quería.

### 6.2 · El proxy

`TRUST_PROXY` decide de dónde sale `request.ip`, y de eso dependen el límite de
intentos y la IP de la bitácora. **Los dos valores fallan en silencio del lado
equivocado:**

| | Sin proxy adelante | Con proxy adelante |
|---|---|---|
| `TRUST_PROXY=false` | Correcto | `request.ip` es la del proxy **para todos**: el límite por origen se vuelve global y treinta fallos de cualquiera dejan afuera al resto |
| `TRUST_PROXY=true` | Cualquiera manda `X-Forwarded-For` y se inventa su dirección: el límite deja de servir | Correcto |

Se pone en `true` **si y solo si** hay un proxy que reescriba esa cabecera. Todo
despliegue con TLS terminado por el proveedor está en ese caso.

---

## 7 · El despliegue, paso a paso

### 7.0 · La forma concreta, en el servidor actual

Decidida y escrita en `docker-compose.prod.yml` el 2026-09-10, sobre el
servidor que ya existe:

| | |
|---|---|
| Aplicación | `nexo-app`, imagen `nexo:production`, red `nexo` |
| Base | `nexo-postgres`, **fuera de este Compose** — ver la nota del archivo |
| Proxy | Traefik, ya instalado en `/docker/traefik`. NEXO solo se anuncia con etiquetas |
| Documentos | `/opt/nexo/var/documents` → `/app/var/documents` |
| Puertos publicados | **ninguno**. Traefik llega por la red de Docker |

Tres decisiones que conviene no deshacer sin leer el archivo:

- **PostgreSQL no está en este Compose.** Adoptar un contenedor que ya corre lo
  hace recrear, y recrear una base en producción no se hace a ciegas.
- **`TRUST_PROXY=true`**, porque hay proxy adelante. Sin eso, `request.ip` sería
  la de Traefik para todos y el límite de intentos pasaría a ser global (§6.2).
- **`read_only: true`**, que es una promesa sobre el código: la API escribe
  únicamente en el volumen de documentos. La sostiene un control (S-43).

### 7.1 · Construir

```bash
docker build -t nexo:$(git rev-parse --short HEAD) -t nexo:production .
```

> ⚠ **La imagen tiene que llevar `infrastructure/`.** El preflight compara los
> `.sql` del disco contra `schema_migrations` y **se niega a arrancar** si no
> puede hacerlo. El primer despliegue real, el 2026-09-10, falló exactamente
> por eso: el Dockerfile no copiaba ese directorio.
>
> Se corrigió **en el servidor y no en el repositorio**, así que durante unas
> horas la imagen que andaba no era reproducible desde un clone limpio. Está
> corregido en el Dockerfile y lo vigila `tests/security/imagen-de-produccion.test.ts`,
> que además detecta la dependencia circular que se introdujo al arreglarlo.

La imagen es de dos etapas: la que corre no lleva compilador, ni dependencias de
desarrollo, ni el código fuente. Corre como `node`, no como root, y expone 3001.

`BUILD_ID` se declara al desplegar, con el mismo identificador que la etiqueta.
Es lo que después contesta `GET /health` y lo único que permite comprobar que lo
que está corriendo es lo que se publicó.

### 7.2 · Migrar, y qué pasa si falla

**Las migraciones no corren al arrancar el contenedor** —con dos réplicas, cada
una intentaría migrar contra la misma base—. Corren una vez, desde un trabajo
aparte, **antes** de desplegar la imagen nueva:

```bash
npm run db:migrate
```

Si una migración falla, **falla entera**: cada una corre en su transacción, así
que o se aplicó o no se aplicó, y no queda un esquema a medias. El despliegue no
avanza y la versión anterior sigue corriendo contra el esquema anterior, que es
justamente el orden que hace posible abortar sin consecuencias.

La guarda de checksum impide otra cosa distinta: **una migración ya aplicada no
se puede editar**. Corregir algo es una migración nueva.

### 7.2.1 · Levantar

```bash
cd /opt/nexo
git pull                                   # el código, no ediciones a mano
docker build -t nexo:production .
BUILD_ID=$(git rev-parse --short HEAD) \
  docker compose -f docker-compose.prod.yml up -d
docker compose -f docker-compose.prod.yml ps
```

`NEXO_DOMAIN` y `TRAEFIK_CERTRESOLVER` salen del entorno o de `/opt/nexo/.env`.
Mientras el dominio no resuelva, el contenedor corre igual y el enrutador de
Traefik simplemente no encuentra tráfico — la sonda interna sigue andando.

### 7.3 · Comprobar que quedó sano

```bash
curl -fsS https://<host>/health        # proceso vivo, y qué versión
curl -fsS https://<host>/health/db     # llega a la base, y cuántas migraciones aplicó
```

Las dos son distintas a propósito: `/health` **no toca la base**. Si preguntara
por PostgreSQL, una caída de la base haría que el orquestador reinicie la
aplicación en bucle, que es lo peor que puede pasar mientras la base vuelve.

Que `version` sea la que se acaba de publicar es la comprobación de que el
despliegue efectivamente cambió algo. Que `migrations` coincida con la cantidad
de archivos en `infrastructure/db/migrations/` es la comprobación de que el
esquema está al día.

Y después, contra la base productiva —las dos son de solo lectura—:

```bash
npm run ledger:verify
npm run audit:cadena
```

### 7.4 · Que el frontend y la API se hablan

No hay nada que comprobar entre dos servicios, porque **son el mismo**: `GET /`
sirve la página pública y `GET /consola` la consola, las dos desde el mismo
proceso que atiende la API. La comprobación de punta a punta es abrir `/consola`
e ingresar: si la sesión se establece, el mismo origen sirvió el HTML, aceptó la
credencial y devolvió la cookie.

### 7.5 · Volver atrás

Redesplegar la etiqueta anterior. El esquema **no** se revierte: por eso ninguna
migración de este repositorio renombra ni borra una columna en uso — para que la
versión anterior siga funcionando contra el esquema nuevo.

Una migración que sí rompiera esa compatibilidad convierte el rollback en una
restauración de copia, y eso pierde lo escrito desde el backup. Es el motivo de
la regla, y la regla es lo que hace barato volver atrás.

### 7.6 · Logs

Salen por la salida estándar en JSON, que es lo correcto para un contenedor: los
recoge el proveedor. El logger **redacta** las cabeceras de autorización y las
cookies antes de escribir (`apps/api/src/server.ts`).

`GET /metrics` expone contadores en formato de exposición estándar y **solo si**
se declaró `METRICS_TOKEN`; sin él contesta 404. Conectar un recolector es de
B2.5.6, no de esta etapa.

### 7.7 · El ensayo de restauración

> **Una copia que nunca se restauró es una hipótesis, no una copia.**
> `PROJECT_STATUS.md` lo decía desde que existe el backup, y durante meses fue
> una deuda viva: el RPO y el RTO eran estimaciones porque nadie había recorrido
> el camino de vuelta ni una vez.

Se hizo por primera vez el **2026-09-17**, sobre el backup automático real.

**En el servidor `db:restaurar` no corre**, y conviene saberlo antes de
intentarlo: el script necesita Node y `pg_restore` en el host, y el host tiene
Docker y nada más. Lo que sí corre es la secuencia equivalente, con `psql` y
`pg_restore` desde el contenedor de PostgreSQL.

```bash
# 0 · el candado: el destino tiene que empezar con aai_restauracion.
#     No se comprueba "que no sea producción": una lista negra siempre queda
#     corta, y la primera vez que quede corta el error es irreversible.
DESCARTABLE=aai_restauracion_ensayo
AUTO=$(ls -1t /opt/nexo/var/backups/*-auto.dump | head -1)

# 1 · crear la base descartable
psql -d postgres -c "CREATE DATABASE $DESCARTABLE"

# 2 · restaurar
docker exec -e PGPASSWORD -i nexo-postgres \
  pg_restore -U "$POSTGRES_USER" -d "$DESCARTABLE" --no-owner --no-password < "$AUTO"

# 3 · comparar estructura y filas contra la base viva
# 4 · correr los verificadores contra la restaurada
# 5 · arrancar la aplicación contra la restaurada
# 6 · borrar la base descartable
```

**Qué contestó, la primera vez:**

| | |
|---|---|
| estructura | idéntica: 169 tablas, 109 vistas, **126 con RLS forzado**, 126 políticas, 666 `CHECK`, 176 triggers, 374 funciones, 126 migraciones |
| contenido | 16 tablas con datos, **842 filas, idénticas tabla por tabla** |
| `audit:estructura` | los 439 objetos declarados, presentes |
| `audit:cadena` | `NO EJERCITADO` — la instalación no tiene empresas todavía |
| `ledger:verify` | `NO EJERCITADO`, por lo mismo |
| `migrate status` | las 126 aplicadas |
| **la API** | **arrancó y quedó escuchando contra la base restaurada** |

**Restaurar no es verificar, y el conteo es la mitad que suele faltar.**
`pg_restore` puede terminar con código 0 y dejar un esquema a medio poblar. Un
backup que perdió la mitad de las filas pasa las dos primeras comprobaciones sin
ruido: el esquema está completo y un Mayor con menos asientos igual cuadra
consigo mismo. Solo el conteo contra la base viva lo delata.

**Dos cosas que el ensayo encontró, y las dos son candados funcionando:**

1. **La API se negó a arrancar con la credencial operatoria.** El preflight
   rechaza un `DATABASE_URL` superusuario —con un superusuario el aislamiento
   entre empresas quedaría a merced de que ninguna consulta se escriba fuera de
   `withCompany`—. Arrancó con la credencial de la aplicación, que es la
   correcta. Ver §6.1.
2. **`audit:invariants` no corre dentro del contenedor en modo conductual.**
   Siembra con `seed-norms.mjs`, que lee `docs/normative-sources/`, y `docs`
   está excluido de la imagen por `.dockerignore`. En modo `--observacional` sí
   corre. Es el mismo motivo por el que la tarea diaria usa ese modo.

**Lo que este ensayo no mide:** el RTO real de una restauración de producción.
Corre en la misma máquina, sobre el mismo disco, sin red de por medio. Dice que
el archivo es restaurable y completo, que es la mitad que no estaba probada.
