# NEXO_CURRENT_BASELINE

**Medido:** 2026-09-08, contra el árbol de trabajo y la base de desarrollo.
**Última actualización:** 2026-09-08, después de cerrar los cinco bloques de la §9.
**Método:** catálogo de PostgreSQL, `routeTable` que Fastify arma al registrar
las rutas, `npm run verify` completo y `npm run audit:estructura`. Ningún número
salió de la documentación anterior.

Este archivo es el censo vigente. `NEXO_EVOLUTION_BASELINE.md` es la foto del
2026-09-02 y se conserva como historia; donde los dos difieran, manda este.

---

## 1. Lo medido, contra lo declarado

El prompt maestro trae una línea de base histórica. La medición dice otra cosa:

| | Prompt | 2026-09-02 | Al auditar | **Hoy** |
|---|---|---|---|---|
| Migraciones | 78 | 86 | 95 | **107** |
| Tablas | 133 | 139 | 145 | **159** |
| Vistas | 80 | 91 | 95 | **104** |
| Políticas RLS | 101 | 107 | 111 | **118** |
| Endpoints | 251 | 274 | 300 | **319** (63 dominios) |
| Pantallas | 31 | 33 | 35 | **35** secciones `v-*` + landing pública |
| Archivos de test | 103 | 108 | 134 | **145** |
| Tests | 1.742 | 1.798 | 2.067 | **2.237** |
| Objetos estructurales | 369 | 416 | 422 | **435** |
| Permisos | — | — | 97 | **101** |
| Acciones auditadas | — | — | 139 | **158** |

Sin cambio y verificado de nuevo: **0** tablas con `company_id` sin RLS, **0**
discrepancias en el Mayor.

## 2. Los candados

| | |
|---|---|
| Tablas con RLS habilitado | 118 |
| De ellas, con `FORCE` | **118 — todas** |
| Tablas con `company_id` sin RLS | **0** |
| Vistas sin `security_invoker` | 6 — `norm_candidates_pendientes` y las cinco `saas_*` |
| Permisos | 101 |
| Acciones auditadas | 155 |
| Triggers propios | 174 |
| Índices | 448 |
| CHECK constraints | 587 |
| Claves foráneas | 335 |
| Funciones | 368 |

**Las seis vistas sin `security_invoker` están verificadas, y por motivos
distintos.**

`norm_candidates_pendientes` lee normativa: sin `company_id`, sin nada de una
empresa que pueda filtrarse a otra. Verificado por segunda vez para que la
próxima auditoría no lo cuente como hallazgo nuevo.

Las cinco `saas_*` (0100) **sí** atraviesan a todas las empresas, y es su
propósito: son las métricas del negocio de NEXO. Lo que las hace seguras no es
un `security_invoker` que no tienen — es que `aai_app` **no las puede leer**,
revocado explícitamente y comprobado contra el catálogo por S-30, que además
verifica que ninguna ruta las nombre.

## 3. Verificación

```
npm run verify   →   145 archivos · 2.237 tests · verde
lint:arch        →   0 violaciones (256 módulos, 888 dependencias)
audit:estructura →   435/435 objetos presentes
cobertura        →   ≥ 89 % líneas, con umbral propio de 95 % en cada motor
```

La cobertura mide `packages/*/src` **y** `apps/api/src`: desde que
`vitest.config.ts` resuelve la API contra el fuente y no contra `dist`, los
8.700 renglones del borde HTTP entran en el número. El motor contable, el
fiscal, el bancario, el de auditoría, los estados y el sandbox tienen umbral
propio de 95 %.

---

## 4. Estado por capa

Cinco estados, y la diferencia entre los dos del medio es la que más engaña:
**PARCIAL** es «funciona para una parte del problema»; **PREPARADO** es «está
todo salvo algo externo que no depende del código».

### NEXO ERP — mayormente IMPLEMENTADO

