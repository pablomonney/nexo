# AUDITORÍA TOTAL DE NEXO

**Medido:** 2026-09-20, contra el árbol de trabajo, la base de desarrollo, la
suite completa y el sitio en producción.
**Método:** se corrió lo que el repositorio sabe correr y se leyó lo que declara.
Ningún número de este documento salió de la documentación anterior: todos se
volvieron a medir hoy.

> **La conclusión, en una línea.** NEXO no está roto. Está **encerrado**: casi
> todo lo que se construyó funciona y está probado, y una parte importante no
> tiene por dónde alcanzarse desde la consola. El problema de NEXO hoy no es
> calidad, es **alcance**.

---

## 0. Cómo leer este documento

Cada afirmación lleva su categoría, y no se mezclan nunca:

| | |
|---|---|
| **HECHO** | existe y está comprobado hoy |
| **PARCIAL** | existe una parte; no está cerrado |
| **PREPARADO** | el código y el esquema están; falta el otro lado |
| **PROYECTADO** | es visión; no hay código |
| **FALTANTE** | no existe |

Cuando digo «no tiene puerta» quiero decir: existe el endpoint, tiene permiso,
tiene test, y **la consola no lo nombra en ninguna línea**. El usuario no puede
llegar.

### Qué audité directamente y qué no

Para que el lector sepa cuánto pesa cada parte:

| Auditado corriéndolo | Auditado leyéndolo | **No auditado todavía** |
|---|---|---|
| suite completa (3.004 tests) | 47 controles estructurales y sus excepciones | las 38 pantallas una por una |
| **el alta y la puesta en marcha, clic a clic (§5-bis)** | las 130 migraciones y el catálogo de permisos | flujos de seguridad ejercitados a mano |
| `typecheck`, `lint:arch` | | |
| `audit:estructura` | la consola como texto (12.190 líneas) | rendimiento bajo carga |
| producción por HTTP | 78 documentos `.md` | restore real de un backup |

**Actualización del 2026-09-21:** el recorrido clic a clic **ya se hizo** y está
en la **§5-bis**. Corrige tres conclusiones de este documento, agrega dos P0 y
encuentra un punto ciego en uno de los controles del repositorio. Lo que sigue
sin auditar está en la §19.

---

## 1. Estado actual — lo que se midió hoy

| Medición | Resultado | Cómo |
|---|---|---|
| Suite completa | **3.004 pruebas, 193 archivos, 3.004 en verde, 0 rojas** | `npm test`, 123,92 s |
| Compilación | **verde** | `npm run typecheck` |
| Frontera de arquitectura | **verde**, 306 módulos, 1.037 dependencias, 0 violaciones | `npm run lint:arch` |
| Objetos de base declarados | **439 presentes, 0 faltantes** | `npm run audit:estructura` |
| Migraciones | **130 aplicadas**, sin pendientes | `node scripts/migrate.mjs status` |
| Producción | **viva**: `/` 200, `/consola` 200, `/health` 200 | `curl`, 0,7 s |
| Rutas de la API | **54 archivos de ruta** | `ls apps/api/src/routes` |
| Pantallas de la consola | **38 secciones**, 34 botones de menú en 8 grupos | `apps/web/consola.html` |
| Permisos declarados | **108** | migraciones |
| Roles | **6** | `0002_tenancy.sql` |

**Esto hay que decirlo claro:** un árbol con 3.004 pruebas en verde, frontera de
arquitectura respetada y 439 candados de base presentes no es un prototipo. La
ingeniería está.

---

## 2. Arquitectura real

Las cuatro capas existen **y están conectadas**. No es una aspiración: hay una
prueba que recorre el circuito entero usando en cada paso la cifra que dejó el
anterior, sin datos de prueba intermedios
(`tests/integration/loop-de-decision.test.ts`).

```
ERP          se factura una venta
 ↓
DATOS        la métrica del mes la refleja
 ↓
INTELLIGENCE la pregunta del catálogo la contesta con esa cifra
 ↓
DECISION     un escenario proyecta qué pasaría si el precio subiera
 ↓
ERP          alguien hace algo, y queda en la bitácora
 ↓
PUENTE       se declara que ese acto aplicó ese escenario
 ↓
MEDICIÓN     qué se esperaba, qué pasó, cuánto se separaron
```

| Capa | Dónde vive | Estado |
|---|---|---|
| **NEXO Interface** | `apps/web/consola.html` (12.190 líneas), `landing.html` | **PARCIAL** — una consola técnica de un archivo para 38 pantallas |
| **NEXO Intelligence** | `routes/intelligence.ts`, `intelligence/{catalogo,riesgos,variacion-de-margen}.ts`, `packages/ai-engine` | **PARCIAL** — determinista completo; el modelo, sin proveedor |
| **Decision Engine** | `intelligence/simulacion.ts`, `routes/analisis.ts` (14 endpoints), `routes/registro-de-decisiones.ts` | **PARCIAL** — escenarios y medición sí; optimización y causalidad no |
| **NEXO ERP** | 54 archivos de ruta | **PARCIAL** — ver §4 |

---

## 3. LO QUE MÁS IMPORTA — las funcionalidades invisibles

