# Planes y precios de NEXO

**Decididos el 2026-10-19 por el titular.** La fuente de verdad de los números es `scripts/sembrar-comercial-b1.mjs` (con vigencia y motivo); este documento explica el criterio.

## El criterio

1. **Se separa por quién compra, no por tamaño.** Cuatro clientes: el que lleva sus libros, la pyme que opera, el estudio contable y la empresa grande.
2. **Una sola medida que crece con el negocio del cliente:** comprobantes por mes (empresas) o empresas atendidas (estudios).
3. **Las funciones separan planes sólo cuando le importan a un tipo de cliente.** Sucursales, proyectos y comisiones no le sirven a quien sólo lleva libros.
4. **Lo que de verdad cuesta es el soporte**, no los datos ni la IA (el costo variable por cliente es casi cero). Por eso Empresa Plus incluye soporte prioritario y los topes de comprobantes y de IA son generosos.
5. **El precio por comprobante baja al subir de plan:** hay una razón clara para pasar al siguiente cuando el negocio crece.
6. **Se vende sólo lo que existe.** Nada de lectura de PDF ni de conectores automáticos hasta que estén.

## Los cinco planes

Precios **sin IVA**; al cobrar se suma el 21 % (`apps/api/src/billing/iva.ts`). Los netos son redondos (múltiplos de $ 5.000); el final con IVA queda a menos de un 2 % del de la lista de septiembre, salvo Estudio, que sube a propósito.

| Plan | Código | Para quién | Neto por mes | Con IVA | Comprobantes por mes | Empresas | Usuarios | IA por día |
|---|---|---|---|---|---|---|---|---|
| **Esencial** | `CONTABLE` | Libros al día: contabilidad, IVA, documentos, auditoría | $ 50.000 | $ 60.500 | 1.000 | 1 | 2 | 330.000 tokens |
| **Gestión** | `GESTION` | Pyme que vende, compra y maneja stock y caja | $ 100.000 | $ 121.000 | 5.000 | 1 | 5 | 660.000 |
| **Estudio** | `ESTUDIO` | Contador con cartera de empresas | $ 125.000 | $ 151.250 | 5.000 | 50 | 5 | 16.000 por empresa |
| **Empresa** | `EMPRESA_B1` | Pyme grande o varias empresas: el sistema completo | $ 205.000 | $ 248.050 | 25.000 | 5 | 15 | 270.000 por empresa |
| **Empresa Plus** | `COMPLETO` | Lo mismo, con más volumen, usuarios y soporte prioritario | $ 370.000 | $ 447.700 | 100.000 | 20 | 50 | 120.000 por empresa |

- **Estudio** costaba menos que Gestión ($ 89.900) y es el plan que más soporte consume: ahora cuesta más.
- **Empresa** no incluía las funciones `analisis`, `inteligencia` e `integraciones` pero declaraba un tope de 10 integraciones: un tope sobre algo que el plan no tenía. Ahora trae todo lo que sabe hacer el sistema, y **Empresa Plus se distingue por volumen, usuarios y soporte, no por funciones.**
- **Todos los planes incluyen el asistente de IA** con un tope diario de tokens **por empresa** (`plan_ai_quotas`, migración 0142); la empresa puede declarar uno propio y ese gana. El presupuesto de IA de cada plan es el **15 % de su precio neto mensual**, al precio del peor caso (todo en salida, US$ 0,50 por millón de tokens) y con US$ 1 = $ 1.500; en los planes multiempresa se reparte entre las empresas del plan (por eso 16.000 por empresa en Estudio, que atiende hasta 50). El cálculo está en `scripts/declarar-cupos-de-ia-por-plan.mjs`; si el dólar es otro se recalcula. Una empresa sin suscripción propia ni tope propio hereda el más bajo de los topes de plan, no «sin tope».
- **Documentos e integraciones son ilimitados en todos los planes** (2026-10-19): hoy no cambian el costo —la única integración es la importación manual y subir un documento sólo ocupa espacio—. Si con conectores automáticos pesaran, se vuelve a declarar un tope: es un cambio de datos. La función de integraciones está incluida en los cinco planes.
- **Estudio atiende hasta 50 empresas** (antes 20).
- Los topes miden y avisan: **no bloquean.**

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
