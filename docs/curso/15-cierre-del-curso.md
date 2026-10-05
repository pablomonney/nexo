# Fase 15 — Cierre definitivo y auditoría de calidad del curso

Auditoría de cierre, 2026-09-30. Contrasta `10-master-plan.md`,
`13-estructura-definitiva.md`, `14-guiones-definitivos.md`, el dataset
(`09-dataset-demo.md`), la evidencia real de producción (capturas, audio,
video ensamblado) y el código de la aplicación entre sí. No se modificó
código ni datos de producción en esta auditoría — solo documentación,
donde la inconsistencia era segura de corregir.

**Corrección de terminología (2026-09-30, misma fecha, segunda pasada):**
este archivo usa `PRODUCIDO`/`VERIFICADO` como los venía usando el informe
original. La nomenclatura oficial, de acá en adelante, es la de
[`16-matriz-de-produccion.md`](16-matriz-de-produccion.md):
`VIDEO_FINAL` (lo que acá se llamaba `PRODUCIDO`), `GUION_VERIFICADO` (lo
que acá se llamaba `VERIFICADO`), `SALTADO_NO_PRODUCIDO` y
`EVIDENCIA_INSUFICIENTE`. El contenido y los números de este archivo
siguen siendo correctos — es el mismo veredicto (3/25/3) — pero el
**checklist operativo para producir los 25 videos pendientes está en
`16`, no acá**; este archivo queda como el informe de auditoría que le
dio origen.

---

## A. Veredicto de cierre

**El curso NO puede cerrarse todavía como serie de 31 videos terminados.
SÍ puede cerrarse la capa de guion, verificación y documentación.**

Son dos cosas distintas y el estado informado al inicio de esta auditoría
las mezclaba bajo una sola palabra, "grabados/verificados", que no es
precisa. Con evidencia real revisada (carpetas de producción, archivos de
audio, video final ensamblado):

- **Solo 3 de 31 videos** (01, 02, 03) existen como **archivo de video
  final** — con narración (audio generado) y ensamblado (clips + título +
  MASTER `.mp4`).
- **25 de 31 videos** (04–18, 20–22, 24–26, 28–31, excluidos los 3
  saltados) tienen **guion verificado contra la aplicación real** —
  bugs reales encontrados y corregidos donde correspondía, datos
  confirmados, flujos ejecutados de verdad — pero **no tienen narración
  ni video final**. Son guiones listos para grabar, no videos grabados.
- **3 de 31 videos** (19, 23, 27) están **deliberadamente saltados**, con
  motivo real documentado.

Como capa de documentación y guion, el curso **sí está cerrado**: los 31
guiones son internamente consistentes entre `13` y `14` (31/31 títulos
coinciden literalmente), no quedan afirmaciones no verificables sin
marcar, y las tres discrepancias reales de la aplicación que bloqueaban
producción (19, 23, 27) están documentadas con motivo concreto y sin
workaround fabricado.

Lo que bloquea el cierre como *curso terminado y publicable* está en la
sección I (Bloqueantes) — el principal es, precisamente, que falta
ensamblar 25 videos.

---

## B. Matriz 31 videos

Leyenda de **Estado**: `PRODUCIDO` = existe archivo de video final con
narración. `VERIFICADO` = guion confirmado contra la app real (código,
API o pantalla), con evidencia documentada, sin video final todavía.
`SALTADO — NO PRODUCIDO` = excluido a propósito, con motivo real.
`EVIDENCIA INSUFICIENTE` = no hay registro suficiente para afirmar nada
de lo anterior.

