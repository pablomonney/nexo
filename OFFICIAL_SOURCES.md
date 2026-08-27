# OFFICIAL_SOURCES.md — Registro de Fuentes Oficiales

> **Relevamiento: 2026-08-24 · Descarga y archivado: 2026-08-24.**
> Registro maestro de fuentes normativas. Cada afirmación lleva un **nivel de verificación**.
> El sistema no puede usar como regla activa nada que no esté en nivel `V1`.
>
> **Estado: 32 documentos oficiales archivados en `docs/normative-sources/originals/` con hash
> SHA-256.** Los dos últimos, el **2026-08-27**: los textos actualizados de la **RG 3561/2013**
> (controladores fiscales) y la **RG 5198/2022** ("Facturador"), que cerraron el último gap del
> régimen de comprobantes. Los siete anteriores se archivaron el **2026-08-26**: la Ley de IVA (t.o. 1997) y las
> fichas de los Decretos 280/97 y 841/84, la Res. P. CPCECABA 460/2024 —que cerraron los tres
> bloqueos de fuente del roadmap— y después la ficha de la RG 4892/2020, las especificaciones del
> QR y el WSDL del wsfev1. Índice completo en `docs/normative-sources/registro-de-descargas.csv`.

## 0. Niveles de verificación

| Nivel | Significado | ¿Puede generar una regla activa? |
|-------|-------------|----------------------------------|
| `V1 — VERIFICADO OFICIAL` | Documento obtenido de dominio oficial y **archivado con hash** | Sí |
| `V2 — OFICIAL INDIRECTO` | La norma existe y fue vista en un índice oficial, pero **no se descargó el texto** | No. Solo backlog |
| `V3 — SECUNDARIO` | Solo hay fuente privada (estudio, blog, prensa, proveedor). *Pista de investigación* | **Nunca** |
| `V4 — NO VERIFICABLE CON FUENTE OFICIAL DISPONIBLE` | No se encontró fuente oficial pública | **Nunca**. Bloquea la funcionalidad |

**Regla dura:** una regla contable o fiscal en producción debe apuntar a una `norm_version` con
nivel `V1` y documento original archivado (§49 del pliego). Sin eso, el motor devuelve
`FUENTE NO ENCONTRADA` y escala a revisión profesional.

---

## 1. Jerarquía de fuentes implementada

```
P1  Constitución Nacional · Leyes · Decretos · Boletín Oficial
P2  Organismos de aplicación y control: ARCA · IGJ · CNV · BCRA · INAES · fiscos provinciales
P3  FACPCE (RT, Interpretaciones, Res. JG) · Consejos Profesionales (adopción jurisdiccional)
P4  Material oficial explicativo: guías, manuales de desarrollador, ABC/FAQ oficiales
S   Doctrina, prensa especializada, proveedores: solo apoyo interpretativo, jamás fuente de regla
```

**Matiz argentino crítico — ahora confirmado por texto oficial.** Una Resolución Técnica de
FACPCE no es derecho vigente por sí sola: adquiere obligatoriedad cuando el Consejo Profesional
de la jurisdicción la adopta, y cada consejo puede fijar vigencia distinta. Esto no es una
interpretación nuestra: la propia IGJ lo dice en el art. 226 sustituido por la RG 9/2026
(ver §4.2).

---

## 2. ARCA (ex AFIP)

Los dominios `afip.gob.ar` y `arca.gob.ar` conviven; la documentación técnica de web services
sigue publicada bajo `afip.gob.ar/ws/` y los endpoints WSAA bajo `afip.gov.ar`.

### 2.1 Autenticación — WSAA · `V1`

Fuente: <https://www.afip.gob.ar/ws/documentacion/wsaa.asp>

| Ítem | Valor |
|------|-------|
| Mecanismo | Certificado digital **X.509 emitido por la Autoridad Certificante de ARCA** + mensaje **CMS** firmado → *Ticket de Acceso (TA)* |
| Endpoint homologación | `https://wsaahomo.afip.gov.ar/ws/services/LoginCms` |
| Endpoint producción | `https://wsaa.afip.gov.ar/ws/services/LoginCms` |
| Alta cert. homologación | **WSASS** |
| Alta cert. producción | **Administrador de Certificados Digitales** (con Clave Fiscal) |
| Delegación a un tercero | **Administrador de Relaciones de Clave Fiscal** |

**Consecuencia de arquitectura:** el sistema nunca es titular de la relación fiscal. Cada empresa
cliente delega el servicio al CUIT que opera el software, o aporta su certificado. Ver `SECURITY.md`.

### 2.2 Web services de emisión · `V1`

Fuente: <https://www.afip.gob.ar/ws/documentacion/ws-factura-electronica.asp>

| WS | Norma | Alcance | Manual |
|----|-------|---------|--------|
| `wsfev1` | RG 4291 | Comprobantes A, B, C y M **sin** detalle de ítem. CAE y CAEA | v4.6 — **archivado** |
| `wsmtxca` | RG 2904 | Comprobantes A y B **con** detalle de ítems | v0.25.7 |
| `wsfexv1` | RG 2758 y RG 4401 | Comprobantes tipo E (exportación) | v3.1.1 |
| `wsbfev1` | RG 5427/2023 y RG 2861 | Bono Fiscal Electrónico | v3.0 |
| `wsseg` | RG 2668 | Pólizas de caución. **Ojo: RG 2668 derogada por RG 5866/2026** | v0.9 |
| `wsct` | RG 3971 | Alojamiento a turistas extranjeros | v1.6.4 |

