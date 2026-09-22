# Matriz de funcionalidades de NEXO

**Medido:** 2026-09-21, contra la consola publicada (commit `d31fcb4`), el
inventario de rutas de Fastify y el control S-25.

Documentación objetiva. No es una evaluación comercial: cada fila dice qué se
puede hacer y desde dónde, y nada más.

---

## Qué respalda cada fila

**La columna «Disponible» dice que la funcionalidad existe y está desplegada.
No dice que alguien la haya ejecutado en producción.** Son dos cosas distintas.

| Nivel de evidencia | Qué quiere decir |
|---|---|
| **VERIFICADO EN PRODUCCIÓN** | Se ejecutó contra `nexointelligence.com.ar` y quedó rastro |
| **VERIFICADO POR TEST** | Hay prueba automatizada que lo ejercita |
| **DOCUMENTADO SEGÚN IMPLEMENTACIÓN** | Código y pantalla existen y están desplegados; **falta la prueba de punta a punta** |

**Verificado en producción el 2026-09-21**, leyendo el estado del servidor:
el registro con su correo y su MFA, la empresa creada, el **ejercicio 2026
`ABIERTO` con 12 períodos** y el actual incluido, el **plan de cuentas con 185
cuentas**, y los **roles `ADMINISTRADOR` y `CONTADOR`** asignados.

**Verificado en producción el 2026-09-22.** El tramo Documento → Comprobante →
Mapeo contable → Propuesta → Asiento en borrador → Aprobación → Mayor se
recorrió por primera vez contra `nexointelligence.com.ar`, con una operación
real de prueba:

- Documento: `factura-prueba-nexo-0001-00000102.xml`.
- Comprobante: VENTA 1-1-102, fecha 2026-09-19, total $123.420.
- Propuesta, con el mapeo ya declarado: 1.1.03.01 Deudores por ventas (Debe
  $123.420), 4.1.01 Ventas de mercaderías (Haber $102.000), 2.1.04.01 IVA
  débito fiscal (Haber $21.420). Debe = Haber = $123.420.
- Asiento `01a0c725-bc0d-7eea-944c-8cd1cf0fe3be`: cargado en `PROPUESTO`,
  aprobado, estado final `APROBADO`.
- Mayor verificado con los tres renglones proyectados: 1.1.03.01 Debe
  $123.420; 4.1.01 Haber $102.000; 2.1.04.01 Haber $21.420.

Sobre esa misma operación aparecieron tres pendientes —**CONSTATACION**,
**DECISION**, **AFECTACION**— y **ninguno bloqueó el circuito**: llegó a
Mayor con los tres todavía sin resolver. Se dejan así a propósito: no se
inventó ninguna constatación, decisión ni afectación para destrabarlos, y
siguen abiertos en la bandeja.

Aparte de esta operación, la bandeja de producción tenía, al momento de esta
prueba, **8 pendientes `REQUIERE_APROBACION`** de períodos ya terminados
(enero a agosto de 2026). Es deuda operativa previa a esta prueba, no algo que
generó: se deja anotada acá y sin tocar; esos períodos históricos no se
cerraron ni se modificaron.

**Los estados de disponibilidad:**

| | |
|---|---|
| **OPERATIVO** | Se usa desde la consola, sin preparación especial |
| **OPERATIVO CON CONFIGURACIÓN** | Funciona una vez declarado algo previo |
| **PARCIAL** | Una parte se puede y otra no |
| **NO EXPUESTO EN CONSOLA** | El endpoint existe, tiene permiso y test; no hay pantalla |
| **CERRADO** | Construido y deshabilitado a propósito |
| **SOLO TÉCNICO** | Requiere línea de comandos o acceso al servidor |

---

## 1 · Cuenta y acceso

