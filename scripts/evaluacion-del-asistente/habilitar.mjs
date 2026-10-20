#!/usr/bin/env node
/**
 * Enciende el asistente en las dos empresas de la cuenta de prueba y levanta el tope de tokens del plan SÓLO en la base de pruebas, para que la
 * evaluación no la corte el cupo. También sirve para cortar o restaurar el acceso a la primera empresa (para sembrar datos en la segunda):
 *
 *   node scripts/evaluacion-del-asistente/habilitar.mjs                      # enciende y sube el tope
 *   node scripts/evaluacion-del-asistente/habilitar.mjs --cortar-primera     # la persona pierde el rol en la primera empresa
 *   node scripts/evaluacion-del-asistente/habilitar.mjs --restaurar-primera
 */

import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import pg from 'pg';
import { RAIZ, baseDePruebas, opcionesDeCliente } from './comun.mjs';

const cuenta = JSON.parse(readFileSync(join(RAIZ, 'var', 'evaluacion', 'cuenta.json'), 'utf8'));
const c = new pg.Client(opcionesDeCliente(baseDePruebas()));
await c.connect();

if (process.argv.includes('--cortar-primera') || process.argv.includes('--restaurar-primera')) {
  const cortar = process.argv.includes('--cortar-primera');
  await c.query(`UPDATE user_company_roles SET valid_to = ${cortar ? 'CURRENT_DATE - 1' : 'NULL'} WHERE company_id = $1 AND valid_from <= CURRENT_DATE`, [cuenta.empresas[0].id]);
  console.log(cortar ? 'La persona ya no tiene rol en la primera empresa.' : 'Rol de la primera empresa restaurado.');
} else {
  for (const e of cuenta.empresas) {
    await c.query(
      `INSERT INTO assistant_settings (company_id, habilitado, motivo, declarado_por)
       VALUES ($1, true, 'Evaluación local del asistente con datos de prueba', 'evaluacion')
       ON CONFLICT (company_id) DO UPDATE SET habilitado = true`,
      [e.id],
    );
  }
  await c.query(`UPDATE plan_ai_quotas SET tokens_por_dia = 50000000, motivo = 'Evaluación local, sólo en la base de pruebas'`);
  console.log('Asistente encendido en las dos empresas; tope de tokens del plan levantado (sólo en esta base de pruebas).');
}
await c.end();
