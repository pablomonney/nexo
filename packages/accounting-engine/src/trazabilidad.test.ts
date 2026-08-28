/**
 * Las tres vías de trazabilidad, en el motor puro.
 *
 * `E_NO_TRACEABILITY` era una disyunción de dos —regla aplicada o justificación
 * firmada— y ahora es de tres. Lo que estos tests fijan no es solo que la
 * tercera funcione: es que las dos viejas **siguen** funcionando exactamente
 * igual, y que citar una decisión que no se pudo resolver es un error distinto
 * de no citar nada.
 */

import { describe, expect, it } from 'vitest';
import { money } from '@aai/shared';
import { prepararPosteo } from './post.js';
import type { JournalEntryDraft } from './contracts.js';
import type { DecisionSnapshot, LedgerContext } from './ledger-context.js';

const DECISION: DecisionSnapshot = {
  id: '01a04000-0000-7000-8000-00000000d001',
  origen: 'MANUAL',
  resultado: 'PROPUESTA_DE_ASIENTO',
  reglasAplicadas: 0,
};

const CONTEXTO: LedgerContext = {
  companyId: '01a04000-0000-7000-8000-000000000001',
  accountingCurrency: 'ARS',
  accounts: [
    {
      id: 'a1', code: '1.1.01', name: 'Caja', type: 'ACTIVO', nature: 'DEUDORA',
      isPostable: true, status: 'ACTIVE', currency: 'ARS', taxRole: null,
      requiresCostCenter: false, requiresThirdParty: false,
    },
    {
      id: 'a2', code: '4.1.01', name: 'Ventas', type: 'INGRESO', nature: 'ACREEDORA',
      isPostable: true, status: 'ACTIVE', currency: 'ARS', taxRole: null,
      requiresCostCenter: false, requiresThirdParty: false,
    },
  ],
  periods: [
    { id: 'p1', fiscalYearId: 'f1', number: 1, startDate: '2026-01-01', endDate: '2026-12-31', status: 'ABIERTO' },
  ],
  fiscalYears: [
    { id: 'f1', code: 'EJ2026', startDate: '2026-01-01', endDate: '2026-12-31', status: 'ABIERTO' },
  ],
  costCenterCodes: [],
  postedSources: [],
  fxRoundingMode: 'HALF_UP',
};

function draft(overrides: Partial<JournalEntryDraft> = {}): JournalEntryDraft {
  return {
    companyId: CONTEXTO.companyId,
    journalCode: 'GENERAL',
    entryDate: '2026-03-15',
    description: 'Prueba de trazabilidad',
    kind: 'NORMAL',
    currency: 'ARS',
    lines: [
      { accountCode: '1.1.01', debit: money(10_000n, 'ARS'), credit: money(0n, 'ARS'), currency: 'ARS' },
      { accountCode: '4.1.01', debit: money(0n, 'ARS'), credit: money(10_000n, 'ARS'), currency: 'ARS' },
    ],
    source: { type: 'INVOICE', id: '01a04000-0000-7000-8000-00000000c001' },
    ruleApplications: [],
    actor: { userId: 'contadora' },
    ...overrides,
  };
}

/** Códigos de error de un intento de posteo. Vacío si pasó. */
function codigos(d: JournalEntryDraft, c: LedgerContext = CONTEXTO): string[] {
  const r = prepararPosteo(d, c);
  return r.ok ? [] : r.errors.map((e) => e.code);
}

describe('las tres vías satisfacen la trazabilidad', () => {
  it('A · reglas aplicadas → pasa', () => {
    expect(
      codigos(
        draft({
          ruleApplications: [
            { ruleKey: 'AR-X-001', ruleVersion: 1, normVersionId: '01a04000-0000-7000-8000-00000000n001' },
          ],
        }),
      ),
    ).toEqual([]);
  });

  it('I · justificación manual, sin decisión → pasa (el asiento tradicional)', () => {
    expect(codigos(draft({ manualJustification: 'Ajuste resuelto por la contadora.' }))).toEqual([]);
  });

  it('B, G y H · decisión resuelta, SIN reglas y SIN justificación → pasa', () => {
    // Es el caso del circuito nuevo, y el que antes obligaba a repetir la
    // justificación en el asiento solo para conformar al motor.
    const codigosObtenidos = codigos(draft({ decisionId: DECISION.id }), {
      ...CONTEXTO,
      decision: DECISION,
    });
    expect(codigosObtenidos).toEqual([]);
  });

  it('una decisión con reglas aplicadas también pasa, y no se contradicen', () => {
    expect(
      codigos(draft({ decisionId: DECISION.id }), {
        ...CONTEXTO,
        decision: { ...DECISION, origen: 'DETERMINISTICA', reglasAplicadas: 1 },
      }),
    ).toEqual([]);
  });
});

