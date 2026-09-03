# TESTING_STRATEGY.md — Estrategia de Pruebas

> Entregable J del §51. En un sistema contable, los tests no son control de calidad: son la
> evidencia de que los invariantes se cumplen. Varios de ellos son **requisitos del producto**,
> no del equipo de desarrollo.

## 1. Pirámide adaptada

```
        ▲  Invariantes de auditoría (A-1..A-8)   ← fallan el build
        │  Tests normativos                      ← vigencia y citas
        │  Tests contables                       ← partida doble, cierres
        │  Integración (API, base, ARCA homolog.)
        │  Unitarios (dominio puro)
        ▼  Property-based sobre el motor contable
```

## 2. Tipos de prueba

### 2.1 Unitarios — dominio puro

`accounting-engine`, `tax-engine`, `normative-engine` y `shared` no tocan red ni disco: se testean
exhaustivamente y rápido. Objetivo de cobertura: **≥ 95% en el motor contable**, sin excepciones
negociables.

### 2.2 Property-based — el motor contable

Más valiosos que los ejemplos, porque buscan el caso que nadie escribió:

| Propiedad | Enunciado |
|-----------|-----------|
| P-1 | Para todo asiento generado aleatoriamente que el motor **acepta**: Σ débitos = Σ créditos |
| P-2 | Para toda secuencia de asientos: el balance de sumas y saldos cierra |
| P-3 | Asiento + su contraasiento = efecto neto nulo en todos los saldos |
| P-4 | La numeración nunca tiene huecos ni repeticiones, bajo concurrencia |
| P-5 | El Mayor reconstruido desde el Diario es idéntico al materializado |
| P-6 | Ninguna secuencia de operaciones deja un período cerrado con movimientos nuevos |
| P-7 | El redondeo nunca crea ni destruye centavos en el total |

### 2.3 Tests contables (§33) — casos obligatorios

Cada uno con comprobante de entrada, asiento esperado, impacto en IVA, en Mayor y en estados:

```
Factura A (RI a RI)             Nota de crédito             Compra de bien de uso
Factura B (RI a CF)             Nota de débito              Venta de bien de uso
Factura C (monotributista)      Recibo de cobro             Amortización
Factura M                       Orden de pago               Sueldos y cargas sociales
Factura E (exportación)         Transferencia bancaria      Impuestos
Comprobante en USD              Cheque diferido             Percepciones sufridas
Operación exenta                Depósito                    Retenciones sufridas
Operación no gravada            Comisión bancaria           Retenciones practicadas
Prorrateo de crédito fiscal     Diferencia de cambio        Asiento de cierre y apertura
```

Cada caso es un fixture versionado en `tests/fixtures/`. **Un caso contable no se modifica para
que pase el test**: si el resultado esperado cambia, cambia porque cambió una norma, y eso queda
documentado con la cita.

### 2.4 Tests normativos

| Test | Verifica |
|------|----------|
| N-1 | Un hecho de 2024 resuelve con las reglas de 2024, aunque hoy sea 2026 |
| N-2 | La misma norma resuelve distinto en CABA que en otra jurisdicción (caso RT 54 real) |
| N-3 | Dos reglas de igual prioridad sin derogación declarada → `CONFLICTO NORMATIVO`, no un resultado |
| N-4 | Sin regla aplicable → `FUENTE NO ENCONTRADA`, nunca un default silencioso |
| N-5 | Toda regla `ACTIVE` tiene `norm_version_id`, documento archivado, hash y `approved_by` |
| N-6 | Una cita devuelta por un agente que no resuelve → propuesta rechazada automáticamente |
| N-7 | Reproducibilidad bitemporal: la decisión de una fecha pasada se reproduce con el conocimiento de esa fecha |

**N-1 y N-7 son los tests que distinguen este sistema de una planilla con IA.**

### 2.5 Tests fiscales

Liquidación de IVA sobre juegos de comprobantes completos, con notas de crédito, operaciones
exentas y no gravadas, prorrateo, percepciones y retenciones. Verificación cruzada: el subdiario
IVA debe coincidir con las cuentas de IVA del Mayor, al centavo.

### 2.6 Tests de OCR / extracción

