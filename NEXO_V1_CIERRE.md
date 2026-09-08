# NEXO — MATRIZ DE CIERRE V1

**Medido:** 2026-09-08, contra el repositorio, la base y la suite completa.
**Método:** catálogo de PostgreSQL, `routeTable` del servidor, `npm run verify`,
y **una auditoría visual del producto corriendo** — que es la que encontró lo
que la lectura del código no.

---

## La respuesta que no querés oír, primero

**NEXO no es un producto terminado V1, y la distancia no es chica.**

El motor está. Lo que falta es casi todo lo que hay **entre el motor y la
persona**, y una decisión tuya sobre cuánto abarca V1.

Tres hechos que solos alcanzan para no poder declarar 🟢:

1. **No existe una interfaz definitiva.** Hay una consola técnica de un archivo
   de 10.524 líneas, con 91 líneas de CSS para 35 pantallas y 319 endpoints. Es
   competente y coherente —tiene tokens, modo oscuro, roles semánticos de
   color— y **no parece un producto que una pyme paga**. Parece lo que es: una
   herramienta interna.
2. **No existe identidad visual.** No hay logo, no hay isotipo, no hay favicon.
   El `<h1>` es la palabra «NEXO» con letter-spacing. La tipografía es Segoe UI,
   la que trae el sistema operativo.
3. **El ciclo comercial no se completa sin una persona del otro lado.** No hay
   proveedor de correo ni pasarela contratados. Tu propio §32 dice «sin
   intervención manual para procesos normales».

Y un cuarto que encontré auditando visualmente, ya corregido: **la navegación
con los 34 módulos estaba a la vista en la pantalla de ingreso.** Tenía el
atributo `hidden` puesto y se veía igual, porque `nav{display:flex}` le ganaba a
la hoja del navegador. En el DOM decía `hidden`. Leyendo el HTML estaba bien.

---

## 1. Lo que sí está terminado

No para consolar: para que no se vuelva a auditar.

| | Estado |
|---|---|
| Motor contable, fiscal, bancario, de estados | **COMPLETO** — umbral propio de cobertura del 95 % en cada uno |
| Multiempresa | **COMPLETO** — 118 tablas con RLS `FORCE`, 0 con `company_id` sin RLS, barrido sobre los 319 endpoints |
| Autenticación, roles, permisos, MFA | **COMPLETO** — 101 permisos, 6 roles, MFA obligatorio por rol |
| Auditoría | **COMPLETO** — 158 acciones, cadena de hash, `UPDATE`/`DELETE` revocados en el rol |
| Ciclo de facturación | **COMPLETO en código** — período, documento, cobro, cobranza, suspensión, prorrateo, idempotencia |
| Prueba de 14 días | **COMPLETO** — con vencimiento real y conversión |
| Planes, precios, topes, matriz | **COMPLETO** |
| Alta autoservicio | **COMPLETO en código** — estudio + empresa + rol + prueba en una transacción |
| Puerto de correo con bandeja de salida | **COMPLETO en código** — falta el proveedor |
| Registro de decisiones y calibración | **COMPLETO** |
| Métricas SaaS | **COMPLETO** |
| Suite | **2.238 tests, 145 archivos, verde**; 435/435 objetos estructurales |

---

## 2. La matriz

### BLOCKER V1 — sin esto no se puede llamar terminado

