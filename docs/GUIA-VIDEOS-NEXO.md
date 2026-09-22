# Guiones de los videos de NEXO

**Escrito:** 2026-09-21, contra la consola publicada (commit `d31fcb4`).

Diez guiones listos para grabar. Cada paso nombra el botón tal como está en la
consola; si un botón no existe, el guion lo dice en vez de inventarlo.

**Cómo grabar.** Empresa nueva, creada para el video. No uses una que ya tenga
datos: esconde justamente lo que hay que enseñar. Narración en voz argentina,
sin música sobre la explicación.

**Qué respalda estos guiones.** Los rótulos salen de la consola publicada. Los
videos **01 y 02** cubren tramos **verificados en producción** —registro,
correo, MFA, empresa, roles, plan de cuentas y ejercicio—. Los pasos de los
videos **03, 04, 05, 06 y 07** (mapeo, subir documento, documento a
comprobante, comprobante a asiento, aprobación y Mayor) también están
**verificados en producción**,
desde el 2026-09-22, con una operación real —VENTA 1-1-102, asiento
`01a0c725-bc0d-7eea-944c-8cd1cf0fe3be`—; evidencia completa en
[`MATRIZ-FUNCIONALIDADES-NEXO.md`](MATRIZ-FUNCIONALIDADES-NEXO.md). Grabarlos
no es la primera vez que se recorren ahí, pero sigue siendo la primera vez que
se graban: si algo no coincide con lo que ves en pantalla, es un hallazgo.
Los videos **08 y 09** (terceros y productos) están implementados y
desplegados, sin una ejecución de punta a punta registrada todavía en
producción.

**Una regla que atraviesa todos:** cuando NEXO se niegue a hacer algo, **no
cortes**. Que se vea el mensaje. La mitad de lo que hay que enseñar es por qué
el sistema se planta.

---

## VIDEO 01 · Primer ingreso a NEXO

**Objetivo:** de no tener cuenta a estar adentro con el segundo factor puesto.
**Duración:** 4-5 min · **Audiencia:** cualquiera que empiece.
**Pantalla inicial:** `nexointelligence.com.ar/consola`, sesión cerrada.

| # | Se ve | Se hace | Narración |
|---|---|---|---|
| 1 | Pantalla de ingreso | — | «Esto es NEXO. Lo primero es tener una cuenta.» |
| 2 | Se despliega el bloque | Clic en **«No tengo cuenta»** | «Abajo del ingreso está el alta.» |
| 3 | Tres campos | Correo, contraseña, nombre | «La contraseña va de doce caracteres para arriba.» |
| 4 | Aviso verde | **«Registrarme»** | «La cuenta queda **pendiente** hasta que confirmes el correo. Eso impide que alguien se registre con tu dirección.» |
| 5 | Casilla de correo | Abrir el mensaje | «Llega de no-reply arroba nexointelligence punto com punto ar.» |
| 6 | Código pegado | **«Ya tengo el código de confirmación»** → **«Confirmar»** | «Listo: ya podés entrar.» |
| 7 | Adentro | Correo y contraseña → **«Ingresar»** | «El campo de seis dígitos se deja vacío la primera vez.» |
| 8 | «Configurar el segundo factor» | **«Generar el secreto»** | «Tu rol lo exige. Hasta configurarlo, NEXO no te deja llegar a los datos de ninguna empresa.» |
| 9 | **QR grande** | Escanear con el teléfono | «Google Authenticator, Microsoft Authenticator, Authy o 1Password: sirven igual.» |
| 10 | Diez códigos | **Detenerse acá** | «Estos diez códigos de recuperación **guardalos en otro lado**. Cada uno sirve una vez y son la única forma de entrar si perdés el teléfono. No hay pantalla para volver a generarlos.» |
| 11 | Seis dígitos | **«Confirmar»** | «Y estamos adentro.» |

**Error que conviene mostrar:** poné un código vencido y que se vea el rechazo.
«El código dura treinta segundos.»
**Pantalla final:** «Crear mi empresa».

---

## VIDEO 02 · Configurar una empresa desde cero

**Objetivo:** empresa, rol, plan de cuentas y ejercicio.
**Duración:** 7-8 min · **Audiencia:** quien pone en marcha la empresa.
**Pantalla inicial:** «Crear mi empresa».

