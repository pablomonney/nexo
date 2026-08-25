# @aai/tax-engine

IVA: subdiarios de Compras y Ventas, notas de crédito, evaluación del crédito
fiscal y Libro de IVA Digital. **Alícuotas desde la base con su norma, nunca
cableadas.**

Documentación completa en [TAX_ENGINE.md](../../TAX_ENGINE.md).

## Las dos negativas que definen el paquete

**No hay un `21` en el código.** Ni `0.21`, ni una constante `IVA_GENERAL`. Las
alícuotas salen de `tax_rates`, que tiene `norm_version_id NOT NULL`. Hoy la
tabla está vacía —la Ley 23.349 no está archivada— así que el motor responde
`SIN_ALICUOTAS_RELEVADAS`.

Suponer 21% acertaría casi siempre. Por eso es peligroso: falla en carnes, frutas,
medicina prepaga, servicios públicos y bienes de capital, que son operaciones
grandes, y falla sin ruido.

**`EstadoCreditoFiscal` no tiene `COMPUTABLE`.** Eso lo deciden los arts. 12 y 13
de la Ley 23.349. El motor verifica lo verificable —constatación en ARCA, base de
apócrifos, IVA discriminado, alícuota, total que cierra— y devuelve
`NO_DETERMINABLE` con esa lista y con lo que falta relevar para decidir de fondo.

Es el §11: **validación fiscal ≠ validación contable ≠ validación económica**. Que
la factura exista en ARCA no dice nada sobre si el gasto es del giro.

## Distinciones que no se aplanan

| No es lo mismo | Y el motor lo dice distinto |
|---|---|
| ARCA rechazó el comprobante | Nunca se consultó |
| El emisor no está en apócrifos | No se pudo consultar el padrón |
| El código de comprobante suma | No se sabe qué clase es |

## El puente con el CCyC art. 327

`comoSubdiarioDeclarado()` devuelve la estructura que `resumirPorMes` del motor
contable exige para aceptar un asiento resumido mensual, con el hash del
contenido. El subdiario de IVA **es** el subdiario del que el art. 327 permite
que surja el resumen — no dos cosas distintas que casualmente coinciden.