| Funcionalidad | Disponible | Dónde está | Cómo se usa | Requisitos | Estado |
|---|---|---|---|---|---|
| Registrarse | sí | Ingreso → «No tengo cuenta» | Correo, contraseña (12+), nombre → «Registrarme» | — | OPERATIVO |
| Confirmar el correo | sí | Ingreso → «Ya tengo el código…» | Pegar el código → «Confirmar» | Proveedor de correo conectado | OPERATIVO |
| Reenviar la verificación | sí | Ingreso → «No me llegó» | Correo → «Mandar otro» | Invalida el código anterior | OPERATIVO |
| Ingresar | sí | Ingreso | Correo y contraseña → «Ingresar» | Cuenta confirmada | OPERATIVO |
| Configurar MFA con QR | sí | «Configurar el segundo factor» | «Generar el secreto» → escanear → «Confirmar» | Obligatorio para 3 de los 6 roles | OPERATIVO |
| Entrar con código de recuperación | sí | Ingreso, campo de 6 dígitos | Pegar uno de los diez | Se consume | OPERATIVO |
| Regenerar códigos de recuperación | **no** | — | Son de uso único; agotados, **requiere intervención técnica** | — | **NO DISPONIBLE** |
| Recuperar la contraseña | **no** | — | **No existe flujo desde la UI.** Requiere intervención técnica | — | **NO DISPONIBLE** |
| Cerrar sesión | sí | Arriba a la derecha | «Salir» | — | OPERATIVO |

---

## 2 · Empresa, estudio y roles

| Funcionalidad | Disponible | Dónde está | Cómo se usa | Requisitos | Estado |
|---|---|---|---|---|---|
| Crear empresa (autoservicio) | sí | «Crear mi empresa» | Datos + plan → «Crear y empezar la prueba» | Sesión con MFA | OPERATIVO |
| Elegir empresa | sí | Administración → Cambiar empresa | Clic en la empresa | Rol vigente en ella | OPERATIVO |
| Ver personas con acceso | sí | Configuración | «Actualizar» | `user:read` | OPERATIVO |
| **Dar un rol** | sí | Configuración → «Dar un rol» | Persona + rol → «Dar el rol» | `user:manage` | OPERATIVO |
| Crear la organización | no | — | Sólo por API | — | **NO EXPUESTO EN CONSOLA** |
| Dar de alta otra empresa en el estudio | no | — | Sólo por API | — | **NO EXPUESTO EN CONSOLA** |
| Invitar a alguien al estudio | no | — | Sólo por API | — | **NO EXPUESTO EN CONSOLA** |
| Primer administrador del sistema | no | — | Script de siembra | — | **SOLO TÉCNICO** |

---

## 3 · Plan de cuentas

| Funcionalidad | Disponible | Dónde está | Cómo se usa | Requisitos | Estado |
|---|---|---|---|---|---|
| Cargar el plan modelo | sí | Panel → «Usar este plan» | Un botón; carga 185 cuentas | `account:write` | OPERATIVO |
| Ver las cuentas antes de aceptar | sí | Panel → «Ver las cuentas» | — | — | OPERATIVO |
| Buscar una cuenta | sí | Configuración → Plan de cuentas | Código o nombre → «Buscar» | `account:read` | OPERATIVO |
| Crear una cuenta | sí | Configuración → «Dar de alta una cuenta» | Código, nombre, tipo, imputable | `account:write` | OPERATIVO |
| Editar nombre, estado y exigencias | sí | Fila → «editar» | Con motivo → «Guardar los cambios» | `account:write` | OPERATIVO |
| Editar código, tipo o naturaleza | **no** | — | Prohibido por diseño: se archiva y se da de alta otra | — | **NO DISPONIBLE** |

---

## 4 · Ejercicios y períodos

| Funcionalidad | Disponible | Dónde está | Cómo se usa | Requisitos | Estado |
|---|---|---|---|---|---|
| **Abrir un ejercicio** | sí | Períodos y cierre → «Abrir un ejercicio» | Código, desde, hasta → «Abrir el ejercicio» | `period:write` | OPERATIVO |
| Ver períodos y ejercicios | sí | Períodos y cierre | «Actualizar» | `period:read` | OPERATIVO |
| Bloquear un período | sí | Fila del período | «Bloquear» con motivo | `period:write` | OPERATIVO |
| Cerrar un período | sí | Fila del período | «Cerrar» con motivo | `period:close` | OPERATIVO |
| Reabrir un período | sí | Fila del período | Motivo + **contrafirma de otra persona** | `period:reopen` | OPERATIVO |
| Checklist de pre-cierre | sí | Fila del ejercicio | «Ver checklist de pre-cierre» | `fiscal_year:close` | OPERATIVO |
| Asiento de apertura del siguiente | sí | Fila del ejercicio cerrado | «Asiento de apertura» | `fiscal_year:close` | OPERATIVO |

---

## 5 · Terceros y productos

