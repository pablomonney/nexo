# BORRADOR — Acuerdo de encargado del tratamiento de datos

> **BORRADOR SIN REVISIÓN LEGAL. NO FIRMAR NI PUBLICAR.** Fecha: 2026-10-15. Aplica cuando el Cliente es un **estudio o una empresa que carga en NEXO datos personales de terceros** (sus clientes, proveedores, empleados) y por eso es **responsable** de esos datos, mientras NEXO es su **encargado**. Marco a confirmar por el abogado: Ley 25.326 y su reglamentación (**[CONFIRMAR]**). Lo entre `[CORCHETES]` no se conoce y no se inventó.

## 1. Partes y objeto

- **Responsable:** el Cliente (**[RAZÓN SOCIAL, CUIT]**). **Encargado:** **[RAZÓN SOCIAL DEL PRESTADOR, CUIT]** («NEXO»).
- **Objeto:** NEXO trata, **por cuenta y según las instrucciones del responsable**, los datos que éste carga en el Servicio, **únicamente** para prestarle el Servicio descripto en los Términos y Condiciones.

## 2. Qué datos y de quiénes

Datos contables y fiscales de las empresas del Cliente y de **sus terceros**: razón social o nombre, CUIT/CUIL/DNI, domicilio, condición fiscal, datos de comprobantes y movimientos, datos bancarios que el Cliente decida importar (extractos), y la información de usuarios de la empresa. **No** se cargan datos de tarjeta. **[CONFIRMAR si se admite o se prohíbe cargar datos sensibles — categorías especiales — y declararlo.]**

## 3. Obligaciones de NEXO como encargado

1. **Tratar los datos sólo según las instrucciones documentadas del responsable** (el uso normal del Servicio es una instrucción). No los usa para fines propios ni los cede.
2. **Confidencialidad:** el personal con acceso está obligado a reserva. *Hecho del producto:* el diseño asume que el operador no debe leer la contabilidad de un Cliente sin dejar rastro; el aislamiento entre empresas es por diseño de la base (RLS forzado), y las acciones de operación sobre una empresa quedan en **su** bitácora encadenada.
3. **Seguridad:** aplica las medidas de la Política de Privacidad §5 (cifrado en tránsito, contraseñas con Argon2id, segundo factor, sesiones acotadas, aislamiento por empresa, bitácora verificable, copias verificadas). **Lo que todavía no existe** (copia fuera del servidor, monitoreo con aviso, cifrado de disco declarado) **se declara acá y no se promete**: **[DECIDIR si el acuerdo se firma recién cuando esas medidas existan.]**
4. **Subencargados:** autoriza a los terceros de la Política de Privacidad §3 (infraestructura, correo, ARCA a pedido del Cliente). Informa **antes** de sumar o cambiar uno que reciba datos personales, y el responsable puede oponerse **[PLAZO — por definir]**.
5. **Asistencia al responsable** para atender los derechos de las personas (acceso, rectificación, supresión) **dentro de lo que el Servicio permite**: ver la limitación por conservación contable (Política §6).
6. **Incidentes:** NEXO **avisa al responsable sin demora indebida** y, a más tardar, dentro de **[PLAZO: X HORAS desde que lo confirma]**, con lo que sabe y lo que no (`PROCEDIMIENTO_INCIDENTE_DE_SEGURIDAD.md`). El responsable decide si debe notificar a la autoridad y a los titulares. **[REVISIÓN LEGAL: plazo y contenido del aviso.]**
7. **Devolución y eliminación al terminar el servicio:** a pedido del responsable, y dentro de **[PLAZO]**, NEXO **entrega una copia** de los datos **[FORMATO — hoy el Servicio exporta informes en CSV; no existe exportación completa: ver T&C §6]** y **elimina** los datos del Servicio salvo lo que la ley obligue a conservar. **[REVISIÓN LEGAL: qué se conserva, cuánto, con qué acceso.]**
8. **Auditoría:** el responsable puede pedir información razonable para verificar el cumplimiento. **[ALCANCE Y FRECUENCIA — por definir.]** La bitácora de la empresa es el insumo natural: es verificable de forma independiente (`verify-audit-chain`).

## 4. Obligaciones del responsable (el Cliente)

Contar con base legal y, cuando corresponda, **consentimiento o aviso** a las personas cuyos datos carga; no cargar datos que no tiene derecho a tratar; mantener la seguridad de las credenciales de sus usuarios (T&C §3); y **dar instrucciones lícitas**.

## 5. Transferencias internacionales

Si un subencargado trata datos fuera de Argentina (p. ej., el proveedor de correo), se aplican las garantías que exija la normativa. **[REVISIÓN LEGAL OBLIGATORIA.]**

## 6. Responsabilidad y vigencia

**[REQUIERE ABOGADO: responsabilidad de cada parte por incumplimiento, relación con el tope de los T&C §9.]** Vigencia: mientras dure el Servicio y hasta la devolución o eliminación de los datos.

---

## Lo que falta decidir

1. Datos del Prestador y plazo de aviso de incidentes (§3.6).
2. Categorías sensibles: admitidas o prohibidas (§2).
3. **Exportación completa**: hoy no existe (§3.7).
4. Plazos de devolución/eliminación y de oposición a subencargados.
5. Qué medidas deben existir **antes** de firmar (§3.3).
6. Responsabilidad y su tope (§6).
