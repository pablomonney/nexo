# RISKS.md — Riesgos Legales y Técnicos

> Entregable H del §51. Riesgos identificados en FASE 0, con mitigación concreta y estado.
> Los marcados 🔴 pueden invalidar el producto, no solo degradarlo.

## Riesgos normativos

### ✅ R-01 — Alcance derogatorio de la RT 54 — **CERRADO (2026-08-24)**

Se descargó el texto oficial de la RT 54. El **art. 3°** enumera las derogaciones de forma expresa:
RT 6, 8, 9, 11, 17, 41, 42 y 48 completas; RT 18 secciones 4 y 5; RT 21 sección 3;
Interpretaciones 1, 2, 3, 7, 8 y 11; y once resoluciones de Junta de Gobierno / Mesa Directiva.

**No deroga RT 16, RT 26, RT 44 ni RT 45.** El considerando c) confirma que la RT 54 se dirige a
entidades que preparan estados contables con normas *distintas* a las de la RT 26 (NIIF).

*Efecto:* la determinación automática de marco aplicable queda habilitada. El marco sigue
declarándose por empresa y período en `company_reporting_frameworks`, porque el art. 230 del Anexo A
de la RG IGJ 15/2024 (sustituido por RG 9/2026) mantiene la **opción** por NIIF — pero ya no por
desconocimiento de la norma, sino porque la norma efectivamente da a elegir.

### 🔴 R-02 — Vigencia distinta por jurisdicción

FACPCE fija vigencia de la RT 54 desde 01/07/2024; CPCECABA desde 01/01/2025. Un sistema con
vigencia nacional única produce estados contables mal fundados.

*Mitigación:* tabla `norm_adoptions` con clave `(norma, jurisdicción, fecha)`; resolución por
inicio de ejercicio; el motor rechaza resolver si no conoce la adopción de la jurisdicción.

*Estado (2026-08-24):* **confirmado con texto oficial, no ya inferido.** El art. 226 del Anexo A de
la RG IGJ 15/2024, sustituido por la RG 9/2026, remite a las RT de FACPCE *"adoptadas por el Consejo
Profesional de Ciencias Económicas de la Ciudad Autónoma de Buenos Aires"*. El organismo de control
no manda aplicar "la RT vigente": manda aplicar la adoptada por el consejo de la jurisdicción.

Se agrega un dato que refuerza el punto: la vigencia de la RT 54 tuvo **tres valores sucesivos** —
01/01/2024 en el texto original, 01/07/2024 tras la RT 56, y 01/01/2025 en CABA. Un modelo con un
único campo `fecha_vigencia` no puede representarlo.

Sigue abierto: relevar el acto de adopción de cada consejo donde opere el estudio.

### 🟠 R-03 — Ausencia de API oficial para comprobantes recibidos

No existe web service oficial de "Mis Comprobantes". La automatización total de la ingesta de
compras **no es posible por vía oficial**.

*Mitigación:* ADR-004 — no se hace scraping de portales con Clave Fiscal (riesgo legal, de términos
de uso y de custodia de credenciales). Ingesta por archivo exportado, subida y email.
*Impacto comercial:* debe comunicarse con honestidad al cliente. Prometer lo contrario es vender
algo que depende de un mecanismo frágil e impugnable.

### ✅ R-04 — Conflicto de fechas en la RG 5616/2024 — **CERRADO (2026-08-24)**

No había conflicto: había dos normas distintas mezcladas por las fuentes secundarias.

- **RG 5616/2024**, art. 5°: vigencia el día de su publicación (18/12/2024); la nueva versión del
  WebService es de **uso obligatorio desde el 15/04/2025**.
- El hito de **septiembre de 2026** corresponde a la **RG 5866/2026**, que fijó un cronograma
  escalonado de *nuevos sujetos obligados* que se extiende hasta el 01/03/2027.

*Lección para el proceso:* dos fuentes secundarias que "se contradicen" pueden estar ambas en lo
cierto y hablando de normas diferentes. Es precisamente por esto que la regla del proyecto es
citar el texto oficial y no la interpretación de terceros.

