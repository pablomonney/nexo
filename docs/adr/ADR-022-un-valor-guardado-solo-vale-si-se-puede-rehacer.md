# ADR-022 — Un valor guardado solo vale si se puede rehacer

**Fecha:** 2026-09-02
**Estado:** aceptada
**Migraciones:** 0086

## El problema

La regla de este esquema, desde la 0016, es **derivar y no guardar**. Un saldo
guardado puede contradecir a los movimientos de los que salió, y el día que
difieran alguien tiene que decidir cuál gana. Por eso el Mayor no tiene una
columna de saldo, la existencia sale del libro de stock y la antigüedad de
saldos se calcula.

La 0086 encontró el límite de esa regla, y lo encontró midiendo:

    50.000 movimientos de stock de una empresa
    SELECT count(*) FROM stock_valuation  →  25.000 ms

El promedio ponderado móvil se derivaba recorriendo el libro entero **en cada
consulta**. Correcto siempre, e inutilizable a partir de cierto volumen — que
para un comercio de 200 artículos son dos años.

Las dos salidas obvias eran malas. Dejarlo así entrega un ERP que se cuelga
cuando el cliente lo usa en serio. Guardar el promedio a secas rompe la regla
que sostiene la confianza en las cifras.

## La decisión

**Se puede guardar lo derivado cuando se cumplen tres condiciones, y solo
entonces:**

1. **Lo que está debajo no puede cambiar.** Si la historia es inmutable, el
   valor calculado sobre ella no puede quedar viejo. En el caso del stock eso ya
   estaba garantizado desde la 0054: un movimiento no se edita
   (`stock_movements_inmutable`) y no se borra (`stock_movements_no_delete`).
   Sin esa garantía, esta decisión no aplica.

2. **La derivación queda viva y se compara.** El recorrido recursivo no se
   borró: quedó como `stock_ppp_derivado`, sin pantalla, y un test comprueba en
   cada corrida que la caché y la derivación digan exactamente lo mismo. Un
   valor guardado que nadie puede rehacer es una afirmación sin origen — lo
   mismo que §24 prohíbe para un asiento.

3. **La aplicación no lo escribe.** La caché la escribe la base, en el mismo
   trigger que ve el hecho. Si la API pudiera escribirla, volvería a existir la
   segunda verdad: alguien podría declarar un costo distinto del que sale del
   libro, que es justo lo que la 0077 evita.

## Lo que esto no autoriza

No autoriza guardar el saldo del Mayor, ni la existencia, ni el pendiente de un
comprobante. Ninguno cumple la primera condición: un asiento se anula por
contraasiento y una imputación se anula, así que el pasado **sí** cambia de
significado.

Tampoco autoriza una vista materializada refrescada cada tanto. Entre el refresco
y la consulta hay una ventana en la que el sistema afirma algo que ya no es
cierto, y no hay forma de que quien lee sepa si está adentro de esa ventana.

## El caso que hay que mirar siempre

El orden del libro de stock es (fecha, alta, id): un movimiento cargado hoy con
fecha del mes pasado **se mete en el medio**. La primera condición sigue
cumpliéndose —nada se editó— pero la cadena calculada después de esa fecha ya no
corresponde.

Prohibir la carga con fecha anterior habría sido impedir trabajo real: la
recepción del lunes se carga el martes. La solución fue que el trigger mire si
hay movimientos posteriores del mismo producto y rehaga la cadena solo en ese
caso — el caso raro paga, el normal cuesta un paso.

La lección general: al guardar lo derivado hay que preguntarse no solo *«¿puede
cambiar lo de abajo?»* sino *«¿puede aparecer algo nuevo en el medio?»*.

## Y una trampa de PostgreSQL que costó dos mediciones

La primera versión del trigger decidía si rehacer la cadena preguntándole a
`stock_movements` si había movimientos posteriores de ese producto. Parece lo
mismo y no lo es: **los triggers `AFTER ... FOR EACH ROW` se encolan y se
ejecutan al terminar la sentencia**, no fila por fila. En un `INSERT` de varias
filas —una recepción con muchos renglones, una carga de historia— cuando el
trigger corre para la primera fila, todas las demás ya están escritas. Cada
fila veía «posteriores» y rehacía la cadena entera: cuadrático, y con cincuenta
mil movimientos no terminaba nunca.

La versión que quedó le pregunta **a la caché**, que solo tiene lo que el
trigger ya procesó. Una sola búsqueda contesta las dos preguntas —de dónde
sigue la cuenta y si el movimiento nuevo va al final— y el orden de las filas
dentro de la sentencia deja de importar.

Lo encontró `npm run bench:vistas`, no un test: ninguna suite carga volumen.

## Consecuencias

**Se puede medir antes de decidir.** La medición que originó esta decisión ahora
es un instrumento (`npm run bench:vistas`): carga volumen en la base descartable
y mide con el rol de la aplicación. Existe porque ninguna suite podía ver este
defecto — los tests comprueban que la cuenta esté bien, no que se pueda esperar
el resultado.

**Queda una pregunta abierta y escrita.** Las demás vistas derivadas —la bandeja,
que es la unión de veintitrés; el flujo de fondos; la antigüedad de saldos— no
se midieron con volumen. No hay motivo para suponer que estén mal ni para
afirmar que estén bien.
