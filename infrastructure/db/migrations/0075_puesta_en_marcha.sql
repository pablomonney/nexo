-- ============================================================================
-- 0075 — Puesta en marcha: qué le falta a esta empresa para poder trabajar
-- ============================================================================
--
-- La auditoría integral lo puso como P0 junto con el mapeo contable: una
-- empresa nueva necesita plan de cuentas, ejercicio, períodos y varias cosas
-- más antes de poder registrar nada, y **hoy eso se descubre pantalla por
-- pantalla**, chocando con un error por vez.
--
-- El sistema ya sabe todo lo que hace falta para contestarlo: son cuentas de
-- filas sobre tablas que existen. Lo que faltaba era preguntárselo.
--
-- ## No es un estado nuevo: es una cuenta
--
-- No hay tabla de pasos, ni columna «onboarding_completo», ni checklist que
-- alguien tilde. Un tilde es una segunda verdad que puede decir «listo» sobre
-- una empresa sin ejercicio abierto. Acá cada paso se responde contando lo que
-- hay, así que no puede quedar desactualizado ni mentir.
--
-- ## Lo que bloquea y lo que no
--
-- Tres cosas impiden trabajar de verdad: sin cuentas imputables no entra ningún
-- asiento, sin ejercicio no hay períodos, y sin período abierto que contenga la
-- fecha no entra ninguna operación. Esas van a la bandeja.
--
-- El resto —depósitos, cajas, sucursales, listas de precios— **no falta**: es
-- que no toda empresa las usa. Un checklist que le reclama depósitos a un
-- estudio contable enseña a ignorar el checklist.
-- ============================================================================

CREATE VIEW company_readiness WITH (security_invoker = true) AS
SELECT c.id                                        AS company_id,

       -- Lo que bloquea
       (SELECT count(*)::int FROM accounts a
         WHERE a.company_id = c.id AND a.is_postable AND a.status = 'ACTIVE')
                                                   AS cuentas_imputables,
       (SELECT count(*)::int FROM fiscal_years f WHERE f.company_id = c.id)
                                                   AS ejercicios,
       (SELECT count(*)::int FROM periods p
         WHERE p.company_id = c.id AND p.status = 'ABIERTO'
           AND current_date BETWEEN p.start_date AND p.end_date)
                                                   AS periodos_abiertos_hoy,

       -- Lo que habilita cosas concretas, sin bloquear nada
       (SELECT count(*)::int FROM company_account_map m WHERE m.company_id = c.id)
                                                   AS roles_mapeados,
       (SELECT count(*)::int FROM company_reporting_frameworks r WHERE r.company_id = c.id)
                                                   AS marcos_de_reporte,
       (SELECT count(*)::int FROM parties p
         WHERE p.company_id = c.id AND p.status = 'ACTIVO')
                                                   AS terceros,
       (SELECT count(*)::int FROM products p
         WHERE p.company_id = c.id AND p.status = 'ACTIVO')
                                                   AS productos,
       (SELECT count(*)::int FROM warehouses w
         WHERE w.company_id = c.id AND w.status = 'ACTIVO')
                                                   AS depositos,
       (SELECT count(*)::int FROM cash_boxes b
         WHERE b.company_id = c.id AND b.status = 'ACTIVA')
                                                   AS cajas,
       (SELECT count(*)::int FROM bank_accounts b WHERE b.company_id = c.id)
                                                   AS cuentas_bancarias,
       (SELECT count(*)::int FROM branches b
         WHERE b.company_id = c.id AND b.status = 'ACTIVA')
                                                   AS sucursales,
       -- ⚠ `ACTIVE`, en inglés, y no `ACTIVA`. Los dominios de estado de este
       -- esquema mezclan idiomas —`accounts` y las credenciales usan `ACTIVE`,
       -- `parties` usa `ACTIVO`, `cash_boxes` usa `ACTIVA`, `journal_entries`
       -- usa `APROBADO`— y comparar contra el valor equivocado no falla: cuenta
       -- cero y nadie se entera. Esta línea decía `ACTIVA` en el primer intento.
       (SELECT count(*)::int FROM company_arca_credentials k
         WHERE k.company_id = c.id AND k.status = 'ACTIVE')
                                                   AS credenciales_arca,
       (SELECT count(DISTINCT u.user_id)::int FROM user_company_roles u
         WHERE u.company_id = c.id
           AND u.valid_from <= current_date
           AND (u.valid_to IS NULL OR u.valid_to >= current_date))
                                                   AS usuarios,

       -- Y qué tanto se usó ya. Una empresa con asientos no está «arrancando».
       (SELECT count(*)::int FROM tax_transactions t WHERE t.company_id = c.id)
                                                   AS comprobantes,
       (SELECT count(*)::int FROM journal_entries e WHERE e.company_id = c.id)
                                                   AS asientos
  FROM companies c;

COMMENT ON VIEW company_readiness IS
  'Qué tiene y qué le falta a cada empresa para operar. Se cuenta en el '
  'momento: no hay checklist que alguien tilde, porque un tilde puede decir '
  '«listo» sobre una empresa sin período abierto.';

