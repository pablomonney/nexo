# FASE 2 — NEXO Intelligence desde Cero: guiones de producción

31 videos, guion palabra por palabra, pensados para grabarse tal cual
están escritos. Empresa del curso en todos: **Ferretería El Tornillo
Feliz S.R.L.** (dataset completo en `09-dataset-demo.md`). Se graba en un
entorno local propio, nunca contra producción.

Convención: **"Qué digo"** es el guion hablado, palabra por palabra.
**"Qué hago"** son las acciones exactas en NEXO, en el orden en que se
hacen mientras se habla.

**Estado de producción (2026-09-30) — leer antes de grabar cualquier
video:** "guion completo" y "video producido" son cosas distintas. Este
archivo tiene los 31 guiones escritos, pero no los 31 están igual de
verificados ni mucho menos grabados. El estado exacto de cada uno, con
checklist operativo para producirlo, está en
[`16-matriz-de-produccion.md`](16-matriz-de-produccion.md) — esa tabla es
la **única fuente de verdad** de estado; este resumen solo la refleja:

| Estado del video | Cantidad | Videos |
|---|---|---|
| `VIDEO_FINAL` (video terminado, con audio y ensamblado) | 17 | 01, 02, 03, 09, 10, 11, 12, 13, 20, 21, 22, 24, 25, 26, 28, 29, 30 |
| `GUION_VERIFICADO` (confirmado contra la app real, sin video final) | 9 | 06, 07, 08, 14–18, 31 |
| `EVIDENCIA_INSUFICIENTE` (sin confirmación de ejecución en vivo) | 2 | 04, 05 |
| `SALTADO_NO_PRODUCIDO` | 3 | 19, 23, 27 |

Cada video tiene además un **estado de producción** independiente
(`LISTO_PARA_PRODUCIR` / `REQUIERE_PREPARACION` /
`REQUIERE_NUEVA_VERIFICACION` / `BLOQUEADO`) — ver `16` para el detalle
video por video, no se repite acá.

---

## 01 · Crear tu cuenta

*(Corregido el 2026-09-24 contra el producto real: la versión anterior
de este guion incluía la configuración del segundo factor acá. Al
ensayar la grabación con una cuenta nueva de verdad, comprobé que NEXO
**no** pide el segundo factor en este punto — lo pide recién después de
crear la empresa, porque es el rol ADMINISTRADOR el que lo exige, y
antes de tener una empresa la cuenta no tiene ningún rol. El segmento de
MFA se movió al video 02, donde ocurre de verdad.)*

**Objetivo:** que el alumno tenga una cuenta activa y confirmada.

**Qué va a ver el alumno:** el registro completo, la confirmación por
correo, y el primer ingreso ya adentro.

**Pantalla/recorrido:** Ingreso → «No tengo cuenta» → confirmar correo →
Ingresar.

**Qué digo:**

> «Arrancamos por acá: `nexointelligence.com.ar/consola`. Todavía no
> tengo cuenta, así que voy a «No tengo cuenta». Correo, una contraseña
> de doce caracteres o más, mi nombre, y «Registrarme». Ahora tengo que
> confirmar el correo — reviso la bandeja de entrada, copio el código, y
> lo pego en «Ya tengo el código de confirmación», «Confirmar».
>
> Con la cuenta confirmada, entro con mi correo y mi contraseña, y el
> campo de seis dígitos lo dejo vacío — todavía no configuré nada.
> «Ingresar». Y ya estoy adentro.»

**Qué hago:** «No tengo cuenta» → completar registro → «Registrarme» →
confirmar correo → «Confirmar» → volver al login → completar correo y
contraseña → «Ingresar».

**Datos a preparar:** un correo con formato válido para el registro (no
hace falta que reciba correo real — en el entorno local, sin proveedor
de correo configurado, el mensaje de confirmación queda disponible para
leerlo directamente, sin depender de ninguna casilla).

**Resultado visible:** sesión iniciada, parado en la pantalla «Crear mi
empresa».

**Transición:** «Con la cuenta lista, el próximo paso es tener una
empresa donde trabajar — vamos a crearla.»

---

## 02 · Crear una empresa

*(Corregido el 2026-09-24: el segmento de segundo factor, que estaba en
el video 01, se mueve acá — es el punto real donde NEXO lo pide,
confirmado con una cuenta nueva real. Verificado también: la
jurisdicción ya viene en «Ciudad Autónoma de Buenos Aires» y el cierre
en `12-31` por defecto — no hace falta tocarlos si coinciden con el
dataset.)*

*(Nota del 2026-09-23, verificada contra el producto real: «Usar este
plan» carga **185** cuentas en total —confirmado contra el listado real
de «Configuración → Plan de cuentas», que dice «185 cuentas»—. De esas,
**143** son imputables (las que aceptan asientos); las otras 42 son
cuentas agrupadoras. El checklist de «Puesta en marcha» cuenta solo las
143 imputables en su columna «HAY», porque es lo que esa regla necesita
— no es un número distinto del real, es un conteo distinto. La
narración usa 185 porque describe lo que carga el botón, no el filtro
del checklist.)*

*(Corregido el 2026-09-23, agregado al final del video: la empresa se
creó con el plan NEXO Contable (el que propone el formulario de alta
por defecto), y ese plan deja fuera dominios enteros que el curso
necesita desde el video 06 en adelante — `products`, `stock`,
`comercial` (ventas y compras), `recuentos`, `caja`, `banks`, `cheques`,
`precios`, `activos`, `solicitudes-de-compra`, `recepciones`,
`ordenes-de-pago`, `valuacion`, verificado contra
`companies.fueraDelPlan` antes y después del cambio. Se agrega acá un
segmento real declarando el plan NEXO Gestión —mecanismo «Declarar el
plan» de la pantalla Plan, auditado por fecha, sin datos de tarjeta—,
para que el resto del curso se grabe con los módulos ya habilitados.)*

**Objetivo:** empresa creada, segundo factor configurado, con rol de
CONTADOR, plan de cuentas y ejercicio abiertos — la puesta en marcha
resuelta.

**Qué va a ver el alumno:** el formulario de alta de empresa, la
configuración del segundo factor que aparece justo después, el Panel
con «Puesta en marcha», el plan de cuentas modelo, la apertura del
ejercicio, y el cambio del plan de suscripción de NEXO Contable a NEXO
Gestión.

**Pantalla/recorrido:** «Crear mi empresa» → «Configurar el segundo
factor» → Panel → «Usar este plan» → Configuración → «Dar un rol» →
Períodos y cierre → «Abrir un ejercicio» → Plan → «Declarar el plan».

**Qué digo:**

> «Apenas entro, aparece sola esta pantalla: «Crear mi empresa». Cargo
> el nombre del estudio, la razón social — Ferretería El Tornillo Feliz
> S.R.L. —, el CUIT, el tipo de entidad — Sociedad de Responsabilidad
> Limitada. La jurisdicción y el cierre de ejercicio ya vienen
> propuestos. «Crear y empezar la prueba», y no me pide tarjeta.
>
> Y acá pasa algo importante: recién ahora, con la empresa creada, NEXO
> me pide configurar el segundo factor — porque el rol que acabo de
> recibir, ADMINISTRADOR, lo exige, y hasta configurarlo no me deja
> llegar a los datos de ninguna empresa. Aprieto «Generar el secreto»,
> escaneo este código QR con la app de autenticación de mi teléfono, y
> escribo los seis dígitos que me da. «Confirmar».
>
> Y esto — los diez códigos de recuperación — es lo más importante de
> este video: son la única forma de entrar si pierdo el teléfono. No hay
> botón para generar más. Los guardo en otro lado, ahora, antes de
> seguir.
>
> Ahora sí estoy en el Panel, y acá abajo dice «Puesta en marcha: 2
> cosas impiden registrar». NEXO no me hace adivinar qué falta: me lo
> dice y me da el botón exacto. Primero, «Usar este plan» — esto carga
> 185 cuentas de golpe, es el plan modelo, y siguen siendo mías: las
> puedo editar después.
>
> Segundo: quien crea la empresa —yo— recibe el rol ADMINISTRADOR, y a
> propósito **no** firma la contabilidad. Sin el rol CONTADOR no puedo
> ni subir un documento. Voy a Configuración, «Dar un rol», me elijo a
> mí mismo, elijo CONTADOR, «Dar el rol».
>
> Y el último paso: abrir el ejercicio. Períodos y cierre, «Abrir un
> ejercicio» — el código, desde y hasta ya vienen propuestos según el
> cierre que declaré. «Abrir el ejercicio», y ahora tengo doce períodos,
> el actual abierto. El Panel ya no muestra ningún bloqueo — la empresa
> está lista para operar.
>
> Una cosa más, antes de cerrar este video: esta empresa se creó con el
> plan NEXO Contable, el que propone el formulario por defecto. Voy a
> Plan, y en «Declarar el plan» registro el cambio a NEXO Gestión, con
> fecha de hoy — es un hecho declarado, con fecha, no una operación de
> pago: no pide datos de tarjeta. Este cambio habilita los módulos de
> Ventas, Compras, Productos y Existencias, entre otros, que vamos a usar
> en los videos que siguen.»

**Qué hago:** completar alta de empresa → «Crear y empezar la prueba» →
generar secreto MFA → escanear QR → confirmar código → Panel → «Usar
este plan» → Configuración → «Dar un rol» (CONTADOR, a mí mismo) →
Períodos y cierre → «Abrir un ejercicio» → Plan → «Declarar el plan»
(NEXO Gestión, estado Prueba, mismas fechas que la prueba vigente).

**Datos a preparar:** razón social, CUIT (`30-71234560-4`), tipo SRL —
todo del dataset. Jurisdicción y cierre ya vienen bien por defecto, no
hace falta escribirlos.

**Resultado visible:** segundo factor configurado; Panel sin bloqueos,
185 cuentas, ejercicio `ABIERTO` con 12 períodos; plan de suscripción
declarado como NEXO Gestión.

**Transición:** «Ya tenés una empresa operativa. Antes de seguir
cargando datos, veamos algo a lo que vas a volver todo el tiempo: la
bandeja de Pendientes.»

---

## 03 · Pendientes

*(Corregido el 2026-09-23 contra el producto real: al llegar a este
punto de la producción, la empresa ya no tiene ningún pendiente
`BLOQUEADO` — el único que existía, «ningún ejercicio abierto», se
resolvió en el video 02. El guion anterior asumía que seguiría ahí. La
bandeja real, en cambio, muestra 8 pendientes `REQUIERE_APROBACION`
—uno por cada período mensual ya terminado que sigue abierto—, todos
`accionable` y ninguno bloqueante. Se usa ese ejemplo real, y para el
concepto de "bloqueante" se referencia el que ya se vio y se resolvió en
el video anterior, en vez de mostrar uno nuevo que no existe.)*

**Objetivo:** que el alumno entienda que Pendientes es el lugar al que
siempre puede volver cuando no sabe qué hacer.

**Qué va a ver el alumno:** la bandeja, el filtro por categoría, el
filtro «solo bloqueantes» dando vacío, y un pendiente real que no
bloquea.

**Pantalla/recorrido:** Inicio → Pendientes.

**Qué digo:**

> «Esta pantalla es la única a la que conviene volver todo el tiempo
> cuando no sabés qué hacer. Se llama Pendientes, está en el grupo
> Inicio. Cada fila acá es algo real que la base de datos ya sabe —
> nadie la escribe a mano.
>
> Ahora mismo tengo ocho: «El período terminó y sigue abierto», uno por
> cada mes que ya pasó. Son de la categoría REQUIERE_APROBACIÓN, y fijate
> la disponibilidad: «accionable», no «bloqueante» — puedo seguir
> trabajando con estos ocho ahí, sin resolverlos ya.
>
> Y para que se note la diferencia: filtro «solo bloqueantes», y queda
> vacío. Ningún pendiente me impide operar en este momento. El único que
> tuve —«esta empresa no tiene ningún ejercicio abierto»— era categoría
> BLOQUEADO, y lo resolví en el video anterior apretando «abrir», que me
> llevó directo a la pantalla donde se resuelve, no a una explicación.
> Esa es la diferencia que importa: siete categorías, y solo una parte de
> ellas te impide seguir trabajando.»