> El caso `wsseg` es un buen ejemplo de por qué hace falta el motor normativo: el catálogo técnico
> sigue publicando el servicio con su norma de respaldo **ya derogada**. La documentación técnica
> de un organismo no es prueba de vigencia.

### 2.3 Web services de consulta y validación · `V1`

Fuente: <https://www.afip.gob.ar/ws/documentacion/catalogo.asp>

| WS | Uso en este sistema | WSAA |
|----|---------------------|------|
| `wscdcv1` — **Constatación de comprobantes** | Núcleo de *Validación Fiscal*. Manual v4 **archivado** | Sí |
| `ws_sr_padron_a13` | Datos de padrón del emisor/receptor. Manual v1.4 **archivado** | Sí |
| `ws_sr_padron_a4` | Datos tributarios y regímenes | Sí |
| `ws_sr_padron_a10` | Información resumida del contribuyente | Sí |
| `ws_sr_padron_a100` | **Tablas y parámetros** — sincroniza catálogos. Manual v2.1 **archivado** | Sí |
| `ws_sr_constancia_inscripcion` | Constancia de inscripción | Sí |
| `wsapoc` | **Contribuyentes apócrifos** → alertas de riesgo de proveedor | Sí |
| `TRABAJO_F931` | DDJJ F931 → conciliación de asientos de sueldos | Sí |
| `sud_restricciones`, `sud_contrataciones` | **Uso restringido** (bancos / proveedores del Estado) | Sí |
| `wscec` | Régimen de Economía del Conocimiento | Sí |

> Advertencia del catálogo oficial: *"Para usar ciertos servicios se requieren autorizaciones y
> acuerdos especiales con ARCA"*. Las capacidades se modelan por empresa y se degrada sin romper.

### 2.4 "Mis Comprobantes" — `V4 NO VERIFICABLE`

**No existe web service oficial de "Mis Comprobantes" en el catálogo de ARCA.** Lo verificado es la
*ausencia*. Los SDK comerciales que lo ofrecen "por API" automatizan la navegación del portal con
Clave Fiscal.

**ADR-004: no se implementa.** Ingesta por archivo exportado, subida y email. Ver `docs/RISKS.md` R-03.

Matiz relevante: la RG 5707/2025 sustituyó el art. 7° de la RG 4597 estableciendo que en el
servicio web *"se pondrá a disposición de los responsables la información que obre en las bases de
datos del Organismo respecto de los comprobantes que hubieran sido emitidos y/o recibidos"*, y el
art. 8° admite **importación de datos según diseños de registro publicados en el micrositio IVA**.
Es decir: hay un camino oficial de intercambio por archivo, aunque no un WS de consulta.

### 2.5 Normativa fiscal operativa · `V1` — **archivada**

| Norma | Materia | Datos confirmados en el texto oficial |
|-------|---------|----------------------------------------|
| **RG 4597/2019** (T.O.) | Libro de IVA Digital | Norma base del régimen de registración electrónica |
| **RG 5707/2025** | Portal IVA · Libro de IVA Digital · IVA Simplificado | Emitida 30/05/2025, publicada 02/06/2025. **Art. 2: vigencia 01/12/2025**, salvo la derogación del Título II ("IVA Simplificado") que rige desde **01/07/2025**. Art. 12 sustituido: registración mensual y presentación **dentro de los primeros 15 días corridos del mes siguiente**; obligación de presentar aun sin operaciones informando **"SIN MOVIMIENTO"**; un período solo puede presentarse si se generó el anterior |
| **RG 5616/2024** | Emisión de comprobantes; condición IVA del receptor; moneda extranjera | Emitida 17/12/2024, publicada 18/12/2024. Modifica RG 1415, 3561, 4291 y 5198. **Art. 5: vigencia el día de la publicación.** Cronograma: manuales y homologación externa 15/01/2025; **nueva versión de WebService de uso obligatorio desde 15/04/2025**; Comprobantes en Línea 15/01/2025; Facturador Móvil y Facturador 05/03/2025 |
| **RG 5866/2026** | Régimen de emisión de comprobantes | Publicada 29/06/2026. Modifica RG 1415 y 4291; **deroga RG 2668, 2719 y 5824**. Vigencia 01/07/2026, con disposiciones desde 01/10/2026 y cronograma escalonado de nuevos obligados hasta 01/03/2027 |

**Efecto:** la FASE 8 (IVA) queda desbloqueada. Ver §6, C-01.

---

## 3. FACPCE y Consejos Profesionales

### 3.1 Norma Unificada Argentina de Contabilidad — cadena completa · `V1`

Los cinco documentos de la cadena están archivados. Secuencia verificada **en los textos**:

| Norma | Fecha | Qué hace |
|-------|-------|----------|
| **RT 54** | 01/07/2022 (Corrientes) | Aprueba la NUA — **solo Introducción y Primera Parte**. Art. 2: obligatoria para ejercicios iniciados desde **01/01/2024**; anticipada desde 01/01/2023. Art. 3: **derogaciones** (ver 3.2). Art. 5: encomienda a CENCyA el Apéndice A (normas de transición) y el Apéndice B |
| **RT 56** | 30/06/2023 | Texto ordenado. Incorpora Título Segundo (normas particulares), Título Tercero (normas específicas) y **Apéndice A**. Según FACPCE, **traslada la vigencia a ejercicios iniciados desde 01/07/2024** |
| **RT 59** | 28/06/2024 (CABA) | "Aclaraciones previas a la implementación de la RT 54". Art. 2 reemplaza el índice y la segunda parte de la RT 54 (T.O. RT 56). Art. 3 ratifica arts. 4° y 5° de la RT 56. **Art. 4 sustituye el punto 7 de la RT 26**: una entidad que deja las NIIF aplica el Apéndice A con enfoque retroactivo integral (párr. A11-A12), con solución práctica opcional (A15-A17) |
| **RT 62** | 2025 | Incorpora **Capítulo 12 "Estados contables de entidades cooperativas"**, absorbiendo requerimientos de la RT 24 |
| **Res. JG 660/2026** | 27/03/2026 | **Dispensa transitoria** por restricciones operativas para la primera aplicación. **No posterga la vigencia.** Exige revelar en nota: (a) los cambios que se habrían presentado y (b) los hechos que motivaron la dispensa |

> **Nótese la evolución de la fecha de vigencia: 01/01/2024 (texto original) → 01/07/2024 (según
> RT 56) → 01/01/2025 en CABA.** Tres valores distintos para "la vigencia de la RT 54". Un motor
> con un solo campo `fecha_vigencia` no puede representar esto.

### 3.2 Alcance derogatorio de la RT 54 — **resuelto con el art. 3° del texto oficial** · `V1`

La RT 54 deroga, **a partir de su aplicación efectiva inicial**:

| Categoría | Normas derogadas |
|-----------|------------------|
| Resoluciones Técnicas completas | **RT 6** (moneda homogénea), **RT 8** (exposición general), **RT 9** (exposición entes comerciales), **RT 11** (exposición entes sin fines de lucro), **RT 17** (cuestiones de aplicación general), **RT 41** (entes pequeños y medianos), **RT 42** (entes medianos), **RT 48** (remedición de activos) |
| Parcialmente | **RT 18** secciones 4 "Arrendamientos" y 5 "Reestructuraciones"; **RT 21** sección 3 "Información sobre partes relacionadas" |
| Interpretaciones | **1, 2, 3, 7, 8 y 11** |
| Res. JG / MD FACPCE | 360/07, 394/10, 395/10, 735/13, 765/14, 879/17, 527/17, 913/18, 536/18, 929/18, 549/19 |
| Res. JG 539/18 (T.O. 584/21) | apartados 3.7 y 3.8; secciones 4, 6 y 7 |

**Lo que NO deroga — y es lo que más importa para el motor:**

- **RT 16 no está en la lista.** El marco conceptual sigue vigente.
- **RT 26 no está en la lista.** Al contrario: la RT 54 se dirige a entidades que preparan estados
  contables *"de acuerdo con normas contables profesionales distintas a las referidas en la
  RT 26"* (considerando c). La RT 26 —NIIF— sigue siendo la vía separada.
- **RT 44 y RT 45 no están en la lista.**

Esto cierra el conflicto C-03 y desbloquea la determinación de marco aplicable.

### 3.3 Adopción jurisdiccional · `V1` (CABA) / `V2` (resto)

| Consejo | Acto | Vigencia declarada |
|---------|------|--------------------|
| **CPCECABA** | **Resolución P. N° 460/2024** (Presidencia, CABA, **11/07/2024**) aprueba la RT 59 FACPCE y la declara norma profesional obligatoria en CABA · **archivada** | Art. 5° inc. a): ejercicios **iniciados desde 01/01/2025**, sin exigir aplicación a los períodos intermedios del primer ejercicio. Art. 5° inc. b): anticipada para ejercicios **finalizados desde 30/09/2024** |
| **CPCECABA** | Resolución CD 70/2025 adopta la RT 62 | Desde su publicación en el BO de CABA: **26/12/2025** |
| **CPCE Córdoba** | Resolución 35/24 adopta RT 54, 56, 59 y Res. JG FACPCE 608/22 | A confirmar en el texto · `V2` |

El acto está archivado y cargado en `norm_adoptions` (`npm run norms:seed`), con el documento
como evidencia y el artículo del que sale cada fecha. Es la primera adopción jurisdiccional del
sistema: hasta que existió, el motor respondía `ADOPCION_NO_RELEVADA` para CABA.

