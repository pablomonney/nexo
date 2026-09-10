# NEXO — AUDITORÍA GLOBAL PRE-PRODUCCIÓN (B-2)

**Fecha de la medición:** 2026-09-10
**Método:** ejecución, no lectura. Toda afirmación de este documento tiene atrás
una consulta al catálogo de PostgreSQL, una corrida de tests, una respuesta HTTP
o un comando con su salida.
**Alcance:** todo NEXO. El Migration Engine entra **solo como regresión** —se
cerró en V3 el 2026-09-09— y no se vuelve a auditar acá.

> **La pregunta que ordena todo el documento.**
>
> ¿Qué falta realmente para que NEXO pueda recibir una empresa real como
> cliente, operar de forma segura y confiable en producción, **cobrarle**,
> mantener sus datos aislados y permitirle trabajar diariamente **sin
> intervención manual del equipo fundador**?

> **Regla de no repetición.** Nada se acepta por venir declarado terminado en una
> auditoría anterior. La auditoría del 2026-09-09
> (`NEXO_AUDITORIA_DETERMINISTICA_PRE_PRODUCCION.md`) cerró nueve hallazgos; los
> que esta auditoría volvió a medir están marcados **CONFIRMADO**.

---

## 1 · Veredicto

# 🟡 PRE-PRODUCTION READY WITH EXTERNAL BLOCKERS

No es verde, y el motivo no es el código.

Después de arreglar los tres hallazgos de esta auditoría, **NEXO no tiene ningún
bloqueante propio para recibir una empresa real**. Los que quedan son cuatro
contrataciones y una decisión de infraestructura: correo, hosting, pasarela de
cobro, certificado de producción de ARCA y gestor de secretos. Ninguno se
resuelve escribiendo código, y **los cinco están del otro lado de una interfaz
que ya existe**.

No es verde porque dos de esos cinco tocan la pregunta directamente:

- **sin proveedor de correo, un alta autoservicio no se completa sola** — el
  token de verificación queda en `email_outbox` y alguien del equipo fundador
  tiene que hacerlo llegar a mano;
- **sin gestor de secretos, no hay ARCA de producción para varias empresas** —
  `desenvolver()` se niega, a propósito, a abrir una clave privada envuelta con
  una llave del entorno cuando `NODE_ENV=production`.

Mientras esas dos sigan abiertas, «recibir una empresa real como cliente» exige
intervención manual del equipo fundador **en el primer minuto** de cada cliente.
Eso es exactamente lo que la pregunta excluye.

---

## 2 · Los tres hallazgos de esta auditoría

Ninguno figura en auditorías anteriores. Los tres estaban en la misma clase de
lugar: **la junta entre dos piezas que, cada una por su lado, funcionaban bien.**

| # | Hallazgo | Gravedad | Estado |
|---|---|---|---|
| **B2-1** | Al vencer la prueba de 14 días, la empresa pasaba a ver **todos** los módulos en vez de ninguno. Dejar de pagar **ampliaba** el producto | **BLOQUEANTE** | Cerrado |
| **B2-2** | `.env.example` y el código no coincidían **en ninguno de los dos sentidos**: prometía un Redis y un S3 que nada usa, y callaba las tres variables que deciden si el servidor arranca | ALTO | Cerrado |
| **B2-3** | El banner de arranque —que existe para que ningún modo degradado sea invisible— **no nombraba el correo ni el cobro**, los dos únicos apagados del todo | ALTO | Cerrado |

### B2-1 · Vencer la prueba ampliaba el acceso

**Lo que decía la documentación.** `NEXO_BILLING.md` §9, con todas las letras:
«Suspender corta el acceso y **conserva todo**». Y §5: «Una suscripción
suspendida se sigue facturando. La deuda corre; lo que se corta es el acceso.»

