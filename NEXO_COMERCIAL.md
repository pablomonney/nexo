# NEXO_COMERCIAL — planes, precios y cómo se vende

**Actualizado:** 2026-09-08, al cerrar B-1.

Todo lo de este archivo se clasifica de una de cinco formas, y la clasificación
está al lado de cada afirmación:

| | |
|---|---|
| **VERIFICADO** | Se midió contra el código, la base o la suite |
| **DECIDIDO** | Una persona lo eligió; queda registrado quién y cuándo |
| **SUPUESTO** | Una hipótesis de trabajo. No se midió y puede estar mal |
| **BLOQUEADO** | Falta algo externo. Dice qué y cómo se destraba |
| **FUTURO** | No existe. No se vende |

---

## 1. Los planes

> ⚠ **La tabla de abajo es la lista de B-1 y quedó superada.** El 2026-09-15 se
> declaró la lista definitiva, con otros importes y **con IVA incluido** —
> `declarado_por = 'comercial-2026-09'`, motivo «Lista comercial de septiembre
> de 2026. Importes FINALES, con IVA incluido.»—.
>
> **La lista vigente está en `plan_prices`, no acá.** Se la ve sin sesión en
> `GET /planes`, que además deriva el tratamiento del IVA de la propia fila en
> vez de afirmarlo por su cuenta. Este documento no se reescribió porque cuál es
> la lista canónica y cómo se comunica es una decisión comercial; la marca está
> para que nadie copie de acá cinco números que ya no se cobran.

**DECIDIDO** — precios de B-1, declarados el 2026-09-08 con
`npm run comercial:b1 -- --aplicar`. Quedan en `plan_prices` con vigencia y
motivo; una lista nueva cierra la anterior en vez de pisarla.

| Plan | Precio mensual | Para quién |
|---|---:|---|
| NEXO Contable | $ 29.900 + IVA | Una empresa que lleva sus libros |
| NEXO Gestión | $ 59.900 + IVA | Una empresa con operación completa |
| NEXO Estudio | $ 79.900 + IVA | Un estudio con su cartera de clientes |
| NEXO Empresa | $ 99.900 + IVA | Varias sucursales, proyectos y analítica |
| NEXO Completo | $ 159.900 + IVA | Todo, más análisis y decisiones |

Los importes son **netos**. La lista dice «+ IVA», así que lo que se guarda es
el neto: guardar el final y llamarlo neto es equivocarse por un 21 % en cada
cargo, y ese error no se ve hasta la primera conciliación.

**Prueba: 14 días, sin tarjeta.** Al terminar, la suscripción queda
`SUSPENDIDA` — los datos, la contabilidad y el historial quedan intactos, y el
acceso vuelve contratando. No queda `CANCELADA`: cancelar es una decisión del
cliente y de ahí no se vuelve.

## 2. Matriz de producto

**VERIFICADO** — sale de `plan_matrix`, que cruza los planes con el catálogo de
funcionalidades. Cada funcionalidad del catálogo **existe y corre**: ninguna
describe algo por venir.

```bash
psql -c "SELECT plan_code, feature, incluida FROM plan_matrix ORDER BY plan_orden, feature_orden"
```

| Funcionalidad | Contable | Gestión | Estudio | Empresa | Completo |
|---|:-:|:-:|:-:|:-:|:-:|
| Contabilidad | ● | ● | ● | ● | ● |
| Fiscal y comprobantes | ● | ● | ● | ● | ● |
| Clientes y proveedores | ● | ● | ● | ● | ● |
| Documentos y OCR | ● | ● | ● | ● | ● |
| Auditoría y trazabilidad | ● | ● | ● | ● | ● |
| ARCA (padrón, constatación) | ● | ● | ● | ● | ● |
| Ventas | | ● | | ● | ● |
| Compras | | ● | | ● | ● |
| Stock | | ● | | ● | ● |
| Tesorería | | ● | | ● | ● |
| Productos y listas de precios | | ● | | ● | ● |
| Analítica | | | ● | ● | ● |
| Sucursales y centros de costo | | | | ● | ● |
| Proyectos | | | | ● | ● |
| Comisiones | | | | ● | ● |
| CRM | | | | ● | ● |
| Análisis y decisiones | | | | | ● |
| Inteligencia | | | | | ● |
| Integraciones | | | | | ● |

Las seis primeras son **esenciales**: un plan que no las incluyera se podría
contratar y no se podría usar, y `tests/security/planes-vendibles.test.ts` lo
impide.

**El reparto es SUPUESTO.** Está declarado con `declarado_por = 'hipotesis-b1'`
justamente para que se distinga de una decisión tomada. Ver §8.

## 3. Topes

**SUPUESTO** — declarados con `declarado_por = 'hipotesis-b1'`.

