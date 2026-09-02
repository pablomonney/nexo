# @aai/shared

Tipos y utilidades que usa todo el resto. Sin red, sin disco, sin base.

## Lo que hay

| Módulo | Qué resuelve |
|---|---|
| `money.ts` | Importes como **enteros en centavos**. Nunca punto flotante. |
| `calendar-date.ts` | Fechas de calendario sin hora ni zona: una fecha contable no es un instante. |
| `cuit.ts` | Validación de CUIT con su dígito verificador. |
| `currency.ts` | Monedas y su presentación. |
| `errors.ts` | Errores tipados, para no distinguir fallas por su prosa. |
| `result.ts` | `Result` explícito donde una excepción escondería el caso. |
| `totp.ts` | Segundo factor. |

## Por qué la plata no es un número

Un `number` de JavaScript es IEEE 754: `0.1 + 0.2` no da `0.3`, y `300.99 * 100`
da `30098.999999999996`. En un sistema contable eso no es un detalle de
precisión — es un asiento que no cierra, un saldo que queda mal para siempre, o
un archivo fiscal rechazado.

`Money` guarda centavos enteros y la aritmética ocurre sobre enteros. Cuando el
cálculo vive en la base, ocurre en `numeric`.

La regla la hace cumplir un barrido: `npm run check:no-float` recorre el código
buscando `toFixed` y aritmética de punto flotante sobre importes, y falla. Ya
cazó dos veces código recién escrito.