**Lo que hacía el código.** `funcionalidadesDe()` filtraba por
`estado IN ('ACTIVA','PRUEBA')`. Una suscripción `SUSPENDIDA` devolvía **cero
filas**, y cero filas se interpretaba como «esta empresa no tiene plan» — que es
uno de los tres casos que la puerta comercial deja pasar a propósito.

El resultado, medido:

```
CONTABLE activa      → GET /analysis/signals  403 FUERA_DEL_PLAN
CONTABLE suspendida  → GET /analysis/signals  200          ← el defecto
COMPLETO cancelada   → GET /accounts          200          ← el defecto
```

**Por qué ningún test lo veía.** Las dos mitades estaban probadas y las dos
estaban bien: que la prueba vence y queda `SUSPENDIDA` (probado), y que la
puerta falla abierta sin suscripción (probado, y **deliberado**). Nadie preguntó
qué pasaba **después** de vencer. El defecto vivía en la junta.

**Por qué es bloqueante.** La confusión no era entre dos estados parecidos: era
entre **«no sé»** y **«sé que no»**. Los tres casos que la puerta deja pasar son
formas de no tener información. Una suspensión es información. Con este defecto,
el ciclo comercial de NEXO no cerraba: no había ninguna consecuencia de no pagar.

**El arreglo.** El estado se consulta **aparte** de las funcionalidades y
**antes** —preguntarlo después lo haría indistinguible de una empresa sin plan—,
sin filtrar por vigencia: una prueba vencida queda con `vigencia_hasta` en el
pasado, y cualquier condición de vigencia la volvería a esconder, que es
exactamente cómo el defecto se escondía.

Se arreglaron también las **dos consecuencias** de cortar el acceso, que sin
atender habrían recreado hallazgos ya cerrados:

- `GET /companies/current` devuelve ahora todos los dominios como excluidos y el
  motivo. Sin eso, la consola dibujaba el menú entero y **cada botón terminaba
  en 403**: es H-5 del 2026-09-09 recreado por el otro motivo.
- El mensaje distingue `SUSCRIPCION_SUSPENDIDA` de `FUERA_DEL_PLAN`. Decir el
  equivocado manda a comprar un módulo que la empresa **ya contrató** a quien
  solo tiene que pagar una factura.
- La consola muestra un cartel que dice las tres cosas que hacen falta, en este
  orden: que está suspendida, que **los datos están**, y adónde ir.

**Control:** siete casos nuevos en `tests/integration/prueba-y-planes.test.ts`.
**Cinco se observaron fallando** antes del arreglo. Dos de ellos son los que
sostienen la regla que **no** se tocó: sin suscripción se sigue pasando, y una
suspendida sigue llegando a `/suscripciones` y `/companies/current` —una puerta
que deja al cliente afuera de la caja no cobra: enoja—.

### B2-2 · La plantilla de configuración mentía en los dos sentidos

`docs/DESPLIEGUE.md` §2 tenía la lista completa y correcta. El que estaba
desactualizado era **el archivo que alguien copia**, que es el que se usa.

Declaradas y que nadie leía —siete—:

| Variable | Qué prometía | Qué pasaba de verdad |
|---|---|---|
| `REDIS_URL` | Una cola | No hay colas |
| `S3_ENDPOINT` / `S3_BUCKET` / `S3_ACCESS_KEY` / `S3_SECRET_KEY` | Object storage | Los documentos van al **disco local** |
| `OCR_PROVIDER=local` | Tesseract en el host | El código lee `OCR_ENGINE`; no hay motor |
| `ARCA_KMS_KEY_ID` | Una referencia a KMS | El código lee `ARCA_LOCAL_KEK` |

Leídas y no declaradas: dieciséis, tres de ellas decisivas —`MFA_ENCRYPTION_KEY`
(sin ella el servidor **no arranca** en producción), `ARCA_LOCAL_KEK` y
`METRICS_TOKEN` (sin ella `GET /metrics` **no existe**, así que un despliegue
hecho desde la plantilla queda sin observabilidad y nadie se entera)—.

