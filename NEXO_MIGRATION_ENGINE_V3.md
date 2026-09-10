# NEXO — Migration Engine V3 · Estado final

**Fecha:** 2026-09-10
**Qué es esta fase:** no expandir el motor, sino **endurecerlo, auditarlo y
cerrarlo**. La consigna era encontrar lo que todavía no se había visto fallar.
**Documentación técnica:** [`docs/MIGRACION.md`](docs/MIGRACION.md) — cómo
funciona y cómo se le agrega un adaptador.

---

## 1 · Estado general

**`CLOSED`**

Con una condición que hay que leer junto al veredicto: cerrado quiere decir
*terminado para lo que declara*, y lo que declara es **migrar una empresa desde
archivos estructurados**. No se conecta a ningún sistema. Esa frase no es una
limitación pendiente de resolver: es el alcance.

## 2 · Entidades implementadas

Diez, todas ejercitadas por el E2E de empresa completa:

`PARTY` · `PRODUCT` · `WAREHOUSE` · `ACCOUNT` · `STOCK_BALANCE` ·
`STOCK_MOVEMENT` · `SALES_DOCUMENT` · `PURCHASE_DOCUMENT` · `JOURNAL_ENTRY` ·
`PAYMENT`

## 3 · Fuentes implementadas

Una: **`ARCHIVO_GENERICO`**. Formatos, todos con una prueba que los pasa por el
adaptador y compara la tabla resultante:

| Formato | Estado |
|---|---|
| CSV / TSV / TXT | `IMPLEMENTED + VERIFIED` |
| XLSX / XLS | `IMPLEMENTED + VERIFIED` |
| JSON | `IMPLEMENTED + VERIFIED` |
| XML | `IMPLEMENTED + VERIFIED` |
| ZIP con varias hojas | `IMPLEMENTED + VERIFIED` |

## 4 · Fuentes preparadas

| Código | Estado | Qué falta |
|---|---|---|
| `BASE_DE_DATOS` | `PREPARED` | El mapa de esquema del sistema de origen. Sin eso solo quedaría aceptar SQL escrito desde el navegador, que la regla de seguridad prohíbe |
| `API_REST` | `PREPARED` | Una credencial contra un servicio real: la paginación y los errores parciales se ejercitan, no se leen |

## 5 · Fuentes no soportadas

| Código | Estado | Por qué |
|---|---|---|
| `TANGO` | `PLANNED` | Falta una exportación real. **Un archivo de Tango se migra hoy con el genérico**: lo que falta es el reconocimiento automático de sus columnas, no la capacidad |
| `BANCO_OFX` | `PLANNED` | Escribir el lector. No depende de nadie |
| `COMERCIO_API` | `BLOCKED` | Cuenta de desarrollador y OAuth2 en cada plataforma |
| SAP · Bejerman · Xubio · Colppy · Odoo · Dynamics | **no existen** | No hay adaptador, ni siquiera declarado. Nombrarlos en una matriz sería inventarlos |

## 6 · Funcionalidades

| | Estado |
|---|---|
| Upload | `IMPLEMENTED + VERIFIED` |
| Mapping automático y manual | `IMPLEMENTED + VERIFIED` |
| Validación | `IMPLEMENTED + VERIFIED` |
| Vista previa | `IMPLEMENTED + VERIFIED` |
| Tandas | `IMPLEMENTED + VERIFIED` |
| Puntos de control | `IMPLEMENTED + VERIFIED` |
| Reanudación | `IMPLEMENTED + VERIFIED` |
| Cancelación | `IMPLEMENTED + VERIFIED` |
| Importación | `IMPLEMENTED + VERIFIED` |
| Reconciliación (filas, stock, partida doble) | `IMPLEMENTED + VERIFIED`, **las tres vistas fallar** |
| Reversión | `IMPLEMENTED + VERIFIED` |
| Auditoría | `IMPLEMENTED + VERIFIED` |
| Candado contra corridas simultáneas | `IMPLEMENTED + VERIFIED` — nuevo en V3 |

## 7 · Seguridad

| | Estado |
|---|---|
| RLS forzado en las 6 tablas del módulo | `VERIFIED` — leído del catálogo de PostgreSQL |
| Tres permisos separados | `VERIFIED` — `AUDITOR` mira y no puede crear, importar ni revertir |
| Cross-company | `VERIFIED` — 404 y no 403; dos empresas migrando a la vez con las mismas identidades |
| Nunca SQL desde el navegador | `VERIFIED` — barrido estático sobre las sentencias del módulo |
| Archivos | `VERIFIED` — 20 controles: vacío, corrupto, extensión mentirosa, ZIP malformado, travesía de directorios, BOM, columnas duplicadas |
| Secretos | No hay: el módulo no guarda credenciales de ningún origen |

