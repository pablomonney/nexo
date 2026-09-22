# Manual de usuario de NEXO

**Escrito:** 2026-09-21, contra la consola que está publicada en
`nexointelligence.com.ar` (commit `d31fcb4`).

Este manual dice **cómo se usa NEXO**, no cómo está hecho. Cada nombre de botón
se verificó contra la consola: si acá dice «apretá X», X existe con ese nombre.

---

## Qué respalda cada procedimiento

**Que un procedimiento esté escrito no significa que alguien lo haya ejecutado
en producción.** Son dos cosas distintas y este manual no las mezcla.

| Marca | Qué quiere decir |
|---|---|
| **VERIFICADO EN PRODUCCIÓN** | Se ejecutó realmente contra `nexointelligence.com.ar` y quedó rastro |
| **VERIFICADO POR TEST** | Hay prueba automatizada que lo ejercita |
| **DOCUMENTADO SEGÚN IMPLEMENTACIÓN** | El código y la pantalla existen y están desplegados; **todavía no se hizo la prueba de punta a punta** |
| **PARCIAL** | Una parte se puede y otra no |
| **BACKEND DISPONIBLE / UI NO EXPUESTA** | El endpoint existe, tiene permiso y test; no hay pantalla |
| **NO DISPONIBLE** | No existe |
| **CERRADO** | Construido y deshabilitado a propósito |
| **SÓLO TÉCNICO** | Requiere línea de comandos o acceso al servidor |

No hay una categoría para «casi».

### Lo que sí está verificado en producción, hoy

Comprobado el 2026-09-21 leyendo el estado del servidor:

| Qué | Evidencia |
|---|---|
| Registro → correo → verificación → MFA | Una cuenta activa con segundo factor, y dos mensajes en estado `ENVIADO` al primer intento |
| Empresa creada | 1 empresa |
| **Ejercicio 2026 `ABIERTO`, 12 períodos**, el actual incluido | Consulta a la base |
| **Plan de cuentas: 185 cuentas** | Consulta a la base |
| **Roles `ADMINISTRADOR` y `CONTADOR`** asignados | Consulta a la base |
| La consola sirve las pantallas nuevas | Descarga de `/consola` |

### El tramo documento → Mayor, verificado en producción el 2026-09-22

El tramo **documento → comprobante → mapeo contable → propuesta → asiento en
borrador → aprobación → Mayor** se recorrió de punta a punta contra
`nexointelligence.com.ar`, con una operación real: documento
`factura-prueba-nexo-0001-00000102.xml`, comprobante VENTA 1-1-102 ($123.420),
asiento `01a0c725-bc0d-7eea-944c-8cd1cf0fe3be` (`PROPUESTO` → `APROBADO`) y
Mayor verificado. Va marcado como **VERIFICADO EN PRODUCCIÓN** en cada
sección. Evidencia completa, con los tres renglones contables, en
[`MATRIZ-FUNCIONALIDADES-NEXO.md`](MATRIZ-FUNCIONALIDADES-NEXO.md).

Sobre esa misma operación quedaron tres pendientes sin resolver a propósito
—constatación, decisión, afectación— y ninguno bloqueó el circuito. Aparte,
la bandeja tenía 8 pendientes `REQUIERE_APROBACION` de períodos ya cerrados
(enero-agosto de 2026): es deuda operativa previa, no parte de esta prueba.

---

## 0 · El mapa de NEXO

```
REGISTRO ─────────────► correo de verificación ─► confirmación
   │
   ▼
SEGUNDO FACTOR (MFA) ──► obligatorio para Administrador, Contador y Auditor
   │
   ▼
EMPRESA ───────────────► se crea junto con el estudio y la prueba de 14 días
   │
   ▼
ROLES ─────────────────► quien crea la empresa es ADMINISTRADOR
   │                     y NO puede firmar contabilidad: hay que darse CONTADOR
   ▼
PLAN DE CUENTAS ───────► «Usar este plan» carga el plan modelo (185 cuentas)
   │
   ▼
EJERCICIO ─────────────► Períodos y cierre → «Abrir el ejercicio»
   │                     crea los períodos; sin uno abierto no entra nada
   ▼
MAPEO CONTABLE ────────► 8 roles; con los 6 primeros alcanza para operar
   │
   ▼
DOCUMENTOS ────────────► subir → se extrae solo → revisar → corregir
   │
   ▼
COMPROBANTE ───────────► «Registrar el comprobante» (en Documentos)
   │
   ▼
PROPUESTA ─────────────► Operaciones → «Ver la propuesta»
   │
   ▼
CARGA HUMANA ──────────► «Cargar como asiento en borrador»
   │
   ▼
APROBACIÓN ────────────► Asientos → abrir → «Aprobar»
   │
   ▼
MAYOR ─────────────────► Libros → «Mayor»
```