Lo grave no es la desprolijidad: es que **una plantilla de configuración es
documentación ejecutable, y una documentación ejecutable equivocada no se lee
como un error sino como una instrucción.** Alguien iba a levantar un MinIO y
creer que los comprobantes de sus clientes viajaban ahí.

**Control:** `tests/security/configuracion-declarada.test.ts` (S-38), observado
fallando con la lista exacta de los 23 desajustes.

### B2-3 · El banner de arranque callaba los dos modos más apagados

`apps/api/src/arranque.ts` existe, según su propio encabezado, porque «los modos
degradados son invisibles». Mostraba ARCA, OCR, IA, secretos y entorno.

No mostraba **correo** ni **cobro** — que son los dos únicos que están apagados
del todo. El motivo es de forma y por eso no se ve leyendo: el banner recorría
variables de entorno, y **lo que no tiene variable no aparecía**. Correo y cobro
no tienen ninguna, precisamente porque no hay nada que configurar.

Ahora se declaran fijos, a propósito: el día que se conecte un proveedor habrá
que tocar esa línea, y eso es lo que se quiere — que conectar algo y decir que
está conectado sean el mismo cambio.

**Control:** un caso nuevo en `tests/integration/arranque.test.ts`.

---

## 3 · Línea de base, medida

Consultas al catálogo de PostgreSQL sobre la base de desarrollo, 2026-09-10.

| | |
|---|---|
| Paquetes / apps | 16 / 2 |
| Migraciones aplicadas | 115 |
| Rutas | 53 archivos |
| Scripts de operación | 50 |
| Archivos de test | 163 |
| Controles de seguridad `S-*` | 37 |
| **Tests** | **2.456 en 163 archivos, todos en verde sobre base reconstruida desde cero** |

### Aislamiento multiempresa

| | |
|---|---|
| Columnas `company_id` | 223 |
| Tablas con `company_id` **sin RLS forzado** | **0** |
| Tablas con `company_id` sin política | **0** |
| `aai_app` · `rolsuper` / `rolbypassrls` | `false` / `false` |
| Vistas sin `security_invoker` | 6, **ninguna problemática** (ver abajo) |
| Funciones `SECURITY DEFINER` | 9 |

**Las 6 vistas sin `security_invoker`.** Una vista sin esa opción corre como su
dueño y **saltea RLS**, así que cada una se verificó por privilegio efectivo:

- `norm_candidates_pendientes` — registro normativo global, sin `company_id`.
  Legible por `aai_app`, y **no hay nada de ninguna empresa adentro**.
- `saas_cobranza_mensual`, `saas_ingreso_recurrente`, `saas_movimientos`,
  `saas_sin_importe`, `saas_suscripciones_vigentes` — **`aai_app` NO tiene
  `SELECT` sobre ninguna de las cinco.** Son del operador de la instalación.

`tests/security/vistas-rls.test.ts` ya fija esta regla.

**Las 9 funciones `SECURITY DEFINER`.** Es la clase de H-1 —tres funciones que
permitían rehacer datos contables de otra empresa—, así que se midió el
privilegio efectivo de `aai_app`, no la intención:

| Ejecutable por `aai_app` | Función |
|---|---|
| **no** | `company_organization`, `project_ledger_movements`, `proyectar_ppp`, `rebuild_account_balances`, `recalcular_ppp_de_producto` |
| sí, por diseño | `create_company`, `create_organization`, `grant_company_role`, `user_companies` |

Las cuatro que reconstruyen estado contable siguen fuera del alcance de la
aplicación. **H-1: CONFIRMADO cerrado.**

---

## 4 · Matriz de dependencias externas

Solo estados verificables. «Preparado» significa que la interfaz existe y está
probada del lado de NEXO; **no** significa que haya algo del otro lado.

