# Decisión técnica — los 12 videos restantes

2026-10-01. Auditoría determinística, sin ejecutar ninguna acción. No se
creó ningún ejercicio, no se abrió ningún período, no se creó ninguna
empresa, no se creó ningún sandbox, no se generó ningún video, no se
modificó código de producción, no se hizo commit ni push. Todas las
consultas contra la aplicación real fueron de **solo lectura** (`GET`,
o consultas `SELECT` directas de solo-lectura a Postgres para verificar
el estado de bases de datos). Donde el texto cita un endpoint de
escritura, es una descripción de lo que haría — no se invocó.

---

## 1. Estado actual

| Eje | Valor |
|---|---|
| `VIDEO_FINAL` | 14 — 01, 02, 03, 09, 13, 20, 21, 22, 24, 25, 26, 28, 29, 30 |
| `GUION_VERIFICADO` | 12 — 06, 07, 08, 10, 11, 12, 14, 15, 16, 17, 18, 31 |
| `EVIDENCIA_INSUFICIENTE` | 2 — 04, 05 (fuera del alcance de este informe) |
| `SALTADO_NO_PRODUCIDO` | 3 — 19, 23, 27 |
| **Total** | **31** |

Confirmado en vivo ahora mismo (`GET /fiscal-years`, `GET /periods`,
`GET /fiscal-years/.../closure`):

```
GET /fiscal-years  →  [{ code: "2026", status: "CERRADO", periodCount: 12 }]
GET /periods       →  12/12 en status "CERRADO"
GET /fiscal-years/.../closure  →  status: "COMPLETADO"
```

No existe ningún ejercicio 2027 ni ningún otro. No hay ningún período
`ABIERTO` en ninguna empresa de este entorno (`aai`, 8 empresas, ninguna
con un período abierto).

---

## 2. Problema raíz — **corregido respecto a la premisa de partida**

La premisa con la que arrancó este encargo —que los 12 videos están
bloqueados porque el ejercicio 2026 está cerrado— **es correcta para
exactamente 1 de los 12 videos, no para los 12**. Esto no es una
opinión: es el resultado de leer cada ruta que cada video usa y de
consultar, de solo lectura, el estado real de la empresa del curso.

### 2.1 El candado real es mucho más angosto de lo que parecía

El único candado que existe en todo el backend es un trigger de base de
datos, `je_fiscal_year_guard` (migración `0038`), que se dispara **antes
de cualquier `INSERT` o `UPDATE` en la tabla `journal_entries`** y
rechaza la operación si el ejercicio de esa fila no está `ABIERTO` (o
`EN_CIERRE`, para los asientos del propio cierre):

```sql
-- infrastructure/db/migrations/0038_cierre_de_ejercicio.sql, línea 230
CREATE OR REPLACE FUNCTION assert_fiscal_year_admite_asiento() ...
  IF estado = 'CERRADO' THEN
    RAISE EXCEPTION 'E_PERIOD_CLOSED: el ejercicio % está CERRADO ...'
  ...
CREATE TRIGGER je_fiscal_year_guard
  BEFORE INSERT OR UPDATE ON journal_entries
  FOR EACH ROW EXECUTE FUNCTION assert_fiscal_year_admite_asiento();
```

Se hizo un `grep` de `INSERT INTO journal_entries` en **todo**
`apps/api/src`. Solo existen tres lugares:

| Archivo | Para qué |
|---|---|
| `routes/journal-entries.ts` (líneas 179 y 372) | Cargar un asiento manual (borrador/propuesta) y el contraasiento (`REVERSION`) |
| `routes/closures.ts` (`postearAsientoDeCierre`, 3 usos) | Refundición, Cierre y Apertura del ejercicio |
| `migracion/escritores.ts` | Migraciones de datos históricos (no aplica a ningún video de este lote) |

**Ningún otro archivo de rutas inserta en `journal_entries`.** Se
verificó explícitamente, archivo por archivo, que estas rutas **no**
tienen ninguna referencia a `journal_entries`:

- `comprobantes.ts` (registrar un comprobante — video 10)
- `comercial.ts` (pedido → emitir → aceptar → facturar — videos 11, 12)
- `recepciones.ts` (confirmar recepción de compra — video 12)
- `ordenes-de-pago.ts` (armar y aprobar una orden de pago — video 12)
- `recuentos.ts` (abrir/cerrar un recuento físico — videos 06, 14)
- `stock.ts` (confirmar salida de stock, ajustes, transferencias — video 14)

El comentario del propio código de `recuentos.ts` lo dice en estas
palabras: *"**No se generó ningún asiento**: un faltante de inventario
tiene consecuencia contable y ese asiento lo firma una persona, por el
camino de siempre."* Y tanto `comprobantes.ts` como `comercial.ts`
sí consultan la tabla `periods` antes de registrar una operación fiscal
— pero la consulta (línea 201-204 de `comprobantes.ts`, línea 446-449
de `comercial.ts`) es:

```sql
SELECT id, status FROM periods
 WHERE company_id = $1 AND $2::date BETWEEN start_date AND end_date
```

**No filtra por `status`.** Exige que exista una fila de período que
cubra esa fecha — `CERRADO` cuenta igual que `ABIERTO` — y nunca vuelve
a mirar `status` después de traerlo. Es decir: **registrar un
comprobante o facturar un pedido no requiere un período abierto, solo
requiere que el período exista.** Los 12 períodos de 2026 existen (están
cerrados, pero existen), así que esta operación no está bloqueada hoy.

### 2.2 Lo que la evidencia real de la empresa confirma

No alcanza con leer el código: hay que comprobar si esto ya se ejecutó
de verdad contra la empresa del curso, antes de que el ejercicio se
cerrara. Se consultó en vivo (`GET`, solo lectura) y la respuesta es
que **sí, para casi todos los videos, el flujo completo ya se ejecutó
de verdad** — es exactamente lo que exige la etiqueta `GUION_VERIFICADO`
("confirmado contra la aplicación real... con evidencia documentada").
Lo que falta no es poder ejecutar el flujo: es **la producción
audiovisual** (narración + capturas + ensamblado), el mismo trabajo ya
hecho para los otros 14 videos — once de los cuales (25, 26, 28, 29, 30,
y antes 09, 13, 20, 21, 22, 24) se filmaron **mostrando pantallas reales
ya existentes, narradas**, no clics en vivo sincronizados con el audio.

