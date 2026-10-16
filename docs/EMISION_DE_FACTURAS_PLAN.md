# Emisión de facturas electrónicas desde NEXO — plan y estado

**Decisión del titular (2026-10-16): NEXO tiene que emitir facturas.** Hasta hoy la emisión estaba **cerrada a propósito** (`EMISION_HABILITADA = false`, `@aai/arca-emision` fuera del grafo de la API, `docs`: `NEXO_B2_5_4_1_FISCAL_EMISSION_SAFETY.md`): NEXO sólo constataba comprobantes. Este documento ordena lo que falta, qué se hizo hoy y **dónde tenés que intervenir vos**.

> Emitir una factura **no se deshace** (se corrige con una nota de crédito, que es otro comprobante). Por eso la emisión real se habilita **al final**, con tu orden expresa, después de probarla de punta a punta en homologación. Nada de lo hecho hoy emite nada real.

## 1 · Qué ya estaba construido (B2.5.4.1, septiembre)

La **seguridad** de emitir: máquina de estados de la intención fiscal (BORRADOR → LISTA → EMITIENDO → AUTORIZADA / RECHAZADA / DESCONOCIDA → RECONCILIANDO), idempotencia por índice único, numeración reservada con candado de fila (`reservar_numero_fiscal`), la transición `DESCONOCIDA → EMITIENDO` prohibida por la base, la puerta de 7 condiciones (`apps/api/src/fiscal/puerta.ts`), auditoría de 5 acciones, y el cliente WSFEv1 (`FEDummy`, `FECompUltimoAutorizado`, `FECAESolicitar`, tipos y condiciones de IVA) con el QR transcripto del documento oficial. Probado contra la base (S-42, 31 casos).

## 2 · Qué se hizo hoy (2026-10-16)

| Hecho | Dónde | Estado |
|---|---|---|
| **`FECompConsultar` implementado** desde el WSDL archivado (`consultarComprobante`: ENCONTRADO / NO_EXISTE / INDETERMINADO). Era el riesgo #1 del diseño | `packages/arca-emision/src/wsfev1.ts` | Probado con ARCA simulado |
| **Reconciliador fiscal** (`ReconciliadorWsfev1`): `FECompUltimoAutorizado` + `FECompConsultar` → AUTORIZADO con evidencia / NO_AUTORIZADO / EXISTE_SIN_EVIDENCIA / SIN_RESPUESTA. Regla: **ante la duda, la duda sigue**; `NO_AUTORIZADO` sólo sale de «último = reservado − 1» | `packages/arca-emision/src/reconciliador-wsfev1.ts` | 13 pruebas (red caída, credencial vencida, contradicciones, número distinto, token no filtrado) |
| **Tu certificado de homologación tiene `wsfe` autorizado** en WSASS (CUIT 20452148324). `wscdc`, `ws_sr_padron_a13` y `a100` **no** (no bloquean emitir) | consulta real a WSAA | Verificado |
| **Defecto corregido:** `arca:capabilities` pedía un ticket por servicio **sin guardarlo** y dejó `wsfe` «ocupado» (el WSAA da un ticket por CUIT y servicio, de ~12 h). Ahora usa la caché compartida y hay un guardián (S-49) | `scripts/arca-capabilities.mjs` | Corregido; **el ticket de `wsfe` de hoy quedó perdido hasta que venza (~15:00 ART)** |

**No verificado:** ninguna emisión real a homologación todavía (el ticket de `wsfe` está ocupado), así que el código de «no existe» que devuelve ARCA (`CODIGOS_DE_COMPROBANTE_INEXISTENTE = [602]`) está **sin confirmar** contra el servicio; mientras tanto cualquier otro código se trata como «no se sabe». El manual PDF archivado no se pudo leer como texto en esta sesión (no hay lector de PDF instalado); lo construido sale del **WSDL archivado**.

## 3 · Lo que falta, en orden

