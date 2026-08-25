# ACCOUNTING_ENGINE.md

> Motor contable determinístico. **No usa IA, no llama a la red, no lee archivos.** Es una
> función pura sobre datos: dado un borrador de asiento y el estado del libro, decide si el
> asiento puede existir y con qué número.

## 1. Contrato

```ts
type JournalEntryDraft = {
  companyId: CompanyId;
  journalCode: JournalCode;      // GENERAL | COMPRAS | VENTAS | BANCOS | CAJA | SUELDOS | AJUSTES | CIERRE | APERTURA
  entryDate: CalendarDate;       // fecha contable
  description: string;
  kind: 'NORMAL' | 'AJUSTE' | 'APERTURA' | 'CIERRE' | 'REVERSION';
  lines: Array<{
    accountCode: string;
    debit: Money;                // entero en centavos
    credit: Money;
    currency: Currency;
    fx?: { rate: Decimal; source: string; date: CalendarDate };
    costCenterCode?: string;
    partyId?: PartyId;
    description?: string;
  }>;
  source: { type: 'INVOICE' | 'RECEIPT' | 'BANK' | 'MANUAL' | 'CLOSING'; id: string };
  ruleApplications: RuleApplicationRef[];   // trazabilidad normativa
  actor: { userId: UserId; onBehalfOfAi?: AiPredictionId };
};

postJournalEntry(draft): Result<JournalEntry, AccountingError[]>
```

Devuelve `Result`, no lanza. Un asiento rechazado produce una lista de errores tipados y
accionables, porque el destinatario es un contador que necesita saber **qué** corregir.

---

## 2. Validaciones, en orden

| # | Validación | Error |
|---|-----------|-------|
| 1 | El asiento tiene ≥ 2 líneas | `E_MIN_LINES` |
| 2 | Cada línea es débito **o** crédito, con importe > 0 | `E_LINE_SIDE` |
| 3 | Σ débitos = Σ créditos, **en la moneda de la contabilidad** | `E_UNBALANCED` |
| 4 | Todas las cuentas existen, están activas y son imputables | `E_ACCOUNT_NOT_POSTABLE` |
| 5 | La fecha cae dentro de un período con estado `ABIERTO` | `E_PERIOD_CLOSED` |
| 6 | La fecha cae dentro del ejercicio del período | `E_DATE_OUT_OF_PERIOD` |
| 7 | Si la cuenta exige centro de costo o tercero, están presentes | `E_MISSING_DIMENSION` |
| 8 | Si hay moneda extranjera, hay cotización con fuente y fecha | `E_MISSING_FX` |
| 9 | Toda línea con efecto fiscal tiene su `tax_transaction` | `E_TAX_LINK_MISSING` |
| 10 | Existe al menos una `ruleApplication` o una justificación manual firmada | `E_NO_TRACEABILITY` |
| 11 | El asiento no duplica un `source` ya posteado | `E_DUPLICATE_SOURCE` |

La #3 se verifica **dos veces**: en el motor y por constraint diferido en PostgreSQL
(`DATABASE.md` §7.1). Redundancia deliberada: el invariante más importante del sistema no depende
de que la aplicación esté libre de bugs.

La #10 es lo que hace que la trazabilidad del §24 sea estructural: un asiento sin origen
demostrable **no se puede postear**, ni siquiera manualmente — el humano debe firmar el motivo.

---

## 3. Redondeo y moneda

- Toda la aritmética en enteros de centavos. **`float` está prohibido en el paquete** (regla de lint).
- La conversión de moneda extranjera guarda `rate`, `source` y `date`; la diferencia de redondeo
  se imputa a una cuenta configurable de *diferencias de cambio*, nunca se "reparte".
- Una línea guarda **dos** importes en columnas distintas (migración `0020`): `debit`/`credit` es lo
  registrado en moneda de contabilidad —lo que el libro suma, CCyC art. 325— y `original_*` es la
  operación tal como ocurrió. Sin el primero el libro no suma; sin el segundo la conversión no se
  puede rehacer.
- El criterio de redondeo (medio arriba, medio par, truncamiento) es **parámetro normativo por
  operación**, no una constante del código (ADR-005).
- Cuando la suma de líneas redondeadas no cierra, el motor **rechaza**; no ajusta en silencio.

---

## 4. Numeración

- Correlativa, sin huecos, por `(company, journal, fiscal_year)`.
- Se asigna **dentro de la transacción del posteo**, con advisory lock por libro, después de que
  todas las validaciones pasaron.
