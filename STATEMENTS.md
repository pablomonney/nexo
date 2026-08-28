# STATEMENTS.md — Estados contables

> **Fuente de la estructura:** Ley 19.550 (T.O. 1984), **art. 63** (contenido del
> balance general) y **art. 64** (contenido del estado de resultados). Archivada
> en `docs/normative-sources/originals/INFOLEG_LGS_19550_texto_actualizado.htm`
> con su sha256.
>
> También rige el **CCyC art. 326**: al cierre del ejercicio hay que confeccionar
> estados contables que comprendan como mínimo un estado de situación patrimonial
> y uno de resultados.

## 1. La estructura es dato, no código

El criterio de la fase es *"dos empresas con marcos distintos generan estructuras
distintas **sin cambiar código**"*. Eso descarta la forma en que casi todos los
sistemas contables arman un balance: un módulo por marco, con los rubros escritos
adentro y un `if` por regulador.

Acá la plantilla es un **árbol declarativo** en `statement_templates`, versionado
por `(marco, tipo de ente, regulador, período)`. Agregar un marco es insertar una
fila.

```
RUBRO   agrupa hijos; su importe es la suma de ellos
RENGLON toma su importe de las cuentas que su selector captura
TOTAL   suma otros nodos por código, incluso de otra rama
```

Y por eso mismo la plantilla **se valida antes de usarla**: viene de la base, así
que no se puede confiar en que esté bien formada. Es el mismo razonamiento que el
intérprete cerrado del motor normativo.

### El selector es cerrado a propósito

Prefijo de código, tipo de cuenta, códigos exactos, exclusiones. Nada más.

La tentación es permitir una condición general —"cualquier cuenta que cumpla X"—
y termina siendo un lenguaje que nadie puede auditar. Un perito tiene que poder
leer una plantilla y decir qué cuentas caen en cada rubro; con cuatro criterios
enumerables eso se puede.

> **Un bug que encontró un test.** La primera versión trataba `codigos` como un
> criterio más que se combinaba con los otros. Un selector con **solo** `codigos`
> capturaba todo el plan: los otros dos criterios estaban "no declarados, así que
> no filtran" y su conjunción era verdadera para cualquier cuenta. El renglón se
> veía razonable y sumaba de más. `codigos` es una vía **alternativa**.

## 2. Ninguna cifra existe sin origen

`RenglonEmitido.origen` no es opcional, y `financial_statement_lines.lineage` es
`NOT NULL` con un CHECK que exige que sea un array. **No hay ningún tipo ni
ninguna columna donde alguien pueda escribir un importe**: todo renglón se deriva
de saldos de cuentas.

Un rubro sin cuentas es legítimo —un "Bienes de uso" en cero existe— y su origen
es la lista vacía: se preguntó y no hubo cuentas. Eso es distinto de un importe
que alguien escribió, y por eso el CHECK solo exige origen cuando el importe no
es cero.

El origen de un RUBRO es la **unión del de sus hijos**: hacer clic en "Total del
activo corriente" lleva a las cuentas, no a otro subtotal que hay que volver a
abrir.

## 3. Los dos controles que sostienen la fase

### `CUENTA_SIN_RUBRO`

Si el plan tiene una cuenta que ningún selector captura, su saldo **desaparece
del estado**. Y a veces el estado igual cierra —cuando dos cuentas huérfanas se
compensan— y entonces nadie lo nota nunca.

Es el modo de falla propio de los estados armados con plantilla. Hay un test que
lo reproduce exactamente así: dos huérfanas que se compensan, ecuación
patrimonial en verde, `emisible: false`.

### `CUENTA_EN_DOS_RUBROS`

Lo contrario: un selector demasiado ancho hace que una cuenta sume dos veces.

Los dos corren sobre **las dos columnas**, actual y comparativa. Un comparativo
armado sobre un plan que la plantilla de hoy no cubre tiene el mismo problema y
se ve igual de poco.

## 4. Un estado que no cierra no se emite

Es la diferencia con el Libro Diario, que **sí** se emite con sus observaciones.

| | Libro Diario | Estado contable |
|---|---|---|
| Qué es | El registro de lo que pasó | Una afirmación sobre la situación patrimonial |
| Con observaciones | Se emite igual: un hueco hay que poder verlo para arreglarlo | No se emite: una afirmación que no cierra es falsa |

