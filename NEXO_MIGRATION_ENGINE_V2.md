# NEXO — Migration Engine V2

**Fecha de la medición:** 2026-09-09
**Punto de partida:** el V1, que importaba terceros y productos desde un archivo,
en una sola transacción, sin progreso ni reanudación.
**Cómo leer este documento:** todo lo que dice «está» se midió corriendo el
código el día de la fecha. Lo que falta se dice con nombre propio y con el
motivo. Lo que se rompía y se arregló también.

---

## A · Estado general

🟡 **Migra una empresa completa desde archivos estructurados, y no se conecta a
ningún sistema.**

Las dos mitades de esa frase importan igual. Lo primero es real y está probado:
maestros, stock, comprobantes de venta y de compra, pagos y contabilidad
histórica entran a una empresa, quedan relacionados entre sí, reconcilian contra
lo que el origen declaraba, no se duplican al repetir y se pueden deshacer. Lo
segundo también es real: **el único origen implementado sigue siendo un
archivo**. Un CSV exportado de Tango se migra hoy; «NEXO se conecta con Tango»
sería falso.

## B · Entidades implementadas

Diez de once. Cada una escribe en la tabla que le corresponde y está ejercitada
por el E2E de empresa completa.

| Entidad | Dónde escribe | Qué hay que saber |
|---|---|---|
| `PARTY` | `parties` + `party_roles` | Reconoce por CUIT lo cargado a mano antes de migrar |
| `PRODUCT` | `products` | **Se arregló: nunca había funcionado** (ver §L) |
| `WAREHOUSE` | `warehouses` | Nuevo |
| `ACCOUNT` | `accounts` | Arma la jerarquía; ordena padres antes que hijos |
| `STOCK_BALANCE` | `stock_movements` | Entrada a la fecha de corte, no un ajuste |
| `STOCK_MOVEMENT` | `stock_movements` | Histórico con `origen_tipo = MIGRACION` |
| `SALES_DOCUMENT` | `tax_transactions` + renglones | **No pide CAE**; constatación `NO_CONSULTADO` |
| `PURCHASE_DOCUMENT` | `tax_transactions` + renglones | Igual |
| `JOURNAL_ENTRY` | `journal_entries` + renglones | Entra **PROPUESTO**, no llega al Mayor |
| `PAYMENT` | `payment_orders` + renglones | Entra en BORRADOR, imputa si el comprobante está |

## C · Entidades preparadas

Ninguna en ese estado intermedio: o se escriben o está dicho por qué no.

## D · Entidades bloqueadas

| Entidad | Estado | Por qué |
|---|---|---|
| `COLLECTION` | **BLOQUEADA por el modelo, no por falta de trabajo** | Una cobranza en NEXO es una imputación contra un renglón del Mayor: `party_allocations` exige el `journal_entry_line_id` que la cancela. Un archivo de otro sistema no trae ese renglón, y elegirlo por parecido decidiría contra qué factura se aplicó cada peso. Se destraba cuando la contabilidad migrada está **aprobada**: ahí la imputación se hace desde «Imputaciones» con los renglones a la vista. |

## E · Fuentes soportadas

Una: **archivo**. CSV, TSV, TXT, XLSX, XLS, JSON, XML y ZIP con varios adentro.
El ZIP es lo que hace posible migrar una empresa entera de una vez: diez
archivos, diez entidades.

## F · Adapters implementados

`ARCHIVO_GENERICO`, y nada más. Sin cambios respecto del V1.

## G · Adapters preparados y bloqueados

Sin cambios respecto del V1, y por los mismos motivos:

| Código | Estado | Qué falta |
|---|---|---|
| `BASE_DE_DATOS` | PREPARADO | El mapa de esquema del sistema de origen. Sin eso solo quedaría aceptar SQL escrito desde el navegador, que la regla de seguridad prohíbe. |
| `API_REST` | PREPARADO | Una credencial contra un servicio real: la paginación y los errores parciales se ejercitan, no se leen. |
| `TANGO` | PLANIFICADO | Una exportación real. **Un archivo de Tango se migra hoy con el genérico**; falta el reconocimiento automático, no la capacidad. |
| `BANCO_OFX` | PLANIFICADO | Escribir el lector. No depende de nadie. |
| `COMERCIO_API` | BLOQUEADO | Cuenta de desarrollador y OAuth2 en cada plataforma. |

