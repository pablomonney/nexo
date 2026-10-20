# Si quien emite es monotributista: qué cambia, y cómo se maneja NEXO con NEXO

**Fecha:** 2026-10-16. **Estado:** análisis a partir de las normas archivadas en `docs/normative-sources/`; **lo que no está archivado se dice como «no relevado»** y es para el contador. Nada de esto es asesoramiento fiscal.

Punto de partida (palabras del titular): lo más probable es que **quien emite sea monotributista**; NEXO se va a manejar con NEXO: una empresa (el **NEXO propietario**) administra a las demás, y **todas las facturas y toda la gestión corren contra ese NEXO propietario**.

## 1 · Una corrección importante: un monotributista no emite facturas B

Se pensaba «B o C; A sólo contra un responsable inscripto». La norma archivada dice otra cosa:

| Quién emite | Qué letra | Fuente (texto archivado) |
|---|---|---|
| **Responsable inscripto** | **A** si el receptor es responsable inscripto o monotributista; **B** si es exento, no responsable, consumidor final o no categorizado | RG 1415, **art. 15** |
| **Monotributista** (Régimen Simplificado), exento o no responsable | **C — siempre, a cualquier receptor** | RG 1415, **art. 16**, inc. b (texto de la RG 5198/2022) |

Es decir: **la letra la define quien emite, no a quién le factura.** Si el emisor es monotributista, **todas** las facturas —también las que se le hacen a un responsable inscripto— son **clase C** (y sus notas de crédito y de débito, 13 y 12). **A y B sólo existen si el emisor es responsable inscripto.** Es lo que `armarComprobante` ya hace (`emisor monotributista → C, sea cual sea el receptor`, probado) y lo que ARCA aceptó en homologación.

Lo que sí cambia según el receptor, aun con una factura C, es **la condición frente al IVA del receptor** que hay que informar (RG 5616/2024, art. 2): a un responsable inscripto se le informa condición 1, a un consumidor final 5, etc. **Sin ella ARCA rechaza (10246).**

## 2 · Monotributista y responsable inscripto, lado a lado

| Tema | Responsable inscripto | Monotributista | Qué hace NEXO hoy |
|---|---|---|---|
| **Letra de la factura** | A o B (RG 1415 art. 15) | **C** (art. 16) | ✔ `letraDeFactura` |
| **IVA en la factura** | Discriminado (A y B informan base e IVA por alícuota) | **No se discrimina**: ImpNeto = total, ImpIVA = 0 y **no se manda el nodo `Iva`** | ✔ probado hasta el XML y en ARCA |
| **Pedir el CAE por web service (WSFEv1)** | Sí | **Sí** (RG 4291, **art. 6, incisos b y c**: el Régimen Simplificado sólo puede usar el web service y «Comprobantes en línea») | ✔ NEXO emite por WSFEv1 |
| **«Facturador»** (aplicación de ARCA) | — | Sólo para operaciones con **consumidores finales personas humanas**, hasta **$ 500.000** por operación (RG 5198, art. 1°, texto RG 5700/2025) | No aplica: NEXO usa el web service, no el Facturador |
| **Condición del receptor en el comprobante** | Obligatoria | Obligatoria (rige para quien emite, sea cual sea su régimen) | ✔ |
| **Libro de IVA Digital** | Obligado | **Exceptuado** (RG 4597, **art. 2, inc. d**) | ⚠ ver §3 |
| **Crédito fiscal del cliente** | Un cliente RI computa el IVA de una A | Un cliente RI que recibe una **C no tiene IVA discriminado que computar** | ⚠ consecuencia comercial, ver §3 |
| **Factura A a un monotributista** | Lleva la leyenda del Régimen de Sostenimiento e Inclusión Fiscal (art. 15 inc. a) | — | No aplica mientras el emisor sea monotributista |
| **Obligación de llevar contabilidad** | CCyC **art. 320**: obligadas las personas jurídicas privadas y **quienes realizan una actividad económica organizada o son titulares de una empresa o establecimiento**; excluidas las personas humanas con **profesiones liberales o actividades agropecuarias no organizadas en forma de empresa**; **cualquier otra persona puede llevarla** si lo solicita | ídem: **no depende del monotributo sino de si la actividad es «organizada» (empresa)** | ⚠ lo decide el contador (§3) |
| **Montos y categorías del monotributo, tope de facturación** | No aplica | Existen y **mandan** (si se superan, hay que pasar a responsable inscripto) | ⬜ **No relevado**: no está en las normas archivadas |
| **Ingresos Brutos y otros tributos provinciales** | Aplican | Aplican | ⬜ **No relevado** (el mapa normativo ya lo dice) |

## 3 · Lo que esto implica para NEXO (y lo que hay que decidir)