| Módulo | Estado | Qué hay |
|---|---|---|
| Empresa, usuarios, roles, permisos | IMPLEMENTADO | 97 permisos, 6 roles, RLS por empresa, MFA obligatorio por rol |
| Sucursales, centros de costo, centros de beneficio | IMPLEMENTADO | Con puntos de venta por sucursal |
| Terceros (clientes y proveedores) | IMPLEMENTADO | Roles de tercero, imputaciones, listas de precios |
| Productos y precios | IMPLEMENTADO | Catálogo, listas, impuestos, unidades |
| Ventas y compras | IMPLEMENTADO | Presupuesto → pedido → remito → factura → cobranza; solicitud → orden → recepción → factura → pago |
| Stock | IMPLEMENTADO | Movimientos, depósitos, recuentos, PPP, valuación |
| Tesorería | IMPLEMENTADO | Caja, bancos, cheques, órdenes de pago, conciliación |
| Contabilidad | IMPLEMENTADO | Plan, asientos, diario, mayor, períodos, cierres, estados contables |
| Activos fijos | IMPLEMENTADO | Altas, mejoras, depreciaciones |
| Proyectos y comisiones | IMPLEMENTADO | Horas, tarifas, esquemas |
| Documentos | PARCIAL | Ingesta, OCR, extracción, versiones y duplicados — pero el almacén es **disco local** (`FilesystemDocumentStore`), no el object storage con versionado y object-lock que promete SECURITY.md §6 |
| Auditoría | IMPLEMENTADO | 139 acciones, cadena de hash, `UPDATE`/`DELETE` revocados en el rol |
| RRHH | AUSENTE | No hay empleados, liquidación ni legajos. El prompt lo lista en la visión; el repositorio no lo tiene |

### NEXO Regulatory — IMPLEMENTADO para Argentina

Motor de normativa versionado con vigencias, artículos, adopciones,
modificaciones, conflictos y huecos; reglas con norma citada obligatoria
(ADR-005) y hash. Comprobantes con tipos de ARCA. **Emisión fiscal real:
fuera del MVP y aislada por lint** — `packages/arca-emision` no es alcanzable
desde `apps/`.

ARCA: consulta y constatación andan contra **homologación** con el certificado
que vive fuera del repositorio. Producción: BLOQUEADO por trámite del cliente.

### NEXO Intelligence — PARCIAL

Lo que hay es real y está medido: predicciones con confianza, cuotas por
empresa, rechazos, revisiones, preguntas con catálogo cerrado, panorama,
señales de análisis, umbrales con sugerencia, flujo de fondos, proyección de
cobranzas, riesgos, linaje.

**Actualizado el 2026-09-08:** hay **detección persistente**. Las señales ya
eran una vista determinística; lo que faltaba era la distinción entre una señal
—qué es cierto ahora— y una alerta —desde cuándo cruzó el umbral y quién la
miró—. El detector (0102) abre una alerta por sujeto, no una por corrida,
la cierra sola cuando el problema se corrige, y **no abre ninguna sin umbral
declarado**: `null` no es «no supera».

Cerró de paso tres piezas construidas y desconectadas desde la 0028: la tabla
`alerts` y los permisos `alert:read` y `alert:acknowledge`, que no gobernaban
ninguna ruta.

Lo que **no** hay: forecasting con horizonte y versión de modelo registrados, y
copiloto conversacional abierto. El proveedor de modelo está 🟡 PREPARADO (sin
credencial), así que hoy la inteligencia que corre es la determinística — y eso
incluye la detección: cada alerta trae la cuenta exacta para rehacerla a mano.

### NEXO Decision Engine — PARCIAL, con el ciclo cerrado salvo recomendar

**Actualizado el 2026-09-08.** El registro de decisión del §28 existe como
entidad (0101): problema, evidencia, alternativas, recomendada, elegida,
aprobación con segunda firma, ejecución, y revisión posterior con veredicto.