### 🟠 R-05 — Volatilidad normativa

Solo en 2026 la IGJ dictó al menos 10 resoluciones generales, una de las cuales rehízo el régimen
de estados contables. La normativa fiscal cambia con frecuencia comparable.
*Mitigación:* `Normative Update Service` con revisión humana obligatoria; versionado bitemporal
que permite recontabilizar el pasado con el derecho del pasado.

### 🟠 R-21 — La documentación técnica de un organismo no prueba vigencia *(nuevo, 2026-08-24)*

Detectado en campo: el catálogo oficial de web services de ARCA publica el servicio `wsseg`
citando como respaldo la **RG 2668**, que la **RG 5866/2026 derogó**. La documentación técnica
quedó desactualizada respecto de la normativa.

*Por qué importa:* es tentador tomar el manual del organismo como fuente de la regla. No lo es.
*Mitigación:* la vigencia se resuelve **siempre** contra `normative-engine`. Los manuales se
archivan con jerarquía **P4** (material explicativo) y jamás fundan una regla por sí solos.

### 🟠 R-22 — El Boletín Oficial no es una fuente de texto automatizable *(nuevo, 2026-08-24)*

Verificado descargando un aviso: las páginas `boletinoficial.gob.ar/detalleAviso/…` son una SPA y
**el HTML servido no contiene el articulado**. Un `Normative Update Service` que dependa de hacer
fetch al BO obtiene una cáscara vacía.

*Mitigación:* InfoLeg (`norma.htm` / `texact.htm`) es HTML estático con el texto completo y pasa a
ser la fuente de texto del sistema. El BO se usa para datar y citar el aviso. Ver
`docs/api/official-apis.md`.

### 🔴 R-23 — El error silencioso de extracción *(nuevo, 2026-08-24)*

Un OCR nítido que leyó `1.019,83` donde el papel decía `7.019,83` devuelve confianza 0.98 y está
equivocado. No hay puntaje de confianza que detecte esto: el motor está seguro, y tiene razón en
estarlo — leyó bien lo que ve.

*Por qué importa:* es la falla más cara del módulo documental, porque no se parece a una falla.
Una abstención le cuesta al contador un minuto de mirar el papel; un error silencioso le cuesta un
asiento mal imputado que nadie revisó, y eventualmente una declaración jurada rectificativa.

*Mitigaciones, en capas:*

1. **Controles de coherencia** (`coherencia.ts`): neto + IVA + exento + tributos tiene que dar el
   total, **sin tolerancia**. Es lo único que detecta un error con confianza alta.
2. **Abstención ante ambigüedad** en los parsers, en lugar de elegir la lectura más probable.
3. **Techo de confianza por método**: una lectura de imagen no puede alcanzar el nivel de un campo
   estructurado, por más que el motor lo afirme.
4. **La métrica de la fase es la tasa de error silencioso**, no la precisión global, y
   `metrics:extraction` termina con error si hay alguno.

*Residual:* alto mientras no haya corpus real. Un comprobante sin IVA discriminado no tiene
aritmética que controlar, y ahí la única defensa es la revisión humana.

### 🟡 R-24 — La planilla que ya perdió precisión antes de llegar *(nuevo, 2026-08-24)*

Un XLSX guarda los números como flotantes IEEE. Si el sistema que generó la planilla escribió
`1234.5599999999999`, el error de redondeo ocurrió **antes** de la ingesta y no hay forma de
recuperar el valor original.

*Mitigación:* los lectores tabulares devuelven siempre **texto**, nunca llaman a `Number()`, y el
parser rechaza más decimales de los que admite la moneda. Un importe así se marca en vez de
redondearse: la señal de que el origen del dato tiene un problema es más valiosa que el número.

### 🔴 R-25 — La aprobación que se vuelve un trámite *(nuevo, 2026-08-24)*

Todo el diseño descansa en que un profesional revisa antes de aprobar. Si la bandeja se llena de
propuestas y la mayoría son correctas, la revisión degenera en apretar "aprobar" sin leer — y en ese
momento el sistema pasa a contabilizar solo, con la firma de alguien que no miró.

