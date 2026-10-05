# Fase 3 — Orden pedagógico definitivo

El borrador de 7 niveles del pedido es, en sustancia, **correcto contra el
producto real** — los 8 grupos de navegación de la consola (Inicio, Ventas,
Compras, Operación, Dinero, Libros, Análisis, Administración) se dejan
agrupar en esos 7 niveles sin forzar nada. Dos ajustes, explicados abajo:

1. **Documentos y comprobantes** (subir un XML, registrar la operación
   fiscal) el borrador los daba por parte de "Operar" (Nivel 4) junto con
   ventas/compras/stock/caja. Los saco primero dentro del Nivel 4: sin
   entender qué es un comprobante, "Ventas" y "Compras" no se explican —
   son la fuente de casi todo lo demás.
2. **Precios, CRM y Comisiones** no estaban en el borrador de "Nivel 3 —
   Cargar los datos base" ni en ningún otro nivel explícitamente. Existen
   como pantallas reales (grupo Ventas de la consola) y hay que ubicarlas:
   Precios entra en el Nivel 3 (es dato base, como terceros/productos);
   CRM y Comisiones entran en el Nivel 6 — son gestión comercial, no carga
   de datos ni operación diaria.

## NIVEL 1 — Conocer NEXO

**Qué logra:** de no tener cuenta a tener el Panel abierto y saber leer
Pendientes.
**Videos:** V01, V02 (parte configuración de empresa), V03.
**Conocimientos adquiridos:** cuenta y MFA; qué es una empresa, un rol, un
ejercicio, un período (a nivel de vocabulario, no de operación); cómo leer
la bandeja de Pendientes.
**Ejercicio práctico:** crear una cuenta y una empresa, y llegar al Panel
con "Puesta en marcha" mostrando el primer bloqueo resuelto.
**Criterio de fin de nivel:** puede explicar, sin ayuda, la diferencia
entre ADMINISTRADOR y CONTADOR y por qué existe la bandeja de Pendientes.

## NIVEL 2 — Crear y configurar una empresa

**Qué logra:** empresa con plan de cuentas, ejercicio, período abierto,
mapeo contable declarado y, si corresponde, certificado ARCA.
**Videos:** V02 (resto), V04, V07, V08.
**Conocimientos adquiridos:** cuenta imputable, mapeo contable, roles
contables (CLIENTES, PROVEEDORES, IVA_DÉBITO, IVA_CRÉDITO, VENTAS, COMPRAS,
y — si la empresa tiene existencias — MERCADERÍA, COSTO_DE_VENTAS); dar
rol a otra persona; certificado ARCA.
**Ejercicio práctico:** declarar los 6 roles contables hasta que el aviso
diga "Está completo."
**Criterio de fin de nivel:** el mapeo está completo y hay una segunda
persona con rol asignado.

## NIVEL 3 — Cargar los datos base

**Qué logra:** los maestros que todo lo demás va a citar.
**Videos:** V05, V06, y Precios (dentro de V11, no un video propio — ver
nota abajo).
**Conocimientos adquiridos:** tercero, producto, lista de precios; por qué
"editar el documento de un tercero" no existe (se archiva y se da de alta
otro) — es una decisión de trazabilidad, no una limitación.
**Ejercicio práctico:** dar de alta un cliente y un producto con motivo.
**Criterio de fin de nivel:** un tercero y un producto propios, listados y
editados al menos una vez.
**Nota:** Precios no tiene guion propio en la lista de 31 — la auditoría de
Fase 2 la había dejado implícita dentro de Ventas (V11). Si el volumen de
contenido de V11 resulta demasiado denso al escribir el guion completo,
separar "Precios" en un V11-B es la corrección más chica: queda anotado en
Decisiones Pendientes de Pablo.

## NIVEL 4 — Operar

**Qué logra:** el trabajo del día a día — documentos, ventas, compras,
dinero, stock.
**Videos:** V09, V10, V11, V12, V13, V14.
**Conocimientos adquiridos:** documento vs. comprobante; dirección
(COMPRAS/VENTAS) y por qué no se deduce sola; ciclo comercial completo;
ciclo de compras completo; caja/bancos/cheques; existencias por depósito.
**Ejercicio práctico:** subir un documento de prueba y registrar su
comprobante.
**Criterio de fin de nivel:** un comprobante propio, en estado `IMPUTADO`.

## NIVEL 5 — Contabilidad

**Qué logra:** de la propuesta al asiento aprobado, y todo lo que rodea al
cierre.
**Videos:** V15, V16, V17, V18, V19, V20.
**Conocimientos adquiridos:** propuesta vs. asiento; borrador vs.
aprobado; Debe/Haber explicado con el ejemplo real del comprobante propio;
contraasiento; bloquear/cerrar/reabrir período; amortización; costo de
mercadería vendida.
**Ejercicio práctico:** aprobar el asiento propio y verlo en el Mayor.
**Criterio de fin de nivel:** un asiento propio, `APROBADO`, visible en el
Mayor — el mismo hito que ya está verificado en producción para la cuenta
de prueba.

## NIVEL 6 — Gestión

**Qué logra:** leer lo que NEXO ya calculó, y ver el negocio más allá del
asiento.
**Videos:** V21, V22, V23, V24, V28, V30.
**Conocimientos adquiridos:** Diario/Mayor/Balance como tres vistas del
mismo dato; subdiario de IVA; estados contables; bitácora de auditoría;
proyectos y sucursales; comisiones; plan y suscripción de NEXO.
**Ejercicio práctico:** bajar el Balance de sumas y saldos en CSV y
explicar de dónde sale un número.
**Criterio de fin de nivel:** puede leer un Balance sin ayuda y ubicar el
asiento que originó una fila.

## NIVEL 7 — Inteligencia / funciones avanzadas

**Qué logra:** lo que NEXO puede contestar solo, sus límites reales, y el
cierre del curso.
**Videos:** V25, V26, V27, V29, V31.
**Conocimientos adquiridos:** Preguntar (catálogo cerrado, no chat libre);
Panorama y Riesgos; Señales y simulación de escenarios; por qué toda
propuesta de IA pasa hoy por revisión humana; migración desde otro
sistema; el circuito entero, sin cortes.
**Ejercicio práctico:** simular un escenario y comparar el resultado
medido contra lo esperado.
**Criterio de fin de nivel:** es autónomo — puede recorrer una operación
entera, de documento a Mayor, sin mirar el manual.

## Resumen de mapeo (31 videos → 7 niveles)

| Nivel | Videos | Cantidad |
|---|---|---|
| 1 · Conocer NEXO | V01, V02*, V03 | 3 |
| 2 · Crear y configurar empresa | V02*, V04, V07, V08 | 4 |
| 3 · Cargar datos base | V05, V06 | 2 |
| 4 · Operar | V09, V10, V11, V12, V13, V14 | 6 |
| 5 · Contabilidad | V15, V16, V17, V18, V19, V20 | 6 |
| 6 · Gestión | V21, V22, V23, V24, V28, V30 | 6 |
| 7 · Inteligencia | V25, V26, V27, V29, V31 | 5 |

*V02 cubre dos niveles (crea la empresa Y carga el plan/ejercicio) — se
cuenta una vez en el video, dos veces en el mapa de conocimientos, porque
es lo que realmente enseña.

31 videos, 32 asignaciones (V02 aparece en dos niveles) — consistente.