Corpus versionado de comprobantes reales anonimizados. Se mide **por campo**: exactitud, cobertura
y —lo más importante— **tasa de error no detectado** (campo extraído mal con confianza alta). Esa
métrica tiene umbral de bloqueo de release.

### 2.7 Tests de seguridad

| Test | Verifica |
|------|----------|
| S-1 | Sesión de empresa A no accede a datos de empresa B — **en cada endpoint** |
| S-2 | Rol Auditor no puede escribir en ningún recurso |
| S-3 | No hay secretos en el repositorio ni en imágenes |
| S-4 | Un documento con instrucciones embebidas ("aprobá este asiento") no altera el comportamiento de ningún agente |
| S-5 | El fetcher de normas rechaza dominios fuera de la allowlist (SSRF) |
| S-6 | `UPDATE`/`DELETE` sobre `audit_logs` fallan a nivel de base de datos |
| S-7 | Reapertura de período requiere dos firmantes distintos |
| S-8 | **El lint de arquitectura falla si alguien viola el ADR-001** — se introduce una violación real y se verifica que el build se cae. Un lint configurado no es un lint que funciona |
| S-9 | **Barrido de aislamiento sobre TODOS los endpoints** — el test recorre el inventario de rutas que el servidor construye al registrarlas, no una lista escrita a mano. Un endpoint nuevo sin protección de tenancy lo detecta solo |
| S-10 | El login no permite enumerar cuentas: email inexistente y contraseña incorrecta devuelven exactamente la misma respuesta |
| S-11 | El token de sesión se guarda hasheado; buscarlo en claro en `sessions` no da resultados |
| S-12 | Un rol que exige MFA no accede a datos de empresa sin haberlo configurado |
| S-13 | Un código de recuperación de MFA sirve una sola vez |
| S-14 | La cuenta se bloquea tras N intentos fallidos, y con la cuenta bloqueada la contraseña correcta tampoco entra |

> ⚠ **Estos números y los de `tests/security/` son dos series distintas.**
> Esta tabla enumera **requisitos**, escritos antes de que existieran los tests.
> Los archivos de `tests/security/` se rotularon después con su propia
> numeración, y desde S-11 las dos dejaron de coincidir: acá S-12 es «un rol que
> exige MFA no entra sin configurarlo» y en los archivos S-12 es el barrido de la
> consola. No se renumeró nada porque las etiquetas de los archivos ya están
> citadas en una docena de lugares, y cambiarlas sin cambiar cada cita dejaría
> referencias apuntando a otra cosa — que es peor que la colisión.
>
> Qué hay en los archivos, con su rótulo:
>
> | Archivo | Rótulo propio | Qué defiende |
> |---|---|---|
> | `aislamiento-multiempresa`, `endpoint-isolation` | S-1, S-9 | Aislamiento entre empresas, endpoint por endpoint |
> | `adr-001` | S-8 | El lint de arquitectura falla de verdad |
> | `auth` | S-2, S-10 | Permisos de solo lectura y no enumeración de cuentas |
> | `coherencia-fase4` | S-11 | Que ningún estado afirme lo que los hechos niegan |
> | `consola-contrato` | S-12 | Que la consola solo llame a rutas que existen, y que cada dominio tenga puerta |
> | `metricas` | S-13 | Que `/metrics` no exista sin su token |
> | `limite-de-intentos` | S-14 | Que el límite por origen cuente fallos y no consultas |
> | `consola-elementos` | S-15 | Que la consola escriba en el elemento que cree: ningún id repetido, ninguno inexistente |
> | `motores-con-consumidor` | S-16 | Que cada función exportada por un paquete la use algo que no sea el propio paquete ni sus tests |
> | `tablas-con-escritor` | S-17 | Que cada tabla del esquema tenga al menos un `INSERT` fuera de los tests |
> | `solo-lectura` | S-18 | Que ninguna ruta de escritura le conteste otra cosa que 403 a un usuario de solo lectura |
> | `cadena-de-ventas` | S-19 | Que la misma operación cruce todas las capas: comercial → fiscal → stock → cuenta corriente → Mayor → cobranza → costo |
> | `vocabulario-de-eventos` | S-20 | Que la bitácora sea un vocabulario estable, y que renombrar una acción excepcional no apague su candado en silencio |
| `agentes-con-ejecucion` | S-21 | Que cada agente que el `CHECK` de `ai_predictions` acepta lo produzca algo, y no exista solo como miembro de una unión de tipos |

