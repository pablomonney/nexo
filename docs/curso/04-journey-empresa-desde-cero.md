# Fase 4 — Journey "Empresa desde cero"

Base real: `docs/GUIA-PRIMEROS-30-MINUTOS.md` (12 pasos, verificados en
producción) + `scripts/factura-demo.mjs` (el mismo recorrido, reproducible,
en local) + los 24 puntos pedidos en el brief. Donde el brief pide un paso
que el producto real no separa en una pantalla propia, lo digo explícito en
vez de inventar una.

| # | Paso pedido | Pantalla real | Acción | Prerequisito | Resultado esperado | Estado real | Verificado |
|---|---|---|---|---|---|---|---|
| 1 | Crear/acceder a empresa | «Crear mi empresa» (aparece sola tras el login) | Completar datos + plan → «Crear y empezar la prueba» | Cuenta con MFA | Panel con «Puesta en marcha: 2 cosas impiden registrar» | Existe | 🟢 Producción |
| 2 | Configuración inicial | Panel → «Puesta en marcha» | — (es el mismo bloque que guía todo lo que sigue) | Empresa creada | Lista de lo que falta, con su botón cada una | Existe | 🟢 Producción |
| 3 | Usuarios/roles | Configuración → «Dar un rol» | Elegir persona + rol CONTADOR → «Dar el rol» | Empresa creada | «Rol otorgado.» | Existe | 🟢 Producción |
| 4 | Plan de cuentas | Panel → «Usar este plan» | Un clic | Empresa creada | 185 cuentas imputables cargadas | Existe | 🟢 Producción |
| 5 | Ejercicio | Períodos y cierre → «Abrir un ejercicio» | Código, desde, hasta → «Abrir el ejercicio» | Empresa creada | Ejercicio `ABIERTO`, 12 períodos | Existe | 🟢 Producción |
| 6 | Períodos | Períodos y cierre | (se crean junto con el ejercicio, paso 5) | Ejercicio abierto | 12 períodos listados, el actual `ABIERTO` | Existe | 🟢 Producción |
| 7 | Configuración fiscal | Configuración → «Cargar un certificado» | Certificado ARCA → guardar | Rol con `arca_credential:manage` | Servicios habilitados visibles | Existe | 🟡 No verificado en esta prueba |
| 8 | Terceros | Ventas → Terceros → «Dar de alta» | Documento, razón social, IVA, contacto | Empresa creada | Tercero listado | Existe | 🟡 No verificado en esta prueba puntual¹ |
| 9 | Productos | Ventas → Productos → «Dar de alta» | Código, nombre, unidad, impuesto | Empresa creada | Producto listado | Existe | 🟡 No verificado en esta prueba puntual¹ |
| 10 | Sucursales | Operación → Sucursales | Alta de sucursal | Empresa creada | Sucursal listada | Existe | 🟡 No verificado |
| 11 | Mapeo contable | Configuración → Mapeo contable | Rol + cuenta → «Declarar», 6-8 veces | Plan de cuentas cargado | Aviso «Está completo.» | Existe | 🟢 Producción |
| 12 | Primera compra | Compras → Solicitudes → Recepciones → Pagos | Solicitud → recepción → orden de pago | Terceros, productos | Comprobante de compra registrado | Existe | 🟡 Verificado por test, no en esta prueba |
| 13 | Primera venta | Operación → Documentos → Operaciones | Subir XML → registrar comprobante | Mapeo declarado | Comprobante VENTA registrado | Existe | 🟢 **Producción** — VENTA 1-1-102, $123.420 |
| 14 | Caja/banco si corresponde | Dinero → Caja / Bancos | Apertura de caja o alta de cuenta bancaria | Empresa creada | Caja/cuenta listada | Existe | 🟡 No verificado en esta prueba |
| 15 | Generación de propuesta | Operación → Operaciones → «Ver la propuesta» | Clic | Comprobante registrado + mapeo declarado | 3 renglones balanceados, Debe = Haber | Existe | 🟢 **Producción** — Debe=Haber=$123.420 |
| 16 | Carga de asiento | Operaciones → «Cargar como asiento en borrador» | Clic | Propuesta vista | Asiento en `PROPUESTO` | Existe | 🟢 **Producción** — `01a0c725-bc0d-7eea-944c-8cd1cf0fe3be` |
| 17 | Aprobación | Libros → Asientos → «Aprobar» | Clic | Asiento en `PROPUESTO`, rol `journal_entry:approve` | Asiento en `APROBADO` | Existe | 🟢 **Producción** |
| 18 | Mayor | Libros → «Mayor» | — | Asiento aprobado | Los 3 renglones proyectados | Existe | 🟢 **Producción** — verificado renglón por renglón |
| 19 | Diario | Libros → «Diario» | — | Al menos un asiento | Asiento listado con su número | Existe | 🟡 No verificado por separado² |
| 20 | Balance | Libros → «Balance» | — | Al menos un asiento aprobado | Debe = Haber en verde | Existe | 🟡 No verificado por separado² |
| 21 | Cierre/período | Períodos y cierre → «Cerrar» / checklist de pre-cierre | Motivo → cerrar | Todo lo pendiente del ejercicio resuelto | Ejercicio `CERRADO`, acta disponible | Existe | 🟡 Verificado por test |
| 22 | Reportes | Libros → Estados y notas / Exportar CSV | «Armar el estado» / «Bajar … (CSV)» | Marco de reporte declarado (para estados) | Estado contable armado / CSV descargado | Existe | 🟡 No verificado |
| 23 | Indicadores/gestión | Análisis → Analítica | — | Datos operando | Indicadores calculados | Existe | 🟡 No verificado |
| 24 | Funciones avanzadas | Inicio → Preguntar / Análisis → Señales | Elegir pregunta del catálogo / simular escenario | Datos operando | Respuesta o simulación | Existe | 🟡 No verificado |

**¹** El comprobante VENTA 1-1-102 necesitó un tercero y un producto ya
existentes al momento de la prueba — la propuesta balanceada lo confirma
indirectamente — pero el flujo de alta en sí (clic en «Dar de alta», llenar
el formulario) no fue lo que se observó en esta prueba puntual. Es una
distinción honesta, no una duda sobre si terceros/productos funcionan (hay
195 archivos de test y evidencia extensa de que sí).

**²** El Mayor sí se verificó fila por fila (paso 18); Diario y Balance
muestran el mismo asiento desde otra vista y no hay motivo técnico para
dudarlo, pero no se pidió explícitamente su pantalla durante la prueba del
2026-09-22 — por eso quedan en 🟡 y no en 🟢, siguiendo la regla de
veracidad del brief.

## Lectura del journey completo

De los 24 pasos, **12 están verificados en producción con evidencia
concreta** (1, 2, 3, 4, 5, 6, 11, 13, 15, 16, 17, 18). Los otros 12 existen y
tienen código, pantalla y test, pero nadie los recorrió todavía en
producción durante esta prueba —
eso no los invalida, solo dice qué evidencia falta si se quiere subir el
nivel de confianza antes de grabar cada video correspondiente.

Ningún paso de los 24 es inexistente. No hubo que inventar ni omitir
ninguno.
