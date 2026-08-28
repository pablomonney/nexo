# AUDIT_TRAIL.md — Trazabilidad y Auditoría

> §21 y §24. Este documento describe cómo el sistema responde, para **cualquier** número que
> muestre, la pregunta: *"¿de dónde salió este importe?"*.

## 1. Dos mecanismos distintos

| Mecanismo | Pregunta que responde | Tabla |
|-----------|----------------------|-------|
| **Bitácora** (`audit_logs`) | ¿Quién hizo qué, cuándo y por qué, **en una empresa**? | Append-only encadenado |
| **Bitácora normativa** (`normative_audit_logs`) | ¿Quién aprobó esta regla, y contra qué? | Append-only encadenado |
| **Linaje** (`lineage_edges`) | ¿De qué se compone esta cifra? | Grafo append-only |

Se confunden a menudo. No son lo mismo: la bitácora registra **acciones**; el linaje registra
**derivaciones de datos**. Ambos son necesarios.

### Por qué son dos bitácoras y no una

`audit_logs.company_id` es `NOT NULL`, su política de RLS es
`company_id = app_company_id()` y su cadena de hash se encadena **por empresa**.
Nada de eso es incidental: es lo que hace que un inquilino no pueda leer la
operación de otro dentro del registro que dice quién hizo qué.

Una **regla** no pertenece a ninguna empresa —`accounting_rules` ni siquiera
tiene RLS—, así que su aprobación no cabe ahí. Durante un tiempo se intentó:
`aprobar-regla.mjs` insertaba con `company_id = NULL`, la inserción fallaba con
`23502` **después** del `UPDATE`, y el `catch` revertía la activación entera. El
comando nunca pudo aprobar nada, y no se notó porque nunca se aprobó una regla —
el §32 exige la firma, y la firma no tenía dónde escribirse—.

La salida no era aflojar el `NOT NULL`: eso habría abierto una fila invisible
para todos los inquilinos dentro de la bitácora contable. Es reconocer que un
acto normativo no ocurre dentro de una empresa (migración `0041`). En
`normative_audit_logs` el `motivo` además **no es opcional**: mínimo 30
caracteres, por CHECK. Una firma que no dice qué se revisó es lo que el §32 pide
que no pase.

---

## 2. Bitácora

Se registra creación, modificación, aprobación, rechazo, eliminación lógica, ajustes, cambios de
configuración, de plan de cuentas, de reglas y de normativa (§21).

```
id · company_id · actor_type (USER|SYSTEM|AI) · actor_id · action · object_type · object_id
old_value · new_value · motivo · ip · user_agent · occurred_at · prev_hash · hash
```

Propiedades:
- **Append-only real**: `UPDATE` y `DELETE` revocados a nivel de rol de base de datos, no por
  convención de código.
- **Encadenada**: `hash = sha256(prev_hash || payload)` por empresa. Alterar un registro pasado
  invalida toda la cadena posterior, y eso es detectable.
- `motivo` es **obligatorio** en acciones destructivas o excepcionales: anulación, reapertura de
  período, cambio de regla, reclasificación posterior a la aprobación.
- `actor_type = AI` registra además agente, proveedor, `model_id` y `prompt_hash`.

Verificador: `scripts/verify-audit-chain` recorre la cadena y reporta la primera discontinuidad.
Corre en cada cierre de período.

---

## 3. Linaje bidireccional

### 3.1 Descendente — de la cifra al documento

```
ESTADO CONTABLE
  └─ renglón (financial_statement_lines.lineage_id)
      └─ CUENTA
          └─ MAYOR (ledger_movements)
              └─ LÍNEA DE ASIENTO
                  └─ ASIENTO
                      └─ COMPROBANTE
                          └─ DOCUMENTO ORIGINAL (sha256)
                              └─ FUENTE NORMATIVA (norm_version + sha256 del texto)
```

### 3.2 Ascendente — del documento a la nota

```
DOCUMENTO → COMPROBANTE → ASIENTO → MAYOR → ESTADO CONTABLE → NOTA
```

Ambas direcciones se resuelven sobre la misma tabla `lineage_edges`, recorriéndola en el sentido
que corresponda. No hay lógica especial por tipo de reporte — por eso funciona igual para un
renglón del balance, para una cifra de una nota y para un anexo.

### 3.3 La consulta

```sql
WITH RECURSIVE trace AS (
  SELECT * FROM lineage_edges WHERE company_id = $1 AND to_type = $2 AND to_id = $3
  UNION ALL
  SELECT e.* FROM lineage_edges e JOIN trace t
    ON e.to_type = t.from_type AND e.to_id = t.from_id
  WHERE e.company_id = $1
)
SELECT * FROM trace;
```

Un solo recorrido recursivo. La UI lo expone como el botón *"¿de dónde salió este importe?"*,
disponible sobre **cualquier** cifra del sistema.

