#!/usr/bin/env node
/**
 * Los datos base que toda instalación necesita, en un solo comando.
 *
 *   npm run seed:base
 *
 * ## Por qué hacía falta
 *
 * `desplegar.sh` corre `migrate.mjs up` y nada más. Las migraciones crean las
 * tablas; **no las llenan**, y varias del sistema no son configuración de una
 * empresa sino datos globales que existen o no existen:
 *
 *     arca_comprobante_types   sin esto ningún comprobante tiene clase, y sin
 *                              clase no se propone ningún asiento: no se sabe
 *                              si una nota de crédito suma o resta
 *     norms / norm_versions    las normas archivadas con su sha256
 *     tax_rates                las alícuotas de IVA con su artículo
 *     statement_templates      las plantillas de ESP y ER (Ley 19.550, 63 y 64)
 *     prompt_versions          los prompts registrados por hash
 *
 * Una base migrada y vacía arranca bien, deja crear empresas y deja registrar
 * asientos a mano. Lo que **no** puede hacer es proponer un asiento desde un
 * comprobante ni emitir un estado contable, y el motivo no era obvio desde el
 * lado del usuario: la API contestaba correctamente que no sabía.
 *
 * ## Qué NO siembra, a propósito
 *
 *     accounting_rules    entran en DRAFT y las aprueba una persona (§32). El
 *                         circuito está diseñado para funcionar con cero reglas
 *                         y decirlo: `FUENTE_NO_ENCONTRADA` es una respuesta,
 *                         no una falla.
 *     accounts            el plan es POR EMPRESA. Se materializa desde la
 *                         consola con `POST /chart-template`.
 *     company_account_map el mapeo es una declaración de cada empresa sobre su
 *                         propio plan. Sembrarlo sería inventar su contabilidad.
 *     precios del plan    son datos comerciales, no datos base del sistema.
 *
 * ## Se puede correr las veces que haga falta
 *
 * Los cinco sembradores comprueban antes de insertar: `ON CONFLICT` en los
 * tipos de comprobante, las normas y los prompts; comparación de estructura
 * canónica en las plantillas; y búsqueda por vigencia en las alícuotas, que la
 * 0021 prohíbe reescribir. Correrlo dos veces no duplica nada.
 *
 * ## El orden importa
 *
 * Las alícuotas y las plantillas tienen `norm_version_id NOT NULL`: sin las
 * normas sembradas primero, las dos fallan. Por eso esto es un script y no
 * cinco líneas encadenadas en `package.json`.
 */

import { spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const AQUI = dirname(fileURLToPath(import.meta.url));
const RAIZ = join(AQUI, '..');
if (existsSync(join(RAIZ, '.env'))) process.loadEnvFile(join(RAIZ, '.env'));

if ((process.env.DATABASE_URL ?? '') === '') {
  console.error('Falta DATABASE_URL.');
  process.exit(1);
}

/** En orden de dependencia: las normas antes de lo que las referencia. */
const PASOS = [
  ['catálogo de comprobantes de ARCA', 'seed-comprobante-types.mjs'],
  ['prompts registrados', 'register-prompts.mjs'],
  ['normas archivadas', 'seed-norms.mjs'],
  ['alícuotas de IVA', 'seed-tax-rates.mjs'],
  ['plantillas de estados contables', 'seed-statement-templates.mjs'],
];

const destino = process.env.DATABASE_URL.replace(/:\/\/[^@]*@/u, '://***@');
console.log(`Sembrando datos base en ${destino}`);
console.log('');

for (const [nombre, archivo] of PASOS) {
  const resultado = spawnSync(process.execPath, [join(AQUI, archivo)], {
    stdio: 'inherit',
    env: process.env,
  });
  if (resultado.status !== 0) {
    console.error('');
    console.error(`✖ falló: ${nombre} (${archivo})`);
    console.error('  No se siguió con los pasos que faltaban: los que vienen después');
    console.error('  dependen de lo que este paso tenía que dejar.');
    process.exit(resultado.status ?? 1);
  }
  console.log(`  ✔ ${nombre}`);
}

console.log('');
console.log('Datos base sembrados.');
console.log('');
console.log('Lo que sigue es por empresa y lo hace quien la administra:');
console.log('  1. materializar el plan de cuentas   POST /chart-template');
console.log('  2. declarar el mapeo contable        PUT  /accounting-map');
console.log('  3. declarar el marco contable        POST /companies/current/reporting-framework');
console.log('  4. abrir el ejercicio                POST /fiscal-years');