| # | Etapa | Qué incluye | Criterio de aceptación |
|---|---|---|---|
| **E1 ✔ 2026-10-16** | **Prueba real en homologación** | Con el ticket ya liberado: `npm run comprobantes:generar -- --cantidad 1 …` emite una Factura C de prueba (sin efecto fiscal); luego `consultarComprobante` real para confirmar el código de «no existe» | Un CAE de homologación y la consulta devuelve ese CAE; el código de inexistente queda confirmado y archivado |
| **E2 ✔ 2026-10-16** | **Caché de tickets compartida en la API** | Hoy la API pide un ticket por consulta (`arca_access_tickets` no tiene escritor, S-17): con dos consultas seguidas el WSAA rechaza la segunda. Escritor sobre esa tabla con un candado por CUIT+servicio | Dos procesos simultáneos reciben el **mismo** ticket; un ticket vencido se renueva una sola vez |
| **E3 ✔ 2026-10-16** | **Del documento comercial al comprobante** (función pura) | Tipo A/B/C/M según la condición del emisor y del receptor; concepto; documento y **condición de IVA del receptor (RG 5616: sin ella, rechazo 10246)**; alícuotas e importes con decimales exactos (nada de punto flotante); moneda y cotización; fechas de servicio | `ImpTotal = ImpTotConc + ImpNeto + ImpOpEx + ImpTrib + ImpIVA` por construcción; pruebas por tipo de emisor/receptor |
| **E4 ✔ 2026-10-16** | **Caso de uso `emitir`** | Intención → número reservado → EMITIENDO → ARCA → AUTORIZADA / RECHAZADA / DESCONOCIDA; al autorizar, enlaza el CAE con el documento comercial y la operación fiscal. Un **reconciliador periódico** (timer) para las que quedaron en duda | Las pruebas de §5 de B2.5.4.1 corren **con ARCA simulado** y luego en homologación; ninguna ruta reintenta desde DESCONOCIDA |
| **E5** | **Impacto contable de una emisión autorizada** | Hoy el documento pasa a FACTURADO sin CAE. Definir cuándo se asienta (al autorizar), con qué cuentas y qué pasa con un rechazo | Diseño escrito y aprobado por un contador **antes** de implementar; asiento balanceado y trazable al CAE |
| **E6** | **Notas de crédito y de débito** | Anular o corregir una factura emitida = comprobante nuevo con `CbtesAsoc` | Una factura autorizada sólo se corrige con una NC asociada |
| **E7** | **PDF con QR y pantalla** | El PDF que hoy genera un script pasa a la API; la consola muestra los 8 estados, el CAE, el vencimiento y descarga | Sin QR (si falta la especificación) el PDF lo dice impreso |
| **E8** | **Levantar la puerta, a sabiendas** | Quitar la regla de arquitectura `la-emision-no-llega-a-la-aplicacion`; `EMISION_HABILITADA` pasa a leerse de la configuración **y las otras 6 condiciones siguen valiendo**; habilitación **por empresa**, con ambiente (homologación / producción) y motivo en la bitácora | Revisión de código y suite completa; una empresa de homologación emite y una sin credencial **no puede** |
| **E9** | **Producción** | Certificado de producción, delegación de `wsfe` y punto de venta para web services **en producción**, confirmar y archivar con hash el extremo de producción de WSFEv1 | Primera factura real con **tu orden expresa** y un importe mínimo |
| **E10** | **Alta de cada cliente** | Cada empresa delega `wsfe` a NEXO (o sube su certificado) y declara su punto de venta; guía paso a paso | Una empresa nueva emite en homologación sin intervención de código |

## 4 · Dónde tenés que intervenir