*Por qué importa:* es el modo de falla más probable de todo el producto, y no lo produce un bug.
Lo produce que el sistema funcione bien. Un asistente que acierta el 97% entrena a su usuario a
confiar en el 3% restante.

*Mitigaciones:*

1. **Umbrales conservadores por defecto** (`auto_threshold` 0.9): la aprobación en lote se gana, no
   viene puesta.
2. **Fundamentación exigida para 🟢**: sin citas, o con citas que no llegan a `V1`, la propuesta no
   entra al lote por más confianza que declare. Se aprueba de a una.
3. **Los disparadores duros no se pueden apagar** desde la política de la empresa.
4. **Métrica de deriva** (`GET /predictions/metrics`): si la tasa de rechazo humano sube, el umbral
   automático hay que bajarlo antes de que la confianza se vuelva costumbre.
5. **El aprendizaje no puede levantar un bloqueo**, por más veces que se haya repetido.

*Residual:* alto, y en buena medida fuera del software. La UI puede hacer más —mostrar cuántas
propuestas se aprobaron en menos de N segundos, por ejemplo— y está anotado para FASE 12.

### 🟡 R-06 — Ajuste por inflación

Régimen sensible y con condiciones de aplicación que dependen de índices y de la norma vigente.
**No relevado en FASE 0.**
*Mitigación:* declarado como gap explícito. El motor no lo aplica hasta tener fuente `V1`.

---

## Riesgos legales y de responsabilidad

### 🔴 R-07 — Confusión entre asistencia y ejercicio profesional

El sistema no puede presentarse como sustituto del contador matriculado. Una salida de IA
presentada como dictamen profesional es un problema de responsabilidad, no de UX.
*Mitigación:* §42 implementado en la UI — etiquetado obligatorio de todo contenido generado,
aprobación humana previa a cualquier efecto contable, contador responsable identificado en cada
emisión de estados contables.

### 🔴 R-08 — Custodia de certificados fiscales de terceros

El sistema custodia claves que permiten actuar fiscalmente en nombre de contribuyentes.
*Mitigación:* cifrado por sobre con KMS/HSM, DEK por empresa, revocación verificable, prohibición
absoluta de manejar Clave Fiscal, bitácora de todo uso del certificado. Ver `SECURITY.md` §5.

### 🟠 R-09 — Secreto profesional y filtración entre empresas

*Mitigación:* triple aislamiento (RLS + middleware + storage), test de fuga por endpoint en CI,
aprendizaje de clasificación no compartido entre clientes.

### 🟠 R-10 — Envío de documentación a proveedores de IA externos

*Mitigación:* configuración por organización, región de procesamiento, no-retención, opción de OCR
on-prem, modo determinístico puro sin envío externo. Registro auditable de todo lo enviado.

### 🟡 R-11 — Valor probatorio de libros digitales

El art. 61 de la LGS admite medios digitales, pero los requisitos formales dependen del organismo
de control y de la jurisdicción.
*Mitigación:* inmutabilidad, hash encadenado, exportación reproducible. **Requisito de FASE 13:**
relevar formalidades específicas por jurisdicción antes de prometer sustitución de libros rubricados.

---

## Riesgos técnicos

### 🔴 R-12 — La IA escribiendo contabilidad

El riesgo de producto más grave: que por conveniencia se abra un atajo de la IA a la base.
*Mitigación:* topología de dependencias verificada por lint en CI; invariante A-6 en la suite de
auditoría; `ai_predictions` sin FK de escritura al núcleo contable.

### 🟠 R-13 — Calidad de OCR sobre documentos reales

Facturas escaneadas torcidas, térmicas desvanecidas, fotos de celular. La extracción va a fallar.
*Mitigación:* confianza por campo, nunca completar por inferencia, revisión humana en campos
críticos (CUIT, total, CAE, fecha) por debajo del umbral, métricas por proveedor de OCR.

### 🟠 R-14 — Dependencia de disponibilidad de ARCA

