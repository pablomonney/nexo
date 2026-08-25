# @aai/accounting-engine

Motor contable determinístico. **No usa IA, no llama a la red, no lee archivos.**

Recibe un borrador de asiento y el estado del libro, y decide si el asiento puede
existir. Esa superficie chica es lo que permite probarlo de forma exhaustiva: cada
caso es un objeto literal, sin base, sin mocks, sin orden de ejecución.

```ts
prepararPosteo(draft, context) → Result<AsientoParaNumerar, AccountingError[]>
```

Devuelve `Result`, no lanza. Un asiento rechazado produce una **lista** de errores
tipados, no el primero que apareció: el destinatario es un contador que necesita
corregir todo de una pasada.

## Las once validaciones

| # | Qué | Error |
|---|---|---|
| 1 | ≥ 2 líneas | `E_MIN_LINES` |
| 2 | Débito **o** crédito, importe > 0, moneda coherente | `E_LINE_SIDE` |
| 3 | Σ débitos = Σ créditos **en la moneda de la contabilidad** | `E_UNBALANCED` |
| 4 | Cuenta existente, activa e imputable | `E_ACCOUNT_NOT_POSTABLE` |
| 5 | Período abierto | `E_PERIOD_CLOSED` |
| 6 | Fecha dentro del período y del ejercicio | `E_DATE_OUT_OF_PERIOD` |
| 7 | Centro de costo y tercero cuando la cuenta los exige | `E_MISSING_DIMENSION` |
| 8 | Moneda extranjera con cotización, fuente y fecha | `E_MISSING_FX` |
| 9 | Línea con rol fiscal vinculada a su operación | `E_TAX_LINK_MISSING` |
| 10 | Regla aplicada o justificación manual firmada | `E_NO_TRACEABILITY` |
| 11 | El comprobante no tiene ya un asiento vigente | `E_DUPLICATE_SOURCE` |

La #3 se verifica **dos veces**: acá y como `CONSTRAINT TRIGGER` diferido en
PostgreSQL. La redundancia es deliberada — el invariante más importante del
sistema no puede depender de que esta capa no tenga bugs.

La #10 es la que hace estructural la trazabilidad del §24: un asiento sin origen
demostrable **no se postea, ni siquiera a mano**. El humano tiene que firmar el
motivo.

## Cuatro decisiones que se notan usándolo

**Ante un descuadre, rechaza; no ajusta.** No hay cuenta de diferencias donde
esconder el resto. Un motor que cierra la diferencia solo produce libros que
siempre cuadran y asientos que nadie revisó.

**El signo lo da la columna.** Los importes negativos se rechazan y el
contraasiento **intercambia** Debe y Haber en vez de restar. Un libro con
importes negativos no es un libro.

**El modo de redondeo de la conversión es un parámetro, no una constante**
(ADR-005). Hay un test que lo muestra sin metáfora: el mismo asiento en dólares
cuadra con `HALF_UP` y no cuadra con `DOWN`. Si fuera una constante del código,
esa decisión —que depende de la norma aplicable— sería invisible.

**En la base se guardan los importes originales**, con su moneda y su cotización.
El convertido se recalcula. Guardar solo el convertido perdería el dato de la
operación tal como ocurrió, que es justamente lo que un libro tiene que conservar.

## El motor no numera

Devuelve un asiento listo para numerar; el número lo pone el repositorio dentro
de la transacción, con `next_entry_number` tomando la fila del contador para
actualización.

No es purismo. Si el motor dijera "el número es el 47" y después la transacción
hiciera rollback, el 47 quedaría libre o duplicado. Acá vive la **regla**
—correlativa, sin huecos, por `(empresa, libro, ejercicio)`— y allá la
**mecánica**. Hay un test que postea diez asientos en paralelo y verifica que la
secuencia salga `1..10` sin saltos.

**Un asiento anulado conserva su número.** El hueco sería peor que el asiento
anulado: un libro con saltos no se puede defender ante nadie.

## Períodos

```
ABIERTO ──bloquear──► BLOQUEADO ──cerrar──► CERRADO
   ▲                                            │
   └──────── reapertura con doble firma ────────┘
```

`BLOQUEADO` no es un `CERRADO` suave: significa "solo ajustes de cierre". La
distinción existe porque el cierre lleva días y durante esos días hay que poder
asentar ajustes sin que entre operación corriente.

La reapertura exige **dos personas distintas** y motivo. Que una sola pueda
hacerlo convierte el cierre en una formalidad.

## Balance de sumas y saldos

Tres igualdades, verificadas en cada corrida:

```
Σ débitos          =  Σ créditos
Σ saldos deudores  =  Σ saldos acreedores
saldo inicial + débitos − créditos = saldo final   (por cuenta)
```

Si alguna falla, la respuesta marca **modo degradado** y el sistema no emite
estados contables. Un balance que no cuadra no es un reporte con una salvedad al
pie: es un libro roto, y firmar estados sobre él sería firmar algo que no se
sostiene.

La tercera igualdad es tautológica dada la fórmula del saldo, y por eso mismo se
verifica: si algún día deja de serlo, es que alguien cambió cómo se calcula el
saldo y no se dio cuenta.

## Lo que deliberadamente no hace

| No hace | Quién |
|---|---|
| Decidir a qué cuenta va un gasto | `ai-engine` propone, una persona aprueba |
| Calcular el IVA | `tax-engine`, con alícuotas de `normative-engine` |
| Saber qué norma aplica | `normative-engine` |
| Leer un PDF | `document-engine` |
| Asignar el número de asiento | el repositorio, en su transacción |

Esta lista es la razón por la que se puede probar de forma exhaustiva. La
cobertura de este paquete tiene umbral propio —95%— y se verifica en
`npm run verify`.
