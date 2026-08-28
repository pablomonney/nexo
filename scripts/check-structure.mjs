#!/usr/bin/env node
/**
 * Verificación **estructural**: que los candados existan.
 *
 *   npm run audit:estructura
 *
 * Es la mitad que no necesita datos. `audit:invariants` pregunta *«¿las filas
 * que hay cumplen la propiedad?»* y para eso necesita filas; esto pregunta
 * *«¿está puesto el candado que hace que no puedan dejar de cumplirla?»*, y para
 * eso alcanza con el esquema.
 *
 * ## Por qué separarlas
 *
 * Son dos preguntas distintas y fallan por motivos distintos. Una base recién
 * migrada y vacía tiene que dar **estructural verde** y **conductual sin
 * ejercitar**: si las dos se mezclaran en un solo número, esa base saldría
 * "parcialmente verde" y nadie sabría cuál de las dos mitades es la que falta.
 *
 * Y al revés: un trigger que existe pero que nunca recibió una fila válida y una
 * inválida no está probado. Por eso esto **no reemplaza** a los invariantes ni a
 * los tests — dice que la pieza está, no que funcione.
 *
 * ## Qué se declara acá
 *
 * El inventario no es exhaustivo a propósito: son los objetos de los que
 * dependen los invariantes A-1 a A-14 y las promesas centrales del producto. Un
 * inventario que enumerara cada índice se volvería una copia del esquema que hay
 * que actualizar en cada migración, y la primera vez que alguien la desactualice
 * el checker pasa a informar ruido.
 */

import { existsSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import pg from 'pg';

const HERE = dirname(fileURLToPath(import.meta.url));
if (existsSync(join(HERE, '..', '.env'))) {
  process.loadEnvFile(join(HERE, '..', '.env'));
}

/** CHECK constraints de los que depende un invariante. */
const CHECKS = [
  ['journal_entries', 'je_balanced', 'Debe = Haber en la cabecera'],
  ['journal_entries', 'je_approved_signed', 'Un asiento aprobado tiene aprobador y fecha'],
  ['journal_entries', 'je_ai_requires_human_approval', 'A-6: ningún asiento de IA sin firma humana'],
  ['journal_entries', 'je_trazabilidad_obligatoria', 'A-3: las tres vías de trazabilidad'],
  ['journal_entries', 'je_reversal_target', 'Una reversión referencia al asiento que anula'],
  ['journal_entry_lines', 'jel_one_side', 'Una línea es débito o crédito, no las dos'],
  ['journal_entry_lines', 'jel_fx_complete', 'Moneda extranjera con cotización, fuente y fecha'],
  ['accounting_closures', 'ac_completado_completo', 'Un cierre COMPLETADO dice con qué cerró'],
  ['accounting_closures', 'ac_apertura_solo_sobre_cierre_completo', 'A-13: la apertura nace de un cierre'],
  ['accounts', 'accounts_resultado_es_pn_imputable', 'La cuenta de resultado es PN e imputable'],
  ['notes', 'notes_no_se_aprueba_sin_evidencia', 'Una nota sin evidencia no se firma'],
  ['notes', 'notes_version_con_motivo', 'Una versión nueva dice qué cambió'],
  ['note_figures', 'nf_con_origen', 'A-2: una cifra con importe tiene linaje detrás'],
  ['account_balances', 'balance_arithmetic', 'El saldo final se deriva de sus movimientos'],
  ['normative_audit_logs', 'normative_audit_logs_motivo_check', 'Un acto normativo sin constancia escrita no se registra'],
  ['tax_transactions', 'tt_constatacion_coherente', 'Un resultado de constatación sin procedencia no entra'],
  ['tax_transactions', 'tt_constatacion_arca_con_consulta', 'Una constatación de ARCA muestra la consulta que la produjo'],
  ['tax_transactions', 'tt_constatacion_declarada_firmada', 'Una constatación declarada lleva firma y fecha'],
];

/** Triggers que hacen valer un invariante en la escritura. */
const TRIGGERS = [
  ['journal_entries', 'je_entry_consistent', 'La cabecera no miente sobre sus líneas (diferido)'],
  ['journal_entries', 'je_period_guard', 'CANDADO 4: período abierto y fecha en rango'],
  ['journal_entries', 'je_fiscal_year_guard', 'Estado del ejercicio: EN_CIERRE y CERRADO'],
  ['journal_entries', 'je_approved_immutable', 'CANDADO 5: un asiento aprobado no se edita'],
  ['journal_entries', 'je_no_delete', 'CANDADO 6: borrado físico imposible'],
  ['journal_entries', 'je_project_ledger', 'A-7: el Mayor lo escribe un trigger, no la aplicación'],
  ['journal_entries', 'journal_entries_decision_coherente', 'A-10: la decisión es de esta empresa y no es de PRUEBA'],
  ['journal_entry_lines', 'jel_entry_consistent', 'Debe = Haber verificado al COMMIT'],
  ['journal_entry_lines', 'jel_account_valid', 'CANDADO 7: cuenta imputable y dimensiones'],
  ['ledger_movements', 'ledger_movements_immutable', 'El Mayor no se edita ni se borra'],
  ['accounting_closures', 'accounting_closures_inmutable', 'Lo que fundamentó un cierre no cambia'],
  ['accounting_closures', 'accounting_closures_no_delete', 'Un cierre no se borra'],
  ['accounting_decisions', 'accounting_decisions_inmutable', 'Una decisión usada no se edita'],
  ['notes', 'notes_inmutable', 'Una nota aprobada no se edita: se supersede'],
  ['note_figures', 'note_figures_match_line', 'A-2: la cifra dice lo mismo que su renglón'],
  ['note_figures', 'note_figures_inmutables', 'Las cifras de una nota firmada no se tocan'],
  ['audit_logs', 'audit_logs_chain', 'A-5: cada entrada encadena con el hash de la anterior'],
  ['audit_logs', 'audit_logs_immutable', 'A-5: la cadena solo crece; nada se edita ni se borra'],
  ['normative_audit_logs', 'normative_audit_logs_chain', 'La bitácora normativa también encadena por hash'],
  ['normative_audit_logs', 'normative_audit_logs_immutable', 'La bitácora normativa solo crece'],
  ['accounting_rules', 'accounting_rules_gap_abierto', 'Un gap normativo ABIERTO bloquea la activación de la regla'],
  ['periods', 'periods_transicion_valida', 'La máquina de estados del período, no solo en TypeScript'],
  ['tax_transactions', 'tax_transactions_constatacion_coherente', 'La consulta ARCA que respalda es de esta empresa y del servicio wscdc'],
  ['tax_transactions', 'tax_transactions_constatacion_no_degrada', 'Una declaración no reemplaza una respuesta del organismo'],
  ['user_company_roles', 'user_company_roles_audit', 'Dar o quitar acceso a una empresa deja su entrada en la bitácora'],
];

/** Índices únicos que sostienen una unicidad de negocio. */
const INDICES = [
  ['journal_entries_unique_source', 'E_DUPLICATE_SOURCE: un comprobante, un asiento vigente'],
  ['journal_entries_una_refundicion_por_ejercicio', 'Una sola refundición por ejercicio'],
  ['journal_entries_un_cierre_por_ejercicio', 'Un solo asiento de cierre por ejercicio'],
  ['journal_entries_una_apertura_por_ejercicio', 'Una sola apertura por ejercicio'],
  ['accounting_closures_uno_por_ejercicio', 'A-11: un cierre vivo por ejercicio'],
  ['accounting_closures_apertura_unica', 'Cada apertura pertenece a un solo cierre'],
  ['accounts_una_cuenta_de_resultado', 'Una sola cuenta de resultado por empresa'],
  ['accounting_decisions_una_vigente', 'Una decisión vigente por operación fiscal'],
  ['notes_numero_vigente', 'Un número de nota por estado, entre las no supersedidas'],
  ['notes_una_sucesora', 'Una nota reemplaza como mucho a una anterior'],
];

/**
 * Tablas con RLS **forzado**.
 *
 * `ENABLE` no alcanza: sin `FORCE`, el dueño de la tabla la lee entera. La lista
 * sale de la 0009 y de las migraciones que agregaron tablas después.
 */
const RLS_FORZADO = [
  'accounts', 'fiscal_years', 'periods', 'journal_entries', 'journal_entry_lines',
  'notes', 'note_figures',
  'ledger_movements', 'account_balances', 'accounting_closures', 'accounting_decisions',
  'rule_applications', 'audit_logs', 'tax_transactions', 'ai_predictions',
];

/**
 * Vistas que tienen que correr con los permisos de quien consulta.
 *
 * Una vista sin `security_invoker` se evalúa con los del que la creó y **saltea
 * el RLS** de las tablas de abajo. La 0032 lo arregló en nueve vistas después de
 * encontrar una fuga entre empresas que estaba desde la 0016.
 */
const VISTAS_INVOKER = [
  'ledger_trace', 'trial_balance', 'bank_trace', 'note_trace', 'statement_trace',
  'documents_pendientes', 'predictions_pendientes', 'company_arca_credentials_public',
  'statement_package',
  'ai_answer_metrics',
];

export async function verificarEstructura(client) {
  const hallazgos = [];
  const anotar = (grupo, objeto, que, ok) => {
    hallazgos.push({ grupo, objeto, que, ok });
  };

  const existentes = async (sql, params = []) =>
    new Set((await client.query(sql, params)).rows.map((r) => r.nombre));

  const checks = await existentes(
    `SELECT conname AS nombre FROM pg_constraint WHERE contype = 'c'`,
  );
  for (const [tabla, nombre, que] of CHECKS) {
    anotar('CHECK', `${tabla}.${nombre}`, que, checks.has(nombre));
  }

  const triggers = await existentes(
    'SELECT tgname AS nombre FROM pg_trigger WHERE NOT tgisinternal',
  );
  for (const [tabla, nombre, que] of TRIGGERS) {
    anotar('TRIGGER', `${tabla}.${nombre}`, que, triggers.has(nombre));
  }

  const indices = await existentes(
    'SELECT indexname AS nombre FROM pg_indexes WHERE schemaname = current_schema()',
  );
  for (const [nombre, que] of INDICES) {
    anotar('ÍNDICE', nombre, que, indices.has(nombre));
  }

  const forzadas = await existentes(
    `SELECT c.relname AS nombre FROM pg_class c
      WHERE c.relrowsecurity AND c.relforcerowsecurity`,
  );
  for (const tabla of RLS_FORZADO) {
    anotar('RLS FORCE', tabla, 'Aislamiento por empresa, también para el dueño', forzadas.has(tabla));
  }

  const invoker = await existentes(
    `SELECT c.relname AS nombre FROM pg_class c
      WHERE c.relkind = 'v' AND 'security_invoker=true' = ANY(c.reloptions)`,
  );
  for (const vista of VISTAS_INVOKER) {
    anotar('VISTA', vista, 'security_invoker: no saltea el RLS de abajo', invoker.has(vista));
  }

  // El rol de la aplicación no puede saltear el RLS. Es la condición de la que
  // depende todo lo anterior: con `BYPASSRLS`, las políticas son decorativas.
  const rol = await client.query(
    `SELECT rolbypassrls FROM pg_roles WHERE rolname = 'aai_app'`,
  );
  anotar(
    'ROL',
    'aai_app',
    'NOBYPASSRLS: sin esto las políticas de RLS son decorativas',
    rol.rows.length > 0 && rol.rows[0].rolbypassrls === false,
  );

  return hallazgos;
}

const invocadoDirectamente =
  process.argv[1] !== undefined &&
  resolve(fileURLToPath(import.meta.url)) === resolve(process.argv[1]);

if (invocadoDirectamente) {
  const url = process.env.DATABASE_URL ?? '';
  if (url === '') {
    console.log('audit:estructura — sin DATABASE_URL. Nada que verificar.');
    process.exit(0);
  }

  const client = new pg.Client({ connectionString: url });
  await client.connect();
  let hallazgos;
  try {
    hallazgos = await verificarEstructura(client);
  } finally {
    await client.end();
  }

  const faltantes = hallazgos.filter((h) => !h.ok);
  for (const h of faltantes) {
    console.error(`  ✘ ${h.grupo} ${h.objeto} — FALTA. ${h.que}`);
  }

  console.log('');
  if (faltantes.length > 0) {
    console.error(
      `audit:estructura — faltan ${faltantes.length} de ${hallazgos.length} objetos declarados.`,
    );
    console.error('');
    console.error('Cada uno es un candado que el sistema dice tener. Sin él, la propiedad que');
    console.error('protege depende de que la aplicación no tenga bugs — que es exactamente la');
    console.error('dependencia que estos objetos existen para eliminar.');
    process.exit(1);
  }

  console.log(`audit:estructura — los ${hallazgos.length} objetos declarados están presentes.`);
  console.log('');
  console.log('Esto dice que los candados ESTÁN, no que funcionen: un trigger que nunca');
  console.log('recibió una fila válida y una inválida no está probado. Eso lo hacen los tests');
  console.log('de integración y el modo conductual de audit:invariants.');
}