| # | Título (13 y 14 coinciden) | Estado | Evidencia | Coherencia con app | Problemas | Acción |
|---|---|---|---|---|---|---|
| 01 | Crear tu cuenta | PRODUCIDO + VERIFICADO | 3 GIF, audio, `video01-nexo-desde-cero.mp4` | Sí — cuenta real creada, correo de confirmación real leído | Ninguno | Ninguna |
| 02 | Crear una empresa | PRODUCIDO + VERIFICADO | 4 GIF, audio, `video02-nexo-desde-cero.mp4` | Sí — MFA, 185 cuentas, ejercicio, conversión de plan, todo verificado en vivo | Video más denso del curso (ver §F) | Evaluar separar el segmento de plan de suscripción |
| 03 | Pendientes | PRODUCIDO + VERIFICADO | 0 GIF en capturas (evidencia consolidada en el video final), audio, `video03-nexo-desde-cero.mp4` | Sí — bandeja de 8 pendientes real verificada | Ninguno | Ninguna |
| 04 | Mapeo contable | VERIFICADO (evidencia parcial) | Fix real confirmado en el diff (`MERCADERIA`/`COSTO_DE_VENTAS` agregados), **sin GIF ni confirmación explícita de haber declarado los 8 roles en vivo** | Código sí, ejecución en vivo no documentada | Evidencia de ejecución débil | Grabar/ejecutar en vivo y dejar constancia antes de dar por cerrado |
| 05 | Terceros | **EVIDENCIA INSUFICIENTE** | Ninguna — sin GIF, sin nota de corrección, sin confirmación de ejecución | No verificable con lo disponible | Único video sin ningún rastro de verificación | Ejecutar contra la app real antes de producir |
| 06 | Productos | VERIFICADO | 5 GIF | Sí — error de datos propio detectado y corregido en vivo | Fila residual de existencia archivada (documentado, no se toca) | Ninguna |
| 07 | Usuarios y permisos | VERIFICADO | 1 GIF, 2 cambios reales de código (backend `organization_members`, botón nuevo) | Sí | Cuenta de producción quedó con ambos roles (ADMINISTRADOR+CONTADOR), ver §F | Grabar con cuenta limpia, no la de producción ya usada |
| 08 | Certificado ARCA | VERIFICADO | 1 GIF | Sí | Ninguno | Ninguna |
| 09 | Documentos | VERIFICADO | 1 GIF, fix real + 8/8 tests de integración citados | Sí | Ninguno | Ninguna |
| 10 | Comprobantes | VERIFICADO | 1 GIF | Sí | Ninguno | Ninguna |
| 11 | Ventas | VERIFICADO | 1 GIF | Sí | Ninguno | Ninguna |
| 12 | Compras | VERIFICADO | 4 GIF, 3 bugs reales corregidos, 14/14 y 10/10 tests citados | Sí | Ninguno | Ninguna |
| 13 | Caja, bancos y cheques | VERIFICADO | 2 GIF | Sí — guion corregido contra `consola.html` antes de grabar | Ninguno | Ninguna |
| 14 | Existencias | VERIFICADO | 2 GIF | Sí — error de producción propio (paso salteado) detectado y corregido | Ninguno | Ninguna |
| 15 | Asientos | VERIFICADO | 1 GIF | Sí | Ninguno | Ninguna |
| 16 | Asientos manuales y contraasientos | VERIFICADO | 2 GIF, bug real corregido (tercero en asiento manual) | Sí — circuito de imputación completo verificado | Ninguno | Ninguna |
| 17 | Períodos y cierre de ejercicio | VERIFICADO (parcial) | Sin GIF (panel de navegador congelado); cierre real ejecutado vía API con IDs verificables | Sí, para el tramo de cierre | **Falta el tramo "bloquear período → reabrir con contrafirma"**: no quedaba ningún período ABIERTO para filmarlo (ver §F) | Grabar ese tramo puntual en una empresa/ejercicio distinto, con un período todavía abierto |
| 18 | Bienes de uso | VERIFICADO | 2 GIF, bug real corregido (aviso de baja) y verificado con bien de prueba BU-99 | Sí | Bug menor no bloqueante sin corregir (columnas Acumulada/Valor residual) — ya tiene tarea de fondo abierta | Ninguna adicional |
| 19 | Costo de lo vendido y valuación de existencias | **SALTADO — NO PRODUCIDO** | Método de valuación declarado y verificado; CMV no se pudo probar | — | Ver §C | Fuera de alcance de este cierre |
| 20 | Diario y Mayor | VERIFICADO | 1 GIF, bug real corregido (selector de cuenta en Mayor) | Sí | Ninguno | Ninguna |
| 21 | Balance | VERIFICADO | 1 GIF | Sí | Ninguno | Ninguna |
| 22 | Subdiarios de IVA | VERIFICADO | 1 GIF | Sí | Ninguno | Ninguna |
| 23 | Estados contables | **SALTADO — NO PRODUCIDO** | Formulario de marco de reporte agregado y verificado; "Armar el estado" no se pudo probar | — | Ver §C | Fuera de alcance de este cierre |
| 24 | Auditoría y exportaciones | VERIFICADO | 1 GIF | Sí | Ninguno | Ninguna |
| 25 | Preguntar: Panorama y riesgos | VERIFICADO | 1 GIF | Sí | Ninguno | Ninguna |
| 26 | Señales y escenarios | VERIFICADO | 1 GIF, acción real ejecutada (lista de precios LISTA-2026-10) para no citar un acto inexistente | Sí | Ninguno | Ninguna |
| 27 | Propuestas de IA | **SALTADO — NO PRODUCIDO** | Confirmado vía API real: `IA_DESHABILITADA`, cero propuestas generables | — | Ver §C | Fuera de alcance de este cierre |
| 28 | Proyectos, sucursales y comisiones | VERIFICADO | Sin GIF (panel congelado); bug real corregido (centro de costo en asiento manual), verificado con asientos reales ($80.000/$50.000 → margen $30.000) | Sí | Ninguno | Ninguna |
| 29 | Integraciones y migración | VERIFICADO | Sin GIF (panel congelado); migración real de 2 terceros, validación con CUIT reales, reversión verificada vía API | Sí | Ninguno | Ninguna |
| 30 | Plan y suscripción | VERIFICADO | 1 GIF, conversión de plan real ejecutada (GESTIÓN→COMPLETO) y verificada | Sí | Ninguno | Ninguna |
| 31 | Circuito completo: de un documento a un balance | VERIFICADO | Sin GIF (panel congelado); circuito documento→Balance verificado íntegro vía API, balance cuadra | Sí | Ninguno | Ninguna |

