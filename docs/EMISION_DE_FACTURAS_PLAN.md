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
| **E2** | **Caché de tickets compartida en la API** | Hoy la API pide un ticket por consulta (`arca_access_tickets` no tiene escritor, S-17): con dos consultas seguidas el WSAA rechaza la segunda. Escritor sobre esa tabla con un candado por CUIT+servicio | Dos procesos simultáneos reciben el **mismo** ticket; un ticket vencido se renueva una sola vez |
| **E3** | **Del documento comercial al comprobante** (función pura) | Tipo A/B/C/M según la condición del emisor y del receptor; concepto; documento y **condición de IVA del receptor (RG 5616: sin ella, rechazo 10246)**; alícuotas e importes con decimales exactos (nada de punto flotante); moneda y cotización; fechas de servicio | `ImpTotal = ImpTotConc + ImpNeto + ImpOpEx + ImpTrib + ImpIVA` por construcción; pruebas por tipo de emisor/receptor |
| **E4** | **Caso de uso `emitir`** | Intención → número reservado → EMITIENDO → ARCA → AUTORIZADA / RECHAZADA / DESCONOCIDA; al autorizar, enlaza el CAE con el documento comercial y la operación fiscal. Un **reconciliador periódico** (timer) para las que quedaron en duda | Las pruebas de §5 de B2.5.4.1 corren **con ARCA simulado** y luego en homologación; ninguna ruta reintenta desde DESCONOCIDA |
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
