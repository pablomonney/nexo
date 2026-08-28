# MVP.md — el circuito productivo, y qué falta para que lo use una persona

> Estado al commit de esta fase. Describe **lo que existe**, no lo que se
> planea. Cada afirmación de acá tiene un test detrás; las que no lo tienen
> están marcadas como gap.

## 1. El circuito, eslabón por eslabón

```
DOCUMENTO ──▶ TAX TRANSACTION ──▶ CONSTATACIÓN ARCA
                     │
                     ├──▶ AFECTACIÓN PROFESIONAL
                     │
                     └──▶ DECISIÓN ──▶ ASIENTO ──▶ DIARIO ──▶ MAYOR ──▶ ESTADOS
```

`tests/integration/circuito-mvp-e2e.test.ts` lo recorre entero **por HTTP**, sin
un solo `INSERT` directo, y termina comprobando que la regla
`AR-IVA-CF-VINCULACION-001.v1` sigue en DRAFT: el circuito se completa sin
activar nada.

| Eslabón | Ruta | Quién aporta el dato |
|---|---|---|
| Documento | `POST /documents` | el archivo; el sistema calcula hash y tipo |
| Operación fiscal | `POST /documents/:id/tax-transaction` | los importes los declara una persona; el sistema los cruza contra la extracción |
| Constatación | `POST /tax-transactions/:id/constatar` | **ARCA**, vía WSCDC |
| Afectación | `POST /tax-transactions/:id/afectacion` | una persona matriculada, con evidencia |
| Decisión | `POST /comprobantes/:id/decision` | el motor si hay regla; una persona si no |
| Asiento | `POST /journal-entries` + `/approve` | una persona, siempre |
| Libros y estados | `GET /books/*`, `POST /statements/issue` | derivados, sin intervención |

## 2. Las cuatro procedencias de un dato

El §11 pide distinguir validación fiscal, contable y económica. Para eso hace
falta que cada dato diga **de dónde salió**, y desde la migración `0043` lo dice:

| Procedencia | Qué significa | Dónde vive |
|---|---|---|
| `ARCA` | el organismo contestó, y la respuesta está archivada | `constatacion_origen` + `arca_query_id` |
| `DECLARACION_PROFESIONAL` | una persona lo afirma bajo su responsabilidad | `constatacion_por` + `constatacion_at`, o `tax_affectations.origen` |
| `SUGERIDA_POR_PRECEDENTE` | el sistema lo propone a partir del historial de la empresa | `tax_affectations.origen`; **excluida** de la vista que el motor consulta |
| `NO_CONSULTADO` / ausencia | nadie preguntó | el valor por defecto |

Antes de la `0043`, `constatacion` era un campo del cuerpo del pedido: un dato
verificado y uno afirmado se guardaban igual y después se veían idénticos. Un
comprobante apócrifo podía entrar como constatado, con su crédito fiscal detrás.

**Un candado que conviene conocer:** una declaración profesional no reemplaza una
respuesta de ARCA. Una vez que el organismo contestó, el trigger
`tax_transactions_constatacion_no_degrada` rechaza el cambio de procedencia.

## 3. Qué pasa hoy, con cero reglas ACTIVE

Es el estado real del producto y el circuito lo demuestra en vez de esquivarlo:

1. La vía determinística devuelve `REQUIERE_REVISION` y **nombra** qué falta.
2. Ninguna aplicación de regla se registra: no había ninguna que aplicar, y no se
   inventa.
3. Una persona puede resolver con una decisión `MANUAL`, que exige justificación
   escrita y que la base impide que cite reglas.
4. El asiento entra fundado en esa decisión, y la trazabilidad lo dice.

Un sistema que asentara igual inventaría un fundamento; uno que no asentara nunca
dejaría la contabilidad detenida esperando una fuente normativa. Ninguna de las
dos es aceptable.

## 4. Contrato del documento

