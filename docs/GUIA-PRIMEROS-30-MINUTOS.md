# Los primeros 30 minutos en NEXO

**Escrito:** 2026-09-21, contra la consola publicada (commit `d31fcb4`).

Acabás de crear tu cuenta. Esto te lleva desde ahí hasta tener una empresa que
registra y aprueba un asiento. Seguilo literalmente.

> Si algo no coincide con lo que ves, **no sigas de largo**: la diferencia
> importa. Al final de cada paso está qué hacer si falla.

**Qué respalda esta guía.** Los pasos 1 a 6 están **verificados en
producción**: hay una cuenta activa con su segundo factor, una empresa, el
ejercicio 2026 abierto con sus doce períodos y el plan de cuentas cargado. Los
pasos **7 a 12 están implementados y desplegados, y todavía no los ejecutó
nadie en producción** — se recorrieron enteros en una instalación local. Si sos
la primera persona en hacerlos ahí, avisá si algo no coincide.

**Lo que vas a necesitar a mano:** tu CUIT, el mes y día en que cierra tu
ejercicio, y el teléfono con una aplicación de códigos.

---

## PASO 1 — Confirmar tu correo · 2 min

**Dónde estoy:** en tu casilla de correo.

**Qué hago:** abro el mensaje de **NEXO `<no-reply@nexointelligence.com.ar>`**,
copio el código, vuelvo a `nexointelligence.com.ar/consola`, abro **«No tengo
cuenta» → «Ya tengo el código de confirmación»**, lo pego y aprieto
**«Confirmar»**.

**Qué debería ver:** «Listo: ya podés entrar.»

**Qué significa:** tu cuenta pasó de *pendiente* a activa. Sin esto no entrás.

**Si falla:** abrí **«No me llegó»**, escribí tu correo y apretá **«Mandar
otro»**. El código anterior deja de servir. Si el aviso dice que *no hay
proveedor de correo configurado*, el alta la tiene que completar quien
administra el servidor.

---

## PASO 2 — Entrar y configurar el segundo factor · 5 min

**Dónde estoy:** en la pantalla de ingreso.

**Qué hago:** correo y contraseña, **«Ingresar»**. El campo de seis dígitos lo
dejo vacío. Aparece **«Configurar el segundo factor»**: aprieto **«Generar el
secreto»**, escaneo el **QR** con la aplicación de códigos, escribo los seis
dígitos y aprieto **«Confirmar»**.

**Qué debería ver:** el código QR sobre fondo blanco, los diez **códigos de
recuperación**, y después «Segundo factor configurado».

**Qué significa:** tu rol exige segundo factor. Hasta configurarlo, NEXO no te
deja llegar a los datos de ninguna empresa.

**Si falla:** revisá que el reloj del teléfono esté en hora — el código dura 30
segundos. **Guardá los diez códigos de recuperación en otro lado**: son la
única forma de entrar si perdés el teléfono, y no hay pantalla para
regenerarlos.

---

## PASO 3 — Crear tu empresa · 4 min

**Dónde estoy:** en **«Crear mi empresa»**, que aparece solo.

**Qué hago:** completo nombre del estudio, razón social, **CUIT**, tipo,
jurisdicción, **cierre (MM-DD)** y plan. Aprieto **«Crear y empezar la
prueba»**.

**Qué debería ver:** el **Panel**, con el aviso de la prueba de 14 días y el
bloque **«Puesta en marcha»** diciendo *«2 cosas impiden registrar»*.

**Qué significa:** se crearon de una sola vez el estudio, la empresa, tu rol de
administrador y la prueba. **No se pide tarjeta.**

**Si falla:** si dice que el CUIT es inválido, revisá el dígito verificador —
son 11 dígitos sin guiones. **«Organismo»** se deja en *(ninguno)* salvo que tu
empresa esté bajo IGJ, CNV, BCRA o INAES.

---

## PASO 4 — Darte el rol de Contador · 2 min

> **Éste es el paso que más se saltea, y sin él no podés hacer contabilidad.**

**Dónde estoy:** **Administración → Configuración**.