**Qué hago:** Pendientes → mostrar filtro de categoría → filtrar «solo
bloqueantes» (queda vacío) → volver a «no filtrar» → abrir uno de los
pendientes `REQUIERE_APROBACION` de período.

**Datos a preparar:** empresa recién salida del video 02 — cuentas,
ejercicio y rol CONTADOR ya resueltos, ningún comprobante ni asiento
cargado todavía.

**Resultado visible:** bandeja con 8 `REQUIERE_APROBACION` accionables,
cero bloqueantes, diferencia clara entre "bloquea" y "no bloquea".

**Instrucción de seguridad de grabación:** si al filmar aparece
cualquier pendiente sobre un asiento o un comprobante (categorías que
todavía no se enseñaron), se corta y se regraba con una empresa limpia.

**Transición:** «Con esto ya sabés a dónde volver si te perdés. Ahora sí,
empecemos a cargar lo que NEXO necesita para trabajar por vos: el mapeo
contable.»

---

## 04 · Mapeo contable

*(Corregido el 2026-09-23 contra el producto real: el `<select>` de rol
en el formulario de «Mapeo contable» solo listaba 6 de los 8 roles —
faltaban `MERCADERIA` y `COSTO_DE_VENTAS`, aunque el backend los
soporta desde la migración `0079_asiento_de_costo_de_ventas.sql`. Era
un bug de UI, no una funcionalidad inexistente. Se agregaron las dos
opciones faltantes a `apps/web/consola.html` — autorizado explícitamente
— y con eso el flujo de los 8 roles que describe este guion es real.)*

**Objetivo:** declarar los roles contables para que NEXO pueda proponer
asientos.

**Qué va a ver el alumno:** la pantalla de mapeo, la declaración de un
rol, y el aviso de "completo".

**Pantalla/recorrido:** Configuración → Mapeo contable.

**Qué digo:**

> «El mapeo contable es la respuesta a una sola pregunta: cuando vendo,
> ¿en qué cuenta anoto? Sin esto, NEXO no puede proponerte nada — podés
> seguir cargando asientos a mano, pero te perdés la propuesta
> automática.
>
> Elijo el rol — CLIENTES —, escribo el código de la cuenta —
> `1.1.03.01` —, y «Declarar». Lo repito con PROVEEDORES, IVA_DÉBITO,
> IVA_CRÉDITO, VENTAS y COMPRAS. Como esta ferretería tiene stock, sumo
> también MERCADERÍA y COSTO_DE_VENTAS.
>
> Dos errores típicos, para que no te pasen: `4.1` no sirve para VENTAS
> porque es una cuenta agrupadora — tiene que ser `4.1.01`. Y una cuenta
> de "Anticipos a proveedores" no sirve para el rol PROVEEDORES, porque
> es del activo, no del pasivo.
>
> Cuando declaro el último rol, el aviso de arriba cambia de «Faltan:
> …» a «Está completo.» — ahí sé que terminé.»

**Qué hago:** declarar los 8 roles uno por uno (tabla completa en
`09-dataset-demo.md`) → mostrar el aviso final.

**Datos a preparar:** las 8 cuentas del mapeo, ya listadas en el
dataset.

**Resultado visible:** «Está completo.»

**Transición:** «El mapeo ya está. Ahora necesitamos con quién y qué
vender — vamos a cargar los terceros.»

---

## 05 · Terceros

**Objetivo:** dar de alta los tres terceros del curso y entender la
ficha de tercero.

**Qué va a ver el alumno:** alta de un cliente Responsable Inscripto,
un cliente Consumidor Final, y un proveedor — la ficha de uno de ellos,
y una edición con motivo.

**Pantalla/recorrido:** Ventas → Terceros → «Dar de alta» (×3).

**Qué digo:**

> «Un tercero es cualquier cliente o proveedor. Vamos a cargar los tres
> que vamos a usar en todo el curso, así no aparece ninguno de la nada
> más adelante.
>
> Primero, Maderera San Martín: «Dar de alta», documento, razón social,
> condición de IVA — Responsable Inscripto —, contacto. Guardo.
>
> Ahora un cliente distinto: el Kiosco de Doña Rosa. Mismo botón, pero
> la condición de IVA es Consumidor Final — no lleva CUIT de empresa,
> lleva el documento de la persona. Guardo.
>
> Y el tercero que nos va a vender a nosotros: Distribuidora Ferrolux.
> Mismo formulario — lo único que cambia es que, cuando lo usemos, va a
> aparecer del lado de proveedor y no de cliente. NEXO no separa el
> alta por rol: un tercero es un tercero, y el rol lo define la
> operación.
>
> Entro a la ficha de Maderera con «ficha». Acá corrijo nombre,
> contacto, lo que sea — siempre con un motivo, porque queda en la
> bitácora. Lo que **no** puedo editar es el documento: si me equivoco
> el CUIT, no lo piso — lo archivo y doy de alta uno nuevo. Es a
> propósito: mueve la trazabilidad, no un capricho de la pantalla.»

**Qué hago:** «Dar de alta» → Maderera San Martín S.A. (RI) → guardar →
«Dar de alta» → Kiosco Doña Rosa (Consumidor Final) → guardar → «Dar de
alta» → Distribuidora Ferrolux S.A. (RI) → guardar → «ficha» de
Maderera → editar un campo con motivo.

**Datos a preparar:** los 3 terceros completos del dataset — Maderera
San Martín S.A. (`30-71234561-2`, RI), Kiosco Doña Rosa (consumidor
final), Distribuidora Ferrolux S.A. (`30-71234562-0`, RI).

**Resultado visible:** los 3 terceros listados, ficha de Maderera
editada.

**Transición:** «Con los tres terceros cargados, falta lo que le vamos a
vender — los productos.»

---

## 06 · Productos

