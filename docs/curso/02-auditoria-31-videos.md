# Fase 2 — Auditoría de los 31 videos, uno por uno

Categorías de verificación usadas (una sola por video, la más limitante):
🟢 **PRODUCCIÓN** = verificado en producción · 🟢 **TEST** = verificado por test ·
🟡 **NO VERIF.** = documentado/implementado, sin verificar en producción ·
🟠 **FRICCIÓN** = funciona con fricción UX real · 🔴 **BUG** = no funciona ·
⚪ **N/D** = no implementado · ❓ **INSUF.** = evidencia insuficiente.

## Tabla A — Contenido pedagógico

| # | Título actual | Título pedagógico recomendado | Nivel | Objetivo de aprendizaje |
|---|---|---|---|---|
| V01 | Bienvenido a NEXO | Primer ingreso a NEXO | Inicial | Tener una cuenta activa con MFA configurado |
| V02 | Crear tu empresa desde cero | Crear y configurar tu primera empresa | Inicial | Empresa + rol CONTADOR + plan de cuentas + ejercicio abierto |
| V03 | *(nuevo)* | La bandeja de Pendientes | Inicial | Saber leer las 7 categorías y usar "abrir" para resolver |
| V04 | Configurar el mapeo contable | Mapeo contable: enseñarle a NEXO dónde imputar | Operativo | Declarar los 6-8 roles contables sobre el plan de cuentas |
| V05 | Alta de terceros | Terceros: clientes y proveedores | Operativo | Cargar y editar un tercero con motivo |
| V06 | Alta de productos | Productos y catálogo | Operativo | Cargar y editar un producto con motivo |
| V07 | *(nuevo)* | Usuarios, roles y permisos | Operativo | Dar un rol a otra persona y entender ADMINISTRADOR vs. CONTADOR |
| V08 | *(nuevo)* | Certificado ARCA y servicios habilitados | Operativo | Cargar un certificado y ver qué habilita |
| V09 | Subir y procesar un documento | Documentos: subir y leer | Operativo | Subir, revisar la lectura automática, corregir un campo |
| V10 | Convertir un documento en comprobante | Del documento al comprobante | Operativo | Registrar la dirección y los importes de un comprobante |
| V11 | *(nuevo)* | Ventas: presupuestos, pedidos y facturación | Operativo | Recorrer el ciclo comercial hasta la operación fiscal |
| V12 | *(nuevo)* | Compras: solicitud → recepción → pago | Operativo | Recorrer el ciclo de compras hasta la orden de pago |
| V13 | *(nuevo)* | Caja, bancos y cheques | Operativo | Arqueo de caja, alta de cuenta bancaria, cartera de cheques |
| V14 | *(nuevo)* | Existencias: depósitos, lotes y recuento | Operativo | Ver stock por depósito y hacer un recuento físico |
| V15 | Del comprobante al asiento | Contabilidad: la propuesta y el borrador | Contable | Ver la propuesta que arma el mapeo y cargarla en borrador |
| V16 | Aprobar un asiento y consultar el Mayor | Aprobar un asiento y ver el Mayor | Contable | Aprobar y entender la diferencia entre borrador y Mayor |
| V17 | *(nuevo)* | Asientos manuales y contraasientos | Contable | Cargar un asiento a mano y anular uno por contraasiento |
| V18 | *(nuevo)* | Períodos, cierre y apertura de ejercicio | Contable | Bloquear, cerrar y reabrir un período; cerrar un ejercicio |
| V19 | *(nuevo)* | Bienes de uso y amortizaciones | Contable | Dar de alta un bien y entender el plan de amortización |
| V20 | *(nuevo)* | Costo de lo vendido y valuación de existencias | Contable | Declarar un método de valuación y ver el CMV propuesto |
| V21 | *(nuevo)* | Diario, Mayor y Balance | Gestión | Leer los tres libros y entender qué muestra cada uno |
| V22 | *(nuevo)* | Subdiarios de IVA | Gestión | Ver el subdiario de un período |
| V23 | *(nuevo)* | Estados contables | Gestión | Armar un estado contable con un marco declarado |
| V24 | *(nuevo)* | Exportar y auditar | Gestión | Bajar CSV y leer la bitácora de auditoría |
| V25 | *(nuevo)* | Preguntar: Panorama y Riesgos | Avanzado | Usar el catálogo cerrado de preguntas de Intelligence |
| V26 | *(nuevo)* | Señales, umbrales y escenarios | Avanzado | Simular un escenario y comparar contra lo ocurrido |
| V27 | *(nuevo)* | Revisar propuestas del motor de IA | Avanzado | Entender por qué toda propuesta hoy pasa por revisión humana |
| V28 | *(nuevo)* | Proyectos, sucursales y comisiones | Gestión | Ver rentabilidad por proyecto y esquemas de comisión |
| V29 | *(nuevo)* | Integraciones y migración | Avanzado | Migrar datos desde otro sistema |
| V30 | *(nuevo)* | Plan, suscripción y facturación | Gestión | Ver el plan contratado y sus topes |
| V31 | Una operación completa, de punta a punta | El circuito completo, de punta a punta | Avanzado | Recorrer documento → Mayor sin cortes, como cierre del curso |

