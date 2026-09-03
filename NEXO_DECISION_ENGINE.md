# NEXO_DECISION_ENGINE

**Estado:** IMPLEMENTADO qué pasó, por qué y qué pasaría si · PLANIFICADO el
resto del ciclo (recomendar, aprobar, ejecutar, medir, aprender).

Este archivo dice qué parte del ciclo existe hoy y qué le falta a cada paso
siguiente. Para el censo general, `NEXO_EVOLUTION_BASELINE.md`; para la capa de
preguntas, `NEXO_INTELLIGENCE.md`.

---

## 1. El ciclo, y dónde está cortado

```
QUÉ PASÓ          ✔ analítica, cuenta corriente, valuación, margen
POR QUÉ           ✔ descomposición de la variación del margen
QUÉ ESTÁ EN RIESGO ✔ seis frentes, cada uno con lo que no se puede medir
QUÉ PASA SI        ✔ simulación de precio, volumen y costo, con escenarios guardados
CUÁL CONTRA CUÁL   ✔ dos a cinco escenarios lado a lado, sin ganador
QUÉ CONVIENE       ✗ recomendación
APROBAR            ✗
EJECUTAR           ✔ existe el camino (el ERP), no existe el puente desde una decisión
MEDIR              ✗ predicción contra resultado
APRENDER           ✗
```

Los cuatro primeros pasos comparten una propiedad y por eso están: **son
aritmética sobre hechos registrados**. Los que faltan no lo son, y cada uno
necesita algo que todavía no existe.

## 2. Qué hay hoy

### Por qué cambió el margen

`GET /analysis/margen/variacion?desde=AAAA-MM&hasta=AAAA-MM` abre la variación
en tres efectos:

```
precio   = (p₁ − p₀) · q₁
costo    = −(c₁ − c₀) · q₁
volumen  = (p₀ − c₀) · (q₁ − q₀)
```

Los tres **suman exactamente** la variación: no hay reparto proporcional ni
residuo. La respuesta trae la comprobación de que suman, porque una identidad
algebraica mal escrita se ve igual que un número plausible.

Los productos que estuvieron en un solo período no se abren en precio y volumen
—no hay contra qué compararlos— y van en `altas` y `bajas`. Repartirlos sería
inventar un precio anterior que no existió.

Solo entran los renglones con margen afirmable. La venta que queda afuera se
informa: explicar una variación que incluyera ventas sin su costo sería explicar
otra cosa que la que muestra la pantalla de margen.

### Qué pasaría si

`POST /analysis/simulate` proyecta neto y margen ante variaciones de precio,
volumen y costo. Cada respuesta imprime sus supuestos, y el más fuerte va con
los demás: **el costo se trata como enteramente variable**. Una empresa con
costos fijos adentro del costo de ventas verá un margen proyectado peor que el
real cuando el volumen baja, y mejor cuando sube.

### Escenarios guardados

`POST /analysis/scenarios` guarda **la pregunta, no la respuesta**. El resultado
se recalcula cada vez que se mira, así que el mismo escenario contesta distinto
en marzo y en junio — en el medio la empresa vendió. Un resultado congelado
diría hoy lo que era cierto entonces, y quien lo lee no tendría cómo saberlo.

Los parámetros no se editan: cambiarlos convertiría al escenario en otro con el
mismo nombre, y la comparación de la semana pasada pasaría a hablar de algo
distinto sin avisar. Se archiva con motivo y se guarda uno nuevo.

### Comparar escenarios

`GET /analysis/scenarios/compare?ids=a,b` toma **dos a cinco** escenarios
guardados, los recalcula a todos contra las cifras de hoy y los pone al lado.
Uno solo no se acepta: no es una comparación. Un id que no exista en la empresa
devuelve 404 nombrándolo, en vez de comparar los que sí encontró y dejar que
alguien lea una comparación a la que le falta un escenario.

Las diferencias entre escenarios se calculan **en `numeric` del lado de la
base** —`SELECT ($1::numeric - $2::numeric)::text`—: restar dos importes en
JavaScript es exactamente lo que prohíbe `check:no-float`, y acá el resultado se
muestra como cifra.

**Cuando las ventanas no coinciden, no se resta.** Dos escenarios que miran 12 y
3 meses proyectan cada uno sobre una base distinta; las cifras de cada uno son
correctas, pero la diferencia entre ellas no significa nada. La respuesta trae
`baseComparable: false`, `comparacion: []` y el motivo. No se normalizan a la
ventana más corta porque eso descartaría datos que alguien eligió mirar.

**No dice cuál conviene.** La respuesta enumera, ordena por nada y no marca un
ganador — por lo mismo que la sección siguiente: elegir exige un objetivo
declarado por la empresa, y ponerlo acá sería inventarlo.

## 3. Lo que falta, y qué necesita cada cosa

### Recomendar

«Conviene subir el precio de estos cuatro productos» exige un criterio de
conveniencia, y ese criterio es de la empresa: maximizar margen, cuidar volumen,
proteger la caja o defender un cliente son objetivos distintos y a veces
opuestos.

**Lo que falta declarar:** el objetivo y sus restricciones. Sin eso, cualquier
recomendación sería la preferencia de quien programó el sistema disfrazada de
análisis.

**Lo que ya se puede hacer sin eso:** ordenar. «Estos productos se venden por
debajo del costo» no es una recomendación, es un hecho, y ya se señala (0084).

### Aprobar y ejecutar

Una decisión aprobada que se ejecuta sola exige, como mínimo: qué se hizo, quién
lo autorizó, con qué política, y qué pasó después. Nada de eso existe todavía, y
`analysis_scenarios` no tiene —a propósito— estados de «aprobado» o «ejecutado»:
inventárselos ahora sería prometer un ciclo que no está.

**Además, la mitad del camino ya tiene dueño.** Ejecutar una decisión sobre
precios es escribir en la lista de precios; sobre compras, armar una orden.
Todos esos caminos existen y **exigen firma humana**. El puente que falta no es
la ejecución: es el registro de que una decisión determinada llevó a ese acto.

### Medir y aprender

`decisión → predicción → resultado real → error` necesita las dos puntas. La
predicción existe (un escenario guardado es exactamente eso). El resultado real
también. Lo que falta es **la declaración de que este escenario se aplicó** —
sin ella, comparar el escenario contra lo que pasó atribuiría a una decisión un
resultado que pudo venir de cualquier otra cosa.

Es el mismo criterio que ADR-021: un documento cita el hecho, y la cita se
verifica. Acá haría falta que un escenario pudiera citar el acto que lo aplicó.

## 4. Lo que este motor no va a hacer

- Calcular con un modelo de lenguaje. La aritmética es determinística y
  auditable; la de un modelo no (ADR-017).
- Escribir en el Mayor. La autoridad sigue siendo `POST /journal-entries` con
  firma humana.
- Presentar una correlación como una causa. La descomposición del margen es una
  identidad algebraica —no una hipótesis— y por eso se puede afirmar; «las
  ventas cayeron porque subió el dólar» no lo es, y no se va a decir.
- Recomendar sin un objetivo declarado por la empresa.