**31/31 títulos coinciden exactamente** entre `13-estructura-definitiva.md`
§5 y los encabezados `## NN ·` de `14-guiones-definitivos.md` — no se
encontró ninguna divergencia de título.

---

## C. Videos saltados

### Video 19 — Costo de lo vendido y valuación de existencias

**Motivo:** las entradas de stock ya cargadas para los tres productos del
dataset (PROD-001, PROD-002 y el `TOR-001` archivado) nunca declararon
`costoUnitario` al entrar, y el diseño del sistema no revalúa movimientos
anteriores. **Dependencia faltante:** un producto nuevo cuya primera
entrada de stock se declare con costo desde el inicio. **Por qué no
corresponde fabricarlo:** hacerlo ahora, solo para el video, sería
inventar un dato contable que no ocurrió — exactamente lo que la
auditoría pidió no hacer. **Qué debería existir para producirlo:** un
producto del dataset (nuevo o agregado) cuya primera recepción de compra
o ajuste de recuento incluya el costo unitario real desde el primer
movimiento.

### Video 23 — Estados contables

**Motivo:** el único alcance de plantilla de estado contable sembrado en
todo el sistema es `marco: RT_FACPCE, tipoEnte: SA, regulador: IGJ`
(Sociedad Anónima / IGJ). La empresa del curso es una S.R.L., y no existe
ninguna plantilla para ese tipo de ente. **Dependencia faltante:** una
plantilla de estado contable para S.R.L., o un cambio de tipo de ente de
la empresa del curso. **Por qué no corresponde fabricarlo:** no hay
ningún endpoint en la aplicación para cargar una plantilla nueva — solo
un script de siembra que transcribe a mano el articulado real de la Ley
19.550; escribir esa plantilla sin ese trabajo profesional sería
inventar contenido normativo. **Qué debería existir para producirlo:**
una plantilla nueva sembrada con el mismo rigor (transcripción real de
la norma aplicable a S.R.L.), o una decisión de producto de cambiar el
tipo de ente de la empresa de demostración a S.A.

