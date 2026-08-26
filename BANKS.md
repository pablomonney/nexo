# BANKS.md — Conciliación bancaria

## 1. El modo de falla que este módulo existe para evitar

No es un error de cálculo. Es este:

> El motor propone un match plausible. El contador aprueba, porque los otros
> cuarenta estaban bien. El pago a un proveedor queda cancelando la factura de
> otro. **Los saldos cierran igual.** Nadie se entera hasta que el proveedor
> reclama, seis meses después.

Todo lo que sigue son decisiones tomadas contra ese escenario.

## 2. Las tres reglas duras

### El importe exacto es precondición, no un componente del puntaje

Casi todo el software de conciliación le da mucho peso al importe y deja que un
match con $ 0,50 de diferencia gane igual por fecha y referencia. Eso produce el
error caro: un pago de $ 1.234.567,00 conciliado contra una factura de
$ 1.234.567,50 cierra la factura, deja los cincuenta centavos flotando, y el
saldo del proveedor queda mal para siempre.

Acá **no hay match sin importe idéntico**. Una diferencia de importe no es un
match peor: es una partida conciliatoria, que es otra cosa y se muestra en el
acta.

El puntaje sirve solo para **ordenar entre candidatos que ya coinciden en
importe**.

### El empate no se resuelve

Si dos líneas contables puntúan igual contra el mismo movimiento, el motor
devuelve las dos y no elige. Quedarse con la primera del array es el orden de la
consulta SQL decidiendo una imputación contable.

Un movimiento ambiguo **no cuenta como cubierto** en el indicador de cobertura:
el motor lo encontró, pero no propuso nada, y contarlo inflaría el número justo
con los casos que más trabajo humano requieren.

### Nada se confirma solo, ni el match de score 100

El criterio de la fase es *0 conciliaciones confirmadas sin intervención humana*.
Un invariante así no se cumple midiéndolo, así que está en la base:

| Candado | Qué impide |
|---|---|
| `rec_confirmada_firmada` | Confirmar sin persona y fecha |
| `match_confirmado_firmado` | Un match confirmado sin firmante |
| `assert_reconciliation_confirmable()` | Confirmar con matches que nadie revisó |
| `rec_acta_cierra` | Confirmar un acta que no cierra |
| `brm_immutable_when_confirmed` | Tocar los matches de una conciliación cerrada |

Y no existe ningún endpoint que confirme en lote. Un botón de "aceptar todas" es
exactamente cómo la intervención humana se vuelve un trámite (R-25).

## 3. `ENTRADA`/`SALIDA`, nunca `DEBITO`/`CREDITO`

Es la decisión que más errores evita, y la más aburrida de explicar.

En el extracto, **"débito" significa que salió plata**: el banco debita *su* deuda
con la empresa. En el libro, **un débito en la cuenta Banco significa lo
contrario** — entró plata, aumentó el activo. Las dos palabras son correctas y
opuestas, y quien escribe el código tiene que acordarse todo el tiempo de en qué
óptica está parado.

`ENTRADA` y `SALIDA` no tienen dos lecturas, y son siempre desde la caja de la
empresa. La traducción se hace **una sola vez**, en el importador, y de ahí en
adelante comparar un movimiento con una línea contable es comparar dos cosas que
significan lo mismo.

El check `sentido IN ('ENTRADA','SALIDA')` en `bank_transactions` existe para que
la palabra ambigua no pueda entrar ni por SQL directo.

> Esto lo encontró un test. La primera versión tenía el signo del acta invertido
> en dos de los cuatro casos, y el acta cerraba igual cuando los importes de las
> dos puntas coincidían.

## 4. El acta: la igualdad que tiene que cerrar

```
saldo según extracto  +  partidas conciliatorias  =  saldo según libro
```

Es a la conciliación lo que las tres igualdades del balance son al Diario. Si no
cierra, la conciliación **no está hecha**, por más que los cuarenta matches estén
bien: lo que falta es una partida que nadie identificó, y esa partida es el
hallazgo.

Los cuatro casos, escritos porque los dos del medio se confunden todo el tiempo:

| Partida | Sentido | Ajuste | Ejemplo |
|---|---|---|---|
| En el libro, no en el banco | `ENTRADA` | **+** | Depósito en tránsito |
| En el libro, no en el banco | `SALIDA` | **−** | Cheque emitido y no debitado |
| En el banco, no en el libro | `SALIDA` | **+** | Comisión que nadie registró |
| En el banco, no en el libro | `ENTRADA` | **−** | Acreditación no registrada |

