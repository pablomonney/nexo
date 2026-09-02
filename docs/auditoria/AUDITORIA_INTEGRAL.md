# Auditoría integral — de ERP construido a producto

**Fecha:** 2026-09-02
**Alcance:** las cinco dimensiones pedidas — ERP funcional, integración,
contabilidad, producto y SaaS — sobre el árbol en `8a7d418`.

**Método.** Se inspeccionó el repositorio y el esquema real antes de escribir
nada: 73 migraciones aplicadas, 130 tablas, 71 vistas, 156 triggers, 99
políticas RLS, 89 permisos, 205 endpoints en 37 archivos de ruta, 31 pantallas y
70 archivos de test propios. No se consultó ningún README para afirmar qué
existe. Cuando una cifra viene de una medición, se dice de cuál.

> **Dos instrumentos rotos antes del primer hallazgo.** El primer barrido de
> «qué exporta cada paquete que la API no usa» armaba una expresión regular por
> concatenación dentro de `node -e` y el escapado la dejó inservible: informó
> `withCompany` como no usada cuando la importa cada ruta. El segundo tokenizaba
> el fuente entero —comentarios incluidos— y daba por alcanzada a `decidir`
> porque la palabra aparece en prosa castellana. El tercero lee las cláusulas
> `import` y es el que se usa acá. Queda escrito porque un instrumento roto que
> informa hallazgos es peor que no medir, y las dos primeras versiones habrían
> producido un informe con nombres y todo.

---

## 1 · Estado actual: qué está construido de verdad

| Dimensión | Estado |
|---|---|
| **Motor contable-fiscal** | Maduro. Diario, Mayor, períodos, ejercicios, cierre y apertura, estados contables, notas, IVA, subdiarios, ARCA en homologación. Con candados en la base, no en la aplicación. |
| **Cobertura ERP** | Amplia. Los nueve bloques del orden de ejecución están cerrados (cheques, compras, lotes, caja, CRM, proyectos, comisiones, sucursales, suscripciones). |
| **Integración entre módulos** | Alta y sin duplicar verdad: ningún módulo guarda cifras que otro pueda contradecir. |
| **Aislamiento multiempresa** | Verificado por barrido: **cero** tablas con `company_id` sin RLS forzado. |
| **Producto para no técnicos** | **Bajo.** Una consola técnica de un solo archivo, declarada como provisoria por su propio README. |
| **SaaS comercializable** | **Parcial.** La arquitectura de planes existe; el alta autoservicio, el cobro y la operación productiva no. |
| **Web comercial** | **No existe.** Ni página pública, ni dominio, ni despliegue. |

### Lo que una empresa puede hacer hoy

Registrar y constatar comprobantes de venta y de compra; llevar clientes y
proveedores con cuenta corriente y antigüedad de saldos; presupuestar, pedir,
facturar, recibir mercadería y conciliar tres puntas; manejar stock por depósito
y por lote, con recuento físico; llevar caja con arqueo, bancos con conciliación
y cheques con su cartera; declarar listas de precios y planes de cuotas;
registrar asientos con trazabilidad hasta el papel; cerrar el ejercicio; emitir
estados contables con notas; ver analítica con drill-down; y —desde esta
auditoría— pasarle al Diario cuatro detectores de anomalías.

---

## 2 · El hueco central: **el Mayor se escribe a mano**

Es el hallazgo más importante y el que más condiciona todo lo demás.

**Evidencia.** `INSERT INTO journal_entries` aparece en exactamente dos lugares
de la aplicación: `routes/journal-entries.ts` (la carga manual) y
`routes/closures.ts` (cierre y apertura). En las 73 migraciones **no hay un solo
trigger** que cree un asiento. Es decir: **el único hecho de negocio que produce
asientos por sí solo es el cierre de ejercicio.**