Esta es la sección que contesta «¿qué existe pero el usuario no puede usar?».

El repositorio tiene un control que hace exactamente esta pregunta
(**S-25 · `capacidades-con-puerta.test.ts`**). Su primera corrida encontró **47
rutas de 293** escritas, probadas, con permiso y con migración, y sin una sola
línea de la consola que las nombrara. Hoy quedan **35 excepciones declaradas**,
de las cuales **4 son legítimas** (sondas de salud, métricas, la consola misma,
el webhook de pagos).

### Quedan 31 capacidades construidas y sin puerta

#### 🔴 P0 — rompen el uso del producto

| Ruta | Qué se pierde |
|---|---|
| `POST /companies/:companyId/roles` | **Asignar un rol a una persona.** Hoy lo hace la siembra |
| `PATCH /accounts/:accountId` | **El plan de cuentas es de solo lectura en la consola.** Crear o editar una cuenta no tiene dónde apretarse; el plan entra por la siembra |
| `GET/POST /organizations` y `…/companies`, `…/users` | **No hay panel del estudio.** Crear la organización, dar de alta otra empresa, invitar a alguien: solo por API |
| `POST /auth/register-first-admin` | El arranque en frío del sistema. Hoy lo hace un script |

#### 🟠 P1 — contradicen una promesa central del producto

| Ruta | Qué se pierde |
|---|---|
| `GET /statements/trace/:lineId` | De un renglón de un estado contable a los asientos que lo forman. **La pantalla muestra las cifras y no deja abrirlas** |
| `GET /banks/trace/:matchId` | De una conciliación al movimiento y al asiento que la sostienen |
| `GET /vat/credito-fiscal/:txId` | El origen del crédito fiscal de un comprobante |
| `GET /tax-transactions/:id/lines` · `PUT …/lines` · `…/allocations` · `…/correcciones` | Ver y corregir el detalle fiscal de un comprobante |

> **Esto es grave por una razón concreta:** NEXO se presenta diciendo que *cada
> cifra se rastrea hasta su origen*. Es cierto en la API y **no es alcanzable
> desde la consola**. La capacidad que más distingue al producto es una de las
> que el usuario no puede ejercer.

#### 🟡 P2 — funciones de negocio sin pantalla

`GET/POST /parties/:id/price-lists` · `POST /parties/:id/roles` ·
`GET /products/:id/movimientos` · `PUT /purchase-requests/:id/renglones` ·
`PUT /payment-orders/:id/renglones` · `POST /documents/:id/classify` ·
`POST /commercial-documents/:id/link-invoice` ·
`POST /comprobantes/:id/decision/supersede` · `POST /party-allocations/:id/cancel` ·
`GET /checks/flujo` · `PUT /crm/stages/:id` ·
`POST /companies/current/reporting-framework` · `POST /subscription/:id/estado`

### Existe pero el usuario no sabe que existe

- **18 tablas sin escritor** (S-17), cada una con motivo documentado. Siete son
  del *Normative Update Service* (§32), que **no está construido**:
  `norm_articles`, `norm_candidates`, `norm_modifications`, `norm_references`,
  `norm_watch_sources`, `normative_conflicts`, `normative_updates`.
- `confidence_policies` — los umbrales de confianza por empresa existen en el
  esquema y **no hay endpoint** para fijarlos.
- `profit_centers` — en el esquema desde la 0003, sin ABM.
- `journals` — **duplica** el catálogo de libros; nada la referencia. Sobra.
- `system_settings`, `lineage_edges`, `bank_reconciliation_differences`,
  `document_versions`, `vat_book_lines`, `arca_access_tickets`, `audit_findings`.

---

## 4. NEXO ERP — módulo por módulo

Leyenda: 🟢 terminado · 🟡 parcial · 🟠 existe y no está expuesto · 🔴 roto ·
⚪ diseñado sin implementar.

| Módulo | Estado | Evidencia |
|---|---|---|
| Ventas / Comercial | 🟢 | pantalla `v-comercial`, `cadena-de-ventas.test.ts` |
| Compras | 🟢 | `v-solicitudes`, `v-recepciones`, `ciclo-compras.test.ts`; **renglones de solicitud sin puerta** |
| **Facturación electrónica (emisión)** | 🔴 | **`EMISION_HABILITADA = false`**, constante en código; `@aai/arca-emision` fuera del grafo. **NEXO no puede emitir una factura real hoy** |
| Clientes / Proveedores (Terceros) | 🟢 | `v-terceros`; roles de tercero y listas de precio sin puerta |
| Productos | 🟡 | `v-productos`; **movimientos por producto sin pantalla** |
| Stock / Existencias | 🟢 | `v-stock`, por depósito y lote, `valuacion.test.ts` |
| Tesorería / Caja | 🟢 | `v-caja` |
| Bancos | 🟡 | `v-bancos`, conciliación contra el Mayor; **la traza de la conciliación no se puede abrir** |
| Cheques | 🟡 | `v-cheques`; `GET /checks/flujo` sin puerta |
| Cuentas corrientes | 🟢 | imputación y antigüedad de saldos (0053) |
| Contabilidad / Asientos | 🟢 | `v-asientos`, `v-propuestas` |
| **Plan de cuentas** | 🟠 | 185 cuentas, materialización probada, **y solo lectura en la consola** |
| Mayor | 🟢 | `ledger:verify` en verde |
| Balance / Estados contables | 🟡 | `v-estados`; **sin trazabilidad abrible** |
| Información fiscal / IVA | 🟡 | `v-iva`; **Libro IVA Digital bloqueado** (diseños de registro no publicados) |
| Retenciones | ⚪ | exige decidir qué regímenes se soportan |
| Reportes / Exportaciones | 🟢 | `exports`, CSV |
| Importaciones (migración) | 🟢 | `v-migraciones`, `migration-engine` |
| Configuración empresarial | 🟡 | `v-config`; `reporting-framework` sin puerta |
| **Usuarios y roles** | 🟠 | 6 roles y 108 permisos vivos; **sin pantalla para asignarlos** |
| Multiempresa / multitenancy | 🟢 | RLS `FORCE`, `nexo_app` es `NOBYPASSRLS`, `tenant-isolation.test.ts` |
| Auditoría / bitácora | 🟢 | `v-auditoria`, cadena por hash, `audit:cadena` |
| Suscripción / billing | 🟡 | ciclo entero salvo la pasarela |

