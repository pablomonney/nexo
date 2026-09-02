# ADR-020 — La valuación se declara, y solo se ofrece lo que se calcula

**Fecha:** 2026-09-02
**Estado:** aceptada
**Migraciones:** 0077, 0078

## El problema

`COBERTURA_ERP.md` tenía la valuación de existencias como DECISIÓN desde la
primera auditoría: «PPP, FIFO o costo de reposición es una decisión contable con
norma detrás. Sin ella no hay costo de mercadería vendida ni margen».

La consecuencia era concreta: el resultado del ejercicio no incluía el costo de
lo vendido. Una venta figuraba entera como ganancia.

## La decisión

**El método lo declara la empresa; el sistema calcula el que declaró y solo
ofrece los que sabe calcular.**

Tres piezas:

1. **Un catálogo de métodos con estado**, igual que los proveedores de
   integración (0056): `DISPONIBLE` o `PLANIFICADO`, cada uno con el motivo
   escrito. Hoy solo el promedio ponderado móvil está disponible.

2. **Una declaración con vigencia y motivo** (`company_stock_valuation`).
   Cambiar de método es un cambio de política contable que la norma exige
   exponer, así que el motivo es obligatorio y queda en la bitácora. Los
   movimientos anteriores no se revalúan.

3. **El costo de entrada declarado en el renglón de la recepción** (0078), que
   el trigger de proyección copia al movimiento de stock.

## Por qué solo PPP, y por qué eso no es una elección del sistema

El promedio ponderado móvil **sale de los movimientos que ya existen**: se
recorre el libro en orden y se recalcula. No hace falta ninguna estructura
nueva.

FIFO exige costear por capas —seguir cada salida contra la entrada que la
abastece— y eso es un modelo nuevo, no una consulta distinta. El costo de
reposición exige una fuente de precios vigente por producto que este sistema no
tiene ni puede inventar.

Ofrecer los tres y calcular uno sería peor que ofrecer uno: la empresa declararía
FIFO y se quedaría sin valuación sin entender por qué. Por eso el catálogo dice
de cada uno qué le falta, y declarar un `PLANIFICADO` se rechaza con ese motivo.

**Esto no elige el método por la empresa.** Elige qué puede prometer el sistema,
que es una afirmación sobre el software y no sobre la contabilidad del ente.

## Las tres reglas de la aritmética

1. **El costo de entrada se declara; el de salida se deriva.** Una salida se
   costea al promedio vigente en ese momento. Un CHECK impide que un movimiento
   de salida lleve costo declarado: sería una segunda verdad capaz de
   contradecir al promedio.

2. **Una entrada sin costo deja al producto sin valuar.** No se promedia lo que
   hay ignorando lo que falta: un promedio que ignora las entradas sin costo no
   es un promedio, es un número más chico. Se informa cuál producto y la bandeja
   lo dice.

3. **Las transferencias no entran.** Mover mercadería entre depósitos propios no
   cambia ni la cantidad ni el costo de la empresa; contarlas movería el
   promedio por una mudanza.

## Lo que esta decisión NO habilita

**No escribe ningún asiento.** El costo de mercadería vendida se calcula y se
informa; llevarlo al Mayor es un asiento que firma una persona, por el mismo
camino que todo lo demás. Automatizarlo exige decidir contra qué cuenta y en qué
momento —por venta, por período, por cierre—, y eso es otra decisión que nadie
tomó.

**No deriva el costo de la factura de compra.** Sería lo natural y hoy no
alcanza: la factura puede llegar después de la mercadería, cubrir varias
recepciones y traer conceptos que no son costo del producto —flete,
percepciones—. Prorratearlos es una política contable sin declarar. Queda
anotado como el paso siguiente.

## Alternativas descartadas

**Elegir PPP por defecto y calcularlo siempre.** Es el método más común y sigue
siendo una decisión del ente. Un balance que valúa con un criterio que nadie
eligió es un balance que dice algo que su firmante no afirmó.

**Guardar el costo promedio en una columna del producto.** Sería una segunda
verdad que se desincroniza en la primera carga masiva, y el error aparecería
recién en el balance.
