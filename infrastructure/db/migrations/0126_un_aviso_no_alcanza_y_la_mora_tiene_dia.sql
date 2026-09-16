-- ---------------------------------------------------------------------------
-- Un aviso no alcanza, y la mora tiene día
-- ---------------------------------------------------------------------------
--
-- La 0096 declaró la política de cobranza con **un** aviso: `aviso_en_dias
-- integer`. Un solo mensaje entre el rechazo de la tarjeta y el corte del
-- servicio, y ninguna forma de declarar más sin tocar el esquema. En la
-- práctica una cobranza avisa varias veces, y la única alternativa que dejaba
-- el modelo era mandarle el mismo correo tres veces, que es peor que no
-- mandarlo: entrena al cliente a ignorarlo.
--
-- Y falta algo más grande: **no hay dónde escribir cuándo empieza la mora.**
-- La 0124 creó el estado; el calendario que lo dispara no tenía columna. Con
-- `reintentos_en_dias`, `aviso_en_dias` y `dias_de_gracia` se puede decir
-- cuándo se reintenta, cuándo se avisa y cuándo se corta — y no cuándo se
-- degrada. Sin `dias_de_mora`, el estado `MOROSA` existiría y nada lo
-- produciría nunca.
--
-- ## Por qué `dias_de_mora` admite NULL
--
-- `NULL` es «esta política no declara un paso de mora», y entonces el
-- calendario es el de antes: `ACTIVA → SUSPENDIDA` directo. **No es cero.**
-- Cero sería «la mora empieza el día del fallo», que es una decisión comercial
-- muy distinta y perfectamente declarable.
--
-- Es la misma regla que el sistema aplica en los cupos de IA, en los topes de
-- plan y en la propia ausencia de política: un valor por defecto inventado se
-- ve igual que uno decidido, y el día que degrade el acceso de un cliente nadie
-- va a saber de dónde salió.
--
-- ## Por qué el orden se valida y no se ordena solo
--
-- `aviso_en_dias` tiene que venir ascendente y sin repetidos. Ordenarlo en
-- silencio al insertarlo escondería el error: quien escribió `{0, 5, 2}`
-- probablemente se equivocó en el 2, y un sistema que se lo acomoda le confirma
-- una política que no es la que quiso declarar. Se rechaza y se dice por qué.
-- ---------------------------------------------------------------------------

-- ---------------------------------------------------------------------------
-- 1 · La pregunta que faltaba
-- ---------------------------------------------------------------------------
--
-- Un `CHECK` no admite subconsultas y esto mira el arreglo entero. Se envuelve
-- en una función inmutable, igual que `maximo_de_dias` y `minimo_de_dias` de la
-- 0096, y de paso le pone nombre a la regla.
--
-- Estrictamente ascendente: cubre el orden **y** los duplicados de una vez. Dos
-- avisos el mismo día son dos correos idénticos con un minuto de diferencia.

CREATE FUNCTION dias_ascendentes(dias integer[]) RETURNS boolean
  LANGUAGE sql IMMUTABLE STRICT PARALLEL SAFE AS $$
  SELECT coalesce(bool_and(d > anterior), true)
    FROM (SELECT d, lag(d) OVER (ORDER BY i) AS anterior
            FROM unnest(dias) WITH ORDINALITY AS t(d, i)) AS pares
   WHERE anterior IS NOT NULL
$$;

COMMENT ON FUNCTION dias_ascendentes(integer[]) IS
  'Si el arreglo viene estrictamente ascendente en el orden en que se escribió. '
  'Estrictamente, para que además rechace repetidos. Un arreglo vacío o de un '
  'solo elemento cumple: no hay ningún par que pueda estar mal.';

-- ---------------------------------------------------------------------------
-- 2 · Varios avisos
-- ---------------------------------------------------------------------------

-- Las dos restricciones que nombran la columna vieja se sacan antes de cambiar
-- el tipo: un `CHECK` sobre `integer` no sobrevive a un `integer[]`.
ALTER TABLE collection_policies DROP CONSTRAINT collection_policies_aviso_en_dias_check;
ALTER TABLE collection_policies DROP CONSTRAINT collection_policies_aviso_antes_de_suspender;

-- `USING ARRAY[aviso_en_dias]` conserva lo declarado: una política con aviso al
-- día 5 pasa a ser una política con un aviso, el del día 5. Hoy la tabla está
-- vacía en todos los entornos, y aun así se escribe la conversión —una
-- migración que solo funciona sobre una tabla vacía es una trampa para el
-- entorno que no lo esté.
ALTER TABLE collection_policies
  ALTER COLUMN aviso_en_dias TYPE integer[] USING ARRAY[aviso_en_dias];

ALTER TABLE collection_policies
  ADD CONSTRAINT collection_policies_avisos_sin_dias_negativos
    CHECK (coalesce(minimo_de_dias(aviso_en_dias), 0) >= 0),
  ADD CONSTRAINT collection_policies_avisos_ordenados
    CHECK (dias_ascendentes(aviso_en_dias)),
  -- El último aviso, no el primero: avisar después de haber cortado es
  -- explicarle a alguien que se le viene algo que ya le pasó.
  ADD CONSTRAINT collection_policies_avisos_antes_de_suspender
    CHECK (coalesce(maximo_de_dias(aviso_en_dias), 0) <= dias_de_gracia);