## Tabla B — Producto real, dependencias y estado

| # | Pantalla(s) | Flujo que ejecuta | Duración | Sabe antes de | Depende de | Verificación | Guion | ¿Listo para grabar? |
|---|---|---|---|---|---|---|---|---|
| V01 | Ingreso, MFA | Registro → confirmación → login → MFA | 4-5 min | — | — | 🟢 PRODUCCIÓN | Completo | **Sí** |
| V02 | Alta de empresa, Configuración, Plan de cuentas, Períodos y cierre | Crear empresa → dar rol → cargar plan → abrir ejercicio | 6-7 min | V01 | V01 | 🟢 PRODUCCIÓN | Completo | **Sí** |
| V03 | Pendientes | Filtrar, abrir un pendiente bloqueante y uno no bloqueante | 4-5 min | Qué es un asiento (básico) | V02 | 🟡 NO VERIF.¹ | Completo (`08-guiones-nuevos.md`) | **Sí** |
| V04 | Configuración → Mapeo contable | Declarar rol → cuenta, 6 veces | 5-6 min | Qué es una cuenta imputable | V02 | 🟢 PRODUCCIÓN | Completo | **Sí** |
| V05 | Terceros | Alta → ficha → edición con motivo | 4 min | — | V02 | 🟡 NO VERIF. | Completo | **Sí** |
| V06 | Productos | Alta → ficha → edición con motivo | 4 min | — | V02 | 🟡 NO VERIF. | Completo | **Sí** |
| V07 | Configuración → Personas con acceso | Dar un rol a otra persona | 3 min | Diferencia ADMINISTRADOR/CONTADOR | V02 | 🟢 PRODUCCIÓN | Completo (`08-guiones-nuevos.md`) | **Sí** |
| V08 | Configuración → Certificado ARCA | Cargar certificado, ver servicios | 3-4 min | Qué es ARCA | V02 | 🟡 NO VERIF. | Completo (`08-guiones-nuevos.md`) | **Sí** |
| V09 | Documentos | Subir → EXTRAIDO → revisar → corregir | 5 min | — | V02 | 🟢 PRODUCCIÓN | Completo | **Sí** |
| V10 | Documentos (detalle) | Dirección + datos → Registrar el comprobante | 4-5 min | Qué es un comprobante, Debe/Haber (intro) | V09 | 🟢 PRODUCCIÓN | Completo | **Sí** |
| V11 | Comercial | Presupuesto → pedido → factura | 6-7 min | — | V05, V06 | 🟡 TEST | Estructura only | Falta guion |
| V12 | Solicitudes, Recepciones, Pagos | Solicitud → aprobación → recepción → pago | 7-8 min | — | V05 | 🟡 TEST | Estructura only | Falta guion |
| V13 | Caja, Bancos, Cheques | Arqueo, alta de cuenta bancaria, cartera de cheques | 6 min | — | V02 | 🟡 TEST | Completo (`08-guiones-nuevos.md`)⁵ | **Sí** |
| V14 | Existencias | Consulta por depósito, recuento | 5 min | — | V06 | 🟡 TEST | Estructura only | Falta guion |
| V15 | Operaciones | Ver la propuesta → cargar como borrador | 4-5 min | Qué es un asiento, Debe/Haber | V04, V10 | 🟢 PRODUCCIÓN | Completo | **Sí** |
| V16 | Asientos, Libros | Aprobar → ver el Mayor | 3-4 min | Qué es aprobar vs. cargar | V15 | 🟢 PRODUCCIÓN | Completo | **Sí** |
| V17 | Asientos | Carga manual → contraasiento | 6 min | Debe/Haber, qué es un asiento vigente | V16 | 🟡 TEST | Estructura only | Falta guion |
| V18 | Períodos y cierre | Bloquear → cerrar → checklist → apertura | 6-7 min | Qué es un ejercicio, un período | V16 | 🟡 TEST | Completo (`08-guiones-nuevos.md`) | **Sí** |
| V19 | Bienes de uso | Alta → plan de amortización → asiento | 6 min | — | V16 | 🟡 TEST | Estructura only | Falta guion |
| V20 | Existencias, Configuración | Declarar método → ver CMV propuesto | 5 min | — | V14, V16 | 🟡 TEST | Estructura only | Falta guion |
| V21 | Libros | Diario → Mayor → Balance | 6 min | Qué es cada libro | V16 | 🟡 NO VERIF.² | Estructura only | Falta guion |
| V22 | IVA | Ver período → ver subdiario | 3 min | — | V10 | 🟡 TEST | Estructura only | Falta guion |
| V23 | Estados y notas | Declarar marco → armar estado | 5 min | — | V21 | 🟡 TEST | Estructura only | Falta guion |
| V24 | Libros, Auditoría | Exportar CSV, leer bitácora | 4 min | — | V21 | 🟡 TEST | Estructura only | Falta guion |
| V25 | Preguntar | Panorama → Riesgos | 4-5 min | — | V16 | 🟡 TEST | Completo (`08-guiones-nuevos.md`) | **Sí** |
| V26 | Análisis → Señales | Simular escenario → declarar aplicado → ver resultado | 6 min | — | V25 | 🟡 TEST | Estructura only | Falta guion |
| V27 | Propuestas de IA | Revisar una propuesta | 4 min | — | V15 | 🟠 FRICCIÓN³ | Estructura only | Falta guion |
| V28 | Proyectos, Sucursales, Comisiones | Ver rentabilidad, dar de alta vendedor | 5 min | — | V02 | 🟡 TEST | Estructura only | Falta guion |
| V29 | Migraciones | Elegir fuente, migrar, revertir | 5 min | — | V02 | 🟡 TEST | Estructura only | Falta guion |
| V30 | Administración → Plan | Ver plan, topes, convertir prueba | 3 min | — | V02 | 🟡 NO VERIF. | Estructura only | Falta guion |
| V31 | Todas las anteriores | Recorrido entero, un producto de punta a punta | 12-15 min | Todo lo de V01-V16 | Todo lo anterior | 🟡 MIXTO⁴ | Completo | **Sí, con la salvedad ⁴** |