### Video 27 — Propuestas de IA

**Motivo:** este entorno de desarrollo no tiene ningún proveedor de IA
configurado (`IA_DESHABILITADA`, confirmado contra `POST
/documents/:id/classify` en vivo) — no hay con qué generar ni una sola
propuesta de clasificación, ni siquiera de baja confianza.
**Dependencia faltante:** un proveedor de IA real (OpenAI/Anthropic/etc.)
configurado con credenciales propias. **Por qué no corresponde
fabricarlo:** insertar una propuesta a mano directamente en la base
sería fabricar evidencia — el video existe para mostrar que el motor
genera la propuesta, no para simular que la generó. **Qué debería
existir para producirlo:** contratar/configurar un proveedor de IA real
en el entorno de grabación, con su costo correspondiente, decisión que
le compete al productor del curso.

Los tres permanecen explícitamente `SALTADO — NO PRODUCIDO` en
`14-guiones-definitivos.md` (marcador agregado en esta auditoría) — no
aparecen como completados en ningún documento del curso.

---

## D. Inconsistencias encontradas

| # | Inconsistencia | Dónde | Cómo se resolvió |
|---|---|---|---|
| 1 | El estado de producción se venía describiendo como "grabados/verificados" sin distinguir video final de guion verificado | Mensaje de estado recibido al iniciar esta auditoría, implícito en la falta de una tabla de estados explícita en `13`/`14` | Resuelto documentalmente: terminología `PRODUCIDO`/`VERIFICADO`/`SALTADO`/`EVIDENCIA INSUFICIENTE` aplicada en este informe y como marcador explícito en los videos 19/23/27 de `14` |
| 2 | `09-dataset-demo.md` listaba `mariana.sosa@demo-nexo.test` como la cuenta del curso; la cuenta real usada en toda la producción grabada es `mariana.sosa.produccion@demo-nexo.test` (la primera quedó huérfana, sin empresa ni MFA, según documentan `scripts/reset-mfa-usuario.mjs` y `scripts/reset-password-usuario.mjs`) | `docs/curso/09-dataset-demo.md`, tabla "Usuarios ficticios" | **Corregido en esta auditoría** — tabla actualizada con nota fechada, sin borrar la cuenta huérfana de la base (no hay baja de usuarios en NEXO) |
| 3 | Videos 19, 23 y 27 estaban marcados `DETENIDO` en `14-guiones-definitivos.md`, una palabra que no distingue "pausado temporalmente" de "excluido a propósito del cronograma" | `14-guiones-definitivos.md`, secciones 19/23/27 | **Corregido en esta auditoría** — se agregó la línea `**Estado: SALTADO — NO PRODUCIDO.**` en las tres, sin tocar el resto de cada nota (los hechos documentados ya eran correctos) |
| 4 | `10-master-plan.md` cita una lista de "16/31 guiones completos" y "funciones listas para grabar (16 de 31)" que ya no refleja el estado actual (31/31 guionados) | `10-master-plan.md` §2, §9, §13, §15 | **No se tocó** — el propio archivo, en su encabezado, ya declara explícitamente que es la sesión original y que `13`/`14` "son la versión vigente" y lo reemplazan en la práctica; no hay contradicción activa, es historia ya declarada como superada |
| 5 | No se encontró evidencia de ejecución en vivo para los videos 04 y 05 (04: código confirmado, sin corrida citada; 05: nada) | `14-guiones-definitivos.md`, secciones 04 y 05; ausencia de carpeta de evidencia en el árbol de producción | **No se fabricó evidencia.** Quedan marcados `VERIFICADO (evidencia parcial)` y `EVIDENCIA INSUFICIENTE` respectivamente en la matriz de este informe — pendiente real, ver §I |
| 6 | Ningún documento del curso (guion, estructura o material de YouTube) advierte al alumno, dentro del curso mismo, que los temas de los videos 19/23/27 no tienen video — solo queda documentado en el material interno de producción | `13-estructura-definitiva.md`, `11-youtube.md` | **No corregido en esta auditoría** — es una decisión de contenido pedagógico/editorial, no una inconsistencia documental segura de resolver sin criterio del productor; queda en §F como hallazgo pedagógico |