---

## 4. Invariantes verificados en CI

Estos tests fallan el build, no emiten advertencias:

| # | Invariante |
|---|-----------|
| A-1 | Todo `financial_statement_lines.lineage_id` resuelve a ≥ 1 asiento aprobado |
| A-2 | Todo `note_figures.lineage_id` resuelve a ≥ 1 asiento aprobado |
| A-3 | Todo `journal_entry` aprobado tiene comprobante, justificación firmada o decisión contable |
| A-4 | Todo `rule_application` apunta a una `norm_version` existente con documento y hash |
| A-5 | La cadena de `audit_logs` es continua para cada empresa |
| A-6 | Ningún `journal_entry` fue creado por un actor `AI` sin `approved_by` humano |
| A-7 | El Mayor reconstruido desde el Diario coincide con `ledger_movements` |
| A-8 | Ninguna `accounting_rule` en estado `ACTIVE` carece de `approved_by` |
| A-9 | Toda aplicación de regla congeló el hash del documento normativo que citó |
| A-10 | Ningún asiento aprobado se funda en una decisión de ambiente `PRUEBA` |
| A-11 | Todo ejercicio `CERRADO` tiene su cierre completado, y viceversa |
| A-12 | Los asientos de cierre pertenecen al ejercicio que su expediente dice cerrar |
| A-13 | Toda apertura deriva de un cierre completado del ejercicio anterior |
| A-14 | Ningún ejercicio cerrado tiene asientos que no sean de su propio cierre |

### Los cuatro estados

Un invariante no tiene dos resultados posibles sino cuatro, y confundir dos de
ellos fue exactamente el falso verde del 2026-08-28:

| Estado | Qué significa | ¿Corta el build? |
|---|---|---|
| `VERIFIED` | hay casos y ninguno viola la propiedad | no |
| `VIOLATED` | hay al menos un caso que la viola | **sí, siempre** |
| `NOT_EXERCISED` | exige ejercicio y no hubo ni un caso | **sí, en modo conductual** |
| `VACUO_PERMITIDO` | no hubo casos, y está declarado por qué no puede haberlos | no |

La distinción entre los dos últimos **no es una etiqueta**. Cada invariante
declara una de las dos políticas y no puede omitir las dos: o `ejercicio:
'REQUERIDO'` —y entonces el fixture conductual tiene que producirle casos— o
`vacuoPermitido: '<motivo>'`, que obliga a escribir por qué hoy es imposible
ejercitarlo. Ese motivo se imprime en cada corrida: es una deuda a la vista, no
un permiso. Un invariante nuevo que se olvide de declarar cae en
`NOT_EXERCISED` y corta el build.

Hoy hay cinco `VACUO_PERMITIDO`: **A-4, A-8 y A-9** necesitan una regla en
estado `ACTIVE` y el sistema tiene cero por decisión de producto; **A-1 y A-2**
necesitan un estado contable emitido, y `/statements/issue` no puede completarse
para ninguna empresa con un plan de cuentas completo (ver los gaps de
`STATEMENTS.md`).

### Cómo se corren

```bash
npm run audit:estructura    # ¿están los candados? no necesita datos
npm run audit:invariants    # ¿las filas cumplen? crea su base y sus fixtures
npm run ledger:verify       # ¿el Mayor coincide con el Diario? ídem
```

Los tres son parte de `npm run verify` y de CI. Son **dos preguntas distintas**:
la estructural verifica que existan los CHECK, triggers, índices únicos, RLS
forzado y vistas con `security_invoker` de los que dependen los invariantes; la
conductual verifica que las filas que hay cumplan la propiedad. Una base recién
migrada y vacía tiene que dar estructural verde y conductual sin ejercitar — si
las dos se mezclaran en un solo número, nadie sabría cuál de las dos mitades
falta.

Y ninguna de las dos reemplaza a los tests: un trigger que existe pero que nunca
recibió una fila válida y una inválida no está probado.

#### El modo conductual, y por qué se crea su propia base

`audit:invariants` destruye y rehace `aai_verify`, la migra, la siembra
**recorriendo los flujos productivos reales** —altas de asiento por las tres vías
de trazabilidad, aprobación, contraasiento, propuesta de IA revisada, decisión
contable, pre-cierre, cierre y apertura, en dos empresas— y recién entonces
verifica. Los fixtures escriben por HTTP y no por `INSERT`: un fixture que arma
las filas a mano produce el estado final sin pasar por los candados que el
invariante promete proteger, y el `CONSTRAINT TRIGGER` del `Debe = Haber` solo
dispara en el COMMIT.

La base de desarrollo no se toca: ni se lee ni se escribe. Verificar no puede
tener efectos colaterales sobre el trabajo de nadie.