---

## 5-bis. RECORRIDO CLIC A CLIC — lo que encontré usando NEXO de verdad

**Hecho el 2026-09-21** contra la instalación local, con una cuenta nueva
(`auditoria.recorrido@ejemplo.test`), registrándome desde cero y sin tocar la
base ni la API. Esto cambia tres conclusiones de las secciones anteriores y
encuentra dos defectos que **ningún control del repositorio puede ver**.

### Primero, tres correcciones a lo que dije antes

| Dije | Es falso, y esto es lo que hay |
|---|---|
| «termina en una consola con 34 botones y sin un primer paso guiado» (§10) | **Hay un panel de puesta en marcha muy bueno.** 14 pasos con área, qué habilita cada uno, qué queda afectado si falta, cuántos hay y estado. Y **cinco** estados, no dos: `listo`, `impide trabajar`, `sin declarar`, `todavía no`, `no aplica` — este último explicando por qué no aplica |
| «el plan de cuentas entra por la siembra» (§4) | **Se carga desde la consola.** Hay un botón «Usar este plan» que materializa el plan modelo. Lo hice: **143 cuentas imputables** cargadas por un `ADMINISTRADOR` recién registrado |
| «quien se registra no puede hacer nada» (§5) | **Puede más de lo que supuse.** Materializó el plan de cuentas sin problema. El bloqueo real es otro, y está abajo |

El menú tampoco aparece con 34 botones muertos: mientras no hay empresa dice
«sin empresa» y no muestra nada. El arreglo de S-33 funciona.

### 🔴 P0-A — No se puede abrir el ejercicio desde la consola

Éste es el bloqueo real, y detiene el producto por completo.

El panel de puesta en marcha dice, correctamente:

> «Todavía falta abrir el ejercicio y tener un período abierto que contenga hoy.
> **Hasta entonces no se puede registrar nada.**»

Y manda a la pantalla *Períodos y cierre*. **Esa pantalla tiene exactamente un
control: «Actualizar».**

| | |
|---|---|
| El endpoint existe | `POST /fiscal-years` — `apps/api/src/routes/periods.ts:44` |
| La consola lo llama | **Nunca.** `grep "POST', '/fiscal-years'"` → 0 resultados |
| Qué sí hace la consola | `GET /fiscal-years` para listarlos, y cerrar / bloquear / reabrir los que ya existan |
| Consecuencia | **Una empresa nueva no puede registrar ni un asiento.** El producto se detiene en el tercer paso |

Comprobado a mano: `document.getElementById('v-cierre')` contiene un solo botón.

### 🔴 P0-B — La consola no puede editar ningún dato maestro

```
grep -c "api('PATCH'" apps/web/consola.html  →  0
```

**La consola no usa `PATCH` ni una sola vez.** Las tres rutas de edición de la
API son inalcanzables:

| Ruta | Qué no se puede arreglar |
|---|---|
| `PATCH /accounts/:accountId` | el nombre o la imputabilidad de una cuenta |
| `PATCH /parties/:partyId` | **el CUIT o la razón social de un cliente o proveedor** |
| `PATCH /products/:productId` | el código, el nombre o la unidad de un producto |

Se puede dar de alta y no se puede corregir. Para una PYME esto no es una
molestia: **un CUIT mal tipeado es un problema fiscal** y no hay pantalla donde
arreglarlo.

### 🔎 Por qué ningún control vio el P0-A — el punto ciego de S-25

Esto es lo más importante que encontré, porque explica cómo puede haber más.

S-25 decide si una capacidad tiene puerta con `tienePuerta(ruta, html)`, en
`tests/security/helpers/consola.ts`. La función recibe **la ruta y nada más**:

```ts
export function tienePuerta(ruta: string, html: string): boolean
```

**No mira el método.** Como la consola contiene `/fiscal-years` (para el `GET`),
el `POST /fiscal-years` figura con puerta aunque ningún botón lo llame. El
control que existe justamente para encontrar capacidades inalcanzables **no
distingue leer de escribir**.