*(Corregido el 2026-09-23, error de producción propio, no del guion: la
primera captura de este video dio de alta los tres productos con
códigos y precios inventados en el momento (`TOR-001`, `PIN-001`,
`SRV-001`) en lugar de consultar el dataset canónico de
`docs/curso/09-dataset-demo.md`. Se detectó antes de cerrar el video, se
archivaron esos tres productos desde su ficha —ESTADO → ARCHIVADO, con
motivo, nunca se borran— y se recapturaron los tres altas y el recuento
físico usando los códigos reales del dataset: `PROD-001` (Tornillo
autorroscante 6x1", caja x100), `PROD-002` (Pintura látex interior 20L)
y `PROD-003` (servicio de corte de madera). El guion de abajo no
mencionaba códigos explícitos y no necesitó cambios; esta nota deja
registrado por qué las capturas finales usan `PROD-00N` y no los
nombres de prueba de la primera pasada. Nota aparte, no de guion: el
alta y archivado de los productos de prueba dejó una fila residual de
existencia («TOR-001 · 10.0000», con último movimiento 2026-09-23)
visible en la tabla de Existencias — el producto está ARCHIVADO pero el
libro de movimientos, por diseño, no se reescribe ni se borra una vez
escrito. No se tocó: es un rastro real de la corrección, coherente con
que en NEXO «un error se arregla con otro movimiento», y queda para que
el alumno lo vea o no según se decida al armar el video final.)*

**Objetivo:** dar de alta los tres productos del curso y entender qué
distingue a uno con stock de uno sin stock.

**Qué va a ver el alumno:** alta de dos productos con stock y uno sin
stock (un servicio), y un ajuste de existencias inicial.

**Pantalla/recorrido:** Ventas → Productos → «Dar de alta» (×3) →
Operación → Existencias → «Depósitos» → «Dar de alta el depósito» →
«Recuento físico» → «Abrir recuento» → «Cerrar y ajustar».

**Qué digo:**

> «Cargo el tornillo autorroscante: código, nombre, unidad — caja —, y
> el tratamiento impositivo. Este producto **lleva stock**. Guardo.
>
> Ahora la pintura látex, de veinte litros — también lleva stock.
>
> Y un producto distinto: el corte de madera a medida. Es un servicio,
> se factura por hora, y **no lleva stock** — no hay nada que contar en
> un depósito. Esa casilla es la que decide si el producto va a
> aparecer después en Existencias o no.
>
> Como con los terceros: puedo editar nombre y precio desde la ficha,
> siempre con motivo, pero no el código ni el tratamiento impositivo —
> mismo principio de trazabilidad.
>
> Una cosa más, antes de seguir: esta empresa todavía no tiene ni un
> depósito declarado, y un producto recién creado no tiene ningún stock
> todavía — no se puede vender lo que no existe. En Existencias,
> «Depósitos», doy de alta el depósito principal.
>
> Y para cargar el stock, NEXO no tiene un botón de «cargar stock
> inicial» — la única puerta de entrada sin pasar por una compra es un
> recuento físico: contás lo que hay de verdad, y la diferencia contra
> lo que el libro dice —cero, en este caso— se convierte sola en el
> movimiento que da de alta el stock. Abro un recuento, declaro diez
> cajas contadas de tornillo autorroscante, y «Cerrar y ajustar». Es la
> misma pantalla que vamos a ver en detalle en el video 14 — acá la
> usamos una vez, para arrancar.»

**Qué hago:** dar de alta Tornillo autorroscante (con stock) → dar de
alta Pintura látex interior 20L (con stock) → dar de alta Servicio de
corte de madera (sin stock) → Existencias → «Depósitos» → «Dar de alta
el depósito» → «Recuento físico» → «Abrir recuento» → declarar 10
unidades contadas de Tornillo autorroscante → «Guardar el recuento» →
«Cerrar y ajustar».

**Datos a preparar:** los 3 productos del dataset; sin este recuento
inicial, la venta del video 11 no tiene stock del que descontar.

**Resultado visible:** tres productos listados (dos con stock, uno sin);
10 cajas de tornillos en existencias, dadas de alta por el ajuste del
recuento.

**Transición:** «Terceros y productos, listos. Antes de vender nada,
vamos a darle acceso a tu contador — usuarios y permisos.»

---

## 07 · Usuarios y permisos

*(Corregido el 2026-09-24 contra el producto real: al llegar a este video,
la cuenta de producción de Mariana Sosa ya tenía, además de ADMINISTRADOR,
el rol CONTADOR — otorgado en una sesión de grabación anterior para poder
probar la separación proponer/aprobar de un asiento en otro video de esta
misma tanda. Se verificó en el código (`apps/api/src/routes/onboarding.ts`)
que el alta de una empresa solo otorga ADMINISTRADOR a quien la crea — la
premisa de la narración de abajo es correcta como regla general — y que no
existe ninguna ruta para quitar un rol ya otorgado (`apps/api/src/routes/
studio.ts` solo tiene `POST .../roles`, sin equivalente de baja). No se
tocó la base para forzar el estado "limpio": revertirlo a mano hubiera sido
fabricar un estado que la aplicación real no ofrece deshacer. Consecuencia
visible: en la tabla «Personas con acceso» de este video, la fila de
Mariana Sosa va a mostrar los dos roles, no uno solo. No es un error de
captura — es el estado real y permanente de esta empresa de demostración a
partir de acá.)*

*(Corrección adicional, 2026-09-24: la premisa de más abajo — «la persona
tiene que existir y tener su correo confirmado antes de aparecer acá» —
también resultó falsa contra el producto real. Julián Ferreyra existía
como usuario confirmado (alta pública + verificación de correo, el mismo
mecanismo del video 01) y aun así NO aparecía en el selector de «Dar un
rol». Causa real, verificada en el código: esa pantalla arma su lista a
partir de quien YA tiene un rol en esta empresa (`GET
/companies/current/users`), y el backend que de verdad otorga el rol
(`grant_company_role`, migración 0014) exige además que la persona
pertenezca al mismo estudio (`organization_members`) — algo que el alta
pública (`POST /auth/signup`) nunca otorga; ese usuario nace sin ninguna
membresía (`apps/api/src/routes/onboarding.ts`). El único camino real
para que alguien ajeno empiece a existir para el estudio es `POST
/organizations/:organizationId/users` («alta de usuario del estudio»),
que hasta este video no tenía ningún botón en la consola. Se agregaron
dos cambios reales, mínimos, sin endpoints nuevos: un botón para esa ruta
(«Alta de una persona nueva en el estudio», en Configuración, arriba de
«Dar un rol») y una corrección en `GET /companies/current/users` para que
liste también a quien pertenece al estudio pero todavía no tiene rol en
esta empresa puntual. Sin esos dos cambios este video no se podía grabar
tal como estaba escrito. «Qué va a ver el alumno», «Pantalla/recorrido»,
«Qué digo», «Qué hago» y «Datos a preparar» quedan corregidos abajo para
reflejar el flujo real de dos pasos.)*

**Objetivo:** dar de alta a una persona nueva en el estudio y, a partir de
ahí, darle un rol en la empresa — y entender la diferencia entre
ADMINISTRADOR y CONTADOR.

**Qué va a ver el alumno:** el alta de una persona nueva en el estudio y,
con esa alta ya hecha, el alta de un rol para esa misma persona.

**Pantalla/recorrido:** Configuración → «Alta de una persona nueva en el
estudio» → «Personas con acceso» → «Dar un rol».

**Qué digo:**

> «Ya vimos que quien crea la empresa recibe ADMINISTRADOR y no firma la
> contabilidad — es a propósito. Ahora vamos a sumar a Julián, que es
> quien realmente va a cargar y aprobar asientos.
>
> Primero tiene que existir para el estudio — no alcanza con que tenga
> una cuenta en NEXO, tiene que pertenecer a este estudio en particular.
> Configuración, «Alta de una persona nueva en el estudio»: correo,
> nombre y una contraseña provisoria. Esto todavía no le da acceso a
> ninguna empresa — solo hace que exista para que se lo pueda elegir.
>
> Ahora sí, «Personas con acceso», «Dar un rol». Elijo a Julián, elijo
> CONTADOR, «Dar el rol». Listo — ya aparece en la lista con su rol.»

**Qué hago:** Configuración → «Alta de una persona nueva en el estudio»
→ correo `julian.ferreyra@demo-nexo.test`, nombre «Julián Ferreyra»,
contraseña provisoria → «Dar de alta en el estudio» → «Personas con
acceso» → «Dar un rol» → elegir Julián Ferreyra → CONTADOR → «Dar el
rol».

**Datos a preparar:** ninguno de antemano — a diferencia de lo que decía
la versión anterior de este guion, el alta de Julián se graba completa en
este video; no se prepara ni se muestra en el video 01.

**Resultado visible:** «Alta hecha.», después «Rol otorgado.», Julián
listado con CONTADOR.

**Transición:** «Con dos personas trabajando, vamos a conectar NEXO con
ARCA.»

---

## 08 · Certificado ARCA

**Objetivo:** cargar un certificado y entender qué habilita.

**Qué va a ver el alumno:** la carga de un certificado de homologación y
la lista de servicios habilitados.

**Pantalla/recorrido:** Configuración → «Cargar un certificado».

**Qué digo:**

> «Antes de seguir: NEXO no emite facturas con CAE — lo vamos a repetir
> en el último video, pero conviene decirlo ya. Lo que sí hace es
> registrar tus comprobantes y constatarlos contra ARCA, para saber si
> coinciden. Para eso hace falta un certificado.
>
> «Cargar un certificado» — subo el archivo. Este es de homologación, el
> ambiente de pruebas de ARCA, nunca uno real en un video. Guardo, y acá
> abajo aparece la lista de servicios habilitados: exactamente lo que
> ese certificado autoriza, ni más ni menos.»

**Qué hago:** Configuración → «Cargar un certificado» → seleccionar
archivo de homologación → guardar → mostrar servicios habilitados.

**Datos a preparar:** un certificado de **homologación** generado para
este dataset — nunca el certificado real del proyecto.

**Resultado visible:** certificado listado, servicios habilitados
visibles.

**Transición:** «La empresa ya está configurada de punta a punta. Ahora
sí: el trabajo de todos los días. Empezamos por subir un documento.»

---

## 09 · Documentos

**Estado: `VIDEO_FINAL`** (2026-09-30) — `MASTER/video09-nexo-desde-cero.mp4`,
890×444, 25 fps, H.264/AAC, 32,17 s. Narración real generada con **Piper TTS**
(motor MIT, 100% local, sin API ni créditos), voz **Daniela** (`es_AR-daniela-high`,
22.050 Hz, dataset OpenSLR SLR61, licencia CC BY-SA 4.0) — reemplaza a
ElevenLabs/Helena únicamente porque esta cuenta no tiene créditos; la narración
sigue el "Qué digo" de abajo palabra por palabra, dividido en 6 segmentos para
sincronizar con las 6 capturas reales ya existentes de este mismo video
(`scratchpad/produccion/video09/stills/`). Detalle completo, texto exacto de
cada segmento y la única adaptación de locución (`SIN_MOTOR_OCR` → "sin motor
OCR", para que el sintetizador no deletree "SIN" letra por letra) en
`scratchpad/produccion/video09/guion-audio.txt`. Esta es ahora la voz y el
motor de narración del curso — la misma voz se reutiliza para los 25 videos
restantes, no una distinta por video.*

*(Corregido el 2026-09-24 contra el producto real: «corregir» un campo estaba
roto. El botón «Guardar corrección» mandaba `{ campos: [{ fieldPath, value }] }`
a `POST /documents/:id/fields`, y esa ruta real exige `{ extractionId,
fieldPath, rawValue, motivo }` — nombres distintos, sin el id de la extracción
vigente, y sin ningún campo «Motivo» en el formulario para juntarlo. Toda
corrección fallaba con «Datos inválidos», siempre, para cualquier campo —no
era un problema del dato de este video. Se corrigieron `apps/web/consola.html`
(`abrirDocumento` ahora guarda `estado.extraccionActual`; se agregó el input
«Motivo»; el handler manda el cuerpo real) sin tocar el backend, que ya
estaba bien. Verificado en vivo: la corrección quedó guardada con método
`MANUAL` **al lado** de la lectura `XML` original, exactamente como describe
«Qué digo» de este video — las dos quedan, ninguna se pisa. Se corrieron
`tests/integration/documents-api.test.ts` (8/8) sin regresiones.

También corregido: el dataset de este video no es
`factura-prueba-nexo-0001-00000102.xml`. `docs/curso/09-dataset-demo.md`
(«Para los videos que reutilizan la evidencia real») dice reutilizarlo acá;
este guion y `docs/MANUAL-USUARIO-NEXO.md` dicen lo contrario —ese archivo
fue una verificación real puntual contra producción el 2026-09-22, citada
como antecedente en el video 31, nunca para cargar en la empresa de
demostración—. Se siguió este guion, ya que mezclar una operación de
producción real con el dataset ficticio de la Ferretería contradice la razón
de ser del dataset separado. `09-dataset-demo.md` queda con una nota
pendiente de actualizar, no se tocó en esta pasada. Se generó un XML propio
del dataset —perfil WSFEV1 (`Cuit`, `DocNro`, `CbteFch`, etc., según
`packages/document-engine/src/readers/xml.ts`)—, con CUIT emisor
30712345604 (Ferretería) y receptor 30712345612 (Maderera San Martín),
comprobante 0001-00000005, $12.100 total ($10.000 + 21% IVA), fecha
2026-09-24. El archivo no se conserva en el repositorio.)*

**Objetivo:** subir un documento y revisar lo que NEXO leyó solo.

**Qué va a ver el alumno:** la subida de un XML, la extracción
automática, la corrección de un campo.

**Pantalla/recorrido:** Operación → Documentos.

**Qué digo:**

> «Subo una factura en XML. «Subir», y sin que yo haga nada más, NEXO la
> lee: queda en estado EXTRAÍDO. Abro el documento y veo «Lo que se
> leyó» — los importes, la fecha, todo con su confianza.
>
> Si algo salió mal leído, lo corrijo acá con «corregir» — el valor
> nuevo y «Guardar corrección». Esto no reemplaza ninguna validación del
> backend, que sigue siendo la autoridad: me ahorra el viaje de mandar
> algo que ya sé que está mal.
>
> Con PDF o imagen sin motor de OCR instalado, la lectura contesta
> `SIN_MOTOR_OCR` — por eso en este curso trabajamos con XML, que
> siempre funciona.»

**Qué hago:** «Subir» → documento pasa a EXTRAIDO → abrir → mostrar
campos leídos → corregir uno.

**Datos a preparar:** un XML de factura generado para el dataset del
curso (no el archivo real de la verificación en producción,
`factura-prueba-nexo-0001-00000102.xml` — ese tiene datos reales de esa
prueba puntual, no de la Ferretería; se cita como antecedente en el
video 31, no se reutiliza acá). Fecha dentro del período abierto de la
empresa del curso al momento de grabar.

**Resultado visible:** documento en EXTRAIDO, campos leídos, corrección
guardada.

**Transición:** «El documento está leído. El siguiente paso es
convertirlo en un comprobante real.»

---

## 10 · Comprobantes

**Estado: `VIDEO_FINAL`** (2026-10-01) — `MASTER/video10-nexo-desde-cero.mp4`,
890×444, 25fps, H.264/AAC, 34,01s. Narración con Piper TTS (voz Daniela,
es_AR). Evidencia en `scratchpad/produccion/video10/`.

**Objetivo:** registrar el comprobante de un documento ya leído.

**Qué va a ver el alumno:** la dirección del comprobante, los importes
confirmados, el registro.

**Pantalla/recorrido:** Documentos → detalle del documento → «Registrar
el comprobante».

**Qué digo:**

> «Con el documento en EXTRAÍDO, bajo hasta «Registrar el comprobante».
> Acá está casi todo precargado de lo que se leyó. Lo único que **no**
> se deduce solo es la dirección — COMPRAS o VENTAS. Este documento es
> una venta, así que elijo VENTAS.
>
> ¿Por qué no lo deduce NEXO? Porque comparar contra el CUIT de la
> empresa sería adivinar en los casos donde el documento no trae a la
> empresa entre sus partes. Equivocar la dirección invierte el asiento
> entero — mejor preguntarlo que arriesgar eso.
>
> Reviso el total, «Registrar el comprobante». Y ahí queda: comprobante
> registrado, con sus importes fijados. Ahí empieza lo contable.»

**Qué hago:** elegir dirección VENTAS → confirmar importes → «Registrar
el comprobante».

**Datos a preparar:** el mismo XML del video 09, ya en EXTRAIDO.

**Resultado visible:** «Comprobante registrado.»

**Transición:** «Ya tenés tu primer comprobante. Pero antes de llevarlo a
un asiento, veamos el circuito completo de una venta desde el principio:
presupuesto y pedido.»

---

## 11 · Ventas

**Estado: `VIDEO_FINAL`** (2026-10-01) — `MASTER/video11-nexo-desde-cero.mp4`,
890×444, 25fps, H.264/AAC, 41,88s. Narración con Piper TTS (voz Daniela,
es_AR). Evidencia en `scratchpad/produccion/video11/`.

**Objetivo:** recorrer el ciclo comercial completo, de un pedido a la
operación fiscal.

**Qué va a ver el alumno:** un pedido con sus renglones, su recorrido de
estados, y la factura registrada desde ahí.

**Pantalla/recorrido:** Ventas → Comercial → «Nuevo presupuesto o
pedido» → «Cargar el detalle» → «Emitir» → «Aceptar» → «Facturar».

**Qué digo:**

> «Comercial es donde vive todo lo que pasa **antes** de facturar. Acá
> hay dos tipos de documento, Presupuesto y Pedido — se eligen al
> crearlo, uno no se transforma en el otro. Un presupuesto tiene fecha
> de vencimiento y no compromete todavía; un pedido sí. Vamos a cargar
> un pedido directo.
>
> «Nuevo presupuesto o pedido»: dirección VENTAS, tipo PEDIDO, el
> tercero — Maderera San Martín —, la fecha. «Crear en borrador».
>
> Ahora cargo el detalle: elijo el producto, tornillo autorroscante, la
> cantidad — dos —, y el precio, que puedo traer solo con «Traer el
> precio» o escribir a mano. «Agregar renglón», y «Guardar el detalle».
>
> El documento tiene un recorrido de estados, y cada botón aparece solo
> si la transición es legal: «Emitir» lo manda, «Aceptar» registra que
> el cliente lo aceptó. Recién ahí, con el pedido ACEPTADO, aparece la
> sección «Facturar» — no antes. Completo el tipo de comprobante, punto
> de venta y número, y «Registrar la operación fiscal». Los importes no
> se escriben acá: salen de los renglones que ya guardamos. Es lo que
> garantiza que factures exactamente lo que el cliente aceptó.»

**Qué hago:** «Nuevo presupuesto o pedido» → VENTAS, PEDIDO, Maderera
San Martín → «Crear en borrador» → agregar renglón (2 cajas de tornillo
autorroscante) → «Guardar el detalle» → «Emitir» → «Aceptar» → completar
tipo/punto de venta/número → «Registrar la operación fiscal».

**Datos a preparar:** Maderera San Martín ya cargada (video 05), tornillo
autorroscante ya cargado con 10 cajas de stock inicial (video 06), 2
unidades × $1.850.

**Resultado visible:** pedido en estado FACTURADO, operación fiscal
registrada.

**Transición:** «Así se vende desde el lado comercial. Ahora, el mismo
recorrido pero del lado de las compras.»

---

## 12 · Compras

**Estado: `VIDEO_FINAL`** (2026-10-01) — `MASTER/video12-nexo-desde-cero.mp4`,
890×444, 25fps, H.264/AAC, 66,17s. Narración con Piper TTS (voz Daniela,
es_AR). Evidencia en `scratchpad/produccion/video12/` (incluye nota de
contenido: la orden de pago a Ferrolux ya está PAGADA en este entorno,
no "aprobada sin pagar" como narra el guion original — ver nota en
`guion-audio.txt`).

*(Corregido el 2026-09-24 contra el producto real: este video tenía tres
discrepancias, dos de ellas bugs reales, no solo de guion.

**(1) La solicitud nunca tiene proveedor ni precio.** El guion decía «Crear
la solicitud — cincuenta baldes de Distribuidora Ferrolux», como si el
proveedor se eligiera ahí. La pantalla real lo dice explícitamente: «Una
solicitud no dice a quién comprarlo ni a cuánto: eso lo dice el proveedor
después» — no hay ningún campo de tercero en «Pedir una compra». El flujo
real, verificado de punta a punta: Solicitud (sin proveedor, aprobada) →
Comercial, un «Pedido» con dirección COMPRAS, ahí sí con proveedor y
precio (misma pantalla que ya usa Ventas en el video 11) → emitido y
aceptado → «Facturar» ese pedido (paso que tampoco estaba en el guion
anterior, y que Pagos necesita: «Ver qué se le debe» no encuentra nada
hasta que existe una operación fiscal real) → volver a la solicitud
aprobada y «Citar la orden de compra», que la deja CONVERTIDA.

**(2) «Confirmar lo que llegó» estaba roto para cualquier producto con
stock.** `POST /goods-receipts/:id/confirm` exige `depositoId` cuando algún
renglón lleva un producto con stock (migración 0054), y la consola no tenía
ningún control para mandarlo — ni en el alta de la recepción ni en la
confirmación. Confirmar fallaba siempre con «indicá el depósito», para
cualquier recepción real, no por un dato mío. Se agregó un selector de
«Depósito» junto a «Confirmar lo que llegó» en `apps/web/consola.html`
(`abrirRecepcion`/`accionRecepcion`), reusando `GET /warehouses`, que ya
existía para Existencias. No se tocó el backend, que ya pedía el dato
correcto.

**(3) Bug menor de paso:** el selector «Orden de compra que salió de esta
solicitud» mostraba «· undefined» al final de cada opción —
`cargarOrdenesParaSolicitud` leía `d.estado`, y el campo real que devuelve
`GET /commercial-documents` es `d.status`. Corregido en la misma pasada.

Verificado con `tests/integration/recepcion-de-compras.test.ts` (14/14) y
`tests/integration/solicitudes-de-compra.test.ts` (10/10), sin
regresiones. «Qué digo», «Qué hago» y «Datos a preparar» quedan
reescritos abajo para el flujo real de cuatro pantallas, no tres.)*

**Objetivo:** recorrer el ciclo de compras, de la solicitud a la orden
de pago aprobada.

**Qué va a ver el alumno:** una solicitud de compra aprobada y convertida,
la orden de compra que le dio proveedor y precio, la recepción de la
mercadería, la factura registrada, y una orden de pago armada y
aprobada.

**Pantalla/recorrido:** Compras → Solicitudes → Comercial → Recepciones →
Comercial (Facturar) → Solicitudes (citar) → Pagos.

**Qué digo:**

> «Necesito reponer pintura. Voy a Solicitudes, «Pedir una compra» —
> cincuenta baldes, para reponer stock. Una solicitud no dice a quién
> comprarlo ni a cuánto: eso todavía no se sabe acá. La mando con
> «Enviar a aprobar», y alguien con el permiso la aprueba con
> «Aprobar».
>
> Aprobada, el aviso es explícito: falta armar la orden de compra, el
> proveedor y los precios no salen de esta pantalla. Voy a Comercial,
> un pedido nuevo con dirección COMPRAS — Distribuidora Ferrolux,
> cincuenta baldes a su precio de lista —, lo emito y lo acepto. Vuelvo
> a la solicitud y «Citar la orden de compra»: queda CONVERTIDA, las dos
> puntas atadas.
>
> Cuando llega la mercadería, la registro en Recepciones — «Crear en
> borrador» contra esa misma orden, cargo lo que llegó y «Confirmar lo
> que llegó», declarando el depósito porque la pintura lleva stock.
>
> Todavía falta la tercera punta: facturar. Vuelvo al pedido de compra
> y «Registrar la operación fiscal» — recién ahí la conciliación de
> tres puntas dice «coincide»: pedido, recibido y facturado, los tres
> cincuenta.
>
> Y en Pagos armo la orden para Ferrolux: «Ver qué se le debe» me trae
> el pendiente real de sus comprobantes — recién ahora aparece, porque
> antes no había ninguna operación fiscal—, elijo cuáles pagar, y la
> apruebo con «Aprobar». Ahí queda: aprobada, esperando el pago.
>
> Lo que todavía no hacemos acá es «Registrar el pago» — ese botón pide
> el asiento del pago ya aprobado, y todavía no vimos cómo cargar un
> asiento a mano. Lo cerramos en el video 16, cuando ya sepamos hacerlo.»

**Qué hago:** Solicitudes → «Pedir una compra» → «Enviar a aprobar» →
«Aprobar» → Comercial → nuevo pedido COMPRAS (Ferrolux, 50 baldes) →
«Emitir» → «Aceptar» → Solicitudes → «Citar la orden de compra» →
Recepciones → «Crear en borrador» (contra la orden) → «Cargar lo que
llegó» → «Confirmar lo que llegó» (con depósito) → Comercial → el mismo
pedido → «Facturar» → Pagos → «Armar una orden» → «Ver qué se le debe» →
elegir comprobante → «Aprobar».

**Datos a preparar:** Distribuidora Ferrolux ya cargada (video 05), 50
baldes de pintura (PROD-002) × $28.400 (precio de lista real del
producto).

**Resultado visible:** solicitud aprobada, recepción registrada, orden
de pago en estado APROBADA (sin pagar todavía).

**Transición:** «Ya compramos y vendimos. Ahora, dónde vive el dinero:
caja, bancos y cheques.»

---

## 13 · Caja, bancos y cheques

**Estado: `VIDEO_FINAL`** (2026-09-30) — `MASTER/video13-nexo-desde-cero.mp4`,
890×444, 25fps, H.264/AAC, 52,44s. Narración con Piper TTS (voz Daniela,
es_AR), mismo motor y voz que el resto del curso. Evidencia completa en
`scratchpad/produccion/video13/`.

**Objetivo:** abrir una caja, dar de alta una cuenta bancaria, y ver la
cartera de cheques.

**Qué va a ver el alumno:** el alta y apertura de una caja, el alta de
una cuenta bancaria, la cartera de cheques.

**Pantalla/recorrido:** Dinero → Caja → Bancos → Cheques.

**Qué digo:**

> «Todo el dinero de la empresa vive en este grupo: Caja, Bancos,
> Cheques. Empezamos por Caja — y acá hay un paso que se salta fácil:
> antes de abrir una sesión, tengo que **dar de alta la caja en sí**.
> «Dar de alta una caja»: un código, un nombre, y opcionalmente la
> cuenta contable que la representa. «Crear».
>
> Recién ahora puedo abrirla: «Abrir una caja», elijo la que acabo de
> crear, declaro el saldo inicial — cincuenta mil pesos —, «Abrir». Ojo:
> el saldo **no se arrastra** del cierre anterior — se declara cada vez,
> a propósito, para que un error de conteo no se propague solo.
>
> A partir de acá registro movimientos — un cobro en efectivo del
> Kiosco Doña Rosa — y cuando cierro, declaro lo contado. Si no coincide
> con lo teórico, la diferencia queda escrita, no desaparece.
>
> Bancos: «Dar de alta» una cuenta con el banco, el titular y el CBU —
> acá el fixture del curso. Y Cheques: «Cargar un cheque» — la cartera
> de los que la empresa recibió y emitió, cada uno con su estado.»

**Qué hago:** Caja → «Dar de alta una caja» → «Crear» → «Abrir una caja»
→ saldo inicial → «Abrir» → registrar un movimiento → Bancos → «Dar de
alta» cuenta bancaria → Cheques → «Cargar un cheque».

**Datos a preparar:** caja nueva con código `CAJA-01`, nombre "Caja
Principal" (código y nombre fijados acá para no improvisarlos en
cámara); fixture bancario `BANCO-DEMO-01` (Banco Ficticio del Sur, CBU
`0999999900000012345678`, alias `FERRETERIA.DEMO.NEXO`,
`09-dataset-demo.md`); un cobro de $1.850 del Kiosco Doña Rosa, ya
cargado como tercero en el video 05.

**Resultado visible:** caja abierta con un movimiento, cuenta bancaria
listada, un cheque en la cartera.

**Transición:** «Con el dinero bajo control, veamos qué pasa con lo que
tenés guardado: existencias.»

---

## 14 · Existencias

*(Corregido el 2026-09-25, error de producción propio, no del guion: la
primera captura de este video cerró un recuento con «Cerrar y ajustar»
inmediatamente después de «Agregar al borrador», sin pasar por «Guardar
el recuento». En la pantalla real, «Agregar al borrador» solo apila el
renglón en el estado local del navegador — no llama a la API. Recién
«Guardar el recuento» hace el `PUT /stock-counts/:id/lines` que persiste
los renglones; «Cerrar y ajustar» cierra el recuento con lo que ya esté
guardado en el backend, no con lo que se ve en la tabla en pantalla. El
resultado fue un recuento CERRADO con 0 renglones y sin movimiento de
ajuste — pero con el mismo mensaje de éxito «Recuento cerrado: las
diferencias se ajustaron», que no advierte que ajustó cero diferencias.
No es un bug de NEXO: el recuento cerrado vacío es un estado real y
válido (append-only, no se reescribe ni se borra), y el flujo funciona
si se sigue completo. Se abrió un segundo recuento el mismo día,
repitiendo el paso «Guardar el recuento» antes de cerrar, y esta vez el
Mayor de movimientos muestra el `AJUSTE_NEGATIVO 2.0000` esperado, con
motivo «Recuento físico del 2026-09-24». El «Qué hago» de abajo se
corrige para nombrar el paso explícitamente.)*

**Objetivo:** confirmar la salida de stock de una venta, ver el stock
por depósito, y hacer un recuento físico.

**Qué va a ver el alumno:** una venta pendiente de descontar stock, el
stock de un producto por depósito, y un recuento con diferencia.

**Pantalla/recorrido:** Operación → Existencias → «Ventas que esperan su
salida de stock» → «Buscar ventas pendientes» → «Recuento físico».

**Qué digo:**

> «Acá veo cuánto tengo de cada producto, por depósito y por lote. Las
> entradas se cargan por una recepción de compra o por el ajuste de un
> recuento — ya vimos las dos. Las salidas son distintas: un comprobante
> de venta **no** dice de qué depósito salió la mercadería, así que no
> se descuenta sola.
>
> «Ventas que esperan su salida de stock» — acá está la venta del video
> 11, todavía pendiente. Confirmo el depósito y se genera el movimiento.
> Recién ahora el stock de tornillos bajó de verdad.
>
> Hagamos un recuento físico: cuento los tornillos que hay en el
> depósito de verdad, y se lo digo a NEXO. Si no coincide con lo que el
> sistema esperaba, la diferencia queda registrada — con motivo, igual
> que en caja.»

**Qué hago:** «Buscar ventas pendientes» → confirmar depósito de la
venta del video 11 → Existencias → mostrar stock actualizado →
«Recuento físico» → «Abrir recuento» → declarar cantidad contada →
«Agregar al borrador» → **«Guardar el recuento»** (persiste los
renglones; sin este paso, «Cerrar y ajustar» cierra sobre cero
renglones) → «Cerrar y ajustar».

**Datos a preparar:** el stock de tornillos parte de las 10 cajas
sembradas por recuento en el video 06; después de confirmar la salida de
la venta del video 11 (2 cajas), quedan 8 esperadas. Declarar un contado
de 6, para tener una diferencia chica y explicable en cámara.

**Resultado visible:** salida de stock confirmada; recuento cerrado, con
el ajuste de la diferencia registrado con motivo.

**Transición:** «Con la operación diaria recorrida, vamos al corazón
contable de NEXO: los asientos.»

---

## 15 · Asientos

**Objetivo:** ver la propuesta que arma el mapeo, cargarla como
borrador, y aprobarla — el momento en que un asiento existe de verdad
para el Mayor.

**Qué va a ver el alumno:** la propuesta balanceada, la carga en
borrador, la aprobación, y el asiento en el Mayor.

**Pantalla/recorrido:** Operación → Operaciones → detalle del
comprobante → «Ver la propuesta» → «Cargar como asiento en borrador» →
Libros → Asientos → «Aprobar» → Libros → «Mayor».

**Qué digo:**

> «Ya tenemos un comprobante registrado. Ahora, el paso que junta todo
> lo que armamos hasta acá: mapeo, cuenta, comprobante. Abro el
> comprobante y aprieto «Ver la propuesta».
>
> Mirá esto: tres renglones, generados solos por el mapeo que
> declaramos en el video 4. Deudores por ventas al Debe, Ventas de
> mercaderías al Haber, IVA débito fiscal al Haber. Y algo que **nunca**
> se rompe: la suma del Debe es igual a la suma del Haber. Si no
> cerrara, NEXO ni me dejaría guardar.
>
> Esto todavía es una propuesta — NEXO propone, no impone. «Cargar como
> asiento en borrador», y ahora existe como asiento, en estado
> PROPUESTO. Pero un asiento en borrador **todavía no está en el
> Mayor** — a propósito: la aprobación es el momento en que una persona
> se hace responsable.
>
> Voy a Libros, Asientos, abro el mío, y «Aprobar». Ahora sí — Libros,
> Mayor, y ahí está: mis tres renglones, proyectados. Esto es exactamente
> lo mismo que ya probamos en un servidor de producción real — no es una
> simulación, es el circuito tal como funciona.»

**Qué hago:** abrir comprobante → «Ver la propuesta» → «Cargar como
asiento en borrador» → Asientos → abrir → «Aprobar» → Mayor → mostrar
los 3 renglones.

**Datos a preparar:** el comprobante del video 10, mapeo del video 04 ya
declarado.

**Resultado visible:** asiento `APROBADO`, 3 renglones en el Mayor,
Debe = Haber.

**Transición:** «Esto es lo que pasa cuando el comprobante ya trae la
propuesta. ¿Y si necesito cargar algo a mano?»

---

## 16 · Asientos manuales y contraasientos

*(Corregido el 2026-09-28, discrepancia real de la aplicación, no del
guion: el guion asume que basta con «pegar el identificador del asiento
en Asiento del pago → Registrar el pago» para saldar la orden. La app
real lo rechazó: «El asiento no está imputado a todos los comprobantes
de la orden» — `POST /payment-orders/:id/pay` exige una imputación
activa (`party_allocations`, ver `apps/api/src/routes/imputaciones.ts`)
que vincule una línea del asiento con el comprobante, no solo que el
Debe/Haber cierre por el mismo importe. Investigando la causa se
encontró un bug real y bloqueante en el formulario «Cargar un asiento»
de `apps/web/consola.html`: el backend acepta `partyId` por renglón
(`apps/api/src/routes/journal-entries.ts`) pero el formulario manual
nunca lo exponía, así que un asiento manual jamás podía imputarse
contra ningún tercero — la pantalla «Imputar un cobro o pago» (Terceros)
nunca lo iba a encontrar. Se agregaron los campos opcionales «Tercero en
el Debe» y «Tercero en el Haber» al formulario, poblados igual que el
selector de terceros de otras pantallas. Con el campo agregado, el
circuito completo funciona: asiento manual con tercero en el Debe →
aprobar → Terceros → «Imputar un cobro o pago» (paso que el guion no
mencionaba y hay que agregar) → recién ahí «Registrar el pago» satura la
orden. El «Qué hago» de abajo se corrige para nombrar el paso de
imputación explícitamente.)*

**Objetivo:** cargar un asiento sin pasar por un comprobante, usarlo
para cerrar el pago de Ferrolux que quedó pendiente en el video 12, y
anular un asiento por contraasiento.

**Qué va a ver el alumno:** el formulario de carga manual, el pago a
Ferrolux completado con ese asiento, y la anulación de un asiento ya
aprobado.

**Pantalla/recorrido:** Libros → Asientos → «Registrar» (carga manual) →
«Aprobar» → Compras → Pagos → «Registrar el pago» → detalle de un
asiento aprobado → contraasiento.

**Qué digo:**

> «No todo pasa por un comprobante. Libros, Asientos, y acá abajo el
> formulario para cargar a mano: libro, fecha, la cuenta al Debe, la
> cuenta al Haber, el importe, y una justificación — obligatoria, porque
> un asiento sin origen demostrable no se postea, ni a mano. Cargo el
> asiento del pago a Ferrolux: Proveedores al Debe, Bancos al Haber.
> «Registrar», y lo apruebo, como ya sabemos hacer desde el video 15.
>
> Con este asiento aprobado, vuelvo a la orden de pago que dejamos
> pendiente en el video 12 — Compras, Pagos —, pego el identificador de
> este asiento en «Asiento del pago», y «Registrar el pago». Recién
> ahora la deuda con Ferrolux queda saldada de verdad.
>
> Y si me equivoco en un asiento que ya está aprobado, no lo edito ni lo
> borro — nadie edita el Mayor. Lo anulo por contraasiento: un asiento
> nuevo, con los mismos importes invertidos, que deja rastro de los dos.
> El original queda, anulado, y se entiende exactamente qué pasó.»

**Qué hago:** «Registrar» asiento manual (Proveedores con tercero
Ferrolux en el Debe / Bancos) → aprobar → Terceros → ficha de Ferrolux
→ «Imputar un cobro o pago» → elegir el movimiento y el comprobante →
«Imputar» → Pagos → abrir la orden del video 12 → pegar el id del
asiento → «Registrar el pago» → abrir otro asiento aprobado (uno de
prueba, no el del pago) → contraasiento con motivo.

**Datos a preparar:** la orden de pago APROBADA del video 12; dos
cuentas del plan (Proveedores, Bancos); un asiento ya aprobado de
prueba para el ejemplo de contraasiento (no el del pago a Ferrolux, que
queda vigente).

**Resultado visible:** orden de pago en estado PAGADA; un segundo
asiento en estado ANULADO con su contraasiento.

**Transición:** «Con esto sabés cargar y corregir, y cerraste el pago
que quedó pendiente. Ahora, algo que pasa una vez al mes: cerrar un
período.»

---

## 17 · Períodos y cierre de ejercicio

*Nota de producción (2026-09-30): el cierre del ejercicio 2026 de la
empresa demo (Ferretería El Tornillo Feliz S.R.L.) se ejecutó de
verdad, sobre la API real, recién después de que no quedó ninguna otra
grabación pendiente que dependiera del ejercicio abierto (videos 18 a
31 ya estaban terminados) y con autorización explícita del usuario para
cada paso por separado, según la regla de no ejecutar acciones
irreversibles sin confirmación puntual.

Secuencia real ejecutada: (1) diagnóstico de código
(`apps/api/src/routes/closures.ts`) confirmando que el cierre es en los
hechos irreversible — no existe endpoint de reapertura de ejercicio,
solo la apertura del siguiente; (2) verificación de bloqueos reales:
había un asiento `PROPUESTO` sin aprobar ("Anticipo cobrado — proyecto
remodelación Kiosco Doña Rosa", $80.000), que se aprobó primero
(`POST /journal-entries/.../approve`, con autorización separada); (3)
`POST /fiscal-years/:id/pre-close` — el checklist real pasó los cuatro
ítems bloqueantes (balance cuadra, sin borradores, sin propuestos, sin
propuestas de IA sin revisar) y quedó una advertencia no bloqueante, 4
comprobantes sin asiento; (4) `POST /fiscal-years/:id/close` — cerró el
ejercicio, posteó el asiento de refundición
(`01a0f370-98aa-7055-8135-a24a2717f66b`) y el de cierre
(`01a0f370-98b0-7fed-9c60-dee0e65c0ccc`), resultado real del ejercicio:
**pérdida de $285.000,00** (ingresos $190.000,00, gastos $475.000,00),
y cerró los 12 períodos del año.

Una parte del guion original no se pudo filmar sobre esta empresa: el
tramo "bloquear un período → intentar reabrir (mostrar contrafirma)"
requiere un período todavía `ABIERTO`, y para cuando se retomó este
video ya no quedaba ninguno — los 31 videos restantes se filmaron
primero, tal como pidió el usuario, y eso agotó el ejercicio completo.
No se fuerza una demostración sobre un período ya cerrado porque sería
una captura falsa (un estado que la empresa ya no tiene). Esa
demostración puntual —bloqueo y reapertura con contrafirma, que no
depende de cerrar nada— queda pendiente de grabarse en otra empresa o
ejercicio con un período todavía abierto; no es un bloqueo de código,
es una secuencia de grabación por resolver aparte. El resto del video
—checklist de pre-cierre real, cierre real, resultado real— sí quedó
grabado y verificado de punta a punta contra la API.*

**Objetivo:** bloquear y cerrar un período, y abrir el ejercicio
siguiente.

**Qué va a ver el alumno:** el bloqueo de un período, el checklist de
pre-cierre, el cierre, y la apertura del siguiente ejercicio.

**Pantalla/recorrido:** Libros → Períodos y cierre.

**Qué digo:**

> «Un período bloqueado todavía se puede reabrir; uno cerrado, no — por
> eso hay dos pasos. Primero bloqueo: en la fila del período,
> «Bloquear», con motivo. Si me arrepiento, «Reabrir» — pero eso pide
> **contrafirma de otra persona**, norma de doble control, no un
> capricho de la pantalla.
>
> Para cerrar el ejercicio entero, en la fila del ejercicio hay «Ver
> checklist de pre-cierre» — NEXO no me deja cerrar si falta algo, y me
> dice exactamente qué. Resuelto eso, «Cerrar el ejercicio», y después
> «Asiento de apertura» arma solo el arranque del siguiente.
>
> Una aclaración importante para cuando grabes esto de verdad: **una
> vez cerrado, no hay forma de deshacerlo** para repetir la toma. Se
> graba en una empresa que ya cumplió su función en el curso, no en la
> que vas a seguir usando para los videos que siguen.»

**Qué hago:** bloquear un período → intentar reabrir (mostrar
contrafirma) → checklist de pre-cierre → «Cerrar el ejercicio» →
«Asiento de apertura».

**Datos a preparar:** al menos un asiento aprobado en el ejercicio (del
video 15). **Grabar al final**, en una copia del dataset que ya no se
va a reutilizar en videos posteriores.

**Resultado visible:** ejercicio `CERRADO`, acta disponible, asiento de
apertura del siguiente.

**Transición:** «El ciclo contable ya está completo. Faltan dos temas
que no todas las empresas usan, pero que conviene conocer: bienes de uso
y costo de lo vendido.»

---

## 18 · Bienes de uso

*(Corregido el 2026-09-29. Dos hallazgos reales de la aplicación,
verificados en vivo como pedía la auditoría previa sobre este video:

1. **Bug real y bloqueante, corregido.** El guion afirma que "NEXO me
avisa explícitamente que la baja no genera un asiento solo". Eso es
cierto en el backend — `POST /fixed-assets/:id/baja`
(`apps/api/src/routes/activos.ts`) devuelve `alcance: "La baja no
produce asiento. El resultado por venta o por baja se registra por el
camino del Diario, con las cuentas que corresponda a esta operación."`
— pero el frontend (`apps/web/consola.html`, handler `b-act-baja`)
nunca mostraba ese texto: `decir()` solo lee `mensaje`/`siguiente`, y
`alcance` quedaba escondido dentro de "Ver el detalle técnico" como
JSON crudo. Es decir, tal como estaba, un alumno que diera de baja un
bien en cámara NO iba a ver ningún aviso explícito — la afirmación del
guion era falsa en la práctica. Se corrigió agregando el mismo patrón
ya usado en otras pantallas para mostrar `alcance` (`conEnfasis`), sin
tocar `decir()` globalmente. Verificado dando de baja un bien de
prueba descartable (`BU-99`, $1.000, no forma parte del dataset): el
aviso ahora aparece en pantalla tal cual lo cita el guion.

2. **Bug real, NO bloqueante, no corregido en esta pasada.** La tabla
"Plan de amortización" (`t-act-plan` en consola.html) tiene columnas
Acumulada y Valor residual: Acumulada muestra `c.base` (el valor de
origen completo, 8.500.000) en vez de la amortización acumulada a la
fecha, y Valor residual está codeado como un guion literal ("—"),
nunca calculado. La columna Cuota (la única que el guion narra) es
correcta. No se tocó porque el guion no cita ni depende de esas dos
columnas — queda documentado acá para una corrección futura de
`consola.html`, no es parte de esta producción.)*

**Objetivo:** dar de alta un bien de uso y entender su plan de
amortización.

**Qué va a ver el alumno:** el alta de un bien, el plan calculado solo,
y el asiento de depreciación.

**Pantalla/recorrido:** Operación → Bienes de uso.

**Qué digo:**

> «Damos de alta una camioneta de reparto: valor de origen, vida útil de
> cinco años. Guardo, y NEXO **calcula** el plan de amortización solo —
> no hay una tabla que yo tenga que llenar cuota por cuota.
>
> Cada período, el asiento de depreciación se vincula a este plan, y el
> importe tiene que coincidir exactamente con lo calculado. Un asiento
> sin aprobar no amortiza nada — mismo principio que ya vimos: nada
> pasa hasta que alguien lo aprueba.
>
> Y si doy de baja el bien, NEXO me avisa explícitamente que la baja
> **no** genera un asiento solo — es una negativa a propósito, no un
> olvido.»

**Qué hago:** alta de bien de uso → mostrar plan de amortización
calculado → asiento de depreciación de un período.

**Datos a preparar:** una camioneta de reparto, $8.500.000, 5 años
(dataset).

**Resultado visible:** plan de amortización visible, asiento de
depreciación vinculado.

**Transición:** «El último tema de esta etapa: cuánto costó lo que
vendiste.»

---

## 19 · Costo de lo vendido y valuación de existencias

**Estado: `SALTADO_NO_PRODUCIDO`.**

*(DETENIDO el 2026-09-29 — discrepancia real, sin resolver, requiere
decisión humana. No se fuerzan datos ni se fabrica un workaround; ver
detalle en el reporte de producción de esta fecha. Se alcanzó a
declarar el método de valuación (PPP, vigente desde 2026-01-01) en
Existencias → «Valuación de existencias» — eso funcionó bien y quedó
hecho. Pero "Ver la propuesta" de costo de mercadería vendida no se
pudo probar, por DOS bloqueos independientes:

1. `GET /analysis/costo-de-ventas/asiento-propuesto` devuelve 403
`FUERA_DEL_PLAN`: el módulo "análisis" solo está incluido en el plan
NEXO Completo, y esta empresa está en NEXO Gestión (prueba, desde el
video 02). Confirmado contra `docs_de_precios`/Plan → Administración →
Plan → "Planes disponibles".
2. Aun con el plan correcto, la vista `stock_valuation`
(`infrastructure/db/migrations/0077_valuacion_de_existencias.sql`)
marca los tres productos del dataset (PROD-001, PROD-002, TOR-001)
como "entradas sin costo declarado" — ninguna recepción ni ajuste de
recuento anterior (videos 06, 12, 14) declaró `costoUnitario` al
entrar, y **los movimientos anteriores no se revalúan nunca**: es
permanente por diseño, no se puede corregir a posteriori sobre estos
tres productos.

**Actualización, mismo día:** el bloqueo 1 ya no existe — la empresa
convirtió su prueba a NEXO Completo (ver nota del video 30) al
descubrirse que el mismo `FUERA_DEL_PLAN` frenaba también 25, 26 y 27,
no solo este video. El bloqueo 2 sigue en pie y es el único pendiente:
sigue haciendo falta un producto nuevo con su primera entrada recién
declarada con costo, porque PROD-001/002 y TOR-001 quedaron
permanentemente sin costo por diseño. No se fabricó ese producto sin
autorización explícita — este video sigue DETENIDO por ese motivo
únicamente.)*

**Objetivo:** declarar un método de valuación y ver la propuesta de
costo de mercadería vendida.

**Qué va a ver el alumno:** la declaración del método, y la propuesta
de asiento de CMV.

**Pantalla/recorrido:** Existencias → «Ver la propuesta» (costo de
mercadería vendida) → Configuración (método de valuación).

**Qué digo:**

> «Sin un método de valuación declarado, NEXO no puede decirte cuánto
> te costó lo que vendiste — y sin eso, tu margen es la venta entera,
> lo cual es mentira. Declaro el método acá, una sola vez.
>
> Con eso declarado, cada mes aparece una propuesta de costo de
> mercadería vendida — «Ver la propuesta», igual que con los asientos
> de venta —, y la cargo como asiento en borrador de la misma forma que
> ya sabés hacerlo.»

**Qué hago:** declarar método de valuación → Existencias → «Ver la
propuesta» del CMV del mes → «Cargar como asiento…».

**Datos a preparar:** movimientos de stock ya registrados (recepción y
alguna salida).

**Resultado visible:** método declarado, propuesta de CMV visible y
cargada.

**Transición:** «Ya tenés todo el ciclo contable armado. Ahora, a leer
lo que NEXO calculó: Diario y Mayor.»

---

## 20 · Diario y Mayor

*(Corregido el 2026-09-29, bug real y bloqueante de la aplicación, no
del guion. El guion pide "elijo Deudores por ventas, y veo cada
movimiento que le tocó a esa cuenta, con su saldo acumulado", pero la
pantalla «Mayor» de `apps/web/consola.html` (`b-mayor`) no tenía forma
de elegir una cuenta: llamaba a `GET /books/mayor` sin el parámetro
`cuenta` y solo pintaba la tabla-resumen (una fila por cuenta, con sus
totales), nunca los movimientos uno por uno. El backend
(`apps/api/src/routes/books.ts`, línea ~127) ya soportaba
`?cuenta=<código>` y ya devolvía, por cuenta, el array `movimientos`
completo (fecha, libro, número, detalle, debe, haber, saldo
acumulado) — la funcionalidad existía de punta a punta y a la pantalla
le faltaba el selector. Se agregó un `<select>` "Cuenta (solo para el
Mayor)" junto a Desde/Hasta, poblado con el plan de cuentas igual que
los selectores ya existentes, y se modificó el handler de «Mayor» para
mandar `cuenta` cuando hay una elegida y renderizar la tabla de
movimientos debajo del resumen. Verificado en vivo: Mayor filtrado por
`1.1.03.01 — Deudores por ventas` muestra el movimiento «Venta 1-5»
línea por línea con su saldo acumulado, tal como pide el guion.)*

**Estado: `VIDEO_FINAL`** (2026-09-30) — `MASTER/video20-nexo-desde-cero.mp4`,
890×444, 25fps, H.264/AAC, 28,24s. Narración con Piper TTS (voz Daniela,
es_AR). Evidencia en `scratchpad/produccion/video20/`.

**Objetivo:** leer el Diario y el Mayor como herramientas de consulta,
no como confirmación de un solo evento.

**Qué va a ver el alumno:** el Diario del período, y el Mayor de una
cuenta específica.

**Pantalla/recorrido:** Libros → «Diario» → Libros → «Mayor».

**Qué digo:**

> «Ya vimos aparecer un asiento en el Mayor cuando lo aprobamos, en el
> video 15. Acá aprendemos a leerlo como herramienta, no a repetir eso.
>
> El Diario lista todos los asientos del período, en orden. El Mayor los
> agrupa por cuenta: elijo Deudores por ventas, y veo cada movimiento
> que le tocó a esa cuenta, con su saldo acumulado. Es la misma
> información, mirada desde dos ángulos distintos — y los dos leen
> exactamente los mismos asientos aprobados, nada más.»

**Qué hago:** Libros → «Diario» → mostrar asientos del período → Libros
→ «Mayor» → elegir una cuenta → mostrar movimientos y saldo.

**Datos a preparar:** al menos 2-3 asientos aprobados (de videos
anteriores).

**Resultado visible:** Diario con varios asientos, Mayor de una cuenta
con su saldo.

**Transición:** «Con el Diario y el Mayor, ya podés seguir cualquier
número hasta su origen. El siguiente paso es verificar que todo cierre:
el Balance.»

---

## 21 · Balance

**Estado: `VIDEO_FINAL`** (2026-09-30) — `MASTER/video21-nexo-desde-cero.mp4`,
890×444, 25fps, H.264/AAC, 20,44s. Narración con Piper TTS (voz Daniela,
es_AR). Evidencia en `scratchpad/produccion/video21/`.

**Objetivo:** ver el balance de sumas y saldos y entender sus
verificaciones.

**Qué va a ver el alumno:** el balance con sus columnas y las
verificaciones en verde.

**Pantalla/recorrido:** Libros → «Balance».

**Qué digo:**

> «El Balance de sumas y saldos junta todas las cuentas con su Debe,
> su Haber, y el saldo. Y trae sus propias verificaciones: si algo no
> cierra, NEXO te lo dice acá mismo, no te deja creer que está bien
> cuando no lo está. Todo en verde significa exactamente eso — Debe
> igual a Haber, cuenta por cuenta y en el total.»

**Qué hago:** Libros → «Balance» → mostrar verificaciones en verde.

**Datos a preparar:** los mismos asientos del video 20.

**Resultado visible:** Balance con Debe = Haber, verificaciones en
verde.

**Transición:** «Con contabilidad y Balance recorridos, pasamos al otro
libro que exige la norma: el subdiario de IVA.»

---

## 22 · Subdiarios de IVA

**Estado: `VIDEO_FINAL`** (2026-09-30) — `MASTER/video22-nexo-desde-cero.mp4`,
890×444, 25fps, H.264/AAC, 16,44s. Narración con Piper TTS (voz Daniela,
es_AR). Evidencia en `scratchpad/produccion/video22/`.

**Objetivo:** ver el subdiario de IVA de un período.

**Qué va a ver el alumno:** el subdiario, generado a partir de los
comprobantes registrados.

**Pantalla/recorrido:** Libros → IVA → «Ver el período» / «Ver
subdiario».

**Qué digo:**

> «El subdiario de IVA no es una carga aparte — sale directo de los
> comprobantes que ya registramos. Elijo el período, «Ver subdiario», y
> ahí está cada comprobante con su neto, su IVA, y el total. Es el
> mismo dato del video 10, ordenado para este libro específico.»

**Qué hago:** Libros → IVA → elegir período → «Ver subdiario».

**Datos a preparar:** el comprobante VENTA del video 10.

**Resultado visible:** subdiario con al menos una fila.

**Transición:** «Con el IVA cubierto, veamos un resumen más alto: los
estados contables.»

---

## 23 · Estados contables

**Estado: `SALTADO_NO_PRODUCIDO`.**

*(DETENIDO el 2026-09-29 — dos hallazgos, uno corregido y uno sin
resolver que requiere decisión humana. No se fuerzan datos.

**Corregido:** «Declarar el marco de reporte» no tenía ningún
formulario en toda la aplicación — `POST
/companies/current/reporting-framework` (`apps/api/src/routes/studio.ts`,
línea ~413) existía y funcionaba, pero `apps/web/consola.html` solo
mostraba «Marco contable: sin fijar» en Configuración, sin botón para
fijarlo. Se agregó el formulario (marco/válido desde/Declarar) junto a
esa ficha. Verificado: declarar RT_FACPCE desde 2026-01-01 para esta
empresa funciona y persiste.

**DETENIDO, sin resolver:** con el marco ya declarado, «Armar el
estado» (ESP) devuelve: *"FUENTE NO ENCONTRADA: no hay plantilla ESP
vigente al 2026-12-31 para marco RT_FACPCE, ente SRL y regulador
NINGUNO."* Investigando la causa (`apps/api/src/routes/statements.ts`,
tabla `statement_templates`): el único alcance sembrado en todo el
sistema (`scripts/statement-templates.mjs`, `export const ALCANCE`) es
`marco: RT_FACPCE, tipoEnte: SA, regulador: IGJ` — es decir, NEXO
solo trae una plantilla real para Sociedades Anónimas reguladas por
IGJ. La empresa del curso, "Ferretería El Tornillo Feliz **S.R.L.**",
nunca va a encontrar plantilla, sea cual sea el marco que se declare,
porque no existe ninguna plantilla para el tipo de ente SRL. No hay
ningún endpoint para cargar una plantilla nueva desde la aplicación —
solo existe el script de siembra, que transcribe el articulado real de
la norma (Ley 19.550, arts. 63/64) a mano. No se improvisó ninguna
plantilla ni se cambió el tipo de ente de la empresa del curso sin
autorización explícita: cualquiera de las dos cosas es una decisión
real, no un ajuste de datos de prueba.)*