El bucle del §29 cierra: decisión → ejecución → resultado → comparación contra
lo esperado → evaluación → calibración. **Y es auditable a mano**, que es lo que
el pliego pide: la calibración es un porcentaje sobre revisiones que escribió una
persona, no un modelo que se ajusta solo.

Lo que falta es **que el sistema recomiende**. Comparar escenarios ya lo hace;
elegir uno exige una función de preferencia —cuánto riesgo se tolera, qué pesa
más entre caja y margen— que es del estudio, no del software. El registro ya
tiene dónde ponerla, y la calibración va a poder contestar si conviene
escucharla. Ver [`NEXO_DECISION_ENGINE.md`](NEXO_DECISION_ENGINE.md).

### NEXO Subscriptions y Billing — IMPLEMENTADO salvo el cobro

**Actualizado el 2026-09-08.** Lo que faltaba entero —precio, período,
documento, cobro, cobranza, suspensión— existe y corre. Ver
[`NEXO_BILLING.md`](NEXO_BILLING.md).

| | |
|---|---|
| Precios de plan | Tabla con vigencia y motivo. **Vacía**: el precio es una decisión comercial sin tomar |
| Período y documento | El ciclo los emite, prorratea el alta a mitad de mes y no cobra dos veces |
| Cobro | Por transferencia, a mano, con clave de idempotencia obligatoria |
| Cobranza | Reintento, aviso y suspensión, según política declarada. **Sin política, no dispara nada** |
| Cambio de plan | Prorrateo del período partido, sin crear ni perder centavos |
| Anulación | Con motivo. Anular no es declarar incobrable |
| Eventos de pasarela | Repetido, atrasado, conflicto y desconocido: los cuatro se guardan |

**Desde B-1 (2026-09-08):** cinco planes comerciales con su matriz de
funcionalidades, precios declarados, topes por plan, prueba de 14 días que
efectivamente vence, alta autoservicio y una puerta comercial que hace cumplir
qué incluye cada plan — y que **falla abierta** a propósito, porque es comercial
y no de seguridad.

Lo que sigue faltando y **no es código**: la política de cobranza, la pasarela,
el proveedor de correo y la condición de IVA de NEXO. Ver
[`NEXO_COMERCIAL.md`](NEXO_COMERCIAL.md).

### NEXO Payment Engine — PREPARADO, no conectado

Existe la estructura entera: intentos con idempotencia, eventos con máquina de
estados, y **ninguna columna donde guardar datos de tarjeta**. No hay pasarela
contratada: `intentarCobro` devuelve `SIN_PASARELA` y el ciclo lo informa en
vez de callarlo.

### NEXO Corporate y Self-Management — PARCIAL

**Actualizado el 2026-09-08.** Existen las **métricas del negocio** —MRR, ARR,
ARPU, altas, bajas, cobranza— calculadas sobre suscripciones y cargos reales,
con las fórmulas escritas y reproducibles. Ver
[`NEXO_CORPORATE.md`](NEXO_CORPORATE.md).

Son las únicas vistas del repositorio **sin `security_invoker`**, porque agregan
sobre todas las empresas a propósito. Lo que las hace seguras es que `aai_app`
no las puede leer: revocado, comprobado contra el catálogo, y sin ninguna ruta
que las nombre.

Lo que **no** hay, y comparte una sola causa: **NEXO no lleva su propia
contabilidad**. Sin eso no hay CAC, ni LTV, ni costo por cliente, ni margen por
plan, ni burn, ni runway — y ninguno se puede inventar, porque un CAC inventado
se ve igual que uno medido. Tampoco hay CRM propio, pipeline, equipo, soporte
ni tablero ejecutivo. Los módulos `crm_*` son el CRM **que NEXO le da a sus
clientes**, no el suyo.

### NEXO Interface — PARCIAL

35 secciones en una consola técnica de un solo archivo. Está declarado en
`apps/web/README.md` que **no es la interfaz definitiva**.

