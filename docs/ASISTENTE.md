# El asistente conversacional (Claude Haiku 5.5)

**Estado: construido y probado contra un proveedor de mentira. NO conectado a Claude de verdad, NO desplegado. EN PAUSA POR DECISIÓN DEL TITULAR (2026-10-16): no se compra saldo de API todavía; se conecta más adelante.** Hace falta una credencial de Anthropic (con saldo; USD 5 es el mínimo) y una llamada real de punta a punta antes de decir «conectado» (§7).

**Para retomarlo, una sola orden:** `ASSISTANT_API_KEY=… npm run asistente:probar` hace las llamadas reales (texto, herramienta de ida y vuelta, imagen), muestra el costo medido contra el precio declarado y sale con error si algo falla (`scripts/probar-asistente.mjs`; sin clave no llama a nadie). Después, §8. Alternativa por MCP (el Claude de cada persona, sin API propia): `docs/MCP_FUTURO.md`, diferida.

Es un chat dentro de NEXO (pantalla **Asistente**): la persona escribe, manda una foto o un PDF, o le habla, y el asistente contesta con los datos de la empresa, explica cómo se hace algo y arma la carga de un cliente o proveedor.

## 1 · Qué hace y qué no

| Hace | No hace |
|---|---|
| Contesta cifras de la empresa **consultando el catálogo cerrado** de preguntas (`preguntar_al_sistema`) | No calcula, no suma, no proyecta: toda cifra sale de una herramienta |
| Busca clientes/proveedores ya cargados (`buscar_terceros`) | No da consejo fiscal ni dice qué conviene |
| Explica dónde está cada cosa y qué datos hacen falta (`ayuda_de_nexo`, texto fijo) | No cita normas de memoria |
| **Arma la propuesta** de alta de un tercero (`proponer_alta_de_tercero`) | **No guarda nada**: la persona confirma con un botón, que llama a `POST /parties` con su permiso y su bitácora |
| Lee una foto o un PDF que la persona adjunta | No guarda el archivo; no verifica lo que lee contra el sistema |

ADR-001 se cumple por estructura: `@aai/ai-engine` (el puerto, el bucle y el control) no importa base ni motores contables (`lint:arch`); las herramientas viven en `apps/api` y sólo leen o arman una propuesta.

## 2 · Las piezas

| Pieza | Dónde |
|---|---|
| Puerto `ProveedorDeChat`, bucle `conducirTurno`, control de cifras del texto | `packages/ai-engine/src/chat.ts`, `asistente.ts` |
| Prompt versionado `ASISTENTE_V1` (hash en `prompt_versions`) | `packages/ai-engine/src/prompts/registry.ts` |
| **El único archivo que conoce a Claude** (SDK oficial `@anthropic-ai/sdk`) | `apps/api/src/ai/chat-claude.ts` |
| Configuración y estados del proveedor | `apps/api/src/ai/asistente-proveedor.ts`, `config.ts` (`ASSISTANT_*`) |
| Herramientas (con los permisos de quien escribe) | `apps/api/src/asistente/herramientas.ts` |
| Rutas | `apps/api/src/routes/asistente.ts` |
| Tablas | migración **0136**: `assistant_settings`, `assistant_conversations`, `assistant_messages` |
| Pantalla | `apps/web/consola.html` (vista `asistente`) |

Rutas: `GET /asistente/estado`, `POST /asistente/configuracion`, `GET /asistente/conversaciones[/:id]`, `POST /asistente/mensajes` (JSON o multipart con archivos).

## 3 · Cómo se llama a Claude

