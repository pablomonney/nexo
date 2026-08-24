-- 0009_rls.sql — aislamiento multiempresa por Row Level Security.
--
-- Primera de las tres capas de aislamiento (SECURITY.md §4). Las otras dos son
-- el middleware de tenancy y el prefijo por empresa en el object storage.
-- Ninguna alcanza sola; ésta es la única que sigue en pie cuando la aplicación
-- tiene un bug.
--
-- El rol aai_app se creó con NOBYPASSRLS a propósito: si pudiera saltear las
-- políticas, el aislamiento sería una convención en vez de una garantía.

-- ---------------------------------------------------------------------------
-- Política estándar por company_id
-- ---------------------------------------------------------------------------
DO $$
DECLARE
  scoped_table text;
  -- `companies` NO va acá: se filtra por su propia clave primaria y se trata
  -- aparte, más abajo.
  scoped_tables text[] := ARRAY[
    'company_reporting_frameworks', 'user_company_roles',
    'accounts', 'cost_centers', 'profit_centers',
    'fiscal_years', 'periods', 'journals', 'journal_counters', 'accounting_closures',
    'journal_entries', 'journal_entry_lines', 'ledger_movements', 'account_balances',
    'rule_applications',
    'ai_predictions', 'ai_reviews', 'classification_preferences', 'confidence_policies',
    'audit_logs', 'lineage_edges', 'alerts'
  ];
BEGIN
  FOREACH scoped_table IN ARRAY scoped_tables LOOP
    EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY', scoped_table);
    EXECUTE format('ALTER TABLE %I FORCE ROW LEVEL SECURITY', scoped_table);
    EXECUTE format($p$
      CREATE POLICY tenant_isolation ON %I
        USING (company_id = app_company_id())
        WITH CHECK (company_id = app_company_id())
    $p$, scoped_table);
  END LOOP;
END
$$;

-- `companies` se filtra por su propia clave primaria.
ALTER TABLE companies ENABLE ROW LEVEL SECURITY;
ALTER TABLE companies FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON companies
  USING (id = app_company_id())
  WITH CHECK (id = app_company_id());

-- account_charts admite plantillas globales (company_id NULL), visibles para todos
-- pero no modificables desde el contexto de una empresa.
ALTER TABLE account_charts ENABLE ROW LEVEL SECURITY;
ALTER TABLE account_charts FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON account_charts
  USING (company_id = app_company_id() OR is_template)
  WITH CHECK (company_id = app_company_id());

-- system_settings: configuración global (company_id NULL) más la de la empresa.
ALTER TABLE system_settings ENABLE ROW LEVEL SECURITY;
ALTER TABLE system_settings FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON system_settings
  USING (company_id IS NULL OR company_id = app_company_id())
  WITH CHECK (company_id = app_company_id());

-- ---------------------------------------------------------------------------
-- Privilegios
-- ---------------------------------------------------------------------------
GRANT USAGE ON SCHEMA public TO aai_app;
GRANT SELECT, INSERT, UPDATE ON ALL TABLES IN SCHEMA public TO aai_app;
GRANT EXECUTE ON ALL FUNCTIONS IN SCHEMA public TO aai_app;

-- DELETE no se concede en ninguna tabla. Los triggers forbid_delete son la
-- segunda línea; la primera es simplemente no tener el privilegio.
REVOKE DELETE ON ALL TABLES IN SCHEMA public FROM aai_app;

-- La bitácora es append-only también a nivel de privilegios.
REVOKE UPDATE ON audit_logs FROM aai_app;

-- Las tablas normativas son de solo lectura para la aplicación: se pueblan por
-- el proceso de carga normativa con revisión humana, no desde un endpoint.
REVOKE INSERT, UPDATE ON norms, norm_versions, norm_documents, norm_articles,
  norm_modifications, norm_references, norm_adoptions, accounting_rules FROM aai_app;
GRANT SELECT ON norms, norm_versions, norm_documents, norm_articles,
  norm_modifications, norm_references, norm_adoptions, accounting_rules TO aai_app;

ALTER DEFAULT PRIVILEGES IN SCHEMA public
  GRANT SELECT, INSERT, UPDATE ON TABLES TO aai_app;
