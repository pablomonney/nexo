# NEXO_INTELLIGENCE

**Estado:** IMPLEMENTADO la capa determinística · PLANIFICADA la narración ·
BLOQUEADA la conexión a un modelo real (falta el adaptador del proveedor).

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
dice con qué vista lo contesta. Hoy son doce:

| Pregunta | De dónde sale |
|---|---|
| ¿Cuánto vendí? | `analytics_operaciones_mensuales` |
| ¿Cuánto compré? | `analytics_operaciones_mensuales` |
| ¿Cuánto me deben? | `party_aging`, `invoice_settlement` |
| ¿Cuánto debo? | `party_aging`, `payment_order_status` |
| ¿Cuánta plata tengo? | `analytics_disponible` |
| ¿Cuánto vale mi stock? | `stock_valuation` |
| ¿Cuál es mi margen? | `analytics_margen_por_producto` |
| ¿Cuánto costó lo que vendí? | `cogs_por_mes` |
| ¿Qué está en riesgo? | `analysis_signals` |
| ¿Qué me falta hacer? | `work_queue` |
| ¿A quién le tengo que cobrar? | `invoice_settlement` |
| ¿Cómo viene el mes? | `analytics_resumen` |

Agregar una pregunta es agregar una entrada con su consulta y su metodología. No
hay forma de agregar una que no diga de dónde sale su número.

## 3. Las tres respuestas posibles, y por qué son tres

**La contesta.** Con la cifra, el detalle que la compone, la vista de la que
salió, cómo se calcula y qué no incluye.

**No la entiende.** Lo dice y muestra lo que sí sabe contestar. No busca la
pregunta más parecida: una respuesta correcta a una pregunta que nadie hizo se
lee igual que la respuesta.

**Entiende varias.** Las ofrece y pide elegir. Romper el empate sería adivinar.

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

## 5. Lo que falta, y qué lo bloquea

**La narración.** El respondedor está escrito y probado en
`packages/ai-engine/answering.ts`: valida que cada numeral de la redacción esté
en el contexto y rechaza la respuesta entera si no. La tabla `ai_answers`
—migración 0027— guarda pregunta, contexto exacto, respuesta, si se aceptó y por
qué se rechazó, y `ai_answer_metrics` separa alucinación de error.

Lo que falta es el adaptador de un proveedor real. Es un archivo que implementa
`LLMProvider`, y su ausencia no impide operar.

**Riesgos por contestar.** El Risk Radar de §29 del prompt de evolución —
liquidez, concentración, dependencia de proveedores, anomalías— hoy está
parcialmente cubierto por `analysis_signals` y la bandeja. Lo que falta es la
lectura transversal: hoy cada señal se enciende sola y nadie las relaciona.

**Explicación causal.** «El margen cayó 6,4 puntos» se puede afirmar; «cayó
porque subió el costo promedio 12 % y el precio solo 3 %» exige descomponer la
variación, que es un cálculo determinístico que todavía no está escrito. Es el
próximo paso natural de esta capa, y no necesita ningún modelo.

## 6. Lo que esta capa no hará nunca

- Escribir en el Mayor. La autoridad sigue siendo `POST /journal-entries` con
  firma humana.
- Ejecutar SQL que no esté en el catálogo.
- Contestar con un número que no venga de un motor determinístico.
- Cruzar datos de dos empresas: el catálogo consulta dentro de la transacción
  con la empresa en contexto, y el RLS filtra por debajo.
- Presentar una inferencia como una norma.
