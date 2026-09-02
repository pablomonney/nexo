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

Ninguna de las últimas cuatro es un estado degradado disfrazado: son modos de
operación previstos, y cada uno **dice** en qué modo está en vez de contestar
como si hubiera mirado.

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
| **Gestor de secretos** | `MFA_ENCRYPTION_KEY` y las credenciales de ARCA no pueden vivir en un `.env` de producción. Cuál gestor es una decisión de infraestructura. |
| **Programación de copias** | Los scripts existen y nadie los agenda. Cada cuánto y cuánto se retiene es una decisión con costo y con obligación legal de conservación detrás. |
| **Destino de los logs** | Hoy salen por la salida estándar, que es lo correcto para un contenedor. A dónde van después lo decide el proveedor. |
| **Escalado horizontal** | La aplicación guarda dos cosas en memoria y las dos son por proceso: los contadores de métricas y la ventana del límite de intentos. Con varias réplicas, el recolector tiene que sumar las primeras, y el límite efectivo de la segunda se multiplica por la cantidad de réplicas. Contarlo en la base agregaría una escritura por intento fallido en el camino más caliente del sistema, así que la decisión es del tamaño del despliegue. |

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
