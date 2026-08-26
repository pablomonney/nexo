# @aai/normative-engine

El módulo del que depende la credibilidad de todo el producto. **Independiente
del motor de IA**: no tiene ninguna dependencia hacia `ai-engine`, y el lint de
arquitectura lo verifica.

## La pregunta que responde

> Dado un hecho ocurrido el `D`, para un ente de tipo `T`, en jurisdicción `J`,
> con marco `F` — ¿qué reglas eran aplicables y de qué texto exacto surgen?

Y las dos respuestas que **también son válidas**:

- `FUENTE_NO_ENCONTRADA` — no hay norma relevada para el caso.
- `CONFLICTO_NORMATIVO` — hay más de una regla aplicable de igual prioridad.

El motor **no desempata, no interpola y no infiere**.

## Por qué la vigencia no es `WHERE fecha <= now()`

```sql
-- PROHIBIDO en este repositorio
SELECT * FROM norms
 WHERE fecha_vigencia <= CURRENT_DATE
   AND (fecha_derogacion IS NULL OR fecha_derogacion > CURRENT_DATE)
```

Cuatro razones, todas verificadas en fuente oficial y todas con test:

**1. Recontabilizar 2024 con el derecho de 2026.** Es el §6 en una línea.

**2. La vigencia de una norma profesional se ata al inicio del ejercicio**, no a
la fecha del hecho. Una sociedad con cierre en noviembre no empieza a aplicar la
RT 54 el mismo día que una con cierre en diciembre.

**3. La adopción es jurisdiccional.** FACPCE fijó la RT 54 para ejercicios
iniciados desde el 01/07/2024; el CPCECABA la adoptó desde el 01/01/2025. Los dos
hechos son verdaderos y no se contradicen — son actos jurídicos distintos. Sin el
acto de adopción cargado, el motor responde `ADOPCION_NO_RELEVADA` en vez de caer
a la fecha del emisor.

**4. La aplicación anticipada a veces se ancla al cierre** (CPCECABA: ejercicios
*finalizados* desde el 30/09/2024) **y es una opción del ente**. Ser elegible no
es haber optado: la opción se registra con respaldo documental, y deducirla de
que las fechas dan sería decidir por el ente.

## Tiempo doble

| Eje | Para qué |
|---|---|
| **Vigencia** (`fecha_vigencia` / `fecha_derogacion`) | Qué regía cuando ocurrió el hecho |
| **Sistema** (`recorded_from` / `recorded_to`) | Qué sabía el sistema cuando decidió |

Sin el segundo no se puede responder *"¿por qué el sistema clasificó así en
marzo, si hoy la regla dice otra cosa?"*. Con `asOf` en el pasado, la resolución
se reproduce con el conocimiento de entonces.

## El corazón: cómo se resuelve un empate

La única forma de que el motor elija entre dos normas es que exista una relación
de derogación o sustitución **cargada desde el texto oficial** en
`norm_modifications`. Hay dos tests gemelos que lo muestran: la misma situación
da `CONFLICTO` sin la relación declarada y se resuelve con ella.

No hay heurística de "la más nueva gana" ni "la más específica gana". Las dos son
razonables, las dos se equivocan, y cuando se equivocan lo hacen en silencio: una
norma posterior puede perfectamente no derogar a la anterior.

## Intérprete cerrado de condiciones

`conditions` es un AST declarativo, no JavaScript. Importa por dos motivos: el
obvio —una regla que viene de la base y se evalúa con `eval` es ejecución remota
de código— y el cotidiano: un lenguaje chico y total se puede **auditar**. Un
perito puede leer el AST de una regla y entender qué hace.

La decisión que define el módulo: **lo que no se puede evaluar, falla; nunca vale
`false`.** Operador desconocido, hecho ausente, tipos mezclados: todos lanzan.
Tratarlos como falso haría que una regla dejara de aplicarse en silencio, y una
regla que no se aplica sin que nadie se entere es peor que una que rompe.

Tampoco cortocircuita: un `or` cuyo primer argumento es verdadero igual evalúa el
segundo. Si está mal escrito, se quiere saber ahora y no el día que el primero
cambie de valor.

## Citas

**Una cita que no se puede abrir no es una cita.** Si el nivel no es `V1` o no
hay documento archivado con hash, la regla no se presenta como aplicada: se
muestra `NO VERIFICABLE CON FUENTE OFICIAL DISPONIBLE` y se deriva a revisión.

El hash no es un detalle: las URLs oficiales cambian de lugar cuando el organismo
reorganiza su sitio; el hash del PDF que el sistema leyó ese día no cambia nunca.

## Estado de los datos

```bash
npm run norms:seed
```

Carga el archivo de FASE 1 en `norms` / `norm_versions` / `norm_documents`. De los
21 documentos archivados entran **8**: los que tienen fecha de emisión verificada
en [`vigencias.csv`](../../docs/normative-sources/vigencias.csv), donde cada fila
cita el artículo del que surge. Los otros 13 se saltean y el script dice cuáles y
por qué — completar `fecha_emision` con la de publicación sería afirmar un hecho
que nadie verificó.

El octavo lo agregó la FASE 6: el **Código Civil y Comercial (Ley 26.994)**, del
que salen las formalidades del Libro Diario. Su fecha de vigencia —01/08/2015—
sale del art. 7°, y la edición archivada trae además la nota al pie que dice que
ese texto lo sustituyó el art. 1° de la ley 27.077. Todo verificable en el mismo
documento que el sistema leyó.

**Adopciones cargadas: una.** La Res. **P.** N° 460/2024 del CPCECABA está
archivada y cargada: adopta la RT 59 (T.O. de la RT 54) en CABA para ejercicios
iniciados desde el 01/01/2025, con aplicación anticipada para ejercicios
*finalizados* desde el 30/09/2024 — anclada al cierre y no al inicio, que es el
caso raro para el que existe `early_anchor`.

Las demás jurisdicciones siguen respondiendo `ADOPCION_NO_RELEVADA`, y eso es
una respuesta: la vigencia que fija la FACPCE y la que fija cada consejo son
hechos distintos.

**Reglas cargadas: cero.** Cargar una regla exige transcribir el articulado que
la funda, con revisión humana. No es trabajo de un script.
