# B10 — Estados contables para una SRL: qué hay y qué falta

**Estado: NO SOPORTADO. No se declara disponible hasta verificarlo** (ver §5). Fecha: 2026-10-15.

## 1 · Qué ve hoy una SRL

`GET /statements` (y la pantalla «Estados y notas») responde:

> `FUENTE NO ENCONTRADA: no hay plantilla ESP vigente al 2026-12-31 para marco RT_FACPCE, ente SRL y regulador IGJ. Cargá la plantilla con la norma de la que sale; el sistema no arma una estructura por su cuenta.`

Es el comportamiento diseñado —el sistema no inventa la estructura de un estado—, no un error. Se vio al abrir la pantalla #3 con datos
de prueba (`docs/VERIFICACION_VISUAL_16_PANTALLAS.md` §5, captura `03-estados-sin-plantilla-para-SRL`). **Es un bloqueo para el primer cliente si es una SRL.**

## 2 · Por qué pasa (el código, verificado)

| Pieza | Qué hace | Archivo |
|---|---|---|
| Búsqueda de la plantilla | `plantillaAplicable()` exige **igualdad exacta** de tipo de estado, marco, **tipo de ente**, regulador y vigencia | `packages/financial-statements/src/template.ts` |
| Catálogo sembrado | Sólo `tipoEnte: 'SA'`, regulador `IGJ`, marco `RT_FACPCE`, vigente desde 1984-03-30. El propio guion dice que **no** se replica a los otros tipos de ente: «copiar la plantilla de una SA cambiándole la etiqueta sería afirmar que son iguales» | `scripts/statement-templates.mjs` (`ALCANCE`) |
| Fundamento normativo de lo sembrado | Ley 19.550 (T.O. 1984), arts. 63 y 64, archivada con sha256 en `INFOLEG_LGS_19550_texto_actualizado.htm`, más la ficha del Decreto 841/84 | `scripts/seed-statement-templates.mjs` |
| Tipos de ente que el sistema conoce | `SA`, `SRL`, `SAS`, `UNIPERSONAL`, `SA_299`, `SOCIEDAD_SIMPLE`, `ASOC_CIVIL`, `FUNDACION`, `MUTUAL`, … (12) | `packages/shared/src/entidad.ts` |
| Marco de reporte de la empresa | Se **declara** (`POST /companies/current/reporting-framework`) con respaldo documental; no se deduce del CUIT | `apps/api/src/routes/statements.ts` |

Una plantilla trae además `scope_types` y `scope_fundamento` (qué rubros expone y la norma de la que salen): son parte de lo que habría que cargar.

## 3 · Qué falta para soportar una SRL

Se separa lo que es trabajo de lo que es **decisión con norma detrás**.

### Decisiones y validación (no se resuelven escribiendo código)

1. **Qué estructura corresponde.** Si los arts. 63 y 64 de la Ley 19.550 (estructura del balance de las sociedades comerciales) alcanzan a la SRL en la forma que los usa NEXO,
   o si hace falta otra plantilla (por ejemplo un modelo para entes pequeños bajo otra norma). **No se asume.** Lo decide quien firma los estados.
2. **Qué marco declara la SRL** (RT FACPCE u otro) y desde cuándo.
3. **Quién valida** la plantilla antes de usarla con un cliente (un profesional matriculado), y con qué fuente archivada.
4. **Qué se le promete al cliente**: estados armados por NEXO para que el profesional los revise, o sólo la trazabilidad de las cifras.

### Trabajo de ingeniería (una vez resuelto lo anterior)

1. Agregar la plantilla para `entity_type = 'SRL'` (marco y regulador que correspondan) con su `norm_version_id`, `articulo`, `scope_types`, `scope_fundamento`, ecuación patrimonial y vigencia. La norma tiene que estar **archivada con su sha256** (`npm run norms:verify`).
2. `validarPlantilla()` sobre la nueva estructura (la siembra se niega a insertar si hay un error).
3. El **plan de cuentas** de la empresa tiene que coincidir con los selectores de la plantilla (prefijos de código, tipos, rol fiscal). Hoy el plan que trae el alta autoservicio no lo garantiza: las pruebas de estados contables usan un plan hecho a medida.
4. Pruebas de integración como las de SA (`tests/integration/estados-contables.test.ts`): armar, emitir con hash, trazar una cifra hasta los asientos, ecuación patrimonial, aislamiento entre empresas, y un caso con **SRL**.
5. La consola: que el mensaje de «no hay plantilla» diga **qué hacer** (hoy dice «cargá la plantilla», que una persona de negocio no puede hacer) y a quién pedirlo.
6. Una mutación por cada control nuevo, como en el resto del proyecto.

## 4 · Qué se puede decir hoy al primer cliente

- **SA:** el estado se arma y la trazabilidad llega hasta los movimientos (probado a nivel API, local).
- **SRL (u otro tipo de ente):** NEXO lleva la contabilidad, el Mayor, los libros y los comprobantes, **pero no arma estados contables**. Se lo dice antes de firmar.

## 5 · Criterio para declararlo disponible

No se marca como disponible hasta que, **para una SRL de prueba**: (a) exista la plantilla con su norma archivada y validada por un profesional; (b) el estado se emita con su hash y cierre la ecuación patrimonial; (c) las pruebas de integración y sus mutaciones pasen; (d) la pantalla se haya recorrido con datos; y (e) quede asentado quién validó la estructura y cuándo.

## 6 · Lo que necesito de vos

El tipo de ente del primer cliente y, si es SRL, quién valida la estructura. Sin eso el trabajo de §3 no empieza.