En la base: `fs_emitido_firmado` exige firma, fecha y hash; en el motor,
`emisible: false` cuando algún control falla; en la API, un 409 con el detalle.

## 5. Cosas que el motor se niega a suponer

**El marco contable.** Si la empresa no tiene uno declarado para esa fecha, el
sistema no supone `RT_FACPCE`. Es la misma decisión que tomó la FASE 4: qué
normativa le aplica a un ente lo determina el profesional, no el default más
frecuente.

**La plantilla.** Sin plantilla para ese marco, ente y regulador, la respuesta es
`FUENTE NO ENCONTRADA`. No se elige una "parecida".

**La ecuación patrimonial, cuando la plantilla no la declara.** El control
informa que **no corrió**. No se verificó no es lo mismo que se verificó y da
bien.

> Y un código mal escrito en la ecuación la **rompe**, no la desactiva. Antes,
> `{ activo: 'ACTIVO' }` —el nodo se llama `A`— daba "0 = 0 + 0" y pasaba: un
> control que se apaga con un error de tipeo se ve idéntico a uno que da bien.

## 6. El §6 también rige en la presentación

`plantillaAplicable()` busca por la fecha de cierre del ejercicio, no por hoy. El
ESP de un ejercicio cerrado en 2024 se arma con la plantilla que regía en 2024.

Y una plantilla publicada **no se reescribe**: se cierra con `valid_to` y se carga
la versión siguiente. Reescribirla cambiaría todos los estados ya emitidos con
ella.

## 7. Estado declarado

| | Estado |
|---|---|
| Motor y controles | Funcionando |
| Ley 19.550 en `norms` | **sembrada** — la fecha de emisión del T.O. salió de la ficha oficial del Decreto 841/84 |
| `statement_templates` | **ESP y ER**, transcriptos de los arts. 63 y 64, para SA / IGJ / RT FACPCE |

```bash
npm run statements:seed
```

Valida las dos plantillas con `validarPlantilla()` **antes** de insertar ninguna, y
aborta entero si alguna falla: un ESP sin su ER es un estado contable incompleto.

### La convención de plan de cuentas que asumen

```
1.1.*  Activo corriente          1.2.*  Activo no corriente
2.1.*  Pasivo corriente          2.2.*  Pasivo no corriente
3.*    Patrimonio neto
4.1-4.7 Ingresos ordinarios · 4.8 Ganancias de ejercicios anteriores · 4.9 Ganancias extraordinarias
5.*    Costo de ventas y de servicios prestados
6.1 Administración · 6.2 Comercialización · 6.3 Financiación · 6.4 Otros gastos ordinarios
6.8 Pérdidas de ejercicios anteriores · 6.9 Pérdidas extraordinarias
7.*    Cuentas de orden
```

El art. 63 pide separar créditos de bienes de cambio, y bienes de uso de
inmateriales; también corriente de no corriente. Nada de eso sale de
`accounts.type`, así que los selectores usan **prefijos de código** — y eso ata
las plantillas a una codificación. Cada empresa arma su plan, así que **una
empresa con otra codificación no puede usar estas plantillas**: carga la suya, que
para eso `statement_templates.company_id` es nullable.

Lo importante es cómo falla ese caso: `CUENTA_SIN_RUBRO` marca cada cuenta que
ningún renglón capturó, así que un plan que no sigue la convención produce un
estado con decenas de cuentas señaladas y `emisible = false`. Imposible de
confundir con un balance correcto.

### Los signos: todo el ER va INVERTIDO

En el Mayor un saldo acreedor es negativo; en el estado, el pasivo se expone
positivo y el costo se resta. Marcando `INVERTIDO` los ingresos **y también** los
costos y gastos, cada `TOTAL` queda como una suma llana y el resultado sale solo.
La alternativa era que los totales supieran restar según el nodo, que es volver a
poner contabilidad en el código.

### Una corrección de transcripción no es un cambio de norma

La primera versión del ER tomaba el prefijo `4.` entero y excluía `4.9`. Estaba
mal: `excluir` compara **códigos exactos**, así que `4.9` no excluye a `4.9.01` y
la ganancia extraordinaria sumaba en dos renglones. Lo encontró
`CUENTA_EN_DOS_RUBROS`, que es para lo que ese control existe.

