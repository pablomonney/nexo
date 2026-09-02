# PROJECT_STATUS — NEXO

**Última actualización:** 2026-09-02
**Estado del árbol:** `verify` en verde — 108 archivos de test, 1798 tests,
416 objetos estructurales presentes, 0 discrepancias en el Mayor, cadena de
bitácora íntegra en las dos empresas de verificación.

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
| Consola web (31 pantallas) | TERMINADO | `consola-contrato` (S-12, ida y vuelta) |
| **Maestro de terceros** | **TERMINADO** | **`terceros` (20 tests)** |
| **Maestro de productos** | **TERMINADO** | **`productos` (14 tests)** |
| **Detalle de comprobante** | **TERMINADO** | **`renglones-de-comprobante` (9 tests)** |
| **Ciclo comercial** | **TERMINADO** | **`ciclo-comercial` (16 tests)** |
| **Recepción y conciliación de compras** | **TERMINADO** | **`recepcion-de-compras` (14 tests)** |
| **Imputación y antigüedad de saldos** | **TERMINADO** | **`imputacion-de-cobros` (16 tests)** |
| **Stock: depósitos y existencias** | **TERMINADO** | **`stock` (13 tests)** |
| **Bienes de uso y amortizaciones** | **TERMINADO** | **`bienes-de-uso` (15 tests)** |
| **Integration Hub + ingesta por archivo** | **TERMINADO** | **`integration-hub` (25 tests)** |
| **Analítica con trazabilidad** | **TERMINADO** | **`analitica` (13 tests)** |
| **Señales, proyección y simulación** | **TERMINADO** | **`senales-y-simulacion` (12 tests)** |
| **Arranque del servidor (`npm start`)** | **TERMINADO** | **`arranque` (8 tests)** |
| **Backup y restauración verificada** | **TERMINADO** | **`npm run db:restaurar`** |
| **Integridad de la bitácora** | **TERMINADO** | **`npm run audit:cadena`, gate de `verify`** |
| **Plan de pagos por comprobante** | **TERMINADO** | **`plan-de-pagos` (15 tests)** |
| **Imputaciones sugeridas** | **TERMINADO** | **`sugerir-imputaciones` (13 tests)** |
| **Listas de precios** | **TERMINADO** | **`listas-de-precios` (16 tests)** |
| **Salida de stock por comprobante** | **TERMINADO** | **`stock` (21 tests)** |
| **Umbrales sugeridos** | **TERMINADO** | **`senales-y-simulacion` (15 tests)** |
| **Cheques propios y de terceros** | **TERMINADO** | **`cheques` (20 tests)** |
| **Flujo de fondos: entradas y salidas** | **TERMINADO** | **`cheques`, `ciclo-compras` (ADR-018)** |
| **Circuito de compras completo** | **TERMINADO** | **`ciclo-compras` (8 tests)** |
| **Lotes, vencimientos y recuento físico** | **TERMINADO** | **`stock` (28 tests)** |
| **Caja y arqueo** | **TERMINADO** | **`caja` (10 tests)** |
| **CRM: oportunidades y embudo** | **TERMINADO** | **`crm` (13 tests)** |
| **Proyectos: horas y rentabilidad** | **TERMINADO** | **`proyectos` (11 tests)** |
| **Vendedores y comisiones** | **TERMINADO** | **`comisiones` (10 tests)** |
| **Sucursales** | **TERMINADO** | **`sucursales` (10 tests)** |
| **Suscripciones del propio NEXO** | **TERMINADO** | **`suscripciones` (9 tests)** |
| **Detección de anomalías del Diario** | **TERMINADO** | **`anomalias` (6 tests)** |
| **Mapeo contable y propuesta de asiento** | **TERMINADO** | **`mapeo-contable` (8 tests)** |
| **Puesta en marcha de una empresa** | **TERMINADO** | **`puesta-en-marcha` (10 tests)** |
| **Valuación de existencias y CMV** | **TERMINADO** | **`valuacion` (14 tests)** |
| **Conciliación bancaria por HTTP** | **TERMINADO** | **`conciliacion-por-http` (6 tests)** |
| **Notas de crédito en la cuenta corriente** | **TERMINADO** | **`notas-de-credito` (6 tests)** |
| **Exportaciones a CSV** | **TERMINADO** | **`exportaciones` (5 tests)** |
| **Imagen, sondas y métricas** | **TERMINADO** | **`metricas` (S-13, 4 tests), `docs/DESPLIEGUE.md`** |
| **Límite de intentos por origen** | **TERMINADO** | **`limite-de-intentos` (S-14, 5 tests)** |

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
| 0055 | Bienes de uso: plan de amortización calculado y valor de libros |
| 0056 | Integration Hub: zona de aterrizaje para lo externo (ADR-016) |
| 0057 | Analítica: seis vistas, ni una cifra almacenada, cada total abrible |
| 0058 | Señales contra umbrales declarados, sin modelo de por medio (ADR-017) |
| 0059 | El detector de adulteraciones de la bitácora podía encontrar y no reportar |
| 0060 | Plan de cuotas: la proyección de cobranzas dejó de estar equivocada |
| 0061 | Listas de precios con vigencia, por cliente y por cantidad (§6) |
| 0062 | Depósito por defecto declarado: la salida deja de ser un trámite |
| 0063 | La bandeja avisa cuando una lista de precios dejó de regir |
| 0064 | Cheques: cartera, ciclo derivado del libro y flujo por fecha de pago |
| 0065 | Los cheques entran a la capa de decisión: flujo consolidado y señal (ADR-018) |
| 0066 | El flujo de fondos deja de mirar solo un lado: pagos y compromisos |
| 0067 | Lotes con vencimiento, existencia por lote y recuento que ajusta sin reescribir |
| 0068 | Caja y arqueo: el teórico se deriva, lo contado se declara, y la diferencia va a la bandeja sin umbral |
| 0069 | CRM: etapas declaradas por la empresa, embudo que no pondera sin probabilidad, y que no entra al flujo de fondos |
| 0070 | Proyectos: horas valuadas a la tarifa declarada, ingresos y costos leídos del Mayor, y margen que no se afirma cuando falta un dato |
| 0071 | Vendedores y comisiones: el porcentaje se declara, la base se dice, y devengar no es pagar |
| 0072 | Sucursales: el punto de venta las ata, la vigencia protege el histórico, y las dos atribuciones se muestran |
| 0073 | Suscripciones: planes sin precios, topes declarados, y un límite que avisa sin bloquear |
| 0074 | El mapeo contable declarado: el sistema propone el asiento y deja de escribirse a mano (ADR-019) |
| 0075 | Puesta en marcha: qué le falta a una empresa para trabajar, contado y no tildado |
| 0076 | La puesta en marcha completa: catorce pasos, cinco estados, y un «no aplica» que se deriva |
| 0077 | Valuación de existencias: el método se declara y solo se ofrece el que se calcula (ADR-020) |
| 0078 | El costo entra por el renglón de la recepción, que es donde alguien lo tiene a mano |
| 0079 | El costo de mercadería vendida llega al Mayor: dos roles más en el mapeo y un asiento propuesto por mes |
| 0080 | Una nota de crédito resta: el signo sale del catálogo de ARCA y la antigüedad de saldos deja de filtrar los créditos |
| 0081 | Margen real por producto: la venta contra su costo, y no se afirma si lo facturado no coincide con lo que salió |
| 0082 | La orden de pago: el documento entre la factura y el pago. «Pagada» exige el asiento imputado a cada comprobante (ADR-021) |
| 0083 | La nota de crédito dice qué factura corrige: aplicarla traslada saldo de un comprobante al otro, y la cuota baja con él |
| 0084 | El margen llega a la capa de decisión: vender bajo costo se señala sin umbral —es un hecho— y el margen mínimo se declara |
| 0085 | La solicitud de compra: pedir no es comprar. Sin precios, y «convertida» exige citar una orden de compra de verdad (ADR-021) |
| 0086 | El promedio se calcula al escribir: la valuación pasa de 25 s a 44 ms con 50.000 movimientos, y se sigue comprobando contra la derivación |

