# NEXO_INTELLIGENCE

**Estado:** IMPLEMENTADO — capa determinística de veinte preguntas y camino
de narración cerrado y probado con el simulado. **BLOQUEADO** solo el adaptador
de un proveedor real, que exige una credencial de un tercero.

---

## 1. Qué es, y qué no

NEXO Intelligence contesta preguntas sobre la empresa **con los motores que ya
calculan esos números**. No es un chatbot al lado del ERP: es la capa que hace
accesible lo que el ERP ya sabe.

La diferencia importa porque decide dónde vive la aritmética:

```
PREGUNTA
   ↓
CATÁLOGO CERRADO          ← qué se sabe contestar
   ↓
MOTOR DETERMINÍSTICO      ← la analítica, la cuenta corriente, la valuación
   ↓
RESPUESTA + EVIDENCIA     ← cifra, origen, metodología, qué no incluye
   ↓
NARRACIÓN (opcional)      ← el modelo redacta lo que el motor calculó
   ↓
VERIFICACIÓN DE CIFRAS    ← cada numeral tiene que estar en el contexto
```

**El modelo nunca calcula.** Si la pregunta es «cuánto vendí en marzo», el
número lo trae `analytics_operaciones_mensuales` —que cuadra contra el Mayor y
respeta el RLS— y el modelo, si está configurado, lo redacta. La aritmética de
un modelo de lenguaje no es auditable, y no hace falta: el sistema ya sabe
sumar.

## 2. Por qué el catálogo es cerrado

La alternativa evidente es mandarle la pregunta y el esquema a un modelo para
que arme la consulta. No se hace, y el motivo es concreto: la respuesta a
«cuánto vendí» **ya está calculada**. Una segunda consulta produciría un segundo
número para la misma pregunta, sin forma de saber cuál está bien. Y §41 prohíbe
que la IA ejecute SQL arbitrario.

Entonces el catálogo enumera lo que el sistema sabe contestar, y cada entrada
dice con qué vista lo contesta. Hoy son veinte, y cubren todos los módulos
del ERP que producen analítica:

| Pregunta | De dónde sale |
|---|---|
| ¿Cuánto vendí? · ¿Cuánto compré? | `analytics_operaciones_mensuales` |
| ¿Cuánto me deben? · ¿A quién le cobro? | `party_aging`, `invoice_settlement` |
| ¿Cuánto debo? | `party_aging`, `payment_order_status` |
| ¿Cuánto cobré? | `party_allocations` |
| ¿Cuánta plata tengo? | `analytics_disponible` |
| ¿Qué cheques tengo? | `checks_en_cartera` |
| ¿Cuánto vale mi stock? | `stock_valuation` |
| ¿Qué productos se venden más? | `analytics_por_producto` |
| ¿Cuál es mi margen? | `analytics_margen_por_producto` |
| ¿Cuánto costó lo que vendí? | `cogs_por_mes` |
| ¿Cómo van los proyectos? | `analytics_proyectos` |
| ¿Cuánto devengaron los vendedores? | `analytics_comisiones` |
| ¿Cómo va cada sucursal? | `analytics_sucursales` |
| ¿Qué está en riesgo? | `analysis_signals` |
| ¿Qué me falta hacer? | `work_queue` |
| ¿Cómo viene el mes? | `analytics_resumen` |
| ¿Cómo va cada centro de costo? | `cost_center_results` |
| ¿Qué me va a faltar? | `stock_coverage` |

Un barrido corre **todas** en cada verify: sin él, una pregunta poco usada puede
tener la consulta rota y nadie se entera hasta que alguien la hace.
Agregar una pregunta es agregar una entrada con su consulta y su metodología. No
hay forma de agregar una que no diga de dónde sale su número.

## 3. Las cuatro respuestas posibles, y por qué son cuatro

**La contesta.** Con la cifra, el detalle que la compone, la vista de la que
salió, cómo se calcula y qué no incluye.

**No la entiende.** Lo dice y muestra lo que sí sabe contestar. No busca la
pregunta más parecida: una respuesta correcta a una pregunta que nadie hizo se
lee igual que la respuesta.

**Entiende varias.** Las ofrece y pide elegir. Romper el empate sería adivinar.

**La entiende y el sistema no hace eso.** Es distinto de no entenderla, y por
eso se contesta distinto: con el motivo. Preguntar por los sueldos y recibir
«no entendí» sería mentir sobre la causa; recibir una tabla de ventas por
sucursal sería peor. Los cinco temas fuera de alcance —RRHH, retenciones,
impuesto a pagar, pronóstico y consejo profesional— vienen cada uno con por qué
no está: una decisión pendiente, una fuente sin archivar, o el §42.

### El defecto que esto ya evitó

La primera versión del reconocedor mezclaba todas las palabras de cada pregunta
en una lista. «¿Cuántos empleados tengo en Rosario?» se contestaba con el saldo
de caja, porque la palabra «tengo» alcanzaba.