**Qué hago:** bajo hasta **«Personas con acceso»**, después **«Dar un rol»**.
Me elijo a mí, elijo **CONTADOR** y aprieto **«Dar el rol»**.

**Qué debería ver:** «Rol otorgado.», y tu nombre listado dos veces — una por
cada rol.

**Qué significa:** quien crea la empresa recibe **ADMINISTRADOR**, que **a
propósito no firma la contabilidad**. Sin `CONTADOR` no vas a poder subir
documentos, crear asientos ni aprobarlos.

**Si falla:** si el selector de personas está vacío, actualizá la pantalla con
**«Actualizar»**.

---

## PASO 5 — Cargar el plan de cuentas · 1 min

**Dónde estoy:** **Inicio → Panel**, en «Puesta en marcha».

**Qué hago:** abajo está **«Empezar con el plan de cuentas modelo»**. Miro con
**«Ver las cuentas»** y aprieto **«Usar este plan»**.

**Qué debería ver:** el paso «Cargar el plan de cuentas» pasa a **listo** con
**143** cuentas imputables, y el contador de cosas que impiden registrar baja
de 2 a 1.

**Qué significa:** ya tenés dónde imputar. No es un plan obligatorio: la norma
no prescribe ninguno, y las cuentas quedan siendo tuyas.

**Si falla:** si el bloque no aparece, es que el plan ya estaba cargado.

---

## PASO 6 — Abrir el ejercicio · 2 min

**Dónde estoy:** **Libros → Períodos y cierre**.

**Qué hago:** abajo, en **«Abrir un ejercicio»**, reviso **Código**, **Desde**
y **Hasta** — vienen propuestos desde el cierre que declaraste —, dejo
**«generar los meses»** y aprieto **«Abrir el ejercicio»**.

**Qué debería ver:** «Ejercicio abierto, con 12 período(s).», el ejercicio en
`ABIERTO` y doce períodos listados.

**Qué significa:** el ejercicio crea los períodos, y **sin un período abierto
que contenga la fecha no entra ningún asiento**.

**Si falla:** si es el primer ejercicio de una empresa que arrancó a mitad de
año, corregí **Desde**: no empieza doce meses antes, empieza cuando empezó la
empresa. Si dice que se superpone, ya hay otro ejercicio cubriendo esas fechas.

---

## PASO 7 — Declarar el mapeo contable · 5 min

**Dónde estoy:** **Administración → Configuración → «Mapeo contable»**.

**Qué hago:** elijo rol, escribo el código de cuenta, aprieto **«Declarar»**.
Seis veces:

| Rol | Cuenta |
|---|---|
| `CLIENTES` | `1.1.03.01` |
| `PROVEEDORES` | `2.1.01.01` |
| `IVA_DEBITO` | `2.1.04.01` |
| `IVA_CREDITO` | `1.1.04.01` |
| `VENTAS` | `4.1.01` |
| `COMPRAS` | `5.1.03` |

Si tu empresa lleva **existencias**, agregá `MERCADERIA` → `1.1.05.01` y
`COSTO_DE_VENTAS` → `5.1.01`.

**Qué debería ver:** el aviso de arriba pasa de «Faltan: …» a **«Está
completo.»**

**Qué significa:** el mapeo es lo que le permite a NEXO **proponer** el asiento
de un comprobante. **No es obligatorio para operar**: sin él se puede cargar
todo a mano.

**Si falla:** «Esa cuenta no sirve para ese rol» significa que el tipo no
corresponde. Los dos errores habituales: **`4.1` no sirve** para VENTAS —es
agrupadora, va `4.1.01`— y **«Anticipos a proveedores» no sirve** para
PROVEEDORES, porque es del activo.

---

## PASO 8 — Subir tu primer documento · 3 min

**Dónde estoy:** **Operación → Documentos**.

**Qué hago:** elijo el archivo y aprieto **«Subir»**.

**Qué debería ver:** una fila con el nombre, el tipo, el estado **`EXTRAIDO`**,
la confianza y «sin observaciones».

**Qué significa:** el archivo quedó archivado con su hash y la lectura corrió
sola.

