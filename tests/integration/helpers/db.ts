/**
 * Helpers para los tests de integración contra PostgreSQL.
 *
 * Si no hay DATABASE_URL, las suites se saltean en vez de fallar: un
 * desarrollador sin Docker levantado tiene que poder correr los tests unitarios.
 * En CI la variable siempre está, así que allí se ejecutan.
 */

import pg from 'pg';

export const DATABASE_URL = process.env.DATABASE_URL ?? '';
export const hasDatabase = DATABASE_URL.length > 0;

export type Client = pg.Client;

export async function connect(): Promise<pg.Client> {
  const client = new pg.Client({ connectionString: DATABASE_URL });
  await client.connect();
  return client;
}

/** Ejecuta como el rol de aplicación, con RLS activo y una empresa en contexto. */
export async function asCompany<T>(
  client: pg.Client,
  companyId: string,
  fn: () => Promise<T>,
): Promise<T> {
  await client.query('BEGIN');
  try {
    await client.query('SET LOCAL ROLE aai_app');
    await client.query('SELECT set_config($1, $2, true)', ['app.company_id', companyId]);
    const result = await fn();
    await client.query('COMMIT');
    return result;
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  }
}

/**
 * Espera que una operación falle, y devuelve el mensaje para poder afirmarlo.
 *
 * Solo sirve para afirmar sobre mensajes que escribimos nosotros en los
 * `RAISE EXCEPTION` de las migraciones. Para errores propios de PostgreSQL usar
 * `expectFailureCode`: los mensajes del motor están traducidos según el `lc_messages`
 * del servidor y un test que los compare literalmente pasa en inglés y falla en
 * español.
 */
export async function expectFailure(fn: () => Promise<unknown>): Promise<string> {
  try {
    await fn();
  } catch (error) {
    return error instanceof Error ? error.message : String(error);
  }
  throw new Error('Se esperaba un fallo y la operación tuvo éxito');
}

/** Igual que `expectFailure`, pero devuelve el SQLSTATE, que es independiente del idioma. */
export async function expectFailureCode(
  fn: () => Promise<unknown>,
): Promise<{ code: string; message: string }> {
  try {
    await fn();
  } catch (error) {
    const failure = error as { code?: string; message?: string };
    return { code: failure.code ?? '', message: failure.message ?? String(error) };
  }
  throw new Error('Se esperaba un fallo y la operación tuvo éxito');
}

/** SQLSTATE 42501 — insufficient_privilege. Cubre RLS y permisos denegados. */
export const INSUFFICIENT_PRIVILEGE = '42501';

export interface Fixture {
  organizationId: string;
  companyA: string;
  companyB: string;
  fiscalYearA: string;
  periodA: string;
  cashA: string;
  salesA: string;
}

/**
 * Crea dos empresas del mismo estudio con plan de cuentas y período abierto.
 * Dos empresas y no una: casi todos los tests de aislamiento necesitan un
 * "otro" contra el cual comprobar que no hay fuga.
 */
/**
 * Ocho dígitos únicos por proceso y por llamada.
 *
 * `companies.cuit` tiene un CHECK de formato `^[0-9]{11}$`: el sufijo NO puede
 * llevar letras. El nombre de la suite se usa solo para la razón social, que sí
 * es texto libre. Las suites corren en paralelo, así que la unicidad tiene que
 * contemplar varios procesos.
 */
let seedCounter = 0;
function numericSuffix(): string {
  seedCounter += 1;
  const base = `${process.pid}${Date.now()}${seedCounter}`.replace(/\D/g, '');
  return base.slice(-8).padStart(8, '0');
}

export async function seed(client: pg.Client, label: string): Promise<Fixture> {
  const suffix = numericSuffix();

  const org = await client.query<{ id: string }>(
    `INSERT INTO organizations (name, tax_id) VALUES ($1, $2) RETURNING id`,
    [`Estudio ${label}`, `30${suffix}9`],
  );
  const organizationId = org.rows[0]!.id;

  const makeCompany = async (name: string, cuit: string): Promise<string> => {
    const result = await client.query<{ id: string }>(
      `INSERT INTO companies (organization_id, legal_name, cuit, entity_type, jurisdiction, regulator, fiscal_year_end)
       VALUES ($1, $2, $3, 'SRL', 'AR-C', 'IGJ', '12-31') RETURNING id`,
      [organizationId, name, cuit],
    );
    return result.rows[0]!.id;
  };

  const companyA = await makeCompany(`Empresa A ${label}`, `30${suffix}1`);
  const companyB = await makeCompany(`Empresa B ${label}`, `33${suffix}2`);

  const chart = await client.query<{ id: string }>(
    `INSERT INTO account_charts (company_id, name) VALUES ($1, 'Plan base') RETURNING id`,
    [companyA],
  );
  const chartId = chart.rows[0]!.id;

  const makeAccount = async (
    code: string,
    name: string,
    type: string,
    nature: string,
  ): Promise<string> => {
    const result = await client.query<{ id: string }>(
      `INSERT INTO accounts (company_id, chart_id, code, name, type, nature)
       VALUES ($1, $2, $3, $4, $5, $6) RETURNING id`,
      [companyA, chartId, code, name, type, nature],
    );
    return result.rows[0]!.id;
  };

  const cashA = await makeAccount('1.1.01', 'Caja', 'ACTIVO', 'DEUDORA');
  const salesA = await makeAccount('4.1.01', 'Ventas', 'INGRESO', 'ACREEDORA');

  const fy = await client.query<{ id: string }>(
    `INSERT INTO fiscal_years (company_id, code, start_date, end_date)
     VALUES ($1, $2, '2025-01-01', '2025-12-31') RETURNING id`,
    [companyA, `EJ2025-${suffix}`],
  );
  const fiscalYearA = fy.rows[0]!.id;

  const period = await client.query<{ id: string }>(
    `INSERT INTO periods (company_id, fiscal_year_id, number, start_date, end_date)
     VALUES ($1, $2, 1, '2025-01-01', '2025-01-31') RETURNING id`,
    [companyA, fiscalYearA],
  );

  return {
    organizationId,
    companyA,
    companyB,
    fiscalYearA,
    periodA: period.rows[0]!.id,
    cashA,
    salesA,
  };
}