**Notas:**
1. La bandeja *existe* y tuvo pendientes reales en la prueba de producción del 2026-09-22 (CONSTATACION, DECISION,
   AFECTACION, 8×REQUIERE_APROBACION) — eso está verificado. El routing de las 18 entidades nuevas está
   VERIFICADO POR TEST y desplegado; nadie clickeó específicamente esas 18 en producción todavía.
2. El Mayor se verificó como parte de la evidencia de V16; Diario y Balance no se verificaron por separado en esta prueba.
3. `accounting_rules` está vacía en producción hoy: **toda** propuesta cae en revisión profesional. El video puede
   grabarse, pero no puede mostrar el camino de "confianza alta" porque ese camino no ocurre nunca en la práctica —
   hay que decirlo explícitamente en el guion, no fingir que es infrecuente.
4. El tramo documento→comprobante→mapeo→propuesta→asiento→Mayor de V31 SÍ está verificado en producción (es la
   misma evidencia de V09-V16). Los tramos de terceros/productos que V31 también recorre no tienen esa misma
   evidencia. Grabar V31 es correcto, pero el guion tiene que decir "el tramo contable está verificado en
   producción" y no extender esa afirmación al video entero.
5. El guion de V13 citaba "el número de fixture del dataset" para la cuenta bancaria sin que existiera ninguno.
   **Cerrado el 2026-09-23**: `09-dataset-demo.md` ahora define el fixture `BANCO-DEMO-01`, y el guion de V13
   apunta a él explícitamente.

## Problemas o riesgos detectados en esta auditoría

- **V27** no puede prometer "propuesta de alta confianza" sin mentir — ver nota 3. Redactado también en
  `06-no-grabar-todavia.md`.
- **V21-V24** (Nivel 5, Reportes) dependen todos de V16 pero ninguno tiene guion — es el bloque con mayor
  volumen de trabajo pendiente relativo a su prioridad pedagógica (media).
- **V18** ya tiene un guion de ejemplo completo desde el diagnóstico anterior — es el mejor candidato para
  usar como plantilla de los 19 videos "Estructura only" restantes, más que V03 (que es más corto y atípico).
