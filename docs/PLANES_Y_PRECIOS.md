# Planes y precios de NEXO

**Decididos el 2026-10-19 por el titular.** La fuente de verdad de los números es `scripts/sembrar-comercial-b1.mjs` (con vigencia y motivo); este documento explica el criterio.

## El criterio

1. **Se separa por quién compra, no por tamaño.** Cuatro clientes: el que lleva sus libros, la pyme que opera, el estudio contable y la empresa grande.
2. **Una sola medida que crece con el negocio del cliente:** las empresas atendidas y los usuarios. Los comprobantes son **ilimitados** en todos los planes (decisión del titular, 2026-10-20); lo que se mide y se acota es la IA, en tokens totales por día.
3. **Las funciones separan planes sólo cuando le importan a un tipo de cliente.** Sucursales, proyectos y comisiones no le sirven a quien sólo lleva libros.
4. **Lo que de verdad cuesta es el soporte**, no los datos ni la IA (el costo variable por cliente es casi cero). Por eso Empresa Plus incluye soporte prioritario y el tope de IA es generoso.
5. **Se sube de plan por empresas, usuarios y volumen de IA**, no por comprobantes: son ilimitados.
6. **Se vende sólo lo que existe.** Nada de lectura de PDF ni de conectores automáticos hasta que estén.

## Los cinco planes

Precios **sin IVA**; al cobrar se suma el 21 % (`apps/api/src/billing/iva.ts`). Los netos son redondos (múltiplos de $ 5.000); el final con IVA queda a menos de un 2 % del de la lista de septiembre, salvo Estudio, que sube a propósito.

| Plan | Código | Para quién | Neto por mes | Con IVA | Comprobantes | Empresas | Usuarios | IA por día (total) |
|---|---|---|---|---|---|---|---|---|
| **Esencial** | `CONTABLE` | Contabilidad, IVA y comprobantes de una empresa, con documentos y auditoría | $ 50.000 | $ 60.500 | ilimitados | 1 | 2 | 330.000 tokens |
| **Gestión** | `GESTION` | Gestión integral: ventas, compras, stock y tesorería | $ 100.000 | $ 121.000 | ilimitados | 1 | 5 | 660.000 |
| **Estudio** | `ESTUDIO` | Estudio contable con cartera de empresas | $ 125.000 | $ 151.250 | ilimitados | 50 | 5 | 830.000 |
| **Empresa** | `EMPRESA_B1` | Empresa en crecimiento o con varias razones sociales: el sistema completo | $ 205.000 | $ 248.050 | ilimitados | 5 | 15 | 1.360.000 |
| **Empresa Plus** | `COMPLETO` | Todo Empresa con mayor capacidad y soporte prioritario | $ 370.000 | $ 447.700 | ilimitados | 20 | 50 | 2.460.000 |

- **Estudio** costaba menos que Gestión ($ 89.900) y es el plan que más soporte consume: ahora cuesta más.
- **Empresa** no incluía las funciones `analisis`, `inteligencia` e `integraciones` pero declaraba un tope de 10 integraciones: un tope sobre algo que el plan no tenía. Ahora trae todo lo que sabe hacer el sistema, y **Empresa Plus se distingue por volumen, usuarios y soporte, no por funciones.**
- **Todos los planes incluyen el asistente de IA** con un tope diario de tokens **total del contrato** (`plan_ai_quotas`, migraciones 0142 y 0144): lo comparten todas las empresas del estudio, así que lo que se usa en una se gasta para todas. Cada empresa puede declarar además uno propio, más chico, como límite extra. El presupuesto de IA de cada plan es el **15 % de su precio neto mensual**, al precio del peor caso (todo en salida, US$ 0,50 por millón de tokens) y con US$ 1 = $ 1.500; al ser total, no se divide por empresa. El cálculo está en `scripts/declarar-cupos-de-ia-por-plan.mjs`; si el dólar es otro se recalcula. Sin suscripción en el estudio rige el más bajo de los topes de plan, no «sin tope». Los **comprobantes son ilimitados** en todos los planes.
- **Documentos e integraciones son ilimitados en todos los planes** (2026-10-19): hoy no cambian el costo —la única integración es la importación manual y subir un documento sólo ocupa espacio—. Si con conectores automáticos pesaran, se vuelve a declarar un tope: es un cambio de datos. La función de integraciones está incluida en los cinco planes.
- **Estudio atiende hasta 50 empresas** (antes 20).
- Los topes miden y avisan: **no bloquean.**