El circuito comercial cierra contra el fiscal sin duplicarlo: al facturar, el
pedido **se convierte** en una `tax_transaction` con sus renglones. Un pedido
aceptado y sin facturar aparece en la bandeja, y desaparece de ella cuando se
factura — no cuando alguien lo marca, porque no hay forma de marcarlo.

La cobertura del producto contra la matriz ERP y contra el mercado está en
[`docs/roadmap/COBERTURA_ERP.md`](docs/roadmap/COBERTURA_ERP.md), con cada hueco
clasificado en LIBRE, DECISIÓN o BLOQUEADO.

## 4. Lo que sigue, por dependencias

El orden no es preferencia: cada línea necesita la anterior.

Con la 0055 quedan cerrados **todos los módulos contables de fondo**. Lo que
sigue ya no es contabilidad:

1. **Conectores por API.** Falta el adaptador de cada plataforma —Tiendanube,
   Mercado Pago, Meta y Google Ads, bancos— y su credencial, que es un bloqueo
   externo. Cada uno es un módulo que llama a `POST /integrations/:id/records`
   y nada más.

   **Mientras tanto el hub ya se usa.** Su única entrada era ese endpoint JSON,
   que llama un conector que todavía no existe: toda la zona de aterrizaje de
   ADR-016 estaba escrita, probada y sin recibir un solo registro. La ingesta
   por archivo (`POST /integrations/:id/records/csv`) toma lo que cualquiera
   baja del panel de su proveedor, con el mapeo de columnas declarado. No
   reemplaza a los conectores: hace que el módulo sirva antes de que existan.
