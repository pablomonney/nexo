#!/usr/bin/env node
/**
 * Designa la empresa PROPIETARIA de NEXO: la única que ve «Mis clientes» (cuántas cuentas entran y cuántas suscripciones pagan).
 *
 *   node scripts/designar-propietaria.mjs --cuit 20452148324 --motivo "NEXO propietario: administra a las demás empresas"
 *   node scripts/designar-propietaria.mjs --empresa <uuid>   --motivo "…"
 *   node scripts/designar-propietaria.mjs --ver                 # quién es hoy, sin cambiar nada
 *
 * ## Por qué es un script del operador y no una ruta
 *
 * Designar a la propietaria le da a una empresa la visión de TODAS las demás. Si una empresa pudiera designarse a sí misma, el
 * aislamiento entre clientes dependería de que nadie lo intente: por eso `platform_owner` no la lee ni la escribe `aai_app`
 * (migración 0140) y la única puerta es esta, con las credenciales de base de datos del operador (`DATABASE_URL`).
 *
 * No toca nada más: una sola fila, con motivo escrito y quién la designó. Cambiarla reemplaza la fila anterior.
 */

import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { userInfo } from 'node:os';
import pg from 'pg';

const RAIZ = join(dirname(fileURLToPath(import.meta.url)), '..');
try {
  process.loadEnvFile(join(RAIZ, '.env'));
} catch {
  // En el servidor las variables vienen del entorno del contenedor.
}

const args = new Map();
for (let i = 2; i < process.argv.length; i += 1) {
  const a = process.argv[i];
  if (a.startsWith('--')) {
    const sig = process.argv[i + 1];
    if (sig === undefined || sig.startsWith('--')) args.set(a.slice(2), 'si');
    else {
      args.set(a.slice(2), sig);
      i += 1;
    }
  }
}

const url = process.env.DATABASE_URL;
if (!url) {
  console.error('Falta DATABASE_URL.');
  process.exit(1);
}

const cliente = new pg.Client({ connectionString: url });
await cliente.connect();
try {
  const actual = await cliente.query(
    `SELECT p.empresa_propietaria_id, c.legal_name, c.cuit, p.designada_el, p.designada_por, p.motivo
       FROM platform_owner p JOIN companies c ON c.id = p.empresa_propietaria_id`,
  );
  const mostrar = (f) =>
    f === undefined
      ? 'No hay empresa propietaria designada.'
      : `Propietaria: ${f.legal_name} (CUIT ${f.cuit}), designada el ${new Date(f.designada_el).toISOString()} por ${f.designada_por}. Motivo: ${f.motivo}`;

  if (args.has('ver') || (!args.has('cuit') && !args.has('empresa'))) {
    console.log(mostrar(actual.rows[0]));
    if (!args.has('ver')) console.log('\nUso: --cuit <CUIT> | --empresa <uuid>  --motivo "<por qué>"');
    process.exit(0);
  }

  const motivo = (args.get('motivo') ?? '').trim();
  if (motivo.length < 5) {
    console.error('Falta --motivo (al menos 5 caracteres): designar a la propietaria tiene que poder explicarse dentro de un año.');
    process.exit(2);
  }

  const candidatas = args.has('empresa')
    ? await cliente.query('SELECT id, legal_name, cuit FROM companies WHERE id = $1', [args.get('empresa')])
    : await cliente.query('SELECT id, legal_name, cuit FROM companies WHERE cuit = $1', [String(args.get('cuit')).replace(/\D/gu, '')]);

  if (candidatas.rowCount === 0) {
    console.error('No existe esa empresa. Se crea primero (alta autoservicio o estudio) y después se designa.');
    process.exit(3);
  }
  if (candidatas.rowCount > 1) {
    console.error(`Hay ${candidatas.rowCount} empresas con ese CUIT; usá --empresa <uuid>:`);
    for (const c of candidatas.rows) console.error(`  ${c.id}  ${c.legal_name}`);
    process.exit(4);
  }

  const c = candidatas.rows[0];
  const quien = `operador:${userInfo().username}`;
  await cliente.query(
    `INSERT INTO platform_owner (empresa_propietaria_id, designada_por, motivo) VALUES ($1, $2, $3)
     ON CONFLICT (singleton) DO UPDATE
        SET empresa_propietaria_id = EXCLUDED.empresa_propietaria_id, designada_el = now(),
            designada_por = EXCLUDED.designada_por, motivo = EXCLUDED.motivo`,
    [c.id, quien, motivo],
  );
  console.log(`Listo. ${c.legal_name} (CUIT ${c.cuit}) es ahora la empresa propietaria.`);
} finally {
  await cliente.end();
}
