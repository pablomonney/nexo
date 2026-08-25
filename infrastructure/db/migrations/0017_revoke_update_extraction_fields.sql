-- 0017_revoke_update_extraction_fields.sql
--
-- Corrige un candado que no estaba cerrado.
--
-- La migración 0016 otorgó `GRANT SELECT, INSERT ON document_extraction_fields`
-- con la intención de que la aplicación no pudiera actualizar una lectura. No
-- alcanzaba: la 0009 dejó puesto
--
--   ALTER DEFAULT PRIVILEGES IN SCHEMA public
--     GRANT SELECT, INSERT, UPDATE ON TABLES TO aai_app;
--
-- que le concede UPDATE a `aai_app` sobre **toda tabla nueva**, en el momento de
-- crearla. Un GRANT que enumera menos privilegios no revoca los que ya están:
-- para sacar uno hay que revocarlo, como ya se hace con `audit_logs`.
--
-- Lo detectó el test de integración que afirmaba que había dos candados
-- independientes —el trigger y el privilegio— y encontró uno solo. El trigger
-- funcionaba, así que el comportamiento observable era correcto; lo que faltaba
-- era la defensa en profundidad que el diseño decía tener.

REVOKE UPDATE ON document_extraction_fields FROM aai_app;

-- Mismo razonamiento para el catálogo del organismo: lo sincroniza un proceso
-- con revisión, no un endpoint. Sin este REVOKE, un bug en un handler podría
-- reescribir la descripción de un tipo de comprobante — es decir, cambiar una
-- fuente citada.
REVOKE INSERT, UPDATE ON arca_comprobante_types FROM aai_app;
GRANT SELECT ON arca_comprobante_types TO aai_app;