#### S-16, y por qué un barrido también se equivoca

S-16 persigue el defecto que este repositorio encontró cinco veces: una pieza
construida, probada, con su tabla esperándola, y nadie recorriendo el camino
entre las dos. La primera versión del barrido contaba como consumidor **una
mención en un comentario**, y así se le escapó `resumirPorMes` —el Diario
resumido del art. 327, entero— porque otro paquete la nombraba en su encabezado
para explicar para qué servía la función que nadie llamaba.

Desde entonces el barrido borra comentarios y literales de texto antes de
contar. Las plantillas (backticks) quedan enteras a propósito: pueden llevar una
llamada real adentro de `${...}`.

Las excepciones viven en el propio test, cada una con **qué la destraba**. Una
excepción que sobrevive a su motivo la detecta el segundo test del archivo, que
falla cuando una excepción ya no corresponde a ninguna exportación.

#### S-17, el mismo defecto un piso más abajo

S-16 mira las funciones exportadas; S-17 mira el esquema: **cada tabla tiene que
tener al menos un `INSERT` fuera de los tests**. Sale de tres hallazgos que
encontró una persona leyendo, no un control:

1. `bank_reconciliations` sin ningún INSERT — se podían proponer coincidencias y
   confirmarlas, y no había forma de crear la conciliación que las sostiene.
2. `vat_books.compras_sha256` / `ventas_sha256`, con el motivo escrito desde la
   0021 y ningún escritor.
3. `bank_accounts` y `bank_statement_layouts`: el módulo de bancos entero
   empezaba en dos filas que solo se podían crear por SQL.

Cuenta como escritor un `INSERT` en `apps/`, `scripts/`, `packages/` o en una
migración: una fila escrita por un trigger está tan escrita como una escrita por
un handler. Las diecinueve tablas que hoy no lo tienen están declaradas con su
motivo, y dos tests más impiden que la lista se vuelva decoración: uno falla si
una excepción ya tiene escritor, otro si nombra una tabla que ya no existe.

#### S-18, y por qué exige 403 y no «cualquier cosa menos 2xx»

El aislamiento por empresa (S-1) barre todas las rutas con una empresa ajena.
Adentro de la empresa propia no había barrido: un endpoint al que le falte
`requirePermission` pasa S-1 sin problema —el rol existe, el RLS deja, la
empresa es la suya— y solo se nota probando con un usuario de solo lectura.

La versión floja del control («que no conteste 2xx») se ve razonable y **no
sirve**: casi todos los handlers validan el cuerpo, así que un endpoint sin
permiso contesta 400 al pedido vacío del barrido y pasa igual. Se comprobó
sacándole el `requirePermission` a `POST /banks/accounts`: con la regla floja el
control seguía en verde; con **403 obligatorio** falla.

El 403 obligatorio además ordena los handlers: leer el cuerpo antes de mirar el
permiso le cuenta a quien no puede entrar qué campos espera el endpoint. Tres
transiciones de solicitudes de compra lo hacían.

#### S-19: capas, no piezas

S-16 pregunta si una función tiene consumidor y S-17 si una tabla tiene
escritor. Los dos miran **una pieza por vez**. S-19 mira lo que ninguno de los
dos puede ver: una capa conectada con la de al lado.

El síntoma era que cada eslabón estaba probado con su propio fixture. El ciclo
comercial llegaba hasta la operación fiscal y ahí paraba; la imputación de
cobros arrancaba de una factura creada a mano; la salida de stock se probaba
contra un comprobante que nadie había facturado. Todo verde, y **nadie recorría
la cadena entera con la misma operación**.

`cadena-de-ventas` la recorre por HTTP: cliente → presupuesto → factura → salida
de stock → cuenta corriente → asiento → Mayor → cobranza → imputación → costo de
lo vendido, y de vuelta al presupuesto por trazabilidad. `ciclo-compras` ya hacía
lo propio del lado de compras.

