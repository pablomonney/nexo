/**
 * Saca de la base de DESARROLLO lo que dejaron los benchmarks y las pruebas a mano.
 *
 *     npm run limpiar:pruebas            → lista qué encontraría, sin tocar nada
 *     npm run limpiar:pruebas -- --hacelo → lo borra
 *
 * ## Por qué existe y por qué no borra solo
 *
 * Medir el motor de migración con cincuenta mil filas deja cincuenta mil filas.
 * Son datos de una empresa inventada y no le sirven a nadie, pero viven en la
 * misma base donde alguien puede tener su propia empresa de prueba con datos
 * que sí le importan. Borrar en silencio la base de otro es la clase de ayuda
 * que nadie pidió: por eso el modo por omisión **solo lista**.
 *
 * ## Por qué borra tabla por tabla y NO confía en la cascada
 *
 * `parties`, `products` y `stock_movements` tienen `forbid_delete`: el producto
 * no se borra, se archiva. Esa regla es correcta **dentro** del producto y no
 * tiene sentido para limpiar una empresa entera de mentira, así que se apagan
 * los triggers con `session_replication_role = replica`.
 *
 * Y ahí está la trampa que este script ya se comió una vez: **ese ajuste apaga
 * también las claves foráneas**. La primera versión borraba solo la fila de
 * `companies` esperando que la cascada se llevara el resto, y dejó 384.918
 * filas huérfanas apuntando a empresas que ya no existían —96.005 terceros
 * entre ellas—. Sin FK activas no hay cascada, y sin cascada el borrado de la
 * cabecera es solo el borrado de la cabecera.
 *
 * Por eso ahora se borra **de la hoja a la raíz**, tabla por tabla, con la lista
 * escrita acá abajo. Es más largo y es lo único que deja la base consistente.
 * Al final se comprueba que no quedó nada colgando, y si quedó, se deshace todo.
 *
 * NUNCA se ejecuta contra una base que no sea la de desarrollo: si el nombre
 * termina en `_test` se corta, porque esa la reconstruye `test-db.mjs`.
 */

import pg from 'pg';

const HACELO = process.argv.includes('--hacelo');

/** Cómo se llaman las empresas que este script reconoce como de prueba. */
const PATRONES = ['Bench %', 'Migración Prueba %', 'Migración V_ %', 'Empresa Bench %'];

/** Las cuentas descartables que quedan de probar la consola a mano. */
const CORREO_DE_PRUEBA = "email LIKE '%@prueba.local'";

const url = process.env.DATABASE_URL;
if (!url) {
  console.error('Falta DATABASE_URL.');
  process.exit(2);
}