> **Corrección.** Hasta que se archivó el documento, esta tabla decía *"Resolución 460/2024
> (Consejo Directivo, 21/08/2024, Acta 1302)"*. Las tres cosas son incorrectas y venían de
> material secundario. El documento dice **Resolución P. N° 460/2024**, la firman la Presidenta
> y la Secretaria el **11 de julio de 2024**, y su art. 8° ordena *"elévese al Consejo
> Directivo"* — es decir, no fue dictada por él. Es el §2 en un caso concreto: el resumen era
> plausible, estaba en todos lados, y era falso en el organismo y en la fecha.

Portal de normas: <https://normasweb.facpce.org.ar/>

---

## 4. IGJ — jurisdicción CABA

### 4.1 Marco general · `V1`

- **RG 15/2024** — Normas de la IGJ. Texto actualizado **archivado** desde InfoLeg.
- Índice oficial 2026: <https://www.argentina.gob.ar/justicia/igj/marco-normativo-igj/resoluciones-generales-ano-2026>

### 4.2 RG IGJ 9/2026 — texto completo archivado · `V1`

Fuente: <https://servicios.infoleg.gob.ar/infolegInternet/anexos/425000-429999/427313/norma.htm>

| Ítem | Valor |
|------|-------|
| Identificador | RESOG-2026-9-APN-IGJ#MJ |
| Emisión | 01/07/2026 · Publicación 02/07/2026 |
| Vigencia | **Art. 11: día siguiente al de la publicación** → 03/07/2026 |
| Estructura | 12 artículos |
| Deroga (Anexo A RG 15/2024) | arts. 128, 227, 228, 229, 231, 233, 234, 241, 302, 303, 304, 305, 306, 323, 348, 349 |
| Sustituye | arts. 129, 130 (plazos), **226** (normas técnicas), **230** (opción NIIF), 232, 300, 322, 347 |
| Migración | Art. 10: presentaciones en trámite pueden migrarse al Sistema a opción del presentante |

**El texto del art. 226 sustituido — la cita que valida el diseño del motor normativo:**

> *"Las sociedades anónimas y las de responsabilidad limitada cuyo capital alcance el importe
> fijado por el artículo 299 inc. 2 de la Ley N.° 19.550 (T.O. 1984) […] confeccionarán sus estados
> contables de acuerdo con las normas técnicas profesionales vigentes (Resoluciones Técnicas de la
> Federación Argentina de Consejos Profesionales de Ciencias Económicas) **adoptadas por el Consejo
> Profesional de Ciencias Económicas de la Ciudad Autónoma de Buenos Aires**."*

Además: (a) los estados usados para VPP y los consolidados requieren informe de auditoría de
contador público independiente; (b) no se admiten certificaciones literales.

**Art. 230 sustituido:** las sociedades **podrán optar** por presentar sus estados contables
conforme a NIIF o NIIF para las PyMES.

**Consecuencia:** el organismo de control no remite a "la RT vigente" sino a **la RT adoptada por
el consejo de la jurisdicción**. La tabla `norm_adoptions` no es una precaución de diseño: es lo
que el derecho aplicable exige modelar.

### 4.3 Resto de RG IGJ 2026 · `V1` (índice) / `V2` (textos)

| RG | Materia | Impacto |
|----|---------|---------|
| 10/26 | Notificación electrónica de resoluciones particulares | Bajo |
| 9/26 | Estados contables (arriba) | **Alto** |
| 7/26 | Sistema Online de Documentación Abierta (SODA) | Medio |
| 6/26 | Prórroga de moratoria para balances adeudados | Medio |
| 5/26 | Plancha de inscripción digital con firma digital | Medio |
| 4/26 | Inscripción de sociedades extranjeras | Bajo |
| 3/26 | Administradores y reuniones | Bajo |
| 2/26 | Elaboración participativa de normas | Bajo |
| 1/26 | Inscripción de autoridades | Bajo |

---

## 5. Normativa de fondo · `V1`

### 5.1 Código Civil y Comercial — Ley 26.994

Edición oficial SAIJ **archivada**. **Sección 7ª "Contabilidad y estados contables", Libro Primero,
Título IV, Capítulo 5: arts. 320 a 331** (pág. 65 de la edición). Títulos verificados en el texto:

| Art. | Título |
|------|--------|
| 320 | Obligados. Excepciones |
| 321 | Modo de llevar la contabilidad |
| 322 | Registros indispensables |
| 323 | Libros |
| 324 | Prohibiciones |
| 325 | Forma de llevar los registros |
| 326 | Estados contables |
| 327 | Diario |
| 328 | Conservación |
| 329 | Actos sujetos a autorización |
| 330 | Eficacia probatoria |
| 331 | Investigaciones |

Art. 320, primer párrafo (textual): *"Están obligadas a llevar contabilidad todas las personas
jurídicas privadas y quienes realizan una actividad económica organizada o son titulares de una
empresa o establecimiento comercial, industrial, agropecuario o de servicios."*

Texto plano de trabajo en `docs/normative-sources/extracted/CCyC.txt`.

#### 5.1.1 Vigencia — relevada en FASE 6

Todo sale del mismo documento archivado, sin recurrir a ninguna fuente secundaria:

| Dato | Valor | De dónde |
|---|---|---|
| Sanción | 2014-10-01 | Encabezado de la Ley 26.994 |
| Promulgación | 2014-10-07 | Decreto 1795/2014, transcripto |
| Publicación | 2014-10-08 | Encabezado |
| **Vigencia** | **2015-08-01** | **Art. 7° de la ley** |

El art. 7° original decía 2016-01-01. La edición archivada **ya trae el texto sustituido** y su nota
al pie: *"Texto sustituido por art. 1° de la ley 27.077, BO 19/12/2014"*. Es un caso de manual del
§6: si el sistema resolviera la vigencia del CCyC leyendo el texto original, se equivocaría por
cinco meses.

Cargado en `vigencias.csv` con `ancla_vigencia = FECHA_HECHO`. Los arts. 320 a 331 no registran
modificaciones en esta edición.

**Lo que sí falta:** la Ley 27.077 no está archivada. El sistema conoce la vigencia correcta porque
la edición del CCyC transcribe la sustitución, no porque haya leído la ley modificatoria. Para
cargar la relación en `norm_modifications` haría falta archivarla.

#### 5.1.2 Qué construye esta sección del Código

Los arts. 321, 324, 325 y 327 son la fuente de los siete controles de forma del Libro Diario y de la
regla del Diario resumido. El mapeo artículo → control está en [BOOKS.md](BOOKS.md) §3 y §4, y cada
control transcribe su fundamento en el código.

### 5.2 Ley General de Sociedades 19.550 (T.O. 1984)

Texto actualizado **archivado** desde InfoLeg. Sección IX "De la documentación y de la
contabilidad", arts. 61 y ss.; art. 299 (fiscalización estatal permanente).

Pendiente: extracción artículo por artículo a `norm_articles`.

### 5.3 Ley 27.349 (SAS) — `V2`. Pendiente de descarga.

---

### 5.4 Ley de Impuesto al Valor Agregado (t.o. 1997) · `V1` — **archivada**

Era el gap más caro del repositorio. Ya no lo es.

Lo archivado es el **texto actualizado** que publica InfoLeg del *"Ley de Impuesto al Valor
Agregado, texto ordenado en 1997"*, aprobado por el **Decreto 280/97** (Bs. As., 26/03/1997;
B.O. 15/04/1997) sobre el texto sustituido por el art. 1° de la Ley 23.349. Se archivó además la
ficha oficial del decreto, que es de donde sale su fecha de publicación.

**Lo que destrabó:**

- **Alícuotas** (art. 28) → `tax_rates` tiene cinco filas, todas citando su artículo. Se siembran
  con `npm run tax:seed`.
- **Regla de tope del crédito fiscal** (art. 12 inc. a, primer párrafo) → el motor ahora rechaza
  un IVA que ninguna alícuota vigente a la fecha podría producir.

**Lo que NO destrabó, y conviene tener claro:**

`EstadoCreditoFiscal` **sigue sin tener `COMPUTABLE`**, y el motivo cambió para mejor. Ya no es
que falte la ley: es que el art. 12 condiciona el cómputo a que la compra *"se vincule con las
operaciones gravadas"*, y eso no es un dato del comprobante sino un hecho del negocio. La misma
factura de nafta es crédito para la empresa de fletes y no lo es para el auto del socio. Archivar
la ley no trajo ese dato — trajo poder nombrar con precisión cuál falta.

**Límite temporal del documento.** Es un texto *actualizado*: sus antecedentes normativos están
listados pero **no transcriptos**. Que el art. 28 diga hoy "veintiuno por ciento" no prueba qué
decía en 2010. Lo único que el documento permite afirmar sobre el pasado es lo que él mismo
transcribe: la Nota Infoleg del art. 1° del **Decreto N° 2312/2002**, que fijó 19% entre el
**18/11/2002 y el 17/01/2003** inclusive. Esa ventana cerrada es lo que ancla el 21% desde el
18/01/2003. Para hechos imponibles anteriores el motor responde `SIN_ALICUOTAS_RELEVADAS`.

Es la misma lección que la RG 4597: un T.O. dice qué rige hoy, no qué regía. Ver
[TAX_ENGINE.md](TAX_ENGINE.md).

---

## 5ter. Código QR de la RG 4892/2020 · `V1` — **archivado y transcripto**

| Documento | Qué aporta |
|---|---|
| Ficha de InfoLeg de la **RG 4892/2020** | Emitida 22/12/2020, B.O. 24/12/2020 N° 34548 pág. 55. El articulado completo **no** está archivado: esta ficha solo da las fechas |
| **`ARCA_QR_especificaciones.pdf`** | La tabla de campos del JSON, y un ejemplo completo en la página 2 |
| **`ARCA_wsfev1_homologacion.wsdl`** | El contrato SOAP del servicio de emisión, bajado del propio endpoint |

### Un PDF que parecía escaneado y no lo era

El primer intento de extraer el texto del PDF del QR devolvió basura, y la
conclusión —razonable y equivocada— fue que el contenido era una imagen. Se
declaró así en el registro y el generador quedó emitiendo PDF sin QR.

No era una imagen. El documento usa fuentes con *subset* y **códigos de glifo de
un byte**; el extractor los leía de a dos y componía pares inexistentes. Con el
CMap aplicado por fuente el texto sale entero.

