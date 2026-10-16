# NEXO como servidor MCP (para usarlo desde el Claude de cada persona) — decisión diferida

**Estado: NO construido, a propósito.** Decisión del titular (2026-10-16): primero lanzar con el primer cliente; MCP se evalúa después, si hay pedido. Este documento guarda el análisis para no rehacerlo.

## 1 · Qué sería

NEXO expone un **servidor MCP remoto** (un «conector personalizado»). Cada persona lo agrega en su propia cuenta de Claude (claude.ai o Claude Desktop) y conversa **ahí**; el Claude de esa persona razona y redacta, con su plan. NEXO no paga llamadas a la API por ese camino.

Según la [ayuda de Anthropic](https://support.claude.com/en/articles/11175166-get-started-with-custom-connectors-using-remote-MCP) (consultada 2026-10-16, no verificada contra el producto): los conectores remotos están disponibles en Free (**un** conector), Pro, Max, Team y Enterprise; siguen en beta; el servidor tiene que ser **alcanzable desde internet** (Claude se conecta desde la nube de Anthropic, no desde la PC de la persona).

## 2 · Qué NO es

- **No reemplaza al asistente embebido** (`docs/ASISTENTE.md`). Con MCP la persona conversa en Claude, no en la pantalla de NEXO: no hay foto desde la consola, ni botón de confirmar, ni voz propia, ni el control de cifras.
- **No permite usar una suscripción de Claude para alimentar el chat de NEXO.** Anthropic prohíbe usar los tokens OAuth de planes Free/Pro/Max en otras herramientas (fuentes secundarias, con detalles contradictorios: [1](https://winbuzzer.com/2026/02/19/anthropic-bans-claude-subscription-oauth-in-third-party-apps-xcxwbn/), [2](https://aiengineerguide.com/til/anthropic-claude-subscription-oauth-legal/)). Un producto que se vende usa clave de API.

## 3 · Qué costaría construirlo

| Pieza | Por qué importa |
|---|---|
| **Servidor de autorización OAuth** con la identidad de NEXO (usuario, segundo factor, elección de empresa) | Es lo más grande: semanas, no horas. Sin esto no se sabe quién consulta ni de qué empresa |
| Endpoint público nuevo en el VPS | Superficie de ataque nueva: límites de uso, bitácora (`CONSULTAR_MCP`), revisión de seguridad, y que `servir-contra-pruebas` y los tests de aislamiento lo cubran |
| Las mismas herramientas del asistente (`preguntar_al_sistema`, `buscar_terceros`) con los permisos de la persona | Ya existen en `apps/api/src/asistente/herramientas.ts`: el trabajo es exponerlas, no reescribirlas |
| Salvedad en cada resultado (origen, metodología, «no incluye») | El control de cifras (ADR-017) **no corre**: el texto lo escribe el Claude de la persona, fuera de NEXO. Lo único que NEXO controla es lo que devuelve |
| Textos legales | Los datos salen a la cuenta de Claude de cada persona, bajo sus términos con Anthropic |

## 4 · Cómo hacerlo cuando llegue el momento

1. **Fase 1, sólo lectura:** consultas del catálogo y búsqueda de terceros. Ninguna escritura.
2. **Fase 2, propuestas:** una propuesta de alta se devuelve como **enlace a NEXO ya precargado**, para confirmar ahí (donde están el permiso, el segundo factor y la bitácora). Nunca una escritura directa desde el conector.
3. Antes de la fase 1: diseño del flujo OAuth y revisión de seguridad por escrito, y decidir si el conector se ofrece a todos o por empresa (mismo interruptor `assistant_settings` o uno propio).

## 5 · Cuándo conviene retomarlo

- Un cliente real lo pide, **o**
- ya se lanzó con el primer cliente y el asistente embebido está probado con la clave real, **y**
- hay tiempo para una revisión de seguridad sin apuro.

Lo que no conviene: hacerlo antes del lanzamiento. Abre una puerta nueva a internet y no destraba ninguno de los bloqueos del primer cliente (`docs/BLOQUEOS_PRIMER_CLIENTE.md`).
