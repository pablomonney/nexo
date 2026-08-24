# RISKS.md — Riesgos Legales y Técnicos

> Entregable H del §51. Riesgos identificados en FASE 0, con mitigación concreta y estado.
> Los marcados 🔴 pueden invalidar el producto, no solo degradarlo.

## Riesgos normativos

### ✅ R-01 — Alcance derogatorio de la RT 54 — **CERRADO (2026-08-24)**

Se descargó el texto oficial de la RT 54. El **art. 3°** enumera las derogaciones de forma expresa:
RT 6, 8, 9, 11, 17, 41, 42 y 48 completas; RT 18 secciones 4 y 5; RT 21 sección 3;
Interpretaciones 1, 2, 3, 7, 8 y 11; y once resoluciones de Junta de Gobierno / Mesa Directiva.

**No deroga RT 16, RT 26, RT 44 ni RT 45.** El considerando c) confirma que la RT 54 se dirige a
entidades que preparan estados contables con normas *distintas* a las de la RT 26 (NIIF).

*Efecto:* la determinación automática de marco aplicable queda habilitada. El marco sigue
declarándose por empresa y período en `company_reporting_frameworks`, porque el art. 230 del Anexo A
de la RG IGJ 15/2024 (sustituido por RG 9/2026) mantiene la **opción** por NIIF — pero ya no por
desconocimiento de la norma, sino porque la norma efectivamente da a elegir.

### 🔴 R-02 — Vigencia distinta por jurisdicción

FACPCE fija vigencia de la RT 54 desde 01/07/2024; CPCECABA desde 01/01/2025. Un sistema con
vigencia nacional única produce estados contables mal fundados.

*Mitigación:* tabla `norm_adoptions` con clave `(norma, jurisdicción, fecha)`; resolución por
inicio de ejercicio; el motor rechaza resolver si no conoce la adopción de la jurisdicción.

*Estado (2026-08-24):* **confirmado con texto oficial, no ya inferido.** El art. 226 del Anexo A de
la RG IGJ 15/2024, sustituido por la RG 9/2026, remite a las RT de FACPCE *"adoptadas por el Consejo
Profesional de Ciencias Económicas de la Ciudad Autónoma de Buenos Aires"*. El organismo de control
no manda aplicar "la RT vigente": manda aplicar la adoptada por el consejo de la jurisdicción.

Se agrega un dato que refuerza el punto: la vigencia de la RT 54 tuvo **tres valores sucesivos** —
01/01/2024 en el texto original, 01/07/2024 tras la RT 56, y 01/01/2025 en CABA. Un modelo con un
único campo `fecha_vigencia` no puede representarlo.

Sigue abierto: relevar el acto de adopción de cada consejo donde opere el estudio.

### 🟠 R-03 — Ausencia de API oficial para comprobantes recibidos

No existe web service oficial de "Mis Comprobantes". La automatización total de la ingesta de
compras **no es posible por vía oficial**.

*Mitigación:* ADR-004 — no se hace scraping de portales con Clave Fiscal (riesgo legal, de términos
de uso y de custodia de credenciales). Ingesta por archivo exportado, subida y email.
*Impacto comercial:* debe comunicarse con honestidad al cliente. Prometer lo contrario es vender
algo que depende de un mecanismo frágil e impugnable.

### ✅ R-04 — Conflicto de fechas en la RG 5616/2024 — **CERRADO (2026-08-24)**

No había conflicto: había dos normas distintas mezcladas por las fuentes secundarias.

- **RG 5616/2024**, art. 5°: vigencia el día de su publicación (18/12/2024); la nueva versión del
  WebService es de **uso obligatorio desde el 15/04/2025**.
- El hito de **septiembre de 2026** corresponde a la **RG 5866/2026**, que fijó un cronograma
  escalonado de *nuevos sujetos obligados* que se extiende hasta el 01/03/2027.

*Lección para el proceso:* dos fuentes secundarias que "se contradicen" pueden estar ambas en lo
cierto y hablando de normas diferentes. Es precisamente por esto que la regla del proyecto es
citar el texto oficial y no la interpretación de terceros.

### 🟠 R-05 — Volatilidad normativa

Solo en 2026 la IGJ dictó al menos 10 resoluciones generales, una de las cuales rehízo el régimen
de estados contables. La normativa fiscal cambia con frecuencia comparable.
*Mitigación:* `Normative Update Service` con revisión humana obligatoria; versionado bitemporal
que permite recontabilizar el pasado con el derecho del pasado.

### 🟠 R-21 — La documentación técnica de un organismo no prueba vigencia *(nuevo, 2026-08-24)*

Detectado en campo: el catálogo oficial de web services de ARCA publica el servicio `wsseg`
citando como respaldo la **RG 2668**, que la **RG 5866/2026 derogó**. La documentación técnica
quedó desactualizada respecto de la normativa.

*Por qué importa:* es tentador tomar el manual del organismo como fuente de la regla. No lo es.
*Mitigación:* la vigencia se resuelve **siempre** contra `normative-engine`. Los manuales se
archivan con jerarquía **P4** (material explicativo) y jamás fundan una regla por sí solos.

### 🟠 R-22 — El Boletín Oficial no es una fuente de texto automatizable *(nuevo, 2026-08-24)*

