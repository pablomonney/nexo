# Verificación visual de las 16 pantallas de detalle — 2026-10-15

**Estado: 15 de 16 recorridas y verificadas · 1 BLOQUEADA · la verificación visual COMPLETA no se declara** (§7).
Todo esto es **local**: la API aislada contra `aai_test` en esta máquina. **Producción no se tocó ni se verificó.**

## 1 · Dónde se hizo

| | |
|---|---|
| Servidor | `node scripts/servir-contra-pruebas.mjs`, puerto 3002 |
| Base | `aai_test` en `localhost:5432` (local, de pruebas). La guardia del guion se niega a arrancar contra cualquier otra |
| Hacia afuera | **pagos = none · correo = none · IA = none** (lo dice el banner de arranque); ARCA en **homologación** y **no se consultó**: nunca se apretó «Consultar a ARCA» |
| Navegador | el integrado del escritorio, viewport emulado de **800 × 560**, tema oscuro |
| Datos | sintéticos, sembrados por la API (§2). **Ningún dato real** |

La base de desarrollo `aai` y la de producción no participaron. Ver §6 para el incidente en el que se arrancó, a los pocos segundos, la configuración equivocada.

## 2 · Los datos sintéticos

Los crea `scripts/sembrar-datos-visuales.mjs` **por la API**, con un usuario de prueba que crea `scripts/provisionar-usuario-visual.mjs`
(alta autoservicio → verificación del correo → empresa vacía → segundo factor). Las credenciales viven **fuera del repositorio**.
Los guiones se niegan a hablar con otro destino que `http://localhost:3002`.

| Qué | Cuántos | Cómo reconocerlo |
|---|---|---|
| Empresa | 1 («Empresa de prueba visual SRL», CUIT inventado con dígito verificador válido) | razón social |
| Terceros | 3: dos clientes (Norte, Sur) y un proveedor | nombre `VIS …` + marca de la corrida |
| Vendedor | 1 | código `VIS-V1-<marca>` |
| Depósitos / productos | 2 / 2 (uno con stock, un servicio) | `VIS-D1…`, `VIS-P1…`, `VIS-S1…` |
| Movimientos de stock | 3 (ajuste con costo, transferencia de dos filas, ajuste negativo) | motivo que empieza con «VIS» |
| Comprobantes | 6: 3 ventas, 1 nota de crédito, 2 compras (con constatación **declarada**, no consultada) | documentos `visual-<marca>-<n>.xml` |
| Cobranzas / imputaciones | 2 asientos aprobados / 2 imputaciones | descripción «VIS …» |
| Correcciones de la nota | 2 | — |
| Decisión contable | 1 (después corregida desde la consola) | justificación «VIS …» |
| Listas de precios | 2, una asignada a un cliente | `VIS-LP1/LP2…` |
| Etapas del embudo | 4 | `VIS-…` |
| Orden de pago / solicitud de compra | 1 / 1 (borradores) | — |
| Banco | 1 cuenta, 1 mapeo, 2 extractos, 2 asientos, 1 conciliación | `VIS Banco …` |

Los ids por pantalla quedan en `var/visual/datos-sembrados.json` (no se versiona).

**Lo que se cambió DESDE LA CONSOLA al probar** (también vive en `aai_test`): se renombró dos veces al vendedor; se agregó un rol a un tercero y se le asignó una lista de precios; se renombró una etapa; se editaron los renglones de la orden de pago y de la solicitud; se vinculó un tercero y se cargó el detalle de un comprobante; se corrigió dos veces la decisión de una venta; se anularon dos imputaciones y una corrección; se confirmaron dos coincidencias bancarias; se intentó declarar el marco contable (409: ya estaba declarado).

**Cómo limpiarlo.** Los libros son append-only (asientos, movimientos, bitácora): no hay `DELETE` por diseño y no se limpia de a una fila.
La limpieza es **rehacer `aai_test`**: `DROP DATABASE aai_test; CREATE DATABASE aai_test;` y `npm run db:migrate` con `DATABASE_URL`
apuntando a ella (después `npm run db:setup`-style seeds si se quiere el catálogo). Un usuario de prueba nuevo se crea con el guion de arriba.

## 3 · Resultado por pantalla

Veredictos: **PASS** · **PASS tras corrección** (se halló un defecto abriendo la pantalla y se corrigió; el guion de aceptación se repitió después) · **BLOQUEADO**.
La evidencia de cada una es la **respuesta de la red** (método, ruta, código), lo que quedó **dibujado** (leído del DOM) y una **captura** de `var/visual/capturas/`.