- Modelo `claude-haiku-5-5` (configurable con `ASSISTANT_MODEL_ID`), US$ 0,10 por millón de tokens de entrada y US$ 0,50 por millón de salida (pedidos de hasta 100.000 tokens). El precio está declarado en `ai_pricing` por la 0136 y el costo de cada turno se **calcula** (`assistant_messages.costo_micros`); si el proveedor lo cambia, se declara otra fila con otra vigencia.
- Se manda sólo lo documentado: `model`, `max_tokens`, `system`, `messages`, `tools` y `output_config.effort` (`low` por defecto). **No** se manda `temperature`, `top_p`, `top_k`, `thinking` ni `tool_choice`: Haiku 5.5 rechaza con 400 lo que no es su valor por defecto. Dentro de un turno con herramientas, el contenido de cada respuesta del modelo vuelve **idéntico** (el razonamiento tiene que acompañar a su llamada).
- La credencial se resuelve **por llamada** (`SecretProvider`), nunca se loguea ni sale en un error. Un fallo del proveedor se informa con un **código** (`TIMEOUT`, `LIMITE_DE_TASA`, `CREDENCIAL_RECHAZADA`…), jamás con el texto del proveedor: puede traer el pedido, y el pedido lleva datos de la empresa.
- Un fallo del proveedor **no es un 500**: el turno termina `FALLO_DEL_PROVEEDOR`, el mensaje queda guardado y el resto de NEXO sigue igual.

## 4 · Los controles, y qué los prueba

| Promesa | Cómo se hace cumplir | Prueba |
|---|---|---|
| Apagado por defecto; cada empresa lo enciende, con motivo y bitácora | `assistant_settings` (sin fila = apagado); acción `CONFIGURAR_ASISTENTE` exige motivo | `asistente.test.ts` «apagado por defecto», «quién puede» |
| Sólo quien tiene `intelligence:ask`; sólo `analysis:configure` lo enciende | `requirePermission` | ídem |
| Las herramientas son las de la persona | `armarHerramientas(permisos)`: la que no le toca no existe para el modelo | «con los permisos de quien escribe» |
| Ninguna cifra inventada llega a la pantalla | `revisarTextoDelAsistente`: cada numeral de 3+ dígitos tiene que estar en lo que devolvió una herramienta, lo que escribió la persona o lo ya dicho; **una** corrección y si no, el texto se descarta entero | «una cifra inventada NO llega a la pantalla»; `asistente-turno.test.ts` |
| No escribe | La propuesta es un cuerpo de `POST /parties`; no hay camino del modelo a una escritura | «armar una propuesta NO crea el tercero» |
| No duplica ni acepta CUIT mal formado | Mismo módulo 11 y misma unicidad que el alta | «ya existe», «dígito verificador incorrecto» |
| Una conversación es de quien la abrió | Filtro `created_by`; ajena = 404 | «cada una es de quien la abrió» |
| Contado y auditado | `ai_answers` (cupo diario, métrica de alucinación) + `CONSULTAR_ASISTENTE` en bitácora **sin el contenido** | «contesta, guarda la conversación…» |
| Cupo | Mismo `evaluarCupo` que Preguntar: por empresa, **por día**, en preguntas y/o en **tokens** (declarados) + mensajes por minuto por usuario | «el cupo» |
| Los archivos no se guardan; se mira el contenido, no lo que dice el navegador | firma del archivo (JPG/PNG/GIF/WEBP/PDF), ≤ 5 MB, ≤ 3 por mensaje; en la base sólo nombre, tipo, tamaño y sha256 | «archivos adjuntos» |

**Mutaciones:** 9 mutantes sobre estos guardas (apagado, dueño de la conversación, cupo, control de cifras, relajo con adjunto, texto rechazado, firma de archivo, duplicado, permiso de la herramienta) — **9 detectados**. Uno sobrevivió al principio (el permiso `party:write` de la herramienta) y se cerró con una prueba.

## 5 · Decisiones que no son obvias (y sus costos)

1. **Con un archivo adjunto el control de cifras se relaja.** Una cifra que el modelo lee de una foto no está en ninguna herramienta: exigirlo rechazaría toda lectura de una factura. Se compensa con: la respuesta sale marcada (`lecturaDeArchivoSinVerificar`) y la pantalla lo dice, el prompt le exige decir «leí en la imagen…», y todo alta pasa por los mismos validadores que el alta manual (un CUIT mal leído no pasa el módulo 11) **y** por la confirmación de una persona. Es una decisión de producto: si no se quiere, se cambia en una línea (`revisarTexto` en `routes/asistente.ts`) y las lecturas de fotos pasan a rechazarse.
2. **El consejo fiscal lo ataja el prompt, no el código.** El filtro `fueraDeAlcance` del catálogo (palabras como «qué hago» o «ganancias») rechazaría preguntas legítimas en un chat («¿qué hago para cargar un proveedor?»), así que no se aplica al mensaje entero. Lo que sí es mecánico es que ninguna cifra salga de la cabeza del modelo.
3. **El historial viaja como texto.** Una foto sólo la ve el modelo en el turno en que se manda; en el siguiente ya no está (se guardan sus metadatos). Si la persona vuelve a preguntar por ella, hay que volver a adjuntarla.
4. **El asistente tiene su propia configuración** (`ASSISTANT_*`), separada de `AI_PROVIDER`: conectar el chat no enciende ni apaga los agentes de clasificación y redacción.
5. **La conversación se guarda** (texto de la persona y del asistente) en `assistant_messages`, bajo RLS, sin edición ni borrado. Es lo que permite responder «¿qué le dijo el asistente a quién?». Implica datos personales de terceros dentro de esos textos: ver la política de privacidad (borrador).