1. **Esta tarde (E1):** nada, salvo que **el punto de venta 1 de homologación** exista como «RECE para aplicaciones y web services» para el CUIT 20452148324. Si ARCA lo rechaza al emitir, hay que crearlo en ARCA (Administración de puntos de venta y domicilios → homologación) y avisarme.
2. **Decisión: ¿quién emite y con qué condición de IVA?** (monotributista → Factura C; responsable inscripto → A/B). Define el tipo de comprobante de las facturas de **NEXO a sus clientes** (la suscripción) y de las del primer cliente. **Preguntalo a tu contador.**
3. **Decisión de producto:** ¿las facturas del cliente se emiten con el **certificado de cada empresa** (más seguro, más trámite) o con el de NEXO delegado (menos trámite, NEXO firma por el cliente)? La tabla `company_arca_credentials` está pensada para lo primero.
4. **Antes de E9 (producción):** el certificado de producción y las delegaciones en ARCA con tu clave fiscal (yo no puedo ni debo usarla), y que un **contador** valide formatos e IVA (RG 4291, RG 5616).
5. **E5 (asiento):** un contador tiene que aprobar el tratamiento contable antes de que yo lo implemente.

## 5 · Qué NO se hace sin vos

Emitir en producción, usar tu clave fiscal, crear o delegar certificados en ARCA, ni cargar credenciales de producción en el servidor. La puerta sigue cerrada: hoy `EMISION_HABILITADA = false` y lo seguirá hasta E8 con tu orden.

## 6 · Tamaño honesto

E1 es corto (hoy). E2, E3 y E4 son el grueso del código y se pueden probar enteros con ARCA simulado. E5 depende de una decisión contable. E7 y E8 son medianos. E9 y E10 dependen de trámites tuyos en ARCA. Es un proyecto de varias sesiones de trabajo, no de una; el orden de arriba es el que minimiza el riesgo de emitir algo mal.

## Resultado de E1 (2026-10-16, homologación; sin efecto fiscal)

Corrido con `scripts/generar-comprobantes-homologacion.mjs` (candados de destino en verde, `FEDummy` app/db/auth OK, certificado emitido por «Computadores Test» de AFIP), CUIT 20452148324, punto de venta 1, tipo 11 (Factura C):

| Qué | Resultado |
|---|---|
| Ticket de `wsfe` | Se pidió uno **nuevo** (el del 2026-10-15 ya había vencido); queda en la caché de tickets, vence a las 03:09 ART del 2026-10-17 |
| Último autorizado antes de emitir | 50 (fecha 20260827) |
| **Emisión** | **Comprobante 1-00001-00000051 autorizado**, Resultado `A`, **CAE 86421002204236**, vencimiento 20261024 (el CAE no es secreto) |
| `consultarComprobante` del 51 | `ENCONTRADO`, **el mismo CAE**, mismo importe y fecha |
| `consultarComprobante` del 1051 (no existe) | `NO_EXISTE` con el error **602** «No existen datos en nuestros registros para los parametros ingresados» y ningún otro |

**Conclusiones.**
- El punto de venta 1 de homologación **sí está habilitado** para web services: no hace falta ninguna gestión del titular para E2–E4.
- `CODIGOS_DE_COMPROBANTE_INEXISTENTE = [602]` **queda confirmado**; se quitó de `contracts.ts` la nota «a confirmar».
- La consulta real de un comprobante recién autorizado devuelve el mismo CAE que la emisión: el reconciliador (E4) puede apoyarse en `consultarComprobante` para decidir «ya existe» sin volver a emitir.
- Nada se emitió en producción ni con otro CUIT.

## Resultado de E2 (2026-10-16): la API ya no pelea por el ticket del WSAA

**Qué se construyó.** `TicketCacheDb` (`apps/api/src/arca/ticket-cache-db.ts`) implementa el puerto `TicketCache` sobre la tabla `arca_access_tickets` (ya existía, sin escritor). El paquete `@aai/arca` ganó un método **opcional** `obtenerOCrear` en `TicketCache`, que `loginConCache` y el cliente SOAP prefieren cuando existe; las cachés de un solo proceso (memoria, archivo) no cambian. La ruta de constatación de comprobantes ya usa la caché compartida.

