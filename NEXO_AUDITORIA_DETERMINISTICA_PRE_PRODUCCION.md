# NEXO — AUDITORÍA DETERMINÍSTICA PRE-PRODUCCIÓN

**Fecha de la medición:** 2026-09-09
**Base del repositorio al empezar:** `ad17495` (identidad NEXO)
**Método:** inspección y **ejecución** del sistema real. Toda afirmación de este
documento tiene atrás un archivo, una consulta SQL, una respuesta HTTP, una
corrida de tests o una pantalla abierta en un navegador.

> **Cómo leer los estados.** No son sinónimos y se usan con el sentido estricto
> que pediste:
>
> | | |
> |---|---|
> | **IMPLEMENTADO** | El código existe |
> | **FUNCIONAL** | Se ejecuta y hace lo que dice |
> | **INTEGRADO** | Está conectado con lo que lo rodea |
> | **ACCESIBLE** | Un usuario puede llegar por un camino real |
> | **VERIFICADO** | Se comprobó con una medición, no leyendo |
> | **PRODUCTIZADO** | Un cliente lo puede usar sin que nadie le explique |
> | **PRODUCCIÓN** | Corre para clientes reales |

> **Regla de no repetición.** Nada se acepta por venir declarado terminado en una
> auditoría anterior. Cada afirmación heredada aparece marcada como
> **CONFIRMADO POR ESTA AUDITORÍA**, **REABIERTO** o **NO VERIFICADO**.

---

# 1. Estado ejecutivo

NEXO está **mejor de lo que decían las auditorías anteriores en el motor, y peor
de lo que decían en el producto**.

El núcleo —contabilidad, aislamiento multiempresa, trazabilidad, facturación—
resistió el examen adversarial. Los 2.267 tests pasan, el libro cuadra contra
movimientos reales, la cadena de auditoría detecta una entrada adulterada, y no
hay una sola tabla con `company_id` sin RLS forzado.

Lo que no resistió fue **el camino del cliente**. Esta auditoría fue la primera
en abrir el navegador y recorrer el alta de punta a punta como lo haría alguien
que llega a pagar. Estaba **cortada en tres lugares distintos**, y ningún test lo
veía porque todos los endpoints funcionaban por separado.

Los siete hallazgos nuevos, ninguno detectado por las once auditorías previas:

| # | Hallazgo | Gravedad | Estado |
|---|---|---|---|
| **H-1** | Tres funciones `SECURITY DEFINER` permitían **borrar y rehacer datos contables de otra empresa** desde el rol de la aplicación | Crítico | Cerrado (0108, 0109, S-32) |
| **H-2** | El relevamiento de ARCA declaraba los cuatro servicios `NO_DELEGADO` **sin haberle preguntado nada al organismo** | Alto | Cerrado |
| **H-3** | El alta autoservicio **no llegaba al final**: el formulario de crear empresa era inalcanzable | Bloqueante de V1 | Cerrado (S-33) |
| **H-4** | El Panel mostraba **«Sin pendientes» en verde** con tres 403 detrás | Alto | Cerrado |
| **H-5** | Un cliente del plan de entrada veía **23 de 40 dominios contestando 403** | Bloqueante comercial | Cerrado |
| **H-6** | Un secreto TOTP ilegible dejaba **inalcanzable el código de recuperación** | Alto | Cerrado |
| **H-7** | Errores 4xx del framework se contestaban y registraban como **500** | Medio | Cerrado |

Todos están corregidos, con control automático que los detecta si vuelven, y
**cada control fue observado fallando** antes de darlo por bueno.

**Veredicto anticipado (el detalle está en §31): 🟡 CASI.** Lo que falta para
vender no es motor: es terminar la productización de las 35 pantallas y tres
decisiones de Pablo que no cuestan casi nada. Ver §22: **hoy no hay que pagar
prácticamente nada.**

---

# 2. Línea de base medida

Medido con consultas al catálogo de PostgreSQL sobre la base de desarrollo, y
con las herramientas del repositorio.

## Base de datos

| Objeto | Cantidad |
|---|---|
| Migraciones aplicadas | **109** |
| Tablas | 159 |
| Vistas | 104 |
| Índices | 450 |
| Políticas RLS | 118 |
| Tablas con RLS | 118 |
| Tablas con RLS **FORCE** | **118 (todas)** |
| Funciones | 369 |
| Triggers propios | 174 |
| Restricciones CHECK | 593 |
| Claves foráneas | 337 |
| Restricciones UNIQUE | 109 |
| Permisos | 101 |
| Roles | 6 |
| Acciones auditadas | 158 |

## Código

| | |
|---|---|
| Archivos TypeScript (sin `dist`) | 228 |
| Módulos de rutas HTTP | 52 |
| Registros de endpoint | ~284 |
| Migraciones SQL | 109 |
| Suites de integración | 84 |
| Controles de la serie S-* | **33** |
| Consola (una sola página) | 10.932 líneas |
| Página pública | 423 líneas |

## Verificación completa (`npm run verify`)

