# Fuentes Normativas — Procedimiento de Trabajo

Esta carpeta es el archivo documental del `Normative Engine`. Su contenido es lo que permite
responder, ante una auditoría o un juicio, **qué texto exacto usaba el sistema el día que tomó una
decisión**.

## Contenido

| Archivo | Qué es |
|---------|--------|
| [`../../OFFICIAL_SOURCES.md`](../../OFFICIAL_SOURCES.md) | Registro maestro con niveles de verificación, conflictos y backlog |
| [`mapa-normativo.md`](mapa-normativo.md) | Qué norma gobierna qué capacidad y de qué depende |
| `registro-de-descargas.csv` | Índice de todo documento archivado, con hash |
| `originals/` | Documentos originales (PDF/HTML). **No se editan jamás** |

## Procedimiento de incorporación de una norma

```
1. Identificar la norma en fuente OFICIAL (ver jerarquía en OFFICIAL_SOURCES.md §1)
2. Descargar el documento original — PDF preferido; si solo hay HTML, archivar el HTML
3. Calcular sha256 y guardar en originals/ con nombre:
      {organismo}_{tipo}_{numero}_{anio}[_to{version}].{ext}
      ej.  ARCA_RG_5616_2024.pdf   ·   FACPCE_RT_54_2022_to59.pdf
4. Registrar la fila en registro-de-descargas.csv
5. Cargar metadatos en `norms` + `norm_versions` (nivel V1)
6. Extraer articulado a `norm_articles`
7. Si es norma profesional: cargar `norm_adoptions` POR JURISDICCIÓN — nunca asumir
   vigencia nacional
8. Derivar reglas → status DRAFT
9. Revisión por contador matriculado → status ACTIVE con firma
```

Los pasos 1 a 7 pueden asistirse con herramientas. **El paso 9 es humano y no es delegable.**

## Reglas

1. **Nunca transcribir un artículo de memoria.** Si no está descargado, no existe para el sistema.
2. **Nunca usar una fuente secundaria como origen de una regla.** Blogs, prensa y proveedores
   sirven para *encontrar* la norma, jamás para *citarla*.
3. **Nunca borrar un original.** Una norma derogada sigue siendo necesaria para recontabilizar el
   pasado.
4. **Nunca asumir vigencia nacional de una norma profesional.** Verificar la adopción del consejo
   de cada jurisdicción donde opere el estudio.
5. Ante duda no resoluble con fuente oficial, escribir literalmente:
   `NO VERIFICABLE CON FUENTE OFICIAL DISPONIBLE`.

## Estado actual (2026-08-24)

**21 documentos oficiales archivados en `originals/`, 27 MB, todos en nivel `V1`** con SHA-256
registrado en `registro-de-descargas.csv` y en `checksums.sha256`.

| Bloque | Documentos |
|--------|-----------|
| FACPCE — cadena NUA completa | RT 54 · RT 56 · RT 59 · RT 62 · Res. JG 660/2026 · tabla de montos · Proyecto 52 |
| CPCECABA | RT 54 (T.O.) publicada por el consejo · Guía de preguntas y respuestas |
| ARCA / AFIP | RG 5616/2024 · RG 5707/2025 · RG 4597/2019 (T.O.) · RG 5866/2026 · 4 manuales de desarrollador |
| IGJ | RG 15/2024 (T.O.) · RG 9/2026 |
| Normativa de fondo | Ley 19.550 (T.O. 1984) · CCyC Ley 26.994 (edición SAIJ) |

Verificación de integridad:

```bash
cd docs/normative-sources/originals && sha256sum -c ../checksums.sha256
```

Texto plano derivado para trabajo en `extracted/` (regenerable con `pdftotext -enc UTF-8`).
La fuente autoritativa es siempre el archivo de `originals/` con su hash.

**Lo que sigue abierto** — y por lo que el motor todavía declara gaps: actos de adopción de
consejos fuera de CABA, ajuste por inflación, percepciones/retenciones e IIBB. Ver
`OFFICIAL_SOURCES.md` §8.

## Dos hallazgos que cambiaron el procedimiento

1. **El Boletín Oficial no sirve como fuente de texto.** Sus páginas de aviso son una SPA: el HTML
   servido no contiene el articulado. Se usa **InfoLeg** (`norma.htm` para el texto original,
   `texact.htm` para el consolidado), que es HTML estático y completo — en ISO-8859-1, hay que
   convertir a UTF-8 antes de parsear.
2. **La documentación técnica de un organismo no prueba vigencia.** El catálogo de web services de
   ARCA publica `wsseg` citando la RG 2668, derogada por la RG 5866/2026. Los manuales se archivan
   como jerarquía P4 y nunca fundan una regla por sí solos.
