# ADR-018 — Un módulo que registra y no alimenta la decisión es un archivo

**Estado:** ACEPTADA
**Fecha:** 2026-09-02
**Aplicada por primera vez en:** migración `0065`, sobre el módulo de cheques

## Contexto

La 0064 agregó cheques. Quedó bien integrado con las fuentes de verdad que ya
existían —terceros, cuentas bancarias, asientos por cita, la bandeja— y pasó
todos los controles.

Y sin embargo el sistema **sabía que la empresa tenía novecientos mil pesos en
cheques y no los usaba para contestar «¿cuánta plata entra en los próximos
treinta días?»**. La cartera no aparecía en ninguna señal, en ninguna proyección
consolidada, en ningún tablero. Era un registro correcto y mudo.

Ese es el modo de falla que este ADR previene, y no se detecta con ningún gate
existente: todos dan verde.

## Decisión

**Todo módulo nuevo tiene que hacer las dos cosas, y ninguna de las dos alcanza
sola:**

### 1 · Integrarse con las fuentes de verdad que ya existen

- No crear una segunda tabla para un hecho que ya está modelado.
- No guardar un saldo que se puede derivar.
- Colgar de los maestros existentes —`parties`, `products`, `accounts`,
  `journal_entries`— con la empresa dentro de la clave foránea.
- Si toca plata, decir cómo se relaciona con el Mayor: o lo cita, o lo alimenta
  por el puente de siempre, o declara por qué no lo toca.

### 2 · Alimentar la capa de decisión

Un módulo entra cuando puede contestar al menos una de estas, y lo hace:

| Pregunta | Dónde vive hoy |
|---|---|
| ¿Qué requiere atención humana? | Una rama en `work_queue_*` |
| ¿Cuánto y desde cuándo? | Una vista en `analytics_*` |
| ¿Esto se desvía de lo que la empresa declaró aceptable? | Una rama en `analysis_signals` con su umbral en `analysis_thresholds` |
| ¿Cómo cambia esto lo que va a pasar? | Una entrada en el flujo de fondos o en la simulación |
| ¿De dónde salió este número? | Un `trazaRef` que abra las filas |

**Un módulo que solo escribe filas está sin terminar**, aunque tenga API,
permisos, tests y pantalla. El criterio de calidad §27 ya pedía «integración con
el resto del ERP»; esto lo hace verificable.

## Consecuencias

### Lo que ya no se puede hacer

Cerrar un bloque diciendo «el módulo está listo, la analítica viene después».
La analítica *después* no llega: el módulo pasa a la lista de terminados y nadie
vuelve.

### Lo que esto no significa

**No es «agregarle un gráfico a todo».** Varias de las cinco preguntas no
aplican a un módulo dado, y forzarlas produce tableros decorativos —que §23
prohíbe—. Lo que se exige es contestar **al menos una, de verdad**, y decir
explícitamente por qué las otras no aplican.

Tampoco significa inventar métricas. Las reglas de siempre no se aflojan: la
señal necesita un umbral declarado o informa sin juzgar (0058), la proyección
declara sus supuestos (ADR-017), y ninguna cifra se almacena si se puede derivar.

### El caso que le dio forma: sumar sin contar dos veces

La 0064 había dejado el flujo de cheques separado de la proyección de cobranzas
«porque sumarlos contaría la misma plata dos veces». Era prudente y **demasiado
grueso**: un cheque recibido contra una factura, con su imputación registrada,
ya redujo esa factura — sumarlos da el número correcto.

El doble conteo tiene una condición precisa: ocurre cuando el cobro **no llegó
al Mayor**, y eso es exactamente `checks.journal_entry_id IS NULL`.

De ahí sale la forma que deberían tener estos casos:

> Cuando dos fuentes puedan solaparse, **derivar la condición del solapamiento**
> en vez de renunciar a consolidar. Y mostrar lo que queda afuera **con su
> motivo**: una cifra que falta y una que se decidió no sumar se ven igual si
> nadie las separa.

### Deuda que este ADR abre sobre lo ya construido

Los módulos anteriores a la 0064 se revisaron contra el criterio. El resultado
está en `docs/roadmap/COBERTURA_ERP.md`; el que quedó peor parado es **bienes de
uso**: tiene bandeja y trazabilidad, y no aparece en ninguna proyección — la
amortización del ejercicio que viene es un gasto conocido con fecha conocida y
no entra a ningún flujo. Queda anotado, no silenciado.