No se encontraron contradicciones de **datos numéricos** entre guion y
evidencia (CUIT, precios, cantidades: los verificados — $1.850, $28.400,
30-71234560-4, 30-71234561-2, 30-71234562-0 — coinciden en las tres
fuentes cruzadas), ni videos saltados que aparecieran como completados en
ningún documento antes de esta auditoría, ni funcionalidades citadas que
ya no existan en la aplicación.

---

## E. Correcciones documentales realizadas

| Archivo | Cambio |
|---|---|
| `docs/curso/09-dataset-demo.md` | Corregido el correo de la cuenta del curso (`mariana.sosa@demo-nexo.test` → `mariana.sosa.produccion@demo-nexo.test`), con nota fechada explicando la razón y remitiendo a la nota del video 07 sobre los dos roles |
| `docs/curso/14-guiones-definitivos.md` | Agregado `**Estado: SALTADO — NO PRODUCIDO.**` en los encabezados de los videos 19, 23 y 27, antes de la nota `DETENIDO` ya existente (sin alterar su contenido) |
| `docs/curso/15-cierre-del-curso.md` | Este archivo — informe de cierre, creado en esta auditoría |

No se modificó ningún guion en su contenido sustantivo, ningún dato
histórico de producción, ni se convirtió ningún video saltado en
completado.

---

## F. Auditoría pedagógica

**Video 17 → problema: falta el tramo "bloquear un período → reabrir con
contrafirma" → impacto: el alumno nunca ve en cámara el mecanismo de
doble control para reabrir un período, que el guion promete de forma
explícita en "Qué digo" → corrección recomendada: grabar ese tramo
puntual en una empresa o ejercicio nuevo con un período todavía abierto,
sin depender del ejercicio 2026 ya cerrado de la empresa del curso.**

