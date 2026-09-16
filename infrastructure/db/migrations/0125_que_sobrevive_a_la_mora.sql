-- ---------------------------------------------------------------------------
-- Qué sobrevive a la mora
-- ---------------------------------------------------------------------------
--
-- La 0124 creó el estado `MOROSA` y dijo que el acceso queda **degradado**. Sin
-- esta columna, «degradado» no significa nada: no hay dónde leer qué se
-- degrada.
--
-- ## La regla, en una línea
--
-- Una empresa en mora conserva lo que necesita para **cumplir sus obligaciones
-- y ponerse al día**, y pierde lo que sirve para *mejorar el negocio*.
--
-- No es una escala de importancia: es una distinción legal. Emitir una factura,
-- registrar un asiento, cerrar un período y presentar ante ARCA son
-- obligaciones con plazo y con multa. Un sistema que se las corta a un cliente
-- que debe dos semanas de abono no está cobrando: le está causando un perjuicio
-- que no es proporcional a la deuda, y que además no lo ayuda a pagar.
--
-- Lo que se corta —tableros, predicciones, CRM, comisiones, proyectos,
-- integraciones— es lo que un contador puede dejar de usar dos semanas sin que
-- le pase nada. Se recupera entero al pagar: nada se borra.
--
-- ## Por qué la columna vive acá y no en `plan_features`
--
-- `plan_features` dice **qué compró cada plan**. Esto dice **qué se degrada en
-- mora**, y no depende del plan: el CRM del plan más caro se degrada igual que
-- el del más barato. Ponerlo en `plan_features` obligaría a repetir la misma
-- respuesta por cada plan, y el día que difieran —porque alguien tocó una fila
-- y no las otras— dos clientes en la misma situación verían productos
-- distintos sin que nadie lo haya decidido.
--
-- ## Por qué el default es `true`
--
-- Porque el default es lo que hereda una funcionalidad **futura**, y quien la
-- agregue dentro de un año no va a estar pensando en la mora. Heredar «se
-- corta» le cortaría el acceso a alguien sin que nadie lo hubiera decidido;
-- heredar «sobrevive» produce, en el peor caso, un módulo que sigue disponible
-- de más. El primero es el error caro — es el mismo criterio con el que
-- `alcanzaElPlan` falla abierta.
--
-- ## Lo que esta columna NO hace
--
-- **No distingue por verbo.** No existe «leer sí, escribir no»: la puerta
-- comercial no mira el método, y hacer que lo mirara significaría dos reglas
-- donde hoy hay una, con la garantía de que en algún momento discrepen.
--
-- **No toca los datos.** Una funcionalidad degradada deja de estar disponible;
-- lo que ya se cargó sigue ahí y vuelve a verse entero al pagar. El historial
-- no es parte de lo que se degrada, y por eso nada de acá borra ni archiva.
-- ---------------------------------------------------------------------------

ALTER TABLE product_features
  ADD COLUMN sobrevive_la_mora boolean NOT NULL DEFAULT true;

COMMENT ON COLUMN product_features.sobrevive_la_mora IS
  'Si esta funcionalidad sigue disponible con la suscripción en MOROSA. El '
  'default es true porque es lo que hereda una funcionalidad futura, y el '
  'error caro de una puerta comercial es dejar afuera a quien paga. Solo '
  'gobierna la disponibilidad: ningún dato se borra ni se archiva.';

-- ---------------------------------------------------------------------------
-- Las siete que se degradan
-- ---------------------------------------------------------------------------
--
-- Se nombran una por una y no por exclusión: una lista de lo que NO se degrada
-- haría que cada funcionalidad nueva se cortara por omisión, que es justo lo
-- contrario del default de arriba.
--
-- Las doce que quedan en `true` son las que sostienen una obligación o el
-- camino de vuelta: contabilidad, fiscal, terceros, documentos, auditoría,
-- comercial, compras, stock, tesorería, precios, sucursales y arca.
--
-- `WHERE code IN (...)` sin comprobar cuántas filas tocó: esta migración tiene
-- que poder correr sobre una base donde el catálogo todavía no se sembró, y
-- exigir las siete ahí la haría fallar por una condición que no es un error.

UPDATE product_features
   SET sobrevive_la_mora = false
 WHERE code IN (
   'proyectos',      -- seguimiento de obra: no vence ningún plazo legal
   'comisiones',     -- liquidación a vendedores: se recalcula después
   'crm',            -- gestión comercial: no hay obligación atrás
   'analitica',      -- tableros
   'analisis',       -- escenarios y registro de decisiones
   'inteligencia',   -- predicciones y alertas
   'integraciones'   -- conectores con terceros
 );
