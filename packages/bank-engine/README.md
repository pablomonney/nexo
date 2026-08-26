# @aai/bank-engine

Importación de extractos y conciliación bancaria asistida. Función pura sobre
datos: sin red, sin disco, sin base.

Documentación completa en [BANKS.md](../../BANKS.md).

## Las tres reglas duras

**El importe exacto es precondición, no un componente del puntaje.** No hay match
"por poco". Un pago de $ 1.234.567,00 conciliado contra una factura de
$ 1.234.567,50 cierra la factura y deja el saldo del proveedor mal para siempre.

**El empate no se resuelve.** Dos líneas que puntúan igual contra el mismo
movimiento son dos respuestas posibles; quedarse con la primera es el orden de la
consulta SQL decidiendo una imputación.

**Nada se confirma solo, ni el match de score 100.** Los candados están en la
base, no acá.

## `ENTRADA`/`SALIDA`, nunca `DEBITO`/`CREDITO`

En el extracto "débito" es plata que sale; en el libro, un débito en la cuenta
Banco es plata que entra. Las dos palabras son correctas y opuestas. El
importador traduce una sola vez y el resto del paquete compara cosas que
significan lo mismo.

## El acta

```
saldo según extracto + partidas conciliatorias = saldo según libro
```

Si no cierra, la conciliación no está hecha. El motor dice cuánto falta y de qué
lado; no lo busca ni lo inventa.

## Lo que no clasifica

No dice que una partida sea una comisión, ni el impuesto de la Ley 25.413. Esa
ley no está archivada, y la descripción del banco no es una fuente. Dice de qué
lado quedó y dónde mirar.