2. **Producción y RRHH.** RRHH tiene ADR-012 escrito y sin implementar.
3. **Suscripciones y control interno del propio NEXO** (§31–§35).

La línea que decía «IA sobre datos reales» quedó cerrada, y no como se esperaba:
al escribirla, detectar un desvío resultó ser una comparación, proyectar una
extrapolación de plazos declarados y simular una función pura de parámetros.
Ninguna necesita un modelo, y usarlo las volvería irreproducibles (ADR-017). El
lugar legítimo del modelo —leer, interpretar y **proponer**— ya existía en
`ai_predictions` desde la migración 0018, así que no se duplicó nada.

### Lo que falta dentro de lo hecho

- **Exportar y presentar el Libro de IVA Digital.** No es una pantalla que
  falte: los diseños de registro **no están en la resolución** —el art. 8° los
  remite al micrositio de ARCA, que no está archivado— y ambos endpoints
  contestan `501` con su fundamento. Inventar un layout produciría un archivo
  rechazado, o peor, uno aceptado con los campos corridos (§30, §47).
- **Valuación de existencias.** Resuelta para el promedio ponderado móvil desde
  la 0077: el método lo declara la empresa —es una decisión contable con norma
  detrás— y el sistema calcula el que declaró. FIFO y costo de reposición siguen
  planificados, cada uno con el motivo escrito (ADR-020). Lo que sigue faltando
  es **asentarlo solo**: desde la 0079 el sistema propone el asiento contra las
  cuentas que la empresa declaró para MERCADERIA y COSTO_DE_VENTAS, y una
  persona lo firma por el camino de siempre. Automatizar el momento sigue siendo
  una política contable sin declarar.
- **Métodos de amortización.** Solo `LINEAL`. Cada método adicional tiene
  consecuencias sobre la RT que lo admite y sobre el impuesto.

### Decisiones de producto que aparecieron acá

- **Remitos y entregas parciales.** Un pedido que se factura en dos veces no
  está modelado. No es una limitación técnica: hay que decidir si NEXO admite
  facturación parcial y con qué reglas.
- **Descuentos y promociones por lista.** Una lista tiene precios, no reglas:
  «10% a partir de la quinta unidad» o «2x1 hasta fin de mes» no se pueden
  expresar. Cada uno es una decisión de producto y ninguna está tomada.
- **Umbrales con historia corta.** La propuesta exige seis períodos y con menos
  contesta `SIN_HISTORIA_SUFICIENTE`. Un método que dijera algo con dos meses
  —una estacionalidad declarada, un comparativo del rubro— exige una fuente que
  no está archivada.
- **Pronóstico con método.** La proyección de cobranzas extrapola plazos ya
  declarados; no predice demanda. Un pronóstico real exige elegir un método con
  nombre, y eso es una decisión de producto pendiente (ADR-017 §6).
- **Agrupar cobros en una propuesta.** Que dos cobros juntos cancelen una
  factura es plausible, y abre el mismo espacio combinatorio que el motor
  bancario tuvo que acotar con un tope. Sin necesidad demostrada, no se hizo.
- **Generar el plan de cuotas.** La consola ayuda a tipearlo —n cuotas cada
  tantos días, con el resto en la última para que cierre al centavo— y lo que se
  guarda es lo que quedó en los campos. El sistema **no** genera planes: un plan
  es un acuerdo entre dos partes.
- **Salida de stock automática al facturar.** Sigue sin pasar, y a propósito.
  La 0062 agregó el depósito **declarado** por la empresa, que precarga la
  sugerencia y evita tipear el mismo dato cien veces; registrar la salida sigue
  siendo un acto de una persona, porque la mercadería pudo salir de otro lado y
  solo quien despachó lo sabe. La bandeja avisa hasta que la salida exista.
- **Los otros métodos de valuación.** El promedio ponderado móvil está resuelto
  desde la 0077 y es el que la empresa declara. FIFO y costo de reposición
  siguen planificados: elegirlos es una decisión contable con norma detrás, no un
  detalle de implementación (ADR-020).

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
| KMS ausente | Los sobres de credenciales usan `local:` fuera de producción; `desenvolver()` se niega a abrirlos con `NODE_ENV=production`. El cliente de KMS que pide SECURITY.md §5 no existe todavía, así que hoy **no hay arranque en producción posible** con ARCA real | IMPORTANTE |
| Backup restaurado sobre base vacía | `npm run db:restaurar` demuestra el camino de vuelta, pero la comparación de contenido se informa **SIN EJERCITAR**: `aai` no tiene ni una fila de negocio. El día que tenga datos reales, este control recién empieza a decir algo | MENOR — el mecanismo está probado |
| Base de desarrollo vacía | `aai` no tiene usuarios ni empresas; el primer admin se crea con `POST /auth/register-first-admin`, y ese camino ahora lo recorre `npm run verify:arranque` en cada `verify` | MENOR |