| Video | ¿Ya existe el dato real que el guion necesita mostrar? | Evidencia verificada ahora mismo |
|---|---|---|
| 06 · Productos | Sí — los 3 productos, el depósito y el recuento de 10 cajas ya existen | `GET /products` → PROD-001/002/003 `ACTIVO`; `GET /warehouses` → DEP-01 |
| 10 · Comprobantes | Sí — el comprobante del documento del video 09 ya está registrado | `GET /tax-transactions` → operación VENTAS, documentId del video 09 |
| 11 · Ventas | Sí — el pedido a Maderera San Martín ya está `FACTURADO` | `GET /commercial-documents` → pedido VENTAS #1, neto 3.700,00 (2 cajas × $1.850), `status: "FACTURADO"` |
| 12 · Compras | Sí — el pedido a Ferrolux ya está `FACTURADO` y la orden de pago ya está `PAGADA` | `GET /commercial-documents` → pedido COMPRAS #1, neto 1.420.000,00 (50 baldes × $28.400); `GET /payment-orders` → orden #1, `estado: "PAGADA"` |
| 14 · Existencias | Sí — la salida de stock de la venta y el recuento con diferencia ya se hicieron | `GET /tax-transactions/.../salida-sugerida` → `yaRegistrada: true`; `GET /stock` → PROD-001 en 6 cajas (10 − 2 vendidas − 2 de ajuste de recuento) |
| 15 · Asientos | Sí — el asiento de la venta del video 10 ya está `APROBADO`, con sus 3 renglones | `GET /journal-entries` → "Venta 1-5", `status: "APROBADO"`, debe/haber 12.100,00 |
| 16 · Asientos manuales y contraasientos | Sí — el asiento manual del pago a Ferrolux, la orden `PAGADA`, y un contraasiento real ya existen | `GET /journal-entries` → asiento #2 "Pago a Distribuidora Ferrolux..." `APROBADO`; asiento #3 `REVERSION` `APROBADO` anulando un asiento de prueba; `GET /payment-orders` → `estado: "PAGADA"`, `asientoId` presente |
| 18 · Bienes de uso | Parcial — el bien, el plan y un asiento de amortización `APROBADO` ya existen, pero con una inconsistencia real (ver 2.3) | `GET /fixed-assets/...` → BU-01, `status: "BAJA"`; plan 2026 con `entryId` ya cargado pero `amortizacion: "0.00"` |
| 31 · Circuito completo | Sí — el documento, comprobante, asiento `APROBADO` y su reflejo en Mayor/Balance ya existen | `GET /journal-entries` → "Venta 1-6", fecha 2026-09-30, `status: "APROBADO"`, debe/haber 24.200,00 (coincide exacto con la nota de producción del guion) |
| 07 · Usuarios y permisos | No aplica (no es un dato a "mostrar ya hecho": el guion pide un alta en vivo, y la persona de prueba ya fue usada) | `GET /companies/current/users` → Julián Ferreyra ya tiene `CONTADOR` |
| 08 · Certificado ARCA | No verificado en esta pasada (fuera del árbol de `journal_entries`, no depende del período) | — |
| 17 · Períodos y cierre | **No** — el tramo que falta no tiene ningún estado real que mostrar | Ver 2.4 |

### 2.3 La única inconsistencia real encontrada (video 18)

El bien `BU-01` tiene un asiento de amortización `APROBADO` y vinculado
(`entryId` presente en el plan), pero el valor que la aplicación
recalcula hoy para "amortización del ejercicio 2026" es `0.00` (porque
el bien se dio de baja un día después de darse de alta — `meses: 0` en
el plan recalculado), mientras que el asiento vinculado es por
$425.000,00. Es una discrepancia real de los datos de esta empresa de
demostración, no un bug de la auditoría ni algo para corregir en código:
probablemente el vínculo se hizo *antes* de la baja, cuando el cálculo
todavía daba $425.000, y la baja posterior recalculó el plan sin romper
el vínculo ya hecho. **Para producir el video 18 mostrando esta pantalla
tal cual, un espectador atento vería un plan que dice "$0,00" al lado de
un asiento vinculado por $425.000** — no es prohibitivo, pero sí amerita
una nota de producción explícita (igual que las ya escritas para
videos 06, 07, 12, 17, 18 en `14-guiones-definitivos.md`), no silenciarlo.

### 2.4 El único bloqueo real: el tramo faltante del video 17

El video 17 ya grabó (contra la API real, con autorización explícita
caso por caso) el bloqueo/pre-cierre/cierre/refundición del ejercicio
2026 — eso está hecho y es irreversible. Lo único que falta son dos
demostraciones puntuales que **no tienen ningún estado real existente
que mostrar**, porque nunca se llegaron a ejecutar:

1. **Bloquear un período → intentar reabrirlo (mostrar la contrafirma).**
   Requiere un período en estado `ABIERTO` o `BLOQUEADO` — hoy los 12
   períodos de 2026 están `CERRADO`, y `CERRADO` no tiene reapertura
   (confirmado: no existe ningún endpoint de reapertura de ejercicio,
   solo de período, y solo antes de `CERRADO`).
2. **"Asiento de apertura" del ejercicio siguiente.** Requiere que
   exista un ejercicio nuevo con status `ABIERTO` — hoy no existe
   ninguno.

Este es el **único** punto de los 12 videos que genuinamente necesita
un cambio de entorno (abrir un período en algún lado). No necesita ser
en la empresa del curso, ni necesita el dataset del curso: el bloqueo/
reapertura/apertura es una demostración de mecánica de períodos,
genérica, independiente de qué empresa la muestre.

---

## 3. Matriz de los 12 videos