| # | Se ve | Se hace | Narración |
|---|---|---|---|
| 1 | Los cinco planes | Recorrerlos | «Cinco planes. **No se pide tarjeta**: la prueba dura catorce días y al terminar queda suspendida, sin borrar nada.» |
| 2 | Formulario | Estudio, razón social, CUIT | «El CUIT va sin guiones. El dígito verificador se comprueba.» |
| 3 | Tipo y jurisdicción | Elegir | «**Organismo** se deja en *(ninguno)* salvo que la empresa esté bajo IGJ, CNV, BCRA o INAES.» |
| 4 | Cierre (MM-DD) | Escribir `12-31` | «El mes y día en que cierra el ejercicio. De acá van a salir después las fechas propuestas.» |
| 5 | Panel | **«Crear y empezar la prueba»** | «Se creó todo junto: el estudio, la empresa, tu rol y la prueba.» |
| 6 | «Puesta en marcha» | Mostrar la tabla | «Esta lista dice qué falta. Fijate que tiene **cinco estados**, no dos: *impide trabajar* no es lo mismo que *sin declarar* ni que *no aplica*.» |
| 7 | Configuración | **Administración → Configuración** | «Antes de nada, un paso que se saltea siempre.» |
| 8 | «Dar un rol» | Elegirse, **CONTADOR**, **«Dar el rol»** | «Quien crea la empresa recibe **Administrador**, y ese rol **a propósito no firma la contabilidad**. Administrar el sistema no es firmar los libros. Sin Contador no vas a poder subir documentos ni aprobar asientos.» |
| 9 | Panel | **«Usar este plan»** | «Ciento ochenta y cinco cuentas, ciento cuarenta y tres imputables. No es un plan obligatorio: la norma no prescribe ninguno.» |
| 10 | Períodos y cierre | **Libros → Períodos y cierre** | «Falta el ejercicio. Sin un período abierto que contenga la fecha, no entra ningún asiento.» |
| 11 | Fechas propuestas | **«Abrir el ejercicio»** | «Las fechas vienen del cierre que declaraste. Si la empresa arrancó a mitad de año, corregí el *desde*: el primer ejercicio no empieza doce meses antes.» |
| 12 | Doce períodos | — | «Ejercicio abierto, con doce períodos.» |

**Error:** intentá abrir un ejercicio con el mismo código. «Ya existe un
ejercicio con ese código.»
**Pantalla final:** Panel diciendo **«NEXO está listo para operar»**.

---

## VIDEO 03 · Configurar el mapeo contable

**Objetivo:** declarar los roles para que NEXO proponga asientos.
**Duración:** 5-6 min · **Audiencia:** contador.
**Pantalla inicial:** Configuración → «Mapeo contable», con «Faltan: …».

| # | Se ve | Se hace | Narración |
|---|---|---|---|
| 1 | La tabla con «sin declarar» | — | «Ocho roles. Sin esto NEXO **no propone** el asiento de un comprobante. Ojo: no es que no puedas operar — podés, cargando todo a mano. Lo que se pierde es la propuesta.» |
| 2 | Los seis primeros | Señalarlos | «Con los seis primeros alcanza. Mercadería y costo de ventas sólo hacen falta si llevás existencias: una empresa de servicios no tiene mercadería, y reclamársela sería pedirle algo que no le corresponde.» |
| 3 | CLIENTES | `1.1.03.01` → **«Declarar»** | «Deudores por ventas. Es la contrapartida de una venta en cuenta corriente.» |
| 4 | **Error a propósito** | VENTAS → `4.1` → «Declarar» | «Miren esto. Cuatro punto uno *parece* la cuenta de ventas.» |
| 5 | El rechazo | — | «Y el sistema la rechaza: es una cuenta **agrupadora**, no imputable. Cada rol admite un solo tipo de cuenta y **la base lo comprueba**. Una cuenta del tipo equivocado descuadra el balance en silencio, y el error aparece un ejercicio después.» |
| 6 | Corrección | `4.1.01` → «Declarar» | «Ventas de mercaderías. Ésta sí.» |
| 7 | Los cuatro restantes | PROVEEDORES `2.1.01.01`, IVA_DEBITO `2.1.04.01`, IVA_CREDITO `1.1.04.01`, COMPRAS `5.1.03` | «Proveedores va al **pasivo**. Cuidado con *Anticipos a proveedores*, que suena parecido y es del activo: es plata que vos pusiste.» |
| 8 | «Está completo.» | — | «Cuando el aviso de arriba dice *está completo*, terminaste.» |

**Pantalla final:** la tabla sin ningún «sin declarar» en los seis primeros.

---

## VIDEO 04 · Subir y procesar un documento

**Objetivo:** subir, leer, revisar y corregir.
**Duración:** 5-6 min · **Audiencia:** administrativo.
**Pantalla inicial:** Operación → Documentos, vacía.