| Recurso | Contable | Gestión | Estudio | Empresa | Completo |
|---|---:|---:|---:|---:|---:|
| Empresas | 1 | 1 | 25 | 3 | 5 |
| Usuarios | 3 | 8 | 10 | 20 | 40 |
| Comprobantes / mes | 300 | 1.500 | 4.000 | 6.000 | 20.000 |
| Documentos / mes | 300 | 1.500 | 4.000 | 6.000 | 20.000 |
| Integraciones | 1 | 2 | 2 | 5 | 15 |

**El tope no bloquea: avisa.** Un sistema contable que se niega a registrar un
hecho por una cuestión comercial deja los libros incompletos, y eso no se
arregla pagando después — el hecho ya pasó y quedó sin asentar. El uso se mide
y aparece en la bandeja como informativo.

Y un tope sin declarar **no es «ilimitado»**: se informa como
`SIN_TOPE_DECLARADO`, que es otra cosa.

## 4. Cómo se hace cumplir un plan

**VERIFICADO** — `apps/api/src/planes/alcance.ts`, con tests en
`tests/integration/prueba-y-planes.test.ts`.

La puerta comercial **falla abierta**, y es deliberado:

- un dominio de ruta que ninguna funcionalidad cubre se deja pasar;
- una empresa sin suscripción se deja pasar;
- una suscripción con un plan sin funcionalidades cargadas se deja pasar.

El error caro de una puerta comercial es dejar afuera a alguien que paga. El
error caro de una puerta de seguridad es dejar entrar a alguien que no, y esa
puerta es otra: **el aislamiento entre empresas no depende de esto en
absoluto** — lo sostienen el RLS y los permisos, y hay un test que comprueba que
sin plan contratado se sigue sin ver los datos de otra empresa.

Cerrar esta de más produce un cliente furioso el primer día del mes; cerrarla de
menos produce un mes de un módulo regalado, que se arregla facturándolo.

## 5. Economía unitaria

**El ingreso es aritmética sobre precios DECIDIDOS. Todos los costos son
SUPUESTOS**, y hay que decirlo fuerte: NEXO no lleva su propia contabilidad
todavía, así que **no hay un solo costo medido**. Ver `NEXO_CORPORATE.md` §6.

### Los supuestos, uno por uno

| | Valor | Por qué |
|---|---|---|
| Mezcla de planes | 35 % Contable · 30 % Gestión · 20 % Estudio · 10 % Empresa · 5 % Completo | SUPUESTO. Un producto nuevo vende primero lo barato |
| Infraestructura por cliente | $ 2.500 / mes | SUPUESTO |
| Almacenamiento por cliente | $ 800 / mes | SUPUESTO |
| Correo por cliente | $ 300 / mes | SUPUESTO. **No hay proveedor contratado** |
| Comisión de pasarela | 3,5 % del cobro | SUPUESTO. **No hay pasarela contratada** |
| Costo de IA por cliente | **no está** | No hay proveedor de modelo conectado |
| Soporte por cliente | **no está** | No hay estructura de soporte |

**ARPU de esa mezcla: $ 62.400** por mes, neto.

### Los escenarios

| Clientes | MRR | ARR | Costo variable | Margen bruto | Margen |
|---:|---:|---:|---:|---:|---:|
| 1 | $ 62.400 | $ 748.800 | $ 5.784 | $ 56.616 | 90,7 % |
| 10 | $ 624.000 | $ 7.488.000 | $ 57.840 | $ 566.160 | 90,7 % |
| 50 | $ 3.120.000 | $ 37.440.000 | $ 289.200 | $ 2.830.800 | 90,7 % |
| 100 | $ 6.240.000 | $ 74.880.000 | $ 578.400 | $ 5.661.600 | 90,7 % |
| 500 | $ 31.200.000 | $ 374.400.000 | $ 2.892.000 | $ 28.308.000 | 90,7 % |
| 1.000 | $ 62.400.000 | $ 748.800.000 | $ 5.784.000 | $ 56.616.000 | 90,7 % |

**El margen constante es la señal de que el modelo es de juguete**, no de que el
negocio escale perfecto. Sale de suponer costo variable puramente lineal y cero
costo fijo. En la realidad hay escalones —la primera réplica, el primer plan
pago de infraestructura, la primera persona de soporte— y ninguno está acá
porque ninguno se midió.

### Punto de equilibrio

Con contribución de $ 58.616 por cliente y mes:

| Costo fijo mensual (SUPUESTO) | Equilibrio |
|---|---:|
| $ 1.500.000 | 27 clientes |
| $ 3.000.000 | 53 clientes |
| $ 6.000.000 | 106 clientes |

### Lo que NO se calcula

**CAC y LTV no se pueden calcular todavía.** CAC necesita el gasto de
adquisición y LTV el margen bruto real por cliente y una tasa de bajas medida.
Ninguno existe: NEXO no lleva su contabilidad y no tiene un mes de historia
comercial.

