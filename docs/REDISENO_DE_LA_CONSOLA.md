# Rediseño de la consola y de la página pública (2026-10-16)

Pedido del titular: que el sistema sea **más entendible y práctico**, con una **guía paso a paso** que explique adónde ir cada vez que se toca un botón, el **menú a la izquierda** (tipo hamburguesa) **ordenado de lo más importante a lo menos**, y **mucha más visualidad**: gráficos, esquemas e ilustraciones.

Todo vive en `apps/web/consola.html` y `apps/web/landing.html` (archivos únicos, sin recursos externos: la CSP no admite nada de afuera). No cambió ninguna ruta de la API ni ninguna regla de negocio.

## Qué cambió

| Qué | Dónde | Cómo se mantiene |
|---|---|---|
| **Barra lateral izquierda**, agrupada por tarea y ordenada por prioridad: General · Ventas · Compras · Tesorería · Inventario y operaciones · Contabilidad · Análisis · Administración | `<aside class="lateral">` y `const MENU` | Para agregar una pantalla: botón en el grupo correcto con `data-vista`, `data-nombre`, `data-desc` y `data-claves` (sinónimos de búsqueda), y su `<section id="v-…">` en `VISTAS`. |
| Hamburguesa (botón arriba a la izquierda): achica el menú a íconos en escritorio; en celular abre y cierra un cajón | `#b-menu` | La preferencia se recuerda por navegador (`nexo-menu`, `nexo-grupos`). |
| **Búsqueda**: filtro en el propio menú y paleta **Ctrl+K** con pantallas y acciones | `#buscar-menu`, `const PALETA` | Lee los botones del menú que `aplicarPermisosANav` dejó visibles: respeta rol y plan. |
| **Tarjeta «Cómo se usa esta pantalla»** en cada pantalla: para qué sirve, pasos con «Mostrame» y adónde ir después | `const GUIAS` | Ver «Cómo agregar o cambiar una guía». |
| **Recorrido guiado** con foco sobre los elementos reales (botón «Guía» de la cabecera) y **recorrido de bienvenida** (se ofrece una vez) | `const GUIA` | — |
| **«Siguiente paso»** debajo del aviso verde de una acción que salió bien, con un botón que lleva ahí | `const PROXIMOS` + `decir()` | Se muestra sólo cuando la acción pasó un texto de éxito (las lecturas no lo muestran). |
| **Tablero en Inicio**: cifras, ventas vs. compras, flujo bancario, anillo de «puesta en marcha», rankings, atajos y el esquema del circuito del comprobante | `<div id="tablero">`, `const TABLERO` | Usa los endpoints de Analítica. Un dato que no se pudo leer **esconde su panel**; no se dibuja como cero. |
| Ingreso con presencia de marca; ícono del menú en el título de cada pantalla; el texto técnico de cada pantalla quedó plegado en «Cómo funciona por dentro» | CSS + `#login-intro` | — |
| **Página pública** rediseñada: consola dibujada, esquema «cinco lugares → uno», circuito de seis pasos, tres vitrinas (documentos→asiento, conciliación bancaria, número→comprobante), planes en tarjetas | `landing.html` | Las ilustraciones llevan datos de ejemplo **abreviados** («4,8 M», «380 mil») y lo dicen en la imagen. |

## Reglas que se respetaron

- **Importes sin punto flotante.** El tablero convierte el texto decimal de la API a centavos enteros (`BigInt`) y vuelve a texto; `Number` sólo se usa para la geometría de un gráfico y los rótulos abreviados de un eje. El importe exacto está en el tooltip de cada barra.
- **Sin precios escritos en la landing** (S-34 y el control de `mvp-fronteras`). Por eso las cifras de las ilustraciones se escriben abreviadas y nunca con la forma de un precio de la lista.
- **Nada que el producto no sostenga.** «En qué estamos trabajando» sigue listando lo que no está (emisión de facturas, pago con tarjeta, asistente, sueldos).
- Ningún texto de guía pasa por `innerHTML`: se dibuja con `textContent`.

## Cómo agregar o cambiar una guía

1. En `const GUIAS` agregá la clave de la pantalla (el nombre de `data-vista`) con `que`, `pasos` (`t` = texto, `a` = selector `#id` del elemento que señala) y `despues` (`[vista, texto]`).
2. Si una acción termina con `decir('mi-msg', r, 'Texto de éxito')`, podés ofrecer el siguiente paso en `const PROXIMOS`.
3. Corré `npx vitest run tests/security/consola-guias.test.ts`: falla si una guía señala un `id` que no existe, si apunta a un elemento de **otra** pantalla, si un atajo lleva a una pantalla que no está en el menú, o si una pantalla del menú se queda sin guía.

## De la landing a contratar

- Cada tarjeta de plan de la landing tiene **«Elegir este plan»**, que lleva a `/consola?plan=<CODIGO>`. La consola lo valida con una forma fija y lo usa sólo si el catálogo (`GET /planes`) lo conoce: deja ese plan preseleccionado en «Crear mi empresa» y lo dice en la pantalla de ingreso. El botón se crea cuando llega `/planes`, por eso el modo presentación lo reescribe con `data-cta="plan"` (`ajustarBotones` se vuelve a llamar sobre las tarjetas).
- La sección **«Cómo pagás y cómo entrás a NEXO»** (`#pagar`) cuenta el camino real: prueba de 14 días sin tarjeta → «Plan» → «Convertir la prueba» → **pago por transferencia** (el pago con tarjeta sigue figurando en «lo que viene») → qué pasa si un pago no llega. Termina en «Crear mi cuenta y probar» y «Ya tengo cuenta: entrar a NEXO». Cuando haya pasarela habilitada, ese texto hay que actualizarlo: `tests/security/landing-elegir-plan.test.ts` lo vigila para que no prometa de más.
- **«Mis clientes»** (sólo la empresa propietaria): ver `docs/MONOTRIBUTO_Y_NEXO_PROPIETARIO.md`.

## Pendiente (decisión del titular)

- Mirar las capturas y decir qué ajustar (copy de las guías, colores, orden del menú).
- **Publicarlo**: los commits están en el repositorio pero el despliegue del sábado fija un commit anterior (`desplegar.sh --commit <sha>`). Para incluir el rediseño hay que elegir el commit nuevo, volver a correr la suite completa (también en UTC) y ensayar el despliegue.