| Video | Flujo | ¿Requiere `journal_entries` nuevo? | Dato real ya existente para mostrar | Dato faltante | Bloqueo real | Solución necesaria | Riesgo |
|---|---|---|---|---|---|---|---|
| 06 · Productos | Alta de 3 productos + depósito + recuento inicial | No | Sí — productos, depósito y recuento ya existen | Nada técnico; el guion narra una "alta" que ya no se puede repetir con esos códigos | Dato ya consumido en esta empresa (no el período) | Producir con el mismo método que 25/26/28/29/30: capturas reales del estado ya existente, narradas | Bajo — mismo método ya validado 5 veces |
| 07 · Usuarios y permisos | Alta de persona en el estudio + rol | No | No — necesita una persona nueva | Un correo/nombre nunca usado | Dato ya consumido (Julián ya tiene rol) | Alta de UNA persona nueva (acción aditiva, reversible en los hechos — no hay botón de baja pero tampoco rompe nada existente) | Bajo |
| 08 · Certificado ARCA | Cargar certificado de homologación | No | No verificado si ya hay uno cargado | Confirmar si se puede resubir o hace falta uno nuevo | Posible dato ya consumido | Verificar `GET /companies/current` (lee el certificado actual) antes de filmar | Bajo |
| 10 · Comprobantes | Registrar comprobante de un documento ya `EXTRAIDO` | No (confirmado: `comprobantes.ts` no toca `journal_entries`, y la consulta de período no filtra `status`) | Sí — el comprobante del video 09 ya está registrado | Nada | Ninguno | Producir con capturas del estado ya existente | Bajo |
| 11 · Ventas | Pedido → emitir → aceptar → facturar | No (`comercial.ts`, mismo patrón) | Sí — pedido a Maderera ya `FACTURADO`, importes exactos del guion | Nada | Ninguno | Capturas del estado ya existente | Bajo |
| 12 · Compras | Solicitud → pedido COMPRAS → recepción → facturar → orden de pago | No (`recepciones.ts`, `ordenes-de-pago.ts`, `comercial.ts`: ninguno toca `journal_entries`) | Sí — pedido a Ferrolux `FACTURADO`, orden de pago `PAGADA` | Nada | Ninguno | Capturas del estado ya existente | Bajo |
| 14 · Existencias | Confirmar salida de stock + recuento físico | No (`stock.ts`, `recuentos.ts`: sin `journal_entries`) | Sí — salida ya confirmada (`yaRegistrada: true`), recuento con diferencia ya cerrado, stock en 6 cajas | Nada | Ninguno (dependía de 11, que ya está hecho) | Capturas del estado ya existente | Bajo |
| 15 · Asientos | Ver propuesta → cargar borrador → aprobar | **Si se repite en vivo, sí** (`journal-entries.ts`) — pero el resultado ya existe | Sí — asiento "Venta 1-5" ya `APROBADO`, 3 renglones | El paso "Ver la propuesta" en vivo podría no ser re-exhibible igual (riesgo menor, no verificado) | Ninguno para el resultado; riesgo leve en el paso intermedio | Capturas del asiento y Mayor ya existentes; si "Ver la propuesta" no se puede re-mostrar en vivo, narrar sobre el resultado final igual que el resto | Bajo-medio |
| 16 · Asientos manuales y contraasientos | Asiento manual con tercero → imputar → pagar → contraasiento de otro | **Si se repite en vivo, sí** — pero el resultado ya existe | Sí — asiento manual `APROBADO`, orden `PAGADA`, Y un contraasiento real ya ejecutado (`REVERSION` `APROBADO`) | Nada | Ninguno | Capturas del estado ya existente | Bajo |
| 17 · Períodos y cierre | Bloquear/reabrir período (contrafirma) + asiento de apertura | **Sí, inevitable** — no hay ningún estado existente que mostrar | — | Un período `ABIERTO` o `BLOQUEADO` en algún lado | **El único bloqueo real de los 12** | Opción A, B o C (sección 4) | Depende de la opción elegida |
| 18 · Bienes de uso | Alta de bien + plan + asiento de depreciación vinculado | **Si se repite en vivo, sí** — pero el resultado ya existe, con una inconsistencia real documentada (2.3) | Parcial — bien, plan y asiento `APROBADO` existen; el bien ya está `BAJA` | Nada técnico; nota de producción sobre la inconsistencia $0 vs $425.000 | Ninguno (editorial, no técnico) | Capturas + nota de producción explícita sobre la inconsistencia | Medio (reputacional si se muestra sin explicar) |
| 31 · Circuito completo | Documento → comprobante → propuesta → asiento → Mayor → Balance | **Si se repite en vivo, sí** — pero el resultado ya existe íntegro | Sí — comprobante, asiento `APROBADO` (24.200,00), ya verificado contra Mayor y Balance | Nada | Ninguno | Capturas del circuito ya ejecutado | Bajo |

**Lectura de la matriz:** de los 12 videos, **1 (el 17)** tiene un
bloqueo real de entorno. Los otros **11** no necesitan ningún cambio de
entorno — necesitan aplicar la misma producción audiovisual
(Piper TTS + capturas reales + ffmpeg) ya usada con éxito en los 14
videos que hoy son `VIDEO_FINAL`, once de los cuales (25, 26, 28, 29,
30 y el resto del lote) ya se hicieron exactamente así: narrando sobre
pantallas de datos reales y ya existentes, no sobre clics en vivo
sincronizados.

---

## 4. Auditoría de las tres alternativas (para el video 17, el único que las necesita)

### OPCIÓN A — Abrir el ejercicio 2027 en la empresa actual

1. **Tablas que modifica:** `fiscal_years` (1 INSERT), `periods` (12
   INSERT, vía `generateMonthlyPeriods: true` en la misma llamada),
   `journal_entries` (1 INSERT, el asiento de apertura), `audit_log` (2
   registros: `CREAR_EJERCICIO`, `ABRIR_EJERCICIO`), `accounting_closures`
   (`UPDATE` para registrar `apertura_entry_id`).
2. **Endpoints:** `POST /fiscal-years` (crea 2027 + sus 12 períodos en
   una sola llamada, `generateMonthlyPeriods` por defecto `true`) y
   `POST /fiscal-years/:fiscalYearId2026/opening` (con
   `siguienteEjercicioId` = el id de 2027 recién creado).
3. **Permisos:** `period:write` (para crear el ejercicio) y
   `fiscal_year:close` (para la apertura). Mariana Sosa ya tiene ambos
   — confirmado en vivo, `GET /companies/current/users` lista sus roles
   `ADMINISTRADOR` + `CONTADOR`, y ambos están otorgados a esos códigos
   en las migraciones `0011` y `0038`.
