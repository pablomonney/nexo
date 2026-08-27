# Métricas de extracción por campo

Corpus: **46 documentos**. Generado: 2026-08-27T21:29:47.133Z

La columna que hay que mirar es **error silencioso**: campos interpretados con
seguridad y equivocados. Una abstención cuesta un minuto; un error silencioso
cuesta un asiento mal imputado que nadie revisó.

La última columna es la confianza media *de los errores*. Si es alta, el
puntaje de confianza no está midiendo lo que dice medir.

| Campo | Intentos | Extraídos | Correctos | Incorrectos | Abstenciones | Cobertura | Precisión | Error silencioso | Confianza media del error |
|---|---:|---:|---:|---:|---:|---:|---:|---:|---:|
| `comprobante.codigoAutorizacion` | 46 | 46 | 46 | **0** | 0 | 100.0% | 100.0% | **0.0%** | 0.00 |
| `comprobante.fecha` | 46 | 46 | 46 | **0** | 0 | 100.0% | 100.0% | **0.0%** | 0.00 |
| `comprobante.identificacion` | 46 | 46 | 46 | **0** | 0 | 100.0% | 100.0% | **0.0%** | 0.00 |
| `emisor.cuit` | 46 | 46 | 46 | **0** | 0 | 100.0% | 100.0% | **0.0%** | 0.00 |
| `importes.iva` | 0 | 0 | 0 | **0** | 0 | 0.0% | 0.0% | **0.0%** | 0.00 |
| `importes.total` | 46 | 46 | 46 | **0** | 0 | 100.0% | 100.0% | **0.0%** | 0.00 |


## Cómo leer esto

Si existe un `.txt` junto al documento, la lectura no la hizo un OCR: es la
transcripción del corpus. En ese caso estas métricas miden **la capa de
interpretación**, no el reconocimiento óptico. Son dos números distintos y no
se deben presentar como uno solo.

Documentos declarados: 46. Procesados: 46.
