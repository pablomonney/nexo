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
resistió el examen adversarial. Los 2.285 tests pasan **sobre una base
reconstruida desde cero** —lo que no es un detalle, ver H-8—, el libro cuadra
contra movimientos reales, la cadena de auditoría detecta una entrada
adulterada, y no hay una sola tabla con `company_id` sin RLS forzado.

Lo que no resistió fue **el camino del cliente**. Esta auditoría fue la primera
en abrir el navegador y recorrer el alta de punta a punta como lo haría alguien
que llega a pagar. Estaba **cortada en tres lugares distintos**, y ningún test lo
veía porque todos los endpoints funcionaban por separado.

Los ocho hallazgos nuevos. Ninguno figura en las auditorías anteriores de este
repositorio, y siete de los ocho no los podía ver ningún test que existiera:

| # | Hallazgo | Gravedad | Estado |
|---|---|---|---|
| **H-1** | Tres funciones `SECURITY DEFINER` permitían **borrar y rehacer datos contables de otra empresa** desde el rol de la aplicación | Crítico | Cerrado (0108, 0109, S-32) |
| **H-2** | El relevamiento de ARCA declaraba los cuatro servicios `NO_DELEGADO` **sin haberle preguntado nada al organismo** | Alto | Cerrado |
| **H-3** | El alta autoservicio **no llegaba al final**: el formulario de crear empresa era inalcanzable | Bloqueante de V1 | Cerrado (S-33) |
| **H-4** | El Panel mostraba **«Sin pendientes» en verde** con tres 403 detrás | Alto | Cerrado |
| **H-5** | Un cliente del plan de entrada veía **23 de 40 dominios contestando 403** | Bloqueante comercial | Cerrado |
| **H-6** | Un secreto TOTP ilegible dejaba **inalcanzable el código de recuperación** | Alto | Cerrado |
| **H-7** | Errores 4xx del framework se contestaban y registraban como **500** | Medio | Cerrado |
| **H-8** | **Ajustar stock devolvía 500 en toda instalación nueva**, y la verificación daba verde porque corría contra una base arrastrada | **Crítico** | Cerrado (0110, S-20) |

Todos están corregidos, con control automático que los detecta si vuelven, y
**cada control fue observado fallando** antes de darlo por bueno.

**H-8 merece leerse aparte**, porque no es un defecto del stock: es un defecto
del método. La verificación completa daba verde contra una base de pruebas
arrastrada de hace meses que tenía una fila que **ninguna migración crea**. Una
instalación nueva —es decir, la única que va a existir en producción— no la
tiene, y ahí la operación fallaba. Detalle en §8.

**Veredicto anticipado (el detalle está en §31): 🟡 CASI.** Lo que falta para
vender no es motor: es terminar tres pantallas y tres
decisiones de Pablo que no cuestan casi nada. Ver §22: **hoy no hay que pagar
prácticamente nada.**

---

# 2. Línea de base medida

Medido con consultas al catálogo de PostgreSQL sobre la base de desarrollo, y
con las herramientas del repositorio.

## Base de datos

| Objeto | Cantidad |
|---|---|
| Migraciones aplicadas | **110** |
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
| Acciones auditadas | 159 |

## Código

| | |
|---|---|
| Archivos TypeScript (sin `dist`) | 228 |
| Módulos de rutas HTTP | 52 |
| Registros de endpoint | ~284 |
| Migraciones SQL | 110 |
| Suites de integración | 86 |
| Controles de la serie S-* | **33** |
| Consola (una sola página) | ~10.970 líneas |
| Pantallas de la consola | **37** (34 con botón + 3 del arranque) |
| Página pública | 423 líneas |

## Verificación completa (`npm run verify`)