| Funcionalidad | Disponible | Dónde está | Cómo se usa | Requisitos | Estado |
|---|---|---|---|---|---|
| Listar y buscar terceros | sí | Ventas → Terceros | Filtros → «Buscar» | `party:read` | OPERATIVO |
| Dar de alta un tercero | sí | Terceros → «Dar de alta» | Documento, razón social, IVA, contacto | `party:write` | OPERATIVO |
| **Ficha y edición de tercero** | sí | Fila → «ficha» | Con motivo → «Guardar los cambios» | `party:write` | OPERATIVO |
| Editar el documento de un tercero | **no** | — | Prohibido: se archiva y se da de alta otro | — | **NO DISPONIBLE** |
| Cuenta corriente y antigüedad | sí | Fila → «cuenta corriente» | — | `party:read` | OPERATIVO |
| Imputar un cobro o pago | sí | Cuenta corriente | «Imputar» | `allocation:write` | OPERATIVO |
| Aplicar nota de crédito o débito | sí | Cuenta corriente | «Aplicar la nota» | `allocation:write` | OPERATIVO |
| Listas de precio por tercero | no | — | Sólo por API | — | **NO EXPUESTO EN CONSOLA** |
| Roles de tercero por API | no | — | Sólo por API | — | **NO EXPUESTO EN CONSOLA** |
| Listar y buscar productos | sí | Ventas → Productos | «Buscar» | `product:read` | OPERATIVO |
| Dar de alta un producto | sí | Productos → «Dar de alta» | Código, nombre, unidad, impuesto | `product:write` | OPERATIVO |
| **Ficha y edición de producto** | sí | Fila → «ficha» | Con motivo → «Guardar los cambios» | `product:write` | OPERATIVO |
| Editar código o tratamiento impositivo | **no** | — | Prohibido por diseño | — | **NO DISPONIBLE** |
| Ver movimientos de un producto | no | — | Sólo por API | — | **NO EXPUESTO EN CONSOLA** |

---

## 6 · Documentos y comprobantes

> **VERIFICADO EN PRODUCCIÓN el 2026-09-22.** «Registrar el comprobante» se
> ejecutó contra `nexointelligence.com.ar` con el comprobante VENTA 1-1-102 —
> evidencia completa arriba, en «Qué respalda cada fila».

| Funcionalidad | Disponible | Dónde está | Cómo se usa | Requisitos | Estado |
|---|---|---|---|---|---|
| Subir un documento | sí | Operación → Documentos | Archivo → «Subir» | `document:upload` | OPERATIVO |
| Extracción automática | sí | Automática al subir | — | XML/CSV sí; PDF e imagen exigen OCR | PARCIAL |
| Ver lo que se leyó | sí | Abrir el documento | — | `document:read` | OPERATIVO |
| Corregir un campo leído | sí | Campo → «corregir» | Valor → «Guardar corrección» | `document:upload` | OPERATIVO |
| Volver a leer | sí | Detalle | «Volver a leer» | — | OPERATIVO |
| Descargar el original | sí | Detalle | «Descargar el original» | `document:download` | OPERATIVO |
| Resolver duplicados | sí | Detalle | — | — | OPERATIVO |
| **Registrar el comprobante** | sí | Detalle, con estado `EXTRAIDO` | Dirección + datos → «Registrar el comprobante» | `journal_entry:create` | OPERATIVO |
| Pedir clasificación al motor | no | — | Sólo por API | — | **NO EXPUESTO EN CONSOLA** |
| Buscar operaciones | sí | Operación → Operaciones | Filtros → «Buscar» | `journal_entry:read` | OPERATIVO |
| Ver renglones del comprobante | no | — | Sólo por API | — | **NO EXPUESTO EN CONSOLA** |
| Vincular a un tercero del padrón | no | — | Sólo por API | — | **NO EXPUESTO EN CONSOLA** |
| Tomar la decisión contable | no | — | Sólo por API | — | **NO EXPUESTO EN CONSOLA** |

---

## 7 · Mapeo contable y asientos

> **VERIFICADO EN PRODUCCIÓN el 2026-09-22** y **VERIFICADO POR TEST**
> (`tests/integration/loop-de-decision.test.ts`). El mapeo contable está
> declarado y hay al menos un asiento aprobado y proyectado al Mayor —
> evidencia completa arriba, en «Qué respalda cada fila».