Cuando no cierra, el motor dice **cuánto falta y de qué lado**. No lo busca ni lo
inventa.

## 5. Lo que el motor deliberadamente no clasifica

No dice "esto es una comisión bancaria", ni "esto es el impuesto de la Ley
25.413", ni "esto es un cheque no debitado". La descripción del banco muchas
veces lo insinúa, y aun así:

- **la Ley 25.413 no está archivada**, así que el sistema no puede afirmar ni la
  alícuota ni el hecho imponible;
- **una descripción bancaria no es una fuente**: `COM. MANT. CTA` es una cadena
  que el banco eligió, no una calificación jurídica;
- una partida mal clasificada que después se imputa produce un asiento equivocado
  con la firma de alguien que confió en la etiqueta.

Lo que sí hace es decir de qué lado quedó y **dónde mirar**. La calificación la
pone el contador, en `bank_reconciliation_differences.explicacion`.

## 6. La importación no adivina

No hay un formato de extracto en Argentina. Cada banco exporta columnas
distintas, fechas en dos órdenes, importes con coma o con punto, el signo en una
columna aparte o en dos.

Frente a eso hay dos caminos. **Adivinar** —probar formatos hasta que uno parsee—
anda casi siempre, y cuando falla mete $ 1.234 como $ 1,234 en una conciliación
que alguien después firma. O **declarar el mapeo una vez por cuenta** y rechazar
todo lo que no encaje.

El sistema hace lo segundo. La primera importación de un banco nuevo cuesta cinco
minutos de configuración; a cambio, ninguna importación posterior interpreta nada
por su cuenta. Si el banco cambia el formato, se actualiza el mapeo — no se
adivina en el parser.

Una fila que falla **no aborta la importación y tampoco se saltea en silencio**:
vuelve en `errores` con su contenido original.

### El control que más sirve: la cadena de saldos

Si el extracto trae la columna de saldo, cada fila tiene que explicar la
diferencia con la anterior. Una columna corrida, un archivo truncado a la mitad o
un importe leído con el formato equivocado **rompen la cadena en la primera fila
afectada**, aunque esa fila —vista sola— parezca perfectamente válida.

Es mucho más fuerte que validar cada fila por separado, y por eso la cadena rota
aborta la importación entera: desde ahí, todo lo que sigue está corrido.

Cuando el extracto **no** trae columna de saldo, el resultado dice
`cadenaVerificada: null`. No es lo mismo haber controlado y que dé bien, que no
haber podido controlar.

## 7. Agrupaciones

El caso real: un depósito de cuatro cheques entra al banco como un solo crédito y
en el libro son cuatro cobranzas. Sin agrupaciones quedan cinco partidas
conciliatorias que en realidad son una operación.

Tres decisiones:

- **Los matches uno a uno se resuelven primero.** Buscar agrupaciones antes
  dejaría que un conjunto de tres movimientos se lleve una línea que tenía su par
  exacto.
- **Una agrupación nunca puntúa como un match uno a uno.** Tres importes que
  casualmente suman un cuarto no son la misma operación, y el mensaje lo dice.
- **La búsqueda está acotada** por cantidad de elementos y por combinaciones
  evaluadas, y cuando el tope se alcanza el acta **lo dice**. Un motor que se
  queda sin presupuesto y devuelve "no hay agrupaciones" hace creer que las buscó
  todas.

## 8. Cobertura

El indicador del criterio (≥ 80%). Se mide sobre **movimientos del banco**, no
sobre matches: una agrupación que junta cuatro movimientos cubre cuatro.

El porcentaje es entero y **trunca hacia abajo**. 79,9% se informa como 79, no
como 80: un indicador que redondea hacia arriba justo en el umbral del criterio
deja de servir para verificar el criterio.

## 9. Gaps declarados

- **Ley 25.413** (impuesto sobre créditos y débitos): no archivada. Sin ella el
  sistema no clasifica ni calcula el impuesto de las partidas bancarias.
- **Dígito verificador del CBU**: el algoritmo sale de una comunicación del BCRA
  que no está archivada. Se valida el largo, que es lo verificable sin fuente.
- **Formatos MT940 / CAMT.053**: no implementados. El MVP es CSV.
- **Transferencias internas entre cuentas propias**: se conciliarían como dos
  operaciones independientes; no hay detección de la contrapartida.
- **Conciliación de tarjetas y de cuentas en moneda extranjera**: fuera del MVP.