**Dos diferencias con el orden que se suele suponer.** Los roles vienen
**antes** que todo lo contable, porque sin `CONTADOR` no se puede aprobar nada.
Y el mapeo contable **no bloquea**: sin él se puede operar igual, cargando los
asientos a mano; lo que se pierde es que NEXO los **proponga**.

---

## A · Primer ingreso

### A.1 · Registrarse

1. Entrá a `https://nexointelligence.com.ar/consola`.
2. Abrí **«No tengo cuenta»**.
3. Completá **correo**, **contraseña** (12 caracteres o más) y **nombre y apellido**.
4. Apretá **«Registrarme»**.

**Qué deberías ver:** un aviso verde diciendo que si la dirección no estaba
registrada, el mensaje ya salió.

> La cuenta queda **pendiente** hasta que confirmes el correo. Eso impide que
> alguien se registre con tu dirección y se quede esperando a que vos entres.

### A.2 · Confirmar el correo

Te llega un mensaje de **NEXO `<no-reply@nexointelligence.com.ar>`** con un
código. Volvé a la pantalla de ingreso, abrí **«Ya tengo el código de
confirmación»**, pegalo y apretá **«Confirmar»**.

**Qué deberías ver:** «Listo: ya podés entrar.»

**Si no llega:** abrí **«No me llegó»**, escribí tu correo y apretá **«Mandar
otro»**. Eso **invalida el código anterior** y manda uno nuevo — a propósito:
dos códigos vivos duplican la superficie por la que se puede tomar una cuenta.

> **Si la instalación no tiene proveedor de correo**, la pantalla lo dice con
> todas las letras: *«no hay proveedor de correo configurado en esta
> instalación»*. En ese caso el alta la completa quien administra el servidor.
> En `nexointelligence.com.ar` el correo **está conectado**.

### A.3 · Entrar

Correo y contraseña, **«Ingresar»**. El campo de seis dígitos se deja vacío la
primera vez.

### A.4 · Configurar el segundo factor

Tu rol lo exige, y hasta que esté configurado la API no deja llegar a los datos
de ninguna empresa.

1. Apretá **«Generar el secreto»**.
2. Instalá una aplicación de códigos: Google Authenticator, Microsoft
   Authenticator, Authy o 1Password sirven igual.
3. **Escaneá el código QR** que aparece.
4. Escribí los seis dígitos en **«Código de la aplicación»** y apretá
   **«Confirmar»**.

**Guardá los diez códigos de recuperación en otro lado.** Cada uno sirve una
sola vez y son la única forma de entrar si perdés el teléfono.

> Si no podés escanear, abajo del QR está el **secreto** para cargarlo a mano.
> La URI cruda queda plegada en «Ver la URI».

**Si algo falla:**

| Qué pasa | Qué hacer |
|---|---|
| El código no se acepta | Fijate que el reloj del teléfono esté en hora; el código dura 30 segundos |
| Perdiste el teléfono | Usá un código de recuperación en el campo de seis dígitos |
| Se acabaron los códigos de recuperación | **Requiere intervención técnica.** No hay pantalla para regenerarlos |

---

## B · Configuración inicial de una empresa

### B.1 · Crear la empresa

Después de entrar, si todavía no tenés ninguna, aparece **«Crear mi empresa»**.
Crea el estudio, la empresa, tu rol de administrador y la prueba de 14 días,
todo junto.

| Dato | Obligatorio | Nota |
|---|---|---|
| Nombre del estudio | sí | |
| Razón social | sí | |
| CUIT | sí | 11 dígitos; el dígito verificador se comprueba |
| Tipo | sí | SA, SRL, SAS, Unipersonal, y ocho más |
| Jurisdicción | sí | Nacional, CABA o Buenos Aires |
| Organismo | no | IGJ, CNV, BCRA, INAES o PROVINCIAL, **sólo si la empresa tiene** |
| Cierre (MM-DD) | sí | El mes y día en que cierra el ejercicio. `12-31` es lo habitual |
| Plan | sí | Cinco planes; **no se pide tarjeta** |

Apretá **«Crear y empezar la prueba»**.

**Qué deberías ver:** el Panel, con el aviso de la prueba arriba y el bloque
**«Puesta en marcha»**, que lista lo que falta.

### B.2 · Darte el rol de Contador — el paso que más se pasa por alto