Vale anotarlo porque el error es del tipo que se propaga: una herramienta que
falla en silencio produce una conclusión sobre el mundo —"ARCA publica esto como
escaneo"— que después se cita como si fuera un hecho.

### La transcripción se verifica contra el propio documento

El PDF trae en su página 2 el JSON de ejemplo completo:

```json
{"ver":1,"fecha":"2020-10-13","cuit":30000000007,"ptoVta":10,"tipoCmp":1,"nroCmp":94,
 "importe":12100,"moneda":"DOL","ctz":65,"tipoDocRec":80,"nroDocRec":20000000001,
 "tipoCodAut":"E","codAut":70417054367476}
```

Hay un test que arma el QR de ese comprobante y compara el resultado **byte por
byte** con esa cadena. Es lo que convierte la transcripción de `especificacion-qr.json`
en algo verificado y no en algo copiado con cuidado.

### El documento se contradice sobre la URL

- Especificación técnica: `{URL}=https://www.arca.gob.ar/fe/qr/`
- Su propio ejemplo del pie: `https://www.afip.gob.ar/fe/qr/?p=…`
- ABC de ARCA (consulta 26035850): al escanear se llega a
  `https://serviciosweb.afip.gob.ar/genericos/comprobantes/cae.aspx`

Las tres pueden ser ciertas —el organismo migró de `afip` a `arca` y `/fe/qr/`
redirige al servicio de constatación— pero **cuál se codifica es una decisión**.
Se codifica la que el documento declara como `{URL}`, y el conflicto queda
anotado al lado en `scripts/especificacion-qr.json` en vez de resuelto en
silencio adentro del código.

---

## 5quater. Las cuatro normas del régimen de comprobantes · `V1` — **completo**

Con la RG 3561/2013 y la RG 5198/2022 archivadas el **2026-08-27**, las cuatro normas que la
RG 5616/2024 modifica están las cuatro en el archivo, con hash.

### Lo que confirmó la RG 5198

La ficha de la RG 1415 anotaba, de sus notas al pie, que *"el art. 16 lo sustituyó la RG 5198/2022
con vigencia 2022-06-01"*. Al archivar la 5198 se pudo verificar con su texto, y además precisar
**cuál artículo** hace la sustitución, que la nota de la 1415 no dice:

- **Art. 10, punto 2** sustituye el art. 16 de la RG 1415.
- **Art. 14** fija la vigencia: *"entrarán en vigencia el día 1 de junio de 2022"*. Coincide.

El texto sustituido dice que llevan letra **C** los comprobantes del art. 8° inc. a) —excepto la
factura de exportación y los tiques de Controlador Fiscal— emitidos por **a)** sujetos exentos o no
responsables ante el IVA y **b)** adheridos al Monotributo.

**La letra C se define por el emisor, no por el receptor.** Eso funda algo que en
`revisar-comprobantes.mjs` ya estaba escrito como decisión y ahora tiene texto detrás:
`controlarLetra()` no controla nada del lado del receptor para la clase C, porque la norma no pone
condición sobre el receptor. Es una abstención fundada, no un olvido.

### Una diferencia de método entre las dos

La RG 3561 trae sección **"Antecedentes Normativos"** y **sí transcribe los textos anteriores** de
los artículos sustituidos. La RG 1415 no. Por eso el control de letra no corre para comprobantes
anteriores al 2021-07-01 —no sabemos qué decía el art. 15 antes— y sobre la 3561, en cambio, sí se
podría reconstruir la historia si hiciera falta.

Dato cruzado que aparece ahí: el art. 22 pto. 1 de la RG 5003/2021 sustituyó el art. 19 de la
RG 3561 con vigencia **2021-07-01**, la misma fecha en que esa RG sustituyó el art. 15 inc. a) de la
RG 1415. Las dos modificaciones son del mismo acto y del mismo día.

---

## 5bis. Régimen del Libro de IVA Digital · `V1`

### RG AFIP 4597/2019 — texto actualizado

**Archivada y cargada al motor normativo.** Emitida en CABA el 30/09/2019, publicada el 01/10/2019
(pie del documento: *e. 01/10/2019 N° 74350/19*), vigencia desde el 01/10/2019 por su art. 25 con
cronograma escalonado.

**Hallazgo de FASE 8 — el texto archivado es un T.O., y eso tiene consecuencias.** La RG ARCA
5707/2025 (B.O. 02/06/2025) reescribió buena parte de la resolución, con vigencia **01/12/2025**
salvo la derogación del Título II, que rige desde el 01/07/2025 (art. 2° de la 5707). Lo que cambió:

| Art. | Qué dice ahora |
|---|---|
| 2° | Obligados: los **sujetos exentos** en el IVA, con seis excepciones |
| 6° | PORTAL IVA con **Clave Fiscal Nivel 3**, como mínimo |
| 8° | Los **diseños de registro** se publican en el micrositio IVA, **no en la norma** |
| 12 | Mes calendario · 15 días corridos · novedad `SIN MOVIMIENTO` · secuencialidad |
| Título II | **Derogado** (IVA Simplificado) |

