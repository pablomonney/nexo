# BORRADOR — Términos y condiciones del servicio NEXO

> **BORRADOR SIN REVISIÓN LEGAL. NO PUBLICAR.** Fecha: 2026-10-15. Todo lo que está entre `[CORCHETES]` es un dato o una decisión que no se conoce y no se inventó (lista al final). Las notas «*Verifica:*» dicen dónde se comprueba cada afirmación sobre el producto, para que el abogado y el fundador sepan qué parte del texto depende del código.

## 1. Quién presta el servicio

NEXO («el Servicio») es un sistema de gestión y contabilidad para empresas argentinas, prestado por **[RAZÓN SOCIAL / NOMBRE COMPLETO DEL PRESTADOR]**, CUIT **[CUIT]**, con domicilio en **[DOMICILIO]** («el Prestador»). Contacto: **[CORREO DE CONTACTO — por definir]**.

Quien acepta estos términos («el Cliente») es la persona humana o jurídica que da de alta una cuenta y, si actúa en nombre de una empresa, declara tener facultades para obligarla.

## 2. Qué es el Servicio, y qué NO es

El Servicio registra la contabilidad del Cliente (asientos, mayor, libros, comprobantes, IVA, estados), ayuda a clasificar operaciones y **muestra de dónde sale cada número** (trazabilidad hasta el movimiento y el comprobante). *Verifica:* trazabilidad de cifras publicadas, `tests/integration/estados-contables.test.ts`.

**El Servicio no reemplaza el juicio de un profesional matriculado.** Calcula y propone; la decisión contable, impositiva y legal, y la presentación ante los organismos, son responsabilidad del Cliente y de su profesional. Lo que el Servicio calcule o sugiera **no constituye asesoramiento** profesional.

Alcances que el Cliente debe conocer:

- **Estados contables:** hoy el Servicio sólo trae plantillas de estados para **sociedades anónimas** (SA, con regulador IGJ). Para otros tipos de ente —incluidas las **SRL**— el Servicio lleva la contabilidad pero **no arma estados contables**. *Verifica:* `docs/ESTADOS_CONTABLES_SRL.md`. **[DECIDIR si esta limitación se declara acá o sólo en el momento del alta de una empresa de otro tipo.]**
- **Facturación electrónica:** el Servicio **no emite comprobantes fiscales** en nombre del Cliente; consulta y constata comprobantes ante ARCA. *Verifica:* `EMISION_HABILITADA = false`, `NEXO_LEGAL_Y_SOPORTE.md`.
- **Inteligencia artificial:** hoy **no hay un proveedor de modelo de IA conectado**: las sugerencias salen de reglas determinísticas y de la historia de la propia empresa. *Verifica:* configuración de producción (`AI_PROVIDER` no definido = ninguno). Cuando se conecte uno, este apartado se actualiza **antes**.
  - Ningún componente de IA escribe en la contabilidad: toda propuesta pasa por la aprobación de una persona antes de convertirse en asiento (lo impide la estructura del código, no una política).

## 3. Cuenta y seguridad

- El Cliente es responsable de la confidencialidad de sus credenciales y de lo que se haga con ellas. Debe usar una contraseña de **12 caracteres o más**, no compartirla, y activar el segundo factor cuando el rol lo exige (los roles con acceso a datos contables lo exigen). *Verifica:* `routes/auth.ts`.
- **Recuperación de cuenta:** la contraseña olvidada se recupera por correo (código de 1 hora, de un solo uso). Si se perdió el segundo factor o la casilla de correo, se resuelve con una verificación de identidad que el Prestador hace **antes** de actuar; el Prestador puede **negarse** a actuar si no puede verificarla. *Verifica:* `docs/legal/PROCEDIMIENTO_RECUPERACION_DE_CUENTA.md`.
- El Cliente debe avisar de inmediato ante cualquier uso no autorizado de su cuenta.

## 4. Prueba, planes y precios

- **Prueba:** la prueba dura **14 días** y **no requiere medio de pago**. Al vencer sin contratar, la cuenta queda **suspendida** (no cancelada) y **no se borra nada**; el Cliente puede contratar después y recuperar el acceso. *Verifica:* `DIAS_DE_PRUEBA`, `vencerPruebas`, `tests/integration/prueba-y-planes.test.ts`.
- **Planes y precios:** los vigentes son los publicados en la página de precios del Servicio. Los precios publicados son **finales, con IVA incluido**. *Verifica:* `plan_prices.incluye_impuestos`. Un precio **ya acordado** con un cliente **no cambia** por una nueva lista de precios. **[PLAZO DE PREAVISO PARA CAMBIOS DE PRECIO PARA CLIENTES EXISTENTES — por definir]**.
- **Límites del plan:** exceder un tope del plan **no bloquea** el Servicio; se avisa. *Verifica:* `routes/suscripciones.ts`.
- **Forma de pago:** **[TRANSFERENCIA BANCARIA a los datos que el Prestador informe — hoy es el único medio habilitado; MERCADO PAGO u otra pasarela: no habilitada]**. Los datos de tarjeta **nunca** se almacenan en el Servicio. *Verifica:* `0073_suscripciones.sql`.

## 5. Falta de pago

- Ante una deuda emitida y no cobrada, el Servicio avisa, luego **degrada** módulos no esenciales y, vencido el plazo de gracia declarado en la política de cobranza, **suspende** el acceso. **[PLAZOS DE AVISO Y DE GRACIA — por definir: son los de la política de cobranza vigente]**.
- **Suspender no borra nada:** la contabilidad, los comprobantes y el historial se conservan enteros y vuelven a estar disponibles al regularizar. *Verifica:* `avanzarCobranza`, `tests/integration/mora-y-acceso-degradado.test.ts`.