Todo lo demás —facturar, cobrar, pagar, recibir mercadería, amortizar, arquear
la caja, devengar una comisión— exige que una persona escriba el asiento
renglón por renglón. Cada módulo lo dice honestamente en su documentación («este
módulo no toca el Mayor»), y esa decisión es correcta para el módulo: lo que
falta es el paso que la resuelve una sola vez para todos.

### Y el motor que lo resolvería ya está escrito

`packages/accounting-engine/src/decision-de-comprobante.ts` produce una
`PropuestaDeAsiento` con sus renglones. La API lo llama en
`routes/decisions.ts`. Pero:

1. le inyecta `armarLineas` como **`() => []`**, así que la propuesta sale
   siempre **sin renglones**;
2. la respuesta del endpoint **no devuelve la propuesta**: se calcula y se
   descarta en cada llamada.

**Por qué está así, y qué falta de verdad.** Armar los renglones exige saber a
qué cuenta va cada cosa. Una parte del mapeo ya está declarada —`products`
tiene cuenta de venta y de compra, `accounts.tax_role` distingue IVA débito de
IVA crédito— pero **la contrapartida no**: no existe en ningún lado la
declaración de cuál es la cuenta de deudores por ventas ni la de proveedores de
esta empresa. Sin eso, armar el asiento exigiría elegir una cuenta por el
sistema, que es exactamente lo que este proyecto no hace.

No es un bloqueo externo: es una **declaración que falta**, del mismo tipo que
la tarifa horaria de proyectos o el esquema de comisión. Se resuelve con un
mapeo contable declarado por empresa, y sin declararlo el sistema seguiría sin
proponer nada — que es el comportamiento correcto.

---

## 3 · Piezas construidas sin camino hasta ellas

Barrido de importaciones de `apps/api` sobre cada paquete:

| Paquete | Funciones importadas | Lectura |
|---|---|---|
| `db` | 5/5 | — |
| `accounting-engine` | 19/33 | Sano: lo no importado son auxiliares internos. |
| `financial-statements` | 7/14 | Sano. |
| `bank-engine` | 6/14 | Sano. |
| `tax-engine` | 6/14 | Sano. |
| **`audit-engine`** | **0/10** | **Hueco. Resuelto en esta auditoría.** |
| `normative-engine` | 1/14 | Parcial: la vigilancia de normas corre por script, no por API. |
| `ai-engine` | 2/15 | Coherente con ADR-001: la IA propone y no alcanza el motor contable. |
| `arca-emision` | 0/3 | **Deliberado**: el lint de arquitectura prohíbe que la API lo importe. |
| `sandbox` | 0/3 | **Deliberado**: lo consume `scripts/sandbox.mjs`. |

**`@aai/audit-engine` no lo importaba nadie** — ni la API, ni un script, ni otro
paquete. Cuatro detectores determinísticos con 28 tests propios que nunca habían
visto un asiento real. Es la misma clase de hueco que ya apareció con la
bitácora (escrita por 35 acciones y leída por ninguna) y con el Integration Hub
(cuya única entrada era un endpoint que ningún conector llamaba).

**Quedó conectado en esta auditoría**: `GET /audit/anomalias`, con pantalla en la
consola y `tests/integration/anomalias.test.ts`.

---

## 4 · Auditoría contable

`npm run verify` en verde después de los cambios: **96 archivos de test, 1.693
tests, 353 objetos estructurales presentes, 0 discrepancias entre el Mayor y el
Diario, cadena de bitácora íntegra** en las dos empresas de verificación.

Los invariantes A-1 a A-14 se comprueban con datos reales en cada corrida. Los
tres módulos más recientes (0071 comisiones, 0072 sucursales, 0073
suscripciones) **no escriben en el Mayor**: leen. Se verificó explícitamente en
sus tests que devengar una comisión y suspender un plan no generan asientos, y
que el conteo de `journal_entries` no cambia.

### Riesgos contables detectados