## 6 · Foto, archivos y voz

- **Foto / archivo:** botones **Foto** (abre la cámara del celular, `capture`) y **Archivo** (imagen o PDF). La consola **reduce la imagen** a 1600 px de lado mayor en JPEG antes de mandarla: una foto de celular pesa 5–12 MB y el tope es 5 MB. Un PDF no se reduce. Casilla opcional «También guardar los archivos en Documentos» los sube al circuito de siempre (`POST /documents`: OCR y revisión) **sólo si la persona lo tilda** y tiene `document:upload`.
- **Voz:** botón **Hablar** (dictado) y «Leer las respuestas en voz alta» / «Modo conversación por voz» (escucha → envía → contesta en voz alta → vuelve a escuchar). Lo hace **el navegador** (Web Speech): NEXO no recibe audio. En Chrome y Edge el reconocimiento lo resuelve un servicio del fabricante del navegador, así que el audio sale hacia ese servicio; la pantalla lo dice. En un navegador sin soporte, el botón no aparece.
- **No hecho:** subir un **audio grabado** (nota de voz) para que el asistente lo transcriba. Claude no recibe audio; haría falta un servicio de transcripción (otro tercero que recibe datos). Es una decisión del titular (contratar), no un faltante técnico.

## 7 · Qué NO está verificado

- **Ninguna llamada real a Claude.** Las pruebas ejecutan el adaptador real (SDK oficial) contra un `fetch` y un servidor HTTP que hablan la forma documentada de la API (`tests/unit/chat-claude.test.ts`) y la ruta contra un proveedor guionado (`tests/integration/asistente.test.ts`). Se miró la pantalla de punta a punta en el navegador integrado contra un Claude falso local (encender, preguntar, propuesta de alta con confirmación, foto reducida y enviada). Lo que sólo se sabe con la cuenta real: que la clave sea válida, que Haiku 5.5 acepte exactamente estos parámetros, que lea bien una factura fotografiada y el costo real por turno.
- **El dictado y la lectura en voz alta** dependen del navegador: se verificó que los controles aparecen y no rompen; no se probó con un micrófono.
- **Captura de pantalla:** la ventana del navegador integrado estaba oculta y las capturas expiraron; la verificación fue por el DOM, la red y medidas de layout (sin desborde horizontal a 375 px).

## 8 · Conectarlo (cuando haya credencial)

0. Cargar saldo en la consola de Anthropic (créditos prepagos, mínimo USD 5, vencen al año): con USD 5 alcanza para decenas de miles de turnos al precio declarado. Lo hace el titular.
1. Crear la clave en la consola de Anthropic **sin pegarla en el chat ni en un archivo del repo**. Ponerla en el `.env` del servidor (`ASSISTANT_API_KEY=…`) o en el gestor de secretos (`ASSISTANT_API_KEY_REF=kms:<arn>`).
2. En el servidor: `ASSISTANT_PROVIDER=anthropic` y reiniciar. El arranque informa «preparado» si falta la clave.
3. El prompt `ASISTENTE_V1` ya queda archivado por la migración 0136 (el despliegue no corre `prompts:register`; sin esa fila `ai_answers` rechazaría el turno y el cupo no contaría). `asistente.test.ts` comprueba que el texto archivado es idéntico al del código.
4. `npm run asistente:probar` (llamada real: texto, herramienta, imagen) y, **una vez que pase**, una prueba de punta a punta por la pantalla con una empresa de prueba: encender el asistente, preguntar algo del catálogo, mandar una foto de una factura; comparar el costo calculado con el de la consola de Anthropic.
5. Recién ahí se enciende para un cliente real (con su aviso en la política de privacidad y en los términos, que hoy son borradores).
6. Declarar el **cupo diario** por empresa (`POST /intelligence/quota`): sin él no hay tope de gasto. Conviene el de **tokens** (`tokensPorDia`), que es el que sigue la plata; ver §8b.

