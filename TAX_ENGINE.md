# TAX_ENGINE.md — IVA

> **Fuente archivada que gobierna este módulo:** RG AFIP 4597/2019, texto
> actualizado (Libro de IVA Digital), modificada por RG ARCA 5707/2025.
> `docs/normative-sources/originals/INFOLEG_AFIP_RG_4597_2019_texto_actualizado.htm`,
> con su sha256 en `checksums.sha256`. Cargada al motor normativo.
>
> **Fuente que NO está archivada, y que cambia todo:** la **Ley 23.349 (IVA)**.
> Sin ella no hay alícuotas ni requisitos de cómputo del crédito fiscal.

## 1. Las dos negativas

El módulo se sostiene en dos cosas que **no** hace. Cada una tiene su test.

### No supone la alícuota general

No hay un `21` en el código, ni un `0.21`, ni una constante `IVA_GENERAL`. Las
alícuotas llegan de `tax_rates`, que tiene `norm_version_id NOT NULL` — ADR-005
convertido en constraint. Hoy la tabla está **vacía**, así que el motor responde
`SIN_ALICUOTAS_RELEVADAS`.

Suponer 21% sería la decisión más tentadora del proyecto: es la alícuota general
en Argentina desde hace décadas y acertaría casi siempre. Y por eso mismo es la
peor. Las veces que falla —carnes, frutas, medicina prepaga, servicios públicos,
bienes de capital— falla en operaciones grandes, y falla en silencio.

### No dice que un crédito fiscal sea computable

`EstadoCreditoFiscal` tiene tres valores y ninguno es `COMPUTABLE`:

| Estado | Qué significa |
|---|---|
| `IMPEDIDO_POR_FORMA` | Falló un control verificable. Ni se llega a la cuestión de fondo |
| `NO_DETERMINABLE` | Los controles de forma pasan. La computabilidad depende de la Ley 23.349 |
| `FUENTE_NO_ENCONTRADA` | No hay norma relevada para el caso |

La computabilidad la deciden los arts. 12 y 13 de la Ley 23.349: vinculación con
operaciones gravadas, regla de tope, prorrateo, exclusiones por tipo de bien. Un
motor que devolviera `COMPUTABLE` estaría afirmando algo que no verificó, y el
usuario no tendría cómo notarlo — la respuesta se vería igual que si sí.

Es el **§11** aplicado: *validación fiscal ≠ validación contable ≠ validación
económica*. Que la factura exista en ARCA no dice nada sobre si el gasto es del
giro.

Lo que sí devuelve, y es el valor real de la respuesta:

```
Constatación en ARCA .......... OK / FAIL / NO CONSULTADO (los tres, distintos)
Emisor en base de apócrifos ... sí / no / no se pudo consultar
IVA discriminado .............. sí / no
Alícuota identificada ......... cuál, o por qué no
Total = suma de conceptos ..... sin tolerancia
```

## 2. Distinciones que el módulo no aplana

**`FAIL` no es `NO_CONSULTADO`.** Un comprobante que ARCA rechaza es un problema
del comprobante; uno que nunca se consultó es un problema del sistema. Tratarlos
igual haría que un corte de servicio de ARCA se vea como una factura apócrifa.

**"No se pudo verificar" no es "está limpio".** Si el padrón no responde, el
motor avisa **sin bloquear** —bloquear cada compra pararía el estudio— pero deja
dicho que el dato falta.

**Un código de comprobante desconocido no se supone que suma.** De la clase
depende si el comprobante suma o resta en el período, y suponer que suma infla la
declaración justo cuando el código desconocido era una nota de crédito.

## 3. Las notas de crédito restan, y el signo sale del catálogo

No hay una lista de códigos en el código. Los tipos de comprobante son una tabla
que ARCA publica por WebService con `FchDesde`/`FchHasta` por entrada — el
hallazgo de FASE 3b. La clase se resuelve contra `arca_comprobante_types`
**consultada por la fecha del comprobante**, no por `now()`.

```sql
LEFT JOIN arca_comprobante_types ct
       ON ct.codigo = t.cbte_tipo
      AND (ct.valid_from IS NULL OR ct.valid_from <= t.cbte_fecha)
      AND (ct.valid_to   IS NULL OR ct.valid_to   >= t.cbte_fecha)
```

## 4. El subdiario es dos cosas a la vez

1. El **registro fiscal** del que sale la declaración jurada.
2. El **libro auxiliar contable** del que el CCyC art. 327 permite que surja un
   asiento resumido en el Diario.

`comoSubdiarioDeclarado()` es el puente: devuelve exactamente la estructura que
`resumirPorMes` del motor contable exige, con el hash del contenido en la
referencia. Sin ese puente, el estudio llevaría el subdiario por un lado y
declararía "hay un subdiario" por otro — que es justo la afirmación que el
art. 327 pide poder verificar.