| Riesgo | Evidencia | Gravedad |
|---|---|---|
| Todo asiento operativo es manual | §2 | **Alto**: a volumen real, el error de tipeo es la fuente de descuadre más probable, y ningún candado protege contra imputar a la cuenta equivocada. |
| Sin valuación de existencias no hay costo de mercadería vendida | `COBERTURA_ERP.md` §6 | **Alto**: el resultado del ejercicio no incluye el costo de lo vendido. |
| El cliente ARCA real tiene poca cobertura | 55,17 % de líneas y 22,22 % de funciones en `apps/api/src/arca` | Medio: los tests corren contra el simulador; el camino SOAP real se ejercita poco. |
| `packages/db` mide 0 % de cobertura | El paquete resuelve a `dist` y no a `src` | Bajo, pero es un **instrumento** que informa cero sobre código que se ejecuta en cada request. |

Ninguno de los cuatro es una inconsistencia del Mayor actual: son huecos de
alcance y de medición.

---

## 5 · Producto: qué falta para que lo use alguien que no programa

La interfaz es **un archivo**: `apps/web/consola.html`, 6.726 líneas, sin build
ni framework. Su propio README la declara provisoria: «es la consola con la que
se opera y se demuestra el circuito **mientras esa interfaz no exista**».

Lo que sí tiene, y no es poco: 31 pantallas, permisos aplicados a la navegación,
estados vacíos con explicación, mensajes de error del dominio, y un control (S-12)
que verifica en las dos direcciones que cada llamada resuelva contra una ruta
registrada y que cada dominio de la API tenga puerta.

Lo que falta para una persona no técnica:

1. **Identificadores a la vista.** Varias pantallas piden pegar un uuid en un
   campo de texto —vincular un presupuesto al CRM, atribuir una venta a un
   vendedor, imputar una conciliación—. Un uuid no se copia de memoria.
2. **Onboarding.** No hay asistente de puesta en marcha. Una empresa nueva
   necesita plan de cuentas, ejercicio, períodos, puntos de venta, depósitos y
   centros de costo antes de poder registrar nada, y hoy eso se descubre
   pantalla por pantalla.
3. **Ningún flujo guiado.** Cada pantalla es un ABM correcto; el recorrido
   «facturar y cobrar» exige saber por cuáles pasar y en qué orden.
4. **Exportación.** Solo Diario y Mayor en CSV. Los estados contables, la
   analítica y los subdiarios se leen en pantalla y no se pueden llevar.
5. **Impresión de comprobantes.** No hay representación imprimible de una
   factura, un recibo ni una orden de pago.

---

## 6 · SaaS

| Pieza | Estado |
|---|---|
| Multiempresa con aislamiento verificado | **Hecho** |
| Identidad, MFA, sesiones, bloqueo por intentos | **Hecho** |
| Roles y permisos por empresa | **Hecho** |
| Auditoría encadenada y consultable | **Hecho** |
| Planes, suscripción por empresa con vigencia, uso medido | **Hecho** (0073) |
| Topes por plan | **Estructura hecha, valores sin declarar** — decisión comercial |
| Precios | **No existen**, y no deben inventarse |
| Alta autoservicio | **No existe**: `register-first-admin` sirve una sola vez por instalación y las empresas las crea un administrador del estudio |
| Cobro / pasarela | **Bloqueado** por credenciales |
| Límite de velocidad HTTP | **No existe** |
| Métricas y trazas | **No existen**; solo `GET /health` y `/health/db` |
| Despliegue productivo | **No existe**: hay `docker-compose` de desarrollo, no hay imagen de la aplicación ni workflow de deploy |
| Backups | Scripts manuales (`npm run db:backup`, `npm run db:restaurar`), sin programación |

---

## 7 · Web comercial

**No existe ninguna de las tres piezas.** No hay sitio público, no hay dominio,
no hay entorno productivo. `apps/web` contiene la consola y nada más.

Construirla ahora sería prematuro por una razón concreta y no por prudencia
genérica: una web comercial que ofrezca «probar NEXO» necesita un alta
autoservicio y un entorno donde probarlo, y no existe ninguno de los dos.

---

## 8 · Bloqueos, clasificados

