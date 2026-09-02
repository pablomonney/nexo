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
  ['goods_receipts', 'gr_anulada_con_motivo', 'Anular una recepción exige decir por qué'],
  ['party_allocations', 'pa_anulada_con_motivo', 'Anular una imputación exige decir por qué'],
  ['tax_transaction_installments', 'tax_transaction_installments_importe_check', 'Una cuota vale más que cero'],
  ['price_lists', 'pl_vigencia_coherente', 'Una lista no termina antes de empezar'],
  ['checks', 'ck_propio_con_cuenta', 'Un cheque propio sale de una cuenta de la empresa'],
  ['products', 'products_lote_exige_stock', 'Un producto sin existencias no tiene lotes'],
  ['stock_counts', 'sc_cerrado_firmado', 'Un recuento cerrado dice quién y cuándo'],
  ['stock_counts', 'sc_anulado_con_motivo', 'Anular un recuento exige decir por qué'],
  // 0068 · Una caja cerrada sin lo contado no es un arqueo: es una caja que
  // alguien dio por terminada sin contar.
  ['cash_sessions', 'cs_cerrada_completa', '0068: una sesión cerrada dice cuánto se contó, cuándo y quién'],
  ['cash_sessions', 'cs_cierre_no_anterior', '0068: no se cierra antes de abrir'],
  // 0069 · Una oportunidad es de alguien. Sin tercero ni prospecto, el embudo
  // cuenta plata que no se le puede pedir a nadie.
  ['crm_opportunities', 'co_alguien', '0069: la oportunidad nombra al tercero o al prospecto'],
  // 0070 · Cerrar un proyecto sin decir por qué deja sin explicación el número
  // con el que se lo cerró.
  ['projects', 'pj_cierre_completo', '0070: un proyecto cerrado dice cuándo y por qué'],
  ['projects', 'pj_fin_no_anterior', '0070: no termina antes de empezar'],
  ['project_hour_rates', 'phr_vigencia_coherente', '0070: una tarifa no deja de regir antes de regir'],
  // 0071 · Un acuerdo de comisión que deja de regir antes de empezar no es un acuerdo.
  ['commission_schemes', 'cms_vigencia_coherente', '0071: un esquema no deja de regir antes de regir'],
  // 0072 · Cerrar una sucursal sin decir cuándo ni por qué deja sus ventas sin
  // explicación de origen.
  ['branches', 'br_cierre_completo', '0072: una sucursal cerrada dice cuándo y por qué'],
  ['branch_points_of_sale', 'bpv_vigencia_coherente', '0072: un punto de venta no deja de ser de una boca antes de serlo'],
  // 0073 · Suspender o cancelar un plan sin decir por qué deja al cliente sin
  // explicación de un corte que le afecta el servicio.
  ['company_subscriptions', 'cs_baja_con_motivo', '0073: suspender o cancelar exige decir por qué'],
  // 0077 · El costo de una salida es el promedio del momento: dejar que alguien
  // lo escriba crearía una segunda verdad capaz de contradecirlo.
  ['stock_movements', 'sm_costo_solo_en_entradas', '0077: solo las entradas declaran costo'],
  ['company_stock_valuation', 'csv_vigencia_coherente', '0077: un método no deja de regir antes de regir'],
  ['company_subscriptions', 'cs_vigencia_coherente', '0073: un plan no deja de regir antes de regir'],
  ['checks', 'ck_fecha_pago_no_anterior', 'No se cobra antes de librarse'],
  ['check_movements', 'cm_motivo_cuando_corresponde', 'Un rechazo o una anulación dicen por qué'],
  ['stock_movements', 'sm_ajuste_con_motivo', 'Un ajuste de stock sin explicación no se registra'],
  ['stock_movements', 'sm_tipo_coherente', 'El tipo de movimiento y su origen no se contradicen'],
  ['stock_movements', 'sm_origen_citado', 'Lo que viene de un hecho registrado dice de cuál'],
  ['fixed_assets', 'fa_residual_menor_al_costo', 'El residual no se come el costo: algo hay que amortizar'],
  ['fixed_assets', 'fa_baja_completa', 'Una baja dice cuándo'],
  ['fixed_assets', 'fa_baja_con_motivo', 'Una baja dice por qué'],
  ['external_records', 'er_resuelto_con_entidad', '0056: RESUELTO exige exactamente una entidad'],
  ['external_records', 'er_resuelto_firmado', 'Una resolución dice quién y cuándo'],
  ['external_records', 'er_descarte_con_motivo', 'Descartar lo de afuera exige decir por qué'],
  ['integration_sync_runs', 'isr_cuentas_cierran', 'Recibidos = nuevos + duplicados'],
  ['company_integrations', 'ci_token_con_sobre', 'Un secreto cifrado dice con qué se lo envolvió'],
  ['analysis_thresholds', 'analysis_thresholds_caida_ventas_pct_check', 'Un umbral de caída es un porcentaje válido'],
  ['analysis_thresholds', 'analysis_thresholds_rechazo_cheques_pct_check', 'El umbral de rechazos es un porcentaje válido'],
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
  ['goods_receipts', 'goods_receipts_transicion', '0052: la máquina de estados de la recepción'],
  ['goods_receipts', 'goods_receipts_no_delete', 'Una recepción confirmada no se borra'],
  ['goods_receipt_lines', 'grl_editables', 'Lo que se confirmó que llegó no se edita'],
  ['party_allocations', 'party_allocations_valida', '0053: los cuatro candados de la imputación'],
  ['party_allocations', 'party_allocations_no_excede', '0053: no se imputa de más (diferido)'],
  // 0060 · Plan de pagos. El primero hace que las cuotas cierren contra el
  // total; el segundo, que la imputación diga qué cuota cancela en vez de
  // adivinarlo consumiendo de la más vieja a la más nueva.
  ['tax_transaction_installments', 'tti_plan_cierra', '0060: las cuotas suman el total (diferido)'],
  ['tax_transactions', 'tt_plan_cierra', '0060: cambiar el total no deja el plan sin cerrar'],
  ['party_allocations', 'pa_nombra_cuota', '0060: con plan, la imputación declara la cuota'],
  // 0061 · Un tercero con dos listas el mismo día deja al sistema sin criterio,
  // y elegir por orden de carga sería azar disfrazado.
  ['party_price_lists', 'ppl_una_por_fecha', '0061: una sola lista por tercero y por fecha'],
  // 0064 · La máquina de estados del cheque vive en la base: depositar uno ya
  // acreditado tiene que ser imposible por cualquier camino, no solo por la API.
  ['check_movements', 'cm_transicion', '0064: solo las transiciones que existen'],
  // 0067 · El lote es obligatorio si el producto lo lleva, y prohibido si no.
  // Una existencia sin lote sobre un producto trazable no se puede rastrear.
  ['stock_movements', 'sm_lote_declarado', '0067: el lote se declara si el producto lo lleva'],
  ['stock_count_lines', 'scl_editable', '0067: un recuento cerrado no se edita'],
  ['check_movements', 'cm_no_update', 'El libro de cheques no se edita'],
  ['check_movements', 'cm_no_delete', 'El libro de cheques no se borra'],
  // 0068 · La caja también es un libro. Y una sesión ya arqueada no admite un
  // movimiento nuevo: cambiaría el teórico contra el que se contó.
  ['cash_movements', 'cmv_no_update', 'El libro de caja no se edita'],
  ['cash_movements', 'cmv_no_delete', 'El libro de caja no se borra'],
  ['cash_movements', 'cmv_sesion_abierta', '0068: no se le agrega un movimiento a una caja ya arqueada'],
  // 0069 · El embudo solo sirve si es comparable: una oportunidad se pierde con
  // motivo y no se borra, el libro de etapas no se edita, y lo cerrado no se
  // reabre.
  ['crm_opportunities', 'crm_opportunities_no_delete', '0069: una oportunidad se pierde, no se borra'],
  ['crm_stage_transitions', 'cstr_no_update', '0069: el libro de etapas no se edita'],
  ['crm_stage_transitions', 'cstr_no_delete', '0069: el libro de etapas no se borra'],
  ['crm_stage_transitions', 'cstr_transicion', '0069: perder exige motivo, y lo cerrado no se reabre'],
  ['crm_activities', 'cac_no_update', '0069: lo que se hizo, se hizo'],
  ['crm_activities', 'cac_no_delete', '0069: una visita borrada deja un seguimiento que parece mejor de lo que fue'],
  // 0070 · Una hora cargada y después borrada deja un proyecto que parece más
  // rentable de lo que fue; y un proyecto cerrado no recibe horas nuevas.
  ['time_entries', 'te_no_update', '0070: el parte de horas no se edita'],
  ['time_entries', 'te_no_delete', '0070: el parte de horas no se borra'],
  ['time_entries', 'te_proyecto_abierto', '0070: no se le cargan horas a un proyecto cerrado'],
  ['projects', 'projects_no_delete', '0070: un proyecto se cierra o se cancela, no se borra'],
  ['project_hour_rates', 'phr_una_por_fecha', '0070: una sola tarifa vigente por proyecto y fecha'],
  // 0071 · Con dos esquemas vigentes, la comisión se calcularía por orden de
  // carga: azar disfrazado de regla. Y un vendedor con ventas no se borra.
  ['commission_schemes', 'cms_uno_por_fecha', '0071: un solo esquema vigente por vendedor y fecha'],
  ['salespeople', 'salespeople_no_delete', '0071: un vendedor se inactiva; borrarlo deja sus ventas sin dueño'],
  // 0072 · Con dos sucursales sobre el mismo punto de venta, el comprobante se
  // contaría dos veces y el total de la empresa dejaría de cerrar.
  ['branch_points_of_sale', 'bpv_uno_por_fecha', '0072: un punto de venta es de una sola sucursal por vez'],
  ['branches', 'branches_no_delete', '0072: una sucursal se cierra; borrarla deja sus ventas sin origen'],
  // 0073 · Con dos planes vigentes, el tope aplicable saldría por orden de
  // carga: azar disfrazado de regla.
  ['company_subscriptions', 'csu_una_por_fecha', '0073: un plan vigente por empresa y por fecha'],
  // 0074 · Una cuenta del tipo equivocado descuadra el balance en silencio, y
  // el error aparece un ejercicio después.
  ['company_account_map', 'cam_cuenta_del_rol', '0074: la cuenta declarada sirve para el rol y es imputable'],
  // 0077 · Con dos métodos vigentes el mismo producto tendría dos costos.
  ['company_stock_valuation', 'csv_uno_por_fecha', '0077: un método de valuación vigente por vez'],
  ['party_allocations', 'party_allocations_no_delete', 'Una imputación se anula, no se borra'],
  ['stock_movements', 'stock_movements_inmutable', '0054: el libro de stock solo crece'],
  ['stock_movements', 'stock_movements_no_delete', 'Un movimiento de stock no se borra'],
  ['stock_movements', 'stock_movements_producto_valido', 'Un servicio no mueve existencias'],
  ['goods_receipts', 'goods_receipts_proyecta_stock', 'A-7 en stock: la entrada la escribe la base'],
  ['goods_receipts', 'goods_receipts_revierte_stock', 'Anular escribe el contrario, no borra'],
  ['fixed_assets', 'fixed_assets_cuentas_validas', '0055: las tres cuentas del bien sirven para lo que se usan'],
  ['fixed_assets', 'fixed_assets_no_delete', 'Un bien de uso no se borra'],
  ['fixed_asset_depreciations', 'fixed_asset_depreciations_no_delete', 'Una amortización asentada no se borra'],
  ['external_records', 'external_records_payload_inmutable', '0056: lo que dijo el proveedor es evidencia'],
  ['external_records', 'external_records_no_delete', 'Un registro externo se descarta, no se borra'],
  ['company_integrations', 'company_integrations_proveedor_disponible', 'Lo planificado no se conecta'],
  ['company_integrations', 'company_integrations_no_delete', 'Una integración se desconecta, no se borra'],
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
  ['pa_una_por_par', 'Un movimiento no se imputa dos veces al mismo comprobante'],
  ['warehouses_code_unico', 'Un código, un depósito, por empresa'],
  // 0068 · Con dos sesiones abiertas en la misma caja, un movimiento no sabría
  // a cuál pertenece y el arqueo dejaría de significar algo.
  ['cs_una_abierta_por_caja', 'Una sola sesión abierta por caja'],
  ['cst_code_unico', '0069: un código, una etapa del embudo, por empresa'],
  ['cst_orden_unico', '0069: dos etapas en la misma posición dejan el embudo sin orden'],
  ['pj_code_unico', '0070: un código, un proyecto, por empresa'],
  ['pjt_code_unico', '0070: un código, una tarea, por proyecto'],
  ['sp_code_unico', '0071: un código, un vendedor, por empresa'],
  ['br_code_unico', '0072: un código, una sucursal, por empresa'],
  ['br_un_deposito_por_sucursal', '0072: un depósito es de una sola sucursal'],
  ['fixed_assets_code_unico', 'Un código, un bien de uso, por empresa'],
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
  ['goods_receipts', 'gr_party_fk', 'No se recibe del proveedor de otra empresa'],
  ['price_list_items', 'pli_lista_fk', 'Un precio no cuelga de la lista de otra empresa'],
  ['price_list_items', 'pli_producto_fk', 'Un precio no cita el producto de otra empresa'],
  ['party_price_lists', 'ppl_lista_fk', 'No se asigna la lista de otra empresa'],
  ['checks', 'ck_cuenta_fk', 'Un cheque no sale de la cuenta bancaria de otra empresa'],
  ['checks', 'ck_asiento_fk', 'Un cheque no cita el asiento de otra empresa'],
  ['check_movements', 'cm_cheque_fk', 'Un movimiento no cuelga del cheque de otra empresa'],
  ['cash_boxes', 'cb_cuenta_fk', 'Una caja no apunta a la cuenta contable de otra empresa'],
  ['cash_sessions', 'cs_caja_fk', 'No se abre la caja de otra empresa'],
  ['cash_sessions', 'cs_asiento_fk', 'Una sesión no cita el asiento de otra empresa'],
  ['cash_movements', 'cmv_sesion_fk', 'Un movimiento no cuelga de la sesión de otra empresa'],
  ['cash_movements', 'cmv_party_fk', 'Un movimiento de caja no nombra al tercero de otra empresa'],
  ['crm_opportunities', 'co_party_fk', 'Una oportunidad no es del tercero de otra empresa'],
  ['crm_opportunities', 'co_documento_fk', 'Una oportunidad no cita el presupuesto de otra empresa'],
  ['crm_stage_transitions', 'cstr_oportunidad_fk', 'Una transición no cuelga de la oportunidad de otra empresa'],
  ['crm_stage_transitions', 'cstr_etapa_fk', 'No se mueve a la etapa de otra empresa'],
  ['crm_activities', 'cac_oportunidad_fk', 'Una actividad no cuelga de la oportunidad de otra empresa'],
  ['projects', 'pj_party_fk', 'Un proyecto no es del cliente de otra empresa'],
  ['projects', 'pj_centro_fk', 'Un proyecto no se mide por el centro de costo de otra empresa'],
  ['project_tasks', 'pjt_proyecto_fk', 'Una tarea no cuelga del proyecto de otra empresa'],
  ['time_entries', 'te_proyecto_fk', 'Las horas no se cargan al proyecto de otra empresa'],
  ['time_entries', 'te_tarea_fk', 'Las horas no citan la tarea de otra empresa'],
  ['project_hour_rates', 'phr_proyecto_fk', 'Una tarifa no rige para el proyecto de otra empresa'],
  ['salespeople', 'sp_party_fk', 'Un vendedor externo no es el tercero de otra empresa'],
  ['tax_transactions', 'tt_vendedor_fk', 'Una venta no se le atribuye al vendedor de otra empresa'],
  ['commission_schemes', 'cms_vendedor_fk', 'Un esquema no rige para el vendedor de otra empresa'],
  ['branches', 'br_deposito_fk', 'Una sucursal no usa el depósito de otra empresa'],
  ['branches', 'br_centro_fk', 'Una sucursal no imputa al centro de costo de otra empresa'],
  ['branch_points_of_sale', 'bpv_sucursal_fk', 'Un punto de venta no cuelga de la sucursal de otra empresa'],
  ['company_account_map', 'cam_cuenta_fk', 'El mapeo no declara la cuenta de otra empresa'],
  ['tax_transaction_installments', 'tti_comprobante_fk', 'Una cuota no cuelga del comprobante de otra empresa'],
  ['party_allocations', 'pa_cuota_fk', 'Una imputación no nombra la cuota de otra empresa'],
  ['goods_receipts', 'gr_orden_fk', 'La orden que origina la recepción es de la misma empresa'],
  ['goods_receipt_lines', 'grl_recepcion_fk', 'Un renglón no cuelga de la recepción de otra empresa'],
  ['party_allocations', 'pa_comprobante_fk', 'No se imputa al comprobante de otra empresa'],
  ['party_allocations', 'pa_linea_fk', 'No se imputa con el movimiento de otra empresa'],
  ['stock_movements', 'sm_producto_fk', 'No se mueve el producto de otra empresa'],
  ['stock_movements', 'sm_deposito_fk', 'No se mueve al depósito de otra empresa'],
  ['goods_receipts', 'gr_warehouse_fk', 'La recepción entra a un depósito de la misma empresa'],
  ['fixed_assets', 'fa_cuenta_fk', 'El bien no apunta a la cuenta de otra empresa'],
  ['fixed_asset_depreciations', 'fad_asiento_fk', 'La amortización no cita el asiento de otra empresa'],
  ['fixed_asset_improvements', 'fai_bien_fk', 'Una mejora no cuelga del bien de otra empresa'],
  ['external_records', 'er_integracion_fk', 'Un registro no cuelga de la integración de otra empresa'],
  ['external_records', 'er_party_fk', 'No se resuelve contra el tercero de otra empresa'],
  ['integration_sync_runs', 'isr_integracion_fk', 'Una corrida es de la integración de su empresa'],
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
  // Recepción de mercadería (0052): qué llegó y cuándo.
  'goods_receipts', 'goods_receipt_lines',
  // Imputaciones (0053): qué factura cancela cada cobro.
  'party_allocations',
  // Stock (0054): existencias y depósitos de la empresa.
  'warehouses', 'stock_movements',
  // Bienes de uso (0055): costos, vidas útiles y valor de libros.
  'fixed_assets', 'fixed_asset_improvements', 'fixed_asset_depreciations',
  // Integration Hub (0056): qué trajo cada plataforma externa.
  'company_integrations', 'integration_sync_runs', 'external_records',
  // Umbrales declarados (0058): qué considera un desvío cada empresa.
  'analysis_thresholds',
  // Plan de pagos (0060): sin RLS, las cuotas de una empresa se verían en otra.
  'tax_transaction_installments',
  // Listas de precios (0061): sin RLS, la lista mayorista de una empresa se
  // vería desde otra.
  'price_lists', 'price_list_items', 'party_price_lists',
  // Cheques (0064): la cartera es plata, y sin RLS sería plata compartida.
  'checks', 'check_movements',
  // Recuento físico (0067): sin RLS, el recuento de una empresa se vería en otra.
  'stock_counts', 'stock_count_lines',
  // Caja (0068): efectivo. Sin RLS, el arqueo de una empresa se leería en otra.
  'cash_boxes', 'cash_sessions', 'cash_movements',
  // CRM (0069): a quién le está por vender cada empresa. Sin RLS, la cartera
  // de prospectos de un estudio se leería desde la empresa de al lado.
  'crm_stages', 'crm_opportunities', 'crm_stage_transitions', 'crm_activities',
  // Proyectos (0070): horas y rentabilidad por trabajo. Sin RLS, el margen de
  // una empresa se leería desde otra.
  'projects', 'project_tasks', 'time_entries', 'project_hour_rates',
  // Comisiones (0071): cuánto gana cada vendedor. Sin RLS se leería desde la
  // empresa de al lado.
  'salespeople', 'commission_schemes',
  // Sucursales (0072): dónde factura cada empresa. Sin RLS, el mapa de bocas de
  // una se leería desde otra.
  'branches', 'branch_points_of_sale',
  // Suscripciones (0073): qué plan tiene cada empresa. Sin RLS, una vería el
  // plan y el uso de otra.
  'company_subscriptions',
  // Mapeo contable (0074): a qué cuenta va cada cosa. Sin RLS, una empresa
  // armaría sus asientos con el plan de otra.
  'company_account_map',
  // Valuación (0077): el método declarado por cada empresa. Sin RLS, una vería
  // con qué criterio valúa otra.
  'company_stock_valuation',
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
  'work_queue', 'work_queue_nucleo', 'work_queue_comercial', 'work_queue_compras',
  'work_queue_cobranzas', 'work_queue_stock', 'work_queue_activos',
  'work_queue_integraciones', 'work_queue_senales', 'work_queue_precios',
  'work_queue_cheques',
  // El estado del cheque se deriva del último movimiento: sin security_invoker,
  // la cartera de una empresa se vería desde otra.
  'check_status', 'checks_en_cartera',
  // 0065 · La capa de decisión (ADR-018): el flujo consolidado y la base de
  // señales, que quedó detrás de la vista envolvente al agregar los cheques.
  'analytics_flujo_de_fondos', 'analysis_signals_base',
  // Lotes y recuento (0067). La existencia por lote y la diferencia contra el
  // libro son derivadas: sin security_invoker cruzarían empresas.
  'stock_by_lot', 'stock_count_differences', 'work_queue_lotes',
  // Caja y arqueo (0068). El saldo teórico y lo disponible son derivados: sin
  // security_invoker, el efectivo de una empresa se sumaría al de otra.
  'cash_session_status', 'analytics_disponible', 'work_queue_caja',
  // CRM (0069). La etapa actual y el embudo son derivados: sin security_invoker
  // el embudo de una empresa sumaría las oportunidades de otra.
  'crm_opportunity_status', 'analytics_embudo', 'work_queue_crm',
  // Proyectos (0070). Las horas valuadas y la rentabilidad son derivadas, y la
  // segunda lee el Mayor: sin security_invoker mezclaría empresas.
  'project_time_valuation', 'project_status', 'analytics_proyectos',
  'work_queue_proyectos',
  // Comisiones (0071). Lo devengado es derivado y cruza el comprobante con la
  // imputación: sin security_invoker mostraría las ventas de otra empresa.
  'commission_accruals', 'analytics_comisiones', 'work_queue_comisiones',
  // Sucursales (0072). La atribución de ventas y el desempeño por boca son
  // derivados y leen el Mayor: sin security_invoker cruzarían empresas.
  'branch_sales', 'branch_status', 'analytics_sucursales', 'work_queue_sucursales',
  // Suscripciones (0073). El uso se cuenta en el momento sobre tablas con RLS:
  // sin security_invoker contaría los comprobantes de todas las empresas.
  'subscription_usage', 'subscription_status', 'work_queue_suscripcion',
  // Mapeo contable (0074). Qué falta declarar se deriva: no hay columna
  // «completo» que pueda quedar desactualizada.
  'accounting_map_status', 'work_queue_mapeo',
  // Puesta en marcha (0075). Cuenta filas de doce tablas con RLS: sin
  // security_invoker le contaría a una empresa lo que tiene otra.
  'company_readiness', 'work_queue_arranque',
  // Valuación (0077). El promedio se recorre movimiento por movimiento sobre
  // tablas con RLS: sin security_invoker valuaría con el stock de otra empresa.
  'stock_movements_ordenados', 'stock_ppp', 'stock_valuation',
  'analytics_costo_de_ventas', 'work_queue_valuacion',
  // 0079 · El costo del mes en una sola cifra, con las dos razones por las que
  // puede no ser afirmable.
  'cogs_por_mes',
  // La conciliación de tres puntas (0052): cantidades y proveedores de la empresa.
  'purchase_match',
  // Composición y antigüedad de saldos (0053): la cartera de la empresa.
  'invoice_settlement', 'party_aging',
  // Existencias derivadas (0054).
  'stock_on_hand', 'stock_by_product',
  // Plan de amortización y valor de libros (0055).
  'asset_depreciation_schedule', 'asset_book_value',
  // Salud de las integraciones (0056).
  'integration_health',
  // Analítica (0057). Seis vistas, ni una cifra almacenada: sin
  // `security_invoker` un tablero mostraría las ventas de todas las empresas.
  'analytics_operaciones_mensuales', 'analytics_por_producto', 'analytics_por_tercero',
  'analytics_cobertura_de_detalle', 'analytics_flujo_bancario', 'analytics_resumen',
  // Señales deterministas (0058). Sin `security_invoker` un desvío de una
  // empresa aparecería en la bandeja de otra.
  'analysis_signals',
  // El pendiente por cuota se deriva acá y en ningún otro lado (0060).
  'installment_settlement',
  'price_list_coverage',
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

  // El verificador de la bitácora no puede devolver una columna llamada `found`.
  //
  // `FOUND` es una variable booleana que PL/pgSQL define en toda función, y le
  // gana al parámetro de salida homónimo: la asignación intenta meter un
  // SHA-256 en un booleano y la función revienta **justo cuando encuentra una
  // adulteración**. Estuvo así desde la 0008, sobrevivió a la 0025 y a un test
  // de integración —que solo ejercitaba la cadena sana— y lo encontró
  // `audit:cadena` la primera vez que alguien recorrió la rama roja (0059).
  //
  // Se declara acá porque es un candado sobre la forma, no sobre el
  // comportamiento: el test prueba que detecta, esto impide que el nombre vuelva.
  const retorno = await client.query(
    `SELECT pg_get_function_result(oid) AS r FROM pg_proc WHERE proname = 'verify_audit_chain'`,
  );
  anotar(
    'FUNCIÓN',
    'verify_audit_chain(uuid)',
    'No devuelve `found`: colisiona con la variable de PL/pgSQL y rompe al detectar',
    retorno.rows.length > 0 && !/\bfound\b/i.test(retorno.rows[0].r),
  );

  // El depósito por defecto tiene que ser de la propia empresa, y no entra en el
  // grupo de arriba por un motivo real: ese grupo exige que la primera columna
  // de la clave se llame `company_id`, y en `companies` la empresa **es** el
  // `id`. Aflojar la regla general para que entre este caso dejaría pasar
  // justo el hueco que la regla existe para cerrar, así que va con su propio
  // candado, más preciso: se comprueban las columnas exactas.
  const depositoPropio = await client.query(
    // Se arma la lista como **texto** y no como array: `pg` devuelve un
    // `text[]` de PostgreSQL como string cuando no tiene el parser del tipo
    // registrado, y comparar contra algo que a veces es array y a veces string
    // es cómo un candado empieza a dar falsos verdes.
    `SELECT string_agg(a.attname, ',' ORDER BY k.ord) AS columnas
       FROM pg_constraint c
       CROSS JOIN LATERAL unnest(c.conkey) WITH ORDINALITY AS k(attnum, ord)
       JOIN pg_attribute a ON a.attrelid = c.conrelid AND a.attnum = k.attnum
      WHERE c.conname = 'companies_deposito_propio' AND c.contype = 'f'
      GROUP BY c.oid`,
  );
  anotar(
    'FK + EMPRESA',
    'companies.companies_deposito_propio',
    'Lleva (id, default_warehouse_id): el depósito declarado es de la propia empresa',
    depositoPropio.rows.length > 0 &&
      depositoPropio.rows[0].columnas === 'id,default_warehouse_id',
  );

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