## 6. Datos del Cliente

- Los datos que el Cliente carga **son del Cliente**. El Prestador los trata para prestar el Servicio, según la **Política de Privacidad** y, cuando el Cliente es un estudio que carga datos de **sus** clientes, según el **Acuerdo de Encargado del Tratamiento** (`BORRADOR_ACUERDO_DE_ENCARGADO_DEL_TRATAMIENTO.md`).
- **Lo que se hace y no se hace con la contabilidad:** los asientos **no se borran**; se anulan y queda el rastro, en una bitácora encadenada y verificable. *Verifica:* `AUDIT_TRAIL.md`, `verify-audit-chain`. El personal del Prestador no accede a la contabilidad de un Cliente sin dejar rastro.
- **Exportación:** el Servicio permite exportar **informes puntuales en CSV** (balance de sumas y saldos, antigüedad, analítica, stock, libros de IVA). **Hoy NO existe una exportación completa de la empresa.** *Verifica:* `routes/exportaciones.ts`. **[DECIDIR: (a) construir la exportación completa antes del primer cliente, o (b) declarar acá que el Prestador entregará una copia de los datos del Cliente ante su pedido, en tal formato y plazo.]** *No prometer más de lo que existe.*
- **Conservación:** el Prestador conserva los datos del Cliente mientras la cuenta exista. **[QUÉ PASA DESPUÉS DE LA BAJA: plazo de conservación, forma de entrega de los datos, momento de su eliminación — por definir y con revisión legal por las obligaciones de conservación documental]**.
- **Copias de resguardo:** el Prestador hace copias periódicas. **[DECLARAR el esquema real —frecuencia, retención, y si existen copias fuera del servidor— cuando esté definido: hoy las copias comparten disco con la base y no hay copia externa. Ver `BACKUP_EXTERNO_Y_MONITOREO.md`.]**

## 7. Disponibilidad y soporte

- El Servicio se presta **«tal como está»** en cuanto a disponibilidad: **no hay un compromiso de disponibilidad (SLA)** porque no hay hoy monitoreo con destino ni guardia que lo respalde. **[DECIDIR si se declara «mejor esfuerzo» o si se compromete un horario de atención.]**
- **Soporte:** por **[CORREO DE CONTACTO]**, en horario **[HORARIO — por definir]**. El Prestador puede suspender el Servicio por mantenimiento, avisando cuando sea posible con anticipación.

## 8. Uso aceptable

El Cliente no puede: acceder a datos de otra empresa, intentar vulnerar el aislamiento entre empresas, usar el Servicio para actividades ilícitas, sobrecargarlo deliberadamente ni revender el acceso sin acuerdo. El Prestador puede suspender una cuenta que lo haga, con aviso cuando sea posible.

## 9. Responsabilidad

**[ESTA CLÁUSULA REQUIERE ABOGADO.]** Puntos que el abogado debe resolver con el fundador:

- Alcance de la responsabilidad del Prestador por **determinaciones fiscales y contables**: el Servicio calcula y muestra el origen; la decisión y la presentación son del Cliente y su profesional (§2).
- **Tope de responsabilidad** (por ejemplo, el monto abonado en los últimos **[N] meses**) y exclusiones (lucro cesante, multas de organismos por decisiones del Cliente).
- Responsabilidad por **caídas, pérdida de datos entre copias** (hasta 24 horas hoy: una copia diaria) y fuerza mayor.
- **Propiedad intelectual:** el software y la marca son del Prestador; los datos son del Cliente.

## 10. Cancelación y reembolsos

- El Cliente puede cancelar su suscripción **[CON PREAVISO DE N DÍAS — por definir]**. **Una suscripción cancelada no se reactiva**: se contrata una nueva. *Verifica:* `routes/suscripciones.ts` («de ahí no se vuelve»). Esto debe decirse **antes** de contratar.
- **Reembolsos:** **[DECISIÓN DEL FUNDADOR, luego legal: ¿hay reembolso proporcional?, ¿en qué plazo?, ¿qué pasa con un período ya facturado?]**. Considerar el derecho de arrepentimiento si el Cliente fuera consumidor final (**[CONSULTAR]**: el Servicio está pensado para empresas y profesionales).
- Tras la baja, ver «Conservación» (§6).

## 11. Cambios a estos términos

**[PLAZO DE PREAVISO Y FORMA DE NOTIFICAR CAMBIOS — por definir]**. El uso posterior al cambio implica aceptación; si el Cliente no está de acuerdo, puede cancelar.

## 12. Ley aplicable y jurisdicción

Ley argentina. **[JURISDICCIÓN: tribunales ordinarios de [CIUDAD] / mediación previa — por definir]**.

---

## Lo que falta decidir (lista para el fundador y el abogado)

1. Razón social, CUIT, domicilio y correo de contacto del Prestador (§1).
2. Qué se declara sobre estados contables que sólo existen para SA (§2).
3. Forma de pago y datos bancarios; plazo de preaviso de cambios de precio (§4).
4. Plazos de aviso y de gracia de la mora (§5).
5. **Exportación completa de la empresa**: construirla o prometer entrega a pedido (§6).
6. Conservación de datos tras la baja y esquema real de copias (§6).
7. Disponibilidad: «mejor esfuerzo» o compromiso; horario de soporte (§7).
8. Cláusula de responsabilidad: tope, exclusiones (§9).
9. Cancelación: preaviso, reembolsos, consumidor (§10).
10. Cambios a los términos; jurisdicción (§11–12).
