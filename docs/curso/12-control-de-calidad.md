# Fase 12 — Control de calidad (segunda pasada)

Revisión completa de todo lo producido en `docs/curso/` y de las
extensiones a `MANUAL-USUARIO-NEXO.md`, buscando específicamente lo que
pide el brief: funcionalidades inventadas, afirmaciones sin evidencia,
videos redundantes, dependencias mal ordenadas, conceptos introducidos
demasiado pronto, contradicciones entre documentos y con el código real.

| # | Problema | Evidencia | Impacto | Solución propuesta | ¿Requiere código? |
|---|---|---|---|---|---|
| 1 | "Primera venta" (journey, paso 13) conflating dos caminos reales distintos: subir documento directo (V09-V10) vs. ciclo comercial completo (V11, presupuesto→pedido→«Registrar la operación fiscal») | `04-journey-empresa-desde-cero.md` describe solo el primero; `02-auditoria-31-videos.md` describe el segundo como V11 | Bajo — ambos caminos son reales, pero el journey de un solo paso puede hacer pensar que solo existe uno | Aclarar en el journey que son dos entradas válidas a la misma etapa, con una nota de "cuál usar según el caso" | No |
| 2 | V03 (Pendientes, Nivel 1) puede mostrarle a un alumno nuevo un pendiente cuyo motivo cita un concepto todavía no enseñado (ej. "asiento sin aprobar") si la empresa demo ya tiene actividad | Guion de V03 (diagnóstico previo) usa ejemplos de puesta en marcha (`SIN_PLAN_DE_CUENTAS`, `SIN_EJERCICIO`) — correctos para Nivel 1 — pero no restringe explícitamente qué categorías mostrar | Medio — un pendiente mal elegido en la grabación real rompe la progresión pedagógica | Fijar en el guion de V03, como instrucción de grabación explícita, que la empresa demo usada para ese video **no** debe tener ningún asiento ni comprobante todavía | No |
| 3 | V21 (Diario/Mayor/Balance) puede sentirse redundante con V16 (que ya muestra el Mayor al aprobar) | `02-auditoria-31-videos.md`, filas V16 y V21 | Bajo — es capas distintas (evento puntual vs. lectura como herramienta), pero hay que decirlo en el guion de V21 | El guion de V21 debe abrir explícitamente diferenciándose: "en el video 16 vimos aparecer un asiento; acá aprendemos a leer los tres libros como herramienta, no como confirmación de un solo evento" | No |
| 4 | La categoría de verificación de V31 (capstone) podría leerse como "todo el video está verificado en producción" si alguien no lee la nota 4 de `02-auditoria-31-videos.md` | Tabla B, fila V31: 🟡 MIXTO con nota extensa | Medio — es exactamente el tipo de sobre-afirmación que la regla de veracidad del brief prohíbe | Ya mitigado con la nota explícita; reforzar en el guion de V31 mismo (no solo en la tabla de auditoría) cuando se escriba | No |
| 5 | El dataset demo (`09-dataset-demo.md`) inventa montos y fechas para operaciones que todavía no se ejecutaron en ningún ambiente, ni local ni de prueba | Tabla "Operaciones adicionales sugeridas" — son propuestas, no evidencia | Bajo — están explícitamente marcadas como "sugeridas", no como verificadas | Ninguna acción — ya está correctamente calificado como sugerencia, no como hecho | No |
| 6 | El manual extendido (`MANUAL-USUARIO-NEXO.md`, sección N) describe la bandeja de Pendientes con datos ya verificados (33 entidades, fecha del fix) pero no repite la salvedad de la nota 1 de `02-auditoria-31-videos.md` (el routing de las 18 nuevas está verificado por test/deploy, no por un clic humano en producción) | Comparación entre `MANUAL-USUARIO-NEXO.md` sección N y `02-auditoria-31-videos.md` nota 1 | Bajo-medio — no es una contradicción falsa (ambas afirmaciones son ciertas), pero el manual es más categórico de lo que la evidencia sostiene sobre el nivel de verificación | Agregar una frase de matiz en la sección N del manual la próxima vez que se edite: "verificado por test y desplegado; el clic en producción sobre las 18 entidades nuevas todavía no se registró específicamente" | No |
| 7 | Ningún video de los 31 enseña explícitamente "qué hacer si tu sesión expira a mitad de la grabación/uso" — el gap de manejo de 401 sigue sin corregir (auditoría integral, sesión anterior) | Memoria de la sesión previa: sesión expirada sin manejo global de 401, diagnosticado y no corregido | Medio — puede confundir a un alumno que deja la consola abierta mucho tiempo entre pasos de un video largo | Agregar una advertencia de producción en la sección "GRABACIÓN" de cada guion nuevo: "grabar en una sola sesión continua, sin pausas de más de 25-30 min, para evitar la expiración silenciosa" | No — es una nota operativa de grabación, no un cambio de producto |
| 8 | No hay ningún video que enseñe explícitamente los `HUECOS CRÍTICOS` del manual (recuperación de contraseña, códigos de MFA agotados) como parte del curso — solo están en el manual escrito | `06-no-grabar-todavia.md` los lista como "no grabar", pero eso es distinto de "no mencionar" | Bajo-medio — un curso que nunca menciona "esto no tiene solución desde la interfaz" puede dejar a alguien atascado sin saber que necesita soporte técnico | Agregar una frase breve en V01 o V07 ("si perdés tus códigos de recuperación, no hay forma de regenerarlos vos mismo — anotalo en dos lugares") en vez de un video dedicado | No |
| 9 | El plan de niveles (Fase 3) numera 32 asignaciones para 31 videos (V02 cuenta en dos niveles) — es correcto y está explicado, pero si alguien copia solo la tabla resumen sin el texto puede leerlo como un error de conteo | `03-orden-pedagogico.md`, tabla final | Bajo | Ya está aclarado en el propio archivo con una nota al pie — sin acción adicional | No |
| 10 | Ninguna funcionalidad inventada detectada | Revisión cruzada de los 31 videos y los 24 pasos del journey contra `MATRIZ-FUNCIONALIDADES-NEXO.md` y `consola.html` | — | Sin acción | No |

## Lo que esta pasada confirmó que está bien

- Ninguna afirmación de "verificado en producción" en los archivos nuevos
  corresponde a algo que solo tiene test — se revisó fila por fila contra
  la Sección 12 del diagnóstico previo y contra `MATRIZ-FUNCIONALIDADES-NEXO.md`.
- El orden de dependencias entre videos (columna "Depende de" en
  `02-auditoria-31-videos.md`) no tiene ningún ciclo ni ningún video que
  dependa de uno posterior en el número final.
- Ningún guion nuevo (V07, V08, V13, V25) usa datos, botones o rutas que
  no existan en `consola.html` — se verificaron los nombres de botón y
  pantalla contra el archivo real antes de escribirlos.