La base no deja reescribir ni borrar una plantilla publicada, así que la
corrección entró como **v2** y la v1 se cerró con `valid_to = valid_from`: una
ventana de largo cero, que afirma con precisión que esa versión *nunca tuvo un día
aplicable*. Cerrarla "desde hoy" diría que hasta hoy era la correcta, y un estado
de un ejercicio anterior emitido mañana volvería a tomarla.

## 8. Gaps declarados

- **Art. 64 inc. I. b) puntos 1 a 9**: los nueve montos que deben hacerse constar
  —retribuciones de administradores, honorarios, sueldos y contribuciones, gastos
  de estudios, regalías, publicidad, impuestos con sus intereses y multas
  separados, intereses por acreedor, amortizaciones y previsiones—. No están como
  renglones: exigirían una convención de tercer y cuarto nivel que casi ningún
  plan sigue igual, y un renglón vacío porque el prefijo no existe es peor que la
  ausencia — afirma que el concepto es cero. El propio artículo prevé la salida:
  van en la memoria o en nota.
- **Art. 63 inc. 1) b) y d)**: la apertura de créditos e inversiones con sociedades
  controlantes, controladas o vinculadas, y los litigiosos. Piden un dato de la
  contraparte que el plan de cuentas no lleva.
- **Art. 63 inc. 4) b) y c)**: si los derechos y obligaciones están documentados o
  con garantía real, y la exposición separada de los saldos en moneda extranjera.
- **Los otros once tipos de ente**: solo hay plantillas para SA / IGJ. Copiar la de
  una SA cambiándole la etiqueta afirmaría que una cooperativa expone su
  patrimonio igual, y la RT 62 capítulo 12 dice que no.
- **EEPN y EFE**: fuera del MVP con motivo (`docs/product/MVP.md`).
- **Ajuste por inflación** (RT 6 / RT 54 cap. correspondiente): no implementado.
- **Notas y anexos**: FASE 11.
- **Resultado del ejercicio como puente ESP ↔ ER**: el control que verifica que
  el resultado del ER coincida con la variación del PN necesita el EEPN, que no
  está.
- **Consolidación**: fuera del MVP.

## El alcance de cada estado

Un estado contable no se pronuncia sobre todo el plan de cuentas. La plantilla
declara **sobre qué tipos de cuenta habla**, con el artículo de dónde sale:

| Estado | Alcance | Fundamento |
|---|---|---|
| ESP | ACTIVO, PASIVO, PN, ORDEN, INGRESO, COSTO, GASTO | art. 63 — los tipos de resultado entran netos, en el renglón "Resultado del ejercicio" del PN (inc. 2) II. c) |
| ER | INGRESO, COSTO, GASTO | art. 64 |

Con eso, una cuenta cae en una de **cinco situaciones**, y el estado las informa
una por una en `clasificacion`:

| Situación | Qué significa | ¿Bloquea? |
|---|---|---|
| `CLASIFICADA` | está en el alcance y un renglón la captura | no |
| `SIN_RUBRO` | está en el alcance y ninguno la captura: su saldo desaparece | **sí** |
| `EN_DOS_RUBROS` | dos renglones la capturan: suma dos veces | **sí** |
| `FUERA_DEL_ALCANCE` | su tipo no le corresponde a este estado | no |
| `CAPTURADA_FUERA_DEL_ALCANCE` | un selector se llevó una cuenta que el estado declara no tratar | **sí** |

### Por qué esta distinción y no un booleano

`CUENTA_SIN_RUBRO` recorría el plan entero. Un ESP no tiene renglones para
cuentas de resultado, así que toda cuenta de ingresos con saldo salía huérfana y
el estado quedaba `emisible = false`: **ninguna empresa con un plan de cuentas
completo podía emitir un estado**. No se había notado porque los tests insertan
las filas de `financial_statements` por SQL y los unitarios usan un plan hecho a
medida de la plantilla — el endpoint nunca se había llamado.

La salida no fue apagar el control sino acotarlo. "No aparece porque no le
corresponde" y "no aparece porque falta un renglón" son respuestas distintas a
la misma pregunta, y hasta ahora se veían igual: no está.

Y aparece un control que antes era imposible: `CUENTA_FUERA_DE_ALCANCE`. Un
renglón del ESP que por un prefijo demasiado ancho se lleve una cuenta de gastos
infla el activo, y la ecuación patrimonial puede seguir cerrando si el mismo
error se repite del otro lado.