Los textos **anteriores** de esos artículos —sustituidos por las RG 5133/2021, 4925/2021, 4796/2020
y 4671/2020— figuran en la sección *Antecedentes Normativos* del documento archivado, pero **no
están transcriptos**. Consecuencia directa: para períodos anteriores al 01/12/2025 el sistema
responde `OBLIGACION_NO_DETERMINABLE`. Aplicar la regla de hoy hacia atrás sería el §6 al revés.

**El art. 8° es el segundo caso del mismo patrón que la tabla de comprobantes (§8.1):** la norma no
contiene el formato, contiene la referencia a dónde está el formato. No se inventa.

---

## 6. Conflictos — estado actualizado

| ID | Conflicto | Estado |
|----|-----------|--------|
| **C-01** | Fechas de exigibilidad de la RG 5616/2024 | ✅ **RESUELTO.** No había contradicción: eran hitos de normas distintas. La RG 5616/2024 (art. 5) fija el WebService obligatorio el **15/04/2025**. El hito de **septiembre 2026** proviene de la **RG 5866/2026**, que estableció un cronograma escalonado de *nuevos sujetos obligados* hasta el 01/03/2027. Las fuentes secundarias mezclaban ambos |
| **C-02** | Vigencia RT 54: FACPCE 01/07/2024 vs CPCECABA 01/01/2025 | ✅ **CONFIRMADO COMO DEPENDENCIA JURISDICCIONAL**, no como error. Fundamento oficial: art. 226 del Anexo A RG IGJ 15/2024 sustituido por RG 9/2026, que remite a las RT *adoptadas por el CPCECABA*. Se modela en `norm_adoptions` |
| **C-03** | Alcance derogatorio de la RT 54 sobre RT 16/17/41/42 | ✅ **RESUELTO** con el art. 3° del texto oficial. Deroga RT 6, 8, 9, 11, 17, 41, 42, 48 (completas) y partes de RT 18 y 21. **No deroga RT 16, RT 26, RT 44 ni RT 45.** Ver §3.2 |
| **C-04** | IGJ admite RT FACPCE, NIIF o NIIF PyMES | 🟡 **Vigente por diseño.** El art. 230 sustituido usa la palabra *"podrán optar"*. La opción es del ente y se registra con respaldo documental en `company_reporting_frameworks` |
| **C-05** | Dominios `afip.gob.ar` / `arca.gob.ar` / endpoints en `afip.gov.ar` | 🟡 Abierto. Se registran los tres; se monitorea la migración |
| **C-06** | *(nuevo)* El catálogo técnico de ARCA publica `wsseg` con la **RG 2668 ya derogada** por la RG 5866/2026 | 🟡 Abierto. Confirma que la documentación técnica de un organismo no prueba vigencia. La vigencia se resuelve **siempre** contra el motor normativo |

---

## 7. Fuentes de actualización — con hallazgos de campo

| Fuente | Acceso programático | Verificado |
|--------|---------------------|-----------|
| **Boletín Oficial** — `boletinoficial.gob.ar/detalleAviso/…` | ❌ **La página de aviso es una SPA: el HTML servido no contiene el articulado.** Se descargó un aviso y el texto no está en la respuesta | 2026-08-24 |
| **InfoLeg** — `servicios.infoleg.gob.ar/infolegInternet/anexos/{rango}/{id}/norma.htm` (texto original) y `texact.htm` (texto actualizado) | ✅ **HTML estático con el articulado completo.** Codificación ISO-8859-1. **Es la fuente de texto del sistema** | 2026-08-24 |
| **datos.gob.ar — CKAN** `/api/3` | ✅ API abierta. Datasets "Base Infoleg de Normativa Nacional" (CSV/ZIP) y "Base SAIJ de Normativa Provincial" (CSV). Frecuencia no declarada | 2026-08-24 |
| **SAIJ** | Descarga directa de PDF de ediciones oficiales | ✅ |
| **FACPCE** `facpce.org.ar/wp-content/uploads/…` | Sin API. PDFs con URL estable | ✅ |
| **CPCECABA** `consejo.org.ar/storage/attachments/…` | Sin API. PDFs con URL con sufijo hash | ✅ |
| **IGJ** | Sin API. Índice anual en argentina.gob.ar + texto en InfoLeg | ✅ |
| **ARCA** `afip.gob.ar/ws/…` | Sin API. PDFs de manuales con URL estable | ✅ |
| CNV / BCRA | No relevado | — |

**Consecuencia para el `Normative Update Service`, corregida respecto de FASE 0:**

```
CKAN datos.gob.ar (detección de novedades)
        │
        ▼
InfoLeg  norma.htm / texact.htm   ← FUENTE DE TEXTO (no el Boletín Oficial)
        │
        ▼
archivado + sha256 → extracción de articulado → revisión humana → activación
```

El Boletín Oficial sirve para **datar y citar** el aviso; no para obtener el texto por fetch.

---

## 8. Backlog restante

