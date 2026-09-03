# NEXO_ROADMAP

**Recalculado:** 2026-09-02, después de medir. El censo está en
`NEXO_EVOLUTION_BASELINE.md`; esto es lo que sigue y por qué en ese orden.

Regla de este archivo: **cada línea dice qué la destraba**. Una prioridad sin eso
es una lista de deseos.

---

## Terminado en esta vuelta

| | Qué cerró |
|---|---|
| 0082 | Orden de pago — «pagada» exige el asiento imputado a cada comprobante |
| 0083 | La nota de crédito dice qué factura corrige |
| 0084 | El margen entra en las señales: hecho sin umbral, juicio con umbral |
| 0085 | Solicitud de compra — el último módulo LIBRE |
| 0086 | El promedio se calcula al escribir: 25 s → 44 ms con 50.000 movimientos |
| 0087 | Escenarios guardados: se guarda la pregunta, no la respuesta |
| — | NEXO Intelligence: doce preguntas con evidencia, narración verificada |
| — | Variación del margen abierta en precio, costo y volumen |
| — | Radar de riesgos: seis frentes, con lo que no se puede medir |

## Terminado el 2026-09-03 — el barrido S-16, hasta el final

S-16 («cada motor tiene quién lo use») se estrenó con **veintidós** funciones
exportadas sin consumidor. El barrido además se equivocaba: contaba como uso una
mención en un comentario, y así se le escapaba el Diario resumido entero.
Corregido eso, la lista quedó en cero salvo cuatro excepciones, cada una con qué
la destraba. Qué pasó con cada una:

**Conectadas — la pieza existía y nadie recorría el camino:**

| Pieza | Dónde se conectó |
|---|---|
| `resumirPorMes`, `resumenCoincideConDetalle`, `comoSubdiarioDeclarado` | `GET /books/diario-resumido` — el art. 327 completo, verificado contra el hash del subdiario emitido |
| `verificarActa`, `totalesPorTipo` | `GET /banks/reconciliations/:id/verificar` |
| `saldosPorNaturaleza` | `GET /books/mayor` — el cruce contra el balance de sumas y saldos |
| `bloqueaAprobacion`, `bloqueaImputacion` | La respuesta de documentos dice si se puede aprobar e imputar, en vez de dejar la conclusión a cada pantalla |
| `citaHabilitaAplicacion`, `renderizarCita`, `normasCitables` | Una norma que no es V1 con documento archivado ya no entra al contexto del modelo |
| `hechosDeAfectacion` + `evaluar` | Las condiciones de una regla **se evalúan** al decidir; antes una regla vigente se daba por aplicada sin mirar su AST |
| `leerHabilitacion` | `GET /companies/current/arca/capabilities` — aparece `VENCIDO`, que la ruta no distinguía |
| `aSelloFiscal`, `bloqueaAprobacionAutomatica` | La constatación devuelve el sello del motor: en ambiente simulado dice que no tiene valor probatorio |
| `promptPorHash`, `admiteAprobacionEnLote` | `GET /predictions` — y la pantalla de revisión, que tampoco existía |
| `desambiguarPorControl` | La extracción resuelve un total ambiguo con la aritmética del propio comprobante |
| `multiplyByRate` | `tax-engine` tenía una **segunda implementación** del mismo redondeo |

**Borradas — eran una segunda forma de hacer algo que el sistema ya hace:**
`saldosDeCierre` (el arrastre sale del cierre archivado, por diseño),
`siguienteNumero` (numera la base), `CatalogoSemilla` y su puerto (el tipo de
comprobante se resuelve contra `arca_comprobante_types`, por fecha), y trece
primitivas de `@aai/shared` que solo usaban sus propios tests.

**Y el barrido siguiente, S-17 — tablas sin escritor.** El mismo defecto un piso
más abajo: 140 tablas, 21 sin un solo `INSERT` fuera de los tests. Dos eran un
hueco de producto y se cerraron —`bank_accounts` y `bank_statement_layouts`: el
módulo de bancos entero empezaba en dos filas que solo se podían crear por SQL, y
la consola pedía el `layoutId` escrito a mano sin que hubiera de dónde sacarlo—.
Las diecinueve restantes quedaron declaradas con qué las destraba: siete son el
Normative Update Service del §32, dos son deuda ya registrada (`alerts`,
`audit_findings`), tres esperan una decisión de producto (`plan_limits`,
`profit_centers`, `confidence_policies`) y el resto son estructuras que el diseño
resolvió de otra forma —derivando en vez de guardar— y sobran en el esquema.

**Efectos colaterales que valen por sí solos:** `vat_books.compras_sha256` y
`ventas_sha256` existían desde la 0021 con su motivo escrito y **ningún INSERT**
las llenaba; ahora las escribe la generación del libro, y el Diario resumido las
verifica. La pantalla de revisión de propuestas de IA no existía: la bandeja
mandaba ahí y contestaba que no había pantalla.

