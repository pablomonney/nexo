# UX — Criterios de Diseño

> §41 y §42. El sistema debe sentirse como software profesional de estudio contable. No como un
> chatbot con un balance adentro.

## 1. Postura

| Es | No es |
|----|-------|
| Un workspace con bandejas de trabajo, listas densas y atajos de teclado | Una conversación |
| La IA como *asistente dentro de una pantalla* | La IA como interfaz principal |
| El contador como decisor visible en cada registración | El sistema como autoridad |

Un contador procesa cientos de comprobantes por cierre. La unidad de trabajo es **la bandeja**, no
el mensaje. Todo lo que se pueda aprobar en lote, se aprueba en lote; todo lo dudoso se aísla.

## 2. Pantallas núcleo

1. **Bandeja de ingesta** — documentos por estado, con semáforo y filtros por confianza, proveedor,
   tipo y período.
2. **Revisión de comprobante** — documento a la izquierda, campos extraídos a la derecha, con el
   valor original visible junto al interpretado y su confianza por campo.
3. **Propuesta de asiento** — la pantalla del §41.
4. **Libro Diario / Mayor** — tabla densa, exportable, con navegación al comprobante en un clic.
5. **Conciliación bancaria** — dos columnas con matching propuesto y score.
6. **Estados contables** — cada cifra clickeable.
7. **Panel normativo** — reglas aplicadas en el período, con su nivel de verificación.
8. **Cierre** — checklist del §36 con estado en vivo.
9. **Dashboard** — indicadores del §40.

## 3. La pantalla que define el producto

```
┌───────────────────────────────────────────────────────────────┐
│ Factura A  0001-00045231        Proveedor S.A.  CUIT 30-…-1  │
├────────────────────────────┬──────────────────────────────────┤
│ [ vista del PDF original ] │ CLASIFICACIÓN PROPUESTA          │
│                            │                                  │
│                            │ 6.1.05 Gastos de mantenimiento   │
│                            │ 1.1.05 IVA Crédito Fiscal        │
│                            │ 2.1.01 Proveedores               │
│                            │                                  │
│                            │ ⚙ Sugerencia automática · 96%    │
│                            │                                  │
│                            │ Regla aplicada    [ver regla]    │
│                            │ Fuente normativa  [ver fuente]   │
│                            │ Validación fiscal   ✓ ARCA       │
│                            │ Validación contable ✓            │
│                            │ Validación económica — pendiente │
│                            │                                  │
│                            │ [ APROBAR ] [ MODIFICAR ] [ ✕ ]  │
└────────────────────────────┴──────────────────────────────────┘
```

Tres cosas que esta pantalla hace y que no son decorativas:

1. **Muestra el documento y la propuesta juntos.** El contador no debería tener que abrir el PDF
   en otra ventana para verificar.
2. **Separa los tres tipos de validación** (§11). Que ARCA confirme el CAE no significa que la
   operación económica sea real, y la interfaz no debe sugerir lo contrario.
3. **Etiqueta la sugerencia como sugerencia.** Sin eufemismos: "sugerencia automática", no
   "clasificación del sistema".

## 4. Semáforo

| | Significado | Acción disponible |
|---|---|---|
| 🟢 | Alta confianza | Aprobación individual o en lote |
| 🟡 | Requiere revisión | Aprobación individual, con el motivo del amarillo visible |
| 🔴 | Bloqueado | Sin aprobación hasta resolver. Se explica **qué** falta |

El rojo siempre dice por qué: *"No hay fuente normativa verificada para este tratamiento"* es
mejor que *"Error de clasificación"*. El estado 🔴 no es una falla del sistema, es el sistema
haciendo lo correcto (§52).

## 5. Trazabilidad como interacción

Toda cifra del sistema, en cualquier pantalla, expone la misma acción:

```
$ 1.284.500,00   ⌄  ¿de dónde salió este importe?
```

Se despliega la cadena: renglón → cuenta → mayor → asientos → comprobantes → documentos → normas.
Es una sola interacción y funciona igual en el balance, en una nota y en un anexo, porque debajo
es siempre el mismo recorrido de `lineage_edges`.

## 6. Regla de responsabilidad en la interfaz

- Todo contenido generado por IA lleva marca visible y persistente.
- Ninguna salida de IA se presenta como asesoramiento profesional.
- Toda emisión de estados contables identifica al profesional responsable.
- Cuando el sistema no sabe, lo dice con esas palabras: `NO HAY INFORMACIÓN SUFICIENTE`,
  `FUENTE NO ENCONTRADA`, `CONFLICTO NORMATIVO — REQUIERE REVISIÓN`. Sin sinónimos suaves.

## 7. Accesibilidad y oficio

- Componentes accesibles (Radix/shadcn), navegación completa por teclado, foco visible.
- Números tabulares alineados a la derecha; formato es-AR; negativos entre paréntesis según
  convención contable.
- Atajos para el flujo de aprobación masiva.
- Sin scroll infinito en listados contables: paginación y totales visibles siempre.