**No se agregó ningún adapter nuevo, y es deliberado:** los cinco están
bloqueados por dependencias externas o por información que no tengo, y escribir
un `TangoMigrationAdapter` sin una exportación de Tango delante sería inventar
la estructura de un sistema ajeno.

## H · Modelo canónico

Once entidades (nueve del V1 más `WAREHOUSE` y `COLLECTION`). Los comprobantes
ganaron los campos del **renglón** —`sku`, `cantidad`, `precioUnitario`,
`netoRenglon`, `ivaRenglon`— porque una exportación de ventas trae una fila por
renglón con el número repetido, no una por comprobante.

Los campos ya no están duplicados en la consola: `GET /migraciones/fuentes` los
sirve desde `FORMAS`. La copia que tenía la pantalla **ya había divergido**
—decía `padre` donde el modelo dice `codigoPadre`— y ofrecía campos que el
importador ignoraba en silencio.

## I · Mapping

Se propone solo y se corrige a mano. Dos defectos del adivinador, encontrados
abriendo la pantalla y mirando la propuesta:

1. Un archivo de depósitos entraba como **terceros**: `PARTY` solo exige razón
   social y «Nombre» es sinónimo de eso, así que «cubría sus obligatorios» y
   ganaba por tener más opcionales reconocidos. Ahora gana la entidad que
   reconoce más obligatorios **por su nombre exacto**.
2. La columna «IVA» de una venta se mapeaba a `condicionIva` —que tiene «iva»
   entre sus sinónimos— y el comprobante entraba sin impuesto. Ahora el nombre
   exacto del campo le gana al sinónimo de otro.

Con un repaso final: si un obligatorio quedó sin mapear y alguna columna
asignada a un campo opcional también servía, se la lleva ahí. Es lo que hace que
«SKU / Descripción / Precio» siga reconociéndose como productos.

Medido sobre las siete hojas de la empresa de prueba: **las siete se reconocen
solas, con su campo distintivo mapeado**.

## J · Validación

Sin cambios de fondo y con un arreglo de fondo: **hacía un viaje a la base por
fila**. Validar 5.000 terceros tardaba once segundos, y no por la validación
—que es aritmética en memoria— sino por diez mil idas y vueltas. Agrupadas de a
quinientas, los mismos 5.000 tardan 406 ms. Es 27 veces más rápido escribiendo
exactamente lo mismo.

## K · Importación

Por tandas de 250 registros, en el **orden de dependencia** de las entidades:
depósitos y cuentas, después terceros y productos, después stock, comprobantes,
asientos y pagos. Importar en el orden en que las hojas aparecen en el archivo
hacía fallar la mitad de las filas por un motivo que no era de los datos.

Un rechazo de un escritor —«esta factura cita un proveedor que no está»— no
aborta nada: marca el grupo, guarda el motivo y sigue. Se distingue de un error
de verdad con un tipo propio, `NoSePuedeEscribir`, y un punto de guardado por
grupo.

## L · Tandas y M · Puntos de control

`migration_batches` guarda, por tanda: el rango, cuántas filas, en qué estado,
qué escribió, cuántos intentos, cuándo empezó y terminó, el error si lo hubo, y
el **hash de las claves del rango** —reanudar sobre un archivo distinto no es
reanudar, y así es comprobable.

El plan se escribe **antes** de importar nada: es lo que permite decir «12.400 de
50.000» desde la primera tanda en vez de descubrir el total al final.

Las entidades que agrupan —asientos, comprobantes— se ordenan por su clave y las
tandas se cortan **solo donde la clave cambia**: una tanda que partiera un
asiento por la mitad escribiría medio asiento.

**La contrapartida, dicha sin disimulo:** cada tanda es su propia transacción, y
una importación cortada a la mitad **deja la mitad escrita**. No es un defecto
disimulado, es la elección entre «todo o nada, sin saber cuánto faltaba» y «lo
que entró, dicho e identificado». Lo escrito está en `migration_links` y se
puede reanudar o revertir.

## N · Idempotencia

