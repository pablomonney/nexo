# NEXO — Motor de migración universal (V1)

> **Este documento describe el V1 y quedó superado.** Lo que sigue vigente es
> [`NEXO_MIGRATION_ENGINE_V2.md`](NEXO_MIGRATION_ENGINE_V2.md), del mismo día.
> Se conserva porque el V2 se apoya en su análisis y porque documenta dos
> afirmaciones que resultaron falsas —el escritor de productos nunca funcionó, y
> toda identidad compuesta abortaba la importación—, que es exactamente el tipo
> de cosa que un informe no debería poder borrar de su propia historia.

**Fecha de la medición:** 2026-09-09
**Alcance:** el módulo entero, desde el archivo del sistema anterior hasta las
filas escritas en la empresa.
**Cómo leer este documento:** todo lo que dice «está» se midió corriendo el
código el día de la fecha. Lo que falta se dice con nombre propio y con el
motivo, no como «próximamente».

---

## A · Qué hace, en una frase

Toma un archivo exportado de cualquier sistema, lo lee, muestra **qué entraría y
qué no**, y recién con una confirmación explícita escribe en la empresa — con
la posibilidad de deshacerlo entero después.

## B · La distinción que ordena todo el módulo

> **Un formato soportado no es un sistema soportado.**

NEXO lee el CSV que exporte cualquier programa. Eso **no** quiere decir que
conozca por dentro a ese programa: sus nombres de columna, sus códigos, su forma
de numerar. La diferencia está en el código y no en un comentario — cada
adaptador declara su estado, y la consola muestra el estado, no una promesa.

La segunda distinción, del mismo orden:

> **Transportar una entidad no es saber escribirla.**

El motor transporta las nueve entidades canónicas: las extrae, las mapea, las
normaliza, las valida y las muestra en la vista previa. Escribirlas en NEXO sabe
**dos**. Las otras siete llegan a la vista previa y ahí se detienen, cada una
con su motivo dicho en la pantalla.

---

## C · Estado de cada adaptador

Medido el 2026-09-09 sobre `registroPorDefecto()`, que es la misma lista que
sirve `GET /migraciones/fuentes` y la que dibuja la consola. No hay una segunda
lista en ninguna parte.

| Código | Origen | Medio | Estado | Trae datos hoy |
|---|---|---|---|---|
| `ARCHIVO_GENERICO` | Archivo (CSV, TSV, TXT, XLSX, XLS, JSON, XML, ZIP) | ARCHIVO | **IMPLEMENTADO** | **Sí** |
| `BASE_DE_DATOS` | PostgreSQL, MySQL, SQL Server, SQLite | BASE_DE_DATOS | PREPARADO | No |
| `API_REST` | API externa (REST o GraphQL) | API | PREPARADO | No |
| `TANGO` | Tango Gestión | ARCHIVO | PLANIFICADO | No |
| `BANCO_OFX` | Extracto bancario (OFX, QIF) | ARCHIVO | PLANIFICADO | No |
| `COMERCIO_API` | Mercado Libre, Tiendanube, Shopify, WooCommerce | API | BLOQUEADO | No |

Los cinco que no traen datos **no se pueden elegir**: su `extraer()` lanza con
el motivo, el endpoint de creación contesta `422 ADAPTADOR_NO_IMPLEMENTADO`, y
el selector de la consola solo lista los que declaran `IMPLEMENTADO`. Están en
la tabla para que se vea qué falta, no para que alguien los intente.

### Por qué falta cada uno

**`BASE_DE_DATOS` — PREPARADO.** Falta el mapa de esquema del sistema de origen:
qué tabla y qué columna es cada entidad. Sin eso, lo único que quedaría es
aceptar consultas SQL escritas desde el navegador, que es exactamente lo que la
regla de seguridad del módulo prohíbe. Con un esquema concreto delante, se
implementa.
*Dependencia:* un esquema real. *Qué está hecho:* el contrato, el modelo
canónico, la validación y la escritura — todo lo posterior a la extracción.
*Qué falta:* el lector y su mapa.

**`API_REST` — PREPARADO.** Falta una credencial contra un servicio real. La
paginación, el límite de pedidos y los errores parciales no se verifican leyendo
documentación: hay que ejercitarlos. La infraestructura de credenciales cifradas
ya existe en el Integration Hub y se reusaría.
*Dependencia:* una credencial de un servicio real. *Qué está hecho:* todo lo
posterior a la extracción, más el almacén de credenciales. *Qué falta:* el
cliente HTTP y su prueba contra el servicio.