## Los asientos de cierre no entran al estado

`saldosAlCierre` excluye `REFUNDICION` y `CIERRE`. Un estado contable describe
la **situación** a una fecha; esos dos asientos son el mecanismo para poder
reabrir los libros, no hechos económicos del ejercicio. Incluir el cierre
patrimonial produciría un balance de ceros —formalmente cuadrado y sin ninguna
información— y la refundición vaciaría el estado de resultados.

Dejándolos afuera, el mismo ejercicio da el mismo estado el día antes de
cerrarlo y el día después. Hay un test que compara las dos fotos: que sean
iguales es lo que prueba que el estado sale del Mayor y no del momento en que se
lo pidió.

El renglón `PN_RESULTADO_EJERCICIO` es la otra mitad de eso. Mientras el
ejercicio no cerró, el resultado vive en las cuentas de resultado y ese renglón
lo toma neto; después de la refundición vive en una cuenta `3.4` y lo toma
`PN_RESULTADOS`. El total del patrimonio neto no cambia: cambia dónde se lee.

## Tres defectos que solo aparecen llamando al endpoint

1. **`CUENTA_SIN_RUBRO` sobre el plan entero** (arriba).
2. **La ecuación patrimonial vivía en la ruta**, con los códigos de nodo `A` y
   `P`; la plantilla usa `ACTIVO` y `PASIVO`. El control detectaba los nodos
   faltantes y fallaba —bien: no correr en silencio hubiera sido peor— pero
   fallaba **siempre**. Ahora la declara la plantilla, que es de quien es.
3. **La cabecera se insertaba ya `EMITIDO`** y el trigger
   `fsl_immutable_when_issued` rechazaba el primer renglón. Nace `BORRADOR` y se
   firma al final: el candado se queda intacto, lo que estaba mal era firmar
   antes de terminar de escribir.

Y un cuarto, que apareció al escribir el test: **los saldos del estado no
filtraban por asiento**. Los filtros —estado aprobado, fecha de corte— estaban
en el `ON` de un LEFT JOIN encadenado después del join de líneas, que es
incondicional, así que un asiento en BORRADOR entraba igual al `sum`. El error
es invisible: los números se ven razonables y el balance cuadra, porque cada
asiento de más está balanceado. Lo encontró un test que dejó un asiento
PROPUESTO a propósito y lo vio aparecer.

## Notas complementarias

Fuente: **Ley 19.550 (T.O. 1984), art. 65** — las notas y cuadros *«se
considerarán parte»* de los estados contables.

### La dirección

```
CONTABILIDAD → NOTA        y nunca al revés
```

Una nota **explica** algo ya registrado. No funda un asiento, no funda una
decisión, no funda una regla y no altera un saldo. Eso no se sostiene revisando
código: se sostiene en la forma de las tablas.

- `note_figures.statement_line_id` es `NOT NULL`, así que **no hay dónde
  escribir un número suelto**. Una cifra se obtiene apuntando a un renglón de un
  estado ya emitido, y de ahí hereda el importe y el linaje.
- `notes` no tiene ninguna columna con la que pudiera nombrar contabilidad — ni
  `journal_entry_id`, ni `decision_id`, ni `account_id` — y ninguna tabla
  contable la referencia. Hay un test que recorre el catálogo y lo comprueba en
  las dos direcciones.

### Los tres estados de evidencia

`status` es el trámite —quién firmó—; `evidencia` es qué la sostiene. Son ejes
distintos:

| Evidencia | Qué significa | ¿Se puede aprobar? |
|---|---|---|
| `VERIFIED` | las cifras salen de renglones del estado; nada que suponer | sí |
| `REQUIRES_REVIEW` | hay con qué proponerla; falta juicio profesional, no un dato | sí — aprobarla **es** la revisión |
| `INSUFFICIENT_EVIDENCE` | el sistema no tiene la información | **no**: no hay nada detrás que firmar |

Lo hace valer un CHECK de la migración `0040`, no el endpoint.

Una nota sin evidencia se crea **sin texto**, con el faltante escrito en su
fundamento. Un párrafo plausible sobre bienes de uso que el sistema no tiene
sería exactamente lo contrario de lo que estas notas existen para lograr.

### Qué se genera y qué no

