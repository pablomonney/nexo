# NEXO_RELEASE_READINESS

**Medido:** 2026-09-08, contra el árbol de trabajo, la base de desarrollo y la
suite completa. El censo está en [`NEXO_CURRENT_BASELINE.md`](NEXO_CURRENT_BASELINE.md).

Este archivo contesta una sola pregunta: **¿qué impide poner esto delante de una
empresa que paga?** Todo lo demás —lo que está bien, lo que falta y no bloquea,
lo que se hará después— vive en el baseline y en el roadmap.

---

## La respuesta corta

**Falta cobrar y falta mandar un correo.** El sistema contable, el fiscal, el
multiempresa y la auditoría están; el ciclo de facturación está entero salvo la
pasarela; el registro de decisiones y la detección de alertas están.

Lo que no está es la última milla comercial, y **casi nada de eso es código**:

```
     precios          ← una decisión, no cuesta dinero
     pasarela         ← contratar
     correo           ← contratar
     certificado ARCA ← trámite del contribuyente
     hosting          ← contratar, con jurisdicción
```

Cinco cosas. Dos de ellas —los precios y la elección de proveedores— dependen de
alguien que decida, no de alguien que programe.

---

## BLOCKERS — impiden salir

| | Qué falta | Quién lo destraba | Qué queda bloqueado detrás |
|---|---|---|---|
| **B-1** | **Precios de los planes** | Decisión comercial | Sin precio no se emite un cargo, y sin cargo no hay cobranza ni MRR. Es el más barato de destrabar y el que más traba |
| **B-2** | **Pasarela de pago** | Contratar | Solo entra lo que se registra a mano. `intentarCobro` devuelve `SIN_PASARELA` |
| **B-3** | **Proveedor de correo** | Contratar | El alta autoservicio no se completa sola; no hay recuperación de contraseña ni aviso previo a una suspensión |
| **B-4** | **Gestor de secretos** | Elegir y contratar | Un secreto **por empresa** no se puede resolver: `env:` se niega y no hay otro backend. Sin esto no hay ARCA de producción multiempresa |
| **B-5** | **Certificado ARCA de producción** | Trámite del contribuyente | Emisión fiscal real. Hoy anda homologación |
| **B-6** | **Hosting y jurisdicción** | Contratar | Son datos contables de terceros: dónde viven no es un detalle |

**Ninguno de los seis se resuelve escribiendo código**, y esa es la conclusión
principal de esta auditoría. La arquitectura de los cuatro primeros está hecha y
probada del lado de acá de la interfaz; lo que falta del otro lado es una cuenta.

---

## HIGH — no impiden salir; hacen que salir sea caro

| | Qué | Por qué importa |
|---|---|---|
| **H-1** | **Documentos en disco local** | `FilesystemDocumentStore` no tiene versionado ni object-lock y **no funciona con más de una réplica**. SECURITY.md §6 promete object storage: hoy no es cierto |
| **H-2** | **Dos módulos deciden lo contrario sobre la misma amenaza** | `arca/credential-store.ts` se niega a usar una KEK del entorno en producción y `auth/crypto.ts` la exige. Las dos no pueden ser correctas |
| **H-3** | **La consola no es la interfaz definitiva** | Está declarado en `apps/web/README.md`. 316 endpoints y 35 secciones es mucho producto para una consola técnica de un archivo |
| **H-4** | **Backups sin agendar** | Los scripts existen y nadie los corre. Un backup no probado no cuenta como backup |
| **H-5** | **Escalado horizontal** | Dos cosas viven en memoria por proceso: los contadores de métricas y la ventana del límite de intentos. Con réplicas, el límite efectivo se multiplica |
| **H-6** | **NEXO no lleva su propia contabilidad** | Sin eso no hay CAC, LTV, margen por plan, burn ni runway. Ninguno se puede inventar |

---

## MEDIUM — deuda aceptable, anotada

| | |
|---|---|
| `audit_findings` sin escritor: los hallazgos se derivan y no tienen dónde registrar que alguien los revisó |
| 17 estados muertos en los `CHECK`, clasificados y no removidos |
| Dos series `S-*` que se pisan (TESTING_STRATEGY §2.7) |
| Base de desarrollo sin datos de negocio: el conteo del restore va SIN EJERCITAR |
| `norm_candidates_pendientes` sin `security_invoker` — verificado inofensivo, queda por coherencia |
| RRHH no existe. Está en la visión y no en el repositorio |

---

## LOW — mejoras