Quien crea la empresa recibe **ADMINISTRADOR**. Ese rol **a propósito no firma
la contabilidad**: administrar el sistema no es firmar los libros. Sin
`CONTADOR` no vas a poder subir documentos, crear asientos ni aprobarlos.

1. **Administración → Configuración**.
2. Bajá hasta **«Personas con acceso»** y después **«Dar un rol»**.
3. Elegí tu nombre, elegí **CONTADOR** y apretá **«Dar el rol»**.

**Qué deberías ver:** «Rol otorgado.» y tu nombre listado dos veces, una por
rol.

> Los roles se suman: una misma persona puede administrar y llevar la
> contabilidad. Lo que nunca se junta es **proponer y aprobar** un asiento —
> eso lo impide la base, no la pantalla.

Los seis roles del sistema:

| Rol | Para qué | Exige MFA |
|---|---|---|
| `ADMINISTRADOR` | Configuración, usuarios y reapertura de períodos | sí |
| `CONTADOR` | Aprueba, modifica, rechaza, reclasifica, cierra períodos y emite estados | sí |
| `AUDITOR` | Sólo lectura total más la bitácora completa. No modifica nada | sí |
| `USUARIO_EMPRESA` | Ve su empresa, carga documentación y consulta reportes | no |
| `CARGADOR` | Sube documentos y ve el estado de su procesamiento | no |
| `SOLO_LECTURA` | Consulta | no |

### B.3 · Cargar el plan de cuentas

En el **Panel**, dentro de «Puesta en marcha», está **«Empezar con el plan de
cuentas modelo»**.

- **«Ver las cuentas»** muestra el plan antes de aceptarlo.
- **«Usar este plan»** lo carga: **185 cuentas, 143 imputables**.

> No es un plan oficial ni obligatorio: la norma no prescribe ninguno. Es un
> punto de partida, y las cuentas quedan siendo tuyas.

### B.4 · Abrir el ejercicio

**Sin un período abierto que contenga la fecha, no entra ningún asiento.**

1. **Libros → Períodos y cierre**.
2. Abajo está **«Abrir un ejercicio»**, con las fechas ya propuestas a partir
   del cierre que declaraste para la empresa.
3. Revisá **Código**, **Desde**, **Hasta**, dejá **«generar los meses»** y
   apretá **«Abrir el ejercicio»**.

**Qué deberías ver:** «Ejercicio abierto, con 12 período(s).», el ejercicio en
estado `ABIERTO` y los doce períodos listados.

> El primer ejercicio de una empresa que arrancó a mitad de año **no empieza
> doce meses antes**: empieza cuando empezó la empresa. Por eso las fechas se
> proponen y no se imponen.

### B.5 · Declarar el mapeo contable

Ver la sección **H**.

### B.6 · Certificado de ARCA — opcional

**Administración → Configuración → «ARCA — certificados» → «Cargar un
certificado»**. Ver la sección **L**.

**Sin certificado se puede operar igual.** Lo que no se puede es **constatar un
comprobante contra ARCA**: la constatación queda declarada en vez de
confirmada.

---

## C · Plan de cuentas

**Dónde:** Administración → Configuración → **«Plan de cuentas»**.

### Consultar

Escribí código o nombre en **«Buscar»** y apretá **«Buscar»**. Se muestran las
primeras 40; si hay más, el aviso lo dice y te pide acotar.

### Agrupadoras contra imputables

| | |
|---|---|
| **Imputable** | Recibe asientos. En el plan modelo son **143** |
| **Agrupadora** | Sólo agrupa y **no** se puede usar en un asiento |

La columna **Imputable** dice «sí» o «no». Si elegís una agrupadora donde va
una imputable, el servidor la rechaza — por ejemplo `4.1` («Ventas de bienes»)
es agrupadora y `4.1.01` («Ventas de mercaderías») es la imputable.

### Crear una cuenta

Abrí **«Dar de alta una cuenta»**: **Código** (dígitos y puntos), **Nombre**,
**Tipo** e **Imputable**. Apretá **«Dar de alta»**.

### Editar

Apretá **«editar»** en la fila. Se puede cambiar **nombre**, **estado**,
**exige centro de costo** y **exige tercero**, con un **motivo** que queda en
la bitácora.

> **El código, el tipo y la naturaleza no se editan.** Son lo que hace
> comparable un ejercicio con el anterior, y ya viajan en los asientos
> registrados. Una cuenta con el código equivocado se archiva y se da de alta
> la correcta.

---

## D · Terceros

**Dónde:** Ventas → **Terceros**.

### Consultar

Filtros por texto, **Rol** (CLIENTE / PROVEEDOR) y **Estado**. Apretá
**«Buscar»**.