Rehíce la pregunta separando por método, reconstruyendo las URL con paréntesis
balanceados como hace el propio repositorio:

| | |
|---|---|
| Llamadas de la consola reconstruidas | **270** |
| Rutas registradas | **300** (149 de escritura) |
| Escrituras que la consola nunca ejecuta | **35** |
| **De ésas, en el punto ciego de S-25** | **15** |

Las 15 están en `AUDITORIA-TOTAL-NEXO` §19. **No las declaro todas como
defectos**: calibré contra la consola viva y encontré falsos positivos — la
pantalla de Solicitudes sí tiene «Enviar a aprobar», «Aprobar», «Rechazar»,
«Anular» y «Citar la orden de compra», que mi reconstrucción no ve porque los
arma dinámicamente.

**Verificadas a mano, abriendo la pantalla:** `POST /fiscal-years`,
`PATCH /parties/:partyId`, `PATCH /products/:productId`, `POST /accounts`.

**La recomendación que sale de acá:** que `tienePuerta` reciba el método. Es un
cambio chico en un control que ya existe, y hace visible una clase entera de
defecto que hoy pasa.

### 📧 Dos hallazgos del alta que no estaban en ninguna auditoría

1. **Los correos que no salieron no se reintentan nunca.** La bandeja lo dice:
   *«NO salieron y no van a salir solos, ni siquiera si ahora hay proveedor:
   nada los reintenta. Quien se registró sigue esperando.»* Conectar Resend
   **no** destraba a quien ya se registró.
2. **Hay un alta real esperando desde el 2026-09-13:** `monneypablo@gmail.com`,
   en la bandeja, `SIN_PROVEEDOR`. El defecto ya mordió.

### 🎨 Fricciones de interfaz, vistas usando el producto

| Dónde | Qué pasa |
|---|---|
| Login | «El mismo login que usa la API. La sesión vive en la cookie que emite el servidor». **Es texto para programadores** |
| Alta | El verde dice «te mandamos un mensaje para confirmarla» y **justo debajo** el aviso dice que no se mandó. Dos mensajes opuestos juntos |
| MFA | **No hay código QR.** Solo el secreto en texto y la URI `otpauth://` cruda. Alguien no técnico no puede escanear una cadena de texto |
| MFA | El emisor dice **«Contabilidad AI»**, no NEXO. El nombre viejo del proyecto quedó en lo que el usuario ve en su teléfono |
| MFA | No dice **qué aplicación** instalar. Es la primera pregunta de cualquiera |
| Alta de empresa | «CIERRE (MM-DD)» sin explicar qué es, y los organismos como siglas sueltas (IGJ, CNV, BCRA, INAES) |

Lo bueno, y conviene decirlo: la pantalla de alta de empresa **explica los cinco
planes con precio, alcance y topes**, aclara que no se pide tarjeta y dice qué
pasa al terminar la prueba. Está bien hecha.

---

## 5. 🔴 El P0 que suponía — matizado por el recorrido

> **Leer con la §5-bis al lado.** El recorrido demostró que un `ADMINISTRADOR`
> recién registrado **sí** puede materializar el plan de cuentas. El bloqueo que
> detiene el producto es el ejercicio (P0-A), no el permiso. Lo que sigue
> describe una separación de roles que **es correcta** y una consecuencia que
> sigue abierta: nadie puede cambiar de rol sin pasar por la API.

Este hallazgo no estaba en ninguna auditoría anterior y se llega a él cruzando
tres hechos que por separado parecen correctos:

1. El alta autoservicio otorga a quien crea la empresa el rol **`ADMINISTRADOR`**
   (`routes/onboarding.ts:358`, con el comentario correcto: *«quien crea la
   empresa la administra»*).
2. `ADMINISTRADOR` **no tiene** `document:upload`, `journal_entry:create`,
   `journal_entry:approve` ni `book:emit`. Es **deliberado y correcto**: la 0011
   lo dice con todas las letras — *«Administrar el sistema no es firmar la
   contabilidad»*.
3. `POST /companies/:companyId/roles` —lo único que arreglaría el punto 2— **no
   tiene puerta en la consola**.

**Resultado:** una persona que se registra sola, paga y crea su empresa entra a
una consola donde no puede subir un documento, ni crear un asiento, ni aprobar
nada. Y **no tiene cómo darse el rol que le falta**. El circuito completo que
las pruebas recorren existe, pero el cliente que paga no puede recorrerlo.

Los tres controles dan verde porque cada pieza es correcta. El defecto vive en
la juntura — que es exactamente la forma que el propio repositorio identificó
cinco veces (S-16) y una sexta en el camino del cliente nuevo (S-33).

**Cómo comprobar que quedó cerrado:** registrarse desde cero en producción,
crear una empresa y llegar a un asiento aprobado sin tocar la base ni la API.

---

## 6. NEXO Intelligence