**Video 07 → problema: la cuenta de producción de Mariana Sosa terminó
con los roles ADMINISTRADOR y CONTADOR a la vez, porque NEXO no tiene
ninguna ruta para quitar un rol ya otorgado → impacto: la tabla "Personas
con acceso" que el alumno ve en cámara contradice visualmente la premisa
pedagógica central del video, recién explicada ("quien crea la empresa
—yo— recibe el rol ADMINISTRADOR, y a propósito no firma la
contabilidad") → corrección recomendada: grabar este video con una
cuenta ADMINISTRADOR recién creada que nunca haya recibido CONTADOR, no
reutilizar la cuenta de producción ya usada en el resto del curso.**

**Videos 19, 23 y 27 (saltados) → problema: pertenecen a tres niveles
pedagógicos distintos (Contabilidad, Reportes, Intelligence), y cada uno
es el único video de su subtema — no hay ningún otro video del curso que
cubra costo de lo vendido, estados contables o propuestas de IA →
impacto: un alumno que siga el curso en orden encuentra tres huecos
temáticos sin explicación dentro del curso mismo (la explicación solo
existe en documentación interna de producción, no en `13` ni en `11`) →
corrección recomendada: agregar una nota visible para el alumno —en la
descripción de YouTube del video anterior y siguiente, o en la página del
curso— explicando por qué esos tres temas quedan pendientes, en vez de
que simplemente falten sin aviso.**

**Video 02 → problema: concentra cinco pasos estructuralmente distintos
(alta de empresa, configuración de MFA, plan de cuentas, rol CONTADOR,
apertura de ejercicio, conversión de plan de suscripción) en un solo
guion — es, por lejos, el "Qué digo" más largo del curso → impacto: es
también el video 2, inmediatamente después de crear la cuenta; alta
densidad tan temprano puede sobrecargar a quien el curso promete llevar
"desde cero" → corrección recomendada: evaluar separar el último
segmento (conversión de plan de suscripción) en un video corto aparte —
el propio `10-master-plan.md` (§19, decisión 3) ya dejaba abierta una
pregunta equivalente para "Precios" sin resolver; es la misma clase de
decisión.**

No se encontraron videos con pasos innecesarios o redundantes más allá de
lo ya corregido en `13-estructura-definitiva.md` §1.2/§1.3 (fusión de
Asientos, división de Diario/Mayor/Balance), ni terminología
inconsistente entre videos, ni un concepto usado antes de explicarse —
los ocho conceptos básicos (ejercicio, período, cuenta imputable, mapeo,
comprobante, asiento, Debe/Haber, Mayor) se introducen en el video 02 y
se refuerzan recién en el 15, en orden.

---

## G. Auditoría de evidencia

**Existe:**
- Video ensamblado completo (audio + clips + `MASTER/*.mp4`): videos 01,
  02, 03 — los únicos tres.
- GIF de la pantalla real: 24 videos (ver columna Evidencia de la
  matriz).
- Verificación por API real sin GIF (por el problema de panel de
  navegador documentado en las notas de producción de los videos
  17/28/29/31): 4 videos — evidencia igual de válida, solo de otro tipo,
  tal como pide el criterio de esta auditoría.
- Notas de corrección fechadas, con causa raíz, cita de archivo/línea de
  código y resultado verificado: en 13 de los 31 videos.

**Falta:**
- Video 04: sin GIF, sin confirmación explícita de haber ejecutado los 8
  roles en vivo — el fix de código sí está confirmado en el diff.
- Video 05: sin ningún rastro de verificación — ni GIF, ni nota, ni
  mención en ningún documento de producción.
- Ningún video del 04 al 31 (salvo el 04 parcialmente) tiene audio de
  narración ni ensamblado final — esperable, dado que la generación de
  audio está explícitamente retenida hasta nueva instrucción, pero es
  evidencia que falta para considerar esos videos "producidos".

No se marcó ningún video como problemático solo por no tener GIF cuando
existía otra evidencia válida (API real, con IDs y respuestas
verificables) — ese criterio se aplicó a los videos 17, 28, 29 y 31.

---

## H. Auditoría de seguridad/producción

- **Sin secretos ni credenciales en el repositorio**: se buscó la
  contraseña real, el secreto TOTP y patrones de claves privadas en
  `docs/curso/*.md` y en el árbol de producción — no se encontró ninguno.
  El único correo citado (`mariana.sosa@demo-nexo.test`, ahora corregido
  a `.produccion@`) es una dirección de prueba bajo el TLD reservado
  `.test`, no una credencial.
- **`video31-factura-demo.xml`**: confirmado eliminado del repositorio
  (no aparece en `git status` ni en el árbol de trabajo) — se usó como
  fixture temporal y se borró tal como correspondía.
- **Scripts nuevos sin commitear** (`scripts/reset-mfa-usuario.mjs`,
  `scripts/reset-password-usuario.mjs`): revisados — no contienen
  secretos hardcodeados, leen `.env`, exigen `--hacelo` para escribir,
  filtran por correo exacto y documentan explícitamente qué NO tocan. No
  son un riesgo de seguridad.
- **Riesgo real encontrado**: hay cambios de código sin commitear
  (`git status`: `apps/api/src/routes/studio.ts`,
  `apps/web/consola.html`, `docs/MANUAL-USUARIO-NEXO.md` modificados;
  los dos scripts de arriba sin trackear) que sostienen **nueve** guiones
  verificados (videos 04, 07, 09, 12, 16, 18, 20, 23, 28). Si ese working
  tree se pierde o se descarta, esos nueve guiones dejan de ser
  ejecutables tal como están escritos, sin que ningún documento lo
  advierta. Ver §I — es el segundo bloqueante real de este cierre.
- Ningún fixture temporal quedó abandonado dentro del repositorio. (Hay
  restos de una toma de audio parcial y abandonada del video 04 en el
  directorio temporal de la sesión de producción, fuera del repositorio
  — no representa un riesgo, se menciona solo por trazabilidad y se
  limpia sola con el sistema operativo.)

---

## I. Pendientes reales

### BLOQUEANTES

1. **25 de 31 guiones verificados no tienen video final** — sin audio de
   narración ni ensamblado. Esto es lo que impide considerar "cerrado"
   el curso como serie de 31 videos publicables, más allá de la capa de
   documentación.
2. **Cambios de código reales sin commitear** que sostienen 9 guiones
   verificados (`apps/api/src/routes/studio.ts`, `apps/web/consola.html`)
   — riesgo concreto de que los guiones dejen de ser ejecutables si se
   pierde el working tree. Recomendación: commitear estos cambios antes
   de dar por cerrada la fase de producción (no se hizo en esta auditoría
   porque no fue solicitado y crear commits no estaba dentro del alcance
   pedido).

### IMPORTANTES

1. Video 04: confirmar en vivo la declaración de los 8 roles de mapeo
   contable y capturar evidencia (GIF o nota).
2. Video 05: ejecutar contra la aplicación real y dejar evidencia — hoy
   no hay ninguna.
3. Video 17: falta grabar el tramo "bloquear período → reabrir con
   contrafirma" sobre una empresa distinta con un período todavía
   abierto.
4. Agregar, en el material orientado al alumno (no solo en documentación
   interna), una nota explicando por qué los videos 19/23/27 no existen
   todavía.
5. Evaluar separar el segmento de conversión de plan de suscripción del
   video 02 (ver §F).

### MENORES

1. Columnas "Acumulada" y "Valor residual" rotas en la tabla de Bienes de
   uso (`t-act-plan` en `consola.html`) — ya tiene una tarea de fondo
   abierta, no bloquea nada de este cierre.
2. Las 6 decisiones pendientes registradas en `10-master-plan.md` §19
   (nombre de playlist, separar Precios, dataset definitivo, etc.) siguen
   sin resolver — no bloquean el cierre del guion.

### FUERA DE ALCANCE

1. Configurar un proveedor de IA real para destrabar el video 27.
2. Escribir/sembrar una plantilla de estado contable para S.R.L. para
   destrabar el video 23.
3. Declarar costo unitario retroactivo o dar de alta un producto nuevo
   con costo desde el origen para destrabar el video 19.
4. Contratar una pasarela de pago, habilitar emisión de factura con CAE
   real, retenciones o Libro IVA Digital — ya documentados como
   "no grabar todavía" desde `06-no-grabar-todavia.md`, sin cambios en
   esta auditoría.

---

## J. Estado final

- **Videos con video final producido:** 3 (01, 02, 03).
- **Videos con guion verificado contra la aplicación real, sin video
  final todavía:** 25.
- **Videos saltados (deliberadamente, con motivo real):** 3 (19, 23, 27).
- **Videos con evidencia insuficiente:** 1 pleno (05) + 1 parcial (04).
- **Bloqueantes para publicar el curso completo:** 2 (video final
  pendiente en 25 videos; cambios de código sin commitear).
- **Cambios documentales realizados en esta auditoría:** 3 archivos
  (`09-dataset-demo.md` corregido, `14-guiones-definitivos.md` con
  marcador de estado agregado en 3 videos, este informe creado).

**¿Listo para congelar/publicar?** La capa de guion y verificación, sí —
31/31 guiones son consistentes, ejecutables y están correctamente
etiquetados (28 verificados, 3 saltados con motivo real, ninguno
fabricado). El curso como producto audiovisual de 31 videos, no — faltan
los archivos de video finales de 25 de ellos, y hay un riesgo concreto
de pérdida de código sin commitear que sostiene 9 de los guiones ya
verificados. Ninguno de los dos bloqueantes requiere una decisión que no
pueda resolverse objetivamente; ninguno de los tres videos saltados debe
forzarse para completar el cronograma.