### Dar de alta

**Tipo de documento**, **número**, **razón social**, **condición IVA**,
**correo**, **teléfono**, **días de pago**, y las casillas de **cliente** y
**proveedor**. Apretá **«Dar de alta»**.

### Ver la ficha y editar

En la fila, **«ficha»**. Se puede corregir razón social, condición IVA, estado,
nombre de fantasía, correo, teléfono, días de pago y el domicilio completo.
Hace falta un **motivo**. Apretá **«Guardar los cambios»**.

> **El documento no se edita.** Cambiarlo convertiría la ficha en otra persona
> conservando sus movimientos: si el número está mal, se archiva ésta y se da
> de alta la correcta. La ficha lo muestra arriba, como dato fijo.

### Cuenta corriente

En la fila, **«cuenta corriente»**: antigüedad de saldos, imputaciones
sugeridas, imputar un cobro o pago, y aplicar una nota de crédito o débito.

---

## E · Productos

**Dónde:** Ventas → **Productos**.

### Dar de alta

**Código**, **nombre**, **tipo**, **unidad**, **tratamiento impositivo**,
**impuesto**, cuentas de venta y compra, **precio de lista** y **stock**.

> Si el producto es **gravado**, hay que decir **qué impuesto** le aplica. La
> alícuota no: ésa la resuelve el sistema por la fecha de cada operación.

### Ficha y edición

**«ficha»** en la fila. Se corrigen nombre, descripción, unidad, estado,
cuentas de venta y compra, precio de lista y stock mínimo, con **motivo**.

> **No se editan** el código, el tratamiento impositivo ni si lleva stock: de
> eso dependen movimientos ya registrados.

---

## F · Documentos

> **VERIFICADO EN PRODUCCIÓN el 2026-09-22.** «Registrar el comprobante» se
> ejecutó contra `nexointelligence.com.ar` con el documento
> `factura-prueba-nexo-0001-00000102.xml` → comprobante VENTA 1-1-102.
> Evidencia completa en
> [`MATRIZ-FUNCIONALIDADES-NEXO.md`](MATRIZ-FUNCIONALIDADES-NEXO.md).

**Dónde:** Operación → **Documentos**.

### El flujo

```
Subir → (extracción automática) → EXTRAIDO → revisar → corregir → Registrar el comprobante → IMPUTADO
```

### F.1 · Subir

Elegí el archivo y apretá **«Subir»**. Se admiten **PDF, JPG, PNG, XML, CSV y
XLSX**. Subir archiva el archivo y calcula su hash.

### F.2 · Los estados reales

| Estado | Qué significa |
|---|---|
| `RECIBIDO` | Archivado; la lectura no produjo campos |
| `EXTRAIDO` | Leído. **Es el único estado desde el que se registra el comprobante** |
| `IMPUTADO` | Ya produjo su operación fiscal |
| `ANULADO` | Dado de baja |
| `RECHAZADO` | No se aceptó |

> **`PROCESANDO` y `ERROR` no existen** en NEXO. Si alguna documentación los
> menciona, está equivocada.

### F.3 · Revisar y corregir

Al abrir un documento se ve **«Lo que se leyó»**: cada campo con su valor, el
**método** y la **confianza**. Apretá **«corregir»** en un campo, escribí el
valor correcto y **«Guardar corrección»**.

> La corrección **no pisa** la lectura del motor: se agrega con tu nombre al
> lado. Las dos quedan.

**«Volver a leer»** vuelve a correr la extracción. **«Descargar el original»**
baja el archivo tal como entró.

### F.4 · Registrar el comprobante

Con el documento en **`EXTRAIDO`** y con permiso de contabilidad, aparece
**«Registrar el comprobante»**, precargado con lo que leyó el motor.

| Campo | Precargado | Obligatorio |
|---|---|---|
| **Dirección** | **no** | **sí** — COMPRAS o VENTAS |
| Tipo, punto de venta, número | sí | sí |
| Fecha | sí, traducida de `20260919` a `2026-09-19` | sí |
| Neto, IVA, exento, total | sí | por defecto 0 |
| No gravado, percepciones | en 0 | por defecto 0 |
| CUIT de la contraparte | las partes del comprobante | **no** |
| Condición IVA | `desconocida` | **no** |

> **La dirección se pide y no se deduce.** Normalmente se sacaría comparando el
> CUIT de la empresa con el emisor y el receptor, pero un documento puede no
> tener a la empresa entre sus partes. Equivocarla **invierte el asiento**.

> **«Desconocida» es una respuesta válida.** La condición de IVA y la
> contraparte no salen del documento y el servidor no las exige: si no las
> sabés, dejalas como están. Inventar una condición no es una opción.