| Capacidad | Estado | Evidencia |
|---|---|---|
| Catálogo cerrado de preguntas | **HECHO** | `intelligence/catalogo.ts`, `/intelligence/preguntar`, pantalla `v-inteligencia` |
| Respuesta con origen y metodología | **HECHO** | cada respuesta trae valor, detalle, origen y qué no incluye |
| Panorama | **HECHO** | `/intelligence/panorama` |
| Señales y umbrales | **HECHO** | `/analysis/signals`, `/analysis/thresholds`, `v-analisis` |
| Radar de riesgos (6 frentes) | **HECHO** | `intelligence/riesgos.ts`, `/analysis/riesgos` |
| Variación de margen (precio/costo/volumen) | **HECHO** | descomposición aritmética exacta, verificada en cada respuesta |
| Agente de clasificación | **PREPARADO** | `packages/ai-engine`; **`accounting_rules` está vacía: toda propuesta cae en 🔴** |
| Agente de redacción | **PREPARADO** | `answering-agent.ts`; sin proveedor no redacta |
| Proveedor de modelo | **FALTANTE en producción** | `AI_PROVIDER=none` es el valor **por defecto** y un modo de operación |
| Umbrales de confianza por empresa | **PREPARADO** | tabla `confidence_policies` sin endpoint |
| Aprendizaje por empresa | **HECHO** | `classification_preferences`; no puede tocar la norma |
| Detección de anomalías | **HECHO** | `anomalias.test.ts`, alertas desde la 0102 |

**La frontera está bien puesta y es verificable mecánicamente:** un lint impide
que `ai-engine` importe el motor contable (probado provocando la violación), un
`CHECK` impide que un asiento con origen en IA llegue a aprobado sin aprobador
humano, y la clave foránea apunta al revés.

**Lo que falta para la cadena completa** *datos → análisis → detección →
explicación → recomendación → acción*:

| Tramo | Estado |
|---|---|
| datos → análisis | **HECHO** |
| análisis → detección | **HECHO** (señales, riesgos, anomalías) |
| detección → explicación | **PARCIAL** — la descomposición explica el margen; el resto informa sin explicar |
| explicación → recomendación | **PARCIAL** — hay recomendación en el registro de decisiones; no hay un recomendador general |
| recomendación → acción | **HECHO** — el puente escenario→acto y la medición existen |

---

## 7. Decision Engine

| Capacidad | Diseñada | Código | API | UI | Test | Producción |
|---|---|---|---|---|---|---|
| Simulación de escenarios | ✅ | `intelligence/simulacion.ts` | `POST /analysis/simulate` | ✅ `v-analisis` | ✅ | ✅ |
| Escenarios guardados | ✅ | ✅ | `POST/GET /analysis/scenarios` | ✅ | ✅ | ✅ |
| Comparar alternativas | ✅ | ✅ | `GET /analysis/scenarios/compare` | ✅ | ✅ | ✅ |
| Archivar escenario | ✅ | ✅ | `POST …/archive` | ✅ | ✅ | ✅ |
| Puente escenario → acto real | ✅ | ✅ | `POST …/applied` | ✅ | ✅ | ✅ |
| Medición esperado vs. ocurrido | ✅ | ✅ | `GET …/result` | ✅ | ✅ | ✅ |
| Registro de decisiones | ✅ | `registro-de-decisiones.ts` | ✅ | ✅ | ✅ | ✅ |
| Evidencia obligatoria + 2 alternativas | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ |
| Separación proponer/aprobar | ✅ | `CHECK` en base | ✅ | ✅ | ✅ | ✅ |
| Análisis de riesgos | ✅ | `riesgos.ts` | `GET /analysis/riesgos` | ✅ | ✅ | ✅ |
| Proyección de cobranzas | ✅ | ✅ | `GET /analysis/proyeccion-de-cobranzas` | ✅ | ✅ | ✅ |
| Flujo de fondos | ✅ | ✅ | `GET /analysis/flujo-de-fondos` | ✅ | ✅ | ✅ |
| **Optimización** | ⚪ | ❌ | ❌ | ❌ | ❌ | ❌ |
| **Causalidad** | ⚪ | ❌ *(negada a propósito)* | ❌ | ❌ | ✅ *(se prueba que NO se afirme)* | — |
| **Predicción con modelo** | ⚪ | ❌ | ❌ | ❌ | ❌ | ❌ |

**Dos precisiones honestas.** La simulación proyecta aplicando factores de
precio, volumen y costo sobre las cifras reales de la empresa: es una proyección
aritmética, **no un modelo predictivo**. Y la causalidad no es un olvido: el
sistema mide correlación y **dice explícitamente que no afirma causalidad**, con
un test que comprueba que lo diga.

---

## 8. Base de datos

| | |
|---|---|
| Migraciones | **130**, con guarda de checksum en `schema_migrations` |
| Objetos estructurales | **439 declarados y presentes** |
| Aislamiento | RLS `FORCE`; `nexo_app` es `NOBYPASSRLS`; probado por `tenant-isolation` y `vistas-rls` |
| Bitácora | encadenada por hash, íntegra (`audit:cadena`) |
| Borrado | `forbid_delete`; se corrige por contraasiento (ADR-003) |
| Aritmética | todo en `numeric`; `check:no-float` rechaza punto flotante |
| **Tablas sin escritor** | **18**, cada una con motivo (§3) |
| **Estados muertos en CHECK** | **17**, clasificados y no removidos |
| Backups | scripts `db:backup` y `db:restaurar` existen · **no agendados, restore no probado** |