| # | Se ve | Se hace | Narración |
|---|---|---|---|
| 1 | Pantalla vacía | — | «Acá van las facturas, recibos y extractos.» |
| 2 | Selector | Elegir un XML | «Se admiten PDF, JPG, PNG, XML, CSV y XLSX.» |
| 3 | Fila `EXTRAIDO` | **«Subir»** | «Subir archiva el archivo y calcula su hash. La lectura corre sola.» |
| 4 | Estados | Señalar la columna | «Los estados son **recibido**, **extraído**, **imputado**, **anulado** y **rechazado**. *Extraído* es el único desde el que se registra el comprobante.» |
| 5 | «Lo que se leyó» | Abrir con **«abrir»** | «Cada campo con su valor, el **método** y la **confianza**. El método es lo que separa un dato leído de uno declarado.» |
| 6 | Corrección | **«corregir»** → valor → **«Guardar corrección»** | «La corrección **no pisa** la lectura del motor: se agrega con tu nombre al lado. Las dos quedan, y eso es a propósito.» |
| 7 | «Qué dice la lectura» | Mostrar | «Acá aparecen los hallazgos y si el documento se puede aprobar o imputar.» |

**Error:** subí un `.txt`. «El contenido no corresponde a ninguno de los tipos
admitidos.» Y si no hay OCR, mostrá `SIN_MOTOR_OCR`: «no es que no se haya
encontrado nada — es que no hubo con qué leerlo».
**Pantalla final:** documento `EXTRAIDO` con sus campos.

---

## VIDEO 05 · Convertir un documento en comprobante

**Objetivo:** del documento leído a la operación fiscal.
**Duración:** 5-6 min · **Audiencia:** contador y administrativo.
**Pantalla inicial:** documento `EXTRAIDO` abierto.

| # | Se ve | Se hace | Narración |
|---|---|---|---|
| 1 | El bloque | Bajar hasta **«Registrar el comprobante»** | «Acá el documento se vuelve contabilidad.» |
| 2 | Campos precargados | Recorrerlos | «Tipo, punto de venta, número, importes: todo sale de lo que leyó el motor. Y la fecha viene traducida — el XML de ARCA la trae como ocho dígitos pegados.» |
| 3 | Dirección vacía | Señalarla | «Esto **no** viene precargado, y es el único dato que el sistema te pide. Normalmente se deduciría comparando el CUIT de la empresa con el emisor y el receptor, pero un documento puede no tener a la empresa entre sus partes. Y equivocarla **invierte el asiento**.» |
| 4 | **Error a propósito** | «Registrar» sin dirección | «Falta la dirección: sin saber si es una compra o una venta, el asiento saldría al revés.» |
| 5 | Condición IVA | Señalar «desconocida» | «Esto se puede dejar así. La condición de IVA y la contraparte no salen del documento y el servidor no las exige. **Desconocida es una respuesta válida**; inventar una condición no lo es.» |
| 6 | **Segundo error** | Cambiar el total → «Registrar» | «El total declarado no coincide con el que extrajo el motor. **Se corta**: elegir uno en silencio es peor que preguntar.» |
| 7 | Éxito | Restaurar, COMPRAS → **«Registrar el comprobante»** | «Comprobante registrado.» |
| 8 | **Reintento** | Apretar otra vez | «Y miren: *este documento ya tenía su comprobante*. No es un error — un documento produce **una sola** operación fiscal, y quien reintenta merece la que ya existe.» |
| 9 | Operaciones | **Operación → Operaciones** | «Acá está.» |

**Pantalla final:** el comprobante en la lista.

---

## VIDEO 06 · Del comprobante al asiento

**Objetivo:** ver la propuesta y cargarla.
**Duración:** 4-5 min · **Audiencia:** contador.
**Pantalla inicial:** Operaciones, comprobante abierto. **Mapeo ya declarado.**

| # | Se ve | Se hace | Narración |
|---|---|---|---|
| 1 | Detalle | — | «El comprobante está registrado. Todavía no hay asiento.» |
| 2 | Renglones propuestos | **«Ver la propuesta»** | «Esto es lo que NEXO **propondría**: cuenta, debe, haber y descripción.» |
| 3 | Las cuentas | Señalarlas | «Salen del mapeo contable. Si no lo declaraste, acá no hay nada.» |
| 4 | El botón | Señalar **«Cargar como asiento en borrador»** | «La propuesta se pide, se mira, y **recién después** se carga. Nunca se carga sola: la diferencia entre proponer e imponer es que alguien mire en el medio.» |
| 5 | Asiento creado | Clic | «Quedó en borrador.» |
| 6 | Volver a proponer | **«Ver la propuesta»** otra vez | «Y ahora el botón de cargar no está: *este comprobante ya tiene un asiento, la propuesta se muestra para comparar*. Ofrecerlo sería invitar a duplicarlo — y el duplicado pasa todos los controles.» |