4. **Datos del curso que conserva:** todos — terceros, productos, mapeo
   contable (8/8), certificado ARCA, plan `NEXO Completo` activo,
   proyectos/sucursales/comisiones, y los 25 videos con evidencia ya
   citada por UUID.
5. **Datos del curso que pierde:** ninguno. El trigger `je_fiscal_year_guard`
   no permite tocar nada de un ejercicio `CERRADO`; `fiscal_years` está
   particionado por `company_id` y por rango de fechas sin solape
   (`fiscal_years_no_overlap`), así que 2027 es una fila nueva que no
   puede pisar a 2026.
6. **¿Reproduce el dataset que cada video necesita?** Para el video 17:
   sí, exactamente lo que falta (período `ABIERTO`, bloqueo/reapertura,
   apertura). Para los otros 11 videos: no hace falta, porque ya están
   resueltos sin tocar el entorno (sección 3) — abrir 2027 no les
   aporta ni les quita nada a esos 11.
7. **¿Afecta 2026?** No. Es una fila nueva (`fiscal_years`, `periods`),
   nunca un `UPDATE` sobre las filas de 2026.
8. **¿Afecta los 14 `VIDEO_FINAL`?** No. Son archivos de video ya
   exportados (`scratchpad/produccion/MASTER/*.mp4`), artefactos
   congelados que no dependen de que la base de datos siga en el mismo
   estado.
9. **¿Afecta auditoría?** Suma dos registros nuevos (`CREAR_EJERCICIO`,
   `ABRIR_EJERCICIO`) a `audit_log`, que es append-only por diseño — no
   reescribe nada existente.
10. **¿Afecta saldos contables?** Sí, pero del modo correcto y
    documentado: `planificarApertura` traslada a 2027 los saldos
    patrimoniales de cierre de 2026 (Deudores, Proveedores, Bancos),
    **no** los de resultado (que arrancan en cero). No es una empresa
    "vacía": arrastra historia real, que para algunos videos es incluso
    más realista.
11. **¿Afecta comprobantes?** No directamente — la apertura no toca
    `tax_transactions`.
12. **¿Afecta usuarios/roles?** No.
13. **¿Afecta terceros/productos?** No.
14. **¿Requiere fixtures?** No.
15. **¿Requiere migraciones?** No — el esquema ya soporta esto desde la
    migración `0038`.
16. **¿Requiere código nuevo?** No.
17. **¿Es reversible?** La creación del ejercicio 2027 en sí (sin
    asientos) sería revertible con un `DELETE` manual si no se llegó a
    usar — pero una vez posteado el asiento de apertura, **no**: el
    cierre/apertura es, por diseño, irreversible (no existe endpoint de
    reapertura de ejercicio, solo de período, y solo antes de
    `CERRADO`). El propio guion del video 17 lo dice: *"una vez cerrado,
    no hay forma de deshacerlo para repetir la toma."*
18. **Cómo se haría el rollback:** si se detecta un problema **antes**
    de postear el asiento de apertura, se podría borrar manualmente la
    fila de `fiscal_years` 2027 y sus 12 períodos (sin ningún asiento
    que dependa de ellos). **Después** de postear la apertura, no hay
    rollback de base de datos — la única corrección posible es contable
    hacia adelante (un ajuste), no un deshacer.
19. **Evidencia de no contaminación:** `GET /fiscal-years` después de la
    operación debería seguir devolviendo 2026 con el mismo `status:
    "CERRADO"` y las mismas 12 filas de período en `CERRADO`; un
    `diff` de los saldos de cierre de 2026 (ya citados por UUID en el
    guion del video 17) contra los mismos datos leídos otra vez después
    de abrir 2027 debería dar exactamente igual.

### OPCIÓN B — Crear una empresa nueva de producción

1. **Tablas que modifica:** `companies` (1 INSERT, vía `create_company`,
   `SECURITY DEFINER`), y después, según qué se construya:
   `user_company_roles` (`grant_company_role`), `accounts` (185 filas
   del plan de cuentas), `fiscal_years`/`periods`, `account_mappings`,
   `parties`, `products`, `warehouses`, `fixed_assets`,
   `arca_certificates`, `company_subscriptions`.
2. **Endpoints:** `POST /organizations/:organizationId/companies`
   (crea la empresa — body: razón social, CUIT, tipo de entidad,
   jurisdicción, cierre de ejercicio) y, aparte,
   `grant_company_role` (vía la ruta de roles de empresa) para que
   quien la creó pueda entrar — **`create_company` no otorga ningún rol
   automáticamente** (confirmado leyendo la función SQL, migración
   `0013`: solo hace el `INSERT` en `companies`).
3. **Permisos:** `organization_level(actor, organizationId)` tiene que
   ser `OWNER` o `ADMIN` — verificado en vivo
   (`GET /companies/current/users` → `canManageOrganization: true` para
   Mariana Sosa sobre "Estudio Demo NEXO"). Ningún otro rol ni permiso
   de empresa sirve para este paso.
4. **Datos del curso que conserva:** todos, intactos, en la empresa
   vieja — Opción B no la toca para nada.
5. **Datos del curso que pierde:** ninguno de la empresa vieja. La
   empresa **nueva** nace completamente vacía — ni un plan de cuentas.
6. **¿Reproduce el dataset exacto de cada video?** No automáticamente.
   `create_company()` solo inserta la fila de `companies` — cero plan de
   cuentas, cero mapeo, cero terceros, cero productos, cero ejercicio.
   Todo lo demás hay que construirlo, llamada por llamada, contra la
   empresa nueva.
7. **¿Afecta 2026?** No.
8. **¿Afecta los 14 `VIDEO_FINAL`?** No — son de otra empresa (`company_id`
   distinto) y la política RLS por `company_id` hace que ni siquiera
   sean visibles desde la empresa nueva.
9. **¿Afecta auditoría?** Suma un `audit_log` nuevo para la empresa
   nueva; no toca el de la vieja.
10. **¿Afecta saldos contables?** La empresa nueva arranca en cero —
    "limpia" en el sentido literal, sin ningún saldo arrastrado (a
    diferencia de la Opción A).
11. **¿Afecta comprobantes?** No a los existentes.
12. **¿Afecta usuarios/roles?** Hay que volver a otorgar roles
    (`grant_company_role`) para la empresa nueva — Mariana no tiene
    ningún rol ahí hasta que alguien se lo dé.
