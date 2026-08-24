# APIs e Integraciones Oficiales

> Entregable F del §51. **Relevado, no supuesto.** El pliego pide explícitamente no asumir que una
> API existe (§4). Este documento distingue lo que existe, lo que existe con condiciones y lo que
> no existe.

## 1. Resumen ejecutivo

| Integración | ¿Existe API oficial? | Autenticación | Usable por un tercero |
|-------------|---------------------|---------------|----------------------|
| Emisión de comprobantes electrónicos (ARCA) | **Sí** — SOAP | WSAA + cert. X.509 | Sí, con delegación del contribuyente |
| Constatación de comprobantes (ARCA) | **Sí** — `wscdcv1` | WSAA | Sí, con delegación |
| Padrón de contribuyentes (ARCA) | **Sí** — `a4/a10/a13/a100` | WSAA | Sí, con delegación |
| Contribuyentes apócrifos (ARCA) | **Sí** — `wsapoc` | WSAA | Sí, con delegación |
| DDJJ F931 (ARCA) | **Sí** | WSAA | Con habilitación |
| Consulta de deuda (`sud_*`) | Sí | WSAA | **Restringido** a bancos / proveedores del Estado |
| **"Mis Comprobantes" (recibidos)** | **NO** | — | **No hay vía oficial** |
| **Libro de IVA Digital / Portal IVA** | **No relevado como WS** | — | Presentación por portal |
| Boletín Oficial | **No.** Verificado: la página de aviso es una SPA y **no trae el articulado** | — | Solo para datar y citar |
| **InfoLeg** | **No hay API, pero sí URL estable con HTML estático y texto completo** — es la fuente de texto del sistema | — | Sí |
| SAIJ | Descarga directa de PDF de ediciones oficiales | — | Sí |
| **datos.gob.ar (CKAN)** | **Sí** — `/api/3` | Abierta | Sí |
| FACPCE / consejos | No | — | Descarga manual de PDFs |
| IGJ | No | — | Portal y BO |
| CNV / BCRA | No relevado | — | Pendiente |

---

## 2. ARCA — mecánica de integración

### 2.1 Cadena de autenticación

```
Certificado X.509 (AC de ARCA)
   │  firma CMS del TRA (Ticket Request Access)
   ▼
WSAA  ── LoginCms ──►  Ticket de Acceso (TA): token + sign + expiración
   │
   ▼
Servicio de negocio (wsfev1 / wscdcv1 / padrón …)  con Auth = {token, sign, cuit}
```

| Entorno | Endpoint WSAA |
|---------|---------------|
| Homologación | `https://wsaahomo.afip.gov.ar/ws/services/LoginCms` |
| Producción | `https://wsaa.afip.gov.ar/ws/services/LoginCms` |

Gestión de certificados: **WSASS** en homologación; **Administrador de Certificados Digitales** en
producción. Delegación del servicio a un tercero: **Administrador de Relaciones de Clave Fiscal**.

### 2.2 Implicancias de diseño — cuatro, todas con consecuencia

1. **El sistema no es el contribuyente.** Cada empresa cliente debe delegar el servicio al CUIT
   que opera el software, o aportar su propio certificado. Es un paso de onboarding
   con intervención del cliente, no un checkbox. Debe estar en el diseño de UX desde el inicio.
2. **Un TA por (CUIT, servicio)**, con vigencia acotada. Se cachea cifrado y se renueva antes del
   vencimiento; pedir tickets de más es motivo de bloqueo por parte del organismo.
3. **Habilitación por servicio.** El catálogo oficial advierte que ciertos servicios requieren
   acuerdos especiales. Las capacidades se modelan **por empresa**, y la UI declara qué
   validaciones están disponibles para cada una.
4. **Degradación explícita.** Servicio caído, CUIT sin habilitación o TA vencido producen
   `NO_VERIFICABLE`, nunca un `OK` por omisión. Un falso OK en validación fiscal es peor que la
   ausencia de validación.

### 2.3 Servicios y su uso previsto

| WS | Norma | Uso en el sistema | Fase |
|----|-------|-------------------|------|
| `wscdcv1` | — | Validación fiscal de comprobantes recibidos | 3 |
| `ws_sr_padron_a13` | — | Datos y condición IVA del emisor | 3 |
| `ws_sr_padron_a100` | — | Sincronización de catálogos y parámetros | 3 |
| `wsapoc` | — | Alerta de proveedor apócrifo | 3 |
| `ws_sr_constancia_inscripcion` | — | Constancia para legajo del proveedor | 3 |
| `wsfev1` | RG 4291 | Emisión de comprobantes (si el cliente factura desde el sistema) | 13 |
| `wsmtxca` | RG 2904 | Emisión con detalle de ítems | 13 |
| `wsfexv1` | RG 2758 / 4401 | Exportación | 13 |
| `TRABAJO_F931` | — | Conciliación de asientos de sueldos | 13 |