describe('lo que sigue sin pasar', () => {
  it('C · sin nada de las tres → E_NO_TRACEABILITY', () => {
    expect(codigos(draft())).toContain('E_NO_TRACEABILITY');
  });

  it('el mensaje nombra las tres vías, no dos', () => {
    const r = prepararPosteo(draft(), CONTEXTO);
    if (r.ok) throw new Error('debería fallar');
    const mensaje = r.errors.find((e) => e.code === 'E_NO_TRACEABILITY')!.message;
    expect(mensaje).toMatch(/regla aplicada/);
    expect(mensaje).toMatch(/justificación manual/);
    expect(mensaje).toMatch(/decisión contable/);
  });

  it('D, E y F · se citó una decisión que el contexto no resolvió → E_DECISION_NOT_FOUND', () => {
    // El contexto devuelve `null` sea porque no existe, porque es de otra
    // empresa, porque es de ambiente PRUEBA o porque es de otro comprobante.
    // Para el motor los cuatro casos son el mismo: no hay prueba.
    const codigosObtenidos = codigos(draft({ decisionId: DECISION.id }), {
      ...CONTEXTO,
      decision: null,
    });
    expect(codigosObtenidos).toContain('E_DECISION_NOT_FOUND');
  });

  it('citar una decisión y que se resuelva OTRA tampoco alcanza', () => {
    expect(
      codigos(draft({ decisionId: '01a04000-0000-7000-8000-00000000d999' }), {
        ...CONTEXTO,
        decision: DECISION,
      }),
    ).toContain('E_DECISION_NOT_FOUND');
  });

  it('citar algo inexistente y no tener otra vía informa LOS DOS problemas', () => {
    // Son distintos y los dos son ciertos: la cita está rota **y** el asiento
    // quedó sin fundamento. El motor acumula todos los errores que puede
    // determinar en vez de cortar en el primero —lo dice su propio encabezado—,
    // porque quien está por corregir necesita la lista entera.
    const conCita = codigos(draft({ decisionId: DECISION.id }), { ...CONTEXTO, decision: null });
    expect(conCita).toContain('E_DECISION_NOT_FOUND');
    expect(conCita).toContain('E_NO_TRACEABILITY');
  });

  it('pero con otra vía válida, la cita rota se informa SOLA', () => {
    // Acá se ve que los dos códigos son independientes: hay trazabilidad por
    // justificación manual, así que lo único que falta arreglar es la cita.
    const r = codigos(
      draft({ decisionId: DECISION.id, ruleApplications: [
        { ruleKey: 'AR-X-001', ruleVersion: 1, normVersionId: '01a04000-0000-7000-8000-00000000n001' },
      ] }),
      { ...CONTEXTO, decision: null },
    );
    expect(r).toEqual(['E_DECISION_NOT_FOUND']);
  });

  it('una decisión no resuelta no se rescata con justificación manual, pero el asiento entra', () => {
    // La justificación cubre la trazabilidad; la cita rota sigue siendo un error
    // que hay que arreglar, y el motor lo dice.
    const r = codigos(
      draft({ decisionId: DECISION.id, manualJustification: 'Explicado a mano.' }),
      { ...CONTEXTO, decision: null },
    );
    expect(r).toEqual(['E_DECISION_NOT_FOUND']);
  });

  it('sin citar decisión, un contexto que traiga una resuelta no la usa', () => {
    // No se puede fundar un asiento en una decisión que nadie citó: sería el
    // sistema eligiendo el fundamento por su cuenta.
    expect(codigos(draft(), { ...CONTEXTO, decision: DECISION })).toContain('E_NO_TRACEABILITY');
  });
});