Verificado descargando un aviso: las páginas `boletinoficial.gob.ar/detalleAviso/…` son una SPA y
**el HTML servido no contiene el articulado**. Un `Normative Update Service` que dependa de hacer
fetch al BO obtiene una cáscara vacía.

*Mitigación:* InfoLeg (`norma.htm` / `texact.htm`) es HTML estático con el texto completo y pasa a
ser la fuente de texto del sistema. El BO se usa para datar y citar el aviso. Ver
`docs/api/official-apis.md`.

### 🟡 R-06 — Ajuste por inflación

Régimen sensible y con condiciones de aplicación que dependen de índices y de la norma vigente.
**No relevado en FASE 0.**
*Mitigación:* declarado como gap explícito. El motor no lo aplica hasta tener fuente `V1`.

---

## Riesgos legales y de responsabilidad

### 🔴 R-07 — Confusión entre asistencia y ejercicio profesional

El sistema no puede presentarse como sustituto del contador matriculado. Una salida de IA
presentada como dictamen profesional es un problema de responsabilidad, no de UX.
*Mitigación:* §42 implementado en la UI — etiquetado obligatorio de todo contenido generado,
aprobación humana previa a cualquier efecto contable, contador responsable identificado en cada
emisión de estados contables.

### 🔴 R-08 — Custodia de certificados fiscales de terceros

El sistema custodia claves que permiten actuar fiscalmente en nombre de contribuyentes.
*Mitigación:* cifrado por sobre con KMS/HSM, DEK por empresa, revocación verificable, prohibición
absoluta de manejar Clave Fiscal, bitácora de todo uso del certificado. Ver `SECURITY.md` §5.

### 🟠 R-09 — Secreto profesional y filtración entre empresas

*Mitigación:* triple aislamiento (RLS + middleware + storage), test de fuga por endpoint en CI,
aprendizaje de clasificación no compartido entre clientes.

### 🟠 R-10 — Envío de documentación a proveedores de IA externos

*Mitigación:* configuración por organización, región de procesamiento, no-retención, opción de OCR
on-prem, modo determinístico puro sin envío externo. Registro auditable de todo lo enviado.

### 🟡 R-11 — Valor probatorio de libros digitales

El art. 61 de la LGS admite medios digitales, pero los requisitos formales dependen del organismo
de control y de la jurisdicción.
*Mitigación:* inmutabilidad, hash encadenado, exportación reproducible. **Requisito de FASE 13:**
relevar formalidades específicas por jurisdicción antes de prometer sustitución de libros rubricados.

---

## Riesgos técnicos

### 🔴 R-12 — La IA escribiendo contabilidad

El riesgo de producto más grave: que por conveniencia se abra un atajo de la IA a la base.
*Mitigación:* topología de dependencias verificada por lint en CI; invariante A-6 en la suite de
auditoría; `ai_predictions` sin FK de escritura al núcleo contable.

### 🟠 R-13 — Calidad de OCR sobre documentos reales

Facturas escaneadas torcidas, térmicas desvanecidas, fotos de celular. La extracción va a fallar.
*Mitigación:* confianza por campo, nunca completar por inferencia, revisión humana en campos
críticos (CUIT, total, CAE, fecha) por debajo del umbral, métricas por proveedor de OCR.

### 🟠 R-14 — Dependencia de disponibilidad de ARCA

Los WS tienen caídas y ventanas de mantenimiento.
*Mitigación:* cola con reintentos y backoff, caché de TA respetando su vigencia, estado
`NO_VERIFICABLE` explícito en `invoice_validations` (nunca "OK por defecto"), operación degradada.

### 🟠 R-15 — Habilitaciones por CUIT

Varios servicios requieren acuerdos especiales con ARCA. Un servicio puede no estar disponible
para un cliente concreto.
*Mitigación:* capacidades por empresa modeladas explícitamente; la UI muestra qué validaciones
están disponibles y cuáles no para esa empresa.

### 🟡 R-16 — Errores de redondeo y moneda

*Mitigación:* enteros en centavos, `float` prohibido por lint, criterio de redondeo como parámetro
normativo, rechazo ante descuadre en lugar de ajuste silencioso.

### 🟡 R-17 — Rendimiento del linaje en volumen

El grafo `lineage_edges` crece rápido.
*Mitigación:* particionado por empresa y período, índices sobre ambos extremos, materialización de
caminos frecuentes, poda por archivado (nunca borrado).

### 🟡 R-18 — Costo y latencia de la IA

*Mitigación:* caché por hash de documento, procesamiento por lotes, modelos pequeños para tareas
simples, presupuesto por empresa, y el hecho de que el sistema **funciona sin IA**.

---

## Riesgo de proyecto

### 🟠 R-19 — Alcance

El pliego describe un producto que, completo, es un ERP contable con motor normativo. Intentarlo
de una vez es el modo más confiable de no entregar nada.
*Mitigación:* fases con criterios de salida verificables; MVP acotado en `docs/product/MVP.md`.

### 🟠 R-20 — Deuda normativa silenciosa

Un motor con reglas cargadas a medias que "parece" funcionar es más peligroso que uno vacío.
*Mitigación:* niveles `V1..V4` visibles en la UI; una regla `V2` o inferior **no se aplica**, se
muestra como gap. El sistema prefiere declararse incompleto antes que aparentar completitud.
