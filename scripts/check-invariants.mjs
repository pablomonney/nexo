#!/usr/bin/env node
/**
 * El gate de invariantes: qué promete el sistema y si eso se cumple.
 *
 *   npm run audit:invariants                  — modo CONDUCTUAL (el de `verify`)
 *   node scripts/check-invariants.mjs --observacional   — sobre DATABASE_URL, tal cual está
 *
 * ## El falso verde que este archivo existe para no repetir
 *
 * Hasta el 2026-08-28 este script corría contra la base de **desarrollo**. Los
 * tests de integración habían dejado de escribir ahí el 2026-08-27 —se aislaron
 * en `aai_test`, corrección necesaria y correcta—, así que el checker se quedó
 * mirando una base que después de un `db:reset` está vacía. Los catorce
 * invariantes daban VACUO, VACUO no contaba como violación, y `verify` terminaba
 * en 0.
 *
 * Nadie rompió nada: un arreglo en un lugar dejó ciego a un gate en otro, y el
 * gate siguió diciendo que sí. Por eso lo que cambia acá no es una consulta sino
 * **quién decide que un invariante pasó**.
 *
 * ## Los cuatro estados
 *
 * | Estado | Qué significa | ¿Corta el build? |
 * |---|---|---|
 * | `VERIFIED` | hay casos y ninguno viola la propiedad | no |
 * | `VIOLATED` | hay al menos un caso que la viola | **sí, siempre** |
 * | `NOT_EXERCISED` | el invariante exige ejercicio y no hubo ni un caso | **sí, en modo conductual** |
 * | `VACUO_PERMITIDO` | no hubo casos, y está declarado por qué no puede haberlos | no |
 *
 * La diferencia entre los dos últimos **no es una etiqueta**. `VACUO_PERMITIDO`
 * obliga a escribir el motivo por el que hoy es imposible ejercitarlo, y ese
 * motivo se imprime en cada corrida: es una deuda a la vista, no un permiso.
 * Todo lo demás declara `ejercicio: 'REQUERIDO'`, y entonces el fixture
 * conductual tiene que producirle casos o el gate falla.
 *
 * ## Los dos modos
 *
 * **Conductual** (el que corre `verify`): levanta una base de verificación
 * aislada, la siembra recorriendo los flujos productivos reales —altas,
 * aprobaciones, contraasientos, cierre, apertura— y recién entonces verifica.
 * Un `NOT_EXERCISED` acá significa que algo que tenía que pasar no pasó.
 *
 * **Observacional**: mira la base que se le indique, tal como está. Sirve para
 * preguntarle a una base real si cumple, y **no afirma cobertura**: sus
 * `NOT_EXERCISED` se informan y no cortan, porque que una base no tenga cierres
 * no es un defecto de la base.
 */

import { existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { resolve } from 'node:path';
import pg from 'pg';

const HERE = dirname(fileURLToPath(import.meta.url));
if (existsSync(join(HERE, '..', '.env'))) {
  process.loadEnvFile(join(HERE, '..', '.env'));
}

const INVARIANTES = [
  {
    id: 'A-1',
    enunciado: 'Todo renglón de estado contable resuelve a ≥ 1 asiento aprobado',
    // Dejó de ser VACUO_PERMITIDO el 2026-08-28, cuando la fase de Estados
    // Contables destrabó `/statements/issue`. Ahora exige ejercicio: si el
    // fixture dejara de emitir estados, el gate corta en vez de volver
    // silenciosamente a "no hay sobre qué fallar".
    ejercicio: 'REQUERIDO',
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
    // Las notas son un subsistema aparte (`notes.ts`): no las emite
    // `/statements/issue` y no hay endpoint que las produzca. Cuando lo haya,
    // esto pasa a REQUERIDO como pasó A-1.
    vacuoPermitido:
      'Las cifras de nota las produce el subsistema de notas, que no tiene endpoint de ' +
      'emisión. No hay camino productivo que las cree, así que no hay forma de ejercitarlo.',
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
    ejercicio: 'REQUERIDO',
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
    vacuoPermitido:
      'Una aplicación de regla exige que la regla esté ACTIVE (assert_rule_application_activa). ' +
      'El estado del proyecto es ACTIVE = 0 y ninguna regla se activa sin la firma de un ' +
      'aprobador (§32): activar una para que el tablero quede verde sería falsear el sistema.',
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
    ejercicio: 'REQUERIDO',
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
    ejercicio: 'REQUERIDO',
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
    ejercicio: 'REQUERIDO',
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
    vacuoPermitido:
      'Su universo son las reglas ACTIVE, y hay cero por decisión de producto. Que esté ' +
      'vacío no es una carencia del gate: es el estado declarado del sistema.',
    universo: "SELECT count(*)::int AS n FROM accounting_rules WHERE status = 'ACTIVE'",
    sql: `
      SELECT r.id::text AS violacion, format('regla %s', r.rule_key) AS detalle
        FROM accounting_rules r
       WHERE r.status = 'ACTIVE' AND r.approved_by IS NULL`,
  },
  {
    id: 'A-9',
    enunciado: 'Toda aplicación de regla congeló el hash del documento que citó',
    vacuoPermitido: 'Mismo bloqueo que A-4: no hay aplicaciones de regla sin una regla ACTIVE.',
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
    ejercicio: 'REQUERIDO',
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
    ejercicio: 'REQUERIDO',
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
    ejercicio: 'REQUERIDO',
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
    ejercicio: 'REQUERIDO',
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
    ejercicio: 'REQUERIDO',
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

export { INVARIANTES };

const MAX_EJEMPLOS = 5;

export const VERIFIED = 'VERIFIED';
export const VIOLATED = 'VIOLATED';
export const NOT_EXERCISED = 'NOT_EXERCISED';
export const VACUO_PERMITIDO = 'VACUO_PERMITIDO';

/**
 * Evalúa la lista contra una conexión abierta y devuelve el resultado
 * estructurado. No imprime, no decide el código de salida y no sabe en qué modo
 * está: eso es de quien la llama.
 *
 * Se exporta para que los tests del propio gate puedan armar datos y preguntarle
 * qué ve, en vez de leer su salida de texto. Un gate cuya única interfaz es un
 * `console.log` solo se puede probar por scraping, y entonces no se prueba.
 */
export async function evaluarInvariantes(client, lista = INVARIANTES) {
  const resultados = [];

  for (const invariante of lista) {
    const universo = await client.query(invariante.universo);
    const casos = Number(universo.rows[0]?.n ?? 0);
    const violaciones = await client.query(invariante.sql);

    // El orden importa: una violación manda aunque el universo diera cero. Si
    // las dos consultas discrepan —hay filas que violan y el universo dice que
    // no hay ninguna— el problema es el invariante, y taparlo con VACUO sería
    // esconder justamente el caso que hay que mirar.
    const estado =
      violaciones.rows.length > 0
        ? VIOLATED
        : casos > 0
          ? VERIFIED
          : invariante.vacuoPermitido !== undefined
            ? VACUO_PERMITIDO
            : NOT_EXERCISED;

    resultados.push({
      id: invariante.id,
      enunciado: invariante.enunciado,
      estado,
      casos,
      violaciones: violaciones.rows.length,
      ejemplos: violaciones.rows.slice(0, MAX_EJEMPLOS).map((fila) => fila.detalle),
      motivoVacuo: invariante.vacuoPermitido ?? null,
    });
  }

  return resultados;
}

export function resumir(resultados) {
  const por = (estado) => resultados.filter((r) => r.estado === estado);
  return {
    verificados: por(VERIFIED).length,
    violados: por(VIOLATED).length,
    noEjercitados: por(NOT_EXERCISED).length,
    vacuosPermitidos: por(VACUO_PERMITIDO).length,
    total: resultados.length,
  };
}

/**
 * Código de salida.
 *
 * Una violación corta siempre. Un `NOT_EXERCISED` corta **solo en modo
 * conductual**: ahí el fixture prometió producirle casos y no lo hizo, así que
 * la propiedad quedó sin probar y decir que pasó sería el falso verde otra vez.
 * En modo observacional no corta, porque que una base real no tenga cierres no
 * es un defecto de la base — pero se informa igual, y el resumen dice
 * explícitamente que esa corrida no afirma cobertura.
 */
export function codigoDeSalida(resumen, { conductual }) {
  if (resumen.violados > 0) return 1;
  if (conductual && resumen.noEjercitados > 0) return 1;
  return 0;
}

const SIMBOLO = {
  [VERIFIED]: '✔',
  [VIOLATED]: '✘',
  [NOT_EXERCISED]: '✘',
  [VACUO_PERMITIDO]: '○',
};

export function imprimir(resultados, { conductual }) {
  for (const r of resultados) {
    const linea = `  ${SIMBOLO[r.estado]} ${r.id} — ${r.enunciado}`;
    const detalle = `      Estado: ${r.estado} · casos ejercitados: ${r.casos} · violaciones: ${r.violaciones}`;

    if (r.estado === VIOLATED || (r.estado === NOT_EXERCISED && conductual)) {
      console.error(linea);
      console.error(detalle);
      for (const ejemplo of r.ejemplos) console.error(`        · ${ejemplo}`);
      if (r.violaciones > r.ejemplos.length) {
        console.error(`        … y ${r.violaciones - r.ejemplos.length} más`);
      }
      if (r.estado === NOT_EXERCISED) {
        console.error('        · el fixture conductual no le produjo ni un caso');
      }
      continue;
    }

    console.log(linea);
    console.log(detalle);
    if (r.estado === VACUO_PERMITIDO) console.log(`        · vacuo permitido: ${r.motivoVacuo}`);
  }
}

// ---------------------------------------------------------------------------
// CLI
// ---------------------------------------------------------------------------

const invocadoDirectamente =
  process.argv[1] !== undefined &&
  resolve(fileURLToPath(import.meta.url)) === resolve(process.argv[1]);

if (invocadoDirectamente) {
  const observacional = process.argv.includes('--observacional');
  const conductual = !observacional;

  let url = process.env.DATABASE_URL ?? '';
  if (url === '') {
    console.log('audit:invariants — sin DATABASE_URL. Nada que verificar.');
    process.exit(0);
  }

  if (conductual) {
    // Base aislada + fixtures, en ese orden. La de desarrollo no se toca: ni se
    // lee ni se escribe, así que verificar no puede tener efectos colaterales
    // sobre el trabajo de nadie.
    const { prepararBaseDeVerificacion } = await import('./verification-db.mjs');
    const { sembrarFixtures } = await import('./fixtures-invariantes.mjs');
    console.log('Modo CONDUCTUAL — base de verificación aislada y fixtures propios.\n');
    url = await prepararBaseDeVerificacion({ silencioso: true });
    await sembrarFixtures(url, { silencioso: true });
    console.log('  ✔ fixtures conductuales sembrados\n');
  } else {
    console.log(`Modo OBSERVACIONAL — se mira ${new URL(url).pathname.slice(1)} tal como está.\n`);
  }

  const client = new pg.Client({ connectionString: url });
  await client.connect();
  let resultados;
  try {
    resultados = await evaluarInvariantes(client);
  } finally {
    await client.end();
  }

  imprimir(resultados, { conductual });
  const resumen = resumir(resultados);
  console.log('');

  const salida = codigoDeSalida(resumen, { conductual });

  if (resumen.violados > 0) {
    console.error(
      `audit:invariants — ${resumen.violados} de ${resumen.total} invariantes VIOLADOS.`,
    );
    console.error('');
    console.error('Estos no son avisos. Cada uno es una propiedad que el sistema promete y que');
    console.error('en este momento no se cumple: una cifra sin respaldo, un asiento de IA sin');
    console.error('firma, una cadena de auditoría rota. El build no sigue.');
  }

  if (resumen.noEjercitados > 0 && conductual) {
    console.error(
      `audit:invariants — ${resumen.noEjercitados} invariante(s) NO EJERCITADOS en modo conductual.`,
    );
    console.error('');
    console.error('Declararon exigir ejercicio y el fixture no les produjo ni un caso. No se');
    console.error('sabe si se cumplen: no fallaron, no pasaron. Darlos por buenos sería');
    console.error('exactamente el falso verde que este gate existe para no repetir — o el');
    console.error('fixture dejó de cubrir un flujo, o el invariante necesita declarar por qué');
    console.error('hoy no se puede ejercitar.');
  }

  console.log(
    `audit:invariants — ${resumen.verificados} verificados, ${resumen.violados} violados, ` +
      `${resumen.noEjercitados} no ejercitados, ${resumen.vacuosPermitidos} vacuos permitidos.`,
  );

  if (!conductual) {
    console.log('');
    console.log('Modo observacional: esta corrida NO afirma cobertura. Dice qué cumple la base');
    console.log('que se le señaló, y nada sobre lo que esa base no contiene.');
  }

  process.exit(salida);
}