| Área | Estado actual | Qué falta | Tipo | Responsable |
|---|---|---|---|---|
| **Identidad visual** | No existe | Logo, isotipo, favicon, paleta oficial, tipografía, iconografía, escala de espaciado | **CÓDIGO** + **DECISIÓN** (aprobar la propuesta) | Claude propone, Pablo aprueba |
| **Design system** | 91 líneas de CSS, sin componentes reutilizables | Botones, campos, tablas, modales, alertas, tabs, estados vacíos, estados de carga, diálogos de confirmación | **CÓDIGO** | Claude |
| **Interfaz definitiva** | Consola técnica de un archivo | Rediseño de los flujos que un cliente recorre. **Cuánto abarca es una decisión tuya** — ver §4 | **CÓDIGO** + **DECISIÓN** | Pablo decide alcance, Claude construye |
| **Proveedor de correo** | Puerto y bandeja listos, sin proveedor | Contratar y cargar la credencial | **ACCIÓN DEL FUNDADOR** | Pablo |
| **Pasarela de pago** | `payment_intents`, eventos e idempotencia listos | Contratar, escribir el adaptador, exponer el webhook | **ACCIÓN DEL FUNDADOR** + **CÓDIGO** | Pablo contrata, Claude integra |
| **Hosting, dominio, SSL** | Nada | Contratar, con jurisdicción decidida | **ACCIÓN DEL FUNDADOR** | Pablo |
| **Backups agendados y restore probado** | Los scripts existen, nadie los corre | Agendar y **probar una restauración** | **ACCIÓN DEL FUNDADOR** | Pablo (con el hosting) |
| **Gestor de secretos** | 🟡 puerto listo, sin gestor | Elegir y contratar | **ACCIÓN DEL FUNDADOR** | Pablo |
| **Términos, privacidad, tratamiento de datos** | Checklist escrito, documentos no | Redacción profesional | **LEGAL** | Abogado |
| **Canal de contacto visible** | No existe | Una dirección en la app y en la landing | **CÓDIGO** (trivial) + **ACCIÓN** (la casilla) | Ambos |
| **Estados de carga y vacíos como sistema** | 2 estados de carga en toda la consola | Que cada tabla y cada panel diga qué está pasando | **CÓDIGO** | Claude |
| **Accesibilidad mínima** | 2 atributos `aria` en 10.524 líneas | Foco visible, etiquetas, contraste, navegación por teclado | **CÓDIGO** | Claude |
| **Responsive real** | 2 breakpoints; en pantalla angosta la navegación es una lista de 34 botones | Navegación agrupada, tablas que colapsan | **CÓDIGO** | Claude |
| **NEXO dentro de NEXO** | No existe | Dar de alta NEXO como empresa, cargar plan de cuentas, imputar gastos | **ACCIÓN DEL FUNDADOR** (datos) | Pablo |
| **Monitoreo con destino** | Hay `/metrics` y `/health/db` | Un destino que reciba, y alertas | **ACCIÓN DEL FUNDADOR** | Pablo |

### IMPORTANT — mejora mucho, no bloquea

| Área | Qué falta | Tipo |
|---|---|---|
| Datos demo | Empresa de demostración con operación real cargada | **CÓDIGO** |
| Seguimiento de errores | Un servicio que reciba las excepciones | **ACCIÓN DEL FUNDADOR** |
| Guion de demostración | Cómo se muestra NEXO en 15 minutos | **DECISIÓN** |
| Documentación de usuario | Hay documentación técnica; no hay de usuario | **CÓDIGO** |
| Exportaciones desde la interfaz | Varias existen y no tienen puerta | **CÓDIGO** |
| Rendimiento medido en rutas críticas | Solo está medida la valuación | **CÓDIGO** |

### FUTURO — no bloquea V1, y conviene decir por qué

| | Por qué no bloquea |
|---|---|
| Emisión de comprobantes con CAE | **NEXO no la promete.** La landing la lista en «en qué estamos trabajando» |
| Proveedor de modelo de IA | Lo que corre hoy es determinístico y se presenta como tal |
| Copiloto conversacional | Ídem |
| Siete de los ocho agentes | Declarados con qué los destraba; ninguno se anuncia |
| Recomendación automática | Necesita una función de preferencia tuya |
| Previsión con horizonte y versión de modelo | No se promete |
| RRHH | No está en ningún plan |
| SLA | No se puede prometer sin disponibilidad medida |
| Multi-región | Argentina primero |

---

## 3. Fiscal argentino — el estado exacto