**Implementable ahora** (sin decisiones ni fuentes externas):

- mapeo contable declarado por empresa y propuesta de asiento con renglones;
- exportación de estados contables y analítica;
- asistente de puesta en marcha;
- selectores en vez de campos de uuid;
- límite de velocidad HTTP;
- imagen de la aplicación y despliegue;
- métricas y trazas.

**Requiere decisión de producto:**

- método de valuación de existencias (PPP, FIFO o costo de reposición);
- qué regímenes de retención se soportan;
- precios y topes de cada plan;
- si NEXO admite facturación parcial (remitos y devoluciones dependen de eso);
- métodos de amortización distintos de lineal.

**Requiere fuente externa:**

- diseños de registro del Libro IVA Digital (el art. 8° remite a un micrositio
  no archivado);
- normas de cada régimen de retención;
- calendario de vencimientos impositivos.

**Requiere credenciales:**

- conectores por API (Tiendanube, Mercado Pago, bancos);
- proveedor de pagos de las suscripciones;
- certificado de producción de ARCA.

**No prioritario:** producción (BOM y órdenes) depende de valuación; RRHH sigue
bloqueado por ADR-012 §8.

---

## 9 · Prioridades

| # | Tarea | Prioridad | Por qué |
|---|---|---|---|
| 1 | **Mapeo contable declarado + propuesta de asiento con renglones** | **P0** | Sin esto cada asiento se tipea. Es el techo de uso real del producto. |
| 2 | Asistente de puesta en marcha | **P0** | Hoy una empresa nueva no sabe por dónde empezar. |
| 3 | Valuación de existencias | **P1** | Sin ella no hay CMV ni margen: el resultado del ejercicio está incompleto. |
| 4 | Selectores en vez de uuids, y exportaciones | **P1** | Es lo que separa «se puede operar» de «se puede operar sin ayuda». |
| 5 | Despliegue, métricas y backups programados | **P1** | Nada de lo anterior sirve si no corre en algún lado. |
| 6 | Retenciones | **P2** | Alto valor y alta dependencia externa: exige elegir regímenes y archivar sus normas. |
| 7 | Límite de velocidad y alta autoservicio | **P2** | Necesarios para abrir el registro al público. |
| 8 | Web comercial | **P3** | Depende de que exista algo que mostrar y dónde probarlo. |

---

## 10 · Retenciones o valuación: la recomendación

Se analizaron las dos, y **la respuesta es que ninguna de las dos va primero**.

**Retenciones.** Impacta cada pago a proveedores y cada cobranza de clientes, y
en Argentina es lo primero que una empresa nota que falta. Pero exige dos cosas
que no dependen del código: elegir qué regímenes se soportan (Ganancias, IVA,
SUSS, IIBB por jurisdicción — cada uno con su cálculo, su mínimo no sujeto y su
certificado) y **archivar sus normas**, que es una fuente externa. Además, una
retención mal calculada es un pasivo fiscal del cliente: el costo de
equivocarse es más alto que en cualquier otro módulo.

**Valuación de existencias.** Desbloquea más: costo de mercadería vendida,
margen real por producto y por sucursal, y el costo del producto terminado del
que depende producción. Exige una sola decisión —qué método— con una RT detrás,
y no depende de ninguna fuente que no esté publicada. Es la mejor candidata
entre las dos.

**Pero antes va el mapeo contable y la propuesta de asiento.** El argumento es
de evidencia, no de gusto: hoy el sistema puede registrar una venta, mover el
stock, calcular la comisión, atribuirla a una sucursal y proyectar su cobranza
—y para que esa venta llegue al balance alguien tiene que escribir el asiento a
mano. Agregar valuación o retenciones sobre esa base agrega más cifras que
alguien va a tener que transcribir. El orden que sigue de la evidencia es:
**mapeo y propuesta → valuación → retenciones.**

---

## 11 · Roadmap

**FASE A — Correcciones críticas.** Ninguna pendiente: `verify` está en verde y
no se detectaron inconsistencias del Mayor. Los cuatro riesgos del §4 son de
alcance, no defectos.