## Terminado el 2026-09-03 — S-21: la capa de agentes, medida

El mismo defecto una vez más, y esta vez donde más engaña. `AI_ARCHITECTURE.md`
§3 lista **ocho agentes** y el `CHECK` de `ai_predictions.agent` acepta los ocho
nombres. Corre **uno**: `CLASSIFICATION`.

Un `CHECK` se lee como un inventario, y este afirmaba siete capacidades que no
existen. Peor: los ocho nombres están escritos en la unión `AgentName`, así que
cualquier barrido ingenuo que buscara el literal habría dado ocho de ocho y
confirmado la ilusión. `S-21` descarta las líneas que **solo declaran** el
nombre y pide que quede una ejecución real.

Los siete quedaron declarados con qué los destraba, y agrupan en tres formas
distintas —que no son intercambiables—:

| Forma | Cuáles | Qué falta de verdad |
|---|---|---|
| El trabajo ya está hecho sin modelo | `RECONCILIATION`, `TAX`, `FINANCIAL_ANALYSIS`, `NOTES` | Nada de la capacidad. Falta la propuesta con confianza y cita — y ponerlas a **calcular** sería un retroceso (ADR-017) |
| Falta el proveedor de modelo | `DOCUMENT`, y la narración de `FINANCIAL_ANALYSIS` | Una credencial de un tercero (§P1.2) |
| Falta la materia prima | `NORMATIVE_RESEARCH`, `AUDIT` | El corpus normativo (§32) y decidir si un hallazgo es una fila o una derivación |

**Lo que este barrido confirmó, y vale decirlo:** los controles anti-alucinación
del §4 no son una tabla en un documento. Una cita a una norma que no está en
`norm_versions` rechaza la propuesta y la registra en `ai_rejections` con
`es_alucinacion`, y hay tests que lo ejercitan en las dos direcciones.

## P0 — Integridad

**Nada abierto.** RLS completo con `FORCE` en 107 tablas, Mayor sin
discrepancias, bitácora íntegra, `verify` en verde. El rendimiento crítico se
midió y se corrigió.

## P1 — Lo que se puede construir hoy

### ~~1. Medir el resto de las vistas con volumen~~ — hecho

El generador ahora carga terceros y comprobantes además de stock. Con 12.000
comprobantes la bandeja pasa de 229 ms a **416 ms**, y pedirle una página cuesta
**540 ms**. Ninguna vista pasa de un segundo.

Lo que queda como vigilancia, no como tarea: la bandeja es la pantalla más
visitada y la más cara. Si el volumen crece un orden de magnitud, es la primera
que hay que volver a medir.

### 2. El adaptador de un proveedor de modelo

Todo el camino de la narración está cerrado y probado con el simulado. Falta un
archivo que implemente `LLMProvider`.

**Qué lo destraba:** una credencial de un tercero. Hasta que exista, declarar la
integración sería declarar algo que no se puede ejercitar.

### ~~3. Más preguntas en el catálogo~~ — hecho

De doce a **dieciocho**: cobranzas, cheques, productos más vendidos, proyectos,
comisiones y sucursales. Cubren todos los módulos del ERP que producen
analítica, y un barrido las corre todas en cada verify.

Y se agregó lo que faltaba del otro lado: cinco temas **fuera de alcance** que se
contestan con su motivo —RRHH, retenciones, impuesto a pagar, pronóstico y
consejo profesional— en vez de con la pregunta más parecida.

## P2 — Producción

| | Qué falta | Qué lo destraba |
|---|---|---|
| KMS | El cliente que pide SECURITY.md §5 | Elegir proveedor de KMS: **decisión** |
| ARCA producción | Certificado y credenciales reales | Trámite del cliente |
| Alta autoservicio | Verificación por correo | Proveedor de correo |
| Cobro de la suscripción | Pasarela | Credenciales y decisión de precios |
| Web comercial | — | Que haya un flujo honesto de «probar NEXO» |

Ninguno de los cinco se resuelve escribiendo código.

## P3 — Decision Engine

El ciclo está cortado después de «qué pasaría si». Ver
`NEXO_DECISION_ENGINE.md` §3: recomendar exige un objetivo declarado por la
empresa; medir el resultado de una decisión exige poder declarar que un
escenario se aplicó.

**Qué lo destraba:** una decisión de producto sobre cómo se declara un objetivo,
y otra sobre qué significa «aplicar» un escenario. Ninguna es técnica.

## P4 — ERP: lo que falta y por qué