13. **¿Afecta terceros/productos?** Hay que recrearlos desde cero —
    ninguno se puede copiar automáticamente de la empresa vieja (no
    existe ningún endpoint de "clonar empresa").
14. **¿Requiere fixtures?** Si se quiere automatizar, sí — pero ya
    existe una plantilla de código real y auditada:
    `scripts/factura-demo.mjs` (`npm run factura:demo`). Materializa el
    plan "NEXO PYME", configura una empresa, factura un producto,
    muestra/registra/aprueba el asiento y el Mayor — **de punta a
    punta, vía la API real** (`app.inject()` en proceso, no contra el
    servidor de `npm start`, así que no interfiere con él). Pero es un
    dataset mínimo propio (1 cliente, 1 producto, 1 factura, otra razón
    social — "Ferretería del Norte S.A."), no el dataset de 09-dataset-
    demo.md: no crea proveedores, caja/bancos/cheques, bienes de uso,
    proyectos/sucursales/comisiones, ni certificado ARCA. Serviría como
    plantilla de código a adaptar, no como generador directo.
15. **¿Requiere migraciones?** No.
16. **¿Requiere código nuevo?** Si se quiere reconstruir el dataset
    completo del curso (3 terceros, 3 productos, proyectos, sucursales,
    comisiones, certificado, plan, etc.) de forma reproducible, sí —
    adaptar/extender `factura-demo.mjs`, que hoy cubre una fracción
    chica.
17. **¿Es reversible?** Crear la empresa, sí, es aditivo y no rompe
    nada — pero no se puede *borrar*: el esquema tiene triggers
    `forbid_delete` en prácticamente todas las tablas de negocio. Una
    empresa creada por error queda para siempre (se podría marcar
    `status` inactivo si existe ese campo, pero no desaparece).
18. **Rollback:** no hay rollback real más que dejar de usarla —
    coherente con el diseño append-only de todo el sistema.
19. **Evidencia de no contaminación:** la empresa del curso sigue
    teniendo exactamente el mismo `company_id`, y cualquier consulta con
    ese `company_id` (p. ej. `GET /companies` filtrado, o el mismo
    `GET /fiscal-years` de la empresa vieja) debería devolver lo mismo
    de siempre — la separación la garantiza RLS, no una convención.

### OPCIÓN C — Base de datos separada (sandbox)

1. **Mecanismo real, no hipotético:** `npm run sandbox:create` /
   `sandbox:run` / `sandbox:status` (`scripts/sandbox.mjs`, paquete
   `@aai/sandbox`). `create` corre **las mismas migraciones** que
   producción contra `SANDBOX_DATABASE_URL` (nunca un esquema
   simplificado) y, recién después, graba una marca
   (`sandbox_marker`, sello `AAI_SANDBOX_V1`) — nunca antes, para que un
   fallo a mitad de migración no deje una base a medio migrar que igual
   pase por sandbox.
2. **Candado de aislamiento, auditado línea por línea**
   (`packages/sandbox/src/aislamiento.ts`): `verificarAislamiento` no
   pregunta "¿esto es producción?" — pregunta "¿hay prueba de que esto
   es un sandbox?", y la ausencia de prueba (tabla sin marca, marca
   vacía, consulta que falla) es un rechazo por defecto. Revisa CUATRO
   cosas a la vez (marca válida, URL distinta de producción, nombre de
   base distinto de producción, prefijo `sandbox_` obligatorio) y
   reporta todas las que fallen, no solo la primera.
3. **Tablas/datos que modifica:** ninguna de `aai` — es, por
   definición, otra base de datos completa, con su propio esquema
   (278 tablas si está al día).
4. **Endpoints:** ninguno de la API HTTP — `sandbox:create` corre
   scripts de Node (`db-create.mjs`, `migrate.mjs`) contra una
   `DATABASE_URL` sustituida *solo para el proceso hijo*, nunca para el
   proceso del servidor que ya corre en :3001.
5. **Permisos:** los de Postgres para crear una base y correr
   migraciones (usuario `postgres`, ya en `.env`) — no son permisos de
   la aplicación NEXO.
6. **Datos del curso que conserva/pierde:** no aplica — es una base
   nueva, no deriva de la del curso. Nada de la empresa del curso se
   toca ni se copia.
7. **¿Reproduce el dataset exacto?** Solo el **escenario de demostración
   de fábrica** (`scripts/sandbox-escenario.mjs`) es ejecutable hoy vía
   `sandbox:run`, y es ajeno al curso: una "SIMULACIÓN" fija con CUIT y
   UUID de prueba, pensada para mostrar un caso de IVA
   `NO_DETERMINABLE`. **No hay ningún mecanismo para cargar el dataset
   del curso en el sandbox** salvo repitiendo a mano, contra esa base,
   el mismo trabajo de carga que ya se hizo una vez contra `aai` —
   trabajo equivalente o mayor al de la Opción B.
8. **Verificado ahora mismo, de solo lectura, contra las 5 bases
   candidatas:**

   | Base | Existe | Tamaño | Tablas | Empresas | Marca de sandbox |
   |---|---|---|---|---|---|
   | `aai` | Sí | 36 MB | 278 | 8 | No tiene (es la de producción del curso) |
   | `aai_test` | Sí | 42 MB | 278 | 551 | No tiene — crece sin límite en cada corrida de tests |
   | `aai_verify` | Sí | 24 MB | 278 | 2 | No tiene — datos ajenos de otra verificación |
   | `aai_predeploy_verify` | Sí | 23 MB | 277 | 2 | No tiene — ídem, un esquema una migración atrás |
   | `sandbox_aai` | Sí | 13 MB | **92** | 0 | **Sí tiene** (`AAI_SANDBOX_V1`) — pero muy atrasada: le faltan ~186 migraciones |
   | `aai_demo` / `aai_limpia` | **No existen** | — | — | — | — |

9. **¿Afecta 2026, los 14 `VIDEO_FINAL`, auditoría, saldos, comprobantes,
   usuarios, terceros?** No, a ninguno — aislamiento físico total, es
   literalmente otro archivo de base de datos.
10. **¿Requiere fixtures?** Sí, el equivalente completo del dataset del
    curso, escrito a mano o por script, igual que la Opción B.