## 7. Riesgos vivos

- **El rendimiento con datos de verdad está medido en un solo lugar.** La 0086
  salió de una medición, no de una sospecha: 50.000 movimientos de stock de una
  empresa —200 artículos × 250 movimientos, dos años de un comercio chico—
  hacían que `stock_valuation` tardara **25 segundos**, con el rol `aai_app` y
  la empresa en contexto, que es como consulta la API. Con el promedio
  calculado al escribir, **44 ms**.

  Lo que eso deja abierto: las demás vistas derivadas —la bandeja, que es la
  unión de veintitrés vistas; el flujo de fondos; la antigüedad de saldos— no
  se midieron con volumen. No hay motivo para suponer que estén mal, y tampoco
  para afirmar que estén bien: hasta que se midan, es una pregunta sin
  contestar. El molde para contestarla es el de la 0086 — cargar volumen en
  `aai_test`, medir con el rol de la aplicación, y guardar el número.

- **Restauración probada, y lo que la prueba encontró.** `npm run db:backup` y
  `npm run db:restaurar` cierran el ciclo: la copia se restaura en una base
  descartable (`aai_restauracion`, el único espacio de nombres que el script
  puede borrar) y se le hacen tres preguntas distintas — están los candados,
  cuadra el Mayor, y **está todo lo que había**, contando fila por fila contra
  la base viva. La tercera es la que convierte «se restauró» en «es la misma
  base»: sin ella, un backup que perdió filas pasa las otras dos sin ruido.

  La primera corrida encontró algo real: el backup que figuraba como respaldo
  era de las 08:06 y estaba **nueve migraciones atrás** (`schema_migrations`:
  58 contra 49). Ese archivo no reconstruía el sistema de hoy. Con una copia al
  día el control da verde sobre 104 tablas y 436 filas.

  Sigue faltando el otro lado: el conteo se informa **SIN EJERCITAR** porque
  `aai` no tiene datos de negocio, y el RTO medido es el de la misma máquina y
  el mismo disco, no el de una restauración real.
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
| **016** | **Un conector no escribe en el motor contable: deposita y una persona resuelve** |
| **017** | **Detectar, proyectar y simular son aritmética determinista: no llevan modelo** |
| **018** | **Un módulo que registra y no alimenta la decisión está sin terminar** |

## 10. El primer arranque

`npm run verify:arranque` recorre el día uno sobre una base **vacía de verdad**,
que crea y destruye: primer admin → sesión → estudio → empresa → rol → MFA →
plan de cuentas → ejercicio → bandeja. Está dentro de `verify`.

Existe porque `POST /auth/register-first-admin` —lo primero que hace cualquiera
con NEXO— aparecía en todo el repositorio **solo dentro de una lista de
exclusión**: el barrido de autenticación la saltea, con razón, y nadie más la
tocaba. El camino que abre el producto no lo había recorrido nadie.

Al recorrerlo aparecieron **dos pasos que no son evidentes desde afuera**, y los
dos están bien:

1. **Crear la empresa no da acceso a operarla.** El fundador recibe «No tenés
   acceso a esta empresa» sobre algo que acaba de crear, y tiene que asignarse
   un rol con `POST /companies/:id/roles`. Es coherente con el modelo —el dueño
   de un estudio no es automáticamente el contador de cada cliente— y corta el
   día uno en seco. Cambiarlo es una decisión de producto, no un arreglo.
2. **El rol contable exige segundo factor.** Ahí el sistema se defiende bien: el
   rechazo trae el camino adentro («Configuralo en `/auth/mfa/setup` antes de
   continuar»), que es como tiene que verse un error.

## 11. Cómo se levanta

```
npm run db:setup     # crea la base, migra y siembra los catálogos
npm start            # compila y levanta la API
```

El arranque **se niega a levantar** si la base quedó atrás de las migraciones, y
dice cuáles faltan y con qué comando se arreglan. No migra solo: un servidor que
corrige el esquema al reiniciarse aplica DDL que nadie pidió.

Después de escuchar imprime en qué modo corre cada integración. Los defaults de
`config.ts` son deliberadamente inertes —OCR `none`, IA `none`, ARCA `mock`— y
esa es la decisión correcta (§30), pero sin el resumen son invisibles: alguien
puede constatar un comprobante contra el mock y creer que habló con el organismo.

```
npm run db:backup    # copia de resguardo
npm run db:restaurar # la restaura en una base descartable y la verifica
```
