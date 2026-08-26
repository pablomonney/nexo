# @aai/audit-engine

Análisis de variaciones y detección de anomalías. Función pura sobre datos: sin
red, sin disco, sin base.

## Por qué esto no usa IA

El roadmap pone "detección de anomalías" en la fase de IA avanzada, y la lectura
natural es que hace falta un modelo. No hace falta, y usarlo sería peor.

Un hallazgo de auditoría tiene que poder explicarse ante un tercero: *este gasto
subió 340%*, *este asiento se cargó seis meses después de su fecha*, *este
proveedor factura siempre unos pesos por debajo del tope*. Las tres son
afirmaciones aritméticas sobre datos que el sistema tiene, y un modelo que las
produzca agrega una capa que no se puede auditar a cambio de nada.

## Una anomalía no es una acusación

Cada hallazgo tiene `observado` —un hecho verificable— y `queMirar` —una
pregunta—. No tiene severidad, ni puntaje de riesgo, ni conclusión.

Un sistema que dice "posible fraude" produce dos efectos y ninguno bueno: quien
lo lee deja de mirar los que no marcó, y el marcado queda con una etiqueta que
nadie escribió a conciencia.

## El análisis de variaciones no elige entre porcentaje e importe

Ordenar por porcentaje pone arriba la cuenta que pasó de $ 100 a $ 400 y abajo la
que movió cuatro millones. Ordenar por importe esconde exactamente el hallazgo
que la auditoría busca. Los dos números viajan juntos y el análisis no ordena.

Y el cero no es un porcentaje muy grande: una cuenta que pasó de cero a saldo
**apareció**, y eso es una categoría propia, no un `∞` ni un `999%`.

## Mediana y MAD, no media y desvío

La media se deja arrastrar por un único valor extremo — y si el extremo es la
anomalía, la media se mueve hacia ella y deja de detectarla.