| # | Pantalla (consola → sección) | Ruta que ejercita | Veredicto | Defectos | Captura |
|---|---|---|---|---|---|
| 1 | Comisiones → ficha de vendedor, editar | `PUT /salespeople/:id` | PASS tras corrección | V-1, V-2 | `01-vendedor-editar` |
| 3 | Estados y notas → «de dónde sale» | `GET /statements` | **BLOQUEADO** (§5) | — | `03-estados-sin-plantilla-para-SRL` |
| 4 | Bancos → proponer, confirmar, traza | `POST …/propose`, `…/matches`, `GET /banks/trace/:id` | PASS tras corrección | V-5, V-6, V-7, V-11 | `04-conciliacion-confirmada-de-donde-sale` |
| 5 | Operaciones → crédito fiscal de IVA | `GET /vat/credito-fiscal/:id` | PASS | — | `05-credito-fiscal-iva` |
| 6/7 | Operaciones → renglones del comprobante | `GET`/`PUT /tax-transactions/:id/lines` | PASS | — | `06-07-renglones-del-comprobante` |
| 8 | Terceros → imputaciones de un comprobante | `GET /tax-transactions/:id/allocations` | PASS tras corrección | V-3, V-9 | `08-15-imputaciones-y-anulacion` |
| 9/10 | Terceros → correcciones (y anular una) | `GET …/correcciones`, `POST /tax-transaction-corrections/:id/cancel` | PASS tras corrección | V-1, V-3, V-9 | `09-10-correcciones-de-la-nota` |
| 11 | Operaciones → vincular a un tercero | `POST /tax-transactions/:id/party` | PASS tras corrección | V-8 | `11-vincular-tercero` |
| 14 | Operaciones → corregir la decisión | `POST /comprobantes/:id/decision/supersede` | PASS tras corrección | V-1 | `14-historial-de-decisiones` |
| 15 | Terceros → anular una imputación | `POST /party-allocations/:id/cancel` | PASS tras corrección | V-1 | `08-15-imputaciones-y-anulacion` |
| 16/17 | Terceros → lista de precios asignada | `GET`/`POST /parties/:id/price-lists` | PASS | — | `16-17-18-roles-y-listas-de-precios` |
| 18 | Terceros → agregar rol | `POST /parties/:id/roles` | PASS | — | `16-17-18-roles-y-listas-de-precios` |
| 19 | Existencias → movimientos de un producto | `GET /products/:id/movimientos` | PASS | (obs. O-1) | `19-movimientos-del-producto` |
| 20 | CRM → editar etapas declaradas | `PUT /crm/stages/:id` | PASS | (obs. O-4) | `20-editar-etapas-del-embudo` |
| 21 | Pagos → renglones de la orden | `PUT /payment-orders/:id/renglones` | PASS tras corrección | V-10 | `21-editar-renglones-de-la-orden-de-pago-ANTES-de-V-10` |
| 22 | Solicitudes → renglones de la solicitud | `PUT /purchase-requests/:id/renglones` | PASS | — | `22-editar-renglones-de-la-solicitud` |

Las capturas de las pantallas corregidas **se tomaron antes o después de la corrección según el caso** (la 21 y `defecto-V-9-ANTES-…` muestran el defecto; el resto, el estado final); la comprobación posterior a cada corrección se hizo leyendo el DOM y la red.

**7 PASS · 8 PASS tras corrección · 1 BLOQUEADO.** Además se recorrió Configuración (marco contable) y apareció V-4.

## 4 · Defectos hallados abriendo las pantallas (todos corregidos y con prueba)

Ninguno lo veía una prueba de integración: llaman a la API, no dibujan una pantalla. Cada uno tiene una prueba de regresión en
`tests/security/consola-regresiones-visuales.test.ts` (18 pruebas) y una **mutación que reintroduce el defecto y la hace fallar**
(18 mutaciones sobre la consola y su API, todas detectadas).