Los WS tienen caídas y ventanas de mantenimiento.
*Mitigación:* cola con reintentos y backoff, caché de TA respetando su vigencia, estado
`NO_VERIFICABLE` explícito en `invoice_validations` (nunca "OK por defecto"), operación degradada.

### 🟠 R-15 — Habilitaciones por CUIT

Varios servicios requieren acuerdos especiales con ARCA. Un servicio puede no estar disponible
para un cliente concreto.
*Mitigación:* capacidades por empresa modeladas explícitamente; la UI muestra qué validaciones
están disponibles y cuáles no para esa empresa.

### 🟡 R-16 — Errores de redondeo y moneda

*Mitigación:* enteros en centavos, `float` prohibido por lint, criterio de redondeo como parámetro
normativo, rechazo ante descuadre en lugar de ajuste silencioso.

### 🟡 R-17 — Rendimiento del linaje en volumen

El grafo `lineage_edges` crece rápido.
*Mitigación:* particionado por empresa y período, índices sobre ambos extremos, materialización de
caminos frecuentes, poda por archivado (nunca borrado).

### 🟡 R-18 — Costo y latencia de la IA

*Mitigación:* caché por hash de documento, procesamiento por lotes, modelos pequeños para tareas
simples, presupuesto por empresa, y el hecho de que el sistema **funciona sin IA**.

### 🔴 R-26 — Una columna que significa dos cosas *(nuevo, 2026-08-25)*

`journal_entry_lines.debit` guardaba el importe original de la línea mientras la cabecera guardaba
el convertido. Con toda la contabilidad en pesos los dos números coinciden y el defecto es
invisible; aparece recién con la primera línea en moneda extranjera, y entonces el asiento se cae al
COMMIT, el balance suma centavos de dólar como pesos y el Mayor hereda la mezcla.

*Por qué importa:* no lo encontró ningún test, porque ningún test de integración tenía una línea en
otra moneda. Lo encontró conectar el Mayor y preguntarse qué unidad tenían esos números. La clase de
defecto —una columna con dos significados según el caso— no la detecta la cobertura: el código está
todo ejecutado, y ejecutado da bien.

*Mitigaciones:*

1. **La migración `0020` separa las dos cosas** en columnas distintas, con `COMMENT ON COLUMN` que
   dice qué es cada una.
2. **Un trigger exige que la moneda de la línea sea la del asiento** (`E_CURRENCY_MISMATCH`): la
   mezcla ya no depende de que la aplicación se porte bien.
3. **Tres tests de integración con moneda extranjera**, que es el caso que faltaba.
4. **`MONEDA_DE_REGISTRO`** en los controles del Diario mira lo mismo desde el otro lado.

*Residual:* medio. El patrón puede repetirse en cualquier columna que hoy tenga un solo caso de uso.
La defensa es la misma que acá funcionó: cuando un módulo nuevo consume un dato viejo, preguntar en
qué unidad está antes de sumarlo.

### 🟡 R-27 — Un libro que se emite sin decir cómo está llevado *(nuevo, 2026-08-25)*

El CCyC art. 330 le da eficacia probatoria a la contabilidad *«llevada en la forma y con los
requisitos prescritos»*. Un sistema que imprime el Diario sin verificar esos requisitos deja al
contador firmando algo que no comprobó — y los defectos de forma (un hueco de numeración, un
contraasiento antedatado) no se ven leyendo el libro de corrido.

*Mitigaciones:*

1. **Siete controles de forma**, cada uno citando el inciso del que sale, corren en cada emisión.
2. **No bloquean**: un Diario con un hueco existe y hay que poder verlo para arreglarlo.
3. **Quedan grabados** en `book_emissions.controles` junto con el hash del contenido, así que
   después no se puede decir que no se sabía.
4. **El pie del libro los transcribe**, con nombre de control y cantidad.

*Residual:* bajo para lo que el software puede ver. Queda fuera lo que no es un dato del sistema:
la rúbrica del art. 323 y la autorización del art. 329 son trámites del Registro Público, y el pie
dice que el sistema no los tiene en vez de afirmar que faltan.