**Objetivo:** armar un estado contable con un marco de reporte
declarado.

**Qué va a ver el alumno:** la declaración de un marco de reporte, y el
armado del estado.

**Pantalla/recorrido:** Libros → Estados y notas → «Armar el estado».

**Qué digo:**

> «Para armar un estado contable primero hace falta declarar un marco
> de reporte — la norma bajo la que se presenta. Con eso declarado,
> «Armar el estado», y NEXO lo arma a partir del Mayor, no de una carga
> manual aparte. Cada línea es trazable hasta los asientos que la
> forman.»

**Qué hago:** declarar marco de reporte → «Armar el estado».

**Datos a preparar:** los asientos ya aprobados de videos anteriores.

**Resultado visible:** estado contable armado.

**Transición:** «El último tema de esta etapa es más técnico pero
importante: cómo auditar y exportar lo que hiciste.»

---

## 24 · Auditoría y exportaciones

**Estado: `VIDEO_FINAL`** (2026-09-30) — `MASTER/video24-nexo-desde-cero.mp4`,
890×444, 25fps, H.264/AAC, 21,85s. Narración con Piper TTS (voz Daniela,
es_AR). Evidencia en `scratchpad/produccion/video24/`.

**Objetivo:** leer la bitácora de auditoría y exportar un libro a CSV.