Hay también un modo `--observacional` que mira la base que se le indique tal
como está. Sirve para preguntarle a una base real si cumple, y **no afirma
cobertura**: sus `NOT_EXERCISED` se informan y no cortan, porque que una base no
tenga cierres no es un defecto de la base.

### La causa del falso verde, para no repetirla

El 2026-08-27 los tests de integración se aislaron en `aai_test`. Era necesario
—escribían en la base de desarrollo y no podían limpiar— y estaba bien hecho.
Pero `audit:invariants` corría contra la base de desarrollo, y los datos que
venía mirando eran, sin que nadie lo hubiera decidido, los que esos tests
dejaban. El aislamiento le sacó al gate lo único que estaba viendo.

Nadie rompió nada: un arreglo correcto en un lugar dejó ciego a un gate en otro,
y el gate siguió diciendo que sí. Por eso lo que cambió no fue una consulta sino
**quién decide que un invariante pasó**, y por eso el gate tiene ahora sus
propios tests (`tests/integration/gate-de-invariantes.test.ts`).

#### El mismo falso verde estaba en otros dos lugares

Arreglarlo para los invariantes no lo arregló para los demás gates, y el
2026-08-28 la auditoría encontró que:

- **`ledger:verify` tenía la forma exacta del defecto.** Corría contra la base de
  desarrollo, salía con 0 diciendo «no hay empresas», y tenía además un camino
  más silencioso: una empresa **sin un solo movimiento** no produce discrepancias,
  así que imprimía `✔ el Mayor coincide con el Diario` sin haber comparado nada.
  Encima **no estaba en CI**. Hoy usa los mismos cuatro estados, corre en modo
  conductual sobre `aai_verify` con los mismos fixtures, y falla si no hubo
  movimientos que comparar.
- **CI corría `npm test`, no `npm run test:coverage`.** Los umbrales de cobertura
  por paquete solo se hacían cumplir en el `verify` local.

- **La política de ejercicio era decorativa.** `ejercicio: 'REQUERIDO'` estaba
  escrito en once invariantes y no lo leía nadie: la clasificación miraba
  únicamente si existía `vacuoPermitido`. Un invariante nuevo que no declarara
  nada caía en `NOT_EXERCISED` por accidente y no por diseño, uno que declarara
  las dos cosas se comportaba como la más débil, y `'REQUERIDA'` —una letra— no
  lo detectaba nadie. Ahora la lista **se valida al cargarse** (`validarPoliticas`)
  y un error revienta el módulo en vez de degradar el gate en silencio.

Cuando un invariante puede convertirse en candado, se convierte: **A-3** es desde
la migración `0025` un CHECK sobre `journal_entries` —extendido en la `0037`
para reconocer la tercera vía de trazabilidad—. Un invariante que solo se
verifica después ya se violó cuando se detecta.

A-6 es la verificación mecánica de la promesa central del producto. Si alguna vez
falla, el producto dejó de ser lo que dice ser.

---

## 5. Reportes de auditoría

Generables por período y exportables (§39):

- Asientos generados con intervención de IA vs. manuales, con tasa de modificación humana.
- Operaciones de baja confianza y su resolución.
- Comprobantes sin asiento / asientos sin comprobante.
- Movimientos bancarios sin contrapartida contable.
- Reaperturas de período, con motivo y firmantes.
- Cambios de reglas normativas y su impacto en asientos ya registrados.
- Cambios en el plan de cuentas.
- Accesos y descargas de documentación por usuario.
- Verificación de la cadena de hashes de la bitácora.

---

## 6. Sistema de alertas (§22)

| Alerta | Severidad | Disparador |
|--------|-----------|------------|
| Comprobante duplicado | Alta | hash idéntico o clave lógica repetida |
| Asiento descuadrado | Crítica | *no debería poder ocurrir* → indica corrupción o bug |
| IVA inconsistente | Alta | recalculado ≠ declarado en el comprobante |
| Cuenta inusual para el proveedor | Media | desvío del histórico |
| Proveedor nuevo | Media | primera operación con ese CUIT |
| Proveedor marcado apócrifo | Crítica | `wsapoc` |
| Importe anormal | Media | outlier respecto de la serie de la cuenta |
| Movimiento bancario sin comprobante | Media | conciliación |
| Comprobante sin asiento / asiento sin comprobante | Alta | control cruzado |
| Saldo negativo imposible (caja, stock) | Alta | control de signo por naturaleza de cuenta |
| Cambio de normativa con impacto retroactivo | Alta | `Normative Update Service` |
| Período pendiente de cierre | Media | calendario |
| Vencimiento de presentación (IGJ, fiscal) | Media | calendario normativo por jurisdicción |

Cada alerta guarda su evidencia en `payload` y queda ligada al objeto que la originó. Una alerta
reconocida registra quién la reconoció y por qué — no se puede "hacer desaparecer" en silencio.
