# Fases 8-9 — Guiones nuevos, completos

Los 10 videos ya guionados (V01, V02, V04, V05, V06, V09, V10, V15, V16, V31
en la numeración nueva) están en `docs/GUIA-VIDEOS-NEXO.md` y **no se
tocan** — solo se referencian.

**V03 y V18 están persistidos en este archivo**, copiados palabra por
palabra del artefacto externo "Curso NEXO desde Cero" (sección 7, el
diagnóstico previo) el 2026-09-23, para eliminar la dependencia de ese
artefacto. Conservan su estructura original de campos (Objetivo /
Duración / Previos / Pantalla inicial / Guion / Recorrido / Qué NO
mostrar / Cierre / Errores comunes / Siguiente), distinta de la plantilla
de 14 campos que usan V07/V08/V13/V25 más abajo — no se reescribieron
para unificar formato, tal como se pidió.

Este archivo tiene, en total, **6 guiones nuevos completos**: V03, V07,
V08, V13, V18, V25. Los 15 restantes quedan con la estructura fijada en
`02-auditoria-31-videos.md`, a la espera de que se apruebe el orden antes
de escribir el guion palabra por palabra — así no se reescribe trabajo si
cambia el orden.

---

## V03 · La bandeja de Pendientes

*(Persistido del artefacto externo el 2026-09-23 — contenido original sin
cambios, salvo la "Instrucción técnica de grabación" marcada abajo, que se
agrega por instrucción explícita de esta sesión de cierre.)*

**Objetivo:** Que la persona entienda que "Pendientes" es el lugar al que
siempre puede volver cuando no sabe qué hacer, y que un pendiente que no
bloquea no es un error.

**Duración:** 4-5 min

**Previos:** V01, V02 — necesita una empresa creada, con o sin puesta en
marcha resuelta

**Pantalla inicial:** Panel, con al menos un bloqueo de puesta en marcha
visible

**Guion:**

> «Esta pantalla es la única a la que conviene volver cuando no sabés qué
> hacer. Se llama **Pendientes** y está en el grupo Inicio del menú. Cada
> fila es algo real que la base de datos ya sabe: no hay una persona
> escribiendo esta lista a mano.»

**Recorrido:** Clic en **Pendientes**. Mostrar el filtro por categoría.
Abrir un pendiente de **BLOQUEADO** (por ejemplo "Sin plan de cuentas")
con «abrir» y mostrar que lleva directo a la pantalla y a la acción que
lo resuelve. Volver a Pendientes y mostrar un **REQUIERE_DECLARACIÓN**
como ejemplo de "no bloquea, pero conviene resolver".

**Qué NO mostrar:** No abrir un pendiente de otra empresa ni mostrar el
filtro `bloquea=si` por URL — es un detalle técnico que no aporta a un
usuario nuevo.

> **Instrucción técnica de grabación (protección pedagógica) — agregada
> el 2026-09-23:** la empresa demo usada para grabar este video **no debe
> tener ningún comprobante ni ningún asiento cargado todavía** — solo la
> puesta en marcha sin resolver (sin plan de cuentas y/o sin ejercicio).
> Motivo: a esta altura del curso (Nivel 1, después de V01-V02) todavía no
> se enseñó qué es un asiento ni un comprobante, y si la bandeja llegara a
> mostrar un pendiente `REQUIERE_APROBACIÓN` sobre un asiento sin aprobar,
> o `REQUIERE_REVISIÓN` sobre un comprobante, el grabador **no debe
> abrirlo ni explicarlo** — solo mostrar los dos ejemplos ya elegidos
> arriba (`SIN_PLAN_DE_CUENTAS` / `SIN_EJERCICIO`, ambos `BLOQUEADO`, y un
> `REQUIERE_DECLARACIÓN` de puesta en marcha). Si al grabar aparece
> cualquier otro pendiente en la bandeja por accidente, se corta y se
> vuelve a grabar con una empresa demo limpia — no se mezcla en el mismo
> video.

**Cierre:**

> «Si en algún momento de este curso no sabés qué botón tocar, volvé acá.
> Es lo primero que hay que aprender a leer, no lo último.»