| Garantía | Cómo | Prueba |
|---|---|---|
| Dos procesos simultáneos reciben el **mismo** ticket | candado de base por (ambiente, CUIT, servicio) tomado **antes** de leer; el segundo entra y encuentra lo que escribió el primero | 8 pedidos a la vez → **1** login, 1 token; dos instancias de la caché → 1 login |
| Un ticket vencido se renueva **una sola vez** | ídem | 6 pedidos a la vez sobre uno vencido → 1 login |
| El ambiente es parte de la identidad | la instancia fija el ambiente; la tabla lo guarda | un ticket de homologación no sirve en producción; `mock` no tiene tickets |
| Por vencer **no** deja sin servicio | el WSAA no da otro hasta que el anterior vence de verdad (`alreadyAuthenticated`): si el guardado todavía vale, se usa ese; con cualquier otro error, el error sale | probado, incluido el caso «ya vencido del todo» |
| Un login que falla no escribe ni deja el candado tomado | transacción | el pedido siguiente funciona |
| Un proceso lento no pisa un ticket más nuevo | `put` sólo reemplaza por uno que vence después | probado |

Se comprobó con una **mutación**: sin el candado, fallan exactamente las tres pruebas de concurrencia.

**Dos defectos del diseño anterior que esto corrige de paso.** (1) `get` + `login` + `put` no es atómico entre procesos. (2) Un margen de renovación sin salida de emergencia deja una ventana de minutos sin ticket: el `TicketCacheFs` del CLI renueva diez minutos antes y el WSAA lo rechaza hasta que vence de verdad. **No se tocó el CLI** (pedido aparte si molesta).

**El token es una credencial.** `tests/security/tickets-arca-confinados.test.ts`: sólo la caché nombra la tabla, no loguea ni devuelve `token`/`sign`, y la tabla no tiene `company_id` (la exportación de una empresa no la alcanza). Queda dicho: la copia de seguridad conserva los tickets de las últimas horas; vencen solos.

**No verificado:** contra el WSAA real desde la API (el CLI ya lo probó en E1, pero la ruta de la API con `TicketCacheDb` sólo está probada contra un WSAA simulado). Se prueba junto con E4 en homologación.

## Resultado de E3 (2026-10-16): el comprobante se arma solo y ARCA lo acepta

**Qué se construyó.** `armarComprobante` (`packages/arca-emision/src/armado.ts`), una **función pura** (sin red ni base): recibe emisor, receptor, líneas, fecha y número ya reservado, y devuelve el pedido `FECAESolicitar` (cabecera y detalle) **o la lista completa de lo que impide armarlo**. `letraDeFactura` también está exportada (la pantalla va a necesitar decir «esta factura va a ser una B» antes de armar nada). El cliente WSFEv1 ganó `tiposDeIva` y `tiposDeDocumento`, y los importes del detalle aceptan **texto decimal** (ya no se pasan por `number`).

| Regla | De dónde sale |
|---|---|
| **La letra**: emisor RI → A si el receptor es RI o monotributista, B si es exento / consumidor final / no categorizado; emisor monotributista o exento → C | **RG 1415/2003, arts. 15 y 16** (texto archivado), probada combinación por combinación |
| **Los códigos**: `CbteTipo` 1/6/11, condición del receptor, `Id` de alícuota (3, 4, 5, 6, 8, 9), `DocTipo` | Tablas que **contestó ARCA en homologación** (`docs/normative-sources/extracted/arca-wsfev1-tablas-homologacion-2026-10-16.json`); una prueba compara cada constante contra ese JSON |
| **Condición del receptor obligatoria y admitida por la letra** (A: 4 · B: 7 · C: 11) | RG 5616/2024 + `FEParamGetCondicionIvaReceptor` |
| `ImpTotal = ImpTotConc + ImpNeto + ImpOpEx + ImpTrib + ImpIVA` | **Por construcción**: el total no se recibe, se calcula, con centavos enteros (`Money`); 300 combinaciones aleatorias lo comprueban |
| **Factura C sin nodo `Iva`** (ni vacío); A y B lo mandan agrupado por alícuota | Comprobado hasta el XML del sobre |
| Concepto 1/2/3 según las líneas; el servicio exige período y vencimiento de pago | WSDL |
| La alícuota se **deduce de forma exacta** de IVA/neto o se pide; si no cierra, se rechaza | No se supone |

