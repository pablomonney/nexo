# ADR-017 — La IA no hace aritmética

**Estado:** ACEPTADA
**Fecha:** 2026-09-01
**Migración:** `0058_senales_y_umbrales.sql`
**Ruta:** `apps/api/src/routes/analisis.ts`
**Se prueba en:** `tests/integration/senales-y-simulacion.test.ts`

## Contexto

El roadmap decía «IA sobre datos reales: detección de desvíos, proyección y
simulación». Cerrados los módulos de fondo, por fin hay sobre qué: ventas,
compras, stock, cuenta corriente, bienes de uso y registros externos.

La expectativa por defecto —la que trae el mercado— es que estas tres cosas son
tareas de un modelo. Al escribirlas, ninguna lo es.

## Decisión

**Las tres son funciones deterministas y ninguna usa un modelo.**

| | Qué es en realidad | Dónde vive |
|---|---|---|
| Detectar un desvío | Una **comparación** contra un umbral que la empresa declaró | Vista `analysis_signals` |
| Proyectar una cobranza | Una **extrapolación** de plazos ya declarados por tercero | `GET /analysis/proyeccion-de-cobranzas` |
| Simular un escenario | Una **función pura** de parámetros explícitos | `POST /analysis/simulate` |

Un modelo no las haría mejor. Las haría **irreproducibles**: la misma pregunta,
dos respuestas distintas, y ninguna con una cuenta que se pueda rehacer. Para
las tres, la propiedad que importa no es la sofisticación sino que un contador
pueda reconstruir el número a mano y llegar al mismo lugar.

Eso no deja a la IA afuera del producto. El lugar legítimo del modelo —leer,
interpretar y **proponer** en lenguaje— ya existe desde la migración 0018:
`ai_predictions`, con agente `FINANCIAL_ANALYSIS`. No se duplicó nada (§70). Lo
que ADR-001 fija sigue valiendo acá sin excepción: **propone, no escribe**.

## Consecuencias

### 1. El umbral se declara o no se afirma nada

`analysis_thresholds` tiene **todas las columnas nulas**. Sin un umbral
declarado, `supera_umbral` vale `NULL` —no `false`— y la señal no entra en la
bandeja. Un sistema que decide solo que una caída del 20 % «es mucha» está
inventando el criterio de negocio de una empresa que no conoce (§15).

La señal se calcula igual y se puede consultar: lo que no ocurre es que el
sistema **afirme** un desvío que nadie definió.

### 2. Cada señal viaja con su metodología

Las cuatro ramas —`VARIACION_DE_VENTAS`, `CONCENTRACION_DE_CLIENTES`,
`CLIENTE_INACTIVO`, `MORA_DE_CARTERA`— llevan una columna `metodologia` con la
cuenta en prosa. Un número sin su cuenta al lado no es información: es una
afirmación que hay que creer.

### 3. La simulación no se guarda

Es una función pura de parámetros sobre cifras reales, y **no persiste**.
Guardarla sería almacenar un número derivado, que es exactamente lo que el resto
del sistema evita (terceros, stock, amortizaciones, analítica). Se rehace
llamando de nuevo con los mismos parámetros.

El test lo verifica desde el lado estructural: no existe ninguna tabla de
simulaciones.

### 4. Los supuestos van impresos

La respuesta de `/analysis/simulate` lleva sus cuatro supuestos en el cuerpo. El
primero es el que importa: *el volumen no reacciona al precio*. Una simulación
de precio a volumen constante ignora la elasticidad de la demanda, y decirlo es
la diferencia entre una herramienta y un número que engaña (§42).

### 5. La aritmética ocurre en `numeric`, no en JavaScript

La primera versión de la ruta multiplicaba con `Number` y formateaba con
`toFixed`. `check:no-float` la rechazó, con razón: plata que sale de la base
como decimal exacto y vuelve convertida a IEEE 754 ya no es la misma plata, y
una simulación que puede diferir en el último centavo entre dos corridas deja de
ser reproducible —que es lo único que esta capa promete. Todo el cálculo se
movió a `numeric` del lado de Postgres.

Por lo mismo, `variacionTotalPct` se devuelve como decimal exacto y no como
número: 8 % de precio con 5 % de volumen da 13,4 %, y redondearlo esconde justo
el resto que permitiría rehacer la cuenta.

### 6. Lo que esta capa no hace

- **No pronostica.** Proyectar plazos declarados no es predecir demanda. Un
  pronóstico necesita una serie con historia y un método con nombre, y decir
  cuál es sería una decisión de producto que todavía no se tomó.
- **No sugiere el umbral.** Se podría proponer uno mirando la propia serie. Es
  legítimo por ADR-001 —propone, una persona confirma— y no está hecho.
- **No mide rentabilidad.** Sigue faltando el costo de la mercadería vendida
  (ver `0057`); sin costo no hay margen, y estimarlo sería inventarlo.
