# AUDIT_TRAIL.md — Trazabilidad y Auditoría

> §21 y §24. Este documento describe cómo el sistema responde, para **cualquier** número que
> muestre, la pregunta: *"¿de dónde salió este importe?"*.

## 1. Dos mecanismos distintos

| Mecanismo | Pregunta que responde | Tabla |
|-----------|----------------------|-------|
| **Bitácora** (`audit_logs`) | ¿Quién hizo qué, cuándo y por qué? | Append-only encadenado |
| **Linaje** (`lineage_edges`) | ¿De qué se compone esta cifra? | Grafo append-only |

Se confunden a menudo. No son lo mismo: la bitácora registra **acciones**; el linaje registra
**derivaciones de datos**. Ambos son necesarios.

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
| A-3 | Todo `journal_entry` aprobado tiene `source` o justificación manual firmada |
| A-4 | Todo `rule_application` apunta a una `norm_version` existente con documento y hash |
| A-5 | La cadena de `audit_logs` es continua para cada empresa |
| A-6 | Ningún `journal_entry` fue creado por un actor `AI` sin `approved_by` humano |
| A-7 | El Mayor reconstruido desde el Diario coincide con `ledger_movements` |
| A-8 | Ninguna `accounting_rule` en estado `ACTIVE` carece de `approved_by` |

A-6 es la verificación mecánica de la promesa central del producto. Si alguna vez falla, el
producto dejó de ser lo que dice ser.

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