## 8 · Tests

| Suite | Tests |
|---|---|
| `packages/migration-engine` (motor + 8 conjuntos de datos) | 52 |
| `tests/integration/migracion` | 13 |
| `tests/integration/migracion-empresa-completa` | 17 |
| `tests/integration/migracion-tandas` | 7 |
| `tests/integration/migracion-rechazos` | 11 |
| `tests/integration/migracion-auditoria` **(nuevo en V3)** | 14 |
| `tests/security/migraciones` (S-35) | 18 |
| `tests/security/migracion-archivos` (S-36) **(nuevo en V3)** | 20 |
| `tests/security/fechas-en-hora-argentina` (S-37) **(nuevo en V3)** | 3 |
| **Del módulo** | **155** |
| **Del repositorio** | **2.444** en 162 archivos |

## 9 · E2E

Dos, y hacen falta los dos.

**El automático** (`migracion-empresa-completa`): un ZIP de diez archivos que se
citan entre sí, con los defectos de un archivo real —separadores distintos,
importes con miles, `C.U.I.T.` con puntos, plan de cuentas desordenado, renglones
de un asiento salteados—. Comprueba que los datos entren **relacionados**, que
los números **cuadren**, que repetir **no duplique**, que se pueda **deshacer** y
que la empresa de al lado **no vea nada**.

**El manual, en el navegador**, sobre base limpia y servidor real: cuenta nueva
→ empresa → segundo factor → ejercicio con doce períodos → ZIP de siete hojas
→ **las siete reconocidas solas** → mapeo → validación → importación con la barra
llegando a `14 de 14 · 100,0% · tanda 7 de 7` → reporte con las tres
reconciliaciones. Sin ningún `/undefined` y sin un solo error de JavaScript.

Ese recorrido encontró el defecto n.º 9 de la lista de abajo.

## 10 · Clean DB

`node scripts/test-db.mjs --reset` borra la base y aplica las **115**
migraciones en orden. Sobre esa base, `npm run verify` completo:

    Test Files  162 passed (162)
    Tests       2444 passed (2444)
    exit 0

Incluye typecheck, ESLint, el barrido de arquitectura, el de coma flotante, el
del archivo normativo, el del primer arranque, la verificación del Mayor, la
cadena de auditoría, los invariantes y la cobertura con su umbral.

Se corrió **dos veces desde cero** durante esta fase, con el borrado de los
datos de desarrollo en el medio. La segunda es la de arriba.

## 11 · Performance

Medido con `npm run bench:migracion`, PostgreSQL 18.6 local:

| Filas | Leer y guardar | Validar | Importar | Repetir | Tandas | filas/s |
|---:|---:|---:|---:|---:|---:|---:|
| 1.000 | 85 ms | 85 ms | 1.465 ms | 364 ms | 4 | 682 |
| 10.000 | 548 ms | 1.040 ms | 25.063 ms | 4.597 ms | 40 | 399 |
| 50.000 | 2.749 ms | 12.365 ms | 118.433 ms | 66.459 ms | 200 | 422 |

**50.000 filas entran en 1 minuto y 58 segundos, en 200 tandas, con progreso
visible y reanudación.** Los tres volúmenes cerraron con reconciliación en cero,
y la segunda corrida de cada uno importó **cero** y reconoció todo.

El candado que se agregó en V3 no cambió el ritmo: 422 filas/s contra 371 de la
medición anterior, dentro de la variación normal entre corridas. Es una
sentencia por tanda, no por fila.

**No se midió 100.000.** El entorno lo aguantaría —serían unos 4 minutos y
~700 MB— pero informar lo que no se corrió es exactamente lo que este documento
no hace.

Memoria: 384 MB con 50.000 filas. El archivo se lee entero.

## 12 · Defectos encontrados en V3

Nueve. Ninguno se buscó leyendo código: los nueve salieron de intentar romper
algo que hasta entonces solo se había probado funcionando.

1. **Las tres reconciliaciones nunca se habían visto fallar.** Solo se habían
   probado dando cero, que es lo mismo que no haberlas probado.
2. **Dos importaciones simultáneas de la misma migración se pisaban.** Los datos
   no se duplicaban —lo frena el `UNIQUE`— pero la segunda moría con un 23505
   que abortaba su tanda, y el usuario recibía un error sobre la máquina de
   estados que no describía lo que había pasado.