**Errores comunes:** Confundir un pendiente informativo con un bloqueo
real. Aclarar la diferencia entre las 7 categorías explícitamente.

**Siguiente:** V04 · Mapeo contable

---

## V07 · Usuarios, roles y permisos

**Objetivo:** que la persona entienda que ADMINISTRADOR y CONTADOR son
distintos a propósito, y sepa dar un rol a otra persona.
**Duración objetivo:** 3-4 min.
**Resultado que obtendrá el alumno:** una segunda persona con rol
CONTADOR asignado en su empresa.
**Prerequisitos:** V02 (empresa creada, rol propio de ADMINISTRADOR).
**Preparación antes de grabar:** tener una segunda cuenta demo ya
registrada y con el correo confirmado (`julian.ferreyra@demo-nexo.test`,
del dataset — ver `09-dataset-demo.md`), para no grabar el alta completa
de una cuenta de nuevo.

**Pantallas que se mostrarán:** Configuración → «Personas con acceso».

**Guion hablado, palabra por palabra:**

> «Quien crea una empresa recibe el rol ADMINISTRADOR — y a propósito
> **no** firma la contabilidad. Es una separación deliberada: quien
> administra el acceso no es necesariamente quien tiene que dar fe de los
> números. Para eso existe el rol CONTADOR, y sin él no se puede subir
> documentos, crear asientos ni aprobarlos.
>
> Vamos a Configuración, bajamos hasta "Personas con acceso", y clic en
> "Dar un rol". Elegimos a Julián, elegimos CONTADOR, y "Dar el rol".
>
> Listo — Julián ya aparece dos veces en la lista si en algún momento
> también tuviera otro rol: cada fila es un rol, no una persona.»

**Acción exacta del cursor:** clic en «Configuración» (menú) → scroll
hasta «Personas con acceso» → clic en «Dar un rol» → seleccionar persona
en el desplegable → seleccionar «CONTADOR» → clic en «Dar el rol».

**Qué debe aparecer en pantalla:** el aviso «Rol otorgado.» y la fila
nueva en la tabla de personas con acceso.

**Texto/overlay sugerido:** «ADMINISTRADOR administra el acceso. CONTADOR
firma la contabilidad. Nunca es la misma persona por defecto.»

**Advertencias:** si el selector de personas aparece vacío, hay que
actualizar la pantalla primero — decirlo en el guion para que no parezca
un error de grabación.

**Errores posibles:** intentar dar un rol a alguien que todavía no
confirmó su cuenta — el selector no lo muestra. Explicarlo si pasa en la
toma.

**Cierre:** «Con esto, tu contador ya puede entrar a trabajar. En el
próximo video conectamos con ARCA.»
**Puente al siguiente video:** V08 · Certificado ARCA y servicios
habilitados.

### GRABACIÓN

- **Resolución:** 1920×1080, grabar la ventana del navegador a pantalla
  completa (sin barra de favoritos visible).
- **Datos a usar:** empresa demo «Ferretería El Tornillo Feliz S.R.L.»;
  persona demo Julián Ferreyra (`julian.ferreyra@demo-nexo.test`).
- **Datos a NO mostrar:** el correo real de Mariana (ADMINISTRADOR) más
  allá de lo necesario para identificarla en la tabla; ningún token de
  sesión visible en la URL o en las herramientas de desarrollador.
- **Dónde hacer zoom:** en el aviso «Rol otorgado.» y en la fila nueva de
  la tabla, 1-2 segundos cada uno.
- **Dónde pausar (para el editor, no para el instructor):** justo después
  de «Dar el rol», antes de que aparezca el aviso — deja espacio para un
  corte si el aviso tarda.
- **Qué debe verse claramente:** el desplegable de roles con las opciones
  reales (no recortarlo).
- **Qué ocultar:** cualquier otra empresa del selector de «Cambiar
  empresa» si aparece en el mismo encuadre.
- **Errores a evitar en cámara:** no mostrar el intento fallido de dar rol
  a una cuenta sin confirmar — grabarlo aparte solo si se decide incluir
  como "error común" con corte explícito, no en el flujo principal.
- **Fin exacto del video:** justo después del cierre hablado, con la tabla
  de personas con acceso todavía en pantalla (no cortar a negro sobre un
  formulario a medio llenar).

