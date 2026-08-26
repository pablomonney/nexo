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
receptor.

Los CUIT los hace el script:

```bash
npm run cuit:anonimizar -- entrada.csv --verificar     # qué hay, sin escribir nada
npm run cuit:anonimizar -- entrada.csv --salida limpio.csv --tabla ../tabla.json
```

Reemplaza cada CUIT por un sustituto **con dígito verificador válido** —uno
inválido lo rechaza el parser por un motivo que no es el que se quiere medir— y
sostiene tres propiedades más que a mano se pierden:

- **Determinístico y estable.** El mismo original da siempre el mismo sustituto.
  Sin eso el mismo proveedor aparece con un CUIT distinto en cada comprobante, y
  el corpus deja de servir para medir detección de duplicados, agrupación por
  contraparte e historial de importes — que es la mitad de lo que hay que medir.
- **Conserva el prefijo.** `20`/`23`/`24`/`27` es persona física, `30`/`33`/`34`
  es persona jurídica: el tipo de sujeto es parte de lo que el sistema interpreta.
- **No colisiona.** Dos originales distintos nunca comparten sustituto. Si lo
  hicieran, dos proveedores se fusionarían y el corpus mediría algo que no pasó.

La **tabla de correspondencia re-identifica el corpus entero**, así que el script
se niega a escribirla dentro del repositorio. Guardala donde guardás
credenciales, o no la guardes: la sustitución se reproduce con el mismo
`--semilla`.

### Lo que el script no hace, y hay que hacer a mano

Razón social, domicilio, DNI y número de Ingresos Brutos —que suele traer el CUIT
real con otro prefijo—. **No es un olvido:** detectar un nombre propio dentro de
texto libre es adivinar, y un anonimizador que acierta el 95% es peor que
ninguno, porque deja creer que el archivo quedó limpio. El script enumera esos
campos al terminar para que alguien los mire.

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

## Un CSV de comprobantes no es un corpus

Vale aclararlo porque la confusión es razonable y ya pasó una vez.

Un archivo con cien filas —tipo, número, fecha, CUIT, neto, IVA, total— **no
sirve para este criterio**, y no por ser sintético: no sirve porque no hay nada
que extraer. La FASE 3b mide qué tan bien el sistema **lee un documento**. Si los
datos ya vienen en columnas, lo único que se estaría midiendo es el parser de
CSV.

Lo que hace falta son los **documentos**: el PDF o el escaneo, con el sello
encima del total, la hoja torcida, las dos monedas en la misma página y el
proveedor que imprime la fecha a su manera. Y al lado, en `ground-truth.json`, lo
que dice realmente cada campo.

### Para lo que sí sirve un CSV así

Para revisarlo antes de cargarlo:

```bash
npm run comprobantes:revisar -- archivo.csv --mapeo scripts/mapeos/comprobantes-csv-es.json
```

No escribe nada: pasa las filas por los mismos validadores y motores que usa la
aplicación e imprime lo que el sistema diría. Separa tres cosas que no conviene
mezclar —errores de forma, lo que dice el motor de IVA, y observaciones **sin
fuente archivada**— y el mapeo de columnas se declara, no se adivina.

Sirve además para descubrir que un archivo generado no es utilizable como
fixture: un lote de prueba dio 180 CUIT con dígito verificador inválido sobre
200, que es lo que pasa cuando los números se arman al azar. `corpus/README.md`
ya lo advertía —*"reemplazar el CUIT por otro con dígito verificador válido"*—
pero una cosa es leerlo y otra ver los ciento ochenta.