11. **¿Requiere migraciones?** Si se usa `sandbox_aai`: sí, traerla al
    día (o recrearla) antes de nada — está en ~92/278 tablas. Si se crea
    `aai_demo`/`aai_limpia`: sí, el set completo desde cero.
12. **¿Requiere código nuevo?** No para el mecanismo en sí (ya existe) —
    sí para cargar el dataset del curso, igual que la Opción B.
13. **¿Es reversible?** Sí, totalmente — es la única de las tres donde
    "deshacer" significa literalmente borrar la base entera
    (`DROP DATABASE`) sin tocar nada de lo real.
14. **Rollback:** `DROP DATABASE sandbox_aai` (o la que se use) — pero
    hay que hacerlo manualmente, no hay un comando "destroy" en
    `scripts/sandbox.mjs`.
15. **Evidencia de no contaminación:** trivial de demostrar —
    `DATABASE_URL` nunca cambia, el servidor en :3001 sigue apuntando a
    `aai` en todo momento, y cualquier cosa que pase en el sandbox vive
    en un proceso y una conexión completamente aparte.
16. **Complicación operativa no mencionada antes:** el servidor que ya
    corre (`npm start`, puerto 3001, el mismo que usan **todas** las
    capturas de pantalla de este curso) lee `DATABASE_URL` **una sola
    vez al arrancar**, de `.env`. Para filmar interactivamente contra el
    sandbox con el mismo método ya usado todo el curso (navegador +
    consola real), hay dos caminos, y ninguno es gratis: **(a)** editar
    `.env` y reiniciar el servidor — apaga el servidor que depende el
    resto del curso mientras dure la grabación, y es un paso manual
    fácil de olvidar revertir; o **(b)** levantar un **segundo** proceso
    del servidor, en otro puerto, con `DATABASE_URL` sustituida solo
    para ese proceso (el mismo patrón que ya usa `sandbox.mjs` al
    invocar `migrate.mjs`) — no interfiere con el servidor real, pero es
    un proceso más para administrar y apagar después.

---

## 5. Riesgos para los 14 `VIDEO_FINAL` (protección explícita)

Los 14 videos ya terminados (01, 02, 03, 09, 13, 20, 21, 22, 24, 25, 26,
28, 29, 30) son archivos `.mp4` ya exportados en
`scratchpad/produccion/MASTER/`. Ninguna de las tres opciones los toca:

- **Opción A** no modifica ninguna fila de 2026 (el trigger lo impide a
  nivel de base, no de aplicación) — los datos que esos videos muestran
  siguen existiendo exactamente igual.
- **Opción B** ni siquiera comparte `company_id` con la empresa del
  curso — es otra fila de `companies`, invisible por RLS desde la
  empresa vieja y viceversa.
- **Opción C** es otra base de datos entera — aislamiento físico.

**Verificación de que abrir 2027 (Opción A) no cambia nada que los 14
videos ya muestran:** balances, saldos y reportes de 2026 se calculan
siempre filtrando por `fiscal_year_id`/rango de fechas de 2026 — abrir
2027 agrega filas nuevas con un `fiscal_year_id` distinto, nunca
recalcula ni reescribe una consulta ya hecha sobre 2026. Numeración de
comprobantes (`next_entry_number`) está particionada por
`(company_id, journal_code, fiscal_year_id)`, así que 2027 arranca su
propia numeración sin pisar la de 2026. Auditoría es `append-only` por
diseño (sin triggers de `UPDATE`/`DELETE` sobre `audit_log`). Documentos
y comprobantes de 2026 no se recalculan nunca por la apertura de otro
ejercicio. Resultados de IA, proyectos/sucursales/comisiones e
integraciones son todos de 2026 o de fecha fija, y ninguno lee
`fiscal_years` para decidir qué mostrar salvo el propio módulo de
Plan/Períodos. **No se encontró ningún riesgo indirecto real** para los
14 videos ya terminados, en ninguna de las tres opciones.

---

## 6. Evidencia encontrada (resumen de lo verificado en esta pasada)

- Trigger `je_fiscal_year_guard` leído completo (migración `0038`,
  líneas 230-299): confirma que el candado es **solo** sobre
  `journal_entries`.
- Grep de `INSERT INTO journal_entries` en todo `apps/api/src`: solo 3
  archivos lo hacen (`journal-entries.ts`, `closures.ts`,
  `migracion/escritores.ts`).
- Lectura completa de `recuentos.ts`, y grep de `journal_entries` en
  `stock.ts`, `comprobantes.ts`, `comercial.ts`, `recepciones.ts`,
  `ordenes-de-pago.ts`, `activos.ts`: ninguno inserta en
  `journal_entries`; `activos.ts` solo **lee** un asiento ya existente
  para vincularlo.
- Consultas en vivo, de solo lectura, contra la empresa real del curso
  (`GET /fiscal-years`, `/periods`, `/companies/current/users`,
  `/products`, `/warehouses`, `/fixed-assets`, `/tax-transactions`,
  `/commercial-documents`, `/payment-orders`, `/journal-entries`,
  `/stock`, `/stock-counts`, `/tax-transactions/.../salida-sugerida`):
  confirman que el dato real que necesitan 9 de los 12 videos **ya
  existe**, con los montos exactos que citan sus guiones.
- Consulta SQL de solo lectura (vía `pg`, sin tocar `DATABASE_URL` del
  servidor) a `pg_database` y a cada base candidata: reconfirma tamaños,
  cantidad de tablas y de empresas de `aai`, `aai_test`, `aai_verify`,
  `aai_predeploy_verify`, `sandbox_aai`; confirma que `sandbox_aai` **sí**
  tiene la marca de sandbox pero con solo 92/278 tablas; reconfirma que
  `aai_demo`/`aai_limpia` no existen.
- Lectura de `create_company()`, `grant_company_role()` y
  `organization_level()` (migración `0013`): confirma qué hace y no hace
  cada una, y que Mariana Sosa ya es `OWNER`/`ADMIN` de su estudio
  (`canManageOrganization: true`, verificado en vivo).
- Lectura de `scripts/sandbox.mjs` y
  `packages/sandbox/src/aislamiento.ts` completos: confirma el mecanismo
  de aislamiento y sus cuatro controles.