**Si falla:** se admiten **PDF, JPG, PNG, XML, CSV y XLSX**. Si dice
`SIN_MOTOR_OCR`, no hay motor de OCR instalado: con un **XML** la lectura
funciona igual. Si el estado queda en `RECIBIDO`, la lectura no produjo campos y
vas a tener que completarlos a mano.

---

## PASO 9 — Registrar el comprobante · 3 min

**Dónde estoy:** en Documentos, abriendo el documento con **«abrir»**.

**Qué hago:** bajo hasta **«Registrar el comprobante»**. Está casi todo
precargado. Elijo la **Dirección** —COMPRAS o VENTAS— y aprieto **«Registrar el
comprobante»**.

**Qué debería ver:** «Comprobante registrado.»

**Qué significa:** los importes quedaron fijados. Ahí empieza lo contable.

**Si falla:**

- «Falta la dirección» → elegila; **no se deduce sola**, y equivocarla invierte
  el asiento.
- «El total declarado no coincide con el que extrajo el motor» → corregí el
  importe, o corregí el campo arriba en «Lo que se leyó».
- «Este documento ya tenía su comprobante» → **no es un error**, ya estaba
  hecho.
- Si el bloque no aparece: el documento no está en `EXTRAIDO`, o te falta el rol
  `CONTADOR` del paso 4.

---

## PASO 10 — De la propuesta al asiento · 3 min

**Dónde estoy:** **Operación → Operaciones**, abriendo el comprobante.

**Qué hago:** aprieto **«Ver la propuesta»**, la miro, y si está bien aprieto
**«Cargar como asiento en borrador»**.

**Qué debería ver:** los renglones propuestos con cuenta, debe, haber y
descripción.

**Qué significa:** NEXO propone; **no registra**. La diferencia entre proponer e
imponer es que alguien mire en el medio.

**Si falla:** si no hay renglones, falta el mapeo del paso 7. Si dice que el
comprobante ya tiene asiento, la propuesta se muestra sólo para comparar.

> **Camino alternativo:** podés saltear esto y cargar el asiento a mano en
> **Libros → Asientos**: libro, fecha, estado, descripción, cuenta al debe,
> cuenta al haber, importe y justificación, y **«Registrar»**.

---

## PASO 11 — Aprobar el asiento · 1 min

**Dónde estoy:** **Libros → Asientos**.

**Qué hago:** aprieto **«abrir»** en la fila y después **«Aprobar»**.

**Qué debería ver:** «Aprobado: recién ahora se proyecta al Mayor», y la fila
pasa a **`APROBADO`**.

**Qué significa:** hasta la aprobación el asiento no existe para el Mayor. La
firma es humana siempre.

**Si falla:** si no aparece «Aprobar», te falta `journal_entry:approve`, que
trae el rol **CONTADOR** — paso 4.

---

## PASO 12 — Ver el Mayor · 1 min

**Dónde estoy:** **Libros → Libros**.

**Qué hago:** aprieto **«Mayor»**. También podés apretar **«Balance»**.

**Qué debería ver:** tu asiento, y en el balance que **debe = haber**, con las
verificaciones en verde.

**Qué significa:** el circuito está cerrado. Tu empresa opera.

---

## Listo. ¿Y ahora?

Con esto tenés una empresa que registra y aprueba. Lo que sigue, cuando lo
necesites:

| Para | Andá a |
|---|---|
| Clientes y proveedores | Ventas → Terceros → «Dar de alta» |
| Productos | Ventas → Productos → «Dar de alta» |
| Facturar contra ARCA | Configuración → «Cargar un certificado» |
| Caja y bancos | Dinero |
| Ver cómo va el negocio | Análisis → Analítica, y Inicio → Preguntar |

**Una cosa que conviene saber de entrada:** NEXO **no puede emitir facturas
electrónicas con CAE**. Registra comprobantes y los constata contra ARCA, pero
la emisión está cerrada a propósito. Si esperabas facturar desde acá, todavía
no se puede.

El manual completo está en
[`MANUAL-USUARIO-NEXO.md`](MANUAL-USUARIO-NEXO.md).