| Id | Qué se veía | Causa | Corrección |
|---|---|---|---|
| V-1 | «Vendedor actualizado», «Decisión corregida», «Imputación cancelada», «Corrección cancelada»: **el aviso de éxito no aparecía** | Se avisaba y DESPUÉS se releía la pantalla, y la relectura limpia el contenedor del aviso | Se relee primero y se avisa después |
| V-2 | Al renombrar un vendedor, el título de la ficha seguía con el nombre viejo | El título se reusaba de la memoria | Se arma con el nombre recién guardado |
| V-3 | Abrir a un cliente después de otro: **el select de comprobantes traía las facturas del primero** (con saldos de antes de imputar) y se podía elegir una ajena para imputar, corregir o declarar su plan de pagos | Se vaciaba un select de cuatro | Se vacían los cuatro |
| V-9 | Debajo de la ficha de un cliente seguían **dibujadas las imputaciones y correcciones del anterior**, como si fueran suyas | No se limpiaban sus tablas al cambiar de tercero | Se vacían junto con los selects |
| V-4 | «Declarar el marco contable» era un **botón muerto**: se apretaba y no pasaba nada, sin error | Su `onclick` se perdía con el siguiente `caja.innerHTML +=` (la misma trampa que ya había mordido tres veces) | Por delegación en el contenedor, y una prueba que prohíbe `E(…).onclick =` en `cargarConfig` |
| V-5 | «Proponer» conciliación daba `bankAccountId: No es un identificador válido` | El select de cuenta nacía **sin selección** (`sel.value = ''` deja `selectedIndex = −1`); la pantalla pedía `/banks/accounts//…` | Se elige la primera si no había una |
| V-6 | El select de mapeos decía «— sin mapeos cargados —» **teniéndolos** | Texto fijo | Dice «— elegí un mapeo —» cuando hay |
| V-11 | «Confirmar esta» contestaba «no hay ninguna conciliación abierta» con una abierta en la lista | Mismo patrón que V-5 | Queda elegida la abierta |
| V-7 | La traza de una conciliación mostraba `2026-10-12T03:00:00.000Z` donde va una fecha | La API serializa las fechas de la vista como instantes | La consola muestra el día |
| V-8 | **«Vincular» desvinculaba por defecto**: la única opción vacía decía «desvincular» y era la elegida; abrir un comprobante ya vinculado y apretar «Vincular» sin tocar nada **le sacaba el tercero**, y la pantalla nunca mostraba con quién estaba vinculado | El listado de operaciones no traía el tercero | `GET /tax-transactions` agrega `terceroId` (aditivo); «elegí un tercero» y «desvincular» son opciones distintas; el vinculado queda elegido |
| V-10 | En el editor de la orden de pago, «En otras órdenes» **contaba la propia orden** | `pagables` sumaba todas las órdenes vivas | `GET /payment-orders/pagables` acepta `excluirOrdenId` (aditivo) y el editor lo manda |

## 5 · La pantalla bloqueada: estados contables (#3)

`GET /statements` responde a esta empresa: **«FUENTE NO ENCONTRADA: no hay plantilla ESP vigente al 2026-12-31 para marco RT_FACPCE, ente SRL
y regulador IGJ»**. Es el comportamiento diseñado (el sistema no arma una estructura por su cuenta), pero tiene una consecuencia de producto:

> El catálogo trae plantillas **sólo para SA** (Ley 19.550, arts. 63 y 64; IGJ; RT FACPCE), y `scripts/statement-templates.mjs` lo dice a
> propósito («no se replican para los otros once tipos de ente»). **Una SRL —la forma más común de pyme— no puede armar sus estados contables.**

Esto es un **bloqueo para el primer cliente si es una SRL** (ver `docs/BLOQUEOS_PRIMER_CLIENTE.md`), y no se resuelve escribiendo código: qué estructura
corresponde a cada tipo de ente es una decisión con norma detrás. Lo que sí está probado, a nivel de API y con una SA, es que una cifra publicada llega hasta los
movimientos que la formaron (`tests/integration/estados-contables.test.ts`, «una cifra publicada llega hasta los movimientos»). La parte de la consola
(la tabla «de dónde sale» sobre un estado armado) **no se pudo ver con datos**.

## 6 · Incidentes de la sesión

1. **Primer incidente (previo).** Se inició brevemente la configuración `nexo` de `.claude/launch.json` (base de desarrollo `aai`, `.env` real). La aplicación se negó a arrancar
   —faltaban migraciones— y se la detuvo a los segundos. Sin escrituras.
