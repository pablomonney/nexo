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
| Elegir empresa | `GET /companies` | la pertenencia del usuario, no la cabecera |
| Encontrar el trabajo | `GET /work-queue`, `GET /tax-transactions` | derivado: proyección de estados que ya existen |
| Documento | `POST /documents` | el archivo; el sistema calcula hash y tipo |
| Operación fiscal | `POST /documents/:id/tax-transaction` | los importes los declara una persona; el sistema los cruza contra la extracción |
| Constatación | `POST /tax-transactions/:id/constatar` | **ARCA**, vía WSCDC |
| Afectación | `POST /tax-transactions/:id/afectacion` | una persona matriculada, con evidencia |
| Decisión | `POST /comprobantes/:id/decision` | el motor si hay regla; una persona si no |
| Corrección | `POST /comprobantes/:id/decision/supersede` | una persona, con motivo escrito |
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

## 5. La consola operativa

`GET /consola` sirve una página estática —`apps/web/consola.html`— que recorre el
circuito completo: login, **empresa, pendientes, operaciones**, documento,
operación fiscal, constatación, afectación, decisión, corrección, asiento, libros
y trazabilidad.

Hasta la FASE 3 el segundo paso estaba roto: el selector de empresa llamaba a
`GET /organizations/:id/companies`, que no existe, y quedaba siempre vacío. El
circuito andaba y nadie podía entrar a usarlo. Ahora llama a `GET /companies`, y
las tres pantallas nuevas —empresa, bandeja de pendientes y libro de
comprobantes— son **de lectura**: llevan a la pantalla donde se resuelve cada
cosa, y no resuelven nada por su cuenta.

**No es el frontend del roadmap.** Es la interfaz mínima con la que se opera y se
demuestra el circuito mientras esa aplicación no exista, y está construida para
no poder convertirse en otra cosa:

- no tiene build, ni framework, ni dependencias;
- **no calcula nada**: muestra lo que la API devolvió, incluidos los rechazos;
- no habla con la base —hay un test que lo comprueba—;
- su CSP es `default-src 'none'` con `connect-src 'self'`;
- no lleva ningún dato adentro: ni credenciales, ni tokens, ni un id de empresa.

Se sirve sin autenticar porque no contiene nada, y esa excepción está **declarada**
en el barrido de aislamiento (`SIN_DATOS`) en vez de ser un agujero silencioso.

### Las operaciones que sostiene

| # | Operación | Ruta |
|---|---|---|
| 0a | **Elegir empresa** | `GET /companies` |
| 0b | **Ver qué está pendiente** | `GET /work-queue` |
| 0c | **Buscar una operación fiscal** | `GET /tax-transactions` |
| 1 | Subir o elegir un documento | `POST /documents`, `GET /documents` |
| 2 | Ver el estado del documento y sus hallazgos | `GET /documents/:id` |
| 3 | Volver a leer un documento archivado | `POST /documents/:id/extract` |
| 4 | Registrar la operación fiscal | `POST /documents/:id/tax-transaction` |
| 5 | Ver la operación y su constatación | `GET /documents/:id/tax-transaction` |
| 6 | Constatar contra ARCA | `POST /tax-transactions/:id/constatar` |
| 7 | Declarar la afectación con su evidencia | `POST /tax-transactions/:id/afectacion` |
| 8 | Revisar la afectación declarada | `GET /tax-transactions/:id/afectacion` |
| 9 | Emitir o consultar la decisión | `POST` / `GET /comprobantes/:id/decision` |
| 10 | Corregir la decisión vigente | `POST /comprobantes/:id/decision/supersede` |
| 11 | Ver el historial de decisiones | `GET /comprobantes/:id/decision/historial` |
| 12 | Cargar y aprobar el asiento | `POST /journal-entries`, `/approve` |
| 13 | Ver Diario, Mayor y Balance | `GET /books/diario`, `/books/mayor`, `/reports/trial-balance` |
| 14 | Trazar un movimiento o un renglón | `GET /books/trace/:id`, `/statements/trace/:id` |
| 15 | Administrar certificados de ARCA | `POST`/`GET /companies/current/arca/credentials` |
| 16 | Ver qué servicios de ARCA están habilitados | `GET /companies/current/arca/capabilities` |

## 6. Gaps que siguen abiertos

| Gap | Tipo | Qué lo destraba |
|---|---|---|
| **La bandeja es de lectura** | por diseño de esta fase | primero comprobar que la persona encuentra el trabajo. Resolverlo desde la bandeja viene después |
| **Nadie escribe `documents.status = 'IMPUTADO'`** | defecto | conectar la transición al crear la operación fiscal. Documentado en [OPERACION.md](docs/OPERACION.md) addenda §5; la bandeja lo esquiva preguntando por el hecho y no por el rótulo |
| **`alerts` y `audit_findings` sin escritor** | `PRODUCT_DECISION` | decidir qué condición merece una alerta persistente. `audit-engine` ya calcula los hallazgos; lo que falta no es código |
| **Sin motor de OCR real** | `PRODUCT_DECISION` | elegir un motor. El puerto, los parsers, la persistencia con procedencia y la re-extracción ya están: falta el motor |
| **Cliente de KMS** | técnico | hoy el sobre es `local:dev` y **se niega a funcionar en producción**. Sin KMS, NEXO no opera con certificados reales |
| **`wscdc` no autorizado en WSASS** | `REQUIRES_EXTERNAL_INPUT` | trámite del estudio ante ARCA con clave fiscal. El sistema no lo puede hacer solo |
| **Alta de certificado sin test del camino feliz** | deuda | exige un X.509 real; guardar un par de claves en el repo violaría el §27 |
| Padrón de ARCA no consultado | `FUTURE_DEVELOPMENT` | `consultarPadron` existe en el cliente y ninguna ruta lo llama |
| Aplicación del estudio (`apps/web`) | `PRODUCT_DECISION` | la consola cubre el circuito y ahora también la navegación —empresa, pendientes, comprobantes—; una aplicación con densidad de ERP sigue siendo otro producto |
| `banks.ts` y `vat.ts` con baja cobertura | deuda | **fuera del circuito MVP**, declarado; tests de ruta, no solo de motor |
| Reglas ACTIVE = 0 | `REQUIRES_EXTERNAL_INPUT` + `PROFESSIONAL_REVIEW` | Decreto 280/1997 completo y una firma del §32 |
| Liquidación de sueldos | `PRODUCT_DECISION` | ver [ADR-012](docs/adr/ADR-012-liquidacion-de-sueldos.md). No implementado, y los límites ya están escritos |