| Dependencia | Estado | Qué falta | Consecuencia hoy |
|---|---|---|---|
| **Correo** | 🟡 **PREPARADO** — actualizado en B2.5.1 | Una cuenta de Resend, un dominio verificado y declarar `EMAIL_PROVIDER=resend`, `EMAIL_API_KEY` y `EMAIL_FROM`. **Ya no falta código**: el adaptador está en `apps/api/src/correo/resend.ts` | Con `EMAIL_PROVIDER=none` —el valor por omisión— el alta autoservicio **no se completa sola**: el token queda en `email_outbox` con estado `SIN_PROVEEDOR` y lo entrega el operador con `npm run correo:bandeja` |
| **Gestor de secretos (KMS)** | 🟠 **BLOQUEADO** | Elegir proveedor y escribir un adaptador de `SecretProvider` (`get`, `existe`) | **No hay ARCA de producción para varias empresas.** `desenvolver()` se niega a abrir un sobre `local:` con `NODE_ENV=production` |
| **ARCA — certificado de producción** | 🟠 **BLOQUEADO** | Tramitarlo. Hoy solo existe el de homologación, fuera del repositorio | Los comprobantes no tienen validez fiscal. La constatación informa `NO_VERIFICABLE`, que es la verdad |
| **Pasarela de pago** | 🟠 **BLOQUEADO** | Contratar una | No se puede cobrar a una tarjeta. Emitir, prorratear, suspender y registrar una transferencia **sí** funcionan |
| **Hosting** | 🟠 **BLOQUEADO** | Elegir proveedor y jurisdicción | Nada corre en ningún lado. La imagen (`Dockerfile`, dos etapas, sin compilador, usuario no root, `HEALTHCHECK`) está lista |
| **Agendador de tareas** | 🟡 **PREPARADO** | Agendar **una** línea: `npm run diario` | Sin eso, **la prueba de 14 días no vence nunca** (ver §5) |
| **Object storage** | ⚪ **NO EXISTE, Y NO SE PROMETE** | — | Los documentos van al disco local. En contenedor **tiene que ser un volumen** |
| **OCR** | 🟡 PREPARADO | Elegir motor, y dónde corre | `SIN_MOTOR_OCR`. Los documentos se archivan igual |
| **Proveedor de IA** | 🟡 PREPARADO | Credencial y modelo | `AI_PROVIDER=none` es un **modo de operación**: las sugerencias salen de la historia de la propia empresa, sin mandar nada afuera |
| **Monitoreo** | 🟡 PREPARADO | Un recolector, y declarar `METRICS_TOKEN` | Sin el token, `GET /metrics` contesta 404 |
| **Copias de resguardo** | 🟡 PREPARADO | Agendarlas y decidir retención | Los scripts existen y **la restauración se verifica** contra una base descartable |
| **TLS / dominio** | 🟠 BLOQUEADO | Depende del hosting | La aplicación no termina TLS y corre con `trustProxy: false` |

**Ninguna de las doce está mal resuelta. Nueve no están resueltas porque
resolverlas cuesta dinero o una firma, no trabajo.**

---

## 5 · La respuesta a «sin intervención manual»

Es la parte de la pregunta que peor sale, y conviene decirlo sin rodeos.

**Lo periódico existe, funciona, es idempotente y no lo agenda nadie.** El caso
que lo vuelve grave lo encontró esta auditoría siguiendo la cadena de llamadas:

```
vencerPruebas()   ← lo llama solo correrCiclo()
correrCiclo()     ← lo llama solo scripts/facturacion-ciclo.mjs
facturacion-ciclo.mjs ← no lo llama nadie
```

**La prueba de catorce días solo termina si una persona escribe un comando.** Si
nadie lo hace, la suscripción no pasa nunca a `SUSPENDIDA`, y —ahora que B2-1
está arreglado— tampoco se corta nada. El producto queda gratis por tiempo
indefinido, sin que ninguna pantalla lo diga, porque desde adentro todo está
funcionando perfectamente.