Apretá **«Registrar el comprobante»**.

**Qué deberías ver:** «Comprobante registrado.»

### F.5 · Qué puede salir mal

| Lo que dice | Qué pasó | Qué hacer |
|---|---|---|
| «Falta la dirección…» | No elegiste COMPRAS o VENTAS | Elegila |
| «El total declarado no es la suma de neto, IVA, no gravado, exento y percepciones» | La aritmética no cierra | Corregí los importes |
| «El total declarado no coincide con el que extrajo el motor» | Lo que escribiste difiere de lo leído | Corregí el importe, o corregí el campo en «Lo que se leyó» |
| «Este documento ya tenía su comprobante» | Ya se había registrado | **No es un error.** Buscalo en Operaciones |
| «hallazgo bloqueante» / «duplicado sin resolver» | La lectura encontró algo | Miralo en «Qué dice la lectura» antes de seguir |

---

## G · Comprobantes y operaciones

> **VERIFICADO EN PRODUCCIÓN el 2026-09-22.** El camino «Ver la propuesta» →
> «Cargar como asiento en borrador» se ejecutó con un comprobante real —VENTA
> 1-1-102— y produjo el asiento `01a0c725-bc0d-7eea-944c-8cd1cf0fe3be`.
> Evidencia completa en
> [`MATRIZ-FUNCIONALIDADES-NEXO.md`](MATRIZ-FUNCIONALIDADES-NEXO.md).

**Dónde:** Operación → **Operaciones**.

### Documento contra comprobante

| | |
|---|---|
| **Documento** | El archivo. Evidencia. No tiene efecto contable |
| **Comprobante** (operación fiscal) | Los importes fijados, con los que se decide y se asienta |

**Un documento produce un solo comprobante.** Si lo registrás dos veces, la
segunda te devuelve el que ya existe.

### Consultar

Filtros por **dirección**, **desde**, **hasta**, **CUIT** y **constatación**.
Apretá **«Buscar»**.

### Acciones disponibles

| Botón | Qué hace |
|---|---|
| **«Consultar a ARCA»** | Constata el comprobante contra el organismo. Requiere certificado |
| **«Declarar»** | Declara una constatación hecha por fuera, con tu firma |
| **«Ver la propuesta»** | Muestra el asiento que NEXO propone |
| **«Cargar como asiento en borrador»** | Crea el asiento a partir de la propuesta |

> Si el comprobante **ya tiene asiento**, la propuesta se muestra para comparar
> y el botón de cargar no aparece: sería invitar a duplicarlo.

**`BACKEND DISPONIBLE / UI NO EXPUESTA`** — los renglones del comprobante, sus
imputaciones, sus correcciones y la vinculación a un tercero del padrón tienen
endpoint y **no tienen pantalla**.

---

## H · Mapeo contable

> **DOCUMENTADO SEGÚN IMPLEMENTACIÓN.** Se declaró entero en local. En
> producción el mapeo **está sin declarar**: los ocho roles figuran en cero.

**Dónde:** Administración → Configuración → **«Mapeo contable»**.

Sin el mapeo, NEXO **no propone** el asiento de un comprobante. Se puede operar
igual: a mano.

### Los ocho roles

| Rol | Para qué | Tipo de cuenta |
|---|---|---|
| `CLIENTES` | La contrapartida de una venta en cuenta corriente | ACTIVO |
| `PROVEEDORES` | La contrapartida de una compra en cuenta corriente | PASIVO |
| `IVA_DEBITO` | El IVA que se le cobra al cliente y se le debe al fisco | PASIVO |
| `IVA_CREDITO` | El IVA que paga la empresa y computa contra el débito | ACTIVO |
| `VENTAS` | El neto gravado de una venta | INGRESO |
| `COMPRAS` | El neto gravado de una compra | COSTO o GASTO |
| `MERCADERIA` | El activo que se da de baja al vender | ACTIVO |
| `COSTO_DE_VENTAS` | El resultado negativo que se reconoce cuando la mercadería sale por venta | COSTO |

> **Con los seis primeros alcanza para operar.** `MERCADERIA` y
> `COSTO_DE_VENTAS` sólo hacen falta si la empresa lleva existencias: una
> empresa de servicios no tiene mercadería.

### Con el plan modelo