Los comprobantes con hallazgos bloqueantes quedan **fuera de los totales pero
dentro de la lista**, con su hallazgo. Un comprobante que desaparece del
subdiario sin dejar rastro es un comprobante que nadie va a ir a buscar.

La fila `SIN IDENTIFICAR` de los totales por alícuota existe a propósito. Si
tiene importe, la declaración no está lista — y verlo es el punto.

## 5. Libro de IVA Digital — lo que la RG 4597 T.O. sí dice

| Regla | Artículo |
|---|---|
| Mes calendario | Art. 12 |
| Presentación dentro de los primeros **15 días corridos** del mes siguiente | Art. 12 |
| Se presenta **aun sin operaciones**, con la novedad `SIN MOVIMIENTO` | Art. 12 |
| Un período **solo se presenta si se generó el anterior** | Art. 12 |
| Confirmación con carácter de **declaración jurada** | Art. 9° |

El motor **no** corre el vencimiento al hábil siguiente cuando cae fin de semana.
El traslado sale del art. 7° del Decreto 1397/79 y del calendario de feriados,
ninguno archivado; aplicarlo de memoria daría una fecha que el sistema no puede
fundar.

## 6. Tres cosas que el sistema se niega a hacer, con su artículo

### No genera el archivo de importación de ARCA

El art. 8° dice que los diseños de registro *«se especifican en el micrositio IVA
del sitio web institucional»*. **No están en la norma.** Inventar un layout
produciría un archivo rechazado, o —peor— uno aceptado con los campos corridos.

`GET /vat/books/export-file` devuelve **501**, no 404: el endpoint existe, la
funcionalidad está identificada, y lo que falta es una fuente. Un 404 haría pensar
que nadie lo pensó.

### No presenta el libro

El art. 6° exige ingresar al PORTAL IVA con **Clave Fiscal Nivel 3**. Este sistema
no pide, no almacena y no usa la Clave Fiscal (regla de FASE 3a): los certificados
X.509 habilitan los WebServices, no el portal web. Un sistema que guarda la Clave
Fiscal de un estudio guarda la llave de todos sus clientes.

Por eso el estado se llama `PRESENTADO_POR_TERCERO` y no `PRESENTADO`: el nombre
dice quién lo hizo.

### No dice quién está obligado antes del 01/12/2025

El art. 2° vigente —sustituido por la RG 5707— alcanza a los **sujetos exentos**
en el IVA, con seis excepciones. Es un cambio grande: antes el régimen apuntaba a
otro universo de contribuyentes.

El texto anterior lo sustituyó la RG 5133/2021, que **no está archivada**: el
"texto actualizado" de InfoLeg lista la modificación en sus Antecedentes
Normativos pero no transcribe el texto viejo. Responder con la regla de hoy sobre
un período de 2024 sería exactamente lo que el §6 prohíbe, así que para períodos
anteriores el motor devuelve `OBLIGACION_NO_DETERMINABLE` con la leyenda
`NO VERIFICABLE CON FUENTE OFICIAL DISPONIBLE`.

El libro **se arma igual**. Negarse a armarlo no ayudaría a nadie; lo que no puede
pasar es que afirme quién estaba obligado.

## 7. Aritmética

Todo en enteros. La alícuota se guarda como razón (`numerator`/`denominator`), no
como decimal: `21/100` es exacto, `0.21` no lo es en binario, y una alícuota que
multiplica millones de pesos no puede tener error de representación en el factor.

El IVA se **lee**, no se calcula: el motor toma el que el comprobante discrimina y
verifica que salga de alguna alícuota relevada. Calcularlo sería reemplazar lo que
el emisor declaró por lo que el sistema cree, y el que responde ante ARCA por ese
número es el emisor.

Tolerancia de **un centavo** al identificar la alícuota, porque el emisor redondeó
por renglón y nosotros rehacemos la cuenta desde el total. Dos centavos ya no es
redondeo.

## 8. Estado declarado

| | Estado |
|---|---|
| `taxes` | 1 fila: IVA |
| `tax_rates` | **vacía** — falta archivar la Ley 23.349 |
| Subdiarios | funcionan; sin alícuotas, todo cae en `SIN_ALICUOTAS_RELEVADAS` |
| Libro de IVA Digital | se arma; no se exporta a ARCA ni se presenta |

## 9. Gaps declarados

- **Ley 23.349** — alícuotas (art. 28), crédito fiscal (arts. 12 y 13), prorrateo.
  Es el bloqueante principal.
- **Diseños de registro** del micrositio IVA de ARCA.
- **RG 5133/2021** — texto anterior del art. 2° de la RG 4597.
- **Percepciones y retenciones**: se registran como importe y entran al total; no
  hay motor de regímenes.
- **IIBB y convenio multilateral**: fuera del MVP con motivo.
- **Traslado de vencimientos** a día hábil.
- **Prorrateo** de crédito fiscal en actividades mixtas.