const nombre = decodeURIComponent(new URL(url).pathname.replace(/^\//, ''));
if (nombre.endsWith('_test')) {
  console.error(
    `«${nombre}» es la base de pruebas y la reconstruye \`node scripts/test-db.mjs --reset\`. ` +
      'Este script es para la de desarrollo.',
  );
  process.exit(2);
}

const c = new pg.Client({ connectionString: url });
await c.connect();

const empresas = await c.query(
  `SELECT co.id, co.legal_name,
          (SELECT count(*) FROM parties p WHERE p.company_id = co.id)::int terceros,
          (SELECT count(*) FROM stock_movements s WHERE s.company_id = co.id)::int movimientos,
          (SELECT count(*) FROM migrations m WHERE m.company_id = co.id)::int migraciones
     FROM companies co
    WHERE ${PATRONES.map((_, i) => `co.legal_name LIKE $${i + 1}`).join(' OR ')}
    ORDER BY co.created_at`,
  PATRONES,
);

const usuarios = await c.query(
  `SELECT id, email, status FROM users WHERE ${CORREO_DE_PRUEBA} ORDER BY email`,
);

console.log(`Base: ${nombre}\n`);
if (empresas.rowCount === 0 && usuarios.rowCount === 0) {
  console.log('No hay nada de prueba que limpiar.');
  await c.end();
  process.exit(0);
}

console.table(empresas.rows);
console.table(usuarios.rows);

if (!HACELO) {
  console.log(
    '\nEsto es lo que se borraría. Para hacerlo:\n' +
      '  npm run limpiar:pruebas -- --hacelo',
  );
  await c.end();
  process.exit(0);
}

/**
 * De la hoja a la raíz. El orden es la mitad del script.
 *
 * Cada nombre es una constante de este archivo y nunca un dato: se interpola en
 * el `DELETE`, así que no puede venir de ningún lado más.
 */
const DE_LA_HOJA_A_LA_RAIZ = [
  'migration_findings',
  'migration_links',
  'migration_batches',
  'migration_rows',
  'migration_tables',
  'migrations',
  'payment_order_lines',
  'payment_orders',
  'party_allocations',
  'tax_transaction_lines',
  'tax_transactions',
  'journal_entry_lines',
  'ledger_movements',
  'journal_entries',
  'stock_movement_ppp',
  'stock_movements',
  'party_roles',
  'parties',
  'products',
  'warehouses',
  'periods',
  'fiscal_years',
  'accounts',
  'account_charts',
  'user_company_roles',
  'company_subscriptions',
  // La bitácora va con la empresa, y se puede.
  //
  // `audit_logs` tiene clave foránea a `companies`, así que dejarla sería dejar
  // filas apuntando a una empresa que no existe. Y se puede borrar sin romper
  // nada porque **la cadena de hashes es por empresa**: `audit_chain_link`
  // encadena contra el último `hash` de esa misma `company_id`, así que la de
  // las demás no se entera. Borrar la de una empresa real sería otra cosa —y
  // este script solo toca las que tienen nombre de prueba—.
  'audit_logs',
];

const ids = empresas.rows.map((e) => e.id);

await c.query('BEGIN');
try {
  // Los triggers que impiden borrar existen para el producto, no para tirar una
  // empresa de mentira. Se apagan acá adentro y vuelven al cerrar la
  // transacción. Ojo: esto apaga también las claves foráneas, así que la
  // cascada NO corre y hay que borrar cada tabla a mano.
  await c.query('SET LOCAL session_replication_role = replica');

  let filas = 0;
  for (const tabla of DE_LA_HOJA_A_LA_RAIZ) {
    const r = await c.query(`DELETE FROM ${tabla} WHERE company_id = ANY($1::uuid[])`, [ids]);
    filas += r.rowCount ?? 0;
  }
  const borradas = await c.query('DELETE FROM companies WHERE id = ANY($1::uuid[]) RETURNING id', [
    ids,
  ]);

  const orgs = await c.query(
    `DELETE FROM organization_members om
      WHERE NOT EXISTS (SELECT 1 FROM companies c2 WHERE c2.organization_id = om.organization_id)
      RETURNING organization_id`,
  );
  const estudios = await c.query(
    `DELETE FROM organizations o
      WHERE NOT EXISTS (SELECT 1 FROM companies c2 WHERE c2.organization_id = o.id)
        AND (o.name LIKE 'Bench%' OR o.name LIKE 'Estudio%')
      RETURNING id`,
  );
  const users = await c.query(`DELETE FROM users WHERE ${CORREO_DE_PRUEBA} RETURNING id`);

  // El candado: si algo quedó apuntando a una empresa que ya no está, no se
  // confirma nada. Es preferible no limpiar a dejar la base inconsistente.
  const huerfanas = await contarHuerfanas(c);
  if (huerfanas > 0) {
    throw new Error(
      `Quedarían ${huerfanas} filas apuntando a empresas borradas. Falta alguna tabla en ` +
        'DE_LA_HOJA_A_LA_RAIZ. No se borró nada.',
    );
  }

  await c.query('COMMIT');
  console.log(
    `\nBorradas ${borradas.rowCount} empresas, ${filas} filas suyas, ` +
      `${estudios.rowCount} estudios, ${orgs.rowCount} membresías y ${users.rowCount} cuentas.`,
  );
} catch (error) {
  await c.query('ROLLBACK');
  console.error('\nNo se borró nada:', error instanceof Error ? error.message : error);
  process.exitCode = 1;
}

/** Cuántas filas quedaron apuntando a una empresa que ya no existe. */
async function contarHuerfanas(cliente) {
  let total = 0;
  for (const tabla of DE_LA_HOJA_A_LA_RAIZ) {
    // `company_id IS NOT NULL` importa: una fila sin empresa no es huérfana,
    // es global —las plantillas de estados contables son así—. Sin esa
    // condición, `NOT EXISTS` da verdadero para los nulos y el candado se
    // trabaría para siempre por filas que están perfectamente bien.
    const r = await cliente.query(
      `SELECT count(*)::int n FROM ${tabla} x
        WHERE x.company_id IS NOT NULL
          AND NOT EXISTS (SELECT 1 FROM companies c2 WHERE c2.id = x.company_id)`,
    );
    total += r.rows[0].n;
  }
  return total;
}

await c.end();
