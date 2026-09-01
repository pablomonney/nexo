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
  ['parties', 'parties_documento_coherente', 'Sin documento solo si se declaró SIN_IDENTIFICAR'],
  ['parties', 'parties_documento_forma', 'CUIT y CUIL de once dígitos; DNI de hasta ocho'],
  ['products', 'products_gravado_con_impuesto', 'Un producto gravado dice qué impuesto le aplica'],
  ['products', 'products_servicio_sin_stock', 'Un servicio no tiene existencias'],
  ['tax_transaction_lines', 'ttl_iva_solo_si_grava', 'Un renglón no gravado no lleva IVA'],
  ['commercial_documents', 'cd_facturado_con_operacion', 'FACTURADO si y solo si hay operación fiscal'],
  ['commercial_documents', 'cd_anulado_con_motivo', 'Una anulación sin motivo no se registra'],
  ['commercial_document_lines', 'cdl_iva_solo_si_grava', 'Un renglón no gravado no lleva IVA'],
  ['notes', 'notes_no_se_aprueba_sin_evidencia', 'Una nota sin evidencia no se firma'],
  ['notes', 'notes_version_con_motivo', 'Una versión nueva dice qué cambió'],
  ['note_figures', 'nf_con_origen', 'A-2: una cifra con importe tiene linaje detrás'],
  ['account_balances', 'balance_arithmetic', 'El saldo final se deriva de sus movimientos'],
  ['normative_audit_logs', 'normative_audit_logs_motivo_check', 'Un acto normativo sin constancia escrita no se registra'],
  ['tax_transactions', 'tt_constatacion_coherente', 'Un resultado de constatación sin procedencia no entra'],
  ['tax_transactions', 'tt_constatacion_arca_con_consulta', 'Una constatación de ARCA muestra la consulta que la produjo'],
  ['tax_transactions', 'tt_constatacion_declarada_firmada', 'Una constatación declarada lleva firma y fecha'],
  ['accounting_decisions', 'decision_correccion_con_motivo', 'Corregir una decisión exige decir qué cambió'],
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
  ['tax_transactions', 'tt_party_coherente', '0047: no se vincula un tercero con otro CUIT'],
  ['parties', 'parties_no_delete', 'Un tercero con movimientos se archiva, no se borra'],
  ['party_roles', 'party_roles_no_delete', 'Un rol declarado no desaparece sin rastro'],
  ['products', 'products_cuentas_coherentes', '0048: la cuenta sugerida es imputable y del tipo correcto'],
  ['products', 'products_no_delete', 'Un producto facturado se archiva, no se borra'],
  ['tax_transaction_lines', 'ttl_renglones_cierran', '0049: el detalle cierra con la cabecera (diferido)'],
  ['tax_transactions', 'tt_renglones_cierran', '0049: cambiar la cabecera no descuadra el detalle'],
  ['tax_transaction_lines', 'ttl_editables', 'El detalle de un comprobante imputado no se edita'],
  ['commercial_documents', 'commercial_documents_transicion', '0050: la máquina de estados vive en la base'],
  ['commercial_documents', 'commercial_documents_no_delete', 'Un presupuesto emitido no se borra'],
  ['commercial_document_lines', 'cdl_editables', 'Lo que se le ofreció al cliente no se edita'],
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
  ['accounting_decisions', 'accounting_decisions_supersede_coherente', 'Una corrección es de la misma empresa y del mismo comprobante'],
  ['arca_query_log', 'arca_query_log_credencial_coherente', 'La credencial que firmó una consulta es de esa empresa'],
  // El guard anterior era `status <> 'IMPUTADO'` en el handler, y nadie escribe
  // ese estado: la condición nunca era falsa y el candado estaba apagado desde
  // la 0016. Ahora pregunta por el hecho, y desde la base.
  ['documents', 'documents_anulacion_sin_operacion', 'Un documento que funda una operación fiscal no se anula'],
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
  ['parties_documento_unico', 'Un documento, un tercero, por empresa'],
  ['products_code_unico', 'Un código, un producto, por empresa'],
  ['cd_una_operacion', 'Una operación fiscal nace de un solo documento comercial'],
  ['cd_una_sucesora', 'Un documento reemplaza como mucho a uno anterior'],
];

/**
 * Claves foráneas que llevan la empresa **dentro de la clave**.
 *
 * Una FK simple a `parties (id)` dejaría que una empresa impute un movimiento
 * al tercero de otra: el uuid existe y la restricción lo aceptaría. RLS no lo
 * impide, porque las restricciones foráneas se verifican con privilegios del
 * sistema y ven la fila igual. La única defensa es que la empresa forme parte
 * de la clave referenciada.
 */
