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
| `ARCA_ENVIRONMENT` | `mock` | La constatación no consulta al organismo: informa `NO_VERIFICABLE` |
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

## 4 · Lo que falta, y por qué no se decidió acá

| Decisión | Por qué no la toma este documento |
|---|---|
| **Proveedor de hosting** | Tiene costo, contrato y jurisdicción. La jurisdicción no es un detalle: los datos son contabilidad de terceros. |
| **Terminación TLS** | Depende del proveedor. La aplicación **no** termina TLS y corre con `trustProxy: false`, así que el proxy que la exponga tiene que ser confiable y no reenviar cabeceras de identidad. |
| **Gestor de secretos** | `MFA_ENCRYPTION_KEY` y las credenciales de ARCA no pueden vivir en un `.env` de producción. Cuál gestor es una decisión de infraestructura — **la única que falta**: el código ya está del otro lado de la interfaz (ver §4.1). |
| **Programación de copias** | Los scripts existen y nadie los agenda. Cada cuánto y cuánto se retiene es una decisión con costo y con obligación legal de conservación detrás. |
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