**Si el mapeo no está:** mostralo. La propuesta sale vacía. «Esto es lo que
pasa sin mapeo: hay que ir a Configuración.»
**Pantalla final:** el asiento en Libros → Asientos.

---

## VIDEO 07 · Aprobar un asiento y consultar el Mayor

**Objetivo:** cerrar el circuito.
**Duración:** 4-5 min · **Audiencia:** contador.
**Pantalla inicial:** Libros → Asientos, con un asiento sin aprobar.

| # | Se ve | Se hace | Narración |
|---|---|---|---|
| 1 | La lista | — | «Cuatro estados: **borrador**, **propuesto**, **aprobado** y **anulado**.» |
| 2 | Detalle | **«abrir»** | «Número, fecha, debe, haber, **origen** y **decisión que lo funda**.» |
| 3 | Origen | Señalarlo | «Dice si lo cargó una persona o salió del motor. Esa distinción no se pierde nunca.» |
| 4 | Aprobación | **«Aprobar»** | «**Aprobado: recién ahora se proyecta al Mayor.** Hasta este momento el asiento no existía para los libros.» |
| 5 | Quién puede | — | «Sólo quien tenga el permiso de aprobar, que trae el rol **Contador**. El Administrador **no** puede: es la separación que la base impone, no la pantalla.» |
| 6 | Mayor | **Libros → «Mayor»** | «Y acá está el movimiento.» |
| 7 | Balance | **«Balance»** | «Debe igual a haber, con sus verificaciones: sumas iguales, saldos iguales, y saldo por cuenta.» |
| 8 | CSV | Señalar los botones | «Todo se baja en CSV.» |

**Pantalla final:** el balance cuadrando.

---

## VIDEO 08 · Alta de terceros

**Objetivo:** cargar y corregir un cliente.
**Duración:** 3-4 min · **Audiencia:** administrativo.
**Pantalla inicial:** Ventas → Terceros.

| # | Se ve | Se hace | Narración |
|---|---|---|---|
| 1 | Lista y filtros | — | «Clientes y proveedores viven en el mismo lugar: un tercero puede ser las dos cosas.» |
| 2 | Alta | Tipo, número, razón social, IVA, contacto | «Marcá si es cliente, proveedor, o ambos.» |
| 3 | Fila nueva | **«Dar de alta»** | — |
| 4 | Ficha | **«ficha»** | «Acá se corrige.» |
| 5 | **El documento arriba** | Señalarlo | «Fijate que el documento está arriba, como dato fijo, y **no se edita**. Cambiarlo convertiría esta ficha en otra persona conservando sus movimientos. Si el número está mal, se archiva ésta y se da de alta la correcta.» |
| 6 | Motivo | Corregir + motivo → **«Guardar los cambios»** | «El motivo queda en la bitácora. No es burocracia: es lo que permite contestar después por qué cambió.» |
| 7 | Cuenta corriente | **«cuenta corriente»** | «Antigüedad de saldos, imputaciones y notas de crédito.» |

**Error:** guardar sin motivo. «El motivo queda en la bitácora: escribí uno.»

---

## VIDEO 09 · Alta de productos

**Objetivo:** cargar y corregir un producto.
**Duración:** 3-4 min · **Audiencia:** administrativo.
**Pantalla inicial:** Ventas → Productos.

| # | Se ve | Se hace | Narración |
|---|---|---|---|
| 1 | Lista | — | «Productos y servicios.» |
| 2 | Alta | Código, nombre, unidad | — |
| 3 | **Error a propósito** | Gravado sin impuesto → «Dar de alta» | «Un producto gravado tiene que decir **qué impuesto** le aplica. La alícuota no: ésa la resuelve el sistema por la fecha de cada operación, porque cambia.» |
| 4 | Corrección | Elegir IVA → **«Dar de alta»** | — |
| 5 | Ficha | **«ficha»** | «Nombre, descripción, unidad, cuentas, precio y stock mínimo se corrigen.» |
| 6 | Lo fijo | Señalar arriba | «El código **no**: es la referencia con la que el producto ya figura en presupuestos, remitos y listas impresas. Tampoco el tratamiento impositivo ni si lleva stock, porque de eso dependen movimientos ya registrados.» |