**Qué va a ver el alumno:** la bitácora encadenada, y una exportación a
CSV.

**Pantalla/recorrido:** Administración → Auditoría → Libros → «Bajar …
(CSV)».

**Qué digo:**

> «Cada acción que hicimos en este curso quedó en la bitácora de
> auditoría — quién, cuándo, qué. Está encadenada: si alguien intentara
> alterar un registro viejo, se rompería la cadena y se notaría.
>
> Y para compartir cualquiera de los libros que vimos, los seis botones
> de «Bajar … (CSV)» — Diario, Mayor, Balance, y algunos más — te dan el
> mismo dato que viste en pantalla, en un archivo.»

**Qué hago:** Administración → Auditoría → mostrar bitácora → Libros →
descargar un CSV.

**Datos a preparar:** cualquiera de las acciones ya hechas en videos
anteriores.

**Resultado visible:** bitácora con varias entradas, CSV descargado.

**Transición:** «Con reportes y auditoría cubiertos, vamos a lo que hace
distinta a NEXO: la inteligencia.»

---

## 25 · Preguntar: Panorama y riesgos

**Estado: `VIDEO_FINAL`** (2026-10-01) — `MASTER/video25-nexo-desde-cero.mp4`,
890×444, 25fps, H.264/AAC, 29,08s. Narración con Piper TTS (voz Daniela,
es_AR). Evidencia en `scratchpad/produccion/video25/`.