const FK_CON_EMPRESA = [
  ['journal_entry_lines', 'jel_party_fk', 'Un asiento no se imputa al tercero de otra empresa'],
  ['tax_transactions', 'tt_party_fk', 'Un comprobante no se vincula al tercero de otra empresa'],
  ['products', 'products_cuenta_venta_fk', 'Un producto no apunta a la cuenta de venta de otra empresa'],
  ['products', 'products_cuenta_compra_fk', 'Un producto no apunta a la cuenta de compra de otra empresa'],
  ['tax_transaction_lines', 'ttl_comprobante_fk', 'Un renglón no cuelga del comprobante de otra empresa'],
  ['tax_transaction_lines', 'ttl_producto_fk', 'Un renglón no cita el producto de otra empresa'],
  ['commercial_documents', 'cd_party_fk', 'No se presupuesta al tercero de otra empresa'],
  ['commercial_documents', 'cd_tax_transaction_fk', 'La factura resultante es de la misma empresa'],
  ['commercial_document_lines', 'cdl_documento_fk', 'Un renglón no cuelga del documento de otra empresa'],
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
  // El maestro de terceros (0047). Es el dato comercial más sensible que tiene
  // una empresa: a quién le compra, a quién le vende y cuánto le debe.
  'parties', 'party_roles',
  // El maestro de productos (0048): precios, márgenes y costos de la empresa.
  'products', 'tax_transaction_lines',
  // El ciclo comercial (0050): precios ofrecidos y pedidos de cada empresa.
  'commercial_documents', 'commercial_document_lines', 'commercial_counters',
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
  // La bandeja de trabajo (0045). Lee veinte tablas con RLS forzado: sin
  // `security_invoker` repartiría el trabajo pendiente de todas las empresas.
  // La bandeja es una unión de vistas por dominio desde la 0051. Las tres
  // llevan `security_invoker`: una sola sin él en cualquier eslabón de la
  // cadena saltearía el RLS y repartiría el trabajo de todas las empresas.
  'work_queue', 'work_queue_nucleo', 'work_queue_comercial',
  // La cuenta corriente (0047). Suma el Mayor de un tercero: sin
  // `security_invoker` mostraría lo que le debe cada empresa a ese CUIT.
  'party_balances',
  // Qué se movió de cada producto (0049). Son precios y volúmenes: sin
  // `security_invoker` mostraría el negocio de las demás empresas.
  'product_movements',
];

/**
 * Funciones `SECURITY DEFINER` y la forma que las hace seguras.
 *
 * Una función privilegiada corre con los permisos de su dueño: lo que la vuelve
 * segura no es el `GRANT`, es **qué puede recibir**. `user_companies()` no toma
 * argumentos a propósito — deriva el usuario de `app.actor_id`— y agregarle un
 * `p_user_id` la convertiría en un oráculo para preguntar por la cartera de
 * cualquier otro usuario del estudio. Que la firma sea vacía es el candado, y
 * por eso se verifica acá y no solo en un test.
 */
const FUNCIONES_PRIVILEGIADAS = [
  ['user_companies', '', 'Sin parámetros: no se le puede preguntar por otro usuario'],
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

  // No alcanza con que la clave foránea exista: tiene que llevar `company_id`
  // como primera columna. Una FK con ese nombre pero apuntando solo al `id`
  // pasaría un chequeo de existencia y dejaría el hueco abierto igual.
  const conEmpresa = await client.query(
    `SELECT c.conname AS nombre
       FROM pg_constraint c
       JOIN pg_attribute a
         ON a.attrelid = c.conrelid AND a.attnum = c.conkey[1]
      WHERE c.contype = 'f' AND a.attname = 'company_id'`,
  );
  const fks = new Set(conEmpresa.rows.map((r) => r.nombre));
  for (const [tabla, nombre, que] of FK_CON_EMPRESA) {
    anotar('FK + EMPRESA', `${tabla}.${nombre}`, que, fks.has(nombre));
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

  const privilegiadas = await client.query(
    `SELECT proname AS nombre, pg_get_function_arguments(oid) AS args, prosecdef
       FROM pg_proc WHERE prosecdef`,
  );
  for (const [nombre, firma, que] of FUNCIONES_PRIVILEGIADAS) {
    const fila = privilegiadas.rows.find((r) => r.nombre === nombre);
    anotar('FUNCIÓN', `${nombre}(${firma})`, que, fila !== undefined && fila.args === firma);
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
