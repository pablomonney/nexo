# NEXO_DECISION_ENGINE

**Estado:** IMPLEMENTADO qué pasó, por qué, qué pasaría si, **qué se decidió y
qué salió** · PLANIFICADO lo único que falta: que el sistema **recomiende**.

**Actualizado el 2026-09-08** con el registro de decisiones (0101).

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
QUÉ CONVIENE       ✗ el sistema todavía no recomienda por su cuenta
DECIDIR            ✔ registro con problema, evidencia y alternativas (0101)
APROBAR            ✔ con segunda firma en riesgo alto y crítico
EJECUTAR           ✔ existe el camino (el ERP), y se declara desde cuándo rige
DECLARAR APLICADO  ✔ el puente: una persona lo declara citando el acto
MEDIR              ✔ qué se esperaba, qué pasó, cuánto se separaron
REVISAR            ✔ veredicto escrito, con lo medido congelado
APRENDER           ✔ porcentaje de aciertos, auditable · ✗ no hay nada que se ajuste solo
```

Los primeros pasos comparten una propiedad y por eso están: **son aritmética
sobre hechos registrados**. El que falta —recomendar— no lo es: exige una
política sobre qué conviene, y ese juicio no sale de los datos.

## 1.b El registro de decisiones (0101)

Lo que faltaba no era medir: eso ya estaba. Faltaba **qué se decidió y por qué**,
sin lo cual las piezas anteriores son un tablero que informa y no deja rastro de
ninguna decisión.

### Lo que el registro se niega a aceptar

| | Por qué |
|---|---|
| Una decisión **sin evidencia** | Es una opinión, y una opinión guardada como decisión arruina para siempre cualquier medición de aciertos |
| **Una sola alternativa** | Eso no es haber decidido: es haber ejecutado |
| Que **proponga y apruebe la misma persona**, en riesgo alto o crítico | Misma separación de funciones que la reapertura de período |
| Ir contra la recomendación **sin argumento** | Ir en contra es legítimo; hacerlo sin decir por qué, no |
| Ejecutar **sin decir qué alternativa se eligió** | Dejaría un acto sin contenido |
| **Dos revisiones de la misma ventana** | La segunda cambiaría el porcentaje de aciertos sin que hubiera pasado nada |

### Lo recomendado y lo elegido son dos columnas

Es la decisión de diseño que hace posible el aprendizaje. Si se guardara solo
«qué se hizo», el sistema nunca podría contestar si sus recomendaciones sirven:
para eso hace falta saber **cuándo se le hizo caso y cuándo no**, y cómo salió
cada vez.

Tiene un costo, y conviene decirlo: queda escrito, con nombre y fecha, cada vez
que una persona fue en contra. Eso solo es aceptable si ir en contra es legítimo
— y lo es: el sistema propone sobre lo que puede medir, y quien decide sabe
cosas que el sistema no. Por eso lo que se registra no es la desobediencia, es
el argumento.

### «No atribuible» es un veredicto, no un fracaso

Al revisar, el resultado puede ser que **no se pueda saber**: cambió el mercado,
cambiaron los costos, hubo estacionalidad. Ese caso tiene su propio veredicto y
**queda afuera del porcentaje de aciertos**.

Contarlo como error haría dos cosas malas: el sistema parecería peor de lo que
es, y —lo grave— empujaría a evitar las decisiones difíciles de medir, que suelen
ser las que más importan.

### La revisión congela lo que midió

`medicion` guarda los números **tal como estaban** el día de la revisión. La
medición cambia con el tiempo: los mismos meses se recalculan cuando entran
comprobantes atrasados. Una revisión de marzo tiene que seguir diciendo en
diciembre lo que decía en marzo, porque de eso se trata revisar.

Es el ADR-021 aplicado a una decisión: el documento cita el hecho, no lo genera.

### Esto no es un modelo que aprende solo

La calibración —`decision_calibracion`— es un **porcentaje de aciertos sobre
revisiones que escribió una persona**. No hay pesos, no hay reentrenamiento y no
hay nada que cambie de comportamiento por su cuenta.

El §29 del pliego pide que el aprendizaje sea auditable, y un número que sale de
contar filas revisadas lo es: cualquiera puede rehacerlo a mano. Un modelo que
se ajustara solo sería exactamente lo contrario, y no se puede auditar diciendo
que los pesos cambiaron.

Sin revisiones medibles el porcentaje es `null`, no cero: cero por ciento diría
que nunca se acertó, y lo que pasa es que todavía no se midió.

### Lo que sigue faltando: recomendar

El sistema compara escenarios y **no elige**. Elegir exige una función de
preferencia —cuánto riesgo se tolera, qué horizonte importa, qué pesa más entre
caja y margen— y esa función es del estudio, no del software.

Cuando exista, el registro ya tiene dónde ponerla: `recomendada_id`. Y el día
que haya suficientes revisiones, la calibración va a poder contestar si conviene
escucharla — que es la única forma honesta de justificar una recomendación
automática.

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

### ~~Medir~~ — hecho el 2026-09-04

`decisión → predicción → resultado real → error` necesitaba las dos puntas y las
dos existían: la predicción es un escenario guardado y el resultado lo tiene el
ERP. Faltaba **el puente**, y es el mismo criterio de ADR-021: un documento cita
el hecho, y la cita se verifica.

`POST /analysis/scenarios/:id/applied` declara que un escenario se aplicó
**citando una fila de la bitácora**, no describiendo lo que se hizo. La bitácora
está encadenada por hash y es append-only, así que el acto citado existió, tiene
actor y fecha, y no se puede reescribir después para que encaje con el resultado.

**NEXO no lo deduce.** Que un cambio de precios ejecute un escenario lo afirma
una persona, con motivo, y queda su nombre. Lo que sigue abierto —y no se
inventa— es si el sistema debería alguna vez deducirlo.

**Acá sí se congela la respuesta**, al revés que en el escenario. No es una
contradicción: lo que se esperaba el día que se decidió es un hecho histórico, y
es justamente lo que se pone a prueba. Recalcularlo después contestaría «¿qué
proyectaría hoy?» y no quedaría nada contra qué medir. *Un pronóstico que se
actualiza solo nunca se equivoca.*

`GET /analysis/scenarios/:id/result` compara **ritmos mensuales, no totales**: la
proyección se hizo sobre los meses que la base cubría y desde que se aplicó pasó
otra cantidad, así que restar los totales compararía dos ventanas distintas. El
esperado por mes divide por los meses de la base y no por la ventana pedida — un
error que este mismo diseño tuvo y que encontró el test del loop, con el signo al
revés: dividir por la ventana informaba que la decisión superaba el pronóstico
siempre.

Y no dice que la diferencia la haya **causado** la decisión. Atribuírsela
exigiría que nada más hubiera cambiado en el período, y eso es falso en general.

### Aprender

Lo que falta ahora no es infraestructura: es **evidencia**. Con un caso medido no
se aprende nada; con veinte, la tasa de desvío por tipo de decisión empieza a
decir algo. La infraestructura para acumularlos está.

## 4. Lo que este motor no va a hacer

- Calcular con un modelo de lenguaje. La aritmética es determinística y
  auditable; la de un modelo no (ADR-017).
- Escribir en el Mayor. La autoridad sigue siendo `POST /journal-entries` con
  firma humana.
- Presentar una correlación como una causa. La descomposición del margen es una
  identidad algebraica —no una hipótesis— y por eso se puede afirmar; «las
  ventas cayeron porque subió el dólar» no lo es, y no se va a decir.
- Recomendar sin un objetivo declarado por la empresa.