`UNIQUE (company_id, identidad)` sobre `migration_links`, como en el V1.
Reanudar no es un camino aparte: es volver a llamar a importar, y las tandas
completadas se saltean por su punto de control mientras las filas que igual se
repitieran chocan contra el UNIQUE. Dos candados para lo mismo.

Medido con la empresa completa: segunda corrida del mismo ZIP → **0 importadas,
todo reconocido, censo de filas idéntico en las diez tablas de destino**.
Medido con 50.000 terceros: **0 importados, 50.000 ya estaban**.

## O · Rollback

Cada tabla se deshace como esa tabla se deshace, y en orden inverso al de
importación —compensar un movimiento de stock exige que el producto siga activo,
así que los maestros se archivan **después**—:

| Tabla | Cómo | Medido |
|---|---|---|
| `parties`, `products`, `warehouses` | archivar | 3, 2, 2 |
| `accounts` | archivar | 6 |
| `journal_entries` | anular (siguen PROPUESTOS: no tocaron el Mayor) | 2 |
| `payment_orders` | anular con motivo | 1 |
| `stock_movements` | **movimiento inverso** | 5 |
| `tax_transactions` | **no se deshace** | 3, informados |

El stock se compensa en vez de borrarse porque el libro solo crece, igual que el
Mayor. Medido: la existencia vuelve a cero y el libro tiene **el doble** de
movimientos, no la mitad.

Un comprobante fiscal registrado es parte del registro de la empresa: la tabla no
tiene estado de anulación y un trigger impide borrarla. La reversión los cuenta y
dice cuáles son, con el motivo. Eso está **antes** de importar, en la pantalla.

## P · Reconciliación

Tres, y las tres calculadas:

1. **Por filas** — todo lo que trajo el origen terminó en alguna parte:
   `enOrigen = importadas + ya estaban + rechazadas + omitidas`.
2. **De stock** — la existencia que el archivo declaraba, contra la que quedó en
   NEXO **a la fecha de corte**. Es la parte que se puede hacer mal sin que se
   note: si además se migraron los movimientos posteriores, la existencia de hoy
   no tiene por qué coincidir, y compararla marcaría una diferencia donde no la
   hay. Solo lista los productos cuya existencia el origen declaró.
3. **Contable** — cantidad de asientos, debe y haber, del archivo contra lo
   asentado, en centavos y con enteros.

Medido en el E2E: las tres en cero.

## Q · Auditoría

Ocho acciones declaradas en `audit_actions`, con clave foránea: una acción sin
declarar no se anota mal, aborta la operación. `CANCELAR_MIGRACION` y
`REVERTIR_MIGRACION` exigen motivo — son las dos que dejan la empresa distinta de
como habría quedado sola.

## R · RLS

Las **seis** tablas del módulo con RLS forzado y una política cada una, medido
sobre el catálogo de PostgreSQL:

    migrations · migration_tables · migration_rows
    migration_findings · migration_links · migration_batches

Permisos reales del rol de la aplicación:

    migration_findings   DELETE,INSERT,SELECT,UPDATE
    las otras cinco      INSERT,SELECT,UPDATE

`migration_findings` es la única con `DELETE`: los hallazgos son derivados y se
recalculan en cada validación. Las otras cinco guardan prueba de lo que el origen
tenía o el estado de un proceso.

Comprobado desde la otra empresa: **cero** en las nueve tablas que el E2E mira,
incluidas las tandas.

## S · Seguridad

Lo del V1 sigue en pie y se le agregó lo del V2:

- Ninguna sentencia del módulo interpola algo que no sea una constante del
  propio archivo — comprobado con un barrido estático, no con cargas hostiles.
- La reversión elige la tabla por una lista blanca de siete formas escritas en
  el código, nunca por el texto de una fila.
- Los tipos de comprobante salen del catálogo `arca_comprobante_types`, no de
  texto libre: el tipo decide en qué columna del libro de IVA cae el
  comprobante.
- El módulo **no abre ningún archivo**: no hay `node:fs` en `apps/api/src/migracion/`.
- Tres permisos separados; `AUDITOR` mira y no puede crear, importar ni revertir.

## T · UI

El asistente creció a: fuentes → crear → subir → mapeo propuesto → validar →
**importar con barra de progreso, cancelar y reanudar** → reporte con las tres
reconciliaciones → revertir.