```
typecheck            sin errores
lint                 sin errores
lint:arch            0 violaciones (257 módulos, 893 dependencias)
check:no-float       sin hallazgos
norms:verify         archivo normativo íntegro
verify:arranque      primer arranque completo sobre base vacía
ledger:verify        2 empresas, 25 líneas proyectadas, sin discrepancias
audit:cadena         cadena íntegra + detecta una entrada adulterada
audit:estructura     435/435 objetos declarados presentes
audit:invariants     sin violaciones
tests                (ver §18)
```

---

# 3. Arquitectura

**CONFIRMADO POR ESTA AUDITORÍA.**

Monorepo de npm workspaces, TypeScript en modo estricto con
`exactOptionalPropertyTypes` y `noUncheckedIndexedAccess`. Quince paquetes de
dominio más la API y la web.

La separación que sostiene todo lo demás —**la IA no puede alcanzar el motor
contable** (ADR-001)— está impuesta por `dependency-cruiser`, no por acuerdo:
257 módulos recorridos, **0 violaciones**. Se verificó ejecutándolo, no leyendo
la configuración.

Las decisiones que gobiernan el diseño y que se comprobaron vigentes:

| ADR | Qué dice | Cómo se comprueba |
|---|---|---|
| 001 | La IA no llega al motor contable | `lint:arch`, S-8 |
| 005 | No hay regla sin norma | `norms:verify`, S-29 |
| 017 | La aritmética queda fuera del LLM | S-26 |
| 021 | Un documento cita el hecho, no lo genera | S-19 |
| 022 | Derivar, no guardar | `audit:estructura` |

---

# 4. Base de datos

**CONFIRMADO POR ESTA AUDITORÍA, con una corrección.**

Migraciones SQL con guardián de checksum: una migración aplicada no se puede
editar, y toda corrección es una migración nueva. Esa regla se respetó durante
esta auditoría: la 0108 resultó insuficiente y **no se tocó** — se escribió la
0109.

El dinero vive en `numeric` o en unidades mínimas enteras, nunca en punto
flotante de JavaScript. La compuerta `check:no-float` corre en cada
verificación y hoy da **sin hallazgos**.

`null` significa «no se puede afirmar» y nunca cero. Esta auditoría encontró
**una violación de esa regla en la interfaz** (H-4, §11), no en la base.

---

# 5. Seguridad

## H-1 — La puerta de atrás que dejaba borrar datos de otra empresa

**REABIERTO Y CERRADO.** Ninguna auditoría anterior había mirado las funciones
`SECURITY DEFINER`, que son la única forma que tiene la aplicación de tocar datos
fuera de su empresa: adentro de ellas **no hay RLS**.

Había nueve. Tres reciben una empresa y **no comprueban quién llama**.

Medición adversarial, con el rol `aai_app`, la empresa A en contexto, apuntando
a la B:

```
── control · leer account_balances de B por SQL directo ──   0 filas      (RLS: bien)
── control · escribir stock_movement_ppp de B ──             42501        (0086: bien)
── 1 · company_organization(B) ──                            devolvió     ← PASÓ
── 2 · rebuild_account_balances(B) ──                        2 filas      ← PASÓ
── 3 · recalcular_ppp_de_producto(B, …) ──                   sin error    ← PASÓ
```

Los dos controles son lo que hace válida la medición: las defensas de siempre
funcionan, y aun así había un camino que las rodeaba. Y no era una fuga de
lectura: `rebuild_account_balances` y `recalcular_ppp_de_producto` **borran y
rehacen**. Era una primitiva de escritura destructiva sobre datos contables
ajenos, disponible para el rol de la aplicación.

Lo más incómodo: la migración **0086 revocó a propósito** la escritura sobre
`stock_movement_ppp` para que no existiera «una segunda verdad sobre el costo».
`recalcular_ppp_de_producto` borra esa misma tabla. El candado se leía como
candado y para ese camino no lo era.

**No era explotable desde la API de hoy** —ninguna ruta le pasa a esas funciones
un identificador de empresa que venga del pedido, y todas las consultas van
parametrizadas—. Pero convertía cualquier inyección futura, o cualquier ruta
nueva escrita sin cuidado, en borrado de contabilidad ajena.

### El arreglo, y el error que hubo en el medio

La **0108** revocó `EXECUTE` a `aai_app`. Se volvió a medir y **las tres
siguieron pasando**. El motivo estaba en la lista de permisos:

```
company_organization   =X/postgres | postgres=X/postgres
```

Esa entrada sin nombre a la izquierda del `=` es **PUBLIC**. PostgreSQL le
concede `EXECUTE` a PUBLIC sobre toda función nueva. `aai_app` las ejecutaba por
ser parte de todos, y quitarle un permiso que no usaba no le quitó el que sí.

Es la misma forma que la 0097 («un GRANT no quita nada»), dada vuelta: **un
REVOKE a un rol no quita lo que tiene PUBLIC.** Las tres veces el error fue
escribir el permiso que uno quería sin leer el permiso que había.

La **0109** se lo quita a PUBLIC sobre las nueve, y se lo devuelve por escrito
solo a las cuatro que comprueban al actor. Medición posterior:

```
── 1 · company_organization(B) ──          42501 permiso denegado
── 2 · rebuild_account_balances(B) ──      42501 permiso denegado
── 3 · recalcular_ppp_de_producto(B, …) ── 42501 permiso denegado
── controles 4 y 5 ──                      sin cambios
```