| # | Documento | Bloquea | Nivel |
|---|-----------|---------|-------|
| 2 | Resolución CPCE Córdoba 35/24 y adopciones de otras jurisdicciones | Empresas fuera de CABA | `V2` |
| 3 | Ley 27.349 (SAS) | Entes SAS | `V2` |
| 4 | RG de percepciones y retenciones por régimen | Módulo de retenciones | No relevado |
| 5 | Normativa de IIBB y Convenio Multilateral | Alcance provincial | No relevado |
| 6 | Régimen de ajuste por inflación (contable y fiscal) | Reexpresión | **Gap declarado** |
| 7 | CNV T.O. de Normas; marco contable BCRA; INAES | Entes de esos regímenes | `V2` |
| 8 | Manuales ARCA restantes (wsmtxca, wsfexv1, padrón a4/a10) | Integraciones de FASE 13 | `V2` |
| ~~9~~ | ~~RG 3561 y 5198~~ **Cerrado el 2026-08-27.** Con RG 1415 y RG 4291 (2026-08-26), las cuatro normas del régimen de comprobantes están archivadas | Reglas finas de comprobantes | ✅ `V1` |
| 10 | Vigencias de la tabla de tipos de comprobante (`FEParamGetTiposCbte`) | Interpretar comprobantes por fecha | **Gap declarado** — ver 8.1 |
| 11 | Antecedentes normativos del art. 28 de la Ley de IVA (textos anteriores al 18/11/2002) | Alícuotas para hechos imponibles previos a esa fecha | **Gap declarado** |

Los 10 ítems del backlog original de FASE 0 están **cerrados**: 25 documentos en `V1`.

### 8.1 Hallazgo de FASE 3b — el catálogo de comprobantes es normativa versionada

Al implementar la lectura de comprobantes apareció algo que parecía un dato de configuración y no
lo es.

**ARCA no publica la tabla de tipos de comprobante como una constante.** Publica el método para
pedirla, y cada entrada viene con fechas de vigencia:

- `ARCA_manual_desarrollador_wsfev1_v4.6.pdf` (`V1`): `FEParamGetTiposCbte` devuelve
  `<Id> <Desc> <FchDesde> <FchHasta>`.
- `ARCA_manual_desarrollador_wscdcv1_v4.pdf` (`V1`): `CbteTipo` "debe ser alguno de los definidos
  en el método `ComprobantesTipoConsultar()`".

Es decir: la tabla tiene la misma naturaleza que una alícuota o un mínimo no imponible. Cablear los
códigos de hoy haría que un comprobante de 2019 se interpretara con la tabla de 2026, que es
exactamente lo que el §6 prohíbe.

**Qué se hizo.** Los códigos que el manual del wsfev1 **sí enumera con descripción** —en
"Controles aplicados al objeto `<FeCabReq>`", campo `CbteTipo`, "Obligatorio. Valores
permitidos"— se transcribieron como semilla `V1` y viven en `arca_comprobante_types` con
`vigencia_verificada = false`. Saber qué significa el código 1 y saber desde cuándo significa eso
son dos afirmaciones distintas, y el sistema solo hace la primera.

**Qué queda pendiente, y por qué cambió el motivo.** `npm run comprobantes:tipos` implementa
`FEParamGetTiposCbte` y trae `Id`, `Desc`, `FchDesde` y `FchHasta`. Ya no está atado al certificado.

Pero **sigue sin levantar `vigencia_verificada`**, y ahora por una razón distinta: lo que hay es un
certificado de **homologación**, y homologación es el ambiente de prueba del organismo. Que su tabla
de parámetros coincida con la de producción es plausible y **no está escrito en ningún documento
archivado**. Copiar esas fechas y marcarlas "verificadas contra el organismo" convertiría una
suposición razonable en una cita — que es lo único que el §30 prohíbe sin excepción.

El comando trae las fechas igual, las guarda con el ambiente anotado en `fuente`, y deja la bandera
en `false`. Con un certificado de producción, el mismo comando la sube a `true`. Mientras tanto sirve
para comparar lo que enumera el manual contra lo que devuelve el servicio, y mostrar en qué difieren.

Por defecto simula: hay que pasar `--aplicar` para escribir. Datos normativos que entran a la base
sin que nadie mire el diff son datos normativos que nadie revisó.

**Lo que no se hizo, deliberadamente.** El manual menciona otros códigos —5, 34, 39, 40, 60, 61,
88, 991— entre los comprobantes asociables, pero **nunca dice qué son**. No se les inventó
descripción: `tipoComprobanteSemilla()` devuelve `null` y la UI muestra el número tal cual (§30).

---

## 9. Procedimiento de archivado (§49)

Cada documento se guarda en `docs/normative-sources/originals/` y se registra en
`registro-de-descargas.csv` con: organismo, tipo, número, año, título, T.O., `url_oficial`,
archivo, **`sha256`**, fecha de descarga, nivel de verificación, capturado por, y observaciones con
los datos de vigencia extraídos del propio texto.

El hash es lo que permite responder, dos años después y ante una auditoría, la pregunta
*"¿qué texto exacto estaba usando el sistema el día que tomó esta decisión?"*.

Verificación de integridad del archivo:

```bash
cd docs/normative-sources/originals && sha256sum -c ../checksums.sha256
```