---

## 9. API y backend

- **54 archivos de ruta.** Autenticación por sesión con cookie o Bearer; MFA
  obligatorio para `ADMINISTRADOR`, `CONTADOR` y `AUDITOR`.
- **Toda ruta tiene permiso declarado** (control S-18).
- Límite de intentos con 429 y `Retry-After` — **pero la ventana vive en memoria
  por proceso**: con réplicas el límite efectivo se multiplica.
- Métricas en `/metrics` detrás de token; ninguna etiqueta lleva un UUID.
- Errores en castellano, probado.
- **Contestada la pregunta que pediste:** no, no todo endpoint importante tiene
  función visible. Son 31 (§3).

---

## 10. Frontend / consola

**Lo que existe:** 38 secciones, 34 botones en 8 grupos (Inicio, Ventas,
Compras, Operación, Dinero, Libros, Análisis, Administración), permisos leídos
para esconder lo que el usuario no puede hacer, cartel explícito cuando una
suspensión esconde el menú, y migas de navegación.

**Lo que el propio repositorio declara:**

> «**No hay tests de navegación**: nadie ejercita las pantallas contra un DOM, y
> por eso un error de dibujo solo se ve abriendo la consola.»
> — `consola-contrato.test.ts`

> «La consola no es la interfaz definitiva. 316 endpoints y 35 secciones es mucho
> producto para una consola técnica de un archivo.»
> — `apps/web/README.md`, vía `NEXO_RELEASE_READINESS.md` H-3

**Sin pantalla propia, entre otras:** plan de cuentas editable, asignación de
roles, panel del estudio, trazabilidad de estados contables, movimientos por
producto, listas de precio por tercero.

**¿Una persona que nunca usó NEXO entiende qué hacer?** Con la evidencia que
tengo: **no del todo**. El camino del cliente nuevo fue auditado y reparado en
tres cortes reales (S-33), pero termina en una consola con 34 botones y sin un
primer paso guiado. Falta el recorrido clic a clic para responderlo con
autoridad: está en la §19.

---

## 11. Seguridad

| | Estado |
|---|---|
| Autenticación, sesiones | **HECHO** |
| MFA obligatorio por rol | **HECHO** (`ROLES_REQUIRING_MFA`) |
| Permisos por ruta | **HECHO**, 108 permisos, 6 roles |
| Aislamiento entre empresas | **HECHO**, RLS `FORCE` + tests |
| Inyección en datos | **HECHO**, `inyeccion-en-datos.test.ts` |
| Secretos fuera del log | **HECHO** |
| Límite de intentos | **PARCIAL** — en memoria por proceso |
| Credenciales ARCA | **HECHO** en homologación |
| **Gestor de secretos** | **FALTANTE** — un secreto *por empresa* no se puede resolver; sin esto no hay ARCA de producción multiempresa |
| **Dos módulos deciden lo contrario** | 🔴 `arca/credential-store.ts` **se niega** a usar una KEK del entorno en producción y `auth/crypto.ts` **la exige**. Las dos no pueden ser correctas |
| **Documentos en disco local** | 🔴 sin versionado ni object-lock; **no funciona con más de una réplica**. `SECURITY.md` §6 promete object storage: **hoy no es cierto** |

---

## 12. Infraestructura y producción

| Dependencia | Estado real |
|---|---|
| Hosting / dominio / HTTPS | ✅ **funcionando** — `/`, `/consola` y `/health` responden 200 |
| Base de datos | ✅ migración 130 aplicada |
| **Correo (Resend)** | ✅ **conectado y andando en producción**, medido en el servidor el 2026-09-21: banner `correo resend`, y dos altas `ENVIADO` del 17/09 al primer intento, una de ellas hasta MFA. En **local** el banner dice `correo none`, que es el modo previsto sin credencial |
| **Pasarela (Mercado Pago)** | ❌ **cerrada técnicamente, no conectada**. `intentarCobro` devuelve `SIN_PASARELA` |
| **Certificado ARCA producción** | ❌ trámite del contribuyente; hoy anda homologación |
| **Gestor de secretos** | ❌ sin contratar |
| Backups | ⚠️ scripts sí, agendado no, restore no probado |
| Observabilidad | ⚠️ `/metrics` sí; alertas no |
| Escalado horizontal | ❌ métricas y límite de intentos viven en memoria por proceso |

**Cuatro de estos no se resuelven escribiendo código:** son contratar algo o un
trámite. Es la conclusión que ya traía `NEXO_RELEASE_READINESS.md` y que sigue
valiendo doce días después.

---

## 13. Testing

**Lo bueno, y es mucho:** 3.004 pruebas en verde, 193 archivos, integración real
contra base, 47 controles estructurales que persiguen defectos de *juntura* y no
de unidad, y varios que **provocan la violación a propósito** para comprobar que
el control la ve.

**Los huecos:**

| Hueco | Consecuencia |
|---|---|
| **Sin tests de navegación / DOM** | un error de dibujo solo se ve abriendo la consola |
| **Sin E2E de navegador** | el camino del cliente nuevo se prueba por HTTP y por texto del HTML, no clicando |
| Dos series `S-*` se pisan | declarado en `TESTING_STRATEGY` §2.7 |
| Cobertura no medida hoy | `test:coverage` no se corrió en esta auditoría |

