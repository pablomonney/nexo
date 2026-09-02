-- ============================================================================
-- 0076 — La puesta en marcha, completa: lo que no aplica también se dice
-- ============================================================================
--
-- La 0075 contestó qué le falta a una empresa para trabajar con diez pasos y
-- dos estados de fondo: está o no está. Faltaban dos cosas.
--
-- ## Primero: «no aplica» no es «falta»
--
-- Un estudio contable no tiene depósitos, y decirle que le falta uno enseña a
-- ignorar la lista. Pero «no aplica» tampoco se puede suponer: hay que poder
-- **derivarlo de algo que la empresa declaró**. Dos casos se pueden:
--
--   · Si todos los productos cargados son servicios —`tracks_stock` en falso—,
--     el depósito no aplica: no hay nada que depositar.
--   · Si no hay ninguna sucursal, declarar puntos de venta por sucursal no
--     aplica: no hay a qué atribuirlos.
--
-- Lo que no se puede derivar sigue como pendiente. «No lo declaró» y «no le
-- corresponde» son distintos, y el segundo exige evidencia.
--
-- ## Segundo: faltaban pasos que el pedido enumera
--
-- Puntos de venta, centros de costo y usuarios con rol. Los tres se cuentan
-- igual que el resto: filas que existen, no tildes.
--
-- Las columnas nuevas van **al final**: `CREATE OR REPLACE VIEW` no admite
-- insertar ni renombrar columnas, y `work_queue_arranque` depende de esta
-- vista.
-- ============================================================================

CREATE OR REPLACE VIEW company_readiness WITH (security_invoker = true) AS
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
       -- ⚠ `ACTIVE`, en inglés. Los dominios de estado de este esquema mezclan
       -- idiomas y comparar contra el valor equivocado no falla: cuenta cero y
       -- nadie se entera. Está anotado como P3 en la auditoría integral.
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
                                                   AS asientos,

       -- ── Agregado por la 0076 ──────────────────────────────────────────
       -- Cuántos de los productos llevan existencias. Es lo que permite decir
       -- «el depósito no aplica» sin suponerlo: una empresa cuyos productos son
       -- todos servicios no tiene nada que depositar.
       (SELECT count(*)::int FROM products p
         WHERE p.company_id = c.id AND p.status = 'ACTIVO' AND p.tracks_stock)
                                                   AS productos_con_stock,
       (SELECT count(*)::int FROM branch_points_of_sale v
         WHERE v.company_id = c.id
           AND (v.vigencia_hasta IS NULL OR v.vigencia_hasta >= current_date))
                                                   AS puntos_de_venta,
       (SELECT count(*)::int FROM cost_centers cc
         WHERE cc.company_id = c.id AND cc.status = 'ACTIVE')
                                                   AS centros_de_costo,
       -- Roles vigentes, no usuarios: dos personas con el mismo rol no son dos
       -- responsabilidades distintas.
       (SELECT count(DISTINCT u.role_id)::int FROM user_company_roles u
         WHERE u.company_id = c.id
           AND u.valid_from <= current_date
           AND (u.valid_to IS NULL OR u.valid_to >= current_date))
                                                   AS roles_de_usuario
  FROM companies c;

COMMENT ON VIEW company_readiness IS
  'Qué tiene y qué le falta a cada empresa para operar. Se cuenta en el '
  'momento: no hay checklist que alguien tilde, porque un tilde puede decir '
  '«listo» sobre una empresa sin período abierto. Incluye lo que permite '
  'derivar un «no aplica» con evidencia: productos que llevan stock y '
  'sucursales declaradas.';