**Lo que se hizo:** `npm run diario` (`scripts/tareas-diarias.mjs`) compone las
tres tareas diarias —ciclo de facturación, verificación del libro, cadena de
auditoría—, con modo `--ensayo`, tolerante a fallos por tarea y con código de
salida 1 si alguna falló.

**Lo que no se hizo, a sabiendas:** elegir el agendador. Cron, un timer de
systemd o el programador del proveedor es una decisión del despliegue que sigue
sin tomarse. Lo que cambia es que ahora **lo que hay que agendar es una sola
línea**, y la decisión pendiente es «dónde», no también «qué».

La copia de resguardo queda **fuera** de ese comando a propósito: cada cuánto y
cuánto retener tienen atrás una obligación legal de conservación y un costo, y
meterla con una frecuencia inventada por un script sería tomar esa decisión sin
decirlo.

---

## 6 · Qué se puede afirmar de cada dominio

Medido por la corrida completa de tests sobre base reconstruida desde cero, más
`npm run verify` (typecheck, lint, lint de arquitectura, guarda de flotantes,
archivo normativo, primer arranque, libro, cadena de auditoría, estructura,
invariantes y cobertura).

| Dominio | Estado |
|---|---|
| Contabilidad, partida doble, Mayor | ✅ VERIFICADO — `ledger:verify` recalcula contra movimientos reales |
| Bitácora y cadena de hashes | ✅ VERIFICADO — el verificador **detecta una entrada adulterada** |
| Aislamiento multiempresa | ✅ VERIFICADO — 0 tablas sin RLS forzado, rol sin BYPASSRLS |
| Autenticación, MFA, sesiones | ✅ VERIFICADO |
| Ventas, compras, stock, tesorería, bienes de uso, CRM, POS | ✅ FUNCIONAL con pruebas de integración |
| Impuestos y libros IVA | ✅ FUNCIONAL |
| Migration Engine | ✅ CERRADO en V3 — regresión en verde |
| Facturación SaaS | ✅ FUNCIONAL — **y ahora la suspensión corta** |
| ARCA | 🟡 hasta homologación. Producción bloqueada por certificado **y** por KMS |
| IA / Decision Engine | 🟡 modo `none` por defecto, que es un modo de operación declarado |
| Onboarding autoservicio | 🟠 cortado en el último paso por el correo |
| Consola web | 🟡 es una consola técnica, declarado en `apps/web/README.md` |

---

## 7 · Lo que esta auditoría NO puede afirmar

- **Que NEXO funcione en producción.** No corrió en ningún servidor: no hay
  hosting. Lo que se puede afirmar es que arranca contra una base vacía que crea
  y destruye (`npm run verify:arranque`).
- **Que ARCA de producción responda.** No hay certificado de producción.
- **Que la consola sea usable por un contador no técnico.** Está declarado que
  es una consola técnica. Nadie la puso frente a un usuario final.
- **El rendimiento con carga real.** Los únicos números medidos son los del
  motor de migración (~370 filas/s) y los de `bench:vistas`.

---

## 8 · Archivos tocados

Ninguno se commiteó: el repositorio no es un árbol de git y la política es que
los commits los hace el usuario.

**Arreglos**

- `apps/api/src/planes/alcance.ts` — estado comercial separado de las
  funcionalidades; `SUSPENDIDA`/`CANCELADA` cortan.
- `apps/api/src/http/context.ts` — mensaje propio para la suspensión.
- `apps/api/src/routes/studio.ts` — `/companies/current` informa el corte.
- `apps/web/consola.html` — cartel de suspensión.
- `apps/api/src/arranque.ts` — correo y cobro en el banner.
- `.env.example` — reescrito para coincidir con el código.
- `package.json` — `npm run diario`.

**Nuevos**

- `scripts/tareas-diarias.mjs`
- `tests/security/configuracion-declarada.test.ts` (S-38)

**Controles ampliados**

- `tests/integration/prueba-y-planes.test.ts` — 7 casos (5 vistos fallando).
- `tests/integration/arranque.test.ts` — 1 caso.