**Control nuevo S-32:** barre `pg_proc`, compara contra una lista declarada con
el motivo de cada función, y exige que **PUBLIC no ejecute ninguna**. No lee
migraciones: le pregunta al catálogo. Se comprobó que falla devolviéndole
`EXECUTE` a PUBLIC sobre `rebuild_account_balances`: tres de sus cuatro casos se
pusieron en rojo.

## H-6 — El código de recuperación inalcanzable

**NUEVO.** `decryptSecret` lanza excepción cuando el secreto TOTP guardado no
abre con la clave que hay: tras rotar `MFA_ENCRYPTION_KEY`, con la fila corrupta,
o —fuera de producción— en cada reinicio, porque ahí la clave es efímera a
propósito.

Salía como **500 sin manejar**. Lo grave no era el código de estado: la excepción
cortaba el flujo **antes** del código de recuperación, que existe exactamente
para cuando no se puede generar un TOTP. Quedaba inalcanzable justo en el caso
que vino a cubrir. Alguien con la clave rotada no tenía **ninguna** forma de
entrar, y el segundo factor es obligatorio para Administrador, Contador y
Auditor.

Ahora se devuelve `null`, se sigue hasta el código de recuperación, y en el log
queda la causa real —que es una emergencia de operación, no un intento fallido
más—. Al cliente se le contesta lo mismo que a un código equivocado: no hay
oráculo. Es el criterio que `verifyPassword` ya tenía para un hash corrupto,
aplicado donde faltaba. Control en S-2, observado fallando (500 antes, 401
después).

## H-7 — Errores del cliente contados como fallas del servidor

**NUEVO.** Un cuerpo vacío con `content-type: application/json`, o un JSON mal
formado, los rechaza Fastify antes del handler con un error que **ya trae
`statusCode: 400`**. El manejador los contestaba **500 «Error interno»** y los
anotaba como «error no controlado».

Dos daños: al cliente se le dice que el problema es del servidor cuando el pedido
está mal armado, así que reintenta; y al operador se le llena de errores nivel 50
el log, cuando la tasa de 500 es justamente lo que se mira para decidir si hay
que levantarse a la madrugada.

Control nuevo en `tests/integration/errores-del-borde.test.ts`, con control
positivo —una ruta que explota a propósito **sigue** siendo 500— para que
contestar 4xx a todo no deje los tests en verde.

## Lo que resistió

**CONFIRMADO POR ESTA AUDITORÍA:**

- Contraseñas con Argon2id; tokens de sesión guardados como hash.
- Segundo factor obligatorio por rol; códigos de recuperación de un solo uso.
- Bloqueo progresivo de intentos.
- Secretos por referencia (`env:` / `db:` / `kms:` / `mem:`), nunca en la
  configuración; cifrado de sobre `v1.<iv>.<tag>.<ct>`.
- S-27: ningún secreto sale en un log.
- S-4: inyección por prompt en datos de documento.

**Secretos en el entorno:** hay material sensible presente en `C:\ARCA\`
(certificado y clave privada de homologación). **SECRET PRESENTE — NO EXPONER.**
No está en el repositorio y no debe estarlo; los scripts lo leen por ruta.

---

# 6. Multiempresa / RLS

**CONFIRMADO POR ESTA AUDITORÍA, con el hallazgo H-1 ya descrito.**

Barrido del catálogo:

| Pregunta | Respuesta |
|---|---|
| Tablas con `company_id` **sin** RLS | **0** |
| Tablas con RLS **sin** FORCE | **0** |
| Tablas con RLS y **cero** políticas | **0** |
| Vistas sin `security_invoker` | 6, **todas declaradas y justificadas** |
| Funciones `SECURITY DEFINER` ejecutables por PUBLIC | **0** (era 9) |
| Funciones `SECURITY DEFINER` ejecutables por la aplicación | **4**, todas verifican al actor |

Las seis vistas sin `security_invoker` son las `saas_*` y
`norm_candidates_pendientes`: son del operador, no del cliente, y la migración
0100 les revoca todo acceso a `aai_app`. Es deliberado y está escrito.

El aislamiento por HTTP lo barre S-1 sobre **el inventario de rutas que construye
el propio servidor**, no sobre una lista escrita a mano: un endpoint nuevo sin
protección entra al barrido solo.

---

# 7. ERP

**Estado: FUNCIONAL e INTEGRADO. La productización es lo que falta.**

Los módulos existen, se ejecutan y están cubiertos por 84 suites de integración.
El detalle pantalla por pantalla está en §11, que es donde vive el trabajo
pendiente.

---

# 8. Contabilidad

**CONFIRMADO POR ESTA AUDITORÍA — es la parte más sólida del sistema.**

```
ledger:verify — 2 empresa(s) verificada(s) con movimientos reales, sin discrepancias
  ✔ Verificación A (33900000019) — 23 línea(s) proyectadas, coinciden
  ✔ Verificación B (27900000019) — 2 línea(s) proyectadas, coinciden

audit:cadena
  ✔ el verificador detecta una entrada adulterada
  ✔ Verificación A — 36 entrada(s), cadena íntegra