**Lo que NO se arma todavía, y se rechaza con motivo:** notas de crédito/débito (`CbtesAsoc`, E6), tributos y percepciones (importe ≠ 0), otra moneda que pesos o dólares, documentos extranjeros. **No decide:** la fecha contra «hoy» (la ventana depende del concepto; la verifica E4) ni el umbral de identificación del consumidor final (lo fija ARCA y cambia: hoy se arma y **avisa**).

**Prueba real contra ARCA (homologación, CUIT 20452148324, sin efecto fiscal).** Armadas por `armarComprobante` y enviadas, **una vez cada una**:

| Comprobante | Resultado de ARCA |
|---|---|
| **Factura C** nº 52, a consumidor final sin identificar, $ 1.500,00 | **Autorizada**, CAE 86421002211511 |
| **Factura B** nº 1, a consumidor final, neto $ 1.000,00 + IVA $ 210,00 | **Autorizada**, CAE 86421002211524 |
| **Factura A** nº 1, a responsable inscripto (CUIT de prueba con dígito válido), neto $ 1.500,00 en dos alícuotas (21 % y 10,5 %), IVA $ 262,50 | **Autorizada**, CAE 86421002211537, con la **observación 10217** («el crédito fiscal discriminado … sólo podrá ser computado a efectos del Procedimiento permanente de transición al Régimen General»: es informativa, no un rechazo) |

Es decir: **el mismo certificado de homologación puede emitir A, B y C** —ARCA no distingue la condición del emisor en homologación—, y el armado de importes, alícuotas agrupadas, condición del receptor y concepto es aceptado por el servicio real. **Esto NO prueba** cuál es la condición del emisor real ni qué letra le corresponde en producción: eso sigue siendo la decisión **D1** (preguntarle al contador).

**Pruebas:** 55 casos nuevos en `armado.test.ts`; se comprobó con dos mutaciones (letra del monotributista mal asignada, y el nodo `Iva` en una C) que fallan.

## Resultado de E4 (2026-10-16): emitir y reconciliar, probados de punta a punta — y un defecto de diseño encontrado a tiempo

### El hallazgo: **ARCA no tolera huecos de numeración, y un rechazo no consume número**

La migración 0117 (septiembre) suponía lo contrario: «si ARCA rechaza, ese número se consumió; los huecos existen». Se **midió contra ARCA en homologación**: pedir el número *último + 2* se rechaza con el error **10016** («el número o fecha del comprobante no se corresponde con el próximo a autorizar») y el último autorizado no se mueve; un comprobante rechazado tampoco lo avanza. Con el diseño anterior, **después del primer rechazo la numeración de ese punto de venta quedaba trabada para siempre**: el contador local seguía de largo y ARCA exigía el número anterior.

**Corrección (migración 0138):** el número de una intención **RECHAZADA** (y de una ANULADA) vuelve a estar libre; el de una **DESCONOCIDA / RECONCILIANDO sigue ocupado** (puede estar autorizada; reusarlo sería la doble emisión por otro camino). `reservar_numero_fiscal_correlativo(intención, último_autorizado_por_ARCA)` sincroniza el contador con ARCA y reserva **el siguiente al último autorizado**, serializando por *carril* (empresa, ambiente, punto de venta, tipo): **una sola emisión en curso por carril** (la numeración es secuencial). Se niega si ARCA informa un último menor que el que esta empresa ya tiene autorizado.

### Qué se construyó