-- ---------------------------------------------------------------------------
-- La bandeja: solo lo que impide trabajar
-- ---------------------------------------------------------------------------
CREATE VIEW work_queue_arranque WITH (security_invoker = true) AS
SELECT md5(q.rama || ':' || q.entity_id)::uuid AS item_id,
       q.*
  FROM (

-- 1 · Sin cuentas imputables no entra ningún asiento. Es el primer paso de
--     todos y el único que no depende de ninguna decisión: hasta el plan más
--     chico necesita una cuenta donde imputar.
SELECT r.company_id,
       'SIN_PLAN_DE_CUENTAS'::text                   AS rama,
       'BLOQUEADO'::text                             AS categoria,
       'companies'::text                             AS entidad,
       r.company_id                                  AS entity_id,
       'ARRANQUE'::text                              AS estado,
       'Esta empresa no tiene ninguna cuenta imputable: sin plan de cuentas no ' ||
         'entra ningún asiento'                      AS motivo,
       true                                          AS bloquea,
       ARRAY['PLAN_DE_CUENTAS']::text[]              AS evidencia_faltante,
       'SISTEMA'::text                               AS origen,
       'ACCIONABLE'::text                            AS disponibilidad,
       now()                                         AS creado_en,
       now()                                         AS actualizado_en,
       NULL::date                                    AS fecha_limite,
       '/accounts'::text                             AS traza_ref
  FROM company_readiness r
 WHERE r.cuentas_imputables = 0

UNION ALL

-- 2 · Sin ejercicio no hay períodos, y sin períodos no hay dónde registrar.
SELECT r.company_id,
       'SIN_EJERCICIO'::text                         AS rama,
       'BLOQUEADO'::text                             AS categoria,
       'companies'::text                             AS entidad,
       r.company_id                                  AS entity_id,
       'ARRANQUE'::text                              AS estado,
       'Esta empresa no tiene ningún ejercicio abierto: sin ejercicio no hay ' ||
         'períodos, y sin períodos no se registra nada'
                                                     AS motivo,
       true                                          AS bloquea,
       ARRAY['EJERCICIO']::text[]                    AS evidencia_faltante,
       'SISTEMA'::text                               AS origen,
       'ACCIONABLE'::text                            AS disponibilidad,
       now()                                         AS creado_en,
       now()                                         AS actualizado_en,
       NULL::date                                    AS fecha_limite,
       '/fiscal-years'::text                         AS traza_ref
  FROM company_readiness r
 WHERE r.ejercicios = 0

UNION ALL

-- 3 · Hay ejercicio pero ninguno abierto que contenga hoy. Es distinto del
--     anterior y por eso es su propia rama: el ejercicio existe y aun así no se
--     puede registrar con fecha de hoy.
SELECT r.company_id,
       'SIN_PERIODO_ABIERTO'::text                   AS rama,
       'BLOQUEADO'::text                             AS categoria,
       'companies'::text                             AS entidad,
       r.company_id                                  AS entity_id,
       'ARRANQUE'::text                              AS estado,
       'No hay ningún período abierto que contenga la fecha de hoy: una ' ||
         'operación con fecha de hoy no se puede registrar'
                                                     AS motivo,
       true                                          AS bloquea,
       ARRAY['PERIODO_ABIERTO']::text[]              AS evidencia_faltante,
       'SISTEMA'::text                               AS origen,
       'ACCIONABLE'::text                            AS disponibilidad,
       now()                                         AS creado_en,
       now()                                         AS actualizado_en,
       NULL::date                                    AS fecha_limite,
       '/periods'::text                              AS traza_ref
  FROM company_readiness r
 WHERE r.ejercicios > 0 AND r.periodos_abiertos_hoy = 0

) q;

COMMENT ON VIEW work_queue_arranque IS
  'Las tres cosas que impiden trabajar. Los demás pasos de la puesta en marcha '
  'no van acá: reclamarle depósitos a un estudio contable enseña a ignorar la '
  'bandeja.';

-- ⚠ `WITH (security_invoker = true)` repetido: `CREATE OR REPLACE` no conserva
-- las reloptions, y sin eso la bandeja de una empresa aparecería en la de otra.
CREATE OR REPLACE VIEW work_queue WITH (security_invoker = true) AS
SELECT * FROM work_queue_nucleo
UNION ALL SELECT * FROM work_queue_comercial
UNION ALL SELECT * FROM work_queue_compras
UNION ALL SELECT * FROM work_queue_cobranzas
UNION ALL SELECT * FROM work_queue_stock
UNION ALL SELECT * FROM work_queue_activos
UNION ALL SELECT * FROM work_queue_integraciones
UNION ALL SELECT * FROM work_queue_senales
UNION ALL SELECT * FROM work_queue_precios
UNION ALL SELECT * FROM work_queue_cheques
UNION ALL SELECT * FROM work_queue_lotes
UNION ALL SELECT * FROM work_queue_caja
UNION ALL SELECT * FROM work_queue_crm
UNION ALL SELECT * FROM work_queue_proyectos
UNION ALL SELECT * FROM work_queue_comisiones
UNION ALL SELECT * FROM work_queue_sucursales
UNION ALL SELECT * FROM work_queue_suscripcion
UNION ALL SELECT * FROM work_queue_mapeo
UNION ALL SELECT * FROM work_queue_arranque;

GRANT SELECT ON company_readiness TO aai_app;
GRANT SELECT ON work_queue_arranque TO aai_app;
GRANT SELECT ON work_queue TO aai_app;