**`TANGO` — PLANIFICADO.** Falta una exportación real de Tango para conocer sus
nombres de columna y sus códigos. Mientras tanto **un archivo exportado de Tango
se migra hoy** con el adaptador genérico y mapeo manual: lo que falta es el
reconocimiento automático, no la capacidad.
*Dependencia:* un archivo exportado de Tango. *Qué falta:* la tabla de sinónimos
propia de Tango.

**`BANCO_OFX` — PLANIFICADO.** OFX y QIF son estándares abiertos y no dependen de
nadie: falta escribir el lector. Un extracto en CSV o XLSX ya se migra con el
genérico.
*Dependencia:* ninguna externa. *Qué falta:* el lector.

**`COMERCIO_API` — BLOQUEADO.** Bloqueado por una cuenta de desarrollador y
credenciales OAuth2 en cada plataforma, que son un trámite. Una exportación
manual de cualquiera de ellas se migra hoy con el genérico.
*Dependencia:* alta de desarrollador en cada plataforma. *Qué falta:* todo el
adaptador, y no se puede empezar sin la credencial.

---

## D · Qué entidades se escriben en NEXO

| Entidad | ¿Se importa? | Por qué |
|---|---|---|
| `PARTY` (terceros) | **Sí** | — |
| `PRODUCT` (productos) | **Sí** | — |
| `ACCOUNT` | No | El plan de cuentas se carga desde su propia pantalla, que valida la jerarquía y qué cuentas son imputables. Importarlo por acá saltearía esa validación. |
| `JOURNAL_ENTRY` | No | Un asiento escribe en el Mayor. El importador tendría que decidir contra qué cuenta va cada renglón cuando el origen trae un código que NEXO no tiene, y eso no se deduce de un archivo. |
| `SALES_DOCUMENT` | No | Toca la numeración fiscal. Falta decidir cómo se distingue de uno emitido por NEXO sin generarle un CAE que nunca existió. |
| `PURCHASE_DOCUMENT` | No | Igual que ventas, más cómo se vincula al proveedor cuando el CUIT del origen no está entre los terceros. |
| `STOCK_BALANCE` | No | El stock de apertura escribe un movimiento con costo, y el costo entra al promedio ponderado. Falta decidir fecha de corte y depósito. |
| `STOCK_MOVEMENT` | No | Los movimientos históricos reconstruyen el promedio ponderado. Falta la reconciliación contra el stock del origen. |
| `PAYMENT` | No | Un pago se imputa contra comprobantes, y los comprobantes todavía no se importan. |

Una entidad sin escritor **no cuenta como rechazada**: se marca `OMITIDA`. La
distinción importa — «rechazada» dice que sus datos estaban mal, y no lo
estaban.

---

## E · El recorrido

    crear → cargar el archivo → mapear las columnas → validar → importar → reportar
                                                                    ↘ revertir

Once estados, con una tabla de transiciones en el código y un `CHECK` en la base
que la vuelve a exigir. Dos candados, porque el de la aplicación se saltea
llamando a otra ruta.

**Nada se escribe en la empresa hasta `POST /migraciones/:id/importar`.** Cargar,
mapear y validar no tocan `parties` ni `products`.

---

## F · Idempotencia

Correr la misma migración dos veces no duplica nada. La garantía no es un `if`:
es `UNIQUE (company_id, identidad)` sobre `migration_links`. La segunda corrida
reconoce las identidades y cuenta las filas como `YA_EXISTIA`.

Hay un segundo camino, que el primero no cubre: un tercero **cargado a mano
antes de migrar** no tiene vínculo. Se reconoce por su CUIT, con
`buscarExistente`. Sin eso, la migración lo duplicaría.

Medido, 3.000 terceros:

| Corrida | importados | ya estaban | rechazados |
|---|---|---|---|
| primera | 3.000 | 0 | 0 |
| segunda, mismo archivo | **0** | **3.000** | 0 |

---

## G · Reversión

`POST /migraciones/:id/revertir` con un motivo obligatorio (mínimo 10
caracteres, y la base lo vuelve a exigir para esa acción de bitácora).