3. **Importar algo ya terminado contestaba «una migración en COMPLETADA no puede
   pasar a IMPORTANDO».** Describe el autómata, no la situación. Es reachable
   con un doble clic.
4. **`migration_batches` no podía quedar nunca en `FALLIDA` ni guardar su
   error.** El `UPDATE` que marcaba el fallo vivía dentro de la transacción que
   se estaba abortando, así que se iba con ella. Medido sobre 750 tandas reales:
   ninguna con error, ninguna con más de un intento, y un `CHECK` que exigía
   motivo para un estado que nadie podía escribir.
5. **Un XML de un solo registro desaparecía en silencio**: cero tablas y cero
   avisos. El archivo entraba, no pasaba nada, y nadie sabía por qué.
6. **`facturacion-ciclo.mjs` calculaba «hoy» en UTC.** Un ciclo corrido después
   de las nueve de la noche del 31 se creía en el 1 del mes siguiente: habría
   emitido el período equivocado y adelantado un mes de cobranza. **No es del
   motor de migración**; lo encontró el control que se escribió para el defecto
   gemelo de los precios.
7. **La lista de excepciones del control de UTC ya tenía una que sobraba**
   (`arca-check.mjs`), que es una puerta abierta que nadie recuerda haber
   dejado.
8. **El script de limpieza dejó 384.918 filas huérfanas.**
   `session_replication_role = replica` apaga los triggers **y también las claves
   foráneas**, así que la cascada no corrió y borrar la empresa fue borrar solo
   la cabecera. Lo cometí yo en esta misma fase, al ejecutar la limpieza que
   pedía §29. Y el arreglo tuvo su propia segunda vuelta: el candado que agregué
   —«no confirmes si queda una sola fila colgando»— **se negó a correr la
   siguiente limpieza** porque a la lista todavía le faltaban tres tablas
   (`user_company_roles`, `company_subscriptions` y `audit_logs`). Funcionó
   exactamente como tenía que funcionar: no borró nada y dijo qué faltaba.
9. **La pantalla decía «la migración cuadra» con dos filas rechazadas.**
   Cuadrar quiere decir que ninguna fila se perdió; una migración con cien filas
   rechazadas cuadra perfectamente. Confundir las dos cosas es la forma más fácil
   de que alguien crea que migró algo que no migró.

## 13 · Defectos corregidos

Los nueve.

| # | Cómo |
|---|---|
| 1 | Tres pruebas que rompen cada reconciliación a propósito: un ajuste anterior al corte, un vínculo roto, una fila devuelta a PENDIENTE |
| 2 | Migración **0115**: candado en `migrations.importando_desde`, renovado al cerrar cada tanda y vencido solo a los quince minutos |
| 3 | Un mensaje que dice qué pasó: «esta migración ya terminó en X y no se vuelve a importar» |
| 4 | El fallo se registra **en otra transacción**: estado, motivo e intento |
| 5 | Cuando ningún elemento se repite se toma el hijo de la raíz que tiene hijos; y un archivo sin tablas reconocibles lo dice |
| 6 | La fecha se la pregunta a la base (`SELECT CURRENT_DATE`), que es la que después compara |
| 7 | Excepción eliminada; el control ahora también comprueba que la lista no acumule |
| 8 | El script borra **de la hoja a la raíz**, tabla por tabla —26, incluida la bitácora, cuya cadena de hashes es por empresa y por eso se puede— y no confirma nada si quedó una sola fila huérfana |
| 9 | El reporte distingue «entró todo y cuadra» de «N filas no entraron: ninguna se perdió, pero no están en la empresa» |

Y **tres controles que ya existían** atajaron trabajo de esta fase antes de que
llegara a ningún lado: el de documentación veraz encontró un enlace a un archivo
que todavía no existía; el de coma flotante ya había marcado un cálculo de
porcentaje en V2; el de capacidades sin puerta, un endpoint que ninguna pantalla
llamaba.

## 14 · Riesgos restantes

1. **Una importación interrumpida deja la mitad escrita.** Es la contrapartida
   elegida de tener puntos de control. Mitigado: está identificada, se puede
   reanudar o revertir, y la pantalla lo muestra al abrir la migración. Sin
   mitigar: nadie avisa solo — hay que abrirla.
2. **Los comprobantes fiscales no se revierten.** Correcto —son parte del
   registro de la empresa— y hay que decirlo antes de importar.
