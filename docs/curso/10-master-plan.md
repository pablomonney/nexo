# CURSO NEXO DESDE CERO — MASTER PLAN

**Sesión autónoma, 2026-09-22/23.** Documentación solamente — sin cambios
de código, base de datos, producción, deploy, migraciones, configuración
ni commits. Producción sigue en `7dde83c`; documentación de la
verificación E2E en `39eec2c`; nada de este trabajo se desplegó.

> **Estructura y guiones definitivos (curso "NEXO Intelligence desde
> Cero", 2026-09-23/24):** este master plan documenta el trabajo de la
> sesión original. La estructura de 31 videos con títulos literales y
> los 31 guiones de producción, palabra por palabra, están en
> [`13-estructura-definitiva.md`](13-estructura-definitiva.md) y
> [`14-guiones-definitivos.md`](14-guiones-definitivos.md) —
> **son la versión vigente**, y reemplazan en la práctica a los guiones
> parciales de `02-auditoria-31-videos.md` (Tabla B, columna "Guion") y
> `08-guiones-nuevos.md`. Este archivo no se reestructuró para
> reflejarlo entero — se agregan referencias donde correspondía.
>
> **Estado de producción (2026-09-30):** los conteos de este archivo
> ("16/31 guiones completos", "funciones listas para grabar") describen
> el avance del **guion**, en la sesión en que se escribió, antes de
> grabar nada — no cuántos videos tienen hoy un archivo de video final.
> "Guion completo" y "video producido" son cosas distintas. El estado
> real, video por video, con esa distinción explícita, está en
> [`16-matriz-de-produccion.md`](16-matriz-de-produccion.md) — hoy, 3
> videos tienen archivo final (`VIDEO_FINAL`), 25 tienen guion verificado
> contra la aplicación real sin video todavía (`GUION_VERIFICADO`), y 3
> están saltados a propósito (`SALTADO_NO_PRODUCIDO`).

## 1 · Resumen ejecutivo

Se recuperó y validó el diagnóstico previo (13 entregables, artefacto
"Curso NEXO desde Cero"), se auditaron los 31 videos uno por uno contra el
producto real, se investigó a fondo el gap del plan de cuentas, se escribió
la estructura pedagógica definitiva de 7 niveles, el journey completo de
24 pasos, 4 guiones nuevos completos (más los 10 ya existentes y los 2 del
diagnóstico previo = 16 de 31 con guion completo), el dataset demo, la
arquitectura de YouTube, dos capítulos nuevos del manual oficial, y una
segunda pasada de control de calidad con 10 hallazgos reales.

## 2 · Estado actual

| Área | Estado |
|---|---|
| Diagnóstico previo | Recuperado y validado — sin inconsistencias encontradas entre sus 13 entregables — `01-validacion-diagnostico.md` |
| Auditoría de 31 videos | **Completa** — `02-auditoria-31-videos.md` |
| Orden pedagógico | **Definitivo** — `03-orden-pedagogico.md` |
| Journey empresa desde cero | **Completo**, 24 pasos — `04-journey-empresa-desde-cero.md` |
| Gap del plan de cuentas | **Investigado a fondo**, sin corregir — `05-gap-plan-de-cuentas.md` |
| Qué no grabar todavía | **Completo** — `06-no-grabar-todavia.md` |
| Manual oficial | **Extendido** (Capítulo 0 + Sección N), 9 capítulos completos pendientes — `07-manual-estructura.md` |
| Guiones | 16/31 completos (10 previos en `GUIA-VIDEOS-NEXO.md` + 6 persistidos en `08-guiones-nuevos.md`), 15 en estructura |
| Dataset demo | **Completo**, con CUIT sintéticos válidos en formato — `09-dataset-demo.md` |
| YouTube | **Completo** — playlists, 31 filas de metadata, 3 descripciones completas — `11-youtube.md` |
| Control de calidad | **Completo**, 10 hallazgos — `12-control-de-calidad.md` |
| Estructura definitiva ("NEXO Intelligence desde Cero") | **Cerrada**, 31 videos con título literal — `13-estructura-definitiva.md` |
| Guiones de producción definitivos | **Completos, 31/31**, verificados y corregidos contra el código real — `14-guiones-definitivos.md` |

## 3 · Arquitectura pedagógica

7 niveles (Conocer NEXO / Crear y configurar empresa / Cargar datos base /
Operar / Contabilidad / Gestión / Inteligencia), con 2 ajustes justificados
contra el producto real: Documentos se adelanta dentro de "Operar" (sin él,
Ventas/Compras no se explican), y Precios/CRM/Comisiones se ubican donde
la navegación real de la consola los tiene (Ventas y Gestión), no donde el
borrador original los daba por sentado. Detalle completo en
`03-orden-pedagogico.md`.

## 4 · Mapa completo de funcionalidades

Sin cambios respecto al diagnóstico previo — sigue siendo
`docs/MATRIZ-FUNCIONALIDADES-NEXO.md` (110 filas, 12 secciones), que ya
estaba fresco (2026-09-21/22) y no necesitó re-auditoría.

## 5 · Currículum definitivo de 31 videos

`02-auditoria-31-videos.md` — 17 columnas por video, cubriendo título
actual/recomendado, nivel, objetivo, pantallas, flujo, duración,
prerequisitos, dependencias, verificación, estado del guion y si está
listo para grabar.

## 6 · Orden pedagógico definitivo

`03-orden-pedagogico.md` — los 7 niveles con objetivo, videos, conocimientos
adquiridos, ejercicio práctico y criterio de fin de nivel para cada uno.

## 7 · Journey "Empresa desde cero"

`04-journey-empresa-desde-cero.md` — los 24 pasos pedidos, cada uno con
pantalla real, acción, prerequisito, resultado esperado y nivel de
verificación. 12 de 24 verificados en producción con evidencia concreta.

## 8 · Matriz de verificación

Heredada del diagnóstico previo y de `MATRIZ-FUNCIONALIDADES-NEXO.md` /
`MANUAL-USUARIO-NEXO.md`, con las 7 categorías nuevas de este brief
aplicadas video por video en `02-auditoria-31-videos.md`, Tabla B.

## 9 · Funciones listas para grabar (16 de 31)

V01, V02, V03, V04, V05, V06, V09, V10, V15, V16, V18, V31 (guion completo
y evidencia suficiente) + V07, V08, V13, V25 (guion completo esta sesión,
evidencia parcial — ver Tabla B de `02-auditoria-31-videos.md` para el
detalle exacto de qué está verificado en cada uno).

## 10 · Funciones que NO deben grabarse

`06-no-grabar-todavia.md` — 12 funcionalidades inmaduras (con motivo y qué
tendría que ocurrir antes de cada una) más 1 restricción de mecánica de
grabación (reabrir un período ya cerrado — no es inmadurez de producto,
reclasificada el 2026-09-23).

## 11 · Gap del plan de cuentas

`05-gap-plan-de-cuentas.md` — investigación completa (10 puntos pedidos),
clasificado como bug real de UX, bajo impacto, sin tocar código. Se
agregó a la tabla de huecos del manual oficial (#15).

## 12 · Manual oficial — estructura y avance

`07-manual-estructura.md` — 2 capítulos nuevos completos escritos y ya
insertados en `MANUAL-USUARIO-NEXO.md` (sin commitear): Capítulo 0
(conceptos básicos) y Sección N (Pendientes). 9 capítulos más quedan en
estructura, priorizados por precisión sobre velocidad — ver justificación
en el archivo.

## 13 · Guiones disponibles

16/31 completos. Los 10 más antiguos en `GUIA-VIDEOS-NEXO.md` (sin tocar).
Los otros 6 (V03, V07, V08, V13, V18, V25) están persistidos completos en
`08-guiones-nuevos.md` — ninguno depende ya de un artefacto externo. Los
4 escritos originalmente en esta sesión (V07, V08, V13, V25) traen además
la sección técnica de grabación (Fase 9); V03 y V18, persistidos el
2026-09-23, conservan su estructura de campos original.

## 14 · Dataset demo

`09-dataset-demo.md` — empresa ficticia «Ferretería El Tornillo Feliz
S.R.L.», con CUIT calculados con la función real de dígito verificador
del proyecto sobre bases inventadas (no son de nadie real), 2 usuarios,
3 terceros, 3 productos, plan de cuentas modelo, y la operación de
referencia ya verificada en producción reutilizada donde corresponde.

## 15 · Plan de grabación

Ver sección 9 de este documento para el orden — resumen: primero los 8
videos con guion completo y evidencia de producción (V01, V02, V04, V09,
V10, V15, V16, V31), después V03, V05, V06 y V18 (guionados, alto valor
pedagógico — V05/V06 quedaron fuera de esta lista en una versión anterior
de este documento por omisión, corregido en la auditoría del 2026-09-23),
después V07/V08/V13/V25 (guionados esta sesión), y recién después los 15
restantes, en el orden de niveles 2→7 fijado en `03-orden-pedagogico.md`.

## 16 · Arquitectura YouTube

`11-youtube.md` — canal, 7 playlists, metadata de los 31 videos, 3
descripciones completas de ejemplo, CTA estándar.

## 17 · Gaps de UX/documentación

Heredados de la auditoría integral previa (sesión de "auditoría integral
de NEXO"), más el nuevo de esta sesión (§11 de este documento). No se
re-auditó todo el producto de nuevo — no era el objetivo de esta sesión.

## 18 · Problemas encontrados (control de calidad)

`12-control-de-calidad.md` — 10 hallazgos, ninguno crítico, ninguno
requiere código. El de mayor prioridad (V03 sin instrucción explícita
contra pendientes prematuros) se cerró en la sesión de cierre documental
del 2026-09-23 — ver `08-guiones-nuevos.md`.

## 19 · DECISIONES PENDIENTES DE PABLO

Solo lo que realmente necesita tu intervención — todo lo demás ya se
resolvió con criterio pedagógico documentado, sin esperar respuesta.

1. **Nombre de la playlist principal.** Propuesta: "NEXO desde Cero —
   Curso completo". ¿Aprobado, o preferís otro?
2. **¿Grabar sobre el gap del plan de cuentas tal cual está, o esperar a
   que se corrija?** Recomiendo grabarlo mostrando el clic en "Buscar"
   como parte normal del flujo — no bloquea nada — pero es tu decisión de
   producto si preferís corregirlo antes (una línea de código, no
   ejecutada en esta sesión).
3. **¿Separar "Precios" en un video propio (V11-B)** si V11 (Ventas) queda
   demasiado denso al escribir el guion completo? Ver nota en Nivel 3 de
   `03-orden-pedagogico.md`.
4. **Dataset definitivo:** ¿aprobás "Ferretería El Tornillo Feliz S.R.L."
   como empresa demo del curso completo, o preferís otro rubro/nombre? El
   rubro (ferretería) se eligió porque da terceros, productos con y sin
   stock, y operaciones de compra/venta parejas — pero es una elección
   reversible sin costo.
5. **¿Autorizar la corrección de una línea** (`dibujarCuentas()` al final
   de `cargarConfig()`) para el gap del plan de cuentas, en una sesión
   posterior con las mismas reglas de bajo riesgo ya usadas en la
   auditoría integral? No se tocó código en esta sesión por instrucción
   explícita — quedaría para una sesión futura si lo autorizás.
6. **¿Avanzar los 9 capítulos completos del manual que faltan** (Comercial,
   Compras, Dinero, Existencias, Bienes de uso, Períodos/cierre, IVA,
   Inteligencia/Administración) en la próxima sesión, o priorizar primero
   terminar los 15 guiones de video restantes?

## 20 · Próximos pasos

En orden de valor por esfuerzo, sin esperar aprobación para empezar
ninguno salvo donde el brief exige decisión (arriba):

1. Grabar los 16 videos ya guionados (sección 9), reutilizando la
   evidencia de producción y el dataset demo.
2. Escribir los 15 guiones restantes, usando V18 como plantilla (es el
   más representativo de un video "de administración").
3. Completar los 9 capítulos del manual que quedaron en estructura,
   verificando cada botón contra `consola.html` antes de darlos por
   escritos — mismo estándar que el resto del manual.
4. Resolver las 6 decisiones de la sección 19.
5. Recién entonces: grabar el resto, publicar la playlist (sin publicar
   nada todavía, per instrucción explícita), y considerar la corrección
   del gap del plan de cuentas como cambio de código de bajo riesgo,
   con su propio test — mismo patrón que ya se usó y aprobó en la
   auditoría integral.

---

**Archivos de este proyecto**

```
docs/curso/
├── 01-validacion-diagnostico.md
├── 02-auditoria-31-videos.md
├── 03-orden-pedagogico.md
├── 04-journey-empresa-desde-cero.md
├── 05-gap-plan-de-cuentas.md
├── 06-no-grabar-todavia.md
├── 07-manual-estructura.md
├── 08-guiones-nuevos.md
├── 09-dataset-demo.md
├── 10-master-plan.md          ← este archivo
├── 11-youtube.md
├── 12-control-de-calidad.md
├── 13-estructura-definitiva.md
└── 14-guiones-definitivos.md
```

Fase 1 (recuperar y validar el diagnóstico previo) está en
`01-validacion-diagnostico.md` — sin inconsistencias reales encontradas
entre los 13 entregables previos.