---

## 14. Documentación

**78 archivos `.md`** (40 en `docs/`, 38 en la raíz) + 11 ADR. Hay un control que
comprueba que la documentación no nombre cosas que no existen
(`documentacion-veraz.test.ts`, en verde).

**Pero está desactualizada, y se puede probar:**

| Documento | Fecha | Dice | Hoy |
|---|---|---|---|
| `PROJECT_STATUS.md` | 2026-09-03 | 118 archivos, **1.891 tests**, **422 objetos** | 193 archivos, **3.004 tests**, **439 objetos** |
| `NEXO_CURRENT_BASELINE.md` | 2026-09-08 | censo de ese día | 12 días de cambios sin reflejar |
| `NEXO_RELEASE_READINESS.md` | 2026-09-08 | hosting como bloqueante | **hosting ya está resuelto** |
| `SECURITY.md` §6 | — | promete object storage | **contradice al código** |

**Contradicción con el código:** `SECURITY.md` §6 promete almacenamiento de
objetos y lo que hay es disco local sin versionado.

---

## 15. Matriz maestra

| # | Área | Estado | Evidencia | Falta | Prioridad | Cómo cerrar |
|---|---|---|---|---|---|---|
| **0a** | **Abrir el ejercicio desde la consola** | 🔴 | §5-bis, verificado a mano | un botón que llame a `POST /fiscal-years` | **P0** | empresa nueva que llega a un asiento sin tocar base ni API |
| **0b** | **Editar datos maestros** | 🔴 | §5-bis, `api('PATCH'` → 0 | 3 pantallas de edición | **P0** | corregir el CUIT de un cliente desde la consola |
| **0c** | **`tienePuerta` ignora el método** | 🔴 | §5-bis | pasarle el método | **P0** | el control falla con `POST /fiscal-years` antes de arreglarlo |
| 1 | Cambiar de rol sin API | 🟠 | §5 | pantalla de roles | **P1** | asignar CONTADOR desde la consola |
| 2 | Alta y edición de cuenta sueltas | 🟠 | S-25 | pantalla ABM | **P1** | crear una cuenta nueva desde la consola |
| 3 | Emisión fiscal real | 🔴 | `puerta.ts:33` | `FECompConsultar` + certificado + habilitar | **P0** | emitir en homologación y reconciliar una emisión en duda |
| 4 | Correo | ❌ | `docs/CORREO_RESEND.md` | contratar Resend | **P0** | alta autoservicio que se completa sola |
| 5 | Pasarela | ❌ | `NEXO_MERCADO_PAGO_STATUS.md` | contratar MP | **P0** | un cobro real de punta a punta |
| 6 | Panel del estudio | 🟠 | S-25 | 4 pantallas | **P1** | crear organización, empresa e invitar sin API |
| 7 | Trazabilidad abrible | 🟠 | S-25 | abrir cifra → asientos | **P1** | clic en un renglón del balance hasta el comprobante |
| 8 | KEK contradictoria | 🔴 | H-2 | decidir cuál manda | **P1** | un solo criterio, con test |
| 9 | Documentos en object storage | 🔴 | H-1 | contratar + implementar | **P1** | dos réplicas sirviendo el mismo documento |
| 10 | Tests de navegación | ❌ | §13 | suite de DOM/E2E | **P1** | un error de dibujo que falle en CI |
| 11 | Backups agendados y probados | ⚠️ | §12 | agendar + restore | **P1** | restaurar en limpio y correr `verify` |
| 12 | Límite de intentos compartido | 🟡 | §11 | mover a la base | **P1** | dos réplicas con un solo límite |
| 13 | Gestor de secretos | ❌ | §11 | contratar | **P1** | una credencial ARCA por empresa |
| 14 | Detalle fiscal con pantalla | 🟠 | S-25 | 4 rutas | **P2** | corregir una imputación desde la consola |
| 15 | Listas de precio por tercero | 🟠 | S-25 | pantalla | **P2** | asignar una lista sin API |
| 16 | Movimientos por producto | 🟠 | S-25 | pantalla | **P2** | ver el kárdex de un producto |
| 17 | Umbrales de confianza | 🟡 | `confidence_policies` | endpoint + pantalla | **P2** | fijar un umbral por empresa |
| 18 | Retenciones | ⚪ | RISKS | decidir regímenes | **P2** | una retención calculada y contabilizada |
| 19 | Libro IVA Digital | ⚪ | RISKS | diseños no publicados | **P2** | bloqueado por el organismo |
| 20 | Proveedor de IA + reglas | 🟡 | §6 | contratar + cargar reglas | **P2** | una propuesta que llegue a 🟢 |
| 21 | Normative Update Service | ⚪ | 7 tablas vacías | construir | **P3** | una norma detectada y activada |
| 22 | Optimización | ⚪ | §7 | construir | **P3** | el sistema propone la mejor alternativa |
| 23 | `journals` duplicada | 🟡 | S-17 | migración de baja | **P3** | la tabla ya no está |
| 24 | Documentación al día | 🟡 | §14 | actualizar 4 docs | **P2** | los números coinciden con la medición |
| 25 | NEXO no lleva su contabilidad | ❌ | H-6 | operar NEXO en NEXO | **P2** | CAC, LTV y margen por plan medidos |

