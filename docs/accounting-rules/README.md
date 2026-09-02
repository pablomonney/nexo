# Reglas contables

Catálogo de reglas del dominio `accounting`, una por archivo, con su norma de
respaldo. Se cargan con `npm run reglas:cargar`.

## Cuántas hay

**Una**: `AR-IVA-CF-VINCULACION-001.v1.json`.

No es un catálogo a medio poblar: es todo lo que hoy tiene fuente verificada.
Una regla no llega a `ACTIVE` sin norma en nivel V1, documento oficial archivado
con su hash, y la firma de un matriculado (§32) — y `rule:activate` **no lo tiene
ningún rol**, deliberadamente, porque esa firma todavía no tiene camino en el
sistema.

Por eso las reglas entran como `DRAFT` y una regla `V2` o inferior **no se
aplica**: se muestra como hueco normativo. El sistema prefiere declararse
incompleto antes que aparentar completitud, que es el riesgo R-20.

## Qué declara cada regla

`rule_id`, `norm_version_id`, vigencia, jurisdicción, tipo de entidad, marco,
condiciones, acción y cita completa. La vigencia no es opcional: §6 prohíbe usar
la norma de hoy para una operación de ayer.

Ver `NORMATIVE_ENGINE.md` §5.