**FASE B — Completar el ERP.**
Objetivo: que un hecho de negocio llegue al balance sin tipeo.
Tareas: mapeo contable declarado por empresa; `armarLineas` real; exponer la
propuesta; crear el asiento desde ella sin aprobarlo automáticamente; después
valuación de existencias y CMV.
Criterio de aceptación: una factura de venta produce un asiento propuesto,
firmado por una persona, cuyo Mayor coincide con el Diario.

**FASE C — Producto.**
Objetivo: que lo use alguien que no programa.
Tareas: asistente de puesta en marcha; selectores en lugar de uuids; flujos
guiados de venta y de compra; exportaciones; comprobante imprimible.
Criterio: una persona sin instrucción previa completa el circuito de venta.

**FASE D — SaaS.**
Tareas: alta autoservicio con verificación de correo; topes declarados por plan;
límite de velocidad; administración del estudio.
Criterio: una empresa nueva se da de alta y opera sin intervención manual.
Bloqueado: precios y cobro.

**FASE E — Web comercial.** Después de D, porque necesita algo que probar.

**FASE F — Producción.** Imagen de la aplicación, despliegue, secretos fuera del
entorno, métricas, trazas, backups programados y restauración verificada
periódica.

**FASE G — Escalabilidad.** Índices sobre las consultas de analítica, particionado
de la bitácora, y el trabajo asíncrono que hoy no existe.

---

## 12 · Lo que se implementó durante esta auditoría

1. **`@aai/audit-engine` conectado.** `GET /audit/anomalias` corre los cuatro
   detectores sobre los asientos aprobados, con pantalla en la consola y seis
   tests de integración. El detector `JUSTO_BAJO_UMBRAL` no corre —sus umbrales
   salen de normas no archivadas— y el `comentario` lo dice en vez de devolver
   una lista vacía que se leería como «no encontré nada».

2. **Un falso verde propio, corregido.** El primer filtro de la consulta decía
   `status = 'APPROVED'` y la base escribe `APROBADO`: la ruta devolvía cero
   asientos revisados y tres de mis seis tests pasaban sin haber mirado nada.
   Lo delató el único test que afirmaba algo positivo. El test del período ahora
   exige `asientosRevisados > 0` antes de comparar.

3. **El hueco central, cerrado: migración 0074 y ADR-019.** El mapeo contable se
   declara por empresa (`company_account_map`, seis roles), un trigger comprueba
   que la cuenta sirva para el rol, y
   `GET /tax-transactions/:id/asiento-propuesto` devuelve los renglones. Sin
   mapeo no propone nada y **dice qué rol falta por su nombre**; con conceptos
   que el mapeo no cubre —no gravado, exento, percepciones— tampoco propone,
   porque un asiento cuadrado y equivocado pasa todos los controles y dice una
   mentira. La ruta no escribe en el Diario: los renglones se cargan por
   `POST /journal-entries`, entran en borrador y los aprueba una persona. Un
   test recorre el camino entero y comprueba que el Mayor quede en 121.000
   contra 121.000.

   Con esto, el **P0 #1** de la tabla del §9 queda hecho. La tabla se conserva
   como estaba —es el estado que la auditoría encontró— y lo que cambió se
   registra acá.

4. **El P0 #2 también: migración 0075.** `GET /onboarding` contesta qué le falta
   a una empresa para trabajar, contando filas en vez de tildando pasos —un
   tilde puede decir «listo» sobre una empresa sin período abierto—. Tres pasos
   bloquean y van a la bandeja; los otros siete habilitan un módulo y no le
   hacen falta a toda empresa: reclamarle depósitos a un estudio contable
   enseña a ignorar la lista.