---

## 16. Roadmap de cierre

El detalle va a un documento aparte cuando se escriba. El orden, que sale de
las dependencias y no de la comodidad:

1. **FASE 1 — Que una empresa nueva pueda trabajar.** Ítems 1 y 2. Sin esto
   nada más importa: el producto no se puede usar recién comprado.
2. **FASE 2 — Que se pueda vender sola.** Ítems 4 y 5 (correo y pasarela). No
   es código: es contratar.
3. **FASE 3 — Que se pueda ver lo que ya se calcula.** Ítems 6, 7, 14, 15, 16.
4. **FASE 4 — Producción seria.** Ítems 8, 9, 11, 12, 13.
5. **FASE 5 — Emisión fiscal real.** Ítem 3.
6. **FASE 6 — Inteligencia con modelo.** Ítems 17, 20.
7. **FASE 7 — Decision Engine avanzado.** Ítems 22, 21.
8. **FASE 8 — Producto comercial.** Ítems 24, 25, manual y videos.

**Por qué este orden y no el que pediste.** Pusiste «cerrar fundamentos» primero
y experiencia de usuario segundo. La auditoría dice que el fundamento técnico ya
está cerrado —3.004 pruebas en verde— y que lo que está roto es **el acceso**.
Por eso la FASE 1 no es técnica: es dar la puerta que falta.

---

## 17. Recomendaciones

1. **Antes que cualquier otra cosa, cerrá el ítem 1.** Hoy alguien puede pagar
   NEXO y no poder usarlo. Es el único defecto de esta auditoría que convierte
   una venta en un problema.
2. **Tratá la consola como producto, no como herramienta.** 31 capacidades sin
   puerta no es una lista de tareas de frontend: es un tercio del producto que
   no existe para quien paga.
3. **No habilites la emisión fiscal por apuro.** La puerta doble está bien
   puesta y las siete funciones sin consumidor son la consecuencia correcta de
   haber escrito la seguridad antes que el camino.
4. **Corregí la contradicción de la KEK antes de tocar producción.** Dos módulos
   con criterios opuestos sobre la misma amenaza es el tipo de defecto que se
   descubre tarde y caro.
5. **Poné un control que impida que la documentación envejezca en silencio.**
   Existe el control de que no mienta; falta el de que esté al día.
6. **Actualizá el one-pager de la UCA.** Dice «facturación electrónica con CAE»
   entre lo que hace hoy, y la emisión está cerrada. Ver §18.

---

## 18. ⚠️ Corrección que afecta al entregable ya enviado

El one-pager entregado hoy lista **«facturación electrónica con CAE»** dentro de
la capa ERP, en la sección de lo que NEXO hace hoy.

**Eso es discutible y conviene ajustarlo.** El sistema registra comprobantes con
su CAE y opera contra ARCA en homologación, pero **no puede emitir**:
`EMISION_HABILITADA` es `false` y el transporte está fuera del grafo de la
aplicación. Un jurado que pregunte «¿puedo facturar hoy con NEXO?» recibiría un
«no todavía».

Es la única afirmación del entregable que esta auditoría pone en duda. Todas las
demás —las cuatro capas, el circuito probado, las cifras— quedaron confirmadas.

---

## 19. Decisiones que tenés que tomar vos

Ninguna de estas la puedo tomar yo, y todas bloquean trabajo:

| # | Decisión | Por qué no la puedo tomar |
|---|---|---|
| 1 | **¿Quién crea la empresa recibe un rol operativo, o se hace una pantalla de roles?** | Es política de producto y de separación de funciones, no técnica |
| 2 | **¿Se contrata Resend y Mercado Pago?** | Es plata y es tu cuenta |
| 3 | **¿Qué regímenes de retención soporta NEXO?** | Define el alcance fiscal del producto |
| 4 | **¿Se contrata proveedor de IA, o NEXO queda determinista?** | Afecta el secreto profesional de los estudios |
| 5 | **¿La consola se rehace o se extiende?** | Es semanas de trabajo en cualquier dirección |
| 6 | **¿Dónde viven los datos?** (jurisdicción del hosting) | Son datos contables de terceros |
| 7 | **¿`journals` y `profit_centers` se implementan o se dan de baja?** | Es alcance |
| 8 | **¿Se construye el Normative Update Service?** | Es un producto adentro del producto |

### Y lo que falta auditar

Para cerrar esta auditoría al 100 % falta lo que no se puede hacer leyendo:

- **recorrer las 38 pantallas clic a clic** con una empresa nueva y sin permisos
  de siembra;
- **ejercitar los flujos de seguridad a mano** (sesión expirada, permiso
  revocado en caliente, dos pestañas);
- **probar un restore real** de un backup;
- **medir cobertura** (`npm run test:coverage`);
- **verificar producción con una cuenta de verdad**, no solo por `curl`.

Digo esto en vez de dar por buena la parte que no miré.