**Actualizado el 2026-09-08:** hay **alta autoservicio** (0103). El usuario nace
`PENDIENTE` y no entra hasta confirmar su correo; el token se guarda hasheado,
sirve una sola vez, y pedir otro invalida el anterior. Registrarse con una
dirección que ya existe contesta lo mismo que con una nueva — si dijera «ya está
registrado», cualquiera podría averiguar quién usa NEXO probando direcciones.

**Y no se completa sola**, porque no hay proveedor de correo: el mensaje queda
en `email_outbox`, que la aplicación **puede escribir y no puede leer** —el
cuerpo lleva el token—. Lo lee el operador con `npm run correo:bandeja`. La
pantalla lo dice con esas palabras en vez de dejar a alguien esperando un correo
que nunca va a salir.

---

## 5. Integraciones

| | Estado | Por qué |
|---|---|---|
| ARCA homologación | 🟢 **VERDE** | Firma WSAA verificada, consulta y constatación reales |
| ARCA producción | 🔴 **ROJO** | Certificado de producción: trámite del contribuyente |
| Proveedor de modelo de IA | 🟡 **AMARILLO** | Adaptador, reintentos, redacción y tests completos. Falta la credencial |
| Gestión de secretos / KMS | 🟡 **AMARILLO** | Puerto, aislamiento, referencias, rotación y tests. **No hay gestor externo**, y un secreto por empresa no se puede resolver |
| Object storage | 🟡 **AMARILLO** | Anda sobre disco local. Sin versionado ni object-lock, y no sirve con varias réplicas |
| Email | 🟡 **AMARILLO** | Puerto, bandeja de salida y estados (`SIN_PROVEEDOR` ≠ `FALLIDO`). **Ningún proveedor contratado**: nada sale |
| Pagos SaaS | 🟡 **AMARILLO** | Intentos, eventos, idempotencia y máquina de estados completos. Sin pasarela contratada |
| Bancos | 🟡 **AMARILLO** | Importación de extractos y conciliación reales; sin conexión directa a ningún banco |
| Canales de venta (Shopify, Tiendanube, ML, Woo) | 🟡 **AMARILLO** | Declarados como proveedores con corridas de sincronización; sin adaptador conectado |

Ninguna se declara VERDE por tener interfaz o mock. Es la regla del §63 y es la
que este repositorio ya venía aplicando.

---

## 6. Blockers

### Externos — requieren una decisión o una cuenta, no código

| | Qué destraba | Bloquea |
|---|---|---|
| **B-1** Credencial del proveedor de modelo | Contratar y cargar la clave | Intelligence con modelo real |
| **B-2** Gestor de secretos | Elegir proveedor y contratarlo | ARCA producción multiempresa; §54 |
| **B-3** Certificado ARCA de producción | Trámite del contribuyente | Emisión fiscal real |
| **B-4** Proveedor de correo | Elegir y contratar | Que el alta autoservicio **se complete sola**, recuperación de contraseña, aviso previo a una suspensión |
| **B-5** Pasarela de pago | Elegir y contratar | Cobrar suscripciones |
| **B-6** Precios de los planes | **Decisión comercial** | Billing entero |
| **B-7** Hosting y jurisdicción | Decisión con contrato | Despliegue productivo |

**B-6 es el que más traba y el más barato de destrabar**: no cuesta dinero,
cuesta decidir. Sin precios no hay factura, sin factura no hay cobranza, y sin
cobranza el resto de la cadena comercial no se puede probar de punta a punta.

### Internos — se resuelven escribiendo código