`documents` exige: `company_id`, `storage_key`, `sha256`, `bytes`, `mime`,
`content_type`, `original_name`, `source`, `uploaded_by`. Todo lo demás lo pone
el sistema.

Lo que el documento **no** aporta hoy son los importes: sin motor de OCR real,
`NullOcrEngine` responde `SIN_MOTOR_OCR` —que es la verdad, y no «no se encontró
ningún campo»—. Por eso los importes se declaran y el sistema los cruza contra la
extracción cuando la hay, cortando si difieren.

**Qué falta para que una factura real entre sola al circuito:**

| Dato | De dónde debería salir | Estado |
|---|---|---|
| Tipo, punto de venta, número, fecha | del comprobante, por lectura | XML sí; PDF e imagen necesitan OCR |
| Importes (neto, IVA, total) | del comprobante, por lectura | ídem |
| CUIT del emisor | del comprobante | ídem |
| CAE y modalidad | del comprobante | ídem — hoy se pasan a mano al constatar |
| Autorización del comprobante | **ARCA** | conectado; falta habilitar `wscdc` en WSASS |
| Afectación fiscal | **decisión profesional** | conectado; no se puede inferir y no se infiere |
| Condición IVA del receptor | del padrón de ARCA | no conectado |

## 5. Operaciones mínimas que necesita la interfaz

No hay frontend: `apps/web` tiene un README y nada más. Lo que sigue no es un
diseño, es la lista de lo que la API ya sostiene y que una persona necesita para
completar el circuito. Todas existen.

| # | Operación | Ruta |
|---|---|---|
| 1 | Subir o elegir un documento | `POST /documents`, `GET /documents` |
| 2 | Ver el estado del documento y sus hallazgos | `GET /documents/:id` |
| 3 | Registrar la operación fiscal | `POST /documents/:id/tax-transaction` |
| 4 | Ver la operación y su constatación | `GET /documents/:id/tax-transaction` |
| 5 | Constatar contra ARCA | `POST /tax-transactions/:id/constatar` |
| 6 | Ver qué evidencia hay disponible | `GET /accounts`, `GET /documents` |
| 7 | Declarar la afectación con su evidencia | `POST /tax-transactions/:id/afectacion` |
| 8 | Revisar la afectación declarada | `GET /tax-transactions/:id/afectacion` |
| 9 | Emitir o consultar la decisión | `POST` / `GET /comprobantes/:id/decision` |
| 10 | Cargar y aprobar el asiento | `POST /journal-entries`, `/approve` |
| 11 | Ver Diario, Mayor y Balance | `GET /books/diario`, `/books/mayor`, `/reports/trial-balance` |
| 12 | Trazar un movimiento hasta su origen | `GET /books/trace/:movementId` |
| 13 | Emitir estados y notas | `POST /statements/issue`, `/notes/generate` |
| 14 | Trazar un renglón de un estado | `GET /statements/trace/:lineId` |

**Falta para el circuito, y no existe:** una ruta para **corregir una decisión ya
emitida**. Una operación admite una sola decisión vigente, y superseder la
anterior hoy solo se puede por SQL. Es el gap que el test E2E rodea explícitamente
en vez de disimular.

## 6. Gaps que siguen abiertos

| Gap | Tipo | Qué lo destraba |
|---|---|---|
| No hay interfaz de usuario | producto | decisión de producto |
| Sin motor de OCR real | producto | elegir motor; el puerto ya existe |
| `wscdc` no autorizado en WSASS | externo | trámite del estudio ante ARCA |
| Sin `CredentialStore` contra la base | técnico | el certificado no entra al repo (§27); falta el sobre con KMS |
| Corregir una decisión emitida | técnico | ruta de supersesión |
| Padrón de ARCA no consultado | técnico | `consultarPadron` existe y no se llama |
| `banks.ts` y `vat.ts` con baja cobertura | deuda | tests de ruta, no solo de motor |
| Reglas ACTIVE = 0 | normativo + profesional | Decreto 280/1997 y una firma |
