# NEXO_EVOLUTION_BASELINE

**Medido:** 2026-09-02, contra el árbol de trabajo y la base de desarrollo.
**Método:** consultas al catálogo de PostgreSQL, inventario de rutas que arma
Fastify al registrarlas, y `npm run verify` completo. No se copió ningún número
de la documentación anterior.

Este archivo es el censo. Lo que sigue después —qué hacer y en qué orden— está
en la §7, y sale de lo medido acá, no de un roadmap heredado.

---

## 1. Corrección de la línea de base declarada

El prompt de evolución trae números de una foto anterior. La medición dice otra
cosa, y la autoridad es el código:

| | Declarado | Medido | |
|---|---|---|---|
| Migraciones | 78 | **86** | 0079–0086 se aplicaron después de esa foto |
| Tablas | 133 | **139** | |
| Vistas | 80 | **91** | |
| Políticas RLS | 101 | **107** | |
| Endpoints | 251 | **274** | contados del `routeTable` real, 59 dominios |
| Pantallas | 31 | **33** | secciones `v-*` de la consola |
| Archivos de test | 103 | **108** | 83 en `tests/`, 25 en `packages/` |
| Tests | 1.742 | **1.798** | |
| Objetos estructurales | 369 | **416** | los que declara `audit:estructura` |

Sin cambio: **0** tablas con `company_id` sin RLS, **0** discrepancias en el
Mayor.

## 2. Estado de los candados

| Qué | Medido |
|---|---|
| Tablas con RLS habilitado | 107 |
| De ellas, con `FORCE` | **107** (todas) |
| Tablas con `company_id` y sin RLS | **0** |
| Vistas sin `security_invoker` | **1** — `norm_candidates_pendientes` |
| Triggers propios | 169 |
| Índices | 395 |
| CHECK constraints | 488 |

**La vista sin `security_invoker` está verificada, no es un hueco.** Lee
`norm_candidates` y `norm_watch_sources`, que son normativa: no tienen
`company_id` y no hay nada de una empresa que pueda filtrarse a otra. Queda
anotado para que la próxima auditoría no lo cuente dos veces.

`npm run verify` termina en verde: 108 archivos, 1.798 tests, 416 objetos
declarados presentes, cadena de bitácora íntegra, Mayor sin discrepancias.

## 3. Rendimiento — lo medido y lo que falta medir

`npm run bench:vistas` carga volumen en la base descartable y mide con el rol
`aai_app`. Con **50.014 movimientos de stock de una empresa**:

| Vista | Mejor de tres |
|---|---|
| `stock_valuation` | 75 ms |
| `stock_ppp` | 27 ms |
| `work_queue` (la bandeja entera) | 229 ms |
| `work_queue`, una página de 50 | 242 ms |
| `analysis_signals` | 18 ms |
| `analytics_flujo_de_fondos` | 9 ms |
| las otras cinco | menos de 10 ms |

**PLANIFICADO:** el volumen cargado es de stock. Las ramas de la bandeja que
cuelgan de comprobantes, cheques, proyectos o terceros no tienen volumen detrás,
así que 229 ms es el piso de la bandeja y no su techo.

## 4. Módulos: estado real

Leyenda: **IMPLEMENTADO** (código + tests + pantalla donde corresponde) ·
**VERIFICADO** (además, probado contra datos reales de punta a punta) ·
**SIMULADO** (funciona contra un mock declarado) · **BLOQUEADO** (falta algo
externo) · **REQUIERE_DECISION** (falta una definición contable o de producto).

### Núcleo contable y fiscal

| Módulo | Estado |
|---|---|
| Diario, Mayor, partida doble, período, cierre | VERIFICADO |
| Documentos, extracción, evidencia | VERIFICADO |
| Operaciones fiscales, IVA, libros | VERIFICADO |
| Estados contables y notas | VERIFICADO |
| Bitácora encadenada y su verificador | VERIFICADO |
| ARCA WSAA/WSFE/constatación | SIMULADO en homologación · **BLOQUEADO** para producción: falta KMS |
| Libro IVA Digital: exportar | **BLOQUEADO** — los diseños de registro no están en la RG |

### ERP

| Módulo | Estado |
|---|---|
| Terceros, productos, precios | VERIFICADO |
| Ciclo comercial (presupuesto → pedido → factura) | VERIFICADO |
| Compras: solicitud → orden → recepción → factura → orden de pago → pago | VERIFICADO (0085 cerró el primer eslabón; 0082 el anteúltimo) |
| Cuenta corriente, imputación, antigüedad, plan de cuotas | VERIFICADO |
| Notas de crédito y débito aplicadas a su factura | VERIFICADO (0083) |
| Stock, lotes, recuento, depósitos | VERIFICADO |
| Valuación PPP, CMV, margen por producto | VERIFICADO (0077–0081, 0086) |
| Bienes de uso | VERIFICADO — solo método lineal |
| Cheques, caja, bancos, conciliación | VERIFICADO |
| CRM, proyectos, comisiones, sucursales | VERIFICADO |
| FIFO y costo de reposición | PLANIFICADO (ADR-020) |
| Retenciones y percepciones | **BLOQUEADO** — falta archivar regímenes |
| Remitos y facturación parcial | **REQUIERE_DECISION** |
| Producción | **REQUIERE_DECISION** |
| RRHH | **REQUIERE_DECISION** (ADR-012) |

