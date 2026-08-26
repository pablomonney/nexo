# @aai/document-engine

Ingesta de documentos, lectura de comprobantes y detección de duplicados.

## La idea

```
ingerir()
├── sniff        tipo real por bytes, nunca por la extensión
├── sha256       identidad del archivo
├── store.put    archiva ANTES de intentar leer
├── extracción   XML directo · OCR tras adaptador · tabular por importación
├── coherencia   la aritmética del comprobante
└── duplicados   tres niveles distintos, no tres grados de certeza
```

El orden importa: **primero se archiva, después se interpreta.** Un sistema que
descarta lo que no supo leer pierde justamente los comprobantes raros —los que
traen el problema contable interesante— y deja al contador sin el papel para
mirarlo a mano. El peor caso acá es un documento archivado con cero campos y una
nota que dice por qué.

## Las cuatro dimensiones del §10

Cada campo sale con cuatro datos separados, y son columnas separadas también en
la base:

| | |
|---|---|
| `rawValue` | lo que decía el documento, literal |
| `parsedValue` | cómo lo interpretó el sistema — `null` si no pudo |
| `confidence` | cuánto vale esa lectura |
| `method` | `OCR` · `XML` · `REGEX` · `LLM` · `MANUAL` |

Colapsarlas hace imposible auditar una imputación: si un total quedó mal, no hay
forma de saber si el OCR leyó mal, si el intérprete confundió el separador de
miles, o si alguien lo corrigió a mano. Con las cuatro, sí.

Dos reglas que se derivan de eso:

- **La confianza del conjunto es el mínimo, no el promedio.** Un documento con
  nueve campos perfectos y el total dudoso no tiene 0.9 de confianza: tiene el
  total dudoso.
- **Hay un techo por método.** Un motor de OCR que reporta 0.99 no vale lo mismo
  que un XML estructurado, y un umbral de aprobación automática los trataría
  igual. `TECHO_CONFIANZA` hace que la diferencia sobreviva el viaje.

## Ante la ambigüedad, se abstiene

Es la decisión de diseño que más se nota usando el sistema.

```ts
parseImporteAr('1.234,56')  // → 1234.56
parseImporteAr('1.234')     // → AMBIGUO: ¿1234 o 1,234?
parseFechaAr('05/03/2026')  // → 2026-03-05
parseFechaAr('12/25/2026')  // → abstiene: 25 no es un mes
```

`1.234` puede ser mil doscientos treinta y cuatro o uno coma doscientos treinta y
cuatro. Las dos lecturas son legítimas y difieren en mil veces. Elegir produce un
número plausible y equivocado que nadie va a mirar nunca; abstenerse cuesta un
minuto de contador.

`12/25/2026` es el mismo criterio aplicado a fechas: dar vuelta día y mes "porque
se ve que está al revés" es cómo un comprobante de diciembre termina imputado en
enero, y una posición de IVA en el período equivocado.

Cuando otro dato del comprobante resuelve la ambigüedad —el neto más el IVA solo
cierran con una de las dos lecturas— hay `desambiguarPorControl()`, que la
resuelve, baja la confianza y **deja la nota** de que hizo falta un control
externo.

## Los duplicados son tres cosas distintas

| Nivel | Qué es | Qué hace |
|---|---|---|
| `ARCHIVO_IDENTICO` | mismos bytes | vincula; no es un hecho contable nuevo |
| `COMPROBANTE_REPETIDO` | mismo emisor, tipo, PV y número, otro archivo | **bloquea** |
| `POSIBLE_DUPLICADO` | mismo tercero, mismo importe, fechas cercanas | advierte |

El segundo es el que importa: o es un rescaneo, o es una factura computada dos
veces —crédito fiscal de más—. El sistema no adivina cuál: las presenta.

La deduplicación es **por empresa, nunca global**. Un almacén direccionado por
contenido a nivel sistema ahorraría bytes, pero subir un archivo revelaría si
otra empresa ya lo tenía. Se paga el duplicado.

## OCR

```ts
interface OcrEngine { soporta(tipo): boolean; reconocer(entrada): Promise<ResultadoOcr> }
```

Mismo criterio que con ARCA: el motor por defecto es `NullOcrEngine`, que
responde `disponible: false` con motivo `SIN_MOTOR_OCR`. No es un placeholder a
reemplazar antes de usar el sistema: es la respuesta correcta cuando no hay OCR
configurado. **No hay caída automática al simulado** — eso convertiría una
configuración incompleta en producción en lecturas inventadas presentadas como
reales.

`MockOcrEngine` sabe fallar: tiene escenarios de documento ilegible, tipo no
soportado y confianza baja, y `degradar()` reproduce las confusiones reales de un
escaneo (`0/O`, `1/l`, `5/S`, `8/B`).

## Lo que este paquete no hace

- **No valida alícuotas de IVA.** Están archivadas y sembradas desde el art. 28
  de la Ley de IVA (t.o. 1997), pero las resuelve `@aai/tax-engine`, que conoce la
  fecha del hecho imponible. Este paquete solo ve el documento, e inferir la
  alícuota de su propia aritmética sería usar el dato para validarse a sí mismo.
- **No traduce la letra impresa a `CbteTipo`.** Ver abajo.

## El catálogo de tipos de comprobante es normativa, no una constante

ARCA **no publica** la tabla de tipos de comprobante como un listado fijo:
publica el método para pedirla (`FEParamGetTiposCbte`,
`ComprobantesTipoConsultar`), y cada entrada trae `FchDesde` y `FchHasta`.

O sea: está versionada en el tiempo, igual que una alícuota. Cablear un `Record`
con los códigos de hoy haría que un comprobante de 2019 se interpretara con la
tabla de 2026 (§6).

Por eso el catálogo vive en `arca_comprobante_types`, con vigencias, y
`catalogo.ts` solo tiene una **semilla** transcripta del manual archivado, que
entra a la base con `vigencia_verificada = false`. Los códigos que el manual
menciona sin describir —39, 991 y otros, citados como comprobantes asociables—
devuelven `null`. No se inventan.

## Métricas

```bash
node scripts/extraction-metrics.mjs
```

La métrica que importa no es la precisión global: es la **tasa de error
silencioso**, los campos que el sistema interpretó con seguridad y le erró.

Una abstención cuesta un minuto de mirar el papel. Un error silencioso cuesta un
asiento mal imputado que nadie revisó. Un sistema con 95% de cobertura y 3% de
error silencioso es peor que uno con 70% y 0.1%, aunque tenga mejor número en la
portada.

El reporte incluye la confianza media **de los errores**: si es alta, el puntaje
de confianza no está midiendo lo que dice medir.

El corpus lo aporta quien tiene comprobantes reales anonimizados; ver
[`corpus/README.md`](../../corpus/README.md).
