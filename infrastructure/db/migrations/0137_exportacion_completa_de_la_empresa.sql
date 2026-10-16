-- ============================================================================
-- 0137 — Exportación completa de la empresa
-- ============================================================================
--
-- Una empresa tiene derecho a llevarse TODOS sus datos (`docs/EXPORTACION_COMPLETA.md`). Es un acto sensible: saca de NEXO
-- la contabilidad entera, así que:
--
--   · lo puede pedir sólo quien administra la empresa (`company:export`, ADMINISTRADOR), no cualquiera que pueda leer;
--   · exige un motivo escrito y queda en la bitácora (`EXPORTAR_EMPRESA`), con cuántas tablas, filas y archivos salieron.
--
-- No crea tablas: la exportación lee lo que ya hay.

INSERT INTO permissions (code, description) VALUES
  ('company:export', 'Exportar todos los datos de la empresa (contabilidad, maestros, documentos) en un archivo');

INSERT INTO role_permissions (role_id, permission_id)
SELECT r.id, p.id FROM roles r, permissions p
WHERE r.code = 'ADMINISTRADOR' AND p.code = 'company:export';

INSERT INTO audit_actions (id, dominio, requiere_motivo)
VALUES ('EXPORTAR_EMPRESA', 'companies', true);
