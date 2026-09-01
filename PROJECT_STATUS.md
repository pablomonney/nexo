# PROJECT_STATUS — NEXO

**Última actualización:** 2026-09-01
**Estado del árbol:** `verify` en verde — 77 archivos de test, 1449 tests,
167 objetos estructurales presentes, 0 discrepancias en el Mayor.

Este archivo dice **dónde está el proyecto de verdad**, no dónde debería estar.
Si algo figura como TERMINADO, existe el código, el test y el candado. Si algo
no está probado, figura como no terminado aunque compile.

---

## 1. Qué es NEXO hoy

Un motor contable-fiscal argentino, determinista y auditable, con el circuito
completo cerrado y probado de punta a punta:

```
DOCUMENTO → OPERACIÓN FISCAL → AFECTACIÓN → DECISIÓN → ASIENTO → MAYOR → ESTADOS
```

Sobre eso está empezando la evolución a ERP integral. El plan y su orden de
dependencias están en [`docs/roadmap/ERP_EVOLUCION.md`](docs/roadmap/ERP_EVOLUCION.md).

## 2. Terminado y verificado

| Módulo | Estado | Dónde se prueba |
|---|---|---|
| Identidad, MFA, sesiones | TERMINADO | `tests/security/` |
| Multiempresa con RLS `FORCE` | TERMINADO | `aislamiento-multiempresa`, `aislamiento-lectura` |
| Plan de cuentas y centros de costo | TERMINADO | `circuito-contable-base` |
| Ejercicios, períodos y cierre | TERMINADO | `cierre-de-ejercicio` |
| Diario, Mayor y sus candados | TERMINADO | `ledger-projection`, `gate-de-invariantes` |
| Documentos, extracción, evidencia | TERMINADO | `flujo-comprobante-completo` |
| Operaciones fiscales e IVA | TERMINADO | `circuito-mvp-e2e` |
| Decisiones contables y corrección | TERMINADO | `decisions-api` |
| Estados contables y notas | TERMINADO | `estados-contables`, `notas-complementarias` |
| Bancos y conciliación | TERMINADO | `tests/integration/` |
| Motor normativo (reglas versionadas) | TERMINADO | `packages/normative-engine` |
| ARCA: WSAA, WSFE, constatación | TERMINADO (homologación) | `packages/arca` |
| Bandeja de trabajo (`work_queue`) | TERMINADO | `navegacion-e2e` |
| Bitácora consultable (`GET /audit`) | TERMINADO | `bitacora` |
| Consola web (13 pantallas) | TERMINADO | `consola-contrato` (S-12) |
| **Maestro de terceros** | **TERMINADO** | **`terceros` (20 tests)** |
| **Maestro de productos** | **TERMINADO** | **`productos` (14 tests)** |
| **Detalle de comprobante** | **TERMINADO** | **`renglones-de-comprobante` (9 tests)** |
| **Ciclo comercial** | **TERMINADO** | **`ciclo-comercial` (16 tests)** |
| **Recepción y conciliación de compras** | **TERMINADO** | **`recepcion-de-compras` (14 tests)** |
| **Imputación y antigüedad de saldos** | **TERMINADO** | **`imputacion-de-cobros` (16 tests)** |
| **Stock: depósitos y existencias** | **TERMINADO** | **`stock` (13 tests)** |

## 3. En curso

Nada bloqueado a mitad de camino. Los bloques cerrados en esta evolución:

| Migración | Qué cerró |
|---|---|
| 0047 | Maestro de terceros y cuenta corriente derivada (ADR-013) |
| 0048 | Maestro de productos y servicios, sin alícuotas guardadas (§6) |
| 0049 | Renglones de comprobante, con el candado diferido que los hace cerrar |
| 0050 | Ciclo comercial: presupuesto → pedido → factura (ADR-014) |
| 0051 | La bandeja pasa a ser unión de vistas por dominio, extensible |
| 0052 | Recepción de mercadería y conciliación de tres puntas en compras |
| 0053 | Imputación de cobros, composición y antigüedad de saldos (ADR-015) |
| 0054 | Depósitos, libro de movimientos y existencias derivadas |

El circuito comercial cierra contra el fiscal sin duplicarlo: al facturar, el
pedido **se convierte** en una `tax_transaction` con sus renglones. Un pedido
aceptado y sin facturar aparece en la bandeja, y desaparece de ella cuando se
factura — no cuando alguien lo marca, porque no hay forma de marcarlo.

## 4. Lo que sigue, por dependencias

El orden no es preferencia: cada línea necesita la anterior.

1. **Valuación de existencias.** Hoy el stock son cantidades. Cuánto valen
   —PPP, FIFO o costo de reposición— es una decisión contable con norma
   detrás, y sin ella no hay costo de mercadería vendida automático.