**Objetivo:** usar el catálogo cerrado de preguntas y entender que no
es un chat libre.

**Qué va a ver el alumno:** el Panorama con sus tarjetas, y los seis
frentes de Riesgos.

**Pantalla/recorrido:** Inicio → Preguntar → «Ver el panorama» → «Ver
los riesgos».

**Qué digo:**

> «Antes de mostrar esto, una aclaración: "Preguntar" no es un chat
> libre — es un catálogo cerrado de preguntas que NEXO ya sabe contestar
> con certeza, calculadas por el mismo motor que arma cada pantalla.
>
> «Ver el panorama» — tarjetas como «¿Cómo voy?» o «¿Cuánto tengo?»,
> cada una con su evidencia abajo, no algo que hay que creerle porque sí.
> Si ves un valor en blanco, no es un error: es que el sistema no puede
> afirmarlo todavía, y te dice por qué.
>
> Y «Ver los riesgos» — los seis frentes que NEXO vigila solo, sin que
> nadie se lo pida.»

**Qué hago:** «Ver el panorama» → recorrer tarjetas → volver → «Ver los
riesgos».

**Datos a preparar:** varios asientos y comprobantes ya cargados (de
videos anteriores), para que el panorama no aparezca vacío.

**Resultado visible:** tarjetas con datos reales, lista de riesgos.