| Rol | Cuenta |
|---|---|
| `CLIENTES` | `1.1.03.01` Deudores por ventas |
| `PROVEEDORES` | `2.1.01.01` Proveedores |
| `IVA_DEBITO` | `2.1.04.01` IVA débito fiscal |
| `IVA_CREDITO` | `1.1.04.01` IVA crédito fiscal |
| `VENTAS` | `4.1.01` Ventas de mercaderías |
| `COMPRAS` | `5.1.03` Compras de mercaderías |
| `MERCADERIA` | `1.1.05.01` Mercaderías de reventa |
| `COSTO_DE_VENTAS` | `5.1.01` Costo de mercaderías vendidas |

### Cómo se declara

Elegí **Rol**, escribí el **código de cuenta** y apretá **«Declarar»**. Una vez
por rol.

**Cómo verificar:** el aviso de arriba pasa de «Faltan: …» a **«Está
completo.»**

**Dos errores habituales:** usar `4.1` para VENTAS (es agrupadora; va `4.1.01`)
y usar «Anticipos a proveedores» para PROVEEDORES (es del activo; va
`2.1.01.01`, del pasivo).

---

## I · Asientos

> **VERIFICADO EN PRODUCCIÓN el 2026-09-22** y **VERIFICADO POR TEST**
> (`tests/integration/loop-de-decision.test.ts`). El circuito propuesta →
> carga humana → aprobación → Mayor se ejecutó con el asiento
> `01a0c725-bc0d-7eea-944c-8cd1cf0fe3be`, `PROPUESTO` → `APROBADO` y
> proyectado al Mayor. Evidencia completa en
> [`MATRIZ-FUNCIONALIDADES-NEXO.md`](MATRIZ-FUNCIONALIDADES-NEXO.md).

**Dónde:** Libros → **Asientos**.

### Los dos caminos

**1 · Propuesto por NEXO.** Operaciones → abrir el comprobante → **«Ver la
propuesta»** → **«Cargar como asiento en borrador»**. Requiere el mapeo
contable declarado.

**2 · Cargado a mano.** En Asientos, completá **libro**, **fecha**, **estado**,
**descripción**, **cuenta al debe**, **cuenta al haber**, **importe** y
**justificación**, y apretá **«Registrar»**.

### Los estados

| Estado | Qué significa |
|---|---|
| `BORRADOR` | Se está armando. No proyecta al Mayor |
| `PROPUESTO` | Propuesto, esperando aprobación. **No proyecta al Mayor** |
| `APROBADO` | Firmado. **Recién ahora proyecta al Mayor** |
| `ANULADO` | Dado de baja por contraasiento |

### Aprobar

Abrí la fila con **«abrir»**. En el detalle aparece **«Aprobar»**.

**Qué deberías ver:** «Aprobado: recién ahora se proyecta al Mayor», y la fila
pasa a `APROBADO`.

> **Quién puede aprobar:** sólo quien tenga `journal_entry:approve`, que trae
> el rol **CONTADOR**. El `ADMINISTRADOR` **no** puede.

### Trazabilidad

El detalle muestra **origen** (MANUAL o IA), **decisión que lo funda** y **anula
a**. Nada se borra: se corrige por contraasiento.

---

## J · Mayor, libros y consultas

**Dónde:** Libros → **Libros**.

| Botón | Qué da |
|---|---|
| **«Diario»** | El libro Diario del período |
| **«Diario resumido del mes»** | El resumen mensual |
| **«Mayor»** | Movimientos y saldos por cuenta |
| **«Balance»** | Sumas y saldos, con sus verificaciones |
| **«Emisiones»** | Lo emitido |

Exportaciones a CSV: Diario, Mayor, balance, antigüedad de saldos, operaciones
por mes y existencias valuadas.

**Libros → Estados y notas** arma los estados contables con **«Armar el
estado»**.

**`BACKEND DISPONIBLE / UI NO EXPUESTA`** — abrir un renglón de un estado
contable hasta los asientos que lo forman (`GET /statements/trace/:lineId`)
tiene endpoint y no tiene pantalla.

---

## K · Los demás módulos