Un CAC inventado se ve exactamente igual que uno medido — aparecería en un
tablero, alguien lo compararía contra el del mes pasado y decidiría con él. Por
eso el informe de métricas los omite en vez de estimarlos.

## 6. Los primeros clientes

**Prioridad**, y el orden importa: el primer cliente no debe ser una
corporación. El objetivo de B-1 es aprender.

1. **Estudios contables chicos** (2–10 empresas). Son el mejor primer cliente:
   entienden el vocabulario, sufren la fragmentación todos los meses, y cada uno
   trae varias empresas. El plan Estudio existe por ellos.
2. **Pymes de servicios** con facturación regular y poco stock. La operación es
   simple y el valor se ve rápido.
3. **Comercios** con stock y varios puntos de venta.
4. **Empresas que hoy usan Excel** y ya sintieron el dolor de conciliar.

### El recorrido

```
lead  →  demo  →  prueba 14 días  →  primera operación real  →  contratación
      →  retención  →  segunda empresa  →  referencia
```

**El hito que importa no es el registro: es la primera operación real.** Un
cliente que cargó su plan de cuentas y asentó una venta suya ya invirtió algo;
uno que solo se registró todavía no. La métrica a mirar en B-1 es **cuántos
llegan de la prueba a la primera venta asentada**, y cuánto tardan.

### Qué falta para poder venderlo

| | Estado |
|---|---|
| Página pública con precios | **VERIFICADO** — `/` sirve la landing, los precios salen de la API |
| Registro y confirmación | **PREPARADO** — el adaptador de Resend está (B2.5.1). Falta la cuenta, el dominio verificado y declarar `EMAIL_PROVIDER=resend`. Con `none` —el valor por omisión— el token queda en la bandeja y lo entrega el operador |
| Alta de empresa y prueba | **VERIFICADO** — `POST /onboarding/empresa` |
| Cobrar la suscripción | **BLOQUEADO** — no hay pasarela. Entra por transferencia, a mano |
| Emitir la factura al cliente | **BLOQUEADO** — certificado ARCA de producción |
| Soporte | **FUTURO** — no hay tickets ni SLA |

## 7. Métricas del producto a instrumentar

**VERIFICADO** lo que ya se mide:

| | Dónde |
|---|---|
| MRR, ARR, ARPU por moneda | `saas_ingreso_recurrente` |
| Altas, bajas y suspensiones | `saas_movimientos`, desde la bitácora |
| Emitido y cobrado por mes | `saas_cobranza_mensual` |
| Suscripciones sin importe acordado | `saas_sin_importe` |
| Pruebas en curso, por vencer y vencidas | `trial_status` |

**FUTURO** lo que falta y hay que instrumentar antes de tener clientes:

- **tiempo hasta la primera operación real** — el hito de activación;
- conversión de prueba a plan pago;
- uso por módulo, para saber qué se usa y qué sobra en cada plan;
- bajas con motivo agrupado.

Ninguna se puede calcular sin clientes, y por eso no se inventaron vistas que
devolvieran cero.

## 8. Decisiones que necesitan al fundador

Las que realmente lo necesitan. Todo lo demás está hecho o documentado como
bloqueo externo.

| | Decisión | Hoy | Por qué importa |
|---|---|---|---|
| **D-1** | **Qué incluye cada plan** | Hipótesis B-1, cargada | Es lo que el cliente compra. Si Gestión no debería incluir stock, hay que decirlo antes del primer cliente, no después |
| **D-2** | **Los topes** | Hipótesis B-1, cargada | Determinan cuándo se le avisa a alguien que excedió. Un tope mal puesto molesta a quien paga |
| **D-3** | **Periodicidad anual y su descuento** | No existe | La estructura la soporta (`ANUAL`, se mensualiza para el MRR). Falta decidir si se ofrece y a cuánto |
| **D-4** | **Qué pasarela** | Ninguna | Define la comisión, que es el costo variable más grande del modelo |
| **D-5** | **Qué proveedor de correo** | Ninguno | Sin él el alta no se completa sola |
| **D-6** | **Condición de IVA de NEXO** | Sin cargar | Sin eso los cargos no discriminan impuestos y no se puede facturar |
| **D-7** | **Jurisdicción del hosting** | Sin decidir | Son datos contables de terceros |

Para cambiar D-1 o D-2 no hace falta código: se vuelve a declarar con
`npm run comercial:b1`, o se editan las filas con el nombre de quien lo decide
en `declarado_por`.

## 9. Lo que esta página promete y lo que no

La landing dice qué hace NEXO **hoy**, y tiene una sección aparte —«en qué
estamos trabajando»— con lo que no está: emisión de facturas con CAE, pago con
tarjeta, asistente conversacional y RRHH.

Es la regla más fácil de romper de todo el repositorio, porque una landing
premia exactamente lo contrario. Un sistema que promete emitir y no emite deja
al cliente sin facturar el primer día del mes, y eso no se arregla con una
disculpa.