### Capa de decisión

| Pieza | Estado |
|---|---|
| Bandeja (`work_queue`), unión de 23 vistas por dominio | VERIFICADO |
| Señales contra umbrales declarados | VERIFICADO |
| Señal de margen: hecho vs política (0084) | VERIFICADO |
| Analítica trazable (13 vistas) | VERIFICADO |
| Flujo de fondos consolidado | VERIFICADO |
| Simulación de escenarios | PLANIFICADO |

### Inteligencia — el hallazgo de esta auditoría

| Pieza | Estado |
|---|---|
| `packages/ai-engine` · clasificación, validación, confianza, aprendizaje | IMPLEMENTADO y **consumido** por `POST /documents/:id/classify` |
| Capa determinística de preguntas (`/intelligence/*`) | IMPLEMENTADO — doce preguntas, cada una con su vista y su metodología |
| `packages/ai-engine` · **respondedor** (`answering.ts` + `answering-agent.ts`) | IMPLEMENTADO y consumido; con el simulado se abstiene, y espera el adaptador de un proveedor real |
| Tabla `ai_answers` + vista `ai_answer_metrics` (migración 0027) | IMPLEMENTADO y escrita por cada llamada al respondedor |
| Proveedor de modelo | `none` por defecto; existe `mock`; **no hay adaptador real** |

**Era el mismo patrón que este repositorio ya encontró cuatro veces**: la pieza
existe, está probada, la tabla la espera, y nadie recorre el camino entre las
dos.

La mitad determinística de ese camino ya está cerrada: `/intelligence/preguntas`,
`/intelligence/preguntar` y `/intelligence/panorama` contestan doce preguntas con
el motor que ya calcula cada número, y cada respuesta trae su origen, su
metodología y qué no incluye. La redacción también quedó cableada: cada llamada pasa por el control de cifras
y queda en `ai_answers` con su contexto exacto, aceptada o rechazada. Lo único
que falta es el adaptador de un proveedor real, que exige una credencial de un
tercero.

## 5. Deuda técnica registrada

| Qué | Gravedad |
|---|---|
| KMS ausente: sin él no hay arranque en producción con ARCA real | IMPORTANTE |
| 17 valores de estado muertos, clasificados y no removidos de los CHECK | MENOR |
| `alerts` y `audit_findings`: tablas sin escritores productivos | MENOR |
| Dos series de numeración `S-*` que se pisan (documentado en TESTING_STRATEGY §2.7) | MENOR |
| Base de desarrollo sin datos de negocio: el conteo del restore se informa SIN EJERCITAR | MENOR |

## 6. Bloqueos, separados por causa

**Por dependencia externa** — no se pueden resolver escribiendo código:

- KMS y certificado de producción de ARCA.
- Proveedor de correo (alta autoservicio).
- Pasarela de pagos (cobro de la suscripción).
- Diseños de registro del Libro IVA Digital (no publicados en la RG).
- Regímenes de retención archivados.
- Credenciales de los conectores externos.

**Por decisión de producto o contable** — están anotados, no olvidados:
remitos y facturación parcial, devoluciones, descuentos por regla, producción,
RRHH, y el momento de asentar el CMV.

**Por entorno** — `git push` bloqueado desde esta sesión. No es deuda del producto: el código está escrito, probado y
commiteado.

## 7. Prioridades recalculadas

No se hereda el orden anterior. Sale de lo medido:

**P0 — nada abierto.** Integridad, aislamiento y Mayor están verdes, y el
rendimiento crítico se midió y se corrigió (0086). No hay trabajo P0 pendiente.

**P1 — cerrar el camino del respondedor.** Es la única pieza construida,
probada y desconectada. Y es exactamente la base de NEXO Intelligence: sin ella,
"inteligencia" sería un chatbot nuevo al lado de un motor que ya existe.

El orden dentro de P1:

1. **La capa determinística de preguntas.** El sistema ya sabe contestar
   —cuánto vendí, cuánto me deben, cuánto vale el stock, qué está en riesgo—:
   lo que falta es el catálogo que traduce una pregunta a la consulta que la
   contesta, con su evidencia. Determinístico, sin modelo de por medio.
2. **La narración, cuando hay proveedor.** El modelo redacta lo que el motor
   calculó, bajo el control de cifras que ya está escrito, y cada respuesta
   queda en `ai_answers` con su contexto exacto.
3. **La pantalla**, que muestre las dos cosas y la diferencia entre ellas.

**P2 — producción.** Onboarding, SaaS, infraestructura. Todo lo que no depende
de un tercero.

**P3 — Decision Engine.** Escenarios y simulación, sobre la capa de P1.

**P4 — Aprendizaje.** Decisión → predicción → resultado → error.

Los módulos ERP que faltan (retenciones, remitos, producción) no entran acá
porque **ninguno está bloqueado por código**: los seis primeros están esperando
una fuente externa o una decisión, y el trabajo interno posible ya está hecho.