| Módulo | Dónde | Qué se hace | Estado |
|---|---|---|---|
| **Comercial** | Ventas → Comercial | Presupuestos y pedidos; «Registrar la operación fiscal» al facturar | OPERATIVO |
| **Precios** | Ventas → Precios | Listas de precios | OPERATIVO |
| **CRM** | Ventas → CRM | Oportunidades y su avance | OPERATIVO |
| **Comisiones** | Ventas → Comisiones | Vendedores y esquemas | PARCIAL — se da de alta y **no se edita** |
| **Solicitudes** | Compras → Solicitudes | Pedir, enviar a aprobar, aprobar, rechazar, anular, citar la orden | OPERATIVO |
| **Recepciones** | Compras → Recepciones | Recepción de mercadería | OPERATIVO |
| **Pagos** | Compras → Pagos | Órdenes de pago: aprobar, registrar, anular | OPERATIVO |
| **Existencias** | Operación → Existencias | Stock por depósito y lote, recuento, margen | OPERATIVO |
| **Bienes de uso** | Operación → Bienes de uso | Altas, mejoras, bajas, cuadro de amortización | OPERATIVO |
| **Caja** | Dinero → Caja | Apertura, movimientos, arqueo y cierre | OPERATIVO |
| **Bancos** | Dinero → Bancos | Cuentas, importación de extractos y conciliación | OPERATIVO |
| **Cheques** | Dinero → Cheques | Propios y de terceros | OPERATIVO |
| **IVA** | Libros → IVA | Subdiarios de IVA por período | OPERATIVO |
| **Analítica** | Análisis → Analítica | Métricas del negocio | OPERATIVO |
| **Señales** | Análisis → Señales | Señales, escenarios, riesgos y decisiones | OPERATIVO |
| **Preguntar** | Inicio → Preguntar | Catálogo de preguntas con su origen | OPERATIVO |
| **Propuestas de IA** | Operación → Propuestas de IA | Revisar lo que propuso el motor | PARCIAL — ver M |
| **Migraciones** | Administración → Migraciones | Traer una empresa de otro sistema | OPERATIVO |
| **Auditoría** | Administración → Auditoría | La bitácora encadenada | OPERATIVO |

---

## L · ARCA y fiscal

### Disponible

- **Cargar un certificado.** Configuración → «ARCA — certificados» → «Cargar un
  certificado». Se pegan el **certificado** y la **clave privada** en PEM, con
  un **alias**, el **CUIT representado** y el **ambiente**. El vencimiento **no
  se escribe**: lo lee el servidor del propio certificado, y uno vencido se
  rechaza.
- **Revocar un certificado**, con motivo.
- **Constatar un comprobante** contra ARCA, y **declarar** una constatación
  hecha por fuera.
- **Subdiarios de IVA.**

### Cerrado a propósito

**La emisión de comprobantes con CAE `NO DISPONIBLE`.** NEXO **no puede emitir
una factura electrónica**. La capacidad está construida y deliberadamente
cerrada: `EMISION_HABILITADA` es una constante del código en `false`, y el
paquete de transporte está fuera del grafo de la aplicación.

Se escribió así porque una factura emitida no se deshace: las reglas que lo
impiden se escribieron **antes** que el camino que lo produciría.

### No disponible

- **Retenciones** — exige decidir qué regímenes se soportan.
- **Libro IVA Digital** — bloqueado hasta que se publiquen los diseños de
  registro en la resolución.

---

## M · Si aparece X, hacé Y

| Si aparece | Qué pasó | Qué hacer |
|---|---|---|
| «Tu rol exige segundo factor» | Falta configurar MFA | Pantalla «Configurar el segundo factor» → «Generar el secreto» |
| No podés subir documentos ni crear asientos | Tenés `ADMINISTRADOR` y no `CONTADOR` | Configuración → «Dar un rol» → CONTADOR (sección B.2) |
| «Todavía falta abrir el ejercicio…» | No hay período que contenga hoy | Períodos y cierre → «Abrir el ejercicio» |
| «No hay período abierto que contenga la fecha» | La fecha cae fuera del ejercicio | Corregí la fecha, o abrí el ejercicio que la contenga |
| «Esa cuenta no sirve para ese rol» | Tipo de cuenta equivocado en el mapeo | Mirá la tabla de la sección H |
| «Faltan: CLIENTES, VENTAS…» | El mapeo está incompleto | Declará los roles que faltan |
| «El contenido no corresponde a ninguno de los tipos admitidos» | Formato no soportado | PDF, JPG, PNG, XML, CSV o XLSX |
| «Sin extracción disponible: SIN_MOTOR_OCR» | No hay motor de OCR | **Requiere intervención técnica.** Con XML la lectura funciona igual |
| «no hay proveedor de correo configurado» | La instalación no tiene correo | **Requiere intervención técnica** |
| «El certificado venció el …» | Certificado vencido | Pedí uno nuevo a ARCA |
| «Ya existe un ejercicio con ese código» | Código repetido | Cambiá el código |
| «El ejercicio se superpone con otro» | Fechas pisadas | Revisá desde y hasta |
| Se acabaron los códigos de recuperación de MFA | — | **Requiere intervención técnica** |

---

## HUECOS CRÍTICOS PARA EL USUARIO

Tres, y ninguno tiene salida desde la interfaz. Van aparte porque **le pueden
pasar a cualquiera en la primera semana**, no son casos de borde.