Un defecto encontrado en el navegador: apretar «Subir» antes de que terminara de
crearse la migración mandaba el pedido a `/migraciones/undefined/origen` y la
pantalla mostraba «id: No es un identificador válido», un mensaje sobre un campo
que nadie escribió. Los seis botones del asistente ahora comprueban que haya una
migración abierta. Ninguna de las pruebas que leen el HTML podía verlo: el HTML
estaba bien, lo que faltaba era el estado.

## U · API

Doce rutas. Las tres nuevas: `POST /migraciones/:id/cancelar`,
`GET /migraciones/:id/progreso`, y `POST /migraciones/:id/importar` que ahora
acepta `topeDeTandas` y se puede volver a llamar para reanudar.

## V · Tests

| Suite | Qué prueba | Cantidad |
|---|---|---|
| `packages/migration-engine` | El motor puro y los ocho conjuntos de datos | 52 |
| `tests/integration/migracion` | El ciclo, la idempotencia, la inmutabilidad, RLS | 13 |
| `tests/integration/migracion-empresa-completa` | El E2E del §49 | 17 |
| `tests/integration/migracion-tandas` | Plan, reanudación, cancelación, retomar | 7 |
| `tests/integration/migracion-rechazos` | Qué rechaza y con qué palabras | 11 |
| `tests/security/migraciones` (S-35) | Aislamiento, permisos, SQL, archivos, bitácora | 12 |

**112 pruebas del módulo.** El total del repositorio pasó de 2.364 a 2.399.

## W · E2E

Una empresa entera en un ZIP de diez archivos que se citan entre sí, con los
defectos que traen los archivos reales: separadores distintos, importes con
miles, fechas dd/mm/aaaa, `C.U.I.T.` con puntos, un plan de cuentas desordenado y
los renglones de un asiento salteados.

Comprueba las cinco cosas que hacen creíble una migración: que los datos entren
**relacionados**, que los números **cuadren**, que repetirla **no duplique**, que
se pueda **deshacer** y que la empresa de al lado **no vea nada**.

Además, el asistente recorrido a mano en el navegador contra el servidor real:
cuenta nueva, empresa, segundo factor, ejercicio con sus doce períodos, ZIP de
seis hojas —las seis reconocidas solas—, mapeo, validación, importación con la
barra llegando a `12 de 12 · 100,0% · tanda 6 de 6`, y el reporte con las dos
reconciliaciones en cero. Sin un solo error de JavaScript.

## X · Clean DB

`node scripts/test-db.mjs --reset` borra la base y la levanta aplicando las
**114** migraciones en orden. Sobre esa base, `npm run verify` completo:

    Test Files  159 passed (159)
    Tests       2401 passed (2401)
    exit 0

Incluye typecheck, ESLint, el barrido de arquitectura, el de coma flotante, el
del archivo normativo, el del primer arranque, la verificación del Mayor, la
cadena de auditoría, los invariantes y la cobertura con su umbral.

No se confía en una base arrastrada, y esta vez tuvo consecuencias: la
reconstrucción a las 22:07 destapó el defecto del huso horario en la siembra de
precios (§9 de los defectos), que sobre una base previa habría seguido
escondido.

## Y · Rendimiento

Medido con `npm run bench:migracion`, PostgreSQL 18.6 local, terceros:

| Filas | Leer y guardar | Validar | Importar | Repetir | Tandas | filas/s |
|---:|---:|---:|---:|---:|---:|---:|
| 1.000 | 153 ms | 88 ms | 1.735 ms | 374 ms | 4 | 576 |
| 10.000 | 507 ms | 987 ms | 21.938 ms | 5.219 ms | 40 | 456 |
| 50.000 | 2.904 ms | 11.978 ms | 134.631 ms | 68.953 ms | 200 | 371 |

**50.000 filas entran en 2 minutos y 15 segundos, en 200 tandas, con progreso
visible y reanudación.** El V1 no podía hacerlo: eran dos minutos de transacción
abierta sin nada que mostrar y sin nada que reanudar si se cortaba.

Lo que sigue costando: ~370 filas por segundo, porque cada registro son varias
idas y vueltas a la base —buscar el vínculo, buscar el existente, el punto de
guardado, el INSERT, el vínculo, la marca—. Se bajaron dos de esas por fila
precargando por tanda; las que quedan son las escrituras. **No se cambió el
punto de guardado por grupo para ganar velocidad**: es lo que hace que un
rechazo no arrastre a la tanda entera.