2. **Segundo incidente (hoy), el mismo error por otro camino.** Al pedir `preview_start` con `name: "nexo-pruebas"`, la herramienta levantó la configuración **`nexo`** (puerto 3001,
   `npm start`, base `aai`). Se la detuvo a los 6 segundos: la API se negó a arrancar («faltan 3 migraciones: 0131, 0132, 0133») y salió con código 1.
   **No hubo escrituras en `aai`.** Sí corrió `tsc --build` (regenera `dist/`, no toca datos).
   **Causa real (hallada después):** la herramienta no lee sólo `.claude/launch.json` del repositorio: resuelve el de la **carpeta superior** (`proyecto uca/.claude/launch.json`, fuera de git), que también tenía la
   configuración `nexo`. Arreglar sólo el del repositorio no alcanzaba, y por eso el incidente se repitió.
   **Corregido (2026-10-15):** ambos archivos tienen **una sola** configuración, `nexo-pruebas` (`node scripts/servir-contra-pruebas.mjs`, puerto 3002), que arranca el servidor **sólo contra la base de pruebas** (reescribe cualquier nombre de base local a `<nombre>_test` y se niega ante una URL remota o de producción).
   La configuración `nexo` (`npm start` con el `.env` normal) **ya no existe en ninguno de los dos archivos**, así que no hay con qué arrancar la aplicación normal desde esta herramienta. (No se volvió a pedir `name: "nexo"` para comprobarlo: sería provocar el incidente. La prueba negativa es estática, sobre los archivos.)
   Lo protege `tests/security/launch-json-solo-pruebas.test.ts` (S-48): controla el archivo del repositorio y, si existe, el de la carpeta superior (éste no está en git: en otra máquina o en CI el control sólo ve el primero).
   **Comando correcto** (desde `accounting-ai-argentina/`, que es donde está `.env`):
   ```bash
   node scripts/servir-contra-pruebas.mjs      # puerto 3002, base aai_test (reescribe cualquier nombre de base local a <nombre>_test)
   ```
   o `preview_start` con `name: "nexo-pruebas"`. Para volver a poner la aplicación «normal» en la herramienta hay que **agregar a propósito** una configuración nueva y tocar S-48.
3. **Incidente de proceso en las mutaciones.** La primera corrida de las mutaciones de base (quitar un índice único) se hizo sobre `aai_test` y las propias pruebas dejaron filas con clave duplicada que impidieron recrear el índice.
   Se reparó (50 filas de prueba, índice recreado) y se rehízo sobre una copia descartable. Detalle en `docs/DISENO_IDEMPOTENCIA.md` §10.

## 7 · El bloqueo de las capturas, y por qué la verificación visual NO se declara completa

**Qué pasaba.** El navegador integrado devolvía `viewport 0×0` y la captura vencía a los 5 s («la página no terminó de dibujarse»): la ventana de la aplicación estaba oculta.

**Qué se logró.** Con `resize_window` (viewport emulado) y `tabs_select` antes de capturar, la **segunda** captura sale (la primera tras seleccionar la pestaña vence siempre). Con eso se tomaron **16 capturas** en
`var/visual/capturas/` (no se versionan) y, sobre todo, se leyó el DOM y la red de cada acción, que es lo que sostiene los veredictos de §3.

**Lo que NO está verificado y por eso la verificación visual no está completa:**

- **Un solo tamaño:** 800 × 560. A 1280 × 900 la captura salió **repetida en mosaico (2×2)**: un defecto de la captura, no de la página, pero no hay evidencia de cómo se ve a ese ancho. Móvil y tableta, tampoco.
- **Un solo tema:** el oscuro. El claro no se miró.
- **Un solo navegador** (el integrado) y ningún dispositivo real.
- **Las demás pantallas** (decenas) no se recorrieron: sólo las 16 de este informe, más Configuración.
- La **traza de una cifra de un estado contable** (#3) no se vio por el bloqueo de §5.

## 8 · Observaciones (no son defectos de esta pasada; quedan en el backlog)

- **O-1** — «Registrado por» muestra `user:<uuid>` en lugar del nombre de la persona (movimientos de stock y de caja).
- **O-2** — La tabla de propuestas de conciliación muestra dos UUID (movimiento del banco y línea del asiento) en vez de fecha, importe y descripción: nadie puede juzgar una coincidencia mirando dos UUID.
- **O-3** — En el historial de decisiones, `EMITIDA` (la vigente) y `SUPERSEDIDA` tienen la misma pastilla amarilla.
- **O-4** — El campo «Nombre» del editor de etapas es angosto (muestra «VIS Primer con…»).
- **O-5** — La explicación de «¿Cierra?» de una conciliación habla en unidades menores («77700», «1312200») dentro de una frase para personas.
- **O-6** — Abrir una operación desde la bandeja no deja elegido el tercero vinculado (esa ruta no pasa por el listado): queda «— elegí un tercero —», que ya es seguro, pero no informativo.
- **O-7** — Agregar un rol a un tercero reemplaza el aviso de éxito por «Ya tiene los dos roles.»: es informativo, pero «Rol agregado.» nunca se ve.

## 9 · Cómo repetirlo

```bash
node scripts/servir-contra-pruebas.mjs                                   # terminal 1
node scripts/provisionar-usuario-visual.mjs ../credenciales-visual.json  # terminal 2 (el archivo, FUERA del repo)
node scripts/sembrar-datos-visuales.mjs ../credenciales-visual.json
# opcional: --solo=banco  /  --solo=banco2   (agregan sin duplicar el resto)
```

Después se abre `http://localhost:3002/consola`, se ingresa con el usuario de prueba y se recorren las pantallas de §3.