### 1 · Recuperación de contraseña — NO DISPONIBLE

**No existe ningún flujo de recuperación desde la interfaz.** Ni pantalla, ni
endpoint, ni correo de «olvidé mi contraseña».

Quien olvide su contraseña **queda afuera de NEXO**, y volver a entrar
**requiere intervención técnica**: alguien con acceso al servidor tiene que
intervenir. No hay un procedimiento alternativo que el usuario pueda seguir
solo, y este manual no va a inventar uno.

### 2 · Regenerar los códigos de recuperación de MFA — NO DISPONIBLE

Al configurar el segundo factor, NEXO entrega **diez códigos de recuperación**.
Son de **uso único**: cada uno sirve una sola vez y se consume al usarlo.

**Una vez consumidos los diez, no hay ninguna interfaz para pedir más.**
Regenerarlos **requiere intervención técnica**.

Por eso la instrucción de guardarlos no es una formalidad: son la única forma
de entrar si perdés el teléfono, y se agotan.

> Este manual no contiene ningún código real ni ningún secreto, y no debe
> contenerlos nunca.

### 3 · Trazabilidad abrible — BACKEND DISPONIBLE / UI NO EXPUESTA

NEXO calcula la trazabilidad de cada cifra y **la consola no la deja abrir**.
Tres rutas existen, tienen permiso y tienen test, y ninguna tiene pantalla:

- de un renglón de un estado contable a los asientos que lo forman;
- de una conciliación bancaria al movimiento y al asiento que la sostienen;
- de un comprobante al detalle de por qué computa su crédito fiscal.

Es la capacidad que más distingue al producto, y hoy el usuario no puede
ejercerla desde la interfaz.

---

## Huecos encontrados al escribir este manual

La lista completa, incluidos los tres de arriba. Cada uno es un procedimiento
que **no se pudo escribir completo**.

| # | Qué no se puede documentar | Por qué | Marca |
|---|---|---|---|
| 1 | Emitir una factura con CAE | `EMISION_HABILITADA = false` | `NO DISPONIBLE` |
| 2 | Abrir un renglón de un estado contable hasta sus asientos | `GET /statements/trace/:lineId` sin pantalla. **Ver «Huecos críticos», 3** | `BACKEND DISPONIBLE / UI NO EXPUESTA` |
| 3 | Abrir una conciliación bancaria hasta el asiento | `GET /banks/trace/:matchId` sin pantalla | `BACKEND DISPONIBLE / UI NO EXPUESTA` |
| 4 | Ver por qué se computa un crédito fiscal | `GET /vat/credito-fiscal/:txId` sin pantalla | `BACKEND DISPONIBLE / UI NO EXPUESTA` |
| 5 | Ver y corregir los renglones de un comprobante | Cuatro rutas sin pantalla | `BACKEND DISPONIBLE / UI NO EXPUESTA` |
| 6 | Editar un vendedor | `PUT /salespeople/:id` sin pantalla | `BACKEND DISPONIBLE / UI NO EXPUESTA` |
| 7 | Tomar la decisión contable de un comprobante | `POST /comprobantes/:id/decision` sin pantalla | `BACKEND DISPONIBLE / UI NO EXPUESTA` |
| 8 | Pedirle al motor que clasifique un documento | `POST /documents/:id/classify` sin pantalla | `BACKEND DISPONIBLE / UI NO EXPUESTA` |
| 9 | Crear la organización, dar de alta otra empresa, invitar gente | No hay panel del estudio | `BACKEND DISPONIBLE / UI NO EXPUESTA` |
| 10 | Regenerar códigos de recuperación de MFA | No existe. **Ver «Huecos críticos», 2** | `NO DISPONIBLE` |
| 11 | Fijar umbrales de confianza por empresa | Tabla sin endpoint | `NO DISPONIBLE` |
| 12 | Retenciones y Libro IVA Digital | Sin implementar / bloqueado | `NO DISPONIBLE` |
| 13 | Recuperar la contraseña | No existe ningún flujo. **Ver «Huecos críticos», 1** | `NO DISPONIBLE` |
| 14 | Que una propuesta de IA llegue a confianza alta | `accounting_rules` está vacía: todo cae en revisión profesional | `PARCIAL` |

Documentos relacionados: [`MATRIZ-FUNCIONALIDADES-NEXO.md`](MATRIZ-FUNCIONALIDADES-NEXO.md),
[`GUIA-PRIMEROS-30-MINUTOS.md`](GUIA-PRIMEROS-30-MINUTOS.md),
[`GUIA-VIDEOS-NEXO.md`](GUIA-VIDEOS-NEXO.md).
