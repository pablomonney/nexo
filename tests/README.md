# tests

Ochenta y seis archivos. La estrategia está en `docs/TESTING_STRATEGY.md`.

| Carpeta | Qué prueba |
|---|---|
| `integration/` | El circuito real contra PostgreSQL, por HTTP. Base propia, no la de desarrollo. |
| `security/` | Las fronteras: aislamiento entre empresas, ADR-001, contrato de la consola, sincronización de las puertas. |
| `accounting/`, `tax/`, `normative/` | Los motores, como funciones puras. |
| `unit/` | Lógica sin base. |
| `regression/`, `ocr/`, `fixtures/` | Casos que ya fallaron una vez, y datos. |

## Por qué la base de tests no es la de desarrollo

Hasta el 2026-08-27 las suites escribían en la misma base que el desarrollo, y
**no podían limpiar**: los triggers `forbid_delete` existen justamente para que
nada se borre. El resultado medido ese día: de 143 filas en `norms`, 126 se
llamaban «Norma de prueba». El registro normativo —la tabla cuyo propósito
entero es la trazabilidad a una fuente oficial— era en un 88 % ficción de tests.

La solución no fue envolver cada test en `BEGIN`/`ROLLBACK`, que **sería un
retroceso**: el candado `Debe = Haber` es un `CONSTRAINT TRIGGER DEFERRABLE` y
solo dispara en el `COMMIT`. Un test que nunca confirma no ejercita el candado
más importante del sistema, y seguiría pasando. Los tests confirman de verdad,
contra una base que es de ellos.

## Los cuatro estados

Los verificadores informan **cuatro estados y no dos**: `VERIFIED`, `VIOLATED`,
`NOT_EXERCISED` y `VACUO_PERMITIDO`. «No encontré nada» y «no miré» no se ven
igual — mezclarlos es cómo un control deja de controlar sin que nadie se entere.

Los invariantes son A-1 a A-14 y las puertas de seguridad S-1 a S-15 —con la
salvedad de numeración que explica `docs/TESTING_STRATEGY.md` §2.7—. Corren en
`npm run verify` y en CI, y un test comprueba que esas dos listas no se separen.