| Funcionalidad | Disponible | Dónde está | Cómo se usa | Requisitos | Estado |
|---|---|---|---|---|---|
| Ver el mapeo | sí | Configuración → Mapeo contable | — | `account:read` | OPERATIVO |
| **Declarar un rol contable** | sí | Mapeo contable | Rol + cuenta → «Declarar» | `account:write` | OPERATIVO |
| **Ver la propuesta de asiento** | sí | Operaciones → comprobante | «Ver la propuesta» | Mapeo declarado | OPERATIVO CON CONFIGURACIÓN |
| **Cargar la propuesta como borrador** | sí | Operaciones | «Cargar como asiento en borrador» | `journal_entry:create` | OPERATIVO CON CONFIGURACIÓN |
| Registrar un asiento a mano | sí | Libros → Asientos | Libro, fecha, cuentas, importe → «Registrar» | `journal_entry:create` | OPERATIVO |
| Abrir un asiento | sí | Fila → «abrir» | — | `journal_entry:read` | OPERATIVO |
| **Aprobar un asiento** | sí | Detalle → «Aprobar» | — | `journal_entry:approve` (rol CONTADOR) | OPERATIVO |
| Anular por contraasiento | sí | Detalle | — | `journal_entry:reverse` | OPERATIVO |
| Propuesta de costo de mercadería vendida | sí | Existencias | «Ver la propuesta» → «Cargar como asiento…» | `MERCADERIA` y `COSTO_DE_VENTAS` declarados | OPERATIVO CON CONFIGURACIÓN |

---

## 8 · Libros y consultas

| Funcionalidad | Disponible | Dónde está | Cómo se usa | Requisitos | Estado |
|---|---|---|---|---|---|
| Diario | sí | Libros → «Diario» | — | `report:read` | OPERATIVO |
| Diario resumido del mes | sí | Libros | «Diario resumido del mes» | — | OPERATIVO |
| **Mayor** | sí | Libros → «Mayor» | — | — | OPERATIVO |
| Balance de sumas y saldos | sí | Libros → «Balance» | — | — | OPERATIVO |
| Exportar a CSV | sí | Libros | Seis botones «Bajar … (CSV)» | — | OPERATIVO |
| Estados contables | sí | Libros → Estados y notas | «Armar el estado» | Marco de reporte declarado | OPERATIVO CON CONFIGURACIÓN |
| Declarar el marco de reporte | no | — | Sólo por API | — | **NO EXPUESTO EN CONSOLA** |
| Abrir un renglón del estado hasta sus asientos | no | — | Sólo por API | — | **NO EXPUESTO EN CONSOLA** |
| Subdiarios de IVA | sí | Libros → IVA | «Ver el período» / «Ver subdiario» | `vat_book:read` | OPERATIVO |
| Ver por qué se computa un crédito fiscal | no | — | Sólo por API | — | **NO EXPUESTO EN CONSOLA** |

---

## 9 · Comercial, compras, dinero y stock

| Funcionalidad | Disponible | Dónde está | Estado |
|---|---|---|---|
| Presupuestos y pedidos | sí | Ventas → Comercial | OPERATIVO |
| Facturar un pedido | sí | Comercial → «Registrar la operación fiscal» | OPERATIVO |
| Listas de precios | sí | Ventas → Precios | OPERATIVO |
| CRM | sí | Ventas → CRM | OPERATIVO |
| Vendedores y esquemas de comisión | sí | Ventas → Comisiones | OPERATIVO |
| **Editar un vendedor** | no | — | **NO EXPUESTO EN CONSOLA** |
| Solicitudes de compra | sí | Compras → Solicitudes | OPERATIVO |
| Recepciones | sí | Compras → Recepciones | OPERATIVO |
| Órdenes de pago | sí | Compras → Pagos | OPERATIVO |
| Editar renglones de solicitud u orden | no | — | **NO EXPUESTO EN CONSOLA** |
| Caja y arqueo | sí | Dinero → Caja | OPERATIVO |
| Cuentas bancarias y conciliación | sí | Dinero → Bancos | OPERATIVO |
| Abrir una conciliación hasta el asiento | no | — | **NO EXPUESTO EN CONSOLA** |
| Cheques | sí | Dinero → Cheques | OPERATIVO |
| Existencias por depósito y lote | sí | Operación → Existencias | OPERATIVO |
| Recuento físico | sí | Existencias | OPERATIVO |
| Bienes de uso | sí | Operación → Bienes de uso | OPERATIVO |
| Proyectos y sucursales | sí | Operación | OPERATIVO |
| Integraciones | sí | Operación → Integraciones | OPERATIVO |
| Ingesta programática de registros | no | — | **NO EXPUESTO EN CONSOLA** (es API a API) |