Memoria: 380 MB con 50.000 filas. El archivo se lee entero en memoria, y ese es
el límite de arriba junto con el tope de 25 MB de subida y las 200.000 filas del
adaptador.

**No se midió 100.000.** El entorno lo aguanta —serían unos 4 minutos y medio y
~700 MB— pero medir lo que no se corrió es exactamente lo que este documento no
hace.

## Z · Blockers externos

Los mismos cinco del V1, ninguno nuevo, ninguno resuelto: los cuatro adaptadores
que dependen de una credencial, un esquema o un trámite, y las cobranzas, que
dependen de una decisión del dominio y no de nadie de afuera.

## AA · Riesgos restantes

1. **Una importación interrumpida deja la mitad escrita.** Es la contrapartida
   elegida de tener puntos de control. Mitigado: está identificado y se puede
   reanudar o revertir. Sin mitigar: nadie avisa automáticamente que quedó a
   medias — la pantalla lo muestra al abrir la migración, pero hay que abrirla.
2. **Los comprobantes fiscales no se revierten.** Correcto, y hay que decirlo
   antes: si alguien migra el archivo equivocado, esa parte queda.
3. **Los asientos entran PROPUESTOS.** Es lo seguro, y significa que la
   contabilidad migrada **no está en el Mayor** hasta que alguien la apruebe. Un
   balance sacado el día después de migrar no la va a incluir.
4. **~370 filas/s.** Una empresa con 200.000 comprobantes son quince minutos.
   Funciona; no es instantáneo.
5. **El archivo entero en memoria.** 380 MB con 50.000 filas.

## AB · Próximos pasos

En orden de lo que más mueve la aguja:

1. **Cobranzas**, una vez que la contabilidad migrada se apruebe: es la única
   entidad que falta y la que cierra el circuito de la cuenta corriente.
2. **Bajar las idas y vueltas por fila** con escritura por lotes en los
   escritores que no dependen de la fila anterior (terceros, productos).
3. **Lectura por streaming** del archivo, para sacar el límite de memoria.
4. **Un aviso** cuando una migración queda a medias, en la bandeja de pendientes.
5. Los adaptadores, cuando aparezcan las credenciales y las exportaciones reales.

---

## Métricas: antes y después

| | V1 | V2 | |
|---|---:|---:|---|
| Migraciones de base | 113 | **114** | 0114 |
| Tablas del módulo | 5 | **6** | `migration_batches` |
| Endpoints | 8 | **12** | cancelar, progreso, reanudar |
| Entidades canónicas | 9 | **11** | `WAREHOUSE`, `COLLECTION` |
| Entidades que se escriben | 2 | **10** | y una de las 2 no funcionaba |
| Adaptadores implementados | 1 | **1** | sin cambios, y es honesto |
| Pruebas del módulo | 75 | **112** | |
| Pruebas del repositorio | 2.364 | **2.401** | todas verdes sobre base limpia |
| Renglones del módulo | ~4.900 | **~9.900** | |
| Pantallas | 1 | **1** | el mismo asistente, con tres pasos más |

## Limpieza de los datos de desarrollo

La auditoría del V1 dejó una empresa de benchmark y una cuenta descartable; este
trabajo dejó nueve empresas más y tres cuentas. Verificado antes de tocar nada:
**ningún test, fixture, seed ni benchmark depende de esos datos** —el script de
benchmark crea su propia empresa en cada corrida, así que es reproducible sin
ellos—.

Hecho: las cuatro cuentas de prueba quedaron `DISABLED`. Tenían contraseña
conocida y eso es higiene, no cosmética.

No hecho: **borrar las trece empresas y sus 96.000 terceros**. Es la base de
desarrollo de otra persona y borrar filas ahí no es una decisión mía. Queda
`npm run limpiar:pruebas`, que sin argumentos **solo lista** lo que encontraría
y con `-- --hacelo` lo borra. Es el único lugar del repositorio que desactiva
los triggers de borrado, corre solo a pedido, solo sobre empresas cuyo nombre
las delata, y se niega a correr contra la base de pruebas.

---

## Los defectos que este trabajo encontró

