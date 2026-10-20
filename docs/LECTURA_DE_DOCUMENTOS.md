# Lectura de documentos: qué lee NEXO hoy, y la lectura con IA

**Escrito el 2026-10-19.** Corrige afirmaciones que figuraban en la landing, en la consola y en el manual.

## Qué se lee hoy en producción

| Formato | Qué pasa | Por qué |
|---|---|---|
| **XML** con la nomenclatura de ARCA (`CbteFch`, `ImpTotal`, `CAE`, `PtoVta`, `CbteNro`, `DocNro`…) | Se lee solo, con total exactitud | Perfil `WSFEV1` en `packages/document-engine/src/readers/xml.ts` |
| XML de otro sistema, con otros nombres | Campos vacíos con una nota | Hace falta agregar un **perfil** con su origen documentado |
| **PDF** y **fotos** (JPG, PNG) | Se **archivan** con su huella digital; la extracción responde `SIN_MOTOR_OCR` | `OCR_ENGINE=none` en el servidor: no hay ningún motor que convierta la imagen o el PDF en texto |
| CSV y planillas | Se procesan por **importación**, no por extracción de comprobante | Una planilla es un lote, no un comprobante |

Las reglas de lectura de texto (`readers/texto.ts`: «Punto de Venta», «Comp. Nro», fecha, importe…) **existen y están probadas, pero hoy nada les entrega el texto de un PDF real**: sólo las alimenta el motor simulado de las pruebas. Por eso «lee PDFs» **no** es una afirmación verdadera en producción.

### Tipos de comprobante que reconoce el catálogo

Una semilla de 27 códigos copiada del manual de ARCA (WSFEv1 v4.6): facturas, notas de débito y crédito y recibos A, B y C, las variantes «A con leyenda de retención», liquidaciones A y B y las facturas de crédito electrónicas MiPyMEs. Un código que no está **no se inventa**: se muestra el número tal cual y una persona lo resuelve. El catálogo completo es normativa versionada por fecha (`FEParamGetTiposCbte`) y se sincroniza con `scripts/sincronizar-tipos-comprobante.mjs`.

## Lo que se corrigió el 2026-10-19

- Landing: ya no dice «NEXO lo lee» ni «ingesta con OCR»; dice que los XML de ARCA se leen solos y que un PDF o una foto se archiva y se carga a mano o con el asistente.
- Consola: el texto de la pantalla Documentos, de su guía y del menú dice lo mismo.
- Manual de usuario: idem.

## Lectura con IA (a construir)

**Idea:** cuando el motor no puede leer un documento (PDF, foto, XML sin perfil, tipo desconocido), se lo pasa a un modelo (Claude) que devuelve los datos estructurados, y entran a la **misma pantalla de revisión**, marcados «leído por IA» y con su confianza. Hoy sería la **única** forma de leer un PDF o una foto, así que no es un refuerzo: es lo que hace funcionar esa carga.

Reglas que no cambian (ADR-001):

- La IA **propone y una persona decide**. No clasifica ni asienta sola; el asiento lo arma el motor contable con el mapeo, y lo aprueba una persona.
- Cada dato pasa por los controles que ya existen antes de llegar a la persona: dígito verificador del CUIT, neto + IVA = total, rango de punto de venta y número, largo del CAE, coherencia de fechas (`coherencia.ts`, `parsers/comprobante.ts`).
- Un tipo de comprobante que el catálogo no conoce se **sugiere** y una persona lo confirma; no se inventa un código.
- El original queda guardado intacto como evidencia.
- Cuenta contra el cupo diario de tokens (0141) y se puede apagar por empresa.
- El documento sale de NEXO hacia el proveedor de IA: hay que decirlo en los textos legales (hoy borradores).

Cómo se construye: un adaptador que implemente `OcrEngine` (`packages/document-engine/src/ocr/engine.ts`) en `apps/api`, igual que `chat-claude.ts` es el único archivo que conoce a Claude para el asistente; una regla de cuándo se activa; la marca «leído por IA» en la pantalla; y pruebas con documentos mal leídos a propósito.

**Antes de construirlo: medir.** Falta una muestra real: el titular deja los comprobantes de ejemplo (PDF, fotos y XML, de todos los tipos que recibe) en una carpeta local; se pasan por el motor actual y se mide cuáles reconoce, cuáles no y qué agregar (perfiles de XML, códigos de comprobante, lectura de imágenes).