```
typecheck            sin errores
lint                 sin errores
lint:arch            0 violaciones (258 módulos, 895 dependencias)
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
258 módulos recorridos, **0 violaciones**. Se verificó ejecutándolo, no leyendo
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

**Estado: FUNCIONAL, INTEGRADO y ACCESIBLE. La productización es lo que falta.**

Cada módulo se abrió en el navegador con una empresa nueva (§11) y tiene suite de
integración propia.

| Módulo | Rutas | Suite de integración | Pantalla |
|---|---|---|---|
| **Ventas** | `comercial`, `comprobantes`, `precios` | `ciclo-comercial`, `cadena-de-ventas` | 🟢 |
| **Compras** | `solicitudes-de-compra`, `recepciones`, `ordenes-de-pago` | `ciclo-compras` | 🟢 |
| **Stock** | `stock`, `recuentos`, `valuacion` | `stock`, `recuentos` | 🟢 |
| **Caja** | `caja` | `caja` | 🟢 |
| **Bancos** | `banks` | `bank-reconciliation`, `conciliacion-por-http` | 🟢 |
| **Cheques** | `cheques` | `cheques` | 🟢 |
| **CRM** | `crm` | `crm` | 🟢 |
| **Proyectos** | `proyectos` | `proyectos` | 🟢 |
| **Comisiones** | `comisiones` | `comisiones` | 🟢 |
| **Sucursales** | `sucursales` | (cubierto en analítica) | 🟢 |
| **Bienes de uso** | `activos` | `bienes-de-uso` | 🟢 |
| **Reportes** | `books`, `statements`, `analitica`, `exportaciones` | `financial-statements`, `estados-contables`, `exportaciones` | 🟢 |

Lo que se comprobó y vale la pena destacar, porque son las decisiones que
distinguen un ERP contable de una planilla:

- **La conciliación bancaria se propone y se confirma de a una.** No hay «aceptar
  todas»: la norma pide intervención humana, y un botón que acepta todo junto es
  exactamente lo que la norma evita.
- **La comisión es devengada, no pagada.** Pagarla es un asiento que firma una
  persona.
- **La sucursal no se guarda en la factura**: se deriva del punto de venta
  vigente el día del comprobante. No hay una columna que pueda contradecir al
  número que ya viaja en el comprobante.
- **Un asiento aprobado no se edita**: se anula por contraasiento, y el número
  del anulado queda.
- **Una orden de pago aprobada no es plata que salió.**

El detalle pantalla por pantalla está en §11.

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

## H-8 — La verificación corría contra una base que producción no puede tener

**NUEVO, y el más grave de los ocho.** `POST /stock-movements/ajuste` contestaba
**500 en cualquier base recién migrada**. No fallaba solo la bitácora: fallaba el
ajuste entero, porque la escritura de auditoría corre dentro de la misma
transacción y la clave foránea contra `audit_actions` la aborta.

La causa es de una línea. `stock.ts` emite

```
action: datos.origenTipo === 'AJUSTE' ? 'AJUSTAR_STOCK' : 'REGISTRAR_SALIDA_DE_STOCK'
```

y **`AJUSTAR_STOCK` no está en ninguna migración**. La 0091, que le dio identidad
al vocabulario de la bitácora, cargó las otras dos acciones de stock y se salteó
esta.

**Alcance:** en todo despliegue nuevo de NEXO —o sea, en todos— ajustar
existencias por recuento, rotura o diferencia devolvía «Error interno». Es la
operación con la que un contador arregla la diferencia entre lo que dice el
sistema y lo que hay en el depósito.

### Por qué nadie lo vio, que es lo importante

El control **existía y era correcto**: S-20 compara las acciones que el código
emite contra `audit_actions`, y ese barrido está escrito con cuidado —entiende
hasta el ternario de arriba, que le costó dos versiones—. Los tests de stock
**también** existían y ejercitaban el ajuste.

Lo que fallaba era **contra qué base corrían**. La base de pruebas local se
arrastraba de hace meses y tenía la fila `AJUSTAR_STOCK` cargada por un esquema
anterior. Ninguna migración la crea, así que ninguna instalación nueva la iba a
tener; pero la local sí, y con eso el control pasaba en verde y los tests
también.

Salió a la luz por accidente: esta auditoría corrió los benchmarks (§17), que
dejan datos, y después reconstruyó la base de pruebas para limpiarla. **Esa base
reconstruida es la primera en mucho tiempo idéntica a la que produciría un
despliegue**, y ahí siete tests se pusieron en rojo de golpe.

La lección no es «faltaba una fila». Es que **un control que corre contra un
estado que la producción no puede tener no está midiendo la producción**.

### El control que faltaba

S-20 miraba del código hacia la base, y por eso no podía verlo: la fila
**estaba**; lo que no estaba era el motivo por el que estaba. El control nuevo
mira en la otra dirección: **cada acción de la base tiene que estar nombrada en
alguna migración**. Observado fallando con una fila inventada
(`ACCION_DE_UN_ESQUEMA_VIEJO`), y en verde al sacarla.

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

- **Estados de carga:** una pantalla que tarda no dice que está trabajando.
- Los identificadores crudos que quedan en Configuración.
- El rediseño del panel de inicio.

## Clasificación de las 37 pantallas

**Método:** se creó una empresa nueva con plan **Completo** —para que todas
fueran alcanzables— y se abrió **cada una**, midiendo en el DOM: errores
visibles, filas cargadas, estado vacío presente, y texto que llega al cliente.

**Resultado del barrido: 32 de 33 pantallas alcanzables sin un solo error.** La
única con caja de error es `config`, y su error es legítimo (falta declarar el
ejercicio y el marco contable) aunque esté escrito con identificadores.

| Pantalla | Estado | Qué le falta |
|---|---|---|
| Panel (inicio) | 🟡 | Rediseñarlo como entrada al día, no como lista de tablas |
| Pendientes (bandeja) | 🟢 | — |
| Preguntar (inteligencia) | 🟢 | Degrada honesto: «Sin proveedor de modelo» |
| Comercial | 🟢 | — |
| Terceros | 🟢 | — |
| Productos | 🟢 | — |
| Precios | 🟢 | — |
| CRM | 🟢 | — |
| Comisiones | 🟢 | — |
| Solicitudes | 🟢 | — |
| Recepciones | 🟢 | — |
| Pagos | 🟢 | — |
| Documentos | 🟢 | Estado vacío agregado hoy |
| Propuestas de IA | 🟡 | Sin proveedor no hay nada que revisar |
| Operaciones | 🟢 | — |
| Existencias | 🟢 | — |
| Bienes de uso | 🟢 | — |
| Proyectos | 🟢 | — |
| Sucursales | 🟢 | — |
| Integraciones | 🟢 | — |
| Caja | 🟢 | — |
| Bancos | 🟢 | Estado vacío agregado hoy |
| Cheques | 🟢 | — |
| IVA | 🟢 | — |
| Asientos | 🟢 | Estado vacío agregado hoy |
| Libros | 🟢 | — |
| Estados y notas | 🟢 | — |
| Períodos y cierre | 🟢 | Estado vacío agregado hoy |
| Analítica | 🟢 | — |
| Señales | 🟢 | — |
| Auditoría | 🟢 | — |
| Plan (suscripción) | 🟢 | Topes en castellano hoy |
| Configuración | 🟡 | Permisos y pasos faltantes con identificadores crudos |
| Cambiar empresa | 🟢 | Salida al alta agregada hoy |
| **Ingresar** | 🟢 | Respuestas legibles hoy |
| **Crear mi empresa** (nueva) | 🟢 | Errores de validación legibles hoy |
| **Segundo factor** (nueva) | 🟢 | — |

**Nota sobre el conteo:** el menú tiene 34 botones, hay 37 secciones. Las tres
que no tienen botón —Ingresar, Segundo factor y Crear mi empresa— son las
paradas del arranque, y no pueden tenerlo porque el menú todavía no está visible
cuando se recorren. Dos de las tres **son nuevas de esta auditoría** (§11, H-3).

### Lo que el barrido corrigió

- **Cuatro estados vacíos** donde había una tabla con encabezados y nada más:
  Documentos, Bancos, Asientos, Períodos y cierre. Cada mensaje dice qué va ahí
  y por qué todavía no hay nada.
- **El énfasis de la API se dibuja como énfasis.** Cuarenta y cinco cadenas en
  catorce módulos escriben `**así**` y `` `así` `` —la convención del
  repositorio para lo que hay que leer con atención— y la consola las escapaba
  enteras: en pantalla se leía «La comisión es \*\*devengada, no pagada\*\*».
  Ahora una sola función lo resuelve, **escapando primero y convirtiendo
  después**, en ese orden, para que el texto del servidor no pueda inyectar
  marcado. Verificado en cuatro pantallas: **cero asteriscos literales**.
  Control en S-15, en las dos direcciones — que no quede ningún texto escapado
  crudo, y que el orden escapar→convertir no se invierta.

- **El volcado de JSON dejó de ser lo primero que se lee.** Una sola función
  —`decir()`— dibuja todas las respuestas de la API en las 37 pantallas, y
  volcaba el objeto entero. En la pantalla de crear la empresa, un CUIT con el
  dígito mal se leía:

  ```
  400
  { "error": "VALIDATION_ERROR", "message": "Datos inválidos",
    "details": [ { "path": "cuit", "message": "El dígito verificador…" } ] }
  ```

  El mensaje que servía estaba a tres llaves de distancia. Verificado hoy en esa
  misma pantalla, con el mismo CUIT:

  > **Datos inválidos**
  > · estudio: Tiene que tener al menos 2 caracteres
  > · cuit: El dígito verificador del CUIT no cierra
  > ▸ Ver el detalle técnico

  **No se perdió nada: cambió el orden.** El volcado sigue a un clic, para quien
  lo necesite y para pegarlo en un reporte. El principio que ya estaba escrito
  —«los errores de la API explican qué corregir, así que no se traducen a un
  algo salió mal»— no se tocó: se cumplió mejor.

- **Los errores de validación están en castellano.** Casi todos los esquemas
  traen su mensaje escrito, pero **el caso que nadie escribió** salía con el
  texto por defecto de zod: `roles: Required`, en la pantalla, en inglés. Un
  mapa de errores en un solo lugar lo resuelve para toda la API, y **los
  mensajes escritos a mano ganan**: eso último tiene control positivo propio,
  porque una traducción que se llevara puestos los mensajes buenos sería peor
  que el problema.

- **Los topes de los planes se leen.** Eran `comprobantes_mes: 300 · empresas: 1
  · integraciones: 1 · usuarios: 3` en la pantalla de precios —la que mira
  alguien que está por elegir cuánto pagar—. Ahora: **«300 comprobantes por mes
  · 1 empresa · 1 integración · 3 usuarios»**, con el singular y el plural donde
  corresponde. Verificado en la página pública y en la consola.

### Lo que sigue faltando

Está en §24. Lo resumido: **estados de carga**, los identificadores crudos que
quedan en Configuración, y el rediseño del panel de inicio.

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

**VERIFICADO POR ESTA AUDITORÍA.** Corrido hoy con `npm run bench:vistas`, con el
rol `aai_app` y la empresa en contexto —que es como consulta la API—. Medir como
`postgres` daría números más lindos y equivocados: el superusuario se saltea RLS,
que es justo la parte que cuesta.

Carga generada: **50.002 movimientos de stock**, 200 productos × 250 movimientos,
300 terceros × 40 comprobantes.

| Vista | Mejor de 3 |
|---|---|
| `company_readiness` | 0 ms |
| `invoice_settlement` | 5 ms |
| `analytics_margen_por_producto` | 6 ms |
| `analytics_por_tercero` | 8 ms |
| `analytics_operaciones_mensuales` | 8 ms |
| `stock_ppp` | 24 ms |
| `analytics_resumen` | 25 ms |
| `analytics_costo_de_ventas` | 59 ms |
| **`stock_valuation`** | **66 ms** |
| `analysis_signals` | 98 ms |
| `party_aging` | 126 ms |
| `analytics_flujo_de_fondos` | 173 ms |
| `work_queue` (bandeja) | 429 ms |
| `work_queue` · una página | 564 ms |

**Ninguna pasó de 1000 ms.**

El dato que importa es `stock_valuation`: **66 ms con 50.002 movimientos**. Esa
misma consulta, con ese mismo volumen, tardaba **25 segundos** antes de la
migración 0086 — y con los datos de los tests tardaba 2 ms, así que **ninguna
suite podía verlo**. Los tests prueban que la cuenta esté bien, no que se pueda
esperar el resultado. La mejora es de tres órdenes de magnitud y está medida, no
estimada.

Lo más lento es `work_queue`, la bandeja de pendientes, con **429–564 ms**. Está
dentro de lo tolerable y es lo primero que se abre al entrar, así que es la
candidata natural si algún día hace falta optimizar.

**Lo que estos números NO dicen:** nada sobre producción. Otra máquina, otro
disco, otra concurrencia, y un solo cliente por vez. Afirman cuánto tarda **esta**
consulta contra **este** volumen, que es lo que hace falta para distinguir «es
lento» de «me lo imaginé».

---

# 18. Tests

Al cierre de esta auditoría:

```
Test Files   151 passed (151)
Tests        2.285 passed (2285)
```

Controles de la serie S-*: **33** (S-32 y S-33 son nuevos de esta auditoría).

**Lo que esta auditoría cambió sobre cómo se testea aquí** son dos cosas, y las
dos importan más que los números:

**1. Un control que no se ve fallar no es un control.** Cada control nuevo se
mutó y se observó en rojo antes de aceptarlo. La prueba de que hacía falta:
S-15 tenía un parser que no admitía guiones en los nombres de vista, así que una
pantalla nueva llamada `alta-empresa` le era invisible. El control estaba, y no
miraba.

**2. Un control que corre contra un estado que la producción no puede tener no
está midiendo la producción.** Es H-8 (§8). La base de pruebas local llevaba
meses arrastrándose y tenía una fila que ninguna migración crea; con eso, siete
tests correctos daban verde sobre un sistema que en una instalación nueva estaba
roto. **Reconstruir la base de pruebas cada tanto no es higiene: es medición.**

---

# 19. E2E

**Se recorrió el sistema como cliente, con el navegador, por primera vez.** Ese
recorrido produjo H-3, H-4, H-5 y H-6 — cuatro de los ocho hallazgos, incluido
el único bloqueante de V1.

Dos recorridos completos, con cuentas nuevas de verdad:

1. **El alta de punta a punta.** Registro → confirmación (código leído de la
   bandeja de salida, que es donde queda mientras no haya proveedor de correo) →
   ingreso → segundo factor → crear empresa → consola operando. Una sola sesión,
   sin que nadie tocara la base a mano. Antes de esta auditoría, ese recorrido
   **no llegaba al final**.

2. **Las 33 pantallas alcanzables**, una por una, con una empresa nueva de plan
   Completo. Cero errores en 32. El barrido está en §11.

También se midió el mismo sistema **desde el plan de entrada**: 34 botones, 23 de
40 dominios contestando 403. Después del arreglo: 14 botones, todos funcionando.

La conclusión metodológica, ya confirmada dos veces en este proyecto: **auditar
el código no alcanza.** Los endpoints funcionaban, los tests pasaban, y el
producto no se podía usar.

---

# 20. Infraestructura

**PARCIALMENTE VERIFICADO.** Lo que existe, existe de verdad; lo que no está
decidido, no está.

**Existe y se inspeccionó:**

- `Dockerfile` en dos etapas. La imagen que corre **no lleva el compilador, ni
  las dependencias de desarrollo, ni el código fuente**: una imagen con `tsc`
  adentro es superficie de ataque que no sirve para nada en producción. No elige
  proveedor ni orquestador.
- `infrastructure/docker-compose.yml` con PostgreSQL 18, Redis 7 y MinIO, los
  tres con `healthcheck`.
- **CI en GitHub Actions** que corre cada compuerta por separado —typecheck,
  lint, lint de arquitectura, prohibición del punto flotante, integridad del
  archivo normativo, migraciones, y **migraciones idempotentes corriéndolas dos
  veces**— más los tests con umbrales de cobertura. Cada paso es un paso y no un
  `npm run ci`, para que la interfaz de GitHub muestre cuál falló.
- `docs/DESPLIEGUE.md` con lo que falta decidir.
- Scripts de backup y de restauración.

**No existe, y es lo que falta:**

- Hosting, dominio y certificado (§23).
- Una **restauración probada**: los scripts están, pero nadie restauró un backup
  en una base vacía y verificó que la contabilidad cuadre después. Hasta que eso
  pase, el backup es una intención.
- Destino de logs y alertas.

**No hay nada que medir de producción porque no hay producción.** Decirlo así es
más útil que inventar una evaluación.

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

1. **Terminar de productizar las pantallas.** Están clasificadas (§11) y las
   🟢 son **34 de 37**. Las tres que quedan: estados de carga —una pantalla que
   tarda no dice que está trabajando—, los identificadores crudos que quedan en
   Configuración, y el panel de inicio.
2. **Rediseñar el panel de inicio** como entrada real al trabajo del día.
3. **Motor de OCR local**, si se decide que V1 lo necesita (§26).
4. **Restaurar un backup en una base vacía** y verificar que la contabilidad
   cuadre después. Los scripts existen; la restauración no se probó nunca.
5. **Seguir abriendo el producto.** Ocho hallazgos, y los cinco más caros
   salieron de abrir pantallas y reconstruir la base, no de leer código.

**Ya hechos durante esta auditoría:** clasificar las 37 pantallas, correr los
benchmarks, los ocho hallazgos con sus controles, y la primera tanda de
productización:

| | |
|---|---|
| Respuestas de la API | De volcado de JSON a frase, con el detalle plegado |
| Errores de validación | En castellano, sin pisar los mensajes escritos a mano |
| Topes de los planes | «300 comprobantes por mes · 1 empresa», no `comprobantes_mes: 300` |
| Estados vacíos | Cuatro pantallas que eran una tabla con encabezados y nada |
| Énfasis de la API | Se dibuja como énfasis, no como asteriscos |
| Textos con rutas de la API | El correo de alta y tres mensajes de error, reescritos para una persona |

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

5. **La base local puede no ser la base que produce una instalación nueva.** Es
   H-8, y es el riesgo más difícil de ver porque se manifiesta como *ausencia*
   de síntomas: todo verde, y la producción rota. Mitigado con el control nuevo
   de S-20, pero la regla general vale más que el control: **reconstruir la base
   de pruebas cada tanto no es higiene, es medición.**

---

# 30. Criterio de salida a producción

Se puede salir a producción cuando **todo** esto sea cierto:

1. Las 37 pantallas están productizadas: **34 lo están hoy**; faltan estados de
   carga, los identificadores de Configuración y el panel de inicio.
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
borrar contabilidad ajena; un relevamiento fiscal que afirmaba sin preguntar; un
alta autoservicio que no llegaba al final; un plan de entrada donde más de la
mitad de los botones fallaban; y **una operación —ajustar stock— que estaba rota
en toda instalación nueva mientras la verificación daba verde**. Nada de eso
figuraba en ninguna auditoría anterior. Los ocho están cerrados, verificados, y
con un control que los detecta si vuelven — cada uno observado fallando.

**Por qué no es 🟢:** por dos motivos, y los dos son condiciones tuyas del §48.
Quedan tres pantallas sin llegar a calidad de producto (§11), y **el flujo
comercial normal todavía necesita un proveedor de correo para completarse solo**.
La parte técnica de ese flujo ya está y se camina entera en S-33; lo que falta es
que el correo salga de la bandeja del servidor.

**Por qué no es 🟠 ni 🔴:** porque no hay ningún blocker técnico sin camino
conocido. Todo lo que falta está identificado, acotado y en manos de alguien.

**La respuesta a tu pregunta —cuánto de lo que falta se puede hacer antes de
gastar un peso—:** casi todo, y hoy quedó menos que ayer. Los tres servicios a
contratar (correo, hosting, pasarela) hacen falta **al final**, para vender. Lo
que sigue en mi lista —tres pantallas, el panel de inicio, el OCR local si se
decide, y una restauración de backup probada— no necesita un solo peso.

**Y una cosa que no estaba en la pregunta pero es la más importante que aprendí
hoy:** los cinco hallazgos más caros no salieron de leer código. Salieron de
**abrir el producto y de reconstruir la base**. Las once auditorías anteriores
leyeron; esta ejecutó. Si hay una sola cosa que cambiar en cómo se verifica NEXO
de acá en adelante, es esa.