| Tipo | Evidencia | Por qué |
|---|---|---|
| `BASES_DE_PREPARACION` | `REQUIRES_REVIEW` | marco, norma y moneda están declarados; que sean los aplicables al ente es una afirmación profesional |
| `COMPOSICION_DE_RUBRO` | `VERIFIED` | cada fila del cuadro es una cuenta del linaje del renglón: la suma **es** el renglón por construcción |
| `RESULTADO_DEL_EJERCICIO` | `VERIFIED` | sale del renglón del ER, con su linaje |

Y lo que **no** se puede proponer se devuelve enumerado, con lo que le falta a
cada una: bienes de uso (falta un submayor por bien), plazos y garantías de
créditos y deudas (no están modelados), criterios de valuación (el sistema
declara el marco del ente, no el criterio por rubro) y hechos posteriores (son
hechos del mundo, no del sistema). Una nota ausente y una imposible se ven
igual —no está— y mandan a hacer cosas distintas.

### Corregir una nota es reemplazarla

Una nota aprobada es inmutable: título, cuerpo, cifras y firma. Lo único que le
puede pasar es quedar `SUPERSEDIDA` por una versión nueva, encadenada por
`supersedes_id`, con un motivo que diga qué cambió — «se actualizó» no es un
motivo. Quedan las dos, como un asiento y su contraasiento.

### El paquete

`GET /statements/:id/package` reúne el estado, sus notas y su completitud.
«Completo» ahí significa que todas las notas vigentes están aprobadas y ninguna
quedó sin evidencia. **No significa que estén todas las que la ley exige**: el
sistema no sabe cuáles son obligatorias, y lo dice —
`obligatoriedad: 'REQUIRES_EXTERNAL_INPUT'`.

### El futuro lugar de la IA

La interfaz ya lo contempla y no lo usa. `BloqueDeNota` de tipo `TEXTO` lleva
`origenTexto: 'PLANTILLA' | 'HUMANO' | 'IA_BORRADOR'`, y `verificarNotas`
rechaza con `BORRADOR_DE_IA_SIN_REVISAR` cualquier nota que llegue a emitirse
con texto de IA sin que una persona lo haya hecho suyo. El camino previsto es:

```
LLM → propuesta de REDACCIÓN → evidencia estructurada ya determinada → revisión profesional → publicación
```

Nunca `LLM → cifra`, `LLM → clasificación` ni `LLM → aprobación`. Las cifras no
pasan por ahí: no hay forma de escribirlas.

## Gaps declarados

- **Comparativos.** `construirEstado` acepta `saldosComparativos` y el endpoint
  admite `?comparativo=`, y funciona; lo que **no** existe es el ajuste por
  inflación que el art. 62 último párrafo exige para que dos ejercicios sean
  comparables. Emitir dos columnas en moneda de distinto poder adquisitivo sin
  reexpresar sería presentar como comparable algo que no lo es. No se fabrican
  columnas sintéticas: quien pida un comparativo lo obtiene, y la limitación
  queda dicha acá.
  `REQUIRES_EXTERNAL_INPUT`: FACPCE, RT 6 (reexpresión) y la serie de índices
  que la RT 6 manda usar. Falta el documento oficial archivado con su hash.
- **Qué notas son legalmente obligatorias.** `REQUIRES_EXTERNAL_INPUT`. Las
  plantillas de los arts. 63 y 64 no declaran ninguna remisión a nota
  (`nodo.nota`), y no hay fuente archivada que enumere el juego mínimo
  exigible. Organismo: **IGJ / FACPCE**; falta el documento oficial con su
  hash. Hasta entonces el paquete informa qué notas tiene, no que estén
  todas — y no se inventa una lista de obligatorias.
- **Notas que necesitan datos que el sistema no modela.** Bienes de uso,
  plazos y garantías, criterios de valuación y hechos posteriores: las
  enumera `notasNoGenerables()` con lo que le falta a cada una, en vez de
  omitirlas.
- **Estado de evolución del patrimonio neto y flujo de efectivo.** Fuera del MVP,
  ya declarados.
- **Un solo juego de plantillas**: RT FACPCE, SA, IGJ. Una cooperativa expone su
  patrimonio de otra manera (RT 62, cap. 12) y copiar la plantilla de una SA
  cambiándole la etiqueta sería afirmar que son iguales.