Nueve, todos reales, todos corregidos. Siete son del motor de migración —cinco
de ellos del V1, y **dos hacían que el V1 no funcionara como decía**— y dos
aparecieron de rebote, sin relación con migraciones.

### Del motor

1. **El escritor de productos nunca funcionó.** `products.tax_treatment` vale
   `GRAVADO` por omisión y un CHECK exige que un producto gravado diga contra
   qué impuesto; el escritor no lo mandaba. Ningún producto se podía importar, y
   no se veía porque **ninguna prueba importaba productos**. El V1 declaraba dos
   entidades escribibles y tenía una.
2. **Toda identidad compuesta abortaba la importación.** `claveDeIdentidad` unía
   sus partes con el byte cero, que PostgreSQL no admite en una columna `text`.
   No se notaba porque las dos entidades del V1 tenían identidad de un solo
   campo. La primera existencia de stock —SKU más depósito— rompía la corrida
   entera con un error de codificación.
3. **La validación hacía un viaje a la base por fila.** Once segundos para
   5.000 filas; 406 ms agrupada.
4. **La reversión archivaba los maestros antes de compensar el stock**, y el
   libro rechaza un movimiento sobre un producto archivado. La reversión de una
   empresa con stock fallaba entera.
5. **`CANCELADA` no fechaba**, como le había pasado a `REVERTIDA` en el V1: el
   mismo CHECK, el mismo error, el mismo día.
6. **El adivinador de entidades tomaba un archivo de depósitos por terceros** y
   **la columna «IVA» de una venta por la condición frente al IVA**, dejando el
   comprobante sin impuesto.
7. **La consola pedía `/migraciones/undefined/origen`** si se apretaba «Subir»
   antes de tiempo.

Los defectos 1, 2 y 4 tienen algo en común y vale la pena decirlo: **los tres
son de escritura contra la base, y los tres estaban tapados porque el V1 nunca
escribió lo suficiente para tocarlos**. Un motor que declara nueve entidades y
ejercita dos no está probado al 22 %: está probado en los dos caminos que no
tenían las trampas.

### De rebote, y no son de migraciones

La corrida final de `verify` —a las 22:07— dejó tres pruebas en rojo que no
tenían nada que ver con este trabajo. Las dos causas:

8. **Los planes se quedan sin precio después de las nueve de la noche.**
   `sembrar-comercial-b1.mjs` calculaba «hoy» con `getUTCDate()`. En Argentina
   —UTC menos tres— a las 22:07 eso ya es mañana, así que los cinco precios
   quedaron con `vigente_desde` en el día siguiente y la consulta del catálogo
   —que compara contra `CURRENT_DATE`— no encontró ninguno. **Es un defecto de
   producto, no de la prueba**: el operador que declare un precio después de las
   nueve de la noche se lo va a encontrar vigente recién al día siguiente. Ahora
   la fecha se la pregunta a la base, que es la que después compara.
9. **Una prueba de la prueba de catorce días dependía de la hora.** Mismo huso,
   mismo error, del lado del test: restaba días en UTC y `dias_restantes` los
   cuenta contra `CURRENT_DATE`. Un control que falla según la hora a la que se
   corre no está midiendo lo que dice medir.

Y cuatro controles que ya existían atajaron trabajo mío antes de que llegara a
ningún lado: el de coma flotante marcó un cálculo de porcentaje escrito como se
escribe el redondeo de un importe; el de tablas sin escritor me hizo sacar una
escritura a `journals` que le habría agregado a cada empresa los libros que
trajera el archivo; el del vocabulario de la bitácora exigió declarar
`CANCELAR_MIGRACION`; y el de capacidades sin puerta encontró un endpoint de
progreso que ninguna pantalla llamaba.

---

## La frase honesta

> NEXO tiene un sistema de migración empresarial capaz de trasladar maestros,
> operaciones, stock y contabilidad histórica **desde archivos estructurados**,
> con mapeo asistido, validación, vista previa, importación por tandas con
> progreso y reanudación, reconciliación de filas, de existencias y de partida
> doble, trazabilidad fila a fila, idempotencia y reversión.
>
> La arquitectura admite orígenes nuevos agregando un adaptador, sin tocar el
> núcleo. **Hoy hay uno solo implementado, y es «un archivo».**
