# @aai/tax-engine

IVA: subdiarios de Compras y Ventas, notas de crédito, evaluación del crédito
fiscal y Libro de IVA Digital. **Alícuotas desde la base con su norma, nunca
cableadas.**

Documentación completa en [TAX_ENGINE.md](../../TAX_ENGINE.md).

## Las dos negativas que definen el paquete

**No hay un `21` en el código.** Ni `0.21`, ni una constante `IVA_GENERAL`. Las
alícuotas salen de `tax_rates`, que tiene `norm_version_id NOT NULL`. Se siembran
con `npm run tax:seed` desde el art. 28 de la Ley de IVA (t.o. 1997), archivada.
Para fechas anteriores al 18/11/2002 no hay ninguna vigente y el motor responde
`SIN_ALICUOTAS_RELEVADAS`: el T.O. archivado no transcribe sus antecedentes.

Suponer 21% acertaría casi siempre. Por eso es peligroso: falla en carnes, frutas,
medicina prepaga, servicios públicos y bienes de capital, que son operaciones
grandes, y falla sin ruido.

**`EstadoCreditoFiscal` no tiene `COMPUTABLE`, y no lo tiene aunque la ley esté
archivada.** El art. 12 condiciona el cómputo a la vinculación con operaciones
gravadas, que es un hecho del negocio y no un campo del comprobante: la misma
factura de nafta es crédito para la empresa de fletes y no para el auto del socio.

El motor verifica lo verificable —constatación en ARCA, base de apócrifos, IVA
discriminado, alícuota, total que cierra, y la **regla de tope** del art. 12 inc.
a)— y devuelve `NO_DETERMINABLE` con esa lista y con lo que falta para decidir de
fondo. Archivar la ley no trajo el dato que falta; trajo poder nombrarlo.

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