| | |
|---|---|
| ~~**I-1**~~ | ~~Motor de pagos y facturación~~ — **hecho** el 2026-09-08 (0096–0099). Queda conectar la pasarela, que es externo |
| **I-2** | ~~Alta autoservicio~~ — **hecho** el 2026-09-08 (0103). Queda el onboarding completo: empresa, datos fiscales, plan e importación en un flujo guiado |
| **I-3** | NEXO Corporate y self-management |
| ~~**I-4**~~ | ~~Métricas SaaS con fórmulas reproducibles~~ — **hecho** el 2026-09-08 (0100). Falta lo que depende de la contabilidad propia: CAC, LTV, margen, runway |
| ~~**I-5**~~ | ~~Registro de decisión y bucle de aprendizaje~~ — **hecho** el 2026-09-08 (0101). Queda la recomendación automática, que necesita una política de preferencia del estudio |
| **I-6** | ~~Anomalías~~ — **hecho** el 2026-09-08 (0102): detección persistente con alertas. Queda el forecasting con horizonte y modelo registrados |
| **I-7** | Almacén de documentos apto para producción |
| **I-8** | RRHH |

---

## 7. Deuda registrada

| | Gravedad |
|---|---|
| Sin gestor de secretos: un secreto por empresa no se resuelve | IMPORTANTE |
| `arca/credential-store.ts` se niega a usar una KEK del entorno en producción y `auth/crypto.ts` la exige. Las dos decisiones no pueden ser correctas | IMPORTANTE |
| Documentos sobre disco local: sin versionado, sin object-lock, incompatible con varias réplicas | IMPORTANTE |
| Base de desarrollo sin datos de negocio: el conteo de filas va sin ejercitar | MENOR |
| 17 estados muertos en los CHECK, clasificados y no removidos | MENOR |
| `audit_findings` sin escritor. `alerts` salió de esta lista el 2026-09-08 | MENOR |
| Dos series `S-*` que se pisan (TESTING_STRATEGY §2.7) | MENOR |
| `norm_candidates_pendientes` sin `security_invoker` — verificado inofensivo, queda por coherencia | MENOR |

---

## 8. Riesgos

**El riesgo mayor no es técnico.** El ERP está sólido y medido; lo que falta
para vender no es contabilidad, es **cobrar**: precios, factura, pasarela y
correo. Cuatro cosas, tres de ellas afuera del código.

**El segundo es de expectativa.** La visión del prompt maestro describe una
plataforma con Corporate, Self-Management, agentes y aprendizaje. Lo que hay es
un ERP muy completo con una capa analítica real y un circuito de escenarios que
cierra. Llamar a eso «Decision Engine terminado» sería exactamente el FAKE GREEN
que el §63 prohíbe.

**El tercero es de superficie.** 300 endpoints y 35 pantallas es mucho producto
para una consola técnica de un archivo. La distancia entre «el sistema puede
hacerlo» y «un contador puede hacerlo sin ayuda» es hoy la brecha más ancha.

---

## 9. Qué se hizo con esta medición, y qué queda

El orden de trabajo que salía de la auditoría se ejecutó de punta a punta el
2026-09-08. Lo hecho, en orden:

| | |
|---|---|
| 1 | **Facturación** (0096–0099): precio, período, documento, cobro, cobranza, suspensión, prorrateo, anulación, eventos de pasarela |
| 2 | **Métricas del negocio** (0100): MRR, ARR, ARPU, altas, bajas, cobranza |
| 3 | **Registro de decisiones** (0101): problema, evidencia, alternativas, aprobación con segunda firma, revisión y calibración |
| 4 | **Alertas** (0102): detección persistente, una por sujeto, que se cierra sola |
| 5 | **Alta autoservicio** (0103–0104): con verificación de correo y bandeja de salida |

Lo que queda está clasificado por lo que impide, no por lo que falta:
[`NEXO_RELEASE_READINESS.md`](NEXO_RELEASE_READINESS.md).

**La conclusión de la vuelta entera:** ninguno de los seis bloqueos que impiden
cobrarle a la primera empresa se resuelve escribiendo código. Cuatro son
contratar algo, uno es un trámite del contribuyente y **el que más traba es
decidir los precios**, que no cuesta dinero.