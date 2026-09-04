# NEXO — TRANSVERSAL INTEGRATION STATUS

**Fecha:** 2026-09-04 · `verify` en verde: **1927 tests en 123 archivos**, 23
barridos de seguridad, 142 tablas y 94 vistas.

La pregunta de esta fase no era «¿existe el endpoint?». Era otra:

> ¿Una capacidad atraviesa las capas que necesita, o cada capa es correcta por
> separado y nadie recorre el camino entre ellas?

---

## 1. ERP — **VERIFICADO**

La cadena comercial completa se ejercita por HTTP en
`tests/integration/cadena-de-ventas.test.ts`: comercial → fiscal → stock →
cuenta corriente → Mayor → cobranza → costo. Un único escritor del Mayor
(`POST /journal-entries`), RLS `FORCE` en cada tabla de empresa, y la aritmética
de dinero en `numeric` del lado de la base (`check:no-float`).

**Lo que sigue afuera** está en `NEXO_ROADMAP.md` §P4 con qué lo destraba:
retenciones y percepciones (archivar los regímenes), Libro IVA Digital
(los diseños de registro no están en la RG), FIFO (decisión contable),
remitos parciales, devoluciones, producción y RRHH (decisiones de producto).

## 2. Data Foundation — **VERIFICADO**

Tres cosas que las capas de arriba necesitan de abajo, y las tres están:

| | Estado |
|---|---|
| Vocabulario de eventos | 135 acciones **registradas**, con identidad |
| Métricas | 20 preguntas con origen y metodología declarada |
| Linaje | Derivado de `pg_rewrite`/`pg_depend`, no escrito a mano |

**Lo que cambió en esta fase.** `audit_logs.action` era texto libre y el candado
del motivo comparaba contra cinco literales en un CHECK: renombrar
`ANULAR_ASIENTO` apagaba el candado en silencio. Ahora `audit_actions` registra
las acciones y `audit_logs.action` la referencia — **una acción sin registrar no
se puede escribir**— y la regla del motivo lee el registro (0091).

Y el barrido que defendía el vocabulario veía **un tercio** de él:

| Camino de emisión | Cuántas | ¿Lo veía? |
|---|---|---|
| `action: 'LITERAL'` en `recordAudit` | 112 | sí |
| `accion: 'LITERAL'` en la tabla de acciones de una ruta | 9 | no |
| Triggers SQL que insertan en `audit_logs` | 9 | no |

Dos de las que no veía estaban **en inglés** en un vocabulario castellano
(`AFFECTATION_DECLARED`, `AFFECTATION_CHANGED`): las renombró la 0092.

**Faltan dos métricas**, ninguna bloqueada: rotación de stock (exige elegir qué
stock promedio usa la fórmula) y rentabilidad por cliente (exige decidir qué se
hace con las ventas sin salida de stock registrada).

## 3. Regulatory Engine — **VERIFICADO** como capa transversal

No es una pantalla fiscal aparte. Interviene donde tiene que intervenir:

- **En el esquema:** `accounting_rules.norm_version_id` es `NOT NULL` — no
  existe regla sin norma (ADR-005).
- **Al activar una regla:** un trigger de la 0006 rechaza activar una regla cuya
  norma no sea **V1 con documento archivado**, y otro de la 0041 la rechaza
  mientras un gap normativo siga ABIERTO. Están en la base, no en una ruta:
  defienden también el `UPDATE` a mano.
- **En el camino del modelo:** una cita a una norma que no está en
  `norm_versions` **rechaza la propuesta** y la registra en `ai_rejections` con
  `es_alucinacion`. Hay tests que lo ejercitan en las dos direcciones.
- **En el asiento:** `journal_entries` acepta `ruleApplications` con `ruleKey` y
  `ruleVersion`, y la decisión que lo funda evalúa el AST de la regla — no la da
  por aplicada por estar vigente.

Medido: 44 reglas ACTIVE, **cero** citando una norma sin V1 o sin documento.

> **Nota de método.** En esta fase escribí un trigger para imponer justamente
> esa garantía, y al correr los tests descubrí que ya existía desde la 0006 con
> sus propios tests. Lo revertí entero. Medir el invariante no es lo mismo que
> comprobar si alguien ya lo defiende, y confundir las dos cosas produce una
> segunda implementación de algo correcto.

## 4. Intelligence — **PARCIAL**, y la frontera ahora está defendida

| Capacidad | Estado |
|---|---|
| Catálogo de preguntas con evidencia y metodología | VERIFICADO (20 preguntas) |
| Señales y anomalías determinísticas | VERIFICADO |
| Narración con modelo | **BLOQUEADO POR TERCERO** — falta la credencial |
| Controles anti-alucinación | VERIFICADO |