**Transición:** «Preguntar contesta lo que ya sabe. Para simular algo
que todavía no pasó, existe Señales.»

---

## 26 · Señales y escenarios

**Estado: `VIDEO_FINAL`** (2026-10-01) — `MASTER/video26-nexo-desde-cero.mp4`,
890×444, 25fps, H.264/AAC, 20,84s. Narración con Piper TTS (voz Daniela,
es_AR). Evidencia en `scratchpad/produccion/video26/`.

**Objetivo:** simular un escenario y comparar el resultado medido
contra lo esperado.

**Qué va a ver el alumno:** una simulación, su declaración como
aplicada, y la medición del resultado.

**Pantalla/recorrido:** Análisis → Señales → «Simular» → «Declarar
aplicado» → «Ver el resultado».

**Qué digo:**

> «Simulo un escenario — por ejemplo, subir el precio de la pintura un
> diez por ciento — y NEXO me muestra el impacto esperado. Si decido
> aplicarlo de verdad, «Declarar aplicado» deja registro de que ese acto
> respondió a este escenario.
>
> Y más adelante, «Ver el resultado» compara lo que pasó de verdad
> contra lo que el escenario proyectaba — no queda como una promesa sin
> revisar.»

**Qué hago:** Señales → «Simular» un escenario → «Declarar aplicado» →
«Ver el resultado» (puede mostrarse con datos ya cargados de un
escenario anterior, si el actual todavía no tiene resultado medible).

**Datos a preparar:** algo de historial de precios/ventas para que la
simulación tenga con qué comparar.

**Resultado visible:** escenario simulado, declarado, con su resultado.

**Transición:** «Señales simula. Ahora veamos cómo NEXO decide cuando
propone un asiento solo.»

---

## 27 · Propuestas de IA

**Estado: `SALTADO_NO_PRODUCIDO`.**

*(DETENIDO el 2026-09-29 — discrepancia real, sin resolver, requiere
decisión humana. El módulo ya no da 403 (ver nota del video 30 sobre
el cambio de plan), pero `GET /predictions?estado=PENDIENTE` devuelve
`predicciones: []` — cero propuestas, no "todas de baja confianza"
como asumía el guion. Investigando la causa: `POST
/documents/:id/classify` (única forma de generar una) sobre el
documento real del video 09/10 devolvió `{"estado":"SIN_SUGERENCIA",
"motivo":"IA_DESHABILITADA","detalle":"No hay proveedor de IA
configurado. El sistema opera en modo determinístico."}` — coincide
con el arranque del servidor, que ya declaraba "IA: none · simulado o
apagado". No es un bug: es que esta instalación de desarrollo nunca
tuvo un proveedor de IA (OpenAI/Anthropic/etc.) configurado, y sin uno
`/documents/:id/classify` no tiene con qué generar una propuesta —
ni siquiera una de baja confianza. El "Qué digo" del guion sigue
siendo cierto en espíritu ("todas caen en revisión") pero la premisa
de que existe al menos una propuesta para abrir y mostrar no se pudo
cumplir. Configurar un proveedor de IA real (con su costo y sus
credenciales) o fabricar una propuesta a mano en la base son las dos
únicas formas de destrabar esto, y ninguna se hizo sin autorización
explícita.)*

**Objetivo:** entender por qué toda propuesta de IA pasa hoy por
revisión humana.

**Qué va a ver el alumno:** una propuesta del motor y su revisión.

**Pantalla/recorrido:** Operación → Propuestas de IA.

**Qué digo:**

> «Esta pantalla es donde se revisan las propuestas que el motor generó
> solo. Y hay algo que conviene decir de entrada, sin esconderlo: hoy,
> en este momento, **todas** las propuestas caen en revisión profesional
> — no hay ninguna que llegue con confianza tan alta como para saltarse
> ese paso. Eso no es una falla del video, es el estado real: las
> reglas contables que habilitarían el otro camino todavía no están
> cargadas.
>
> Reviso una propuesta: la cuenta que sugiere, el motivo, la confianza.
> Puedo aceptarla, corregirla, o rechazarla — siempre queda registrado
> con mi nombre.»

**Qué hago:** Propuestas de IA → abrir una propuesta → mostrar cuenta,
motivo, confianza → aceptar o corregir.

**Datos a preparar:** al menos una propuesta generada por el motor sobre
un comprobante del dataset.

**Resultado visible:** revisión registrada.

