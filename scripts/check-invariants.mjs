#!/usr/bin/env node
/**
 * Los ocho invariantes de AUDIT_TRAIL.md, como puerta de CI.
 *
 *   npm run audit:invariants
 *
 * El criterio de la FASE 12 es que **corran en CI y fallen el build al
 * violarse**. No que existan documentados, ni que haya un tablero donde
 * mirarlos: que rompan la compilación.
 *
 * La diferencia importa. Un invariante que se informa en un reporte es algo que
 * alguien tiene que ir a mirar, y la primera semana lo mira. Un invariante que
 * corta el pipeline es algo que hay que resolver para poder seguir.
 *
 * Cada consulta devuelve **las filas que violan** el invariante, no un conteo.
 * Un "3 violaciones de A-1" obliga a escribir la consulta de nuevo para saber
 * cuáles; devolver los ids es la diferencia entre un hallazgo y un aviso.
 *
 * Sin DATABASE_URL no falla: avisa y sale con 0, igual que `ledger:verify`.
 */

import { existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import pg from 'pg';

const HERE = dirname(fileURLToPath(import.meta.url));
if (existsSync(join(HERE, '..', '.env'))) {
  process.loadEnvFile(join(HERE, '..', '.env'));
}

const DATABASE_URL = process.env.DATABASE_URL ?? '';
if (DATABASE_URL === '') {
  console.log('audit:invariants — sin DATABASE_URL. Nada que verificar.');
  process.exit(0);
}

/**
 * Los ocho.
 *
 * `sql` devuelve una fila por violación. Vacío = el invariante se cumple.
 *
 * Varios son **vacuos hoy**: sin plantillas cargadas no hay renglones de estado,
 * así que A-1 y A-2 no tienen sobre qué fallar. Eso se informa como tal —
 * `vacuo: true`— en vez de reportarse como verde. Un invariante que pasa porque
 * no hay datos no es lo mismo que uno que pasa porque los datos están bien, y
 * confundirlos es cómo un tablero en verde acompaña una base rota.
 */
const INVARIANTES = [
  {
    id: 'A-1',
    enunciado: 'Todo renglón de estado contable resuelve a ≥ 1 asiento aprobado',
    universo: 'SELECT count(*)::int AS n FROM financial_statement_lines',
    sql: `
      SELECT l.id::text AS violacion,
             format('renglón %s del estado %s', l.line_code, l.statement_id) AS detalle
        FROM financial_statement_lines l
       WHERE l.line_type = 'RENGLON'
         AND l.amount <> 0
         AND NOT EXISTS (
           SELECT 1
             FROM jsonb_array_elements(l.lineage) AS origen(value)
             JOIN journal_entry_lines jel ON jel.account_id = (origen.value ->> 'accountId')::uuid
             JOIN journal_entries e ON e.id = jel.entry_id
            WHERE e.status IN ('APROBADO', 'ANULADO')
         )`,
  },
  {
    id: 'A-2',
    enunciado: 'Toda cifra de nota resuelve a ≥ 1 asiento aprobado',
    universo: 'SELECT count(*)::int AS n FROM note_figures',
    sql: `
      SELECT f.id::text AS violacion,
             format('cifra "%s" de la nota %s', f.label, n.numero) AS detalle
        FROM note_figures f
        JOIN notes n ON n.id = f.note_id
       WHERE f.amount <> 0
         AND NOT EXISTS (
           SELECT 1
             FROM jsonb_array_elements(f.lineage) AS origen(value)
             JOIN journal_entry_lines jel ON jel.account_id = (origen.value ->> 'accountId')::uuid
             JOIN journal_entries e ON e.id = jel.entry_id
            WHERE e.status IN ('APROBADO', 'ANULADO')
         )`,
  },
  {
    id: 'A-3',
    enunciado: 'Todo asiento aprobado tiene comprobante, justificación firmada o decisión contable',
    universo: "SELECT count(*)::int AS n FROM journal_entries WHERE status = 'APROBADO'",
    // Las tres vías, las mismas de `E_NO_TRACEABILITY` en el motor y de
    // `je_trazabilidad_obligatoria` en la base (0037).
    //
    // Esta consulta conocía dos, y por eso denunciaba como sin respaldo a los
    // ajustes de cierre fundados solo en una decisión. Pasó inadvertido porque
    // `audit:invariants` corre contra la base de desarrollo, que después de un
    // `db:reset` está vacía: el invariante daba VACUO y `verify` lo tomaba por
    // bueno. Es el cuarto lugar donde vivía la misma disyunción de dos.
    sql: `
      SELECT e.id::text AS violacion,
             format('%s #%s del %s', e.journal_code, e.entry_number, e.entry_date) AS detalle
        FROM journal_entries e
       WHERE e.status = 'APROBADO'
         AND e.source_id IS NULL
         AND e.decision_id IS NULL
         AND coalesce(btrim(e.manual_justification), '') = ''`,
  },
  {
    id: 'A-4',
    enunciado: 'Toda aplicación de regla apunta a una norma con documento y hash',
    universo: 'SELECT count(*)::int AS n FROM rule_applications',
    sql: `
      -- La norma no está en rule_applications sino en la regla que se aplicó:
      -- accounting_rules.norm_version_id. Y no alcanza con que la versión
      -- exista: tiene que haber un documento archivado con hash, porque una cita
      -- que no se puede abrir no es una cita.
      SELECT ra.id::text AS violacion,
             format('aplicación de la regla %s v%s', ra.rule_id, ra.rule_version) AS detalle
        FROM rule_applications ra
       WHERE NOT EXISTS (
         SELECT 1
           FROM accounting_rules r
           JOIN norm_versions v ON v.id = r.norm_version_id
           JOIN norm_documents d ON d.norm_version_id = v.id
          WHERE r.id = ra.rule_id
            AND d.sha256 IS NOT NULL
       )`,
  },
  {
    id: 'A-5',
    enunciado: 'La cadena de audit_logs es continua para cada empresa',
    universo: 'SELECT count(*)::int AS n FROM audit_logs',
    // Cada entrada encadena con el hash de la anterior de la misma empresa. Una
    // ruptura significa que alguien insertó, borró o reordenó — que es lo que la
    // cadena existe para hacer imposible de esconder.
    sql: `
      -- Por seq: es el orden en que las entradas ENTRARON. Ordenar por
      -- occurred_at bifurcaba la cadena bajo concurrencia (ver migración 0025).
      WITH encadenado AS (
        SELECT id, company_id, prev_hash,
               lag(hash) OVER (PARTITION BY company_id ORDER BY seq) AS esperado
          FROM audit_logs
      )
      SELECT id::text AS violacion,
             format('entrada %s de la empresa %s rompe la cadena', id, company_id) AS detalle
        FROM encadenado
       WHERE esperado IS NOT NULL AND prev_hash IS DISTINCT FROM esperado`,
  },
  {
    id: 'A-6',
    enunciado: 'Ningún asiento creado por IA existe sin aprobación humana',
    universo: 'SELECT count(*)::int AS n FROM journal_entries WHERE ai_prediction_id IS NOT NULL',
    // La verificación mecánica de la promesa central del producto (ADR-001).
    // Si esta falla alguna vez, el sistema dejó de ser lo que dice ser.
    sql: `
      SELECT e.id::text AS violacion,
             format('%s #%s tiene predicción de IA y no tiene aprobador', e.journal_code, e.entry_number) AS detalle
        FROM journal_entries e
       WHERE e.ai_prediction_id IS NOT NULL
         AND e.status NOT IN ('BORRADOR', 'PROPUESTO')
         AND e.approved_by IS NULL`,
  },
  {
    id: 'A-7',
    enunciado: 'El Mayor coincide con el Diario',
    universo: 'SELECT count(*)::int AS n FROM ledger_movements',
    // Es el mismo control que `npm run ledger:verify`, expresado como
    // invariante. Corre acá también para que el criterio de la FASE 12 —los ocho
    // en una sola puerta— sea literal.
    sql: `
      SELECT l.id::text AS violacion, 'línea sin movimiento en el Mayor' AS detalle
        FROM journal_entry_lines l
        JOIN journal_entries e ON e.id = l.entry_id
       WHERE e.status IN ('APROBADO', 'ANULADO')
         AND NOT EXISTS (SELECT 1 FROM ledger_movements m WHERE m.entry_line_id = l.id)
      UNION ALL
      SELECT m.id::text, 'movimiento del Mayor que el Diario no explica'
        FROM ledger_movements m
        JOIN journal_entry_lines l ON l.id = m.entry_line_id
        JOIN journal_entries e ON e.id = l.entry_id
       WHERE m.debit <> l.debit OR m.credit <> l.credit
          OR m.account_id <> l.account_id OR m.movement_date <> e.entry_date`,
  },
  {
    id: 'A-8',
    enunciado: 'Ninguna regla contable ACTIVE carece de aprobador',
    universo: "SELECT count(*)::int AS n FROM accounting_rules WHERE status = 'ACTIVE'",
    sql: `
      SELECT r.id::text AS violacion, format('regla %s', r.rule_key) AS detalle
        FROM accounting_rules r
       WHERE r.status = 'ACTIVE' AND r.approved_by IS NULL`,
  },
  {
    id: 'A-9',
    enunciado: 'Toda aplicación de regla congeló el hash del documento que citó',
    universo: 'SELECT count(*)::int AS n FROM rule_applications',
    // A-4 comprueba que la derivación `regla → norma → documento` exista HOY.
    // Esto es distinto: que la aplicación haya guardado el hash del día en que
    // se aplicó. Sin eso, un documento vuelto a archivar cambiaría en silencio
    // el texto que un asiento viejo dice haber usado para decidirse.
    //
    // Deliberadamente NO se compara contra el hash actual: que difieran es
    // legítimo —el documento se rearchivó— y es justamente lo que congelar
    // permite ver.
    sql: `
      SELECT ra.id::text AS violacion,
             format('aplicación de la regla %s v%s sin hash congelado', ra.rule_id, ra.rule_version) AS detalle
        FROM rule_applications ra
       WHERE coalesce(btrim(ra.norm_document_sha256), '') = ''`,
  },
  {
    id: 'A-10',
    enunciado: 'Ningún asiento aprobado se funda en una decisión de ambiente PRUEBA',
    universo: "SELECT count(*)::int AS n FROM journal_entries WHERE decision_id IS NOT NULL",
    sql: `
      SELECT e.id::text AS violacion,
             format('%s #%s', e.journal_code, e.entry_number) AS detalle
        FROM journal_entries e
        JOIN accounting_decisions d ON d.id = e.decision_id
       WHERE d.ambiente = 'PRUEBA'`,
  },
  // -------------------------------------------------------------------------
  // Cierre de ejercicio
  // -------------------------------------------------------------------------
  // Los índices únicos de la 0038 impiden que estas situaciones se creen. Estos
  // invariantes existen igual, y no son redundantes: un índice protege de acá en
  // adelante, y esto verifica que lo que YA está en la base cumple. Es la
  // diferencia entre «no puede pasar» y «no pasó», y una migración de datos
  // futura puede romper la segunda sin tocar la primera.
  {
    id: 'A-11',
    enunciado: 'Todo ejercicio CERRADO tiene su cierre completado, y viceversa',
    universo: "SELECT count(*)::int AS n FROM fiscal_years WHERE status = 'CERRADO'",
    sql: `
      SELECT fy.id::text AS violacion,
             format('ejercicio %s está CERRADO sin cierre COMPLETADO', fy.code) AS detalle
        FROM fiscal_years fy
       WHERE fy.status = 'CERRADO'
         AND NOT EXISTS (
           SELECT 1 FROM accounting_closures c
            WHERE c.fiscal_year_id = fy.id AND c.status = 'COMPLETADO')
      UNION ALL
      SELECT c.id::text,
             format('cierre COMPLETADO del ejercicio %s, que está %s', fy.code, fy.status)
        FROM accounting_closures c
        JOIN fiscal_years fy ON fy.id = c.fiscal_year_id
       WHERE c.status = 'COMPLETADO' AND fy.status <> 'CERRADO'`,
  },
  {
    id: 'A-12',
    enunciado: 'Los asientos de cierre pertenecen al ejercicio que su expediente dice cerrar',
    universo: "SELECT count(*)::int AS n FROM accounting_closures WHERE status = 'COMPLETADO'",
    // Un asiento de cierre imputado a otro ejercicio es trazabilidad falsa: el
    // recorrido se ve completo y señala el ejercicio equivocado.
    sql: `
      SELECT e.id::text AS violacion,
             format('%s #%s es del ejercicio %s y cierra el %s',
                    e.journal_code, e.entry_number, suyo.code, dice.code) AS detalle
        FROM accounting_closures c
        JOIN journal_entries e ON e.id IN (c.refundicion_entry_id, c.cierre_entry_id)
        JOIN fiscal_years suyo ON suyo.id = e.fiscal_year_id
        JOIN fiscal_years dice ON dice.id = c.fiscal_year_id
       WHERE e.fiscal_year_id <> c.fiscal_year_id OR e.company_id <> c.company_id`,
  },
  {
    id: 'A-13',
    enunciado: 'Toda apertura deriva de un cierre completado del ejercicio anterior',
    universo: "SELECT count(*)::int AS n FROM journal_entries WHERE kind = 'APERTURA'",
    // Una apertura huérfana es un patrimonio que aparece sin venir de ningún
    // lado. Cuadra —el asiento está balanceado— y no se puede explicar.
    sql: `
      SELECT e.id::text AS violacion,
             format('apertura %s #%s sin cierre que la origine', e.journal_code, e.entry_number) AS detalle
        FROM journal_entries e
       WHERE e.kind = 'APERTURA'
         AND e.status IN ('PROPUESTO', 'APROBADO')
         AND NOT EXISTS (
           SELECT 1 FROM accounting_closures c
            WHERE c.apertura_entry_id = e.id AND c.status = 'COMPLETADO')`,
  },
  {
    id: 'A-14',
    enunciado: 'Ningún ejercicio cerrado tiene asientos que no sean de su propio cierre',
    universo: "SELECT count(*)::int AS n FROM fiscal_years WHERE status = 'CERRADO'",
    // El trigger `je_fiscal_year_guard` lo impide desde la 0038. Esto verifica
    // que nada anterior a la migración —ni ninguna carga posterior con el
    // trigger deshabilitado— haya dejado un asiento entrando después del cierre.
    sql: `
      SELECT e.id::text AS violacion,
             format('%s #%s (%s) creado el %s en el ejercicio cerrado %s',
                    e.journal_code, e.entry_number, e.kind, e.created_at::date, fy.code) AS detalle
        FROM journal_entries e
        JOIN fiscal_years fy ON fy.id = e.fiscal_year_id
        JOIN accounting_closures c ON c.fiscal_year_id = fy.id AND c.status = 'COMPLETADO'
       WHERE fy.status = 'CERRADO'
         AND e.created_at > c.closed_at
         AND e.id IS DISTINCT FROM c.refundicion_entry_id
         AND e.id IS DISTINCT FROM c.cierre_entry_id`,
  },
];

const MAX_EJEMPLOS = 5;

const client = new pg.Client({ connectionString: DATABASE_URL });
await client.connect();

let violados = 0;
let vacuos = 0;

try {
  for (const invariante of INVARIANTES) {
    const universo = await client.query(invariante.universo);
    const filas = Number(universo.rows[0]?.n ?? 0);
    const resultado = await client.query(invariante.sql);

    if (resultado.rows.length > 0) {
      violados += 1;
      console.error(`  ✘ ${invariante.id} — ${invariante.enunciado}`);
      console.error(`      ${resultado.rows.length} violación(es):`);
      for (const fila of resultado.rows.slice(0, MAX_EJEMPLOS)) {
        console.error(`        · ${fila.detalle}`);
      }
      if (resultado.rows.length > MAX_EJEMPLOS) {
        console.error(`        … y ${resultado.rows.length - MAX_EJEMPLOS} más`);
      }
      continue;
    }

    if (filas === 0) {
      vacuos += 1;
      console.log(`  ○ ${invariante.id} — ${invariante.enunciado}`);
      console.log('      VACUO: no hay filas sobre las que pueda fallar.');
      continue;
    }

    console.log(`  ✔ ${invariante.id} — ${invariante.enunciado} (${filas} filas)`);
  }

  console.log('');

  if (violados > 0) {
    console.error(`audit:invariants — ${violados} de ${INVARIANTES.length} invariantes VIOLADOS.`);
    console.error('');
    console.error('Estos no son avisos. Cada uno es una propiedad que el sistema promete y que');
    console.error('en este momento no se cumple: una cifra sin respaldo, un asiento de IA sin');
    console.error('firma, una cadena de auditoría rota. El build no sigue.');
    process.exit(1);
  }

  if (vacuos > 0) {
    console.log(
      `audit:invariants — ${INVARIANTES.length - vacuos} verificados, ${vacuos} vacuos (sin datos).`,
    );
    console.log('');
    console.log('Un invariante vacuo NO es un invariante verde: pasa porque no hay sobre qué');
    console.log('fallar. Se informa aparte a propósito — un tablero que los pinta iguales');
    console.log('acompaña una base vacía con la misma cara que una base sana.');
  } else {
    console.log(`audit:invariants — los ${INVARIANTES.length} invariantes se cumplen.`);
  }
} finally {
  await client.end();
}
