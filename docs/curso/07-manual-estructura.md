# Fase 7 — Manual de usuario: estructura y avance real

`docs/MANUAL-USUARIO-NEXO.md` es el manual oficial y ya sigue casi toda
la forma pedida (secciones A-M, con nombres reales de botones, rutas y
mensajes — no instrucciones genéricas). Esta sesión lo **extendió
directamente**, no lo reescribió:

## Lo que se agregó de verdad (ya está en el archivo, sin commitear)

1. **`## Conceptos básicos, en criollo`** — antes de la sección A. Sin
   número: el manual ya usa "0" para «El mapa de NEXO» y no convenía
   colisionar con eso.
   Explica ejercicio, período, cuenta imputable, mapeo contable,
   comprobante, asiento, Debe/Haber y Mayor en ocho párrafos cortos,
   exactamente lo que pedía el brief ("no asumas conocimiento contable").
2. **`## N · La bandeja de Pendientes`** — sección nueva completa, con
   las 13 subsecciones pedidas (qué es, para qué sirve, cuándo usarla,
   antes de empezar, paso a paso, qué debería aparecer, resultado
   esperado, estados posibles, errores frecuentes, cómo resolverlos,
   permisos, dependencias, ejemplo práctico).
3. Se agregó el hueco #15 (plan de cuentas sin auto-cargar) a la tabla de
   "Huecos encontrados al escribir este manual", con link a la
   investigación completa (`05-gap-plan-de-cuentas.md`).
4. Se agregó un link cruzado a este proyecto de curso.

## Estructura completa propuesta (24 capítulos)

La numeración de letras del manual real (A-N) no alcanza para los 24
capítulos que el curso completo necesita — quedan **9 módulos sin
capítulo propio todavía** en el manual oficial, aunque sí tienen fila en
`K · Los demás módulos` (la tabla resumen, 19 filas). Están listados abajo con
`[resumen en K]` para que quede claro qué es "sin documentar" y qué es
"documentado en forma de tabla, sin el desarrollo completo de 13 puntos".

| Cap. | Título | Estado real hoy |
|---|---|---|
| 0 | Conceptos básicos | **Escrito esta sesión** |
| A | Primer ingreso | Ya existía, completo |
| B | Configuración inicial de una empresa | Ya existía, completo |
| C | Plan de cuentas | Ya existía, completo |
| D | Terceros | Ya existía, completo |
| E | Productos | Ya existía, completo |
| F | Documentos | Ya existía, completo |
| G | Comprobantes y operaciones | Ya existía, completo |
| H | Mapeo contable | Ya existía, completo |
| I | Asientos | Ya existía, completo |
| J | Mayor, libros y consultas | Ya existía, completo |
| K | *(tabla resumen de 19 módulos)* | Ya existía — ver desglose abajo |
| L | ARCA y fiscal | Ya existía, completo |
| M | Si aparece X, hacé Y (troubleshooting) | Ya existía, completo |
| N | La bandeja de Pendientes | **Escrito esta sesión** |
| — | Comercial (ventas) | `[resumen en K]` — falta desarrollo de 13 puntos |
| — | Compras (solicitud→recepción→pago) | `[resumen en K]` — ídem |
| — | Caja, bancos, cheques | `[resumen en K]` — ídem |
| — | Existencias | `[resumen en K]` — ídem |
| — | Bienes de uso | `[resumen en K]` — ídem |
| — | Períodos, cierre y ejercicio | Cubierto parcialmente en B; falta el detalle de bloquear/cerrar/reabrir/pre-cierre como capítulo propio |
| — | IVA | `[resumen en K]` — ídem |
| — | Inteligencia (Preguntar/Señales) | `[resumen en K]` — ídem |
| — | Administración (usuarios, migraciones, auditoría, plan) | Parcial — usuarios está en B.2, el resto en K |

## Por qué no se escribieron los 9 capítulos completos esta sesión

Cada capítulo completo, con las 13 subsecciones pedidas, tiene el mismo
volumen que la sección N que sí se escribió (~700 palabras). Nueve
capítulos más son ~6.300 palabras de contenido nuevo, con su propio
riesgo de introducir un botón o una ruta que no coincida exactamente con
`consola.html` si se escribe sin volver a verificar cada uno contra la
pantalla real — que es precisamente el estándar de calidad que ya tiene
el resto del manual ("si acá dice apretá X, X existe con ese nombre").

Se prioriza mostrarlos hechos **con precisión** antes que completos y
parcialmente inventados. Quedan como próximo paso explícito en el master
plan, no como trabajo abandonado.