COMMENT ON COLUMN collection_policies.aviso_en_dias IS
  'Días desde el fallo en que se avisa, ascendente y sin repetidos. Un arreglo '
  'vacío es «no se avisa», que es una decisión declarable y distinta de no '
  'tener política. Son días desde el fallo original, no desde el aviso '
  'anterior: con offsets relativos, agregar un aviso en el medio le corre el '
  'calendario a quien ya estaba en curso.';

-- ---------------------------------------------------------------------------
-- 3 · El día de la mora
-- ---------------------------------------------------------------------------

ALTER TABLE collection_policies ADD COLUMN dias_de_mora integer;

ALTER TABLE collection_policies
  ADD CONSTRAINT collection_policies_mora_sin_dias_negativos
    CHECK (dias_de_mora IS NULL OR dias_de_mora >= 0),
  -- Degradar el mismo día que se corta no es un error de carga —es una
  -- política sin escalón intermedio— así que se admite el igual. Degradar
  -- **después** de cortar sí es imposible: el acceso ya no está.
  ADD CONSTRAINT collection_policies_mora_antes_de_suspender
    CHECK (dias_de_mora IS NULL OR dias_de_mora <= dias_de_gracia);

COMMENT ON COLUMN collection_policies.dias_de_mora IS
  'Días desde el fallo en que la suscripción pasa a MOROSA y el acceso queda '
  'degradado. NULL es «esta política no declara un paso de mora»: el calendario '
  'va de ACTIVA a SUSPENDIDA directo, como antes de la 0124. NO es cero — cero '
  'sería «la mora empieza el día del fallo», que es otra decisión.';

COMMENT ON TABLE collection_policies IS
  'Qué pasa cuando un pago falla: reintentos, avisos, mora y gracia. Nace '
  'vacía: sin política declarada un fallo se registra y no dispara nada, que no '
  'es lo mismo que cero reintentos.';

-- ---------------------------------------------------------------------------
-- 4 · El paso de mora, y los avisos numerados
-- ---------------------------------------------------------------------------

ALTER TABLE collection_steps DROP CONSTRAINT collection_steps_tipo_check;
ALTER TABLE collection_steps ADD CONSTRAINT collection_steps_tipo_check
  CHECK (tipo IN ('REINTENTO', 'AVISO', 'MORA', 'SUSPENSION'));

-- Los avisos pasan a llevar número por la misma razón que los reintentos: es lo
-- único que permite no repetir uno ya hecho cuando el ciclo corre tarde y
-- encuentra tres vencidos a la vez. Sin número, `collection_steps_unico` los
-- colapsaría en uno solo —`NULLS NOT DISTINCT`— y el segundo y el tercero no
-- se podrían registrar.
--
-- El orden de las tres sentencias de abajo es la migración, y lo escribió un
-- error: con el `UPDATE` primero, la base de pruebas —que sí tenía avisos
-- viejos— lo rechazó contra la restricción **vieja**, que exige `numero IS
-- NULL` en todo lo que no sea un reintento. La fila queda un instante violando
-- una de las dos, y la única ventana en la que no viola ninguna es entre las
-- dos restricciones.
--
-- Así que: se suelta la vieja, se completa el número, se aprieta la nueva.
--
-- El `1` es exacto, no una suposición: el modelo anterior tenía un único aviso
-- por documento y `collection_steps_unico` lo garantizaba.
ALTER TABLE collection_steps DROP CONSTRAINT collection_steps_reintento_numerado;

UPDATE collection_steps SET numero = 1 WHERE tipo = 'AVISO' AND numero IS NULL;

ALTER TABLE collection_steps ADD CONSTRAINT collection_steps_paso_numerado
  CHECK ((tipo IN ('REINTENTO', 'AVISO')) = (numero IS NOT NULL));

COMMENT ON CONSTRAINT collection_steps_paso_numerado ON collection_steps IS
  'Los pasos que pueden repetirse llevan número; los que ocurren una sola vez '
  'por documento —MORA, SUSPENSION— no. El número es lo que permite no repetir '
  'uno ya hecho cuando el ciclo corre tarde.';

COMMENT ON COLUMN collection_steps.numero IS
  'El orden dentro de su tipo: 1, 2, 3… Solo en REINTENTO y AVISO. Una '
  'suscripción se degrada y se corta una vez por documento, así que MORA y '
  'SUSPENSION no lo llevan.';

-- ---------------------------------------------------------------------------
-- 5 · La acción de bitácora del aviso
-- ---------------------------------------------------------------------------
--
-- `MARCAR_EN_MORA` la declaró la 0124. Falta la del aviso, y hace falta por lo
-- mismo: `audit_actions` es un catálogo cerrado y una acción no declarada
-- levanta `E_AUDIT_ACTION_DESCONOCIDA`, que voltea la transacción entera del
-- ciclo.
--
-- `requiere_motivo = false`, a diferencia de la mora y de la suspensión. Un
-- aviso no le quita nada a nadie: el motivo por el que salió está en la deuda
-- que lo disparó, y exigir que alguien lo escriba a mano sería pedir una
-- explicación de algo que el propio calendario ya explica.

INSERT INTO audit_actions (id, dominio, requiere_motivo)
VALUES ('AVISAR_DE_COBRANZA', 'facturacion', false);