Onboarding guiado completo (empresa → datos fiscales → plan → importación en un
flujo). Forecasting con horizonte y versión de modelo registrados. Recomendación
automática en el Decision Engine. CRM y pipeline propios de NEXO. Soporte con
SLA.

---

## EXTERNAL — lo que depende de un tercero

Los seis blockers, más: la evaluación legal del registro de IP en la bitácora
(§21 del pliego), y los plazos de conservación documental, que condicionan dónde
puede alojarse el almacén.

---

## Contra la definición de «listo para mercado» (§71)

| | |
|---|---|
| Una empresa puede registrarse | 🟡 Se registra; **no se confirma sola** sin correo |
| Puede crear su organización | ✅ |
| Puede crear usuarios | ✅ Con roles, permisos y MFA obligatorio por rol |
| Puede operar | ✅ Ventas, compras, stock, tesorería, contabilidad, fiscal |
| Sus datos están aislados | ✅ 118 tablas con RLS forzado, **0** con `company_id` sin RLS, barrido por endpoint |
| Puede usar los módulos principales | ✅ |
| Puede contratar un plan | 🟡 Se declara; **sin precio** no se factura |
| Puede pagar | 🔴 Solo por transferencia registrada a mano |
| Recibe su comprobante | 🔴 Bloqueado por el certificado de producción |
| Puede cancelar | ✅ Con motivo, y sin volver atrás |
| El sistema conserva historial | ✅ Bitácora encadenada por hash, `UPDATE`/`DELETE` revocados |
| El sistema soporta errores | ✅ Reintentos, idempotencia, degradación declarada |
| Existe soporte | 🔴 No hay tickets ni SLA |
| Existe auditoría | ✅ 155 acciones registradas, motivo obligatorio donde importa |
| Existe seguridad | ✅ Ver abajo |
| Existe backup | 🟡 Scripts sí, agenda no, restore probado no |
| Existe observabilidad | 🟡 Logs estructurados, `/metrics`, `/health/db`. Sin destino ni trazas |
| Los tests críticos pasan | ✅ 2.209 tests, 143 archivos, verde |
| No hay blockers críticos conocidos | 🔴 Los seis de arriba |

**Nueve de diecinueve en verde no significa 47 % de producto.** Las que faltan se
concentran en una sola zona —cobrar y avisar— y las que están cubren lo que un
sistema contable no puede tener mal.

---

## Seguridad: qué se intentó romper

El §38 pide intentar romperlo deliberadamente. Se hizo, y en esta vuelta
**encontró cosas**:

| Intento | Resultado |
|---|---|
| Escribir en facturación desde la aplicación | 🔴 **Funcionaba.** Tres archivos afirmaban «solo SELECT» y la 0009 concede escritura sobre toda tabla nueva. Corregido (0097–0098) y convertido en control (S-29) |
| Correr la detección de alertas como usuario de solo lectura | 🔴 **Funcionaba.** Pedía el permiso equivocado. Corregido |
| Leer los cargos de otra empresa | ✅ RLS `FORCE`, verificado con el rol de la aplicación puesto |
| Leer las métricas del negocio desde la aplicación | ✅ Revocado y comprobado contra el catálogo (S-30) |
| Leer la bandeja de correo —que contiene tokens— | ✅ `INSERT` sí, `SELECT` no |
| Cobrar dos veces con la misma clave de idempotencia | ✅ Imposible: `UNIQUE` |
| Registrar un cobro dos veces por reintento | 🔴 **Contestaba «no cobrable»**, que empuja a intentarlo de otra forma. Corregido |
| Guardar datos de tarjeta | ✅ No hay columna, comprobado contra el esquema |
| Enumerar cuentas por el alta autoservicio | ✅ Misma respuesta exista o no |
| Usar dos veces un token de verificación | ✅ Se consume |

Y dos que encontraron los barridos por su cuenta: una comparación de escenarios
cuyo **signo dependía del orden físico de la tabla**, y un paquete entero
—`@aai/secrets`— que estaba escrito, testeado y verde **sin estar en el
repositorio**, por una regla de `.gitignore` sin anclar.

---

## Lo que este documento no dice

No dice que el sistema esté terminado. Dice qué **impide cobrarle a la primera
empresa**, que es otra pregunta y la que corresponde antes de vender.

Tampoco declara verde nada que no se pueda demostrar. Cada 🟡 de arriba tiene
escrito en su documento qué le falta y de quién depende: `NEXO_BILLING.md` §10,
`SECURITY.md` §5, `NEXO_CORPORATE.md` §6, `docs/DESPLIEGUE.md` §4.
