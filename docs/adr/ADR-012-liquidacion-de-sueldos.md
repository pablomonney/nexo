# ADR-012 — Dónde entraría la liquidación de sueldos, y dónde no

**Estado:** ACEPTADO como restricción de diseño. **No implementado, y no se
implementa en esta fase.**

**Contexto:** NEXO tiene que poder convertirse en una plataforma integral. La
pregunta que este documento contesta no es *cómo* liquidar sueldos, sino **qué
límites tiene que respetar ese módulo para no romper lo que ya funciona**.

---

## 1. La decisión, en una línea

> La liquidación de sueldos es **otro dominio** que produce asientos, igual que
> lo hace hoy el subsistema de comprobantes. Entra al Diario por el mismo puente
> —una decisión con evidencia— y **no comparte una sola tabla** con el motor
> fiscal de IVA.

Todo lo demás son consecuencias de esto.

## 2. Por qué no es un módulo del motor fiscal

Es la confusión más fácil de cometer, porque las dos cosas «son impuestos». No lo
son en ningún sentido que importe para el modelo:

| | IVA | Cargas sociales y ganancias 4ª |
|---|---|---|
| Hecho imponible | una operación con un tercero | una relación de trabajo |
| Prueba | un comprobante con CAE, constatable | un recibo que emite el propio empleador |
| Norma | Ley 23.349 y su decreto | LCT, Ley 24.241, 24.714, convenios colectivos |
| Quién fija los números | el organismo | **la paritaria de cada actividad** |
| Verificable contra un tercero | sí, WSCDC | no: no hay un servicio que diga «esta liquidación está bien» |
| Período | mensual, cerrado | mensual, con SAC semestral y vacaciones que cruzan ejercicios |

La última fila es la que decide. El motor fiscal está construido sobre la idea de
que **hay un tercero al que preguntarle**: la constatación, el padrón, el CAE. La
liquidación de sueldos no tiene ese tercero. Meterla en el mismo motor obligaría
a aflojar la frontera `dato constatado ≠ dato declarado` que la migración `0043`
acaba de establecer, y esa frontera es lo que impide que un comprobante apócrifo
entre como bueno.

## 3. Qué debería reutilizar

Casi toda la infraestructura, y **ninguna** de las tablas fiscales.

| Se reutiliza | Cómo |
|---|---|
| `companies`, RLS, `withCompany` | sin excepciones: un legajo es de una empresa, punto |
| `periods` y `fiscal_years` | una liquidación pertenece a un período contable; los candados de período cerrado aplican igual |
| `accounting_decisions` | **el puente**. Una liquidación aprobada produce una decisión con su evidencia |
| `journal_entries` / `journal_entry_lines` | el asiento de sueldos entra por donde entran todos, con Debe = Haber |
| `audit_logs` | mismo encadenado por empresa. Un cambio de sueldo es de las cosas más sensibles que registra un sistema |
| `documents` | el recibo firmado, el convenio, la constancia de alta: archivados con hash como cualquier otro |
| `accounting_rules` y el motor normativo | **con reservas**: ver §6 |
| `norm_documents` y el archivo con SHA-256 | los convenios y escalas se archivan igual que una RG |

| **No** se reutiliza | Por qué |
|---|---|
| `tax_transactions` | modela un comprobante con CAE, punto de venta y contraparte. Un recibo de sueldo no tiene nada de eso |
| `tax_affectations` | la afectación responde «¿se vincula con operaciones gravadas?». No aplica |
| `arca_query_log` | otro organismo, otro servicio, otra semántica de respuesta |
| El catálogo de `EstadoConstatacion` | `APROBADO/RECHAZADO/NO_VERIFICABLE` describe una respuesta del WSCDC |

## 4. Cómo entraría una liquidación al Diario

El mismo recorrido que ya existe, con otro origen:

```
LEGAJO + NOVEDADES
   ↓
LIQUIDACIÓN (calculada, revisable, todavía sin efecto contable)
   ↓
APROBACIÓN PROFESIONAL  ── firma humana, como todo asiento
   ↓
accounting_decision  (origen = 'LIQUIDACION', evidencia = [LIQUIDACION, DOCUMENTO])
   ↓
journal_entry  (kind = 'NORMAL', journalCode = 'SUELDOS', source_type = 'PAYROLL')
   ↓
DIARIO → MAYOR → ESTADOS
```

Tres consecuencias que hay que aceptar de entrada:

1. **`source_type` necesita un valor nuevo** (`PAYROLL`), y `journals` ya prevé
   el libro `SUELDOS`. Eso es todo lo que el motor contable tiene que cambiar.
2. **La evidencia necesita un tipo nuevo** (`LIQUIDACION`) en el catálogo de
   `assert_evidence_exists`. Es una línea en un `CASE`, y es lo correcto: la
   evidencia de un asiento de sueldos es la liquidación que lo produjo.