Ahora cada entrada separa **núcleo** —las palabras que solo tienen sentido en
esa pregunta— de **apoyo**. Sin una palabra del núcleo no hay pregunta
reconocida, y un test comprueba que ninguna palabra de núcleo aparezca en dos
entradas: si apareciera, dejaría de identificar.

## 4. Qué pasa sin proveedor de modelo

`AI_PROVIDER=none` es el valor por defecto y **es un modo de operación**, no una
degradación. La respuesta llega con su cifra y su evidencia; lo único que falta
es el párrafo redactado. La pantalla lo dice con esas palabras.

El motivo está en `AI_ARCHITECTURE.md` §8: los documentos de un estudio son
secreto profesional, y para muchos clientes mandarlos a un tercero es una
conversación que no quieren tener. Un sistema que sin IA no contesta nada obliga
a esa conversación.

## 5. La narración: el camino está cerrado

`AnsweringAgent` arma el pedido, lo manda al proveedor y pasa la salida por las
reglas de `answering.ts`. Toda llamada queda en `ai_answers` con el contexto
exacto que se usó —aceptada o rechazada—, porque guardar solo las aceptadas
haría que la métrica de alucinación se vea mejor de lo que es.

Tres candados, no una instrucción en el prompt:

1. **El schema no tiene dónde poner un importe nuevo.** Las cifras vienen en el
   contexto, calculadas y formateadas.
2. **Las etiquetas y las normas citables son un `enum`.** El modelo no puede
   decir que usó un dato que nadie le pasó.
3. **El control de cifras rechaza la respuesta entera** si aparece un numeral
   que no estaba. No tacha el número: la frase que lo rodeaba afirmaba algo.

Cualquiera de los tres solo no alcanza. El primero se esquiva escribiendo el
número en la prosa; el segundo no mira la prosa; el tercero es el que la mira.

**El límite conocido del tercero.** Los numerales de una o dos cifras se admiten
sin estar en el contexto: son ordinales y cantidades que aparecen naturalmente
al redactar («las tres cuentas», «el 30 de junio»), y exigirlos haría que el
control rechace respuestas correctas — un control que rechaza lo correcto se
apaga en una semana. La consecuencia es que «un margen del 32 %» pasaría el
control aunque nadie lo haya calculado. Lo que lo contiene es que el prompt
prohíbe calcular y el schema no tiene dónde poner el resultado; no es lo mismo
que un candado, y por eso está escrito acá.

### Lo que sigue faltando

**El adaptador de un proveedor real.** Con `AI_PROVIDER=mock` el camino entero
se recorre y el simulado **se abstiene siempre**: no proviene de ningún modelo y
no tiene valor, y la pantalla lo dice así. Un mock que redactara un párrafo
produciría algo indistinguible de una respuesta real.

Conectar un proveedor es implementar `LLMProvider` en un archivo y configurar su
credencial. No está hecho porque exige una credencial de un tercero, y hasta que
exista sería declarar una integración que no se puede ejercitar.

**Nada más.** Las dos cosas que este archivo listaba como pendientes ya están:
el radar de riesgos (`GET /analysis/riesgos`, seis frentes, cada uno con lo que
no se puede medir) y la explicación causal de la variación del margen
(`GET /analysis/margen/variacion`, precio, costo y volumen que suman
exactamente). Ninguna necesitó un modelo — ver `NEXO_DECISION_ENGINE.md`.

## 5b. De dónde sale un número, hasta las tablas

Cada respuesta trae su `origen`: la vista que la contestó. Eso alcanza para un
escalón. `GET /lineage/:relacion` contesta la cadena entera:

```
margen
  → analytics_margen_por_producto
      → stock_valuation, tax_transaction_lines, …
          → stock_movements, tax_transactions, journal_entry_lines
```

**El linaje no está declarado en ningún lado: se lee del catálogo de
PostgreSQL** (`pg_rewrite`, `pg_depend`), que es cómo el motor ejecuta la vista.
Un mapa escrito a mano sería más lindo de leer y habría envejecido con la
primera vista que alguien cambiara — la misma regla que gobierna el resto del
sistema, derivar en vez de guardar, aplicada a la metadata.

Las hojas del árbol son tablas. **Un número cuyo linaje no llega a ninguna tabla
no viene de ningún lado**, y eso se puede comprobar en vez de suponerlo: un test
recorre los orígenes que el catálogo promete y falla si alguno dejó de
existir. Una respuesta que cita una vista renombrada dice de dónde sale un
número y manda a un lugar que no está, que es peor que no decirlo.

En la consola, cada origen de una respuesta es un enlace: se toca y muestra de
qué está hecho. Es el paso «¿por qué? → datos» sin salir de la respuesta.

## 6. Lo que esta capa no hará nunca

- Escribir en el Mayor. La autoridad sigue siendo `POST /journal-entries` con
  firma humana.
- Ejecutar SQL que no esté en el catálogo.
- Contestar con un número que no venga de un motor determinístico.
- Cruzar datos de dos empresas: el catálogo consulta dentro de la transacción
  con la empresa en contexto, y el RLS filtra por debajo.
- Presentar una inferencia como una norma.