Manuales oficiales en `https://www.afip.gob.ar/ws/documentacion/`. Descarga y archivado: ítem 8 del
backlog de `OFFICIAL_SOURCES.md`.

---

## 3. "Mis Comprobantes" — la ausencia importante

**No figura en el catálogo oficial de web services de ARCA.** Se opera por portal web con Clave
Fiscal. Existen SDK comerciales que ofrecen "Mis Comprobantes por API": lo que hacen es automatizar
la navegación del portal con las credenciales del contribuyente.

**Decisión (ADR-004): no se implementa.** Razones, en orden de peso:

1. Requeriría que el sistema custodie la **Clave Fiscal** del contribuyente — una credencial de
   alcance mucho mayor que un certificado delegado, revocable solo cambiándola.
2. Depende de la estructura del portal: se rompe sin aviso y en el peor momento (cierre).
3. Zona gris respecto de los términos de uso del organismo.

**Alternativa implementada:** el usuario exporta el archivo desde el portal y lo sube; el sistema
lo parsea, deduplica contra lo ya registrado y valida cada comprobante por `wscdcv1`. Se pierde
automatismo; se gana un sistema que no se cae ni expone credenciales críticas.

---

## 4. Fuentes normativas

### 4.1 datos.gob.ar — CKAN (la única API abierta relevada)

- API CKAN en `https://datos.gob.ar/api/3`.
- Datasets relevantes: **"Base Infoleg de Normativa Nacional"** (CSV, ZIP) y **"Base SAIJ de
  Normativa Provincial"** (CSV), ambos del Ministerio de Justicia.
- Frecuencia de actualización: no especificada en el portal. **No asumir diaria.**

Uso: *detector* de novedades por diff periódico. **No** es la fuente autoritativa del texto: para
eso se hace fetch dirigido al BO o al organismo, y se archiva con hash.

### 4.2 Boletín Oficial — no sirve como fuente de texto *(verificado 2026-08-24)*

Sin API pública documentada. Los avisos tienen URL estable del tipo
`/detalleAviso/primera/{id}/{yyyymmdd}`.

**Hallazgo de campo:** se descargó el aviso de la RG IGJ 9/2026 y **el HTML servido no contiene el
articulado**. La página es una SPA: 64 KB de respuesta, cero ocurrencias de "ARTÍCULO", cero
referencias a la norma modificada. Un servicio de actualización que dependa de hacer fetch al BO
obtiene una cáscara vacía y —peor— podría interpretarla como "norma sin contenido".

**Uso correcto del BO en este sistema:** datar y citar el aviso (número, fecha, sección, página).
El texto se obtiene de InfoLeg.

### 4.3 InfoLeg — la fuente de texto del sistema *(verificado 2026-08-24)*

Patrón de URL, estable y sin autenticación:

```
https://servicios.infoleg.gob.ar/infolegInternet/anexos/{rango}/{id}/norma.htm     ← texto original
https://servicios.infoleg.gob.ar/infolegInternet/anexos/{rango}/{id}/texact.htm    ← texto actualizado
```

donde `{rango}` es el bloque de 5.000 que contiene el `{id}` (p. ej. `425000-429999` para 427313).

- HTML estático, con el articulado completo, incluidas las cláusulas de vigencia.
- **Codificación ISO-8859-1** — hay que convertir a UTF-8 antes de parsear, o el articulado sale
  con caracteres corruptos.
- Se verificó con 7 normas: RG ARCA 5616/2024, 5707/2025, 5866/2026, RG AFIP 4597/2019 (T.O.),
  RG IGJ 15/2024 (T.O.) y 9/2026, y Ley 19.550 (T.O.).

La distinción `norma.htm` vs `texact.htm` importa y se modela: la primera es la **versión
original** de la norma, la segunda el **texto consolidado con sus modificatorias**. El motor
necesita ambas — una para la vigencia histórica, otra para la actual.

### 4.4 Organismos sin API

FACPCE (`normasweb.facpce.org.ar`), consejos profesionales, IGJ, CNV, BCRA: publicación en HTML y
PDF. Se resuelve con descarga asistida + carga con revisión humana. **Es trabajo de contador,
no de scraping ciego**, y así está previsto en el `Normative Update Service`.

---

## 5. Pendientes de relevamiento

| Ítem | Por qué importa |
|------|-----------------|
| Portal IVA / IVA Simple — ¿existe presentación por WS? | Definiría si el Libro de IVA Digital se presenta desde el sistema o se exporta |
| Regímenes de información con WS propio | Automatización de presentaciones |
| CNV — Autopista de Información Financiera | Presentación de estados de emisoras |
| BCRA — regímenes informativos | Solo si se atienden entidades financieras |
| Fiscos provinciales (IIBB, CM) | Alcance provincial del `tax-engine` |
| IGJ — ¿el nuevo régimen digital de la RG 9/2026 expone interfaz técnica? | Presentación de estados contables desde el sistema |