**Transición:** «Con la parte de inteligencia cubierta, quedan los temas
de gestión: proyectos, sucursales y comisiones.»

---

## 28 · Proyectos, sucursales y comisiones

**Estado: `VIDEO_FINAL`** (2026-10-01) — `MASTER/video28-nexo-desde-cero.mp4`,
890×444, 25fps, H.264/AAC, 18,72s. Narración con Piper TTS (voz Daniela,
es_AR). Evidencia en `scratchpad/produccion/video28/`.

*(Corregido el 2026-09-29, mismo patrón que el video 16: el formulario
"Cargar un asiento" tampoco exponía `costCenterCode`, aunque el backend
lo soporta por línea (`apps/api/src/routes/journal-entries.ts`, línea
~69). Sin eso, un proyecto nunca podía tener ingresos/costos reales —
quedaba con margen 0 para siempre, aunque el centro de costo existiera.
Se agregó "Centro de costo (si aplica)" al formulario manual
(`apps/web/consola.html`), aplicado a ambas líneas. Verificado
completo: centro de costo PROY-01 → proyecto "Remodelación local
Kiosco Doña Rosa" citándolo → un asiento de ingreso ($80.000) y uno de
costo ($50.000), ambos con ese centro → margen real $30.000 (37,50 %).
Sucursal SUC-01 con punto de venta 0001 declarado → 2 comprobantes y
$13.700 atribuidos automáticamente por el número que ya viajaba en cada
venta. Vendedor VEND-01 con esquema 5 % sobre el neto → comisión
devengada real de $185 al atribuirle el comprobante 1-1.

*(Actualizado el 2026-09-30, en la producción real del video: el margen
de PROY-01 hoy es **$110.000 (68,75 %)**, no los $30.000 de la
verificación original — el asiento del anticipo de $80.000 aprobado
para poder cerrar el ejercicio (video 17) también quedó imputado a este
mismo centro de costo, sumando ingresos. Sucursal y vendedor no
cambiaron: SUC-01 sigue con 3 comprobantes / $33.700 y VEND-01 con
comisión devengada $185. Verificado en vivo vía `GET /projects`,
`/branches` y `/salespeople` antes de grabar — el guion debe citar
$110.000, no $30.000.)*

Ningún dato
fue inventado: el proyecto, la sucursal y el vendedor son ficticios
—como todo el dataset del curso— pero cada cifra sale del motor real,
no de un valor tipeado a mano en una pantalla de reporte.)*

**Objetivo:** ver rentabilidad por proyecto y dar de alta un vendedor
con su esquema de comisión.

**Qué va a ver el alumno:** un proyecto con su margen, una sucursal, y
un vendedor con comisión.

**Pantalla/recorrido:** Operación → Proyectos → Operación → Sucursales →
Ventas → Comisiones.

**Qué digo:**

> «Si organizás el trabajo por proyecto, acá ves su rentabilidad — lo
> que entró contra lo que costó. Sucursales es simple: cada punto de
> venta, con lo suyo. Y en Comisiones das de alta un vendedor con su
> esquema — cuánto gana no sigue al mismo permiso que el resto de lo
> comercial, se concede aparte, porque es información sensible.»

**Qué hago:** Proyectos → mostrar margen de un proyecto → Sucursales →
alta → Comisiones → alta de vendedor con esquema.

**Datos a preparar:** un proyecto de ejemplo con algún costo/ingreso
asociado.

**Resultado visible:** proyecto con margen visible, sucursal y vendedor
listados.

**Transición:** «Dos temas más, para quien administra la cuenta:
integraciones y migración.»

---

## 29 · Integraciones y migración

**Estado: `VIDEO_FINAL`** (2026-10-01) — `MASTER/video29-nexo-desde-cero.mp4`,
890×444, 25fps, H.264/AAC, 13,30s. Narración con Piper TTS (voz Daniela,
es_AR). Evidencia en `scratchpad/produccion/video29/`.

*(Nota de producción, 2026-09-29 — sin discrepancias, dato preparado
para la grabación. La única fuente `IMPLEMENTADO` hoy es
`ARCHIVO_GENERICO` (CSV/XLSX/JSON/XML/ZIP); la entidad más simple para
demostrar el circuito completo es `PARTY` (terceros), que solo exige
la columna `razonSocial`. Fixture usado: un CSV de 2 filas
(`razonSocial,cuit,tipo,condicionIva,email`) con dos proveedores/
clientes ficticios nuevos. Circuito real de punta a punta: crear
migración → subir archivo → mapear columnas (entidad PARTY, cada
columna a su campo) → «Guardar la correspondencia» → «Validar» (marcó
las dos filas como ADVERTENCIA porque los CUIT de prueba no tienen
dígito verificador válido — validación real de NEXO, no un bug) →
«Importar» (2 terceros nuevos, verificados por API) → «Deshacer esta
migración» (los 2 terceros dejaron de estar ACTIVOS, verificado por
API). Los dos terceros del fixture no forman parte del dataset
canónico del curso — se cargaron y revirtieron solo para esta
demostración, sin dejar rastro activo.)*

**Objetivo:** migrar datos desde otro sistema.

**Qué va a ver el alumno:** la elección de una fuente, la migración, y
la reversión.

**Pantalla/recorrido:** Administración → Migraciones.

**Qué digo:**

> «Si venís de otro sistema, no arrancás de cero: elegís la fuente,
> mapeás los campos, y migrás. Y si algo sale mal, «Revertir» deshace
> exactamente esa migración — no te deja con datos a medio traer.»

**Qué hago:** Migraciones → elegir fuente → migrar un lote de ejemplo →
mostrar «Revertir».

**Datos a preparar:** un archivo de ejemplo en el formato que NEXO
espera para migración.

**Resultado visible:** datos migrados, opción de reversión visible.

**Transición:** «Último tema de gestión: tu plan y tu suscripción.»

---

## 30 · Plan y suscripción

**Estado: `VIDEO_FINAL`** (2026-10-01) — `MASTER/video30-nexo-desde-cero.mp4`,
890×444, 25fps, H.264/AAC, 23,34s. Narración con Piper TTS (voz Daniela,
es_AR). Evidencia en `scratchpad/produccion/video30/`.

*(Corregido el 2026-09-29 — cambio real de premisa, no un ajuste de
datos de prueba. Se descubrió, filmando los videos 19/25/26/27, que
están bloqueados por el mismo motivo: los módulos "análisis" e
"inteligencia" (`FUERA_DEL_PLAN` en `/analysis/*` e `/intelligence/*`)
solo están incluidos en el plan NEXO Completo, y la empresa del curso
estaba en NEXO Gestión. Autorizado explícitamente por el productor,
se convirtió la prueba a NEXO Completo (`POST /subscription/convertir`,
sin conectar pasarela de pago) — la empresa ya no está "en período de
prueba desde el video 02": tiene una **suscripción activa**, ARS
449.900/mes, desde 2026-09-29. Esto desbloqueó 25, 26 y 27 (no el 19,
que además tiene su propio bloqueo de datos sin costo declarado, ver
su nota). El "Qué digo" de abajo se corrige para reflejar el estado
real: ya no hay botón "Convertir la prueba" que señalar como pendiente
— se puede mostrar la sección "Contratar" igual, pero como un acto ya
hecho, no como una acción futura.)*

**Objetivo:** ver el plan contratado y sus topes.

**Qué va a ver el alumno:** el plan actual, los topes de uso, la
conversión de la prueba.

**Pantalla/recorrido:** Administración → Plan.

**Qué digo:**

> «Acá ves qué plan tenés y cuánto llevás usado de cada tope. Esta
> empresa ya convirtió su prueba a NEXO Completo — plan pago, activo
> desde hoy —, y el historial de abajo muestra exactamente ese acto:
> «Convertir» cierra la prueba y fija el importe según la lista de
> precios vigente, sin perder nada de lo que ya cargaste. Conectar el
> medio de pago es un paso aparte: sin pasarela, el cargo se emite
> igual y se cobra por transferencia.»

**Qué hago:** Administración → Plan → mostrar topes → mostrar el
historial con la conversión ya hecha (NEXO Gestión, prueba → NEXO
Completo, activa).

**Datos a preparar:** ninguno especial — la empresa del curso convirtió
su prueba a NEXO Completo durante la producción (video 19/25/26/27, ver
nota arriba), no sigue en período de prueba.

**Resultado visible:** plan y topes visibles.

**Transición:** «Con todo NEXO recorrido, cerramos el curso con el
circuito completo, de punta a punta.»

---

## 31 · Circuito completo: de un documento a un balance

*Nota de producción (2026-09-30): grabado con un documento propio
(`video31-factura-demo.xml`, comprobante 0001-00000006, distinto del
0001-00000005 de los videos 09-10) sobre la app real. Circuito
verificado de punta a punta con llamadas directas a la API de cada
paso: documento EXTRAIDO con confianza 1.0000 → comprobante registrado
(`tax-transactions/.../registrar`) → propuesta de asiento
(`asiento-propuesto`, Deudores por ventas 1.1.03.01 debe 24200 /
Ventas de mercaderías 4.1.01 haber 20000 / IVA débito fiscal 2.1.04.01
haber 4200) → asiento cargado en borrador (PROPUESTO) → aprobado
(`journal-entries/.../approve`, status APROBADO) → visible en el Mayor
de Deudores por ventas (saldo 36.300,00) → reflejado en el Balance de
sumas y saldos (`reports/trial-balance`), que cuadra (SUMAS_IGUALES,
SALDOS_IGUALES y SALDO_POR_CUENTA en `cumple: true`, diferencia en
menor 0). Sin discrepancias de la app: el único inconveniente fue de
entorno, no de datos — el panel del navegador quedó con el mismo
problema de renderizado ya documentado en los videos 28-29 (captura
con ancho 0 / sin respuesta), así que este tramo también se verificó
por `get_page_text` y `window.api()` en vez de clics y capturas
visuales en vivo; no hay GIF de este segmento, la evidencia es la
secuencia de respuestas reales de la API citada arriba.*

**Objetivo:** recorrer, sin cortes, todo lo que se enseñó en el curso —
la demostración de cierre.

**Qué va a ver el alumno:** documento → comprobante → mapeo (ya
declarado) → propuesta → asiento → aprobación → Mayor → Balance, todo
seguido.

**Pantalla/recorrido:** Documentos → Operaciones → Asientos → Libros.

**Qué digo:**

> «Este es el cierre del curso: la misma secuencia que ya recorrimos
> video por video, ahora sin cortes. Subo un documento nuevo. Lo
> registro como comprobante — VENTA, elijo la dirección. Veo la
> propuesta que arma el mapeo que declaramos hace muchos videos. La
> cargo como borrador. La apruebo. Y ahí está, en el Mayor, y también en
> el Balance.
>
> Esto exacto —el tramo de documento a Mayor— ya lo corrimos una vez en
> un servidor de producción real, no en una demo: el mismo circuito que
> acabás de ver funcionando acá es el que funciona ahí. Y con esto, ya
> sos capaz de recorrer una operación entera de NEXO por tu cuenta, sin
> mirar ningún manual.»

**Qué hago:** subir documento → registrar comprobante → ver propuesta →
cargar borrador → aprobar → mostrar Mayor → mostrar Balance.

**Datos a preparar:** un documento nuevo del dataset (no reutilizar el
mismo comprobante de los videos 09-10, para que se note que es una
operación distinta).

**Resultado visible:** el circuito completo, de punta a punta, sin
cortes.

**Transición:** cierre del curso — sin video siguiente.

---

## Nota de cierre de Fase 2

Los 31 videos quedan con guion completo, acciones exactas y datos del
dataset ya definido. Ningún guion depende de una decisión pendiente para
poder grabarse — donde una decisión pendiente podría cambiar algo (por
ejemplo, si Precios se separa en un video propio, o si se agrega un
video de conciliación bancaria), el guion actual sigue siendo grabable
tal cual está; la decisión solo agregaría contenido, no invalidaría lo
ya escrito.
