# PROJECT_STATUS — NEXO

**Última actualización:** 2026-09-01
**Estado del árbol:** `verify` en verde — 73 archivos de test, 1390 tests,
112 objetos estructurales presentes, 0 discrepancias en el Mayor.

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

## 3. En curso

Nada bloqueado a mitad de camino. Los últimos tres bloques cerrados:

| Migración | Qué cerró |
|---|---|
| 0047 | Maestro de terceros y cuenta corriente derivada (ADR-013) |
| 0048 | Maestro de productos y servicios, sin alícuotas guardadas (§6) |
| 0049 | Renglones de comprobante, con el candado diferido que los hace cerrar |

Con la 0049 los dos maestros dejan de ser tablas y pasan a ser parte del
circuito: un comprobante puede decir qué producto se movió y a quién.

## 4. Lo que sigue, por dependencias

El orden no es preferencia: cada línea necesita la anterior.

1. **Comprobantes de venta** (presupuesto → pedido → factura) sobre terceros y
   productos, emitiendo por el circuito fiscal que ya existe.
2. **Compras** (orden → recepción → factura de proveedor), simétrico.
3. **Tesorería con cuenta corriente**: cobranzas, pagos e imputación contra los
   saldos que ya deriva `party_balances`.
4. **Stock**: depósitos y movimientos que no son comprobantes. Hoy existe
   `product_movements`, que es movimiento **facturado** y no existencias — la
   diferencia está dicha en la propia respuesta de la API para que nadie la
   confunda.
5. **Activos fijos y amortizaciones.**
6. **Integration Hub** y conectores.
7. **BI / analítica** sobre eventos.

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
| Sin remoto git | El repositorio no tiene `origin`: no hay copia fuera de esta máquina | **IMPORTANTE** |
| Sin `npm start` | La API no lee `.env` por sí sola ni tiene script de arranque | IMPORTANTE |
| Base de desarrollo vacía | `aai` no tiene usuarios ni empresas; el primer admin se crea con `POST /auth/register-first-admin` | MENOR |

## 7. Riesgos vivos

- **Copia de seguridad inexistente.** Sin remoto y sin backups probados, el
  trabajo entero depende de un disco. Es el riesgo más alto del proyecto y no
  es técnico de resolver.
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