- Un asiento anulado **conserva su número**. El hueco sería peor que el asiento anulado.
- La numeración es una propiedad del libro, no un `autoincrement` global.

---

## 5. Anulación, modificación y ajuste (§15, §38)

```
NUNCA:  DELETE FROM journal_entries
NUNCA:  UPDATE journal_entry_lines SET debit = …   (en asiento APROBADO)
```

| Situación | Mecanismo |
|-----------|-----------|
| Asiento en `BORRADOR` o `PROPUESTO` | Se edita libremente. Todavía no es contabilidad |
| Asiento `APROBADO` con error, período abierto | **Contraasiento** (`kind = REVERSION`, `reverses_entry_id`) + asiento correcto. Ambos quedan visibles |
| Asiento `APROBADO`, período cerrado | Ajuste en período abierto, o reapertura formal del período con motivo, doble firma y registro en `audit_logs` |
| Corrección de un dato no contable (descripción) | Permitida, versionada en `audit_logs` con valor anterior y nuevo |

El Libro Diario impreso debe poder reproducirse idéntico años después. Por eso la historia es
inmutable y las correcciones son **hechos nuevos**, no reescrituras.

---

## 6. Períodos, apertura y cierre (§36)

```
ABIERTO ──bloquear──► BLOQUEADO ──cerrar──► CERRADO
   ▲                                            │
   └──────── reapertura con doble firma ────────┘
```

- `BLOQUEADO`: nadie postea salvo el rol de cierre (ajustes de cierre).
- `CERRADO`: nadie postea. Punto.
- **Reapertura**: requiere rol Administrador + rol Contador (dos personas distintas), motivo
  obligatorio, y genera alerta. Queda en el log encadenado.
- Cierre de ejercicio: asientos de refundición de cuentas de resultado y de determinación del
  resultado del ejercicio, generados por el motor y **aprobados por el contador**, nunca automáticos.
- Apertura del ejercicio siguiente: asiento espejo del estado de situación patrimonial de cierre.

El checklist del §36 corre como precondición del cierre; cada ítem es una consulta determinística
(bancos conciliados, comprobantes sin asiento, asientos sin comprobante, saldos inusuales…) y su
resultado queda archivado en `accounting_closures.checklist`.

---

## 7. Mayor y saldos (§16)

El Libro Mayor **no es una tabla independiente**: es una proyección del Diario. Se materializa en
`ledger_movements` + `account_balances` por rendimiento, con dos garantías:

1. **Reconstruibilidad**: `npm run ledger:verify` reconstruye el Mayor completo desde el Diario y
   verifica que coincide con lo materializado. Corre en cada cierre y en `npm run verify`. El
   resultado queda en `ledger_verifications` con fecha y nombre.
2. **Reversibilidad**: cada movimiento del Mayor apunta a su `journal_entry_line`, que apunta a su
   asiento, que apunta a su comprobante, que apunta a su documento.

Si el Mayor y el Diario discrepan, el Diario gana y se emite alerta crítica.

Desde la migración `0019` la aplicación **no puede escribir** `ledger_movements`: lo hace un trigger
diferido cuando un asiento pasa a `APROBADO`, y a `aai_app` se le revoca el `INSERT`. Un movimiento
tampoco se borra nunca, ni al anular el asiento — lo compensa el contraasiento, y borrarlo además lo
contaría dos veces. El detalle está en [BOOKS.md](BOOKS.md).

---

## 8. Balance de sumas y saldos

Salida canónica del motor, y la prueba de vida del sistema:

```
Σ débitos del período  =  Σ créditos del período
Σ saldos deudores      =  Σ saldos acreedores
Saldo inicial + débitos − créditos = saldo final   (por cuenta)
```

Las tres igualdades se verifican en cada corrida y son un test de integración obligatorio del
pipeline. Si alguna falla, el sistema entra en modo degradado y **no emite estados contables**.

---

## 9. Lo que el motor deliberadamente NO hace

| No hace | Quién lo hace |
|---------|---------------|
| Decidir a qué cuenta va un gasto | `ai-engine` propone, humano aprueba |
| Calcular el IVA | `tax-engine`, con alícuotas de `normative-engine` |
| Saber qué norma aplica | `normative-engine` |
| Leer un PDF | `document-engine` |
| Decidir la estructura del balance | `financial-statements` con plantilla versionada |

Esta lista es la razón por la que el motor se puede testear de forma exhaustiva: su superficie es
pequeña y su comportamiento no depende de nada externo.