### 🔴 R-28 — La alícuota que casi siempre acierta *(nuevo, 2026-08-25)*

El 21% es la alícuota general del IVA en Argentina desde hace décadas. Un motor que la suponga
cuando no tiene el dato acierta en la enorme mayoría de las operaciones — y ahí está el riesgo: nadie
va a notar que está suponiendo, hasta la operación de carnes, de medicina prepaga o de bienes de
capital, que son grandes.

*Por qué importa:* es el mismo mecanismo del R-25 pero en un número en vez de en una decisión. Un
sistema que acierta el 97% entrena a su usuario a no revisar el 3%.

*Mitigaciones:*

1. **No hay un `21` en el código del motor de IVA.** Ni un `0.21`. Hay un test que lo afirma.
2. **`tax_rates.norm_version_id NOT NULL`**: una alícuota sin norma no se puede insertar, ni por
   la aplicación ni por un `psql` manual.
3. **La aplicación no puede insertar alícuotas** (`REVOKE INSERT`): cargarlas exige credenciales de
   migración y revisión humana, igual que las normas y los prompts.
4. **Cuando ninguna alícuota relevada produce el IVA declarado, el motor no elige la más cercana.**
   Devuelve `ALICUOTA_NO_IDENTIFICADA` y enumera las que hay.

*Residual:* bajo mientras `tax_rates` esté vacía; el riesgo real aparece el día que se cargue la
primera alícuota y alguien tenga la tentación de cargar solo la general.

### 🟠 R-29 — El sistema que "presenta" lo que no puede presentar *(nuevo, 2026-08-25)*

El art. 6° de la RG 4597 exige Clave Fiscal Nivel 3 para el PORTAL IVA, y el art. 8° remite los
diseños de registro al micrositio. Un producto que quiera mostrar un botón "presentar" tiene dos
caminos: pedirle la Clave Fiscal al estudio —guardando la llave de todos sus clientes— o inventar el
layout del archivo.

*Por qué importa:* las dos tentaciones son comerciales, no técnicas. La primera destruye el modelo de
seguridad entero; la segunda produce un archivo que ARCA rechaza, o peor, uno que acepta con los
campos corridos.

*Mitigaciones:*

1. **La Clave Fiscal no se pide, no se guarda y no se usa** (regla de FASE 3a). El estado se llama
   `PRESENTADO_POR_TERCERO`, no `PRESENTADO`: el nombre dice quién lo hizo.
2. **Los dos endpoints existen y devuelven 501** con el artículo adentro, en vez de no existir. Un
   404 haría pensar que nadie lo pensó.
3. **El desbloqueo está escrito**: archivar los diseños de registro del micrositio con su fecha y su
   hash, y recién entonces implementar el exportador contra esa fuente.

*Residual:* medio, y es presión de producto más que riesgo técnico.

### 🔴 R-30 — El match plausible que cierra los saldos igual *(nuevo, 2026-08-26)*

Es el modo de falla propio de la conciliación, y no lo produce un bug. El motor propone un match
razonable —mismo importe, fecha cercana—, el contador aprueba porque los otros cuarenta estaban
bien, y el pago a un proveedor queda cancelando la factura de otro. **Los saldos cierran igual.**
Nadie se entera hasta que el proveedor reclama.

*Por qué importa:* la conciliación es el único proceso contable donde un error puede pasar todos los
controles aritméticos. El balance cuadra, el Mayor coincide con el Diario, el acta cierra — y la
imputación está mal.

*Mitigaciones:*

1. **El importe exacto es precondición.** No hay match "por poco": una diferencia de importe es una
   partida conciliatoria, no un match con menos confianza.
2. **El empate no se resuelve**: dos candidatos con el mismo puntaje vuelven los dos.
3. **Las señales viajan con la propuesta.** El contador ve qué sumó y qué no antes de aprobar, en vez
   de un número de confianza sin desglose.
4. **No hay confirmación en lote.** Ningún endpoint acepta "confirmar todas": es exactamente cómo la
   revisión se vuelve un trámite (R-25).