1. **Los precios dicen «ya incluyen el IVA».** Hoy los cinco planes de producción están declarados como **importes finales con IVA incluido** (`plan_prices.incluye_impuestos = true`, 2026-09-15) y la landing y la consola muestran *«Los importes son FINALES: ya incluyen el IVA»* (`apps/api/src/routes/onboarding.ts`). **Si quien emite es monotributista, esa frase es falsa**: el monotributista no cobra IVA; el precio es final y **no discrimina IVA**. Cuando se confirme la condición de quien emite, la leyenda tiene que pasar a decir «precio final; el emisor no discrimina IVA». Es una frase que se calcula del dato declarado: el dato que falta es la condición del emisor (D1). *No lo cambié todavía porque la condición aún no está confirmada: cambiar una afirmación fiscal pública sobre un supuesto sería repetir el error que ese archivo documenta.*
2. **Clientes responsables inscriptos.** Si NEXO les factura con C, **no pueden computar IVA**. Para un estudio contable o una empresa que compra el servicio es un factor de decisión de compra: conviene saberlo **antes** de fijar precios, no después. (Si algún día se pasa a responsable inscripto, las facturas pasan a A/B y los precios a netos o finales con IVA: la numeración y los puntos de venta de ARCA cambian.)
3. **El monotributista queda exceptuado del Libro de IVA Digital.** NEXO no obliga a generarlo, pero la pantalla de IVA existe para cualquier empresa: en la empresa propietaria **no hay que generar el libro**. Falta que el sistema **lo diga** (hoy no sabe la condición de la empresa: `companies` no tiene condición frente al IVA). Es el mismo dato que falta en el punto 1.
4. **Estados contables.** Hoy las plantillas de estados contables existen sólo para **sociedades anónimas** (una SRL recibe «fuente no encontrada»; un **unipersonal** tampoco tiene plantilla). Si quien emite es una **persona humana monotributista**, **probablemente no necesite estados contables societarios**; sí le sirven el plan de cuentas, los asientos, el Mayor, la caja y los bancos (que no dependen del tipo de ente). Si el contador dice que debe llevar contabilidad (art. 320) o preparar estados, **hay que construir la plantilla** —es trabajo nuevo, y su criterio sale de la RT 54 / del contador—.
5. **Qué hay que preguntarle al contador (todo en una sola consulta):** (a) condición frente al IVA y categoría del monotributo; (b) si la actividad de NEXO (software por suscripción, con estructura de empresa) es «actividad económica organizada» y por lo tanto **obliga a llevar contabilidad** (CCyC 320) o la lleva voluntariamente; (c) hasta qué facturación se puede seguir como monotributista **y qué pasa con las facturas C a clientes responsables inscriptos**; (d) tratamiento de **Ingresos Brutos**; (e) asiento de una factura C (E5).

## 4 · «NEXO se maneja con NEXO»: el NEXO propietario

**Idea.** Hay una empresa —la **propietaria**— dentro de NEXO, y **cada empresa cliente es un cliente (tercero) de ella**. Todo lo que NEXO le cobra a sus clientes se registra, se factura y se contabiliza **en la empresa propietaria**, con las mismas pantallas que usa cualquier cliente: el producto se usa a sí mismo.

### Qué hay hoy y qué falta

| Pieza | Hoy | Falta |
|---|---|---|
| La empresa propietaria como **empresa** de NEXO (con su plan de cuentas, su ejercicio, sus terceros, caja y bancos) | Se puede crear como cualquier empresa (tipo `UNIPERSONAL` existe). No hay manera de **marcarla como la propietaria** | Un dato que la identifique (configuración o tabla), y su alta |
| **El cobro a los clientes** (suscripciones, cargos, mora) | Vive en tablas de facturación (`billing_*`) que **sólo escribe un script del operador**, sin usuario de empresa, a propósito (S-44) y con importes sin discriminar IVA («es un dato de la empresa NEXO y no está cargado») | Que cada **cargo** genere, **en la propietaria**, una **operación de venta** al cliente: un tercero que representa a la empresa suscriptora |
| **La factura** | Emisión construida y probada (E1–E6) pero cerrada a propósito (E8) | Emitir **desde la propietaria**: su certificado, su punto de venta de web services, y clase **C** si es monotributista |
| **El asiento** de esa factura y de su cobro | — | **E5**: lo aprueba un contador |
| **El cobro real** (transferencia o Mercado Pago) | El webhook registra el pago del cargo | Que el pago se **impute** a la cuenta corriente de ese cliente **en la propietaria** |
| **La gestión de NEXO** (stock no aplica; sí caja, bancos, conciliación, análisis, bandeja de pendientes) | Disponible para cualquier empresa | Usarla sobre la propietaria; que la bandeja avise «hay cargos sin facturar» |

### Orden propuesto para construirlo

