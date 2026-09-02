# ADR-019 — El mapeo contable se declara, y sin él no se propone nada

**Fecha:** 2026-09-02
**Estado:** aceptada
**Contexto:** auditoría integral (`docs/auditoria/AUDITORIA_INTEGRAL.md`)

## El problema

La auditoría encontró que **el Mayor se escribía a mano**. `INSERT INTO
journal_entries` aparecía en dos lugares —la carga manual y el cierre de
ejercicio— y en las 73 migraciones no había un solo trigger que creara un
asiento. Facturar, cobrar, pagar, recibir mercadería o devengar una comisión no
producían ninguno.

Cada módulo lo decía honestamente en su documentación —«este módulo no toca el
Mayor»— y esa decisión es correcta módulo por módulo: lo que faltaba era el paso
que la resuelve una vez para todos.

Y el motor que lo resolvería ya estaba escrito: `decision-de-comprobante.ts`
produce una `PropuestaDeAsiento` con renglones, recibiendo el armador como
parámetro. La API le pasaba `() => []`. La propuesta salía siempre vacía y la
respuesta la descartaba.

## Por qué estaba vacía

No era un olvido. Armar los renglones exige saber a qué cuenta va cada cosa, y
esa declaración **no existía**. Una parte del mapeo sí estaba —`products` tiene
cuenta de venta y de compra, `accounts.tax_role` distingue IVA débito de IVA
crédito— pero la contrapartida no: en ningún lado estaba escrito cuál es la
cuenta de deudores por ventas ni la de proveedores de esta empresa.

## La decisión

**El mapeo se declara por empresa, en `company_account_map`, y sin él el sistema
no propone nada.**

Seis roles: `CLIENTES`, `PROVEEDORES`, `IVA_DEBITO`, `IVA_CREDITO`, `VENTAS`,
`COMPRAS`. Mientras falte uno, el comprobante que lo necesita no recibe
propuesta, y la respuesta **dice cuál falta por su nombre**.

Es la misma disciplina que ya gobierna la tarifa horaria de proyectos (0070), el
esquema de comisión (0071), la probabilidad de una etapa del embudo (0069) y los
umbrales de análisis (0058): lo que nadie declaró no se supone.

### Tres consecuencias que no son negociables

1. **La cuenta tiene que servir para el rol.** Deudores es del activo,
   proveedores del pasivo, ventas es un ingreso. Lo comprueba un trigger y no la
   aplicación, porque una declaración por SQL directo tiene las mismas
   consecuencias que una por la API. Un asiento armado con una cuenta del tipo
   equivocado descuadra el balance en silencio y el error aparece un ejercicio
   después.

2. **No se propone lo que el mapeo no cubre.** Si el comprobante trae no
   gravado, exento o percepciones, no hay propuesta. Meterlos en la cuenta de
   ventas para que el total cierre daría un asiento **cuadrado y equivocado**,
   que es la peor combinación posible: pasa todos los controles y dice una
   mentira.

3. **La propuesta no se guarda ni se registra.** Se recalcula cuando alguien la
   pide. Guardarla crearía una tercera verdad —el comprobante, el asiento y una
   propuesta vieja contra un mapeo que cambió— y es la única de las tres que no
   es un hecho. Y la ruta que la arma **no escribe en el Diario**: devuelve los
   renglones para que se carguen por `POST /journal-entries`, que sigue siendo
   el único camino que numera, resuelve el período y exige aprobación humana.

## Lo que esta decisión NO habilita

No habilita el asiento automático. La propuesta entra al Diario **en borrador** y
la aprueba una persona, como cualquier otro asiento (A-6). El §24 sigue
gobernando: el asiento se funda en que alguien miró la propuesta y la cargó, y
eso es lo que dice su justificación — no «lo armó el sistema».

## Alternativas descartadas

**Elegir la cuenta por heurística** (la primera del activo que se llame
«deudores», la que más se usó el mes pasado). Es inventar la contabilidad de
alguien, y el error aparece en el balance de un tercero.

**Sembrar un plan de cuentas por defecto con su mapeo.** Un plan de cuentas es
una decisión del ente y de su marco de reporte; sembrarlo haría que todos los
balances hablaran de una estructura que nadie acordó.

**Guardar la propuesta junto a la decisión contable.** Congelaría los renglones
contra un mapeo que puede cambiar, y dejaría dos respuestas distintas a «qué
asiento propone este comprobante».