**El contrato con el ERP.** Al medirlo, las preguntas salían de dieciocho vistas
y **una tabla cruda**: la de las cobranzas. Eso tenía dos consecuencias y la
segunda era la grave — la métrica quedaba encerrada en la respuesta, y su
significado se decidía ahí sin que se notara. «¿Cuánto cobré?» agrupaba por
`created_at`, *cuándo alguien registró la imputación*, mientras todo el resto del
sistema fecha por el hecho: un cobro de marzo imputado en abril figuraba en
abril, y las cobranzas de un mes cerrado cambiaban al cargar una imputación
atrasada.

`collections_by_month` (0090) es ahora la definición canónica, y `S-26` impide
que vuelva a pasar: **la lista de excepciones está vacía**.

## 5. Decision Engine — **PARCIAL**, con el ciclo cerrado hasta «medir»

```
QUÉ PASÓ           ✔     CUÁL CONTRA CUÁL   ✔
POR QUÉ            ✔     QUÉ CONVIENE       ✗ requiere objetivo declarado
QUÉ ESTÁ EN RIESGO ✔     APROBAR            ✗
QUÉ PASA SI        ✔     EJECUTAR           ✔ (el ERP, con firma humana)
DECLARAR APLICADO  ✔     MEDIR              ✔
APRENDER           ✗ no falta infraestructura: falta evidencia
```

**Lo que se cerró.** `POST /analysis/scenarios/:id/applied` declara que un
escenario se aplicó **citando una fila de la bitácora** —encadenada por hash,
append-only: el acto existió y no se puede reescribir para que encaje con el
resultado—. `GET /analysis/scenarios/:id/result` compara la predicción congelada
de ese día contra lo que el ERP registró.

Tres decisiones que valen más que los endpoints:

1. **NEXO no deduce la aplicación.** La declara una persona, con motivo, y queda
   su nombre.
2. **Acá sí se congela la respuesta**, al revés que en el escenario (0087). Lo
   que se esperaba el día que se decidió es un hecho histórico y es lo que se
   pone a prueba: *un pronóstico que se actualiza solo nunca se equivoca.*
3. **No dice que la diferencia la haya causado la decisión.** Atribuírsela
   exigiría que nada más hubiera cambiado en el período.

## 6. Agents — **PARCIAL**: de ocho, corre uno

`S-21` lo mide contra el `CHECK` de `ai_predictions`. De los ocho agentes
declarados, escribe **uno** (`CLASSIFICATION`). Los siete restantes agrupan en
tres formas que no son intercambiables:

| Forma | Cuáles | Qué falta |
|---|---|---|
| El trabajo ya está hecho sin modelo | `RECONCILIATION`, `TAX`, `FINANCIAL_ANALYSIS`, `NOTES` | La propuesta con confianza y cita. Ponerlos a **calcular** sería un retroceso (ADR-017) |
| Falta el proveedor | `DOCUMENT` | **BLOQUEADO POR TERCERO** |
| Falta la materia prima | `NORMATIVE_RESEARCH`, `AUDIT` | El corpus normativo y decidir si un hallazgo es fila o derivación |

## 7. Interface — **PARCIAL**, medida por primera vez

`S-25` preguntó ruta por ruta lo que `S-12` preguntaba por dominio: **47 de 293
rutas** estaban escritas, probadas, con permiso y con migración, y sin una línea
de la consola que las nombrara. Se cerraron 14 —incluido el alta del segundo
factor, sin la cual **un CONTADOR no podía usar la consola**, y el cierre de
ejercicio, que pre-cerraba y ahí se cortaba—. Las 33 restantes quedan declaradas
con qué las destraba; la más cara: **el plan de cuentas es de solo lectura**.

## 8. End-to-end loops — **VERIFICADO**

`tests/integration/loop-de-decision.test.ts`, once pasos por HTTP:

```
ERP  factura una venta de 100.000
 ↓
DATA  analytics_operaciones_mensuales dice 100.000, un comprobante
 ↓
INTELLIGENCE  «¿cuánto vendí?» contesta 100.000, con origen y metodología
 ↓
DECISION  un escenario proyecta sobre esa base — no sobre una fixture propia
 ↓
ERP  se crea una lista de precios; el acto queda en la bitácora
 ↓
PUENTE  se declara la aplicación citando esa fila
 ↓
MEDICIÓN  esperado 110.000/mes, real 100.000/mes, diferencia −10.000 (−9,09 %)
```

Cada paso usa la cifra que dejó el anterior: si una capa dejara de leer lo que la
de abajo escribe, el paso siguiente se cae.