5. **Un hallazgo que salió de construirla: los dominios de estado mezclan
   idiomas.** `accounts` y `company_arca_credentials` usan `ACTIVE`; `parties` y
   `products` usan `ACTIVO`; `cash_boxes` y `branches` usan `ACTIVA`;
   `journal_entries` usa `APROBADO`. Comparar contra el valor equivocado **no
   falla**: cuenta cero y nadie se entera. Dos de mis propios errores en esta
   auditoría salieron de ahí. Unificarlos exigiría migrar datos y romper
   contratos de la API, así que queda anotado como **P3** con su evidencia;
   mientras tanto, el test de la puesta en marcha comprueba que cada contador se
   mueva cuando se crea la cosa que cuenta, que es lo que atrapa el error sin
   cambiar el esquema.

6. **Y una nota de método.** Estas dos últimas entradas se escribieron primero
   con un script de shell y el intérprete se comió cada acento grave: el
   documento quedó con frases como «los dominios de estado mezclan idiomas: y
   usan , y usan». Se reescribieron con el editor. Es el mismo cuidado que el
   resto del informe pide para los instrumentos de medición, aplicado a la
   herramienta con la que se escribe.

## 13 · Segunda tanda: la ejecución posterior

Lo que se implementó después, siguiendo el orden de prioridades del §9. Cada
bloque tiene su commit y sus tests.

| # | Qué | Migración / archivo | Tests |
|---|---|---|---|
| P0 | Asistente de puesta en marcha, completo | 0076 | `puesta-en-marcha` (10) |
| P1 | Valuación de existencias y CMV | 0077, 0078 (ADR-020) | `valuacion` (11) |
| P1 | Conciliación bancaria: **no se podía abrir** | `banks.ts` | `conciliacion-por-http` (6) |
| P1 | Selectores en lugar de uuids | consola | (cubierto por S-12) |
| P1 | Exportaciones a CSV | `exportaciones.ts` | `exportaciones` (5) |
| P1 | Imagen, sondas y guía de despliegue | `Dockerfile`, `docs/DESPLIEGUE.md` | — |
| P1 | Métricas apagadas por defecto | `observabilidad.ts` | `metricas` S-13 (4) |
| P2 | Límite de intentos por origen | `limite-de-intentos.ts` | `limite-de-intentos` S-14 (5) |
| P2/P3 | SaaS y web: qué falta y por qué | `docs/roadmap/SAAS_Y_WEB.md` | — |

### Tres hallazgos que salieron de construir, no de auditar

1. **`bank_reconciliations` no tenía ni un `INSERT`.** Ni ruta ni trigger. Se
   podían proponer coincidencias y confirmarlas, pero no crear la conciliación
   que las sostiene: los dos endpoints existentes eran inalcanzables. Lo
   destapó la auditoría de selectores — la consola pedía el identificador con un
   `prompt`, y un campo que pide un uuid sin decir de dónde sacarlo casi siempre
   está tapando que no hay de dónde.

2. **Los dominios de estado mezclan idiomas.** `ACTIVE`, `ACTIVO`, `ACTIVA`,
   `APROBADO`. Comparar contra el valor equivocado no falla: cuenta cero. Dos
   errores propios salieron de ahí en una sola sesión. Queda como **P3** con su
   evidencia: unificarlos exige migrar datos y romper contratos de la API.

3. **El barrido S-12 tenía un punto ciego.** Marcó el dominio `exports` como
   inalcanzable cuando sí lo era: las descargas pasan por un ayudante que llama
   a `fetch` adentro, y el barrido solo conocía dos formas de llamada. Se
   corrigió el instrumento, no la lista de excepciones.

### Y uno que no era un hallazgo

Estuve por anotar que «cualquier token inválido produce un 500». Lo medí de
nuevo con el pool de base inicializado y contesta 200: el 500 era del banco de
pruebas, que no lo inicializaba. Queda escrito acá y en el encabezado de
`tests/security/metricas.test.ts` para que el próximo no repita el diagnóstico.

**Estado del árbol al cerrar:** `verify` en verde — 103 archivos de test, 1.742
tests, 369 objetos estructurales, 0 discrepancias entre el Mayor y el Diario.