| | Estado |
|---|---|
| Consulta de padrón (A5) | 🟢 **producción real** contra homologación, con firma WSAA verificada |
| Constatación de comprobantes (wscdcv1) | 🟢 ídem |
| Capacidades del contribuyente | 🟢 |
| IVA, subdiarios, libros | 🟢 |
| Tipos de comprobante, puntos de venta | 🟢 |
| Certificados por empresa | 🟡 se guardan cifrados; en producción el módulo **se niega** a usar una KEK del entorno |
| **Emisión con CAE** | 🔴 **fuera del MVP y aislada por el lint** — `packages/arca-emision` no es alcanzable desde `apps/` |
| QR | 🔴 hay especificación, no hay emisión que lo use |
| Certificado de producción | 🔴 **trámite del contribuyente** |

**Esto no bloquea V1 porque NEXO no promete emitir.** El día que lo prometa, sí.

---

## 4. La decisión que define el tamaño de V1

Ésta es la más importante de todo el archivo.

Los planes venden **19 grupos de funcionalidad** repartidos en **35 pantallas**.
Si «terminado V1» significa las 35 con calidad de producto, son **meses**. Si
significa que el cliente recorra con calidad de producto lo que efectivamente
usa, son **semanas**.

Yo propongo lo segundo, y con este corte:

**Núcleo del recorrido V1 — calidad de producto, sin excepción** (≈15 pantallas)

```
ingreso · alta · onboarding · inicio · terceros · productos
ventas · compras · stock · caja · bancos
IVA y comprobantes · asientos · libros y estados
configuración y usuarios · suscripción
```

**El resto** —proyectos, comisiones, CRM, activos, cheques, listas de precios,
sucursales, integraciones, analítica avanzada— entra a V1 **con el sistema de
diseño aplicado** pero sin rediseño de flujo. Funcionan, se ven consistentes, y
no pretenden ser más de lo que son.

**Y una alternativa que conviene mirar:** vender solo **Contable** y **Gestión**
en V1, y dejar Estudio, Empresa y Completo para V1.1. Reduce a la mitad lo que
hay que llevar a calidad de producto y no cambia una línea de código — es sacar
tres planes del catálogo.

**Necesito que elijas una de las tres.** Es la diferencia entre semanas y meses,
y no la puedo tomar yo.

---

## 5. Auditoría como cliente nuevo — el recorrido real

Lo hice. Esto es lo que pasa hoy:

| Paso | Qué pasa |
|---|---|
| Entra a la landing | ✅ Entiende qué es, ve los precios reales, ve qué incluye cada plan |
| Se registra | ✅ Funciona |
| **Confirma su correo** | 🔴 **El mensaje queda en una bandeja que alguien tiene que leer a mano** |
| Crea su empresa | ✅ Estudio + empresa + rol + prueba, en un pedido |
| Entra | ✅ |
| **Ve el sistema** | 🟠 34 botones de igual peso, sin agrupar, sin iconos, sin jerarquía. Tablas de 13 px |
| **Sabe qué hacer primero** | 🟠 Hay una pantalla «Puesta en marcha»; no hay un onboarding guiado |
| Carga su plan de cuentas | ✅ |
| Registra su primera venta | ✅ |
| Ve su información | ✅ Analítica, señales, margen abierto en precio/costo/volumen |
| **Paga** | 🔴 Solo transferencia registrada a mano |
| **Recupera su contraseña** | 🔴 Procedimiento manual |
| **Pide ayuda** | 🔴 No hay a dónde escribir |

**Siete de trece con problema, y los cuatro rojos son los bordes del negocio.**

---

## 6. Riesgos que no son técnicos

1. **El riesgo de terminar la interfaz sin decidir el alcance.** Si empezamos a
   rediseñar las 35 pantallas sin el corte de §4, el trabajo no termina nunca.
2. **El riesgo de la marca.** Puedo proponer una identidad completa, pero si
   después no te gusta, se rehace todo lo que se construyó encima. **Aprobá la
   identidad antes de que se aplique.**
3. **El riesgo de la demo.** Sin datos demo, mostrar NEXO exige cargar una
   empresa entera cada vez.
4. **El riesgo de creer que el código avanzado es producto avanzado.** Es
   exactamente el que este archivo intenta cerrar.
