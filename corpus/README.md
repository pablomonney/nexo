# Corpus de evaluación

Acá van los comprobantes reales anonimizados con los que se mide la extracción.

**Está vacío a propósito.** El criterio de salida de la FASE 3b pide 100
comprobantes reales procesados con métricas por campo publicadas, y ese corpus no
se puede fabricar: un conjunto de facturas sintéticas mide la calidad del
generador, no la del sistema. Las facturas reales tienen sellos encima del total,
escaneos torcidos, dos monedas en la misma hoja y proveedores que imprimen la
fecha en un formato propio. Eso es lo que hay que medir.

## Qué hay que aportar

```
corpus/
  ground-truth.json
  documentos/
    001.pdf
    001.pdf.txt      ← opcional, ver más abajo
```

`ground-truth.json`:

```json
[
  {
    "archivo": "001.pdf",
    "esperado": {
      "emisor.cuit": "30712345671",
      "comprobante.fecha": "2026-03-05",
      "comprobante.identificacion": "00012-00000045",
      "comprobante.codigoAutorizacion": "75123456789012",
      "importes.neto": "101983 ARS",
      "importes.iva": "21417 ARS",
      "importes.total": "123400 ARS"
    }
  }
]
```

Los importes van **en unidades menores** (centavos) seguidos de la moneda, que es
la forma canónica con la que el sistema los compara. `null` en un campo significa
que ese campo **no está** en el documento: si el sistema devuelve algo, cuenta
como falso positivo.

## Anonimización

Antes de traer un comprobante real hay que sacarle los datos que identifican al
contribuyente. Lo mínimo: CUIT, razón social, domicilio y número de documento del
receptor. Reemplazar el CUIT por otro **con dígito verificador válido** —si no, el
parser lo va a rechazar por una razón que no es la que se quiere medir.

Este directorio está en `.gitignore` salvo este README: los comprobantes no se
commitean, ni siquiera anonimizados.

## Las dos capas, medidas por separado

Si al lado de `001.pdf` existe `001.pdf.txt`, el script usa esa transcripción como
si fuera la salida del OCR.

Sirve para separar dos cosas que se suelen mezclar:

| Con `.txt` | Sin `.txt` |
|---|---|
| Mide **interpretación**: parsers, reglas, coherencia | Mide **OCR + interpretación** |
| Se puede medir hoy, sin motor de OCR contratado | Necesita un motor configurado |

Conviene empezar por la primera. Si la interpretación falla sobre un texto
perfecto, ningún OCR lo va a arreglar.

## Cómo correrlo

```bash
node scripts/extraction-metrics.mjs
```

Escribe `docs/product/extraction-metrics.md` y **termina con error si hay algún
error silencioso**: un campo que el sistema interpretó con seguridad y le erró.
Es la falla que este diseño existe para no tener, así que no pasa desapercibida.