Lo que la migración creó queda **archivado, no borrado**: un tercero puede tener
movimientos colgando, y el borrado fallaría por la clave foránea dejando la
reversión a medias. Lo que ya existía antes de migrar no se toca — comprobado
con un tercero preexistente que sigue `ACTIVO` después de revertir.

El nombre de la tabla que toca el `UPDATE` sale de una lista blanca literal del
código (`TABLAS_REVERSIBLES`), nunca de la fila de `migration_links`.

---

## H · Reconciliación

`GET /migraciones/:id/reporte` compara, por entidad:

    en el origen  =  importadas + ya estaban + rechazadas + omitidas

Lo que no cierra aparece como `sinExplicar`, y eso es un problema del
importador, no de los datos. En las corridas medidas, `cuadra: true` en todas
las entidades.

---

## I · Seguridad

| Qué | Cómo | Comprobado por |
|---|---|---|
| Aislamiento entre empresas | RLS `FORCE` en las cinco tablas, una política cada una, rol `aai_app` sin `BYPASSRLS` | S-35 + integración |
| Migración de A invisible desde B | 404, no 403 — desde B esa migración no existe | S-35 |
| No se puede importar la migración de A estando en B | 404, y `parties` de B queda en 0 | S-35 |
| Tres permisos y no uno | `migration:read` / `:write` / `:import`; `AUDITOR` tiene solo el primero | S-35 |
| Nunca SQL desde el navegador | Barrido estático: toda interpolación en una sentencia sale de una constante del propio archivo | S-35 |
| Encabezado hostil | `CUIT' OR 1=1 --` se guarda literal como nombre de columna; `parties` sigue existiendo | S-35 |
| Nombre de archivo | Se guarda como texto; el módulo **no abre ningún archivo** (comprobado: no hay `node:fs` en `apps/api/src/migracion/`) | S-35 |
| Filas crudas inmutables | Trigger `migration_rows_son_inmutables` + `REVOKE DELETE` | Integración |
| Bitácora | Seis acciones declaradas en `audit_actions`, con clave foránea: una acción sin declarar aborta la operación | S-35 |

Estado real de los permisos en la base, medido:

    migration_findings   DELETE,INSERT,SELECT,UPDATE
    migration_links      INSERT,SELECT,UPDATE
    migration_rows       INSERT,SELECT,UPDATE
    migration_tables     INSERT,SELECT,UPDATE
    migrations           INSERT,SELECT,UPDATE

`migration_findings` es la única con `DELETE`, y por un motivo: los hallazgos son
**derivados** —lo que el validador opina hoy con el mapeo de hoy— y se recalculan
enteros en cada validación. Las otras cuatro guardan prueba de lo que el sistema
anterior tenía, y eso no se destruye.

---

## J · Rendimiento

Medido con `npm run bench:migracion -- 3000`, base de desarrollo, PostgreSQL
18.6 local, 3.000 terceros (150 KB):

| Etapa | Tiempo | Ritmo |
|---|---|---|
| leer el archivo y guardar el crudo | 236 ms | 12.718 filas/s |
| validar | 1.788 ms | 1.677 filas/s |
| importar (primera vez) | 7.722 ms | 389 filas/s |
| importar (repetida, todo ya existe) | 6.194 ms | 484 filas/s |

**El límite real, dicho sin adornos:** la importación corre entera dentro de una
transacción, a ~400 filas por segundo. 50.000 terceros serían unos dos minutos
de transacción abierta. Funciona, pero para volúmenes mayores hace falta una
estrategia por tandas con puntos de control, y **eso no está**. El tope de
subida —25 MB— y el tope de filas del adaptador —200.000, con aviso explícito
cuando recorta— son lo que hoy impide llegar a un archivo que tumbe el proceso.

La lectura es veinte veces más rápida que la escritura: si algún día hay que
optimizar, el lugar es el `INSERT` por fila más la búsqueda de duplicado, no el
parser.

---

## K · Conjuntos de prueba

Ocho, generados por código y no guardados como archivos, para que el archivo y
la afirmación sobre el archivo no se puedan separar:

| Conjunto | Qué prueba | Resultado |
|---|---|---|
| LIMPIO | que lo correcto entre sin ruido | 3/3, cero observaciones |
| CON_ADVERTENCIAS | que un dato dudoso entre **y quede dicho** | se importa, con `NO_INTERPRETABLE` citando el crudo |
| CON_ERRORES | que lo que no puede entrar no entre | 1 error, con campo y número de fila |
| DUPLICADOS | que dos filas con la misma identidad sean una | 3 filas → 2 identidades |
| DESPROLIJO | separador coma, espacios, mayúsculas, `C.U.I.T.`, columna de más | se importa entero |
| CONTABLE | asiento descuadrado | no importa, y **no se cuadra solo** |
| STOCK | cantidad negativa vs. ilegible | `-3` es `-3`; «doce» es `null`, nunca `0` |
| GRANDE | 20.000 filas | mismo resultado, 20.000 identidades distintas |

El conjunto DESPROLIJO encontró un defecto real: `C.U.I.T.` normalizaba a
«c u i t» y no coincidía con ningún sinónimo, así que la columna del CUIT no se
mapeaba sola. Corregido: las siglas escritas con puntos vuelven a ser una
palabra, y «e mail» o «razon social» no se juntan porque el patrón exige que
todos los tramos sean de una letra.

---

## L · Qué encontró el trabajo de pruebas

Cinco defectos que ningún typecheck iba a mostrar, todos encontrados por tests
escritos después del código y todos corregidos:

1. **El validador no podía correr.** `validarMigracion` empieza borrando los
   hallazgos de la corrida anterior, y la 0111 le había revocado el `DELETE`.
   Una migración no se podía validar. → migración **0112**.
2. **Recargar un archivo destruía la prueba.** `cargarOrigen` borraba
   `migration_tables`, y la cascada se llevaba las filas crudas — la única
   manera que le quedaba a la aplicación de sacarlas. → se prohibió recargar; se
   hace una migración nueva.
3. **Revertir era imposible.** El `CHECK` de la base exige que una migración
   revertida diga cuándo, y el estado se escribía en un `UPDATE` y la fecha en el
   siguiente. Un `CHECK` se evalúa al cerrar cada sentencia. → estado y fecha en
   la misma sentencia, decidido por una tabla en un solo lugar.
4. **Un estado inalcanzable rompía el camino real.** La tabla de transiciones
   tenía `ANALIZADA` entre `CARGADA` y `MAPEADA`, y ningún código llegaba a ese
   estado: `CARGADA → MAPEADA`, que es la transición que sí ocurre, estaba
   prohibida. La primera migración real no pudo declarar su mapeo. → se quitó el
   estado y se agregó un control que exige que **todo estado declarado sea
   alcanzable desde el inicio**.
5. **Cargar un archivo no dejaba rastro.** El momento exacto en que un archivo
   ajeno entra a la empresa no quedaba en la bitácora encadenada. → migración
   **0113** y `recordAudit` con nombre, hash, bytes, tablas y filas.

Los cinco tienen en común que solo se ven **ejecutando**, y cuatro de los cinco
son de permisos o de restricciones de la base: exactamente lo que un test que
corre contra un estado que la producción no puede tener no mide.

---

## M · Qué se construyó

| Archivo | Renglones | Qué es |
|---|---|---|
| `packages/migration-engine/` | 1.222 | El motor **puro**: no abre conexiones, no escribe en la base, no lee el disco por su cuenta |
| `apps/api/src/migracion/ciclo.ts` | 700 | El ciclo contra la base |
| `apps/api/src/migracion/escritores.ts` | 201 | Los dos que saben escribir en NEXO |
| `apps/api/src/routes/migraciones.ts` | 380 | Ocho endpoints |
| `infrastructure/db/migrations/0111–0113` | 375 | Cinco tablas, RLS, permisos, vocabulario de bitácora |
| `apps/web/consola.html` | +330 | El asistente de seis pasos |
| Pruebas | 1.226 | 50 de motor, 13 de integración, 12 de seguridad (S-35) |
| `scripts/bench-migracion.mjs` | 150 | La medición de la tabla J |

La separación entre el paquete puro y `apps/api/src/migracion/` es la que
permite probar el motor entero sin base de datos, y es la que hace que agregar
un origen nuevo sea agregar un adaptador y nada más.

---

## N · Endpoints