3. **Los asientos entran PROPUESTOS.** Es lo seguro, y significa que la
   contabilidad migrada **no está en el Mayor** hasta que alguien la apruebe. Un
   balance sacado el día después de migrar no la incluye.
4. **~370 filas/s.** 200.000 comprobantes son quince minutos. Funciona; no es
   instantáneo.
5. **El archivo entero en memoria**: 380 MB con 50.000 filas.
6. **El candado se vence a los quince minutos.** Si una tanda llegara a tardar
   más que eso —ninguna medida se acercó—, una segunda corrida podría entrar.

## 15 · Blockers externos

| Qué | De quién depende |
|---|---|
| Adaptador de base de datos | Un esquema real de un sistema de origen |
| Adaptador REST/GraphQL | Una credencial contra un servicio real |
| Adaptador de Tango | Una exportación real de Tango |
| Adaptadores de e-commerce | Cuenta de desarrollador y OAuth2 en cada plataforma |

Ninguno se resolvió en V3, y ninguno era resoluble desde el repositorio.

## 16 · Limitaciones conocidas

**Cobranzas.** Es la única entidad canónica que el motor transporta y no sabe
escribir, y está bloqueada **por el modelo, no por falta de trabajo**: una
cobranza en NEXO es una imputación contra un renglón del Mayor
—`party_allocations` exige el `journal_entry_line_id` que la cancela— y un
archivo de otro sistema no trae ese renglón. Elegirlo por parecido decidiría
contra qué factura se aplicó cada peso. Se destraba cuando la contabilidad
migrada está aprobada: ahí la imputación se hace desde «Imputaciones» con los
renglones a la vista. El sistema lo explica en la pantalla, no permite una
importación incorrecta, y aparece como limitación en la lista de entidades.

**Conectores nativos con ERPs externos.** No existen. Lo que existe es la
arquitectura de adaptadores y un adaptador de archivos que lee lo que cualquiera
de esos ERPs exporte.

## 17 · Datos de desarrollo

**Eliminados.** Verificado primero que ningún fixture, seed, test ni benchmark
dependiera de ellos: la única referencia en el repositorio está dentro de
`bench-migracion.mjs`, que **crea su propia empresa en cada corrida** y por lo
tanto es reproducible sin datos persistentes.

Borrados en total: 16 empresas, 16 estudios, 5 cuentas de prueba y ~630.000
filas suyas —157.005 terceros entre ellas—.

**Comprobado sobre las 123 tablas del esquema que tienen `company_id`: cero
filas huérfanas.** Y la cadena de auditoría quedó íntegra —`npm run
audit:cadena` verifica dos cadenas reales sin adulteraciones— porque se encadena
por empresa: borrar la de una empresa de prueba no toca la de ninguna otra.

**Ya no hay ninguna cuenta con contraseña conocida.**

Quedan diez empresas y trece cuentas de sesiones anteriores (`@estudio.test`,
`@nexo.test`) que no son de este trabajo y que no toqué: todas con cero
migraciones. `npm run limpiar:pruebas` las lista sin tocarlas, y sin argumentos
**solo lista**.

## 18 · Documentación

| Archivo | Qué |
|---|---|
| `docs/MIGRACION.md` | **Nuevo.** Cómo funciona el motor y cómo se le agrega un adaptador, en diez pasos |
| `NEXO_MIGRATION_ENGINE_V3.md` | Este documento |
| `NEXO_MIGRATION_ENGINE_V2.md` | El informe del V2, vigente para su alcance |
| `NEXO_MIGRATION_ENGINE.md` | El del V1, marcado como superado |

## 19 · Estado final

```text
V3 CLOSED
```

Con lo que eso quiere decir, dicho entero:

> NEXO tiene un motor de migración estable y productizable para traer una
> empresa **desde archivos estructurados**: maestros, productos, depósitos,
> stock, ventas, compras, órdenes de pago y contabilidad histórica, con mapeo
> asistido, validación, vista previa, importación por tandas con progreso,
> reanudación y cancelación, tres reconciliaciones, trazabilidad fila a fila,
> auditoría encadenada, RLS forzado, idempotencia y reversión.
>
> Su arquitectura admite adaptadores nuevos sin tocar el núcleo, y **hoy hay uno
> solo implementado: «un archivo»**.

Después de esto no se le agregan entidades, adaptadores ni funcionalidades
grandes sin una fuente real delante o una necesidad comercial concreta. Lo que
sigue admitiendo es lo de siempre: correcciones, seguridad, pruebas y
documentación.