| Pieza | Dónde | Qué hace |
|---|---|---|
| `emitirIntencion` | `packages/arca-emision/src/emitir.ts` | BORRADOR → LISTA → EMITIENDO → AUTORIZADA / RECHAZADA / DESCONOCIDA, con ARCA y la base detrás de puertos |
| `reconciliarIntencion`, `reconciliarPendientes` | ídem | Averigua lo que quedó en duda y recupera las EMITIENDO huérfanas. **Nunca emite** |
| `TransporteWsfev1` | ídem | El transporte real: `FEDummy`, `FECompUltimoAutorizado`, `FECAESolicitar` sobre el cliente WSFEv1 y la caché compartida de tickets (E2) |
| `RepositorioSqlDeEmision` | `apps/api/src/fiscal/repositorio-de-emision.ts` | Cada método es **una transición con su precondición de estado**, en su propia transacción, con bitácora |
| Migración 0138 | `infrastructure/db/migrations/` | La numeración correlativa (arriba) |

**Las reglas que el caso de uso hace cumplir** (cada una con prueba):
1. **De la duda no se sale emitiendo.** EMITIENDO, DESCONOCIDA o RECONCILIANDO devuelven `EN_DUDA` sin siquiera consultar a ARCA. Barrido: ninguna combinación de desenlaces y reintentos pide más de un CAE por intención.
2. **EMITIENDO se persiste *antes* de llamar** (transacciones separadas): si el proceso muere, queda «puede haber salido» y la pasada periódica lo recupera.
3. **Todo fallo posterior a EMITIENDO es duda**, no error: timeout, respuesta ilegible, resultado parcial, «autorizado» con evidencia que no sirve. Sólo una respuesta inequívoca cierra la intención. Si ARCA autorizó y no se pudo escribir, el CAE se devuelve para dejar constancia.
4. **Lo que no se puede saber *antes* de enviar no toca nada**: `FEDummy` o la consulta del último autorizado que fallan → `SERVICIO_NO_DISPONIBLE`, la intención sigue como estaba.
5. **Si el comprobante no se puede armar, no se reserva número** (un número reservado que no sale traba el punto de venta), y **lo armado tiene que ser lo declarado** (tipo y punto de venta de la intención).

**Pruebas:** 35 con ARCA y repositorio simulados (el repositorio respeta la máquina de estados de la base); 12 de la numeración correlativa contra la base; 11 **de punta a punta contra la base real** (camino feliz con bitácora, timeout y cinco reintentos que no llegan a ARCA, rechazo que libera el número, dos emisiones simultáneas con **una sola** llamada a ARCA, huérfana recuperada, precondiciones, aislamiento entre empresas). Se comprobó con mutaciones que dejar emitir desde DESCONOCIDA o persistir EMITIENDO después de llamar rompe pruebas.

### Contra ARCA real (homologación, CUIT 20452148324, sin efecto fiscal)

- **`emitirIntencion` con el transporte real**: Factura C nº 53 **autorizada** (CAE 86421002220314), transiciones `LISTA → EMITIENDO → AUTORIZADA`; llamarla otra vez devuelve lo mismo sin pedir otro CAE.
- **`ReconciliadorWsfev1` real**: sobre el nº 53 → `AUTORIZADO` con la evidencia completa (CAE y vencimiento, vía `FECompConsultar`); sobre el 54 → `NO_AUTORIZADO` («ARCA no avanzó su numeración»); sobre el 58 (salteado) → `SIN_RESPUESTA`/inconsistente, **sin adivinar**.

### Lo que queda fuera de E4 (a propósito)

- **El cableado a la aplicación** (endpoint, permisos, temporizador del reconciliador): es **E8**, porque exige levantar la regla `la-emision-no-llega-a-la-aplicacion`. Por eso tres funciones figuran en S-16 como «sin consumidor» con su motivo.
- **Enlazar el CAE con el documento comercial y la operación fiscal**, y el asiento contable: son **E5** (decisión contable) y **E7**.
- La clasificación «no salió / sí salió» después de EMITIENDO: **toda** falla posterior se trata como duda (la máquina de estados no tiene `EMITIENDO → LISTA`); lo común (ARCA caída) se descubre antes, sin tocar la intención.