## 9. Feedback loops — **IMPLEMENTADO**, sin evidencia acumulada todavía

Existe la infraestructura para contestar las cuatro preguntas: qué se esperaba,
qué se hizo, qué ocurrió, cuál fue la diferencia. Lo que no existe es el
**aprendizaje**, y no por falta de código: con un caso medido no se aprende nada.

## 10. Seguridad — **VERIFICADO**

RLS `FORCE`, `security_invoker` en cada vista, MFA obligatorio por rol, bitácora
encadenada por hash y append-only, permisos por endpoint barridos por `S-18`.

En esta fase `S-18` encontró que la declaración de un escenario aplicado aceptaba
a un usuario de **solo lectura**: escribe un registro inmutable que después se usa
para juzgar una decisión, y un lector no debería poder plantar una predicción.
Ahora exige `analysis:configure`.

## 11. Auditoría — **VERIFICADO**

Cada control de esta fase se rompió a propósito y detectó la regresión:

| Ruptura | Control | ¿Detectó? |
|---|---|---|
| Renombrar `ANULAR_ASIENTO` en el código | S-20 | sí |
| Escribir la acción renombrada contra la base | trigger 0091 | sí |
| Que una respuesta vuelva a la tabla cruda | S-26 | sí |
| Sacar una acción de `ACTIONS_REQUIRING_REASON` | S-20 | sí |
| Dividir el esperado por la ventana en vez de por la base | loop | sí |
| Cambiar la URL de un botón de la consola | S-25 | sí |
| Borrar una excepción de agente | S-21 | sí |

**Un error que encontró un test, no una lectura.** La medición dividía el neto
proyectado por la ventana que el escenario pedía mirar (12 meses) en vez de por
los meses que la base cubría (1). El resultado habría sido un esperado doce veces
más chico que lo real, y el sistema informando que la decisión **superó el
pronóstico siempre**.

## 12. Terceros — **BLOQUEADO**, sin simular

| | Qué falta |
|---|---|
| Proveedor de modelo | Una credencial. El camino está cerrado y probado contra el simulado |
| KMS | Elegir proveedor |
| ARCA producción | Certificado y credenciales reales |
| Pasarela de cobro | Credenciales y decisión de precios |

Ninguno figura como implementado en ningún lado.

## 13. Decisiones pendientes — **REQUIERE DECISIÓN**

Ver `NEXO_ROADMAP.md` para el detalle. En orden de cuánto destraban:

1. **El objetivo empresarial.** Sin él no hay recomendación que no sea la
   preferencia de quien programó el sistema disfrazada de análisis.
2. **Si NEXO debería deducir** que un acto aplica un escenario, en vez de
   esperar que se lo declaren. La respuesta fácil —«el acto más cercano en el
   tiempo»— fabrica atribuciones falsas.
3. **El plan de cuentas** de solo lectura en la consola.
4. **El panel del estudio**: si es una vista más o una aplicación aparte.
5. Qué guarda `constatacion` en ambiente simulado.
6. Consultar a ARCA con el relevamiento vencido.
7. Qué permiso exige guardar un escenario y declarar su aplicación.

---

## CAPABILITIES THAT NOW CROSS LAYERS

### Atraviesan ERP → Data → Intelligence → Decision → ERP → medición

| Capacidad | Evidencia |
|---|---|
| **Ventas** | El loop completo, once pasos por HTTP |
| **Margen** | Métrica → señal (0084) → descomposición precio/costo/volumen → simulación → escenario comparable |
| **Cobranzas** | `collections_by_month` → pregunta del catálogo → proyección de cobranzas → riesgo |

### Atraviesan ERP → Data → Intelligence, y ahí se detienen

Existencias, bienes de uso, cheques en cartera, proyectos, comisiones,
sucursales, centros de costo. Tienen métrica, pregunta y evidencia; **no tienen
escenario**, porque la simulación hoy modela precio, volumen y costo de ventas y
no un plan de compras ni una política de stock.

No es un hueco por descuido: modelar una decisión de compra exige el plazo del
proveedor, el dinero disponible y la política de la empresa — tres cosas que el
sistema tiene en otro lado o no tiene, y ninguna se supone.

### Quedan aisladas

| Capacidad | Por qué |
|---|---|
| Siete de los ocho agentes | Ver §6 |
| El corpus normativo (`norm_articles`, `norm_candidates`, …) | El Normative Update Service del §32 no está construido |
| `alerts`, `audit_findings` | Se derivan de vistas; no las escribe nadie, y está anotado |
| Rotación de stock, rentabilidad por cliente | Derivables, no bloqueadas: falta elegir la metodología |