- Lectura de permisos por rol (migraciones `0011` y `0038`): confirma
  que `ADMINISTRADOR` tiene `period:write` y `CONTADOR` tiene
  `fiscal_year:close`, y que Mariana tiene ambos roles.

---

## 7. Recomendación técnica

**Para 11 de los 12 videos (06, 07, 08, 10, 11, 12, 14, 15, 16, 18, 31):
ninguna de las tres opciones (A/B/C) hace falta.** El trabajo que falta
es exclusivamente producción audiovisual — exactamente el mismo
pipeline (Piper TTS + capturas reales de pantallas con datos ya
existentes + ffmpeg) ya usado con éxito en 11 de los 14 videos
`VIDEO_FINAL` actuales. Siete de los once (10, 11, 12, 14, 15, 16, 31)
tienen su dato final ya posteado y verificado en vivo; dos (06, 18)
tienen el dato ya existente con una salvedad editorial a anotar (código
de producto no repetible, inconsistencia $0/$425.000); dos (07, 08)
necesitan solo un dato nuevo y chico (una persona, posiblemente un
certificado), sin tocar el ejercicio.

**Para el video 17 (el único con un bloqueo real): Opción A.**

Por qué, con evidencia, no por preferencia:

- Es la única de las tres que no necesita **ningún** trabajo de
  reconstrucción de datos: Mariana Sosa ya tiene los dos permisos que
  hacen falta (`period:write`, `fiscal_year:close`), y la secuencia es
  exactamente dos llamadas HTTP (`POST /fiscal-years`,
  `POST /fiscal-years/:id/opening`), ambas ya confirmadas contra el
  código real, sin código nuevo ni migraciones.
- No afecta 2026 ni a los 14 videos ya terminados (sección 5).
- El video 17 **no necesita el dataset completo del curso** para su
  tramo faltante — bloquear/reabrir un período y mostrar una apertura
  son demostraciones de mecánica, no de contenido del dataset — así que
  la ventaja de aislamiento total de la Opción C, o de "empresa
  limpia" de la Opción B, no aporta nada aquí que la Opción A no tenga
  ya cubierto con menos trabajo.

**Desventajas de la Opción A, dichas sin maquillar:**

- Es, en los hechos, irreversible una vez posteada la apertura (no hay
  endpoint de reapertura de ejercicio).
- Las cuentas patrimoniales de 2027 arrastran saldo de cierre de 2026 —
  no es una empresa "recién nacida" (aunque para el video 17
  específicamente esto es irrelevante: lo que hace falta mostrar es
  mecánica de períodos, no saldos).
- Si en algún momento se decide narrar el video 17 con fechas "2026" en
  el guion y las capturas terminan fechadas "2027", es un ajuste de
  texto del guion, no de datos — pero hay que acordarse de hacerlo.

**Por qué no B ni C para el video 17 específicamente:**

- **Opción B** exigiría reconstruir una empresa entera (plan de
  cuentas, mapeo, ejercicio) solo para demostrar una mecánica de
  períodos que no depende de nada de eso — proporcionalmente, muchísimo
  más trabajo que el problema que resuelve.
- **Opción C** exigiría, como mínimo, migrar `sandbox_aai` (o crear
  `aai_demo`/`aai_limpia` desde cero) y después cargar manualmente un
  ejercicio y un período — de nuevo, más trabajo de infraestructura que
  el tramo de dos minutos de video que hay que producir, para una
  ganancia (aislamiento físico total) que no hace falta cuando lo único
  que se necesita mostrar es que un período se puede bloquear, intentar
  reabrir, y que un ejercicio nuevo arranca con su asiento de apertura.