| | Estado | Qué lo destraba |
|---|---|---|
| Retenciones y percepciones | BLOQUEADO | Archivar los regímenes y sus normas |
| Libro IVA Digital (exportar) | BLOQUEADO | Los diseños de registro no están en la RG |
| FIFO y costo de reposición | PLANIFICADO | Decisión contable (ADR-020) |
| Remitos y facturación parcial | REQUIERE_DECISION | Si NEXO admite facturar en partes y con qué reglas |
| Devoluciones | REQUIERE_DECISION | Depende de la anterior |
| Descuentos por regla | REQUIERE_DECISION | Una lista tiene precios, no reglas |
| Producción | REQUIERE_DECISION | Absorción de costos indirectos |
| RRHH | REQUIERE_DECISION | ADR-012 §8 |
| Momento de asentar el CMV | REQUIERE_DECISION | El asiento ya se **propone** (0079); automatizar cuándo es política contable |
| Qué guarda `constatacion` en ambiente `mock` | REQUIERE_DECISION | Ver abajo |
| Qué permiso exige guardar un escenario | REQUIERE_DECISION | Ver abajo |
| Intentar la consulta con el relevamiento vencido | REQUIERE_DECISION | Ver abajo |

### Qué guarda `constatacion` cuando ARCA está simulado

`aSelloFiscal` clasifica un resultado del ambiente `mock` como `NO_VERIFICABLE`
—«este resultado NO proviene de ARCA y no tiene valor probatorio»—, y la
traducción que se guarda en `tax_transactions.constatacion` dice `OK`. Desde
2026-09-03 la respuesta de `POST /tax-transactions/:id/constatar` muestra las
dos y avisa que no coinciden; la columna no cambió.

- **Alternativa A — guardar el sello.** En desarrollo ninguna operación queda
  constatada, así que el circuito comprobante → decisión → asiento no se puede
  recorrer entero sin ARCA real: `decidir` exige sello aprobado. Es lo más
  honesto y lo más caro.
- **Alternativa B — dejarlo como está.** La columna guarda la traducción y la
  respuesta avisa. El riesgo es una decisión `PRODUCTIVO` fundada en una
  constatación simulada, que hoy nada impide.
- **Alternativa C — negarse a constatar en `mock` salvo pedido explícito**, y
  que el circuito de desarrollo use `constatacionDeclarada`, que ya queda
  marcada como `DECLARACION_PROFESIONAL`.

No la tomo yo: cambia qué puede fundar un asiento.

### Qué permiso exige guardar un escenario

`POST /analysis/scenarios` y su `archive` piden `analysis:read`, que la 0058 le
dio a **todos** los roles: un usuario de `SOLO_LECTURA` puede crear y archivar
escenarios. Lo encontró S-18, que barre todas las rutas de escritura con un
usuario de lectura.

Un escenario guarda la pregunta y nunca el resultado, así que no afirma ninguna
cifra. Pero es una fila con nombre que el resto de la empresa ve en una lista.

- **Alternativa A — dejarlo.** Guardar una pregunta es parte de consultar.
- **Alternativa B — exigir `analysis:configure`** (hoy de ADMINISTRADOR y
  CONTADOR), que es el permiso de declarar umbrales: la misma idea de «esto lo
  fija alguien que responde por ello».
- **Alternativa C — un permiso nuevo** `analysis:write`, con su migración y su
  reparto por rol.

Es una decisión de producto sobre quién deja rastro en los datos de la empresa.

### Intentar la consulta con el relevamiento vencido

`permiteIntentar` (motor) dice que `VENCIDO`, `NO_RELEVADO` y `NO_VERIFICABLE`
**no** frenan el intento: no saber no es motivo para no preguntar. El
`DbCapabilityStore` de la API falla cerrado: sin `enabled = true` no se
consulta. Las dos políticas están escritas y son opuestas.

- **Alternativa A — adoptar la del motor.** Se consulta y el organismo contesta;
  el resultado es justamente el dato que falta. Riesgo: insistir contra un
  servicio no delegado es cómo un CUIT termina bloqueado por ARCA.
- **Alternativa B — mantener la de la API** y borrar `permiteIntentar`, o
  reducirlo a describir estados sin decidir.

Depende de cuánto riesgo de bloqueo acepta el estudio: es del contribuyente,
no del sistema.

## Deuda registrada

| | Gravedad |
|---|---|
| KMS ausente: sin él no hay producción con ARCA real | IMPORTANTE |
| 17 estados muertos en los CHECK, clasificados y no removidos | MENOR |
| `alerts` y `audit_findings` sin escritores | MENOR |
| Dos series `S-*` que se pisan (documentado en TESTING_STRATEGY §2.7) | MENOR |
| Base de desarrollo sin datos de negocio: el conteo del restore va SIN EJERCITAR | MENOR |

## Cómo se decide qué sigue

1. Si hay algo **medido** que está mal, eso primero. La 0086 salió así.
2. Si hay una pieza construida **sin consumidor**, cerrarla vale más que
   empezar otra. La capa de inteligencia salió así.
3. Si algo está bloqueado por un tercero, se documenta y se sigue con otra cosa.
   Nunca se detiene todo por un bloqueo.
4. Si una decisión es contable, fiscal o de producto, **no se inventa**: se
   anota como `REQUIERE_DECISION` y el trabajo independiente continúa.
