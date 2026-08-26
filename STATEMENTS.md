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
| Motor y controles | Funcionando, 33 tests |
| `statement_templates` | **vacía** |
| Ley 19.550 en `norms` | **no sembrada** |

```bash
npm run statements:seed
```

Dice exactamente qué falta y cómo se destraba. Resumen: la `fecha_emision` de la
Ley 19.550 no surge del documento archivado, que solo da el B.O. del Decreto
841/84 que ordenó el texto. Es la misma regla que dejó afuera a otros doce
documentos en FASE 5b — completar la emisión con la publicación sería afirmar un
hecho que nadie verificó.

## 8. Gaps declarados

- **Ley 19.550 sin sembrar**: bloquea la carga de plantillas.
- **EEPN y EFE**: fuera del MVP con motivo (`docs/product/MVP.md`).
- **Ajuste por inflación** (RT 6 / RT 54 cap. correspondiente): no implementado.
- **Notas y anexos**: FASE 11.
- **Resultado del ejercicio como puente ESP ↔ ER**: el control que verifica que
  el resultado del ER coincida con la variación del PN necesita el EEPN, que no
  está.
- **Consolidación**: fuera del MVP.