**Incertidumbre que queda:** si Pablo prefiere, por una razón de
archivo/canon de marketing ("una sola empresa demo para todo el
material futuro"), evitar que la empresa del curso avance a un segundo
ejercicio, la alternativa es filmar el tramo faltante del video 17 en
cualquier otra empresa ya existente de esta misma base (`aai` tiene 8
empresas) que todavía tenga o pueda tener un período `ABIERTO` sin
pasar por este análisis — una decisión de alcance, no técnica, que
ningún hallazgo de este informe puede resolver por él.

---

## 8. Plan de ejecución — preparado, no ejecutado

Esto describe **cómo se haría si se aprueba la Opción A para el video
17**. Nada de esto se ejecutó.

| Paso | Comando/endpoint | Parámetros | Usuario/rol | Resultado esperado | Evidencia a guardar | Condición de abortar | Rollback |
|---|---|---|---|---|---|---|---|
| 0. Pre-check | `GET /fiscal-years`, `GET /periods` | — | cualquiera con `period:read` | Reconfirma: 1 ejercicio (2026, `CERRADO`), 12 períodos `CERRADO` | Respuesta JSON completa, con timestamp | Si aparece algún ejercicio o período distinto a lo documentado acá | No aplica (es lectura) |
| 1. Snapshot | `GET /reports/trial-balance`, `GET /journal-entries` (listado completo) | — | `report:read`, `journal_entry:read` | Captura exacta de saldos y asientos de 2026 antes de tocar nada | Guardar el JSON completo en `scratchpad/produccion/video17/pre-apertura.json` | — | — |
| 2. Crear ejercicio 2027 | `POST /fiscal-years` | `{ code: "2027", startDate: "2027-01-01", endDate: "2027-12-31", generateMonthlyPeriods: true }` | Mariana Sosa (`period:write`, ya lo tiene) | `201`, `{ id, periods: 12 }` | Respuesta completa con el `id` del nuevo ejercicio | Si devuelve error de superposición o de código duplicado | Si no se posteó aún ningún asiento: `DELETE` manual de la fila de `fiscal_years` 2027 y sus 12 `periods` |
| 3. Verificar 2027 | `GET /fiscal-years`, `GET /periods?fiscalYearId=<2027>` | — | `period:read` | 2 ejercicios ahora (2026 `CERRADO`, 2027 `ABIERTO`), 12 períodos de 2027 `ABIERTO` | Respuesta JSON | Si 2026 cambió de estado (no debería ser posible) | — |
| 4. Filmar el tramo "bloquear/reabrir" | `POST /periods/:id/block`, `POST /periods/:id/reopen` (con contrafirma de una segunda persona) | motivo, segunda firma | `period:write`/`period:reopen` | Período `BLOQUEADO` → `ABIERTO` otra vez, con registro de las dos firmas | Captura de pantalla real de cada paso | Si la contrafirma no está disponible (se necesita una segunda persona real con permiso) | El período reabierto vuelve a estar disponible — no hace falta deshacer nada |
| 5. Asiento de apertura | `POST /fiscal-years/<2026>/opening` | `{ siguienteEjercicioId: <2027> }` | Mariana Sosa (`fiscal_year:close`, ya lo tiene) | `200`, con el id del asiento de apertura posteado | Respuesta completa + captura del asiento en el Mayor de 2027 | Si el cierre de 2026 no tiene `saldos` archivados (no debería pasar, ya se cerró) | **Ninguno a partir de acá** — es el punto de no retorno |
| 6. Verificación final | `GET /fiscal-years`, `GET /journal-entries?fiscalYearId=<2027>` | — | `period:read`, `journal_entry:read` | El asiento de apertura visible, con los saldos patrimoniales de 2026 trasladados | Guardar en `scratchpad/produccion/video17/post-apertura.json` | — | — |
| 7. Producción del video | (producción audiovisual, no API) | — | — | `VIDEO_FINAL` del video 17 | `scratchpad/produccion/video17/` completo, igual que los otros 14 | Si alguna captura no coincide con lo que el guion narra | No aplica |
| 8. Auditoría final | `git status --porcelain`, `GET /audit-log` | — | — | Working tree sin cambios de código; `audit_log` con exactamente 2 entradas nuevas (`CREAR_EJERCICIO`, `ABRIR_EJERCICIO`) más las del paso 4 | Guardar salida completa | — | — |

Cada paso con un endpoint de escritura (2, 4, 5) requeriría
autorización explícita y por separado de Pablo antes de ejecutarse,
igual que se hizo para el cierre del ejercicio 2026.

---

## 9. Plan de rollback

- **Antes del paso 5 (asiento de apertura):** reversible. Borrar a mano
  la fila de `fiscal_years` 2027 y sus 12 `periods` deja el entorno
  exactamente como está hoy — no hay ningún asiento que dependa de
  ellos todavía.
- **Desde el paso 5 en adelante:** no reversible por diseño (es la
  misma irreversibilidad, ya aceptada, del cierre del ejercicio 2026).
  La única corrección posible a partir de ahí es contable hacia
  adelante (un ajuste en 2027), nunca un "deshacer".
- **Para los 11 videos que no tocan el entorno:** no aplica ningún
  rollback — es trabajo de producción audiovisual sobre datos que ya
  existen, sin ninguna escritura nueva contra la aplicación.

---

## 10. Orden de producción recomendado

No por número de video — por dependencia real y por riesgo:

1. **06, 10, 11, 12, 14, 15, 16, 31** — ya tienen el 100% de su dato
   real posteado y verificado en vivo (sección 3). Se pueden producir
   en cualquier orden entre sí, sin dependencias nuevas entre ellos
   (las dependencias narrativas — 14 necesita el resultado de 11, 16
   necesita el de 12, 15 necesita el de 10 — ya están satisfechas,
   porque esos resultados ya existen).
2. **18** — mismo caso, más una nota de producción obligatoria sobre la
   inconsistencia $0,00/$425.000 antes de darlo por terminado.
3. **07** — necesita una preparación mínima primero: dar de alta una
   persona nueva en el estudio (acción aditiva, de bajo riesgo).
4. **08** — verificar primero si el certificado actual se puede
   remostrar o hace falta resubir uno de homologación.
5. **17** — el único que depende de una decisión de entorno (sección
   7/8). Se produce al final, después de que no quede ninguna otra
   grabación pendiente que dependa de que el ejercicio actual siga
   `CERRADO` tal cual está — exactamente el mismo criterio que ya se
   usó la vez pasada para decidir cuándo cerrar 2026.

**Criterio exacto para pasar a `VIDEO_FINAL`, igual para los 12:**
mismo que ya se aplicó a los 14 anteriores — MP4 exportado en 890×444/
25fps/H.264+AAC, `ffprobe` confirma especificaciones, `silencedetect`
sin silencios fuera de la tarjeta de título, `volumedetect` sin
anomalías, frames distribuidos comparados contra la narración, sin
pantallas negras/datos de desarrollo/credenciales/rutas locales
visibles, evidencia completa en `scratchpad/produccion/videoNN/`, y
solo entonces se actualiza `14-guiones-definitivos.md` y
`16-matriz-de-produccion.md`.

---

## 11. Criterios de aceptación

- Un video pasa a `VIDEO_FINAL` únicamente si su MP4 existe **y** pasa
  todas las verificaciones técnicas listadas arriba — nunca por
  existir el archivo solamente.
- Ningún video de este lote se da por terminado si su narración
  describe una acción que la pantalla capturada no respalda con datos
  reales (coherente con la regla ya aplicada en todo el curso).
- El video 18 no se da por terminado sin la nota de producción
  explícita sobre la inconsistencia de montos (sección 2.3).
- El video 17 no se da por terminado sin la autorización explícita y
  puntual de cada paso de escritura (sección 8), ni sin la verificación
  de no-contaminación de 2026 (sección 5) después de cada uno.

## 12. Incertidumbres restantes

1. Si el paso "Ver la propuesta" del video 15 se puede re-ejecutar en
   vivo sobre un comprobante que ya tiene un asiento aprobado, o si hay
   que resolverlo narrando directamente sobre el resultado final — no
   se probó (sería una llamada de escritura/lectura especial, fuera del
   alcance de "no ejecutar nada" de esta auditoría).
2. Si el certificado ARCA del video 08 admite resubirse o hace falta
   uno nuevo de homologación — no se leyó `arca.ts` en esta pasada.
3. Si Pablo prefiere evitar que la empresa canónica del curso avance a
   un segundo ejercicio por una razón de archivo/marketing, en cuyo
   caso el video 17 se resolvería en otra de las 8 empresas de `aai`
   (o en una empresa/sandbox nueva) — decisión de alcance, no técnica.
4. El riesgo exacto de mostrar en cámara la inconsistencia del video 18
   (sección 2.3) es una decisión editorial: omitir esa pantalla,
   mostrarla con la nota, o corregir el dato a mano antes de filmar
   (esto último sería una modificación de datos y requeriría
   autorización explícita aparte).
