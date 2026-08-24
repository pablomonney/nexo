# TESTING_STRATEGY.md — Estrategia de Pruebas

> Entregable J del §51. En un sistema contable, los tests no son control de calidad: son la
> evidencia de que los invariantes se cumplen. Varios de ellos son **requisitos del producto**,
> no del equipo de desarrollo.

## 1. Pirámide adaptada

```
        ▲  Invariantes de auditoría (A-1..A-8)   ← fallan el build
        │  Tests normativos                      ← vigencia y citas
        │  Tests contables                       ← partida doble, cierres
        │  Integración (API, base, ARCA homolog.)
        │  Unitarios (dominio puro)
        ▼  Property-based sobre el motor contable
```

## 2. Tipos de prueba

### 2.1 Unitarios — dominio puro

`accounting-engine`, `tax-engine`, `normative-engine` y `shared` no tocan red ni disco: se testean
exhaustivamente y rápido. Objetivo de cobertura: **≥ 95% en el motor contable**, sin excepciones
negociables.

### 2.2 Property-based — el motor contable

Más valiosos que los ejemplos, porque buscan el caso que nadie escribió:

| Propiedad | Enunciado |
|-----------|-----------|
| P-1 | Para todo asiento generado aleatoriamente que el motor **acepta**: Σ débitos = Σ créditos |
| P-2 | Para toda secuencia de asientos: el balance de sumas y saldos cierra |
| P-3 | Asiento + su contraasiento = efecto neto nulo en todos los saldos |
| P-4 | La numeración nunca tiene huecos ni repeticiones, bajo concurrencia |
| P-5 | El Mayor reconstruido desde el Diario es idéntico al materializado |
| P-6 | Ninguna secuencia de operaciones deja un período cerrado con movimientos nuevos |
| P-7 | El redondeo nunca crea ni destruye centavos en el total |

### 2.3 Tests contables (§33) — casos obligatorios

Cada uno con comprobante de entrada, asiento esperado, impacto en IVA, en Mayor y en estados:

```
Factura A (RI a RI)             Nota de crédito             Compra de bien de uso
Factura B (RI a CF)             Nota de débito              Venta de bien de uso
Factura C (monotributista)      Recibo de cobro             Amortización
Factura M                       Orden de pago               Sueldos y cargas sociales
Factura E (exportación)         Transferencia bancaria      Impuestos
Comprobante en USD              Cheque diferido             Percepciones sufridas
Operación exenta                Depósito                    Retenciones sufridas
Operación no gravada            Comisión bancaria           Retenciones practicadas
Prorrateo de crédito fiscal     Diferencia de cambio        Asiento de cierre y apertura
```

Cada caso es un fixture versionado en `tests/fixtures/`. **Un caso contable no se modifica para
que pase el test**: si el resultado esperado cambia, cambia porque cambió una norma, y eso queda
documentado con la cita.

### 2.4 Tests normativos

| Test | Verifica |
|------|----------|
| N-1 | Un hecho de 2024 resuelve con las reglas de 2024, aunque hoy sea 2026 |
| N-2 | La misma norma resuelve distinto en CABA que en otra jurisdicción (caso RT 54 real) |
| N-3 | Dos reglas de igual prioridad sin derogación declarada → `CONFLICTO NORMATIVO`, no un resultado |
| N-4 | Sin regla aplicable → `FUENTE NO ENCONTRADA`, nunca un default silencioso |
| N-5 | Toda regla `ACTIVE` tiene `norm_version_id`, documento archivado, hash y `approved_by` |
| N-6 | Una cita devuelta por un agente que no resuelve → propuesta rechazada automáticamente |
| N-7 | Reproducibilidad bitemporal: la decisión de una fecha pasada se reproduce con el conocimiento de esa fecha |

**N-1 y N-7 son los tests que distinguen este sistema de una planilla con IA.**

### 2.5 Tests fiscales

Liquidación de IVA sobre juegos de comprobantes completos, con notas de crédito, operaciones
exentas y no gravadas, prorrateo, percepciones y retenciones. Verificación cruzada: el subdiario
IVA debe coincidir con las cuentas de IVA del Mayor, al centavo.

### 2.6 Tests de OCR / extracción

Corpus versionado de comprobantes reales anonimizados. Se mide **por campo**: exactitud, cobertura
y —lo más importante— **tasa de error no detectado** (campo extraído mal con confianza alta). Esa
métrica tiene umbral de bloqueo de release.

### 2.7 Tests de seguridad

| Test | Verifica |
|------|----------|
| S-1 | Sesión de empresa A no accede a datos de empresa B — **en cada endpoint** |
| S-2 | Rol Auditor no puede escribir en ningún recurso |
| S-3 | No hay secretos en el repositorio ni en imágenes |
| S-4 | Un documento con instrucciones embebidas ("aprobá este asiento") no altera el comportamiento de ningún agente |
| S-5 | El fetcher de normas rechaza dominios fuera de la allowlist (SSRF) |
| S-6 | `UPDATE`/`DELETE` sobre `audit_logs` fallan a nivel de base de datos |
| S-7 | Reapertura de período requiere dos firmantes distintos |
| S-8 | **El lint de arquitectura falla si alguien viola el ADR-001** — se introduce una violación real y se verifica que el build se cae. Un lint configurado no es un lint que funciona |

### 2.8 Tests de regresión

Todo bug reproducido primero como test que falla. Los bugs contables entran además al corpus
permanente de casos: un error de imputación que ocurrió una vez debe ser imposible de repetir.

### 2.9 Integración con ARCA

Contra **homologación**, nunca producción. Contract tests sobre los payloads de `wsfev1`,
`wscdcv1` y padrón, con grabaciones para CI. Escenarios de degradación: servicio caído, TA vencido,
CUIT sin habilitación → el sistema debe marcar `NO_VERIFICABLE`, jamás "OK".

---

## 3. Datos de prueba

- **Prohibido** usar datos reales de clientes en entornos de desarrollo.
- Generador de empresas sintéticas con CUIT válidos de prueba, planes de cuentas y series de
  comprobantes coherentes.
- El corpus de OCR se anonimiza en origen y su uso se documenta.

---

## 4. Sandbox (§34)

El modo simulación **es** una herramienta de prueba de cara al usuario:

```
Comprobante ficticio → Interpretación IA → Regla aplicada → Asiento propuesto
 → IVA → Mayor → Estados contables → Nota
```

Corre contra un esquema aislado, con los mismos motores y las mismas reglas que producción. Un
contador puede validar el comportamiento del sistema antes de confiarle contabilidad real — y el
equipo puede reproducir cualquier caso reportado.

---

## 5. Puertas de CI

Un build no pasa si:

1. Falla cualquier invariante A-1..A-8.
2. Cobertura del motor contable < 95%.
3. Falla cualquier test de seguridad S-1..S-7.
4. El lint de arquitectura detecta que `ai-engine` importa el motor contable o el cliente de base.
5. Hay un `float` en cálculos monetarios.
6. Existe una regla `ACTIVE` sin norma, sin hash o sin aprobador.
7. La tasa de error no detectado del OCR supera el umbral en el corpus de referencia.

Las puertas 4, 5 y 6 son inusuales en un proyecto de software y esenciales en este: codifican en el
pipeline las promesas que el producto le hace al contador.