1. **Decidir D1** (condición de quien emite) y **crear la empresa propietaria** en producción (acto sobre producción: con tu orden).
2. **Marcarla** como propietaria y **crear un tercero por cada empresa suscriptora** (alta automática al crear la empresa o al contratar).
3. **Que el ciclo de cobro cree la operación de venta** en la propietaria (documento comercial → intención fiscal → E4), **sin emitir**: queda en borrador hasta E8.
4. **E5 aprobado por el contador** → asiento de la factura y del cobro.
5. **E8**: levantar la puerta de emisión **para la propietaria, en homologación primero**; producción con tu orden y un importe mínimo (E9).

**Seguridad del esquema (no negociable):** la propietaria **administra a las demás**, pero **ninguna empresa cliente ve la propietaria ni a las otras** (el aislamiento sigue siendo de la base de datos). El certificado de ARCA de la propietaria es **suyo**: se carga por el camino normal de credenciales, no se guarda en el repositorio.

### «Mis clientes»: el conteo exacto de lo que entra (migración 0140)

Construido como **primer paso** del orden de arriba: la propietaria ya tiene **una forma de marcarse** y **una pantalla que cuenta**.

- **Cómo se designa.** `node scripts/designar-propietaria.mjs --cuit <CUIT> --motivo "<por qué>"` (y `--ver` para consultar). Escribe la única fila de `platform_owner`; `aai_app` **no puede leerla ni escribirla**, así que una empresa no se designa sola. Se corre en el servidor, con las credenciales de base del operador, **después de crear la empresa** (con tu orden).
- **Quién la ve.** Sólo la empresa designada. `GET /propietario/resumen` contesta **404** a cualquier otra (no 403: no se confirma que exista); el control real es de la función de base `resumen_de_cuentas_del_propietario()` (`SECURITY DEFINER`, comprueba `app_company_id()` antes de contar). La consola muestra el botón «Mis clientes» (Administración) sólo si `/companies/current` dice `esPropietaria`.
- **Qué cuenta.** Usuarios (verificados y pendientes), empresas clientes (nuevas en 7 y 30 días, por mes), suscripciones por estado, **cuáles pagan**, cuáles están activas **sin cobro**, lo cobrado por moneda y una lista mínima (empresa, CUIT, alta, plan, estado, último pago) para poder cobrarle a cada una. Nunca contenido contable. La propietaria **no se cuenta a sí misma**.
- **Qué significa «paga».** Suscripción `ACTIVA` con **al menos un cargo `PAGADO`**. La cuenta de prueba de producción está `ACTIVA` hasta 2099 **sin cobro**: contarla inflaría justo el número que necesitás exacto, por eso se informa aparte como «activas sin cobro».
- **Lo que todavía no hace.** Mide cobros registrados en `billing_documents`; no sabe de pagos que nadie cargó. Hasta que el webhook de Mercado Pago esté en el servidor real (§5, pendiente), los pagos por transferencia entran cuando alguien los registra.

### Precios publicados «+ IVA» (decisión del titular, 2026-10-19)

El titular pidió publicar los precios **sin IVA y con «+ IVA»** (hasta entonces eran finales). Los netos son **redondos** (múltiplos de $ 5.000, cerca de final ÷ 1,21); la lista y el criterio están en `docs/PLANES_Y_PRECIOS.md`. Lo que se cobra es el neto **más** el IVA: `apps/api/src/billing/iva.ts` lo suma al fijar el importe de la suscripción y al declarar el plan en la pasarela. Antes el cobro habría salido por el neto tal cual, un 21 % menos de lo publicado.

**Advertencia que sigue en pie:** un monotributista emite factura C y **no discrimina IVA**. Si la condición del titular frente al IVA resulta ser monotributista (a confirmar con el contador), cobrar «+ IVA» no es coherente con su régimen. La decisión se tomó con esta advertencia a la vista; si el contador la contradice, se vuelve a precios finales cambiando `INCLUYE_IMPUESTOS` y la lista en `scripts/sembrar-comercial-b1.mjs` (una vigencia nueva cierra la anterior), sin tocar código. Los cargos de NEXO siguen sin ser comprobantes fiscales: no discriminan el IVA hasta que haya emisión (E8).

## 5 · Lo que necesito de vos

1. **Confirmar la condición frente al IVA de quien emite** (D1) —idealmente con el contador, con las cinco preguntas del §3.5—. Con eso: facturas **C**, leyenda de precios y pantalla de IVA quedan alineadas.
2. **El CUIT de la propietaria**: ¿es el mismo con el que se probó la homologación (`20-45214832-4`)? Si es un monotributista persona humana, ese CUIT es el emisor real.
3. **Tu orden para crear la empresa propietaria en producción** (cuando se despliegue la versión nueva).
