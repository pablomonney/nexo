# NEXO_CORPORATE — NEXO administrando a NEXO

Estado: **PARCIAL, y la parte que falta es la más grande.**

Lo que hay son **las métricas del negocio**: MRR, ARR, ARPU, altas, bajas y
cobranza, calculadas sobre las suscripciones y los cargos reales. Lo que no hay
es la contabilidad propia de NEXO, y sin ella no hay CAC, ni LTV, ni margen, ni
runway.

---

## 1. La decisión: NEXO va a ser una empresa más

El camino fácil sería un módulo aparte —tablas `nexo_gastos`, `nexo_clientes`—
que reprodujera adentro lo que el ERP ya hace afuera. Sería un sistema paralelo
que se desincroniza, y peor: NEXO dejaría de usar lo que vende.

La decisión es la contraria. **NEXO Corporate es una fila en `companies`**, con
su plan de cuentas, sus terceros, sus comprobantes y sus asientos, operando con
el mismo ERP, el mismo RLS y la misma bitácora que cualquier cliente.

Consecuencias, y son las que hacen que valga la pena:

- **Lo que no funciona para NEXO no funciona para nadie.** Un ERP que su propio
  fabricante no puede usar para llevar sus libros tiene un problema que ninguna
  demo muestra.
- Los gastos de infraestructura, de modelo y de personal se imputan como
  cualquier gasto, con su comprobante y su cuenta.
- El margen por cliente sale de la contabilidad, no de una planilla.

## 2. Lo que ya se puede afirmar

Cinco vistas, en la 0100. Se leen con:

```bash
npm run metricas:saas
```

| | Qué dice |
|---|---|
| `saas_suscripciones_vigentes` | Cada suscripción corriendo, con el importe normalizado a mes |
| `saas_ingreso_recurrente` | MRR, ARR, ARPU **por moneda** |
| `saas_sin_importe` | Las que quedaron afuera del MRR, una por una |
| `saas_movimientos` | Altas, bajas y suspensiones, con fecha |
| `saas_cobranza_mensual` | Emitido, cobrado, pendiente, incobrable y anulado |

**Las fórmulas, para que se puedan rehacer a mano:**

```
mensualizado = importe_acordado                si MENSUAL
             = importe_acordado / 12           si ANUAL

MRR  = round( Σ mensualizado , 2 )    por moneda
ARR  = round( MRR × 12 , 2 )
ARPU = MRR / (activas + prueba + suspendidas)   — null si no hay ninguna
```

Se redondea **una sola vez, al final**. Redondear cada fila y después sumar deja
unos centavos de diferencia contra redondear el total, y el que se mira es el
total.

## 3. Las cuatro decisiones que hacen auditable al número

**Ninguna métrica devuelve cero cuando no sabe.** Si no hay suscripciones con
importe acordado, el informe dice que no se puede calcular y por qué. Un `MRR:
0` se leería como «NEXO no factura nada», que es distinto de «nadie declaró
cuánto cobra».

**Lo excluido va al lado del total, siempre.** `saas_sin_importe` lista una por
una las suscripciones vigentes sin importe. Un MRR sin esa lista es un número
que no se puede revisar: no hay forma de saber si es bajo porque el negocio es
chico o porque falta cargar la mitad de los contratos.

**No se suman monedas distintas.** Un total mixto no significa nada y se ve
exactamente igual que uno que sí. Las vistas agrupan por moneda y no hay forma
de pedir el total mezclado.

**La baja voluntaria y la suspensión por falta de pago van separadas.** Una es
una decisión comercial del cliente; la otra, una consecuencia de cobranza.
Sumarlas en un solo «churn» hace que arreglar el cobro se vea como retener
clientes, que es la conclusión equivocada y además la más cara.

## 4. De dónde sale la fecha de una baja

De `audit_logs`. `company_subscriptions` guarda el **estado actual**; cuándo pasó
a estarlo lo sabe la bitácora, que registra cada cambio con su `occurred_at`, su
actor y su motivo.

Agregar un `cancelada_el` sería un segundo registro del mismo hecho, capaz de
contradecir al primero — es el ADR-022 aplicado donde más tienta desobedecerlo,
porque una columna sería más cómoda de consultar.

## 5. Por qué estas vistas no llevan `security_invoker`

Todas las demás vistas del repositorio lo llevan, para que el RLS de las tablas
de abajo se aplique con los privilegios de quien consulta. **Estas cinco no**,
porque su propósito es el contrario: agregar sobre todas las empresas.

Eso las vuelve el objeto más peligroso del esquema. Lo único que lo compensa es
que **`aai_app` no las puede leer**: está revocado explícitamente —no alcanza
con no conceder, porque la 0009 concede sobre todo objeto nuevo— y
`tests/security/metricas-del-operador.test.ts` lo comprueba contra el catálogo,
además de barrer por prefijo para que una vista nueva sin declarar tampoco pase,
y de verificar que ninguna ruta las nombre.

No hay endpoint que devuelva estas métricas, y no puede haberlo: tendría que
leerlas con un rol que las pueda leer, y ese rol no es el de la aplicación.

## 6. Lo que NO se calcula, y por qué no es un olvido

| | Qué necesita | Por qué no está |
|---|---|---|
| **CAC** | Gasto de adquisición: marketing, ventas, comisiones | NEXO no lleva su contabilidad |
| **LTV** | Margen bruto por cliente | Ídem |
| **Costo por cliente** | Infraestructura, modelo, almacenamiento, soporte | Ídem |
| **Margen por plan** | Ingreso por plan menos su costo | Ídem |
| **Burn, runway** | Egresos y caja propios | Ídem |
| **Churn como tasa** | Base de clientes al inicio del período | Se puede, cuando haya doce meses de historia real |

Todos comparten la misma causa, y por eso se destraban juntos: **NEXO no es
todavía una empresa dentro de NEXO.**

Una vista que devolviera CAC con los datos que hay estaría inventando el
numerador, y un CAC inventado se ve exactamente igual que uno medido —
aparecería en un tablero, alguien lo compararía contra el del mes pasado y
tomaría una decisión con él.

## 7. Cómo se destraba

```
1. Dar de alta NEXO como empresa           ← se puede hoy
2. Cargar su plan de cuentas
3. Imputar sus gastos con comprobante      ← infra, modelo, personal
4. Registrar sus ingresos                  ← desde billing_documents
5. Recién ahí: CAC, LTV, margen, runway
```

Los pasos 1 a 4 no necesitan código nuevo: son el ERP funcionando. El paso 4 sí
necesita una decisión —cómo se reconoce el ingreso de una suscripción anual
cobrada por adelantado— y esa decisión es contable, no técnica.

## 8. Lo que sigue faltando de Corporate

Además de la contabilidad propia: no hay CRM de NEXO —el módulo `crm_*` es el
que NEXO le da a sus clientes—, ni pipeline comercial propio, ni gestión de
equipo, ni soporte con SLA, ni tablero ejecutivo.

Nada de eso está construido, y decirlo importa: la visión del prompt maestro
describe una plataforma que se administra a sí misma, y lo que existe hoy son
**las métricas de suscripción del negocio**, que es un pedazo de eso y no el
todo. Ver `NEXO_CURRENT_BASELINE.md` §4.