| Método | Ruta | Permiso |
|---|---|---|
| GET | `/migraciones/fuentes` | `migration:read` |
| GET | `/migraciones` | `migration:read` |
| GET | `/migraciones/:id` | `migration:read` |
| GET | `/migraciones/:id/reporte` | `migration:read` |
| POST | `/migraciones` | `migration:write` |
| POST | `/migraciones/:id/origen` | `migration:write` |
| POST | `/migraciones/:id/mapeo` | `migration:write` |
| POST | `/migraciones/:id/validar` | `migration:write` |
| POST | `/migraciones/:id/importar` | **`migration:import`** |
| POST | `/migraciones/:id/revertir` | **`migration:import`** |

---

## O · Lo que este módulo **no** hace

Dicho acá para que no haga falta deducirlo:

- No se conecta a ningún sistema: hoy solo lee archivos.
- No importa asientos, comprobantes, stock, pagos ni el plan de cuentas.
- No procesa por tandas: una importación es una transacción.
- No reanuda una migración cortada: se revierte y se vuelve a empezar.
- No reemplaza el archivo de una migración ya cargada.
- No decide cuál de dos filas duplicadas vale: las reconoce como una y lo avisa.
- No cuadra un asiento descuadrado.
- No convierte monedas ni reexpresa por inflación.

---

## Ñ · Qué se corrió para poder afirmar todo esto

**Base reconstruida desde cero.** `node scripts/test-db.mjs --reset` borra la base
de pruebas y la levanta aplicando las 113 migraciones en orden. No se confía en
una base arrastrada: la del 2026-08-27 tenía filas que ninguna migración crea, y
eso ya escondió un defecto una vez.

**Sobre esa base, `npm run verify` completo:**

    Test Files  156 passed (156)
    Tests       2364 passed (2364)
    exit 0

Incluye typecheck, ESLint, el barrido de arquitectura, el de coma flotante, el
del archivo normativo, el del primer arranque, la verificación del Mayor, la
cadena de auditoría, los invariantes y la cobertura con su umbral.

**El asistente, ejercitado en el navegador contra el servidor real.** No hay
tests de navegación en este repositorio, así que un error de dibujo solo se ve
abriendo la consola — y se abrió. Cuenta nueva, empresa nueva, segundo factor
configurado, y el asistente recorrido entero el 2026-09-09:

| Paso | Qué mostró |
|---|---|
| Fuentes | los seis orígenes con su estado; **solo `ARCHIVO_GENERICO` en el selector** |
| Entidades | las nueve, con «Sí» en dos y el motivo en las otras siete |
| Crear | migración en `CREADA`, «Archivo: todavía ninguno» |
| Subir | 1 tabla, 3 filas, sin avisos |
| Mapeo propuesto | `RAZON SOCIAL→razonSocial`, **`C.U.I.T.→cuit`**, `E-MAIL→email`, `Condición IVA→condicionIva` |
| Validar | «0 no pueden entrar · 0 con reparos · 3 informativos — nada de esto tocó la empresa todavía» |
| Importar | «Terminó en COMPLETADA. PARTY: 3 importadas, 0 ya estaban, 0 rechazadas, de 3 en el origen» |
| Reporte | `3 = 3 + 0 + 0 + 0`, sin explicar 0, **cuadra** |
| Revertir | «3 archivadas», estado `REVERTIDA`, con fecha |

Sin un solo error de JavaScript en la consola del navegador.

---

## P · Veredicto

🟡 **Funciona de punta a punta para lo que declara, y declara menos de lo que un
motor «universal» sugiere.**

Lo verde: el camino completo —archivo, mapeo, vista previa, importación,
reconciliación, reversión— corre contra la base, con aislamiento entre empresas
comprobado, bitácora encadenada, idempotencia real y 75 pruebas.

Lo amarillo: escribe **dos** de nueve entidades, y su único origen implementado
es «un archivo». Las dos cosas están dichas en el código, en la API y en la
pantalla, que es lo que separa un alcance acotado de una promesa incumplida.
Para una empresa que llega con un CSV de clientes y otro de productos, esto es
un producto terminado. Para una que llega con diez años de asientos, todavía no.

Lo que lo movería a verde, en orden: el escritor de `ACCOUNT` y el de
`JOURNAL_ENTRY` con su reconciliación de saldos, y las tandas con puntos de
control para volúmenes grandes.