## 8b · Cupo de tokens por día (migración 0141)

Como el de Claude, pero **por día**: cuántos tokens (entrada + salida) puede consumir el asistente en un día. El tope del plan es **total del contrato**: lo comparten todas las empresas del estudio (0144), y lo que se usa en una se gasta para todas. Cada empresa puede declarar además uno propio, más chico.

- **Se declara** con `POST /intelligence/quota` (`{ tokensPorDia, llamadasPorDia?, motivo }`, permiso `analysis:configure`) o desde la consola, en «Declarar el cupo». Cada declaración dice la política **entera**: lo que no se manda queda sin tope; hace falta al menos uno.
- **Se cuenta** de `assistant_messages` (los tokens que ya guarda cada turno), no de un contador aparte (ADR-022): por empresa, desde el comienzo del día en la zona de la base.
- **Corte:** antes de cada turno se compara lo ya consumido con el tope; si lo alcanzó, **429 `CUPO_DE_TOKENS_AGOTADO`** sin llamar al modelo. Los tokens de un turno se conocen después de la llamada, así que **el turno que cruza el tope se completa y el siguiente se corta** (se puede pasar por un turno, no más).
- **Sin tope declarado no se corta** (no es cero ni «ilimitado por diseño»). Un tope de 0 apaga el asistente para esa empresa.
- **Lo ve** el estado del asistente (`cupo.tokensDelEstudioHoy` y `topeDelPlanTokens` para el total del estudio; `tokensUsadosHoy` y `topeTokensPorDia` para la empresa) y «Ver el consumo» en la consola. Cada plan publica su tope en `/planes` (`tokensDeIaPorDia`), y la landing y la consola lo muestran.
- **Todos los planes incluyen el asistente (migración 0142).** Es una funcionalidad del catálogo (`asistente`), incluida en los cinco planes por decisión del titular (2026-10-19); la mora y la suspensión lo cortan como a cualquier módulo que no sostiene una obligación con plazo. Antes de la 0142 el dominio no estaba en el catálogo y la puerta comercial, que falla abierta, lo dejaba pasar a cualquier empresa **sin ningún tope de gasto**.
- **Tope por plan** (`plan_ai_quotas`, 0142; lo declara `scripts/declarar-cupos-de-ia-por-plan.mjs`): es **total del contrato** y lo mide `consumo_de_ia_del_estudio()` (0144), que suma lo que gastaron todas las empresas del estudio hoy. Valores (decisión del titular, 2026-10-19/20: el presupuesto de IA es el **15 % del precio neto mensual**, al precio del peor caso —todo en salida, US$ 0,50 por millón— con US$ 1 = $ 1.500): Esencial 330.000, Gestión 660.000, Estudio 830.000, Empresa 1.360.000, Empresa Plus 2.460.000 tokens por día **en total**. La suscripción que rige es la más reciente vigente de cualquier empresa del estudio; sin ninguna, rige el más bajo de los topes de plan, no «sin tope». El tope propio de la empresa (`ai_quotas`) es un límite **extra**: no levanta el del plan.
- **No cubre** una ventana por hora (se decidió «por día»): el tope por minuto por usuario sigue protegiendo del bucle. Si hiciera falta por hora, es el mismo conteo con otra ventana.

## 9 · Qué falta

- Llamada real (§7) y, con ella, ajustar el prompt a lo que Haiku haga mal en la práctica.
- Subir una nota de voz grabada (decisión de contratar transcripción).
- Más herramientas de «ayudar a ingresar información»: hoy sólo terceros. Productos, comprobantes y la importación de planillas (`migraciones`) son los siguientes; cada una se agrega como herramienta que **propone**, con su validación y su botón, nunca como escritura directa.
- Streaming de la respuesta (hoy llega completa).
- Bitácora de retención: cuánto tiempo se guardan las conversaciones es una decisión pendiente (hoy: indefinido).