5. **Una agrupación nunca puntúa como un match uno a uno**, y el mensaje dice que tres importes que
   suman un cuarto pueden ser coincidencia.

*Residual:* medio-alto, y es el mismo residual de R-25: depende de que la persona mire. Lo que el
software puede hacer es no facilitarle no mirar.

### 🟠 R-31 — La misma palabra significando lo contrario *(nuevo, 2026-08-26)*

En el extracto bancario "débito" es plata que sale de la cuenta. En el libro, un débito en la cuenta
Banco es plata que entra. Las dos son correctas y opuestas, y cualquier código que use esas palabras
obliga a quien lo lee a recordar en qué óptica está parado.

*Por qué importa:* apareció en esta misma fase. La primera versión del acta tenía el signo invertido
en dos de los cuatro casos de partida conciliatoria, y **cerraba igual** cuando los importes de las
dos puntas coincidían —que es el caso de prueba que uno escribe primero—. Lo encontró un test con
importes distintos, no una revisión de código.

*Mitigaciones:*

1. **El tipo se llama `ENTRADA`/`SALIDA`**, siempre desde la caja de la empresa. No tiene dos
   lecturas.
2. **La traducción se hace una sola vez**, en el importador, con la columna del banco nombrada como
   el banco la titula.
3. **La base rechaza la palabra ambigua**: `sentido IN ('ENTRADA','SALIDA')`.
4. **Los cuatro casos del acta están escritos uno por uno en un comentario**, con su ejemplo, porque
   los dos del medio se confunden todo el tiempo.

*Residual:* bajo en bancos. El patrón —una palabra del dominio que cambia de signo según el
observador— puede repetirse en cualquier módulo nuevo; la defensa es nombrar el efecto, no la
partida.

### 🔴 R-32 — La cuenta que desaparece del balance *(nuevo, 2026-08-26)*

Un estado contable armado con plantilla toma sus cifras de las cuentas que los selectores capturan.
Si el plan tiene una cuenta que **ningún** selector captura, su saldo simplemente no aparece — y a
veces el balance igual cierra, porque dos cuentas huérfanas se compensan. Ahí nadie lo nota nunca.

*Por qué importa:* es el modo de falla específico de este diseño, y es invisible por construcción. El
estado se ve completo, la ecuación patrimonial da bien, los totales son razonables. Lo único que
falta es una cuenta, y no hay nada en la salida que lo sugiera.

*Mitigaciones:*

1. **`CUENTA_SIN_RUBRO` bloquea la emisión**, no advierte. Hay un test que reproduce el caso
   peligroso: dos huérfanas que se compensan, ecuación en verde, `emisible: false`.
2. **`CUENTA_EN_DOS_RUBROS`** cubre el error simétrico: un selector demasiado ancho.
3. **Los dos corren sobre las dos columnas**, actual y comparativa.
4. **El linaje viaja con cada renglón**: la suma de los aportes tiene que dar el importe, y eso se
   puede verificar renglón por renglón desde la UI.

*Residual:* bajo mientras el control siga siendo bloqueante. El día que alguien lo convierta en una
advertencia para poder emitir un balance apurado, el riesgo vuelve entero.

### 🟠 R-33 — El control que se apaga con un error de tipeo *(nuevo, 2026-08-26)*

La ecuación patrimonial se declara por códigos de nodo. Con un `?? 0n` defensivo, un código mal
escrito daba `undefined` para los tres términos y el control informaba "0 = 0 + 0": **cumplía**. Un
control desactivado por un typo produce exactamente la misma salida que uno que verifica y da bien.

*Por qué importa:* la clase es general. Cualquier control que resuelva sus operandos por nombre y use
un default numérico ante la ausencia puede pasar de verificar a no verificar sin que cambie nada
visible.

*Mitigaciones:*

1. **Si un nodo declarado no existe, el control falla** con el nombre del que falta.
2. **El mismo criterio en el motor normativo**: un hecho ausente hace fallar la evaluación, nunca
   vale `false`.
3. **Y en el motor de IVA**: sin alícuota relevada no se supone la general.

