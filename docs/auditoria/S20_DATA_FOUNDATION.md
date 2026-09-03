# S-20 — Data Foundation

**Fecha:** 2026-09-03 · `verify` en verde (118 archivos, 1888 tests).

Lo que las capas de arriba —Intelligence, Decision Engine, agentes— necesitan de
abajo es exactamente tres cosas: que los hechos estén dichos de una sola manera,
que las métricas existan, y que cualquier número pueda decir de dónde salió.

---

## 1. Event model — el vocabulario de la bitácora

**Estado: NORMALIZADO Y DEFENDIDO.**

Cada escritura productiva deja una fila en `audit_logs` con su `action`. Al
medirlo, el vocabulario derivaba: 106 acciones en `VERBO_EN_MAYUSCULAS` y ocho
en `objeto.verbo`, todas de un puñado de archivos donde cada uno copió el estilo
de su vecino.

No se inventó un modelo de eventos nuevo. Existía uno —la bitácora, encadenada
por hash, con actor, objeto y motivo— y lo que faltaba era que hablara un solo
idioma. Ahora lo hace, y `tests/security/vocabulario-de-eventos.test.ts` impide
que vuelva a derivar.

**Lo que encontró de paso:** `audit_logs` exige motivo para cinco acciones
excepcionales y las compara **por texto**. Renombrar cualquiera de las cinco no
rompe nada visible y apaga el candado en silencio. Se comprobó rompiéndolo.

Dos de esas cinco son nombres que nadie escribe, y quedan declarados con su
motivo: `ACTIVAR_REGLA` (activar una regla no ocurre dentro de una empresa: va a
`normative_audit_logs` como `RULE_APPROVED`) y `RECLASIFICAR_APROBADO` (no
existe como operación; lo que hay es anular y volver a asentar).

---

## 2. Métricas — qué contesta el sistema hoy

**Estado: DIECINUEVE PREGUNTAS, todas con origen y metodología.**

| Métrica pedida | Estado | Dónde |
|---|---|---|
| Ventas | ✔ | `analytics_operaciones_mensuales` |
| Compras | ✔ | `analytics_operaciones_mensuales` |
| Margen | ✔ | `analytics_margen_por_producto` |
| Costo de lo vendido | ✔ | `cogs_por_mes` |
| Cuentas por cobrar | ✔ | `party_aging`, `invoice_settlement` |
| Cuentas por pagar | ✔ | `party_aging`, `payment_order_status` |
| Cash / disponible | ✔ | `analytics_disponible`, `checks_en_cartera` |
| Costos | ✔ | `cogs_por_mes`, `stock_valuation` |
| Rentabilidad por producto | ✔ | `analytics_margen_por_producto` |
| Rentabilidad por proyecto | ✔ | `analytics_proyectos` |
| Por vendedor | ✔ | `analytics_comisiones` |
| Por sucursal | ✔ | `analytics_sucursales` |
| Por centro de costo | ✔ | `cost_center_results` (0088) |
| **Rotación de stock** | **FALTA** | Ver abajo |
| **Rentabilidad por cliente** | **FALTA** | Ver abajo |

### Rotación de stock — qué le falta

El numerador existe (`cogs_por_mes`). El denominador no: la existencia
**a una fecha pasada**. `stock_valuation` valúa hoy, y reconstruir la existencia
valuada a una fecha exige recorrer el libro de movimientos con el PPP vigente en
cada momento — que la 0086 ya calcula por movimiento, así que el dato está.

Es trabajo, no un bloqueo. Lo que sí es una elección: **qué stock promedio** usa
la fórmula (inicio y fin del período, o promedio de los cierres mensuales). Se
declara en la metodología de la respuesta, como todo lo demás.

### Rentabilidad por cliente — qué le falta

Las ventas por cliente existen (`analytics_por_tercero`). El costo de lo vendido
**a ese cliente** exige atribuir cada salida de stock a su comprobante y el
comprobante a su tercero. Los dos vínculos existen desde la cadena de ventas
(`stock_movements.origen_id` → `tax_transactions.party_id`), así que es
derivable sin datos nuevos.

Lo que hay que decidir es qué se hace con las ventas **sin salida registrada**:
hoy el margen por producto no las afirma, y por cliente debería hacer lo mismo
—informar la cobertura en vez de calcular sobre lo que hay—.

---

## 3. Data lineage — de dónde sale un número

**Estado: DERIVADO DEL MOTOR, no declarado.**

`GET /lineage/:relacion` contesta de qué está hecha una vista, hasta las tablas
donde el hecho se escribió. Sale de `pg_rewrite` y `pg_depend`: el catálogo de
PostgreSQL, que es **cómo la vista se ejecuta**.

Un mapa de linaje escrito a mano habría sido más lindo de leer y habría
envejecido con la primera vista que alguien cambiara.

```
¿Cuál es mi margen?
  → analytics_margen_por_producto        ← lo que la respuesta ya decía
      → stock_valuation, tax_transaction_lines, …
          → stock_movements, tax_transactions, journal_entry_lines
```

Dos controles lo sostienen:

1. **Las hojas son tablas.** Un número cuyo linaje no llega a ninguna tabla no
   viene de ningún lado.
2. **Los diecinueve orígenes que el catálogo promete existen.** Una respuesta
   que cita una vista renombrada dice de dónde sale un número y manda a un lugar
   que no está: peor que no decirlo.

En la consola cada origen es un enlace: se toca y muestra su linaje. Es el paso
«¿por qué? → datos» sin salir de la respuesta.

---

## 4. Lo que sigue

Las dos métricas que faltan están descriptas arriba con lo que necesita cada
una; ninguna está bloqueada por un tercero.

La capa de arriba ya tiene con qué trabajar: hechos con un vocabulario estable,
métricas con metodología declarada y linaje verificable hasta la tabla.