3. **`accounting_decisions.origen` necesita `'LIQUIDACION'`**, distinto de
   `MANUAL` y de `DETERMINISTICA`. Una liquidación no es una decisión que alguien
   tomó a mano ni una que salió de una regla de IVA: es un cálculo de otro motor,
   aprobado por una persona.

Ninguno de los tres afloja un candado existente. Los tres amplían un catálogo
cerrado, que es exactamente para lo que sirve tener catálogos cerrados.

## 5. Qué información tiene que ser independiente

**Todo el legajo.** Datos personales, domicilio, categoría, antigüedad,
remuneración, embargos, obra social, familiares a cargo. Nada de eso puede vivir
en tablas que el motor fiscal consulta, por dos razones:

- **Legal.** Son datos personales de un tercero que no es cliente del estudio, y
  algunos son datos sensibles (salud, en el caso de la obra social y las
  licencias). El §21 y la Ley 25.326 piden un tratamiento distinto del que
  recibe una factura.
- **De diseño.** Si el motor de IVA pudiera leer un sueldo, alguien terminaría
  usándolo, y la separación duraría hasta la primera urgencia.

La propuesta concreta: **esquema propio** (`payroll.*`) con su RLS por empresa, y
una sola superficie de contacto —la decisión y el asiento— igual que hoy
`tax_transactions` toca al motor contable solo por `decision_id` y `source_id`.

## 6. Dependencias normativas, y por qué son peores

El motor normativo sirve, pero el corpus laboral tiene una propiedad que el
fiscal no tiene: **cambia por paritaria, por actividad, y con efecto
retroactivo**. Una escala salarial homologada en septiembre puede regir desde
julio, y hay que poder reliquidar.

Eso significa que:

- `norm_versions` y su eje de vigencia **alcanzan**, y son justamente lo que hace
  falta: el §6 —«no usar la norma de hoy para una operación de ayer»— es todavía
  más crítico acá.
- Hace falta un tipo de norma nuevo: `CONVENIO_COLECTIVO`, con su número de
  homologación, y `ESCALA_SALARIAL` como parámetro versionado —el mismo
  mecanismo que ya usa `FACPCE PARAMETRO`—.
- **Y hace falta aceptar que el corpus no se puede archivar completo.** Hay
  cientos de convenios. El sistema tendría que soportar «esta empresa opera bajo
  el CCT 130/75» y archivar **solo ese**, respondiendo `FUENTE NO ENCONTRADA`
  para los demás. Es el mismo criterio que hoy se aplica a las adopciones
  jurisdiccionales de los consejos.

**Ninguna escala se infiere.** Un sueldo básico que el sistema no tiene archivado
no se estima ni se arrastra del mes anterior: se pide.

## 7. Los límites que el módulo no puede cruzar

Escritos como restricciones, para que se puedan convertir en tests el día que se
implemente:

1. **No escribe en `journal_entries` directamente.** Pasa por una decisión, como
   todo lo demás.
2. **No aprueba sus propios asientos.** La firma es humana y separada del cálculo.
3. **No lee ni escribe `tax_transactions` ni `tax_affectations`.**
4. **No consulta ARCA por su cuenta.** El F931 es una presentación, no una
   constatación, y va por otro camino cuando exista.
5. **No inventa una escala.** Sin convenio archivado y vigente a la fecha de la
   liquidación, el resultado es `REQUIERE_REVISION`, no un número aproximado.
6. **No calcula sobre un período cerrado.** Los candados de `periods` y
   `fiscal_years` aplican sin excepción.
7. **Una liquidación aprobada es inmutable.** Se corrige con otra que la
   supersede, encadenada — el mismo mecanismo que las decisiones (`0044`) y las
   notas (`0040`).
8. **La IA no liquida.** Puede redactar una explicación de un recibo; no puede
   determinar un concepto ni un importe. ADR-001 se extiende tal cual: el lint
   debe impedir que `ai-engine` importe el motor laboral.

## 8. Qué habría que decidir antes de escribir una línea

Tres preguntas abiertas que **no** son técnicas y que bloquean el diseño:

- **¿Qué convenios se soportan al inicio?** El corpus completo no es viable.
  `REQUIRES_EXTERNAL_INPUT`.
- **¿Se emite el recibo o solo se liquida y se contabiliza?** Emitir supone
  cumplir la Ley 27.555 de recibo digital, que es un producto en sí mismo.
  `PRODUCT_DECISION`.
- **¿Quién firma la liquidación?** En el modelo actual el CONTADOR firma la
  contabilidad. Una liquidación la suele revisar alguien de RR.HH. y firmarla el
  contador. Hace falta un rol nuevo o no. `PROFESSIONAL_REVIEW`.

## 9. Estimación honesta

No es un módulo: es un producto del tamaño del motor fiscal actual, con un
corpus normativo más grande, más volátil y peor documentado. Cualquier plan que
lo trate como «una tabla de empleados y un cálculo» va a chocar con la primera
paritaria retroactiva.

Lo que esta arquitectura garantiza es que ese producto **pueda** construirse al
lado sin tocar lo que ya funciona. Eso es lo que se decidió acá, y es todo lo que
se decidió.