*Residual:* bajo acá, medio como patrón. La regla es: ante un operando ausente, fallar; nunca
sustituir por un neutro que haga pasar la comprobación.

### 🔴 R-34 — La cadena de auditoría que se bifurca en silencio *(nuevo, 2026-08-26)*

`audit_logs` encadena cada entrada con el hash de la anterior para que agregar, borrar o reordenar
sea detectable. El eslabón anterior se buscaba con `ORDER BY occurred_at DESC`, y `occurred_at` es
`now()`: la hora de **inicio de la transacción**, no la del INSERT.

Bajo concurrencia las horas de inicio se intercalan con el orden real de inserción, y tres entradas
terminan con el mismo `prev_hash`. En la base de desarrollo había **19 bifurcaciones sobre 204
entradas** — sin una sola alarma.

*Por qué importa:* en una bifurcación la propiedad que la cadena existe para dar **se pierde**. Dos
ramas paralelas admiten que se borre una entera sin que ningún eslabón quede colgando. Y el control
fallaba justo bajo carga, que es cuando una bitácora importa.

*Cómo apareció:* no lo encontró una revisión de código ni un test. Lo encontró el invariante A-5 la
primera vez que se lo corrió contra datos reales. El candado de serialización
(`pg_advisory_xact_lock`) estaba bien; lo que estaba mal era la pregunta — se ordenaba por "cuál
empezó última" y había que ordenar por "cuál entró última".

*Mitigaciones:*

1. **La cadena se encadena por `seq`**, una secuencia que toma valor en el INSERT (migración 0025).
2. **`seq` entra al payload hasheado**: reordenar la bitácora también rompe la cadena.
3. **`verify_audit_chain` usa la misma fórmula y el mismo orden.** Un verificador que calcula
   distinto reporta rupturas donde no las hay y —peor— deja de reportar las que sí.
4. **A-5 corre en `npm run verify`**: si vuelve a bifurcarse, el build no pasa.

*Residual:* bajo. Queda el acoplamiento entre las dos fórmulas —trigger y verificador— que hoy se
mantiene a mano; son diez líneas en el mismo archivo, y está anotado que hay que extraerlas a una
función compartida si crecen.

### 🟠 R-35 — El invariante que pasa porque no hay datos *(nuevo, 2026-08-26)*

De los ocho invariantes, dos (A-2 y A-4) hoy no tienen ninguna fila sobre la que puedan fallar: no
hay cifras de nota ni aplicaciones de regla. Reportarlos en verde sería literalmente cierto y
completamente engañoso.

*Por qué importa:* es el mismo error que `NO_CONSULTADO` vs `FUENTE_NO_ENCONTRADA` en el motor
normativo, o `cadenaVerificada: null` en bancos. Un tablero que pinta igual "verificado y está bien"
que "no había nada que verificar" acompaña una base vacía con la misma cara que una base sana — y la
primera vez que alguien confía en ese verde, confía en nada.

*Mitigaciones:*

1. **`audit:invariants` cuenta el universo de cada invariante** y marca `VACUO` cuando es cero.
2. **El resumen los informa por separado**: "6 verificados, 2 vacuos", nunca "8 en verde".
3. Es el mismo criterio ya aplicado en el motor normativo, en el de IVA y en la conciliación.

*Residual:* bajo mientras la distinción se mantenga. El riesgo real es que alguien "simplifique" el
resumen a un booleano.

---

## Riesgo de proyecto

### 🟠 R-19 — Alcance

El pliego describe un producto que, completo, es un ERP contable con motor normativo. Intentarlo
de una vez es el modo más confiable de no entregar nada.
*Mitigación:* fases con criterios de salida verificables; MVP acotado en `docs/product/MVP.md`.

### 🟠 R-20 — Deuda normativa silenciosa

Un motor con reglas cargadas a medias que "parece" funcionar es más peligroso que uno vacío.
*Mitigación:* niveles `V1..V4` visibles en la UI; una regla `V2` o inferior **no se aplica**, se
muestra como gap. El sistema prefiere declararse incompleto antes que aparentar completitud.