---

## 10 · ARCA y fiscal

| Funcionalidad | Disponible | Dónde está | Requisitos | Estado |
|---|---|---|---|---|
| **Cargar un certificado** | sí | Configuración → «Cargar un certificado» | `arca_credential:manage` | OPERATIVO |
| Revocar un certificado | sí | Fila → «revocar» | Motivo de 10+ caracteres | OPERATIVO |
| Ver servicios habilitados | sí | Configuración | — | OPERATIVO |
| Constatar un comprobante | sí | Operaciones → «Consultar a ARCA» | Certificado cargado | OPERATIVO CON CONFIGURACIÓN |
| Declarar una constatación propia | sí | Operaciones → «Declarar» | Queda como declaración profesional | OPERATIVO |
| **Emitir una factura con CAE** | **no** | — | `EMISION_HABILITADA = false` | **CERRADO** |
| Retenciones | **no** | — | Falta decidir qué regímenes | **NO DISPONIBLE** |
| Libro IVA Digital | **no** | — | Diseños de registro sin publicar | **NO DISPONIBLE** |

---

## 11 · Inteligencia y decisión

| Funcionalidad | Disponible | Dónde está | Estado |
|---|---|---|---|
| Preguntar (catálogo cerrado) | sí | Inicio → Preguntar | OPERATIVO |
| Panorama | sí | Preguntar → «Ver el panorama» | OPERATIVO |
| Riesgos (seis frentes) | sí | Preguntar → «Ver los riesgos» | OPERATIVO |
| Señales y umbrales | sí | Análisis → Señales | OPERATIVO |
| Simular un escenario | sí | Señales → «Simular» | OPERATIVO |
| Guardar y comparar escenarios | sí | Señales | OPERATIVO |
| Declarar que un acto aplicó un escenario | sí | Señales → «Declarar aplicado» | OPERATIVO |
| Medir lo esperado contra lo ocurrido | sí | Señales → «Ver el resultado» | OPERATIVO |
| Registro de decisiones | sí | Señales → «Ver el registro» | OPERATIVO |
| Revisar propuestas del motor | sí | Operación → Propuestas de IA | PARCIAL |
| Que una propuesta llegue a confianza alta | **no** | — | `accounting_rules` vacía: todo cae en revisión profesional | **PARCIAL** |
| Fijar umbrales de confianza por empresa | **no** | — | Tabla sin endpoint | **NO DISPONIBLE** |
| Proveedor de modelo de IA | **no** | — | `AI_PROVIDER=none` por defecto | **NO DISPONIBLE** |
| Optimización y causalidad | **no** | — | Sin implementar | **NO DISPONIBLE** |

---

## 12 · Administración

| Funcionalidad | Disponible | Dónde está | Estado |
|---|---|---|---|
| Migrar desde otro sistema | sí | Administración → Migraciones | OPERATIVO |
| Revertir una migración | sí | Migraciones → «Revertir» | OPERATIVO |
| Bitácora de auditoría | sí | Administración → Auditoría | OPERATIVO |
| Ver el plan y los topes | sí | Administración → Plan | OPERATIVO |
| Convertir la prueba | sí | Plan → «Convertir la prueba» | OPERATIVO |
| Conectar el medio de pago | **no** | Plan → «Conectar el medio de pago» | **PARCIAL** — sin pasarela contratada |
| Secretos de integraciones | sí | Configuración | OPERATIVO |
| Cambiar el estado de una suscripción | no | — | **NO EXPUESTO EN CONSOLA** (es del proveedor) |

---

## Resumen

| Estado | Cuántas |
|---|---|
| OPERATIVO | 71 |
| OPERATIVO CON CONFIGURACIÓN | 5 |
| PARCIAL | 4 |
| NO EXPUESTO EN CONSOLA | 17 |
| CERRADO | 1 |
| NO DISPONIBLE | 11 |
| SOLO TÉCNICO | 1 |

**Las 17 «no expuestas» no son un accidente uniforme.** El control S-25 las
tiene declaradas una por una con su motivo, y distingue las que **no deberían**
tener pantalla —un webhook que llama la pasarela, la ingesta que llama otro
sistema— de las que **todavía no la tienen**.

Ver también [`MANUAL-USUARIO-NEXO.md`](MANUAL-USUARIO-NEXO.md) y
[`GUIA-PRIMEROS-30-MINUTOS.md`](GUIA-PRIMEROS-30-MINUTOS.md).