```

La segunda línea de la cadena es la que importa: el verificador **se probó
detectando una adulteración**, no solo diciendo que todo está bien.

---

# 9. Fiscal / ARCA

## H-2 — El relevamiento que afirmaba sin preguntar

**REABIERTO Y CERRADO.** El informe de habilitaciones declaraba los cuatro
servicios `NO_DELEGADO` con el texto «el contribuyente tiene que delegarlo al
certificado desde el portal de ARCA». **Nunca le preguntó nada a ARCA.**

Dos defectos encadenados, y el segundo estaba tapado por el primero:

1. El script armaba el `CompanyCertificate` a mano y le faltaba `notAfter`. La
   primera línea de `login` es `notAfter.getTime()`, así que reventaba con un
   `TypeError` **antes de abrir el socket**. Como el mensaje no se parecía a un
   error de red, la clasificación lo mandaba al cajón de lo que sobraba:
   `NO_DELEGADO`, con fecha de verificación y listo para guardarse en la tabla.
2. El mismo script construía el autenticador con `{ environment }`, que no es un
   campo de `WsaaOptions`. Quedaba **sin endpoint**, y `fetch(undefined)` fallaba
   con «Failed to parse URL from undefined». Se destapó recién cuando el estado
   nuevo empezó a decir «esto es un problema de este lado».

El módulo ya separaba «no delegado» de «no se pudo averiguar» —tiene un
comentario de cabecera entero dedicado a esa distinción— pero `NO_DELEGADO` era
**el caso por omisión**, así que todo lo no previsto se volvía una afirmación
sobre el contribuyente. Ahora afirmar exige `respondioElOrganismo`.

Tercer defecto encontrado en el camino: `coe.alreadyAuthenticated` salía
`NO_DELEGADO`, **y es lo contrario**. WSAA no emite tickets para servicios sin
delegar, así que ese rechazo es evidencia a favor. Como da un solo ticket por
CUIT y servicio, aparecía cada vez que el relevamiento se corría dos veces
seguidas.

Cuarto: `arca-check.mjs` ponía `notAfter: Date.now() + 24h`, **un vencimiento
inventado**, que anulaba el control de certificado vencido. Un diagnóstico que
fabrica uno de sus datos de entrada diagnostica otra cosa.

## El estado fiscal real, medido por primera vez

Contra ARCA homologación, 2026-09-09:

```
wsfe                HABILITADO
wscdc               NO_DELEGADO   ns1:coe.notAuthorized
ws_sr_padron_a13    NO_DELEGADO   ns1:coe.notAuthorized
ws_sr_padron_a100   NO_DELEGADO   ns1:coe.notAuthorized
```

Diagnóstico de red y servicio, misma corrida:

```
✔ WSAA alcanzable — HTTP 200
✔ WSCDC alcanzable — HTTP 200
✔ WSCDC operativo — app=OK db=OK auth=OK
✔ Certificado y clave leídos (vence 2028-08-25)
```

El certificado es de **homologación** (`CN=Computadores Test, O=AFIP`), válido
hasta 2028-08-25. Los tres servicios que faltan se delegan en WSASS y **no
cuestan nada**: es un trámite. Queda anotado en `PABLO_ACCIONES.md` §9-bis.

**Degradación honesta, CONFIRMADA:** sin WSCDC la validación fiscal queda en
`NO_CONSULTADO` y cae en revisión individual; sin padrón no se verifica la
condición del emisor. El sistema lo declara en vez de suponerlo.

---

# 10. SaaS / comercial

## H-5 — El plan de entrada era un campo minado

**NUEVO, y es el hallazgo comercial más caro.** La consola escondía los módulos
**por permiso y no por plan**, y las dos cosas terminan en 403.

Medido contra los planes cargados:

| Plan | Dominios fuera del plan (de 40) |
|---|---|
| **CONTABLE** (29.900) | **23** |
| **ESTUDIO** (79.900) | 22 |
| **GESTION** (59.900) | 10 |
| **EMPRESA_B1** (99.900) | 5 |
| **COMPLETO** (159.900) | 0 |

Es decir: el cliente del **plan de entrada** veía los 34 botones del menú y más
de la mitad del producto le contestaba 403 con el JSON del error en pantalla.

La consola ya tenía la regla escrita, aplicada a la otra puerta: *«un botón que
termina en 403 le enseña a la persona que el sistema falla al azar. Si el backend
va a decir que no, la consola no pregunta.»*

**Arreglo:** `GET /companies/current` devuelve ahora los dominios excluidos,
calculados con la misma función que usa la puerta, y el menú los esconde.
Verificado en el navegador con un cliente real de CONTABLE: **de 34 botones en 8
grupos a 14 en 5**, y los 20 que desaparecieron son exactamente los que
contestaban 403.

**Control S-33 (segunda mitad):** compara el mapa de la consola contra
`product_features` en la base, y solo exige cobertura para los dominios que
**algún plan a la venta realmente excluye** — si mañana un plan nuevo deja fuera
el IVA, el control lo va a pedir sin que nadie lo edite. Observado fallando al
sacar `crm` del mapa.

> **Decisión pendiente de Pablo (§26):** hoy el módulo fuera de plan **se
> esconde**, que es lo conservador y lo que ya hacía el filtro por permiso. La
> alternativa comercial —mostrarlo apagado, como invitación a subir de plan— es
> una decisión de negocio y no la tomo yo.

## Ciclo de facturación

**CONFIRMADO POR ESTA AUDITORÍA:** períodos, documentos, intentos de cobro con
clave de idempotencia obligatoria, eventos de pago, política de cobranza y pasos
de cobranza. Sin pasarela contratada, `intentarCobro` devuelve `SIN_PASARELA`:
un estado nombrado, no un silencio.

Las tablas de facturación son de **solo lectura** para la aplicación, comprobado
por barrido del catálogo (S-29), no por lista escrita a mano. Un administrador de
una empresa cliente no puede emitirse un cargo ni marcarlo pagado.

## Prueba de 14 días

**VERIFICADO en el navegador:** se creó una empresa nueva y la prueba quedó
corriendo hasta el 2026-09-22, con el aviso arriba de Inicio desde el primer
momento. Sin tarjeta. Al vencer, la suscripción queda suspendida y no se borra
nada.

---

# 11. Frontend / UX

Esta es la sección donde está el trabajo que falta, y donde aparecieron los
hallazgos que once auditorías de código no habían visto. **Auditar el código no
alcanza.**

## H-3 — El alta autoservicio no llegaba al final

**BLOQUEANTE DE V1, cerrado.** NEXO se vende con prueba de 14 días y sin
intervención manual. Recorrer ese camino con el navegador mostró que estaba
cortado en **tres** lugares:

1. **El formulario de crear empresa vivía dentro de la pantalla de ingreso.**
   `POST /onboarding/empresa` **exige sesión**: sin entrar daba 401, y al entrar
   `ir()` esconde `v-login` y el formulario dejaba de existir para el usuario.
   Estaba en el único lugar donde no podía funcionar. Comprobado por los dos
   lados: 401 sin sesión, y `offsetParent === null` con sesión.

2. **Quien no tenía empresa aterrizaba en una lista vacía con los 34 botones
   puestos.** Todos daban 403.

3. **El rol que crea el alta exige segundo factor, y la pantalla para
   configurarlo también vivía dentro de `v-login`.** El alta terminaba contra un
   403 crudo que decía «configuralo en `/auth/mfa/setup`»: una ruta de la API, en
   la pantalla, como instrucción. Es **literalmente** el defecto que S-25 había
   encontrado el 2026-09-03 —«la consola no tenía dónde configurarlo»—, arreglado
   en el ingreso y recreado en el alta.

Las tres son la misma forma, la que este repositorio viene persiguiendo: **la
pieza está, la regla está escrita, y nadie recorrió el trayecto entre las dos.**

**Arreglo:** `v-alta-empresa` y `v-mfa` son pantallas propias; una sola función
decide a dónde va alguien que acaba de autenticarse, porque la decisión escrita
dos veces se separó las dos veces; y confirmar el segundo factor **continúa** el
camino en vez de mandar a reingresar (el mensaje viejo pedía rehacer lo recién
hecho — `mfa/confirm` marca `mfa_satisfied` en la sesión en curso).

**Verificado de punta a punta en el navegador, en una sola sesión:** registro →
confirmación → ingreso → segundo factor → crear empresa → consola operando con
la prueba corriendo. **Control S-33**, que camina el tramo por HTTP y comprueba
en el HTML que cada parada tenga pantalla propia.

## H-4 — Un error contado como buena noticia

**NUEVO.** El Panel mostraba **«Sin pendientes.» en verde** mientras la API
devolvía tres 403. `wq.datos` venía indefinido, el resumen quedaba en `{}`, el
total daba cero.

Es la peor lectura posible de un error, porque **tranquiliza**. Y es la regla del
propio proyecto sobre `null` —«no se puede afirmar» nunca es cero— violada
justo donde se ve. Ahora dice: *«No se pudo consultar lo pendiente (403). No
quiere decir que no haya nada: quiere decir que no se sabe.»*

## Productización pendiente

Lo que se corrigió en esta auditoría, ya verificado en pantalla:

- El veredicto de puesta en marcha decía `PLAN_DE_CUENTAS, EJERCICIO,
  PERIODO_ABIERTO` — identificadores, a un cliente nuevo, en su primera
  pantalla. Ahora: *«Todavía falta cargar el plan de cuentas, abrir el ejercicio
  y tener un período abierto que contenga hoy.»* El título en castellano ya venía
  en la misma respuesta; no hacía falta más que usarlo.
- Con una sola empresa ya no se pide elegirla de una lista de una.
- El aviso de la prueba aparece al entrar, no solo al volver a Inicio.

Lo que **falta** (§24 lo detalla):

- Las respuestas de la API se muestran como **JSON crudo** en varias pantallas,
  incluida la de alta. Un error de validación se ve como
  `400 { "error": "VALIDATION_ERROR", "details": [...] }`.
- La tabla de planes muestra los topes como `comprobantes_mes: 300 · empresas: 1
  · integraciones: 1 · usuarios: 3`.
- El cuerpo del correo de confirmación dice «mandá este código a
  `/auth/verificar-correo`»: una instrucción de programador en un mensaje para
  una persona. Importa cuando se contrate el proveedor de correo.
- Estados vacíos y de carga, pantalla por pantalla.

## Clasificación de las 35 pantallas

*(pendiente de completar en esta pasada — ver §24)*

---

# 12. Design system / identidad

**CONFIRMADO POR ESTA AUDITORÍA.** Aprobada por Pablo el 2026-09-08: oscuro,
luminoso, cian.

- Tokens en tres estados de tema, con `[hidden]{display:none!important}` como
  guarda (un `nav{display:flex}` le ganaba al `hidden` del navegador y dejaba los
  34 módulos a la vista en la pantalla de ingreso; lo encontró una auditoría
  visual, no la lectura del código).
- Marca dibujada en SVG: no depende de que exista una fuente en ninguna máquina.
- El resplandor queda reservado a lo público; en una tabla de comprobantes sería
  ruido encima del dato.
- Navegación agrupada en 8 grupos por lo que la persona vino a hacer.

Verificado en el navegador: la página pública y la consola renderizan con la
identidad, en claro y en oscuro.

---

# 13. Dashboard

**FUNCIONAL, NO PRODUCTIZADO.** Tres cuentas de hechos, no indicadores
compuestos. Tras el arreglo de H-4 ya no miente cuando no puede consultar.

Sigue pendiente lo que ya estaba anotado: rediseñarlo como una entrada real al
trabajo del día, no como una lista de tablas.

---

# 14. Decision Engine

**IMPLEMENTADO Y FUNCIONAL. NO VERIFICADO en esta pasada más allá de su
existencia y sus tests.**

`decision_records` exige evidencia (mínimo un elemento), alternativas (mínimo
dos), y separa `recomendada_id` de `elegida_id` en dos columnas —para poder medir
cuántas veces se siguió la recomendación—. Las de impacto ALTO o CRÍTICO exigen
segunda firma. La calibración es un porcentaje de aciertos sobre revisiones que
escribió una persona: no hay ningún modelo que se ajuste solo.

---

# 15. IA / Intelligence

**PREPARADO, NO CONECTADO — y es un estado deliberado, no una falta.**

`AI_PROVIDER` tiene tres valores y ninguno más: `none` (por defecto, **y es un
modo de operación**: el sistema sugiere con la historia de la empresa sin mandar
un solo documento afuera), `mock`, y `http`. Un valor desconocido **no cae a
`none`**: el servidor no arranca. Un typo que degrada en silencio sería peor que
un arranque fallido.

**Nada de lo que NEXO promete hoy necesita un proveedor de modelo.** Ver §22.

---

# 16. OCR / Document Engine

**PREPARADO, NO CONECTADO.** El puerto de OCR está definido y el motor por
defecto es `NullOcrEngine`, que responde `disponible: false` con motivo
`SIN_MOTOR_OCR`.

La decisión de diseño es correcta y está escrita: *«un pipeline que devuelve
"cero campos encontrados" cuando en realidad no había OCR instalado produce
documentos que el contador cree revisados y nadie leyó»*.

Los lectores que **sí** funcionan hoy: tabulares, texto, XML y ZIP. Es decir, lo
que llega de ARCA y de los bancos en formato estructurado se procesa; lo que
llega como imagen escaneada, no.

---

# 17. Performance

**NO VERIFICADO en esta pasada.** Existe `scripts/bench-vistas.mjs`, que nació de
una medición real: `stock_valuation` tardaba 25 segundos con 50.000 movimientos y
2 milisegundos con los datos de los tests. **Ninguna suite podía verlo**: los
tests prueban que la cuenta esté bien, no que se pueda esperar el resultado.

El instrumento existe y mide con el rol `aai_app` y la empresa en contexto, que
es como consulta la API. Medir como `postgres` daría números más lindos y
equivocados.

*(Pendiente: correrlo y anotar los números.)*

---

# 18. Tests

Al cierre de esta auditoría:

```
Test Files   149 passed (149)
Tests        2.267 passed (2267)
```

Controles de la serie S-*: **33** (S-32 y S-33 son nuevos de esta auditoría).

**Lo que esta auditoría cambió sobre cómo se testea aquí:** cada control nuevo
fue **observado fallando** antes de darlo por bueno. Un control que no se ve
fallar no es un control — y esta auditoría encontró la prueba de eso: S-15 tenía
un parser que no admitía guiones en los nombres de vista, así que una pantalla
nueva llamada `alta-empresa` era invisible para él.

---

# 19. E2E

**Se recorrió el sistema como cliente, con el navegador, por primera vez.** Ese
recorrido produjo H-3, H-4, H-5 y H-6 — cuatro de los siete hallazgos, incluido
el único bloqueante de V1.

La conclusión metodológica, ya confirmada dos veces en este proyecto: **auditar
el código no alcanza.** Los endpoints funcionaban, los tests pasaban, y el
producto no se podía usar.

---

# 20. Infraestructura

**NO VERIFICADO en esta pasada.** Es la sección con menos evidencia, y es honesto
decirlo: no hay hosting contratado, así que no hay nada que medir todavía. Ver
§23 y §25.

---

# 21. Dependencias externas

| Dependencia | Estado hoy | Clasificación |
|---|---|---|
| PostgreSQL | Funcionando, 18.6 | — |
| ARCA WSAA/WSFE | **Habilitado** en homologación | **B** — falta delegar 3 servicios (gratis) |
| ARCA WSCDC / padrón | No delegado | **B** — trámite de Pablo, $0 |
| Certificado ARCA de producción | No existe | **C** — cuando NEXO prometa emitir |
| Proveedor de correo | No hay | **D** — blocker real de V1 |
| Pasarela de pago | No hay | **D** — blocker real de V1 |
| Hosting / dominio / SSL | No hay | **D** — blocker real de V1 |
| Gestor de secretos (KMS) | Puerto listo, sin cliente | **C** |
| Proveedor de modelo de IA | No hay, y no hace falta | **A** |
| Motor de OCR | Puerto listo, sin motor | **B** — se puede desarrollar sin pagar |
| Monitoreo / logs | No hay | **C** |
| Backups | Scripts existen, sin agenda probada | **B** |

Leyenda: **A.** No hace falta todavía · **B.** Hace falta desarrollar algo antes
· **C.** Hace falta contratarlo después · **D.** Blocker real de V1 · **E.** Solo
V1.1 o futuro.

---

# 22. Cosas que NO debemos pagar todavía

**Esta es la sección que pediste, y la respuesta es más corta de lo esperable:
hoy no hay que pagar casi nada.**

| No pagar | Por qué | Qué hacer en cambio |
|---|---|---|
| **Proveedor de modelo de IA** | Nada de lo que NEXO promete hoy lo necesita. `AI_PROVIDER=none` **es un modo de operación**, no una carencia | Terminar las 35 pantallas |
| **Motor de OCR en la nube** | Lo que llega de ARCA y de los bancos es estructurado y ya se procesa | Si hace falta, un motor local antes de un servicio |
| **Certificado ARCA de producción** | El de homologación vence en 2028 y alcanza para todo el desarrollo | Delegar los 3 servicios que faltan: **$0** |
| **Monitoreo / APM** | No hay tráfico que observar | Elegir destino cuando haya hosting |
| **Diseñador de marca** | La identidad está aprobada y aplicada | — |
| **Gestor de secretos (KMS)** | Sin producción, el sobre local alcanza y está documentado como tal | — |
| **Segundo entorno / staging** | No hay ni el primero | — |
| **Periodicidad anual y su descuento** | La estructura ya lo soporta | — |

**Lo único que sí hay que pagar antes de vender**: correo, pasarela y hosting.
Los tres son §23.

**Trabajo que se puede hacer sin gastar un peso:** todo §24. Es decir, **la
mayor parte de lo que falta para V1 no depende de ningún pago.**

---

# 23. Servicios que necesitaremos contratar

| Servicio | Cuándo | Por qué es blocker |
|---|---|---|
| **Correo transaccional** | Antes del primer cliente | Sin él el alta no se completa sola y no hay recuperación de contraseña. Hoy el mensaje queda en la bandeja de salida y **la pantalla lo dice** en vez de dejar a alguien esperando |
| **Pasarela de pago** | Antes del primer cobro | Hoy solo entra lo que se registra a mano. `intentarCobro` devuelve `SIN_PASARELA` |
| **Hosting + dominio + SSL** | Antes de cualquier cliente | Sin esto no hay producción |

Precios: **A CONFIRMAR.** No invento números.

---

# 24. Trabajo pendiente de desarrollo

Todo esto es trabajo mío y **ninguno depende de un pago**:

1. **Clasificar y productizar las 35 pantallas.** Es el grueso del alcance que
   elegiste. Incluye estados vacíos, estados de carga, y que ninguna muestre JSON
   crudo.
2. **Sacar el JSON crudo de la interfaz.** Empezando por el alta, que es la
   primera pantalla que ve un cliente.
3. **Los topes de plan en castellano**, no `comprobantes_mes: 300`.
4. **El cuerpo de los correos**, escrito para una persona.
5. **Rediseñar el panel de inicio** como entrada real al trabajo del día.
6. **Correr y anotar los benchmarks** (§17).
7. **Motor de OCR local**, si se decide que V1 lo necesita.
8. **Auditar las pantallas restantes** con el mismo método que encontró H-3 a
   H-6: abriéndolas.

---

# 25. Acciones de Pablo

Ordenadas por lo que destraban. El detalle vive en `PABLO_ACCIONES.md`.

| # | Acción | Costo | Bloquea V1 |
|---|---|---|---|
| 1 | Contratar proveedor de correo | A confirmar | **Sí** |
| 2 | Contratar hosting con jurisdicción | A confirmar | **Sí** |
| 3 | Contratar pasarela de pago | Comisión | **Sí** |
| 4 | **Delegar 3 servicios de ARCA en WSASS** | **$0** | No, pero saca la validación fiscal del modo degradado |
| 5 | Condición de IVA de NEXO como empresa | $0 | No |
| 6 | Confirmar la matriz de planes y topes | $0 | No, pero conviene antes del primer cliente |
| 7 | Abogado (términos y privacidad) | A confirmar | Sí para vender |

**Resueltas durante esta etapa:** alcance de V1 (las 35 pantallas) e identidad
visual (aprobada).

---

# 26. Decisiones pendientes

1. **Módulo fuera de plan: ¿esconder o mostrar apagado?** Hoy se esconde (§10).
   Mostrarlo como invitación a subir de plan es una decisión comercial.
2. **¿V1 necesita OCR de imágenes?** Hoy se procesa lo estructurado. Si los
   clientes van a subir fotos de facturas, cambia el alcance.
3. **Los topes por plan** están cargados como **hipótesis**
   (`declarado_por = 'hipotesis-b1'`). Hay que confirmarlos o corregirlos.
4. **Qué se hace cuando vence la prueba y el cliente no paga.** Hoy: suspensión
   sin borrar nada. Falta decidir cuánto tiempo se guardan los datos.

---

# 27. V1 vs V1.1 vs Futuro

**V1** — las 35 pantallas a calidad de producto, sobre el motor que ya existe;
correo, pasarela y hosting contratados; ARCA en modo degradado declarado.

**V1.1** — OCR de imágenes; ARCA de producción por empresa cliente; función de
preferencia para las recomendaciones; periodicidad anual.

**Futuro** — proveedor de modelo de IA; multi-región; app móvil.

---

# 28. Matriz completa de blockers

| # | Blocker | Tipo | Dueño | Estado |
|---|---|---|---|---|
| B-1 | Correo transaccional | Contratación | Pablo | Abierto |
| B-2 | Hosting + dominio + SSL | Contratación | Pablo | Abierto |
| B-3 | Pasarela de pago | Contratación | Pablo | Abierto |
| B-4 | Términos y política de privacidad | Legal | Pablo | Abierto |
| B-5 | Las 35 pantallas productizadas | Desarrollo | Claude | Abierto |
| B-6 | Alta autoservicio completa | Desarrollo | Claude | **Cerrado hoy** |
| B-7 | Paso cruzado por `SECURITY DEFINER` | Seguridad | Claude | **Cerrado hoy** |
| B-8 | Menú que ofrece lo que el plan no incluye | Producto | Claude | **Cerrado hoy** |
| B-9 | Backups con una restauración probada | Operación | Pablo | Abierto |

---

# 29. Riesgos

1. **El riesgo dominante de este repositorio tiene nombre y ya se repitió cinco
   veces:** *la pieza está, la regla está escrita, y nadie recorre el trayecto
   entre las dos.* H-1, H-2, H-3 y H-6 son todos ese mismo defecto. La única
   defensa que funcionó fue **caminar el camino**.

2. **Un control que no se ve fallar no es un control.** S-15 tenía un parser
   ciego a los guiones. Por eso ahora cada control se muta antes de aceptarlo.

3. **El sistema de privilegios de PostgreSQL es acumulativo y tiene defaults
   implícitos.** Tres veces se escribió el permiso que se quería sin leer el que
   había. `has_function_privilege` y `information_schema` contestan en una línea.

4. **Nadie ha usado NEXO más que nosotros.** No hay carga real, ni un cliente
   real, ni una restauración de backup probada.

---

# 30. Criterio de salida a producción

Se puede salir a producción cuando **todo** esto sea cierto:

1. Las 35 pantallas están productizadas y ninguna muestra JSON crudo.
2. Correo, hosting y pasarela contratados y verificados con un cobro de prueba.
3. El alta autoservicio corre de punta a punta con correo real. *(La parte
   técnica ya está: S-33.)*
4. Términos y política de privacidad publicados.
5. Un backup restaurado en una base vacía, con la contabilidad cuadrando después.
6. Los benchmarks corridos con volumen realista.
7. `npm run verify` en verde, incluidos los 33 controles S-*.
8. Una auditoría visual como esta, con **cero** hallazgos nuevos de la familia
   «no se puede llegar».

---

# 31. VEREDICTO FINAL

## 🟡 CASI

**Qué significa exactamente:** el motor está listo y hoy es más sólido que ayer.
El producto no, y el trabajo que falta es en su enorme mayoría **trabajo que se
puede hacer sin pagar un solo peso**.

**Lo que cambió hoy:** NEXO tenía un paso cruzado entre empresas que permitía
borrar contabilidad ajena, un relevamiento fiscal que afirmaba sin preguntar, un
alta autoservicio que no llegaba al final, y un plan de entrada donde más de la
mitad de los botones fallaban. Nada de eso lo había visto ninguna auditoría
anterior. Los cuatro están cerrados, verificados y con control que los detecta si
vuelven.

**Por qué no es 🟢:** porque no puede serlo mientras las 35 pantallas no estén a
calidad de producto, y porque el flujo comercial normal todavía necesita un
proveedor de correo para completarse solo. Las dos condiciones son tuyas, §48.

**Por qué no es 🟠 ni 🔴:** porque no hay ningún blocker técnico sin camino
conocido. Todo lo que falta está identificado, acotado y en manos de alguien.

**La respuesta a tu pregunta —cuánto de lo que falta se puede hacer antes de
gastar un peso—:** casi todo. Los tres servicios a contratar (correo, hosting,
pasarela) hacen falta **al final**, para vender. Todo lo demás —las pantallas, la
productización, el OCR local si se decide, los benchmarks— se hace antes, y es la
mayor parte del trabajo.