2. **Activos fijos y amortizaciones.**
3. **Integration Hub** y conectores.
4. **BI / analítica** sobre eventos.

### Decisiones de producto que aparecieron acá

- **Remitos y entregas parciales.** Un pedido que se factura en dos veces no
  está modelado. No es una limitación técnica: hay que decidir si NEXO admite
  facturación parcial y con qué reglas.
- **Listas de precios.** `products.list_price` es un precio único. Precios por
  cliente, por cantidad o por lista todavía no existen.
- **Imputación automática sugerida.** Se podría *proponer* una imputación por
  antigüedad y que una persona la confirme — la forma que ADR-001 admite. Hoy
  no existe: imputar es siempre manual (ADR-015 §7).
- **Condiciones de pago por comprobante y cuotas.** El plazo es del tercero;
  una factura con condiciones distintas o en tres cuotas no se puede expresar.
- **Salida de stock al facturar.** Hoy es un paso aparte porque el comprobante
  no dice de qué depósito salió. Un depósito por defecto por empresa lo haría
  automático — y sería inventar el dato más importante del movimiento cada vez
  que la empresa tenga más de uno. La bandeja lo señala mientras tanto.
- **Valuación de existencias.** Cantidades sí, valores no. Elegir PPP o FIFO es
  una decisión contable con norma detrás, no un detalle de implementación.

## 5. Bloqueado por decisión de producto

Ninguno es un problema técnico. Están anotados, no olvidados.

| | Qué falta decidir |
|---|---|
| **D-1 … D-7** | Ver `docs/FASE_4_OPERACION.md` §15 |
| **D-8** | Conciliación masiva de comprobantes históricos contra el maestro de terceros: qué grado de automatismo se admite cuando nadie puede firmar fila por fila (ADR-013 §6) |

## 6. Deuda técnica registrada

| | Qué es | Gravedad |
|---|---|---|
| 17 valores de estado muertos | Clasificados en la FASE 4 (`MUERTO` / `GAP_DE_PRODUCTO` / `DERIVADO`), **no** removidos de los CHECK | MENOR — documentada |
| `alerts` y `audit_findings` | Tablas sin escritores productivos; deliberadamente fuera de la bandeja | MENOR |
| Sin `npm start` | La API no lee `.env` por sí sola ni tiene script de arranque | IMPORTANTE |
| Backup sin restauración probada | Existe `C:\Users\SaludCapilar\Backups\NEXO`. Un backup que nunca se restauró es una hipótesis, no una copia (§66) | IMPORTANTE |
| Base de desarrollo vacía | `aai` no tiene usuarios ni empresas; el primer admin se crea con `POST /auth/register-first-admin` | MENOR |

## 7. Riesgos vivos

- **Restauración nunca probada.** Hay remoto (`origin`, GitHub) y hay un backup
  de `aai` en `C:\Users\SaludCapilar\Backups\NEXO`. Falta lo que convierte un
  backup en una copia: restaurarlo una vez y comprobar que la base restaurada
  pasa `audit:estructura` y `ledger:verify`. Hasta que eso ocurra, el RPO y el
  RTO son estimaciones.
- **Certificados de ARCA fuera del repositorio** (`C:\ARCA\`), como debe ser
  (§27). Su pérdida bloquea la integración fiscal.
- **El WSAA entrega un solo ticket por CUIT y servicio**, sin caché en disco:
  dos comandos seguidos fallan.

## 8. Cobertura

Los umbrales del `vitest.config.ts` se cumplen sin excepciones ni silencios.
Ningún test se volvió vacuo para conseguir verde; los cuatro estados de
invariante (`VERIFIED` / `VIOLATED` / `NOT_EXERCISED` / `VACUO_PERMITIDO`) se
siguen reportando por separado.

## 9. Decisiones de arquitectura vigentes

| ADR | Qué fija |
|---|---|
| 001 | La IA no alcanza el motor contable. Verificado por dependency-cruiser y 3 tests |
| 003 | Un asiento se anula por contraasiento, nunca se edita |
| 008 | Migraciones SQL primero, con checksum |
| 010 | `SECURITY DEFINER` con nombre en vez de aflojar RLS |
| 011 | Los permisos se resuelven *con* la empresa en contexto |
| 012 | Sueldos son otro dominio; entran por el mismo puente |
| **013** | **El tercero es un maestro por empresa; el comprobante conserva lo que declaró** |
| **014** | **La factura no se guarda dos veces: el pedido se convierte en operación fiscal** |
| **015** | **El vencimiento no se deduce y la imputación no se adivina: se declaran** |