---

## V08 · Certificado ARCA y servicios habilitados

**Objetivo:** cargar un certificado y entender qué habilita (y qué no).
**Duración objetivo:** 3-4 min.
**Resultado que obtendrá el alumno:** certificado cargado, lista de
servicios habilitados visible.
**Prerequisitos:** V02, V07 (rol con `arca_credential:manage`).
**Preparación antes de grabar:** usar exclusivamente un certificado de
**homologación** (ambiente de pruebas de ARCA) generado para este dataset
— nunca el certificado real del proyecto (`C:\ARCA\`, CUIT 20452148324).

**Pantallas que se mostrarán:** Configuración → «Cargar un certificado».

**Guion hablado, palabra por palabra:**

> «NEXO no emite facturas — ya lo vamos a repetir en el video final, y
> conviene decirlo ahora también: lo que sí hace es registrar tus
> comprobantes y constatarlos contra ARCA, para saber si lo que cargaste
> coincide con lo que ARCA tiene. Para eso hace falta un certificado.
>
> En Configuración, "Cargar un certificado", subimos el archivo — este es
> de homologación, el ambiente de pruebas de ARCA, no uno de producción
> real — y guardamos. Abajo aparece la lista de servicios habilitados:
> son los que ese certificado autoriza a consultar, ni más ni menos.»

**Acción exacta del cursor:** Configuración → «Cargar un certificado» →
seleccionar archivo → completar el motivo si se pide → «Guardar».

**Qué debe aparecer en pantalla:** el certificado listado con su fecha de
carga, y la tabla de «Servicios habilitados».

**Texto/overlay sugerido:** «Certificado de homologación — ambiente de
pruebas de ARCA. Nunca un certificado de producción en este video.»

**Advertencias:** advertir explícitamente en el video, con texto en
pantalla, que el certificado mostrado es de homologación — evita que
alguien lo confunda con instrucciones para cargar el suyo real sin
entender la diferencia.

**Errores posibles:** certificado vencido → NEXO lo dice explícitamente;
mostrarlo como ejemplo de mensaje de error si se tiene uno vencido a mano
para la demo.

**Cierre:** «Con el certificado cargado, ya podés constatar comprobantes
contra ARCA — lo vemos en el video de comprobantes. Ahora sí, a operar.»
**Puente al siguiente video:** V09 · Documentos: subir y leer.

### GRABACIÓN

- **Resolución:** 1920×1080.
- **Datos a usar:** certificado de homologación del dataset del curso,
  generado específicamente para grabar (no reutilizar el certificado real
  del proyecto bajo ninguna circunstancia).
- **Datos a NO mostrar:** el contenido del archivo del certificado en
  ningún visor de texto ni en una ventana de "propiedades del archivo";
  cualquier clave privada asociada.
- **Dónde hacer zoom:** en la tabla de «Servicios habilitados» tras la
  carga.
- **Dónde pausar:** antes de seleccionar el archivo, para que el editor
  pueda insertar el overlay de advertencia de homologación.
- **Qué debe verse claramente:** el aviso de éxito y la lista de
  servicios.
- **Qué ocultar:** el explorador de archivos del sistema operativo más
  allá de lo imprescindible para elegir el archivo — evita mostrar otras
  carpetas o archivos del escritorio.
- **Errores a evitar en cámara:** nunca mostrar la ruta real
  `C:\ARCA\` en el explorador de archivos durante la grabación — usar una
  carpeta de dataset separada, p. ej. `demo-nexo\certificados\`.
- **Fin exacto del video:** con la tabla de servicios habilitados en
  pantalla, después del cierre hablado.

---

## V13 · Caja, bancos y cheques

**Objetivo:** hacer un arqueo de caja, dar de alta una cuenta bancaria y
ver la cartera de cheques.
**Duración objetivo:** 6 min.
**Resultado que obtendrá el alumno:** una caja abierta con un movimiento,
una cuenta bancaria dada de alta.
**Prerequisitos:** V02.
**Preparación antes de grabar:** dataset con caja en $0 y sin cuenta
bancaria — para que el alta se vea completa, no editada.

**Pantallas que se mostrarán:** Dinero → Caja; Dinero → Bancos; Dinero →
Cheques.

**Guion hablado, palabra por palabra:**

> «Todo el dinero de la empresa vive en este grupo del menú: Caja, Bancos
> y Cheques. Empezamos por Caja. Abrimos una sesión de caja con un monto
> inicial — acá $50.000 — y eso queda como punto de partida del arqueo:
> en cualquier momento se puede comparar lo que debería haber contra lo
> que hay, y la diferencia, si existe, queda registrada, no se esconde.
>
> Ahora Bancos: damos de alta una cuenta con sus datos reales de banco y
> número de cuenta — esto es lo que después se concilia contra el extracto,
> así que tiene que quedar bien cargado desde acá.
>
> Y Cheques: acá aparece la cartera — los que la empresa recibió y los
> que emitió, con su estado.»

**Acción exacta del cursor:** Dinero → Caja → «Abrir caja» → monto inicial
→ confirmar; Dinero → Bancos → «Dar de alta» → banco, número de cuenta,
moneda → guardar; Dinero → Cheques → mostrar tabla (sin acción si no hay
cheques cargados todavía).

**Qué debe aparecer en pantalla:** la caja abierta con su saldo inicial;
la cuenta bancaria en la lista; la tabla de cheques (vacía o con el
fixture del dataset).

**Texto/overlay sugerido:** «El arqueo compara lo que debería haber contra
lo que hay — la diferencia se registra, nunca se ajusta en silencio.»

**Advertencias:** no mostrar un número de cuenta bancaria real, ni
siquiera de una cuenta de prueba del banco — usar el fixture `BANCO-DEMO-01`
definido en `09-dataset-demo.md` (Banco Ficticio del Sur, CBU
`0999999900000012345678`, alias `FERRETERIA.DEMO.NEXO`).

**Errores posibles:** intentar cerrar una caja sin declarar el arqueo →
NEXO lo pide antes de cerrar. Mostrarlo si se quiere ejemplificar el
candado.

**Cierre:** «Con la caja y el banco cargados, ya podés registrar cobros y
pagos reales. Seguimos con existencias.»
**Puente al siguiente video:** V14 · Existencias: depósitos, lotes y
recuento.

### GRABACIÓN

- **Resolución:** 1920×1080.
- **Datos a usar:** caja del dataset demo, cuenta bancaria del fixture
  `BANCO-DEMO-01` (`09-dataset-demo.md`) — Banco Ficticio del Sur, CBU
  `0999999900000012345678`, alias `FERRETERIA.DEMO.NEXO`.
- **Datos a NO mostrar:** cualquier CBU o número de cuenta real, aunque
  sea de una cuenta de prueba personal del instructor.
- **Dónde hacer zoom:** en el saldo de la caja tras la apertura, y en la
  fila nueva de la tabla de cuentas bancarias.
- **Dónde pausar:** entre Caja y Bancos, para permitir un corte de
  sección con overlay "Bancos" en el editor.
- **Qué debe verse claramente:** el formulario completo de alta de cuenta
  bancaria, con todos sus campos.
- **Qué ocultar:** ninguna otra empresa ni otra caja en el mismo
  encuadre.
- **Errores a evitar en cámara:** no dejar visible ningún dato bancario
  real en portapapeles al pegar (si se usa copiar/pegar para completar el
  formulario, escribirlo a mano en cámara en su lugar).
- **Fin exacto del video:** con la tabla de cheques en pantalla, después
  del cierre hablado.

---

## V18 · Períodos, cierre y apertura de ejercicio

*(Persistido del artefacto externo el 2026-09-23 — contenido original sin
cambios.)*

**Objetivo:** Bloquear, cerrar y reabrir un período; hacer el pre-cierre y
la apertura del ejercicio siguiente.

**Duración:** 6-7 min

**Previos:** V16 — necesita al menos un asiento aprobado en el ejercicio a
cerrar

**Pantalla inicial:** Libros → **Períodos y cierre**

**Guion:**

> «Un período bloqueado todavía se puede reabrir; uno cerrado no — por eso
> hay dos pasos y no uno. Primero bloqueamos: fila del período,
> **Bloquear**, con motivo. Después, para cerrar el ejercicio entero, hay
> un **Ver checklist de pre-cierre** en la fila del ejercicio: NEXO no
> deja cerrar si falta algo, y dice exactamente qué.»

**Recorrido:** Bloquear un período → intentar reabrir uno bloqueado
(mostrar que pide **contrafirma de otra persona** — norma de doble
control, no un capricho de la UI) → checklist de pre-cierre → **Cerrar el
ejercicio** → **Asiento de apertura** del siguiente.

**Qué NO mostrar:** No reabrir un período ya cerrado (irreversible en la
demo) sin dejarlo explícito en el guion como "esto no se deshace".

**Errores comunes:** «No aparece 'Cerrar'» → falta terminar el checklist
de pre-cierre.

**Siguiente:** V19 · Bienes de uso y amortizaciones

---

## V25 · Preguntar: Panorama y Riesgos

**Objetivo:** usar el catálogo cerrado de preguntas de Intelligence y
entender que no es un chat libre.
**Duración objetivo:** 4-5 min.
**Resultado que obtendrá el alumno:** puede leer el Panorama y los
Riesgos de su propia empresa.
**Prerequisitos:** V16 (necesita datos operando: al menos un asiento
aprobado).
**Preparación antes de grabar:** empresa demo con al menos 2-3 asientos
aprobados, para que Panorama no muestre todo en null.

**Pantallas que se mostrarán:** Inicio → «Preguntar».

**Guion hablado, palabra por palabra:**

> «"Preguntar" no es un chat libre — es un catálogo cerrado de preguntas
> que NEXO ya sabe contestar con certeza, calculadas por el mismo motor
> que arma cada pantalla. Si el número es `null`, no es un error: es que
> el sistema no puede afirmarlo todavía, y la metodología dice por qué.
>
> Clic en "Ver el panorama" — acá aparecen tarjetas como "¿Cómo voy?" o
> "¿Cuánto tengo?", cada una con su evidencia debajo, no como una
> afirmación que hay que creerle. Y "Ver los riesgos" muestra los seis
> frentes que NEXO vigila solo.»

**Acción exacta del cursor:** Inicio → «Preguntar» → «Ver el panorama» →
scroll por las tarjetas → volver → «Ver los riesgos».

**Qué debe aparecer en pantalla:** las tarjetas del panorama con números
reales (no todas en `null`); la lista de riesgos.

**Texto/overlay sugerido:** «Un valor en `null` no es un error: NEXO dice
que no puede afirmarlo todavía, y por qué.»

**Advertencias:** si la empresa demo no tiene suficiente actividad, varias
tarjetas van a mostrar `null` — o se prepara el dataset con más
operaciones antes de grabar, o se usa ese mismo caso como ejemplo
honesto de qué significa `null`.

**Errores posibles:** ninguno bloqueante — es una pantalla de solo
lectura.

**Cierre:** «"Preguntar" contesta lo que ya sabe con certeza. Para
simular algo que todavía no pasó, existe Señales — el próximo video.»
**Puente al siguiente video:** V26 · Señales, umbrales y escenarios.

### GRABACIÓN

- **Resolución:** 1920×1080.
- **Datos a usar:** empresa demo con 2-3 operaciones aprobadas de
  antemano (usar `factura:demo` repetido con distintos montos, o cargar a
  mano según el dataset de `09-dataset-demo.md`).
- **Datos a NO mostrar:** ningún dato de una empresa real, aunque el
  panorama de una empresa real se vea "más completo" — la tentación de
  usar datos reales para que la demo luzca mejor es exactamente lo que
  hay que evitar.
- **Dónde hacer zoom:** en una tarjeta con evidencia visible (el texto
  chico debajo del número).
- **Dónde pausar:** al pasar de Panorama a Riesgos, para un corte de
  sección.
- **Qué debe verse claramente:** al menos una tarjeta con un valor
  `null`, para poder explicarlo en cámara sin fingir que no existe.
- **Qué ocultar:** nada específico — es una pantalla de lectura sin datos
  sensibles más allá de los propios del dataset.
- **Errores a evitar en cámara:** no editar el `null` para que parezca un
  error de grabación — es información real, se explica, no se recorta.
- **Fin exacto del video:** con la lista de riesgos en pantalla, después
  del cierre hablado.