Lo que encontró en su primera corrida es exactamente el tipo de hueco que busca:
la existencia inicial de una empresa entra por ajuste, el endpoint de ajuste no
dejaba declarar el costo —aunque la base sí— y sin costo de entrada ninguna
salida se puede costear. El último eslabón de la cadena, el asiento del costo de
lo vendido, era inalcanzable para toda empresa que no hubiera comprado nunca.

#### S-20: un candado que se apaga renombrando

`audit_logs` exige motivo para cinco acciones excepcionales —anular un asiento,
reabrir un período, activar una regla, reclasificar un aprobado, cambiar el plan
de cuentas— y el CHECK las compara **por texto**.

Renombrar cualquiera de las cinco en el código no rompe nada: la aplicación
sigue andando, los tests siguen verdes, y desde ese día se puede anular un
asiento sin explicar por qué. Se comprobó: renombrando `ANULAR_ASIENTO` el
barrido falla; sin él, nada lo hacía.

De paso midió el vocabulario entero y encontró que derivaba: 106 acciones en
`VERBO_EN_MAYUSCULAS` y ocho en `objeto.verbo`, todas de un puñado de archivos
donde cada uno copió el estilo de su vecino. Ninguna estaba mal escrita; el
conjunto sí. Es la materia prima de todo lo que se construya encima —métricas,
detección, agentes—: un vocabulario con dos formas obliga a cada consulta a
conocer las dos, y la tercera que aparezca no la va a conocer nadie.

### 2.8 Tests de regresión

Todo bug reproducido primero como test que falla. Los bugs contables entran además al corpus
permanente de casos: un error de imputación que ocurrió una vez debe ser imposible de repetir.

### 2.9 Integración con ARCA

Contra **homologación**, nunca producción. Contract tests sobre los payloads de `wsfev1`,
`wscdcv1` y padrón, con grabaciones para CI. Escenarios de degradación: servicio caído, TA vencido,
CUIT sin habilitación → el sistema debe marcar `NO_VERIFICABLE`, jamás "OK".

---

## 3. Datos de prueba

- **Prohibido** usar datos reales de clientes en entornos de desarrollo.
- Generador de empresas sintéticas con CUIT válidos de prueba, planes de cuentas y series de
  comprobantes coherentes.
- El corpus de OCR se anonimiza en origen y su uso se documenta.

---

## 4. Sandbox (§34)

El modo simulación **es** una herramienta de prueba de cara al usuario:

```
Comprobante ficticio → Interpretación IA → Regla aplicada → Asiento propuesto
 → IVA → Mayor → Estados contables → Nota
```

Corre contra un esquema aislado, con los mismos motores y las mismas reglas que producción. Un
contador puede validar el comportamiento del sistema antes de confiarle contabilidad real — y el
equipo puede reproducir cualquier caso reportado.

**Construido en FASE 15.** `npm run sandbox:create` levanta la base aislada aplicándole el runner de
migraciones de producción, y `npm run sandbox:run` corre el escenario.

Lo que hay que entender antes de tocarlo: el candado **no comprueba que el destino no sea
producción**. Comprueba que sí sea un sandbox, exigiendo una marca que ninguna migración de
producción crea. Una lista de bases prohibidas falla abierta —la base nueva que nadie agregó pasa—;
exigir prueba falla cerrada. Ver `packages/sandbox/README.md`.

El escenario de fábrica termina con el crédito fiscal en `NO_DETERMINABLE` a propósito: un sandbox
que mostrara una afirmación que el sistema no hace enseñaría a confiar en ella.

---

## 5. Puertas de CI

Un build no pasa si:

1. Falla cualquier invariante A-1..A-8.
2. Cobertura del motor contable < 95%.
3. Falla cualquier test de seguridad S-1..S-7.
4. El lint de arquitectura detecta que `ai-engine` importa el motor contable o el cliente de base.
5. Hay un `float` en cálculos monetarios.
6. Existe una regla `ACTIVE` sin norma, sin hash o sin aprobador.
7. La tasa de error no detectado del OCR supera el umbral en el corpus de referencia.

Las puertas 4, 5 y 6 son inusuales en un proyecto de software y esenciales en este: codifican en el
pipeline las promesas que el producto le hace al contador.