---

## VIDEO 10 · Una operación completa, de punta a punta

**Objetivo:** el recorrido entero en un solo video.
**Duración:** 12-15 min · **Audiencia:** quien evalúa NEXO.
**Pantalla inicial:** sesión cerrada, empresa inexistente.

**Estructura:** registro → correo → MFA → empresa → **rol Contador** → plan de
cuentas → ejercicio → mapeo → documento → comprobante → propuesta → carga →
aprobación → Mayor.

| Tramo | Minutos | De qué video sale |
|---|---|---|
| Registro, correo y MFA | 0:00-2:30 | 01 |
| Empresa y rol de Contador | 2:30-5:00 | 02 |
| Plan de cuentas y ejercicio | 5:00-7:00 | 02 |
| Mapeo contable | 7:00-9:00 | 03 |
| Documento y comprobante | 9:00-11:30 | 04 y 05 |
| Propuesta, carga y aprobación | 11:30-13:30 | 06 y 07 |
| Mayor y balance | 13:30-15:00 | 07 |

**Cierre sugerido:** «Eso es NEXO de punta a punta: una empresa nueva,
operativa, sin que nadie toque una base de datos ni un servidor.»

### Lo que este video NO puede mostrar, y hay que decirlo

**Emitir una factura electrónica con CAE.** La capacidad está construida y
**cerrada a propósito**: `EMISION_HABILITADA` es una constante del código en
`false`, y el paquete que habla con ARCA está fuera del grafo de la aplicación.
Se escribió así porque una factura emitida no se deshace, y las reglas que lo
impiden se escribieron antes que el camino que lo produciría.

**Si el video dice «y acá facturás», miente.** NEXO **registra** comprobantes y
los **constata** contra ARCA; no los emite.

Guion sugerido para el cierre honesto: «Una cosa más, y es importante: NEXO
todavía **no emite** facturas electrónicas. Registra los comprobantes y los
constata contra ARCA, pero la emisión está cerrada a propósito hasta que esté
completa la reconciliación. Cuando se abra, va a ser un cambio de una línea —
pero hasta entonces, no lo prometemos.»

---

## Dónde se corta cada guion

| Video | ¿Se puede grabar entero hoy? | Dónde se corta |
|---|---|---|
| 01 Primer ingreso | **Sí** | — · verificado en producción |
| 02 Configurar empresa | **Sí** | — · verificado en producción |
| 03 Mapeo contable | **Sí** | En producción el mapeo ya está declarado. **Verificado en producción** (2026-09-22) |
| 04 Subir documento | **Parcial** | Con PDF o imagen sin OCR, la extracción responde `SIN_MOTOR_OCR`. **Grabar con XML** · verificado en producción |
| 05 Documento a comprobante | **Sí** | **Verificado en producción** (2026-09-22, VENTA 1-1-102) |
| 06 Comprobante a asiento | **Sí** | Requiere el mapeo del video 03. **Verificado en producción** (asiento `01a0c725-bc0d-7eea-944c-8cd1cf0fe3be`) |
| 07 Aprobar y Mayor | **Sí** | Requiere rol Contador. **Verificado en producción** |
| 08 Terceros | **Sí** | — |
| 09 Productos | **Sí** | — |
| 10 Punta a punta | **Sí, salvo emisión** | No incluye emitir con CAE: está cerrado. **El tramo documento → comprobante → mapeo → propuesta → asiento → Mayor se verificó en producción** (2026-09-22); terceros y productos, los otros tramos de este guion, no tienen todavía una ejecución de punta a punta registrada ahí |

---

## Videos que NO conviene grabar todavía

| Tema | Por qué |
|---|---|
| Emitir una factura con CAE | Cerrado por diseño |
| Trazabilidad desde un estado contable | El endpoint existe y **no hay pantalla** |
| Editar los renglones de un comprobante | Sin pantalla |
| Panel del estudio (varias empresas) | Sin pantalla |
| Retenciones | Sin implementar |
| Libro IVA Digital | Bloqueado: los diseños de registro no están publicados |
| Propuestas de IA con confianza alta | `accounting_rules` está vacía: hoy **todo** cae en revisión profesional |

Ver [`MANUAL-USUARIO-NEXO.md`](MANUAL-USUARIO-NEXO.md) y
[`MATRIZ-FUNCIONALIDADES-NEXO.md`](MATRIZ-FUNCIONALIDADES-NEXO.md).