## Qué módulos trae cada plan

| Módulo (pantallas) | Esencial | Gestión | Estudio | Empresa | Empresa Plus |
|---|:-:|:-:|:-:|:-:|:-:|
| Contabilidad (asientos, libros, estados, cierre de períodos) | ✔ | ✔ | ✔ | ✔ | ✔ |
| Fiscal (facturas y comprobantes, IVA) | ✔ | ✔ | ✔ | ✔ | ✔ |
| Clientes y proveedores · Documentos · Auditoría · Integraciones · ARCA | ✔ | ✔ | ✔ | ✔ | ✔ |
| Asistente de IA | ✔ | ✔ | ✔ | ✔ | ✔ |
| Ventas (presupuestos y pedidos) · Compras (pedidos, recepciones, órdenes de pago) | — | ✔ | — | ✔ | ✔ |
| Tesorería (caja, bancos, cheques) · Stock y bienes de uso · Productos y precios | — | ✔ | — | ✔ | ✔ |
| Analítica | — | — | ✔ | ✔ | ✔ |
| Sucursales · Proyectos · Comisiones · CRM | — | — | — | ✔ | ✔ |
| Análisis y decisiones · Consultas · Propuestas de IA | — | — | — | ✔ | ✔ |

**Cómo se comprueba** (`tests/integration/planes-y-modulos.test.ts`): lo declarado (funcionalidades y topes de cada plan), lo que hace la API (una empresa con cada plan: cada módulo incluido contesta y cada excluido contesta `FUERA_DEL_PLAN`, con rutas reales), que cada pantalla del menú esté atada a un dominio que la API corta, y que el asistente sólo conteste sobre los módulos del plan.

**Auditoría del 2026-10-20:** la consola ocultaba las pantallas que un plan no incluye, pero la API **no las cerraba** (los dominios de la 0105 eran los nombres de las pantallas, no los de las rutas): un cliente de Esencial podía usar por API Ventas, Compras, Tesorería, Stock, Sucursales, Proyectos y Comisiones. La migración 0147 agrega las rutas reales. Y el asistente contestaba sobre cualquier módulo si el rol de la persona lo permitía: ahora sólo sobre los del plan (`preguntasDelPlan`).

**Para decidir (comercial):** Esencial y Estudio no traen Tesorería, así que no concilian bancos ni llevan caja ni cheques; para quien «lleva los libros» la conciliación bancaria suele ser parte del trabajo. Si se quiere, es un cambio de datos (agregar `tesoreria` a esos planes).

## Reglas de gestión

- Prueba de 14 días, completa y sin tarjeta, con el plan elegido.
- Un precio nuevo se declara **con vigencia**; una vigencia nueva cierra la anterior. Lo acordado con quien ya está suscripto se **congela** al convertir (`importe_acordado`).
- Descuento anual (alrededor de un 15 %), aviso al 80 % del tope y actualización trimestral por índice: **a construir.**

## Advertencia: IVA

Un monotributista emite factura C y **no discrimina IVA**; si la condición del titular resulta ser monotributista (a confirmar con el contador), publicar «+ IVA» no es coherente con su régimen. Volver a precios finales es cambiar `INCLUYE_IMPUESTOS` y la lista en el script, sin tocar código.

## Qué falta construir

| Pieza | Estado |
|---|---|
| Tramos de comprobantes como un solo plan | A construir (hoy Empresa y Empresa Plus son dos planes) |
| Cobro de Estudio por empresa activa (base + adicional) | A construir; hoy es un precio fijo |
| Adicionales (más usuarios, comprobantes o IA) | A construir |
| Aviso al 80 % y al 100 % del tope, con la oferta de subir | A construir |
| Actualización por índice y prorrateo al cambiar de plan | A construir |
| Calibrar los precios contra los costos reales y el punto de equilibrio | Pendiente de los costos del titular |
