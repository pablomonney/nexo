import { describe, expect, it } from 'vitest';
import {
  money,
  parseCalendarDate,
  rate,
  zero,
  type AccountingErrorCode,
  type CalendarDate,
} from '@aai/shared';
import {
  balanceDeSumasYSaldos,
  construirContraasiento,
  diferenciaEnMenor,
  evaluarChecklist,
  prepararPosteo,
  puedeCerrar,
  siguienteNumero,
  transicionar,
  validar,
  type AccountSnapshot,
  type HechosDelCierre,
  type JournalEntryDraft,
  type JournalEntryLineDraft,
  type LedgerContext,
  type PeriodSnapshot,
} from './index.js';

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

const fecha = (iso: string): CalendarDate => parseCalendarDate(iso);
const pesos = (centavos: bigint) => money(centavos, 'ARS');
const dolares = (centavos: bigint) => money(centavos, 'USD');

function cuenta(overrides: Partial<AccountSnapshot> & { code: string }): AccountSnapshot {
  return {
    id: `acc-${overrides.code}`,
    name: `Cuenta ${overrides.code}`,
    type: 'ACTIVO',
    nature: 'DEUDORA',
    isPostable: true,
    status: 'ACTIVE',
    currency: 'ARS',
    taxRole: null,
    requiresCostCenter: false,
    requiresThirdParty: false,
    ...overrides,
  };
}

const CUENTAS: readonly AccountSnapshot[] = [
  cuenta({ code: '1.1.01', name: 'Caja' }),
  cuenta({ code: '4.1.01', name: 'Ventas', type: 'INGRESO', nature: 'ACREEDORA' }),
  cuenta({ code: '1.1', name: 'Disponibilidades', isPostable: false }),
  cuenta({ code: '1.1.09', name: 'Cuenta vieja', status: 'ARCHIVED' }),
  cuenta({ code: '1.1.05', name: 'IVA Crédito Fiscal', taxRole: 'IVA_CF' }),
  cuenta({ code: '5.1.01', name: 'Gastos de administración', type: 'GASTO', requiresCostCenter: true }),
  cuenta({ code: '2.1.01', name: 'Proveedores', type: 'PASIVO', nature: 'ACREEDORA', requiresThirdParty: true }),
];

const PERIODOS: readonly PeriodSnapshot[] = [
  {
    id: 'per-1',
    fiscalYearId: 'fy-2025',
    number: 1,
    startDate: fecha('2025-01-01'),
    endDate: fecha('2025-01-31'),
    status: 'ABIERTO',
  },
  {
    id: 'per-2',
    fiscalYearId: 'fy-2025',
    number: 2,
    startDate: fecha('2025-02-01'),
    endDate: fecha('2025-02-28'),
    status: 'BLOQUEADO',
  },
  {
    id: 'per-3',
    fiscalYearId: 'fy-2025',
    number: 3,
    startDate: fecha('2025-03-01'),
    endDate: fecha('2025-03-31'),
    status: 'CERRADO',
  },
];

function contexto(overrides: Partial<LedgerContext> = {}): LedgerContext {
  return {
    companyId: 'empresa-1',
    accountingCurrency: 'ARS',
    accounts: CUENTAS,
    periods: PERIODOS,
    fiscalYears: [
      {
        id: 'fy-2025',
        code: 'EJ2025',
        startDate: fecha('2025-01-01'),
        endDate: fecha('2025-12-31'),
        status: 'ABIERTO',
      },
    ],
    costCenterCodes: ['ADM', 'VTA'],
    postedSources: [],
    fxRoundingMode: 'HALF_UP',
    ...overrides,
  };
}

function linea(overrides: Partial<JournalEntryLineDraft> & { accountCode: string }): JournalEntryLineDraft {
  // Los ceros se emiten en la moneda de la línea: un `credit` en pesos sobre una
  // línea en dólares es una inconsistencia que el motor rechaza, con razón.
  const currency = overrides.currency ?? 'ARS';
  return { debit: zero(currency), credit: zero(currency), ...overrides, currency };
}

function borrador(overrides: Partial<JournalEntryDraft> = {}): JournalEntryDraft {
  return {
    companyId: 'empresa-1',
    journalCode: 'GENERAL',
    entryDate: fecha('2025-01-15'),
    description: 'Venta de contado',
    kind: 'NORMAL',
    currency: 'ARS',
    lines: [
      linea({ accountCode: '1.1.01', debit: pesos(121000n) }),
      linea({ accountCode: '4.1.01', credit: pesos(121000n) }),
    ],
    source: { type: 'MANUAL', id: null },
    ruleApplications: [],
    manualJustification: 'Carga manual del contador',
    actor: { userId: 'user-1' },
    ...overrides,
  };
}

function codigos(draft: JournalEntryDraft, ctx = contexto()): AccountingErrorCode[] {
  const resultado = validar(draft, ctx);
  return resultado.ok ? [] : resultado.errors.map((error) => error.code);
}

// ---------------------------------------------------------------------------

describe('validación del asiento', () => {
  it('acepta un asiento correcto', () => {
    const resultado = validar(borrador(), contexto());
    expect(resultado.ok).toBe(true);
    if (!resultado.ok) return;
    expect(resultado.value.totalDebit.amount).toBe(121000n);
    expect(resultado.value.periodId).toBe('per-1');
    expect(resultado.value.lines.map((l) => l.lineNo)).toEqual([1, 2]);
  });

  it('1 · exige al menos dos líneas', () => {
    const draft = borrador({ lines: [linea({ accountCode: '1.1.01', debit: pesos(100n) })] });
    expect(codigos(draft)).toEqual(['E_MIN_LINES']);
  });

  it('2 · una línea es débito o crédito, nunca las dos ni ninguna', () => {
    expect(
      codigos(
        borrador({
          lines: [
            linea({ accountCode: '1.1.01', debit: pesos(100n), credit: pesos(100n) }),
            linea({ accountCode: '4.1.01', credit: pesos(100n) }),
          ],
        }),
      ),
    ).toContain('E_LINE_SIDE');

    expect(
      codigos(
        borrador({
          lines: [
            linea({ accountCode: '1.1.01' }),
            linea({ accountCode: '4.1.01', credit: pesos(100n) }),
          ],
        }),
      ),
    ).toContain('E_LINE_SIDE');
  });

  it('2 · rechaza importes negativos: el signo lo da la columna', () => {
    const draft = borrador({
      lines: [
        linea({ accountCode: '1.1.01', debit: pesos(-100n) }),
        linea({ accountCode: '4.1.01', credit: pesos(-100n) }),
      ],
    });
    expect(codigos(draft)).toContain('E_LINE_SIDE');
  });

  it('3 · rechaza el descuadre en lugar de ajustarlo', () => {
    const draft = borrador({
      lines: [
        linea({ accountCode: '1.1.01', debit: pesos(121000n) }),
        linea({ accountCode: '4.1.01', credit: pesos(120000n) }),
      ],
    });
    const resultado = validar(draft, contexto());
    expect(resultado.ok).toBe(false);
    if (resultado.ok) return;
    const error = resultado.errors.find((e) => e.code === 'E_UNBALANCED');
    expect(error?.message).toMatch(/diferencia/);
    // La promesa explícita: no hay cuenta de ajuste donde esconder la diferencia.
    expect(error?.message).toMatch(/no ajusta/);
  });

  it('3 · un asiento que suma cero en las dos columnas no registra nada', () => {
    // Cuadra, y aun así es un asiento vacío. Sin este control pasaría.
    const draft = borrador({
      lines: [
        linea({ accountCode: '1.1.01', debit: pesos(0n), credit: pesos(0n) }),
        linea({ accountCode: '4.1.01', debit: pesos(0n), credit: pesos(0n) }),
      ],
    });
    expect(codigos(draft)).toContain('E_LINE_SIDE');
  });

  it('4 · la cuenta existe, está activa y es imputable', () => {
    const inexistente = borrador({
      lines: [
        linea({ accountCode: '9.9.99', debit: pesos(100n) }),
        linea({ accountCode: '4.1.01', credit: pesos(100n) }),
      ],
    });
    expect(codigos(inexistente)).toContain('E_ACCOUNT_NOT_POSTABLE');

    const agrupacion = borrador({
      lines: [
        linea({ accountCode: '1.1', debit: pesos(100n) }),
        linea({ accountCode: '4.1.01', credit: pesos(100n) }),
      ],
    });
    expect(codigos(agrupacion)).toContain('E_ACCOUNT_NOT_POSTABLE');

    const archivada = borrador({
      lines: [
        linea({ accountCode: '1.1.09', debit: pesos(100n) }),
        linea({ accountCode: '4.1.01', credit: pesos(100n) }),
      ],
    });
    expect(codigos(archivada)).toContain('E_ACCOUNT_NOT_POSTABLE');
  });

  it('5 · no se postea en un período cerrado', () => {
    const draft = borrador({ entryDate: fecha('2025-03-10') });
    const resultado = validar(draft, contexto());
    expect(resultado.ok).toBe(false);
    if (resultado.ok) return;
    expect(resultado.errors.map((e) => e.code)).toContain('E_PERIOD_CLOSED');
    expect(resultado.errors.find((e) => e.code === 'E_PERIOD_CLOSED')?.message).toMatch(/reapertura/);
  });

  it('5 · bloqueado no es cerrado: el rol de cierre sí puede postear', () => {
    const draft = borrador({ entryDate: fecha('2025-02-10') });
    expect(codigos(draft)).toContain('E_PERIOD_CLOSED');
    expect(codigos(draft, contexto({ actorCanPostToBlocked: true }))).toEqual([]);
  });

  it('6 · la fecha tiene que caer en algún período', () => {
    const draft = borrador({ entryDate: fecha('2025-06-10') });
    expect(codigos(draft)).toContain('E_DATE_OUT_OF_PERIOD');
  });

  it('6 · manda el ejercicio cuando el período no coincide con él', () => {
    const ctx = contexto({
      fiscalYears: [
        {
          id: 'fy-2025',
          code: 'EJ2025',
          startDate: fecha('2025-02-01'),
          endDate: fecha('2025-12-31'),
          status: 'ABIERTO',
        },
      ],
    });
    expect(codigos(borrador(), ctx)).toContain('E_DATE_OUT_OF_PERIOD');
  });

  it('6 · un ejercicio cerrado bloquea aunque el período figure abierto', () => {
    const ctx = contexto({
      fiscalYears: [
        {
          id: 'fy-2025',
          code: 'EJ2025',
          startDate: fecha('2025-01-01'),
          endDate: fecha('2025-12-31'),
          status: 'CERRADO',
        },
      ],
    });
    expect(codigos(borrador(), ctx)).toContain('E_PERIOD_CLOSED');
  });

  it('7 · exige centro de costo y tercero cuando la cuenta lo pide', () => {
    const sinCentro = borrador({
      lines: [
        linea({ accountCode: '5.1.01', debit: pesos(100n) }),
        linea({ accountCode: '4.1.01', credit: pesos(100n) }),
      ],
    });
    expect(codigos(sinCentro)).toContain('E_MISSING_DIMENSION');

    const conCentro = borrador({
      lines: [
        linea({ accountCode: '5.1.01', debit: pesos(100n), costCenterCode: 'ADM' }),
        linea({ accountCode: '4.1.01', credit: pesos(100n) }),
      ],
    });
    expect(codigos(conCentro)).toEqual([]);

    const sinTercero = borrador({
      lines: [
        linea({ accountCode: '1.1.01', debit: pesos(100n) }),
        linea({ accountCode: '2.1.01', credit: pesos(100n) }),
      ],
    });
    expect(codigos(sinTercero)).toContain('E_MISSING_DIMENSION');
  });

  it('7 · rechaza un centro de costo que no existe', () => {
    const draft = borrador({
      lines: [
        linea({ accountCode: '5.1.01', debit: pesos(100n), costCenterCode: 'NOEXISTE' }),
        linea({ accountCode: '4.1.01', credit: pesos(100n) }),
      ],
    });
    expect(codigos(draft)).toContain('E_MISSING_DIMENSION');
  });

  it('9 · una cuenta con rol fiscal exige su operación fiscal', () => {
    const sinVinculo = borrador({
      lines: [
        linea({ accountCode: '1.1.05', debit: pesos(100n) }),
        linea({ accountCode: '4.1.01', credit: pesos(100n) }),
      ],
    });
    expect(codigos(sinVinculo)).toContain('E_TAX_LINK_MISSING');

    const conVinculo = borrador({
      lines: [
        linea({ accountCode: '1.1.05', debit: pesos(100n), taxTransactionId: 'tax-1' }),
        linea({ accountCode: '4.1.01', credit: pesos(100n) }),
      ],
    });
    expect(codigos(conVinculo)).toEqual([]);
  });

  it('10 · un asiento sin origen demostrable no se postea, ni a mano', () => {
    const draft = borrador({ manualJustification: undefined, ruleApplications: [] });
    const resultado = validar(draft, contexto());
    expect(resultado.ok).toBe(false);
    if (resultado.ok) return;
    expect(resultado.errors.map((e) => e.code)).toContain('E_NO_TRACEABILITY');

    const conRegla = borrador({
      manualJustification: undefined,
      ruleApplications: [{ ruleKey: 'venta-contado', ruleVersion: 1, normVersionId: 'norm-1' }],
    });
    expect(codigos(conRegla)).toEqual([]);
  });

  it('11 · un comprobante no genera dos asientos vigentes', () => {
    const draft = borrador({ source: { type: 'INVOICE', id: 'inv-1' } });
    expect(codigos(draft, contexto({ postedSources: ['INVOICE:inv-1'] }))).toContain(
      'E_DUPLICATE_SOURCE',
    );
    expect(codigos(draft, contexto({ postedSources: ['INVOICE:inv-2'] }))).toEqual([]);
  });

  it('acumula todos los errores determinables, no solo el primero', () => {
    // Un contador tiene que poder corregir todo de una pasada.
    const draft = borrador({
      entryDate: fecha('2025-03-10'),
      manualJustification: undefined,
      lines: [
        linea({ accountCode: '5.1.01', debit: pesos(100n) }),
        linea({ accountCode: '4.1.01', credit: pesos(90n) }),
      ],
    });
    const encontrados = new Set(codigos(draft));
    expect(encontrados).toContain('E_MISSING_DIMENSION');
    expect(encontrados).toContain('E_UNBALANCED');
    expect(encontrados).toContain('E_PERIOD_CLOSED');
    expect(encontrados).toContain('E_NO_TRACEABILITY');
  });
});

// ---------------------------------------------------------------------------
// Moneda extranjera
// ---------------------------------------------------------------------------

describe('moneda extranjera', () => {
  const enDolares = (overrides: Partial<JournalEntryLineDraft> = {}): JournalEntryDraft =>
    borrador({
      lines: [
        linea({
          accountCode: '1.1.01',
          debit: dolares(10000n),
          currency: 'USD',
          fx: { rate: rate('1000'), source: 'BNA vendedor', date: fecha('2025-01-15') },
          ...overrides,
        }),
        linea({ accountCode: '4.1.01', credit: pesos(100_000_00n) }),
      ],
    });

  it('convierte a la moneda de la contabilidad y cuadra ahí', () => {
    // USD 100,00 a 1000 → ARS 100.000,00
    const resultado = validar(enDolares(), contexto());
    expect(resultado.ok).toBe(true);
    if (!resultado.ok) return;
    expect(resultado.value.lines[0]!.debit.amount).toBe(10_000_000n);
    expect(resultado.value.lines[0]!.debit.currency).toBe('ARS');
    expect(resultado.value.totalDebit.amount).toBe(resultado.value.totalCredit.amount);
  });

  it('8 · sin cotización no se postea', () => {
    const resultado = validar(
      borrador({
        lines: [
          linea({ accountCode: '1.1.01', debit: dolares(10000n), currency: 'USD' }),
          linea({ accountCode: '4.1.01', credit: pesos(100_000_00n) }),
        ],
      }),
      contexto(),
    );
    expect(resultado.ok).toBe(false);
    if (!resultado.ok) expect(resultado.errors[0]!.code).toBe('E_MISSING_FX');
  });

  it('8 · sin fuente declarada tampoco: un rate suelto no es auditable', () => {
    const codigosError = codigos(
      enDolares({ fx: { rate: rate('1000'), source: '  ', date: fecha('2025-01-15') } }),
    );
    expect(codigosError).toContain('E_MISSING_FX');
  });

  it('8 · rechaza una cotización posterior a la fecha del asiento', () => {
    const resultado = validar(
      enDolares({ fx: { rate: rate('1000'), source: 'BNA', date: fecha('2025-01-20') } }),
      contexto(),
    );
    expect(resultado.ok).toBe(false);
    if (!resultado.ok) expect(resultado.errors[0]!.message).toMatch(/posterior/);
  });

  it('la línea tiene que declarar la misma moneda que sus importes', () => {
    const draft = borrador({
      lines: [
        linea({ accountCode: '1.1.01', debit: dolares(10000n), currency: 'ARS' }),
        linea({ accountCode: '4.1.01', credit: pesos(10000n) }),
      ],
    });
    expect(codigos(draft)).toContain('E_LINE_SIDE');
  });

  it('el modo de redondeo decide si el asiento cuadra', () => {
    // USD 0,01 a 1000,50 → 10,005 pesos, exactamente en la mitad. HALF_UP da
    // 1001 centavos; DOWN, 1000. Con el crédito en 1001, el mismo asiento cuadra
    // con un modo y no con el otro — que es la razón concreta por la que el modo
    // es un parámetro normativo y no una constante del código (ADR-005).
    const conTasaQuebrada = borrador({
      lines: [
        linea({
          accountCode: '1.1.01',
          debit: dolares(1n),
          currency: 'USD',
          fx: { rate: rate('1000.50'), source: 'BNA', date: fecha('2025-01-15') },
        }),
        linea({ accountCode: '4.1.01', credit: pesos(1001n) }),
      ],
    });

    const arriba = validar(conTasaQuebrada, contexto({ fxRoundingMode: 'HALF_UP' }));
    expect(arriba.ok).toBe(true);
    if (arriba.ok) expect(arriba.value.lines[0]!.debit.amount).toBe(1001n);

    const abajo = validar(conTasaQuebrada, contexto({ fxRoundingMode: 'DOWN' }));
    expect(abajo.ok).toBe(false);
    if (!abajo.ok) expect(abajo.errors.map((e) => e.code)).toContain('E_UNBALANCED');
  });
});

// ---------------------------------------------------------------------------
// Numeración
// ---------------------------------------------------------------------------

describe('numeración', () => {
  it('la clave del contador es empresa, libro y ejercicio', () => {
    const resultado = prepararPosteo(borrador(), contexto());
    expect(resultado.ok).toBe(true);
    if (!resultado.ok) return;
    expect(resultado.value.claveNumeracion).toEqual({
      companyId: 'empresa-1',
      journalCode: 'GENERAL',
      fiscalYearId: 'fy-2025',
    });
  });

  it('es correlativa y sin huecos', () => {
    expect(siguienteNumero(0)).toBe(1);
    expect(siguienteNumero(46)).toBe(47);
    expect(() => siguienteNumero(-1)).toThrow();
    expect(() => siguienteNumero(1.5)).toThrow();
  });

  it('un asiento rechazado no llega a numerarse', () => {
    const resultado = prepararPosteo(borrador({ entryDate: fecha('2025-03-10') }), contexto());
    expect(resultado.ok).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// Contraasiento
// ---------------------------------------------------------------------------

describe('contraasiento', () => {
  const original = {
    id: 'je-1',
    companyId: 'empresa-1',
    journalCode: 'GENERAL' as const,
    entryDate: fecha('2025-01-15'),
    description: 'Venta de contado',
    currency: 'ARS' as const,
    status: 'APROBADO' as const,
    lines: [
      linea({ accountCode: '1.1.01', debit: pesos(121000n) }),
      linea({ accountCode: '4.1.01', credit: pesos(121000n) }),
    ],
    source: { type: 'INVOICE' as const, id: 'inv-1' },
  };

  const opciones = {
    fecha: fecha('2025-01-20'),
    motivo: 'Error de imputación',
    actor: { userId: 'user-1' },
  };

  it('intercambia Debe y Haber, no resta', () => {
    const resultado = construirContraasiento(original, opciones);
    expect(resultado.ok).toBe(true);
    if (!resultado.ok) return;

    expect(resultado.draft.kind).toBe('REVERSION');
    expect(resultado.draft.lines[0]!.credit.amount).toBe(121000n);
    expect(resultado.draft.lines[0]!.debit.amount).toBe(0n);
    // Ningún importe negativo: un libro no los admite.
    for (const l of resultado.draft.lines) {
      expect(l.debit.amount >= 0n && l.credit.amount >= 0n).toBe(true);
    }
  });

  it('el contraasiento validado cuadra', () => {
    const resultado = construirContraasiento(original, opciones);
    if (!resultado.ok) throw new Error('esperaba contraasiento');
    expect(validar(resultado.draft, contexto()).ok).toBe(true);
  });

  it('NO hereda el comprobante del original', () => {
    // Si lo heredara, el índice único lo tomaría por un asiento duplicado del
    // mismo comprobante — que es exactamente lo que no es.
    const resultado = construirContraasiento(original, opciones);
    if (!resultado.ok) throw new Error('esperaba contraasiento');
    expect(resultado.draft.source.id).toBeNull();
    expect(
      validar(resultado.draft, contexto({ postedSources: ['INVOICE:inv-1'] })).ok,
    ).toBe(true);
  });

  it('no se contrapone un borrador: se edita', () => {
    const resultado = construirContraasiento({ ...original, status: 'BORRADOR' }, opciones);
    expect(resultado.ok).toBe(false);
    if (!resultado.ok) expect(resultado.motivo).toMatch(/se edita/);
  });

  it('exige motivo', () => {
    const resultado = construirContraasiento(original, { ...opciones, motivo: '' });
    expect(resultado.ok).toBe(false);
  });

  it('puede tener fecha distinta a la del original', () => {
    // El período del original puede estar cerrado: la corrección va a uno abierto.
    const resultado = construirContraasiento(original, { ...opciones, fecha: fecha('2025-01-31') });
    if (!resultado.ok) throw new Error('esperaba contraasiento');
    expect(resultado.draft.entryDate).toBe('2025-01-31');
  });
});

// ---------------------------------------------------------------------------
// Períodos
// ---------------------------------------------------------------------------

describe('estados del período', () => {
  it('el camino normal', () => {
    expect(transicionar({ desde: 'ABIERTO', transicion: 'BLOQUEAR', actorId: 'a' })).toEqual({
      ok: true,
      hacia: 'BLOQUEADO',
    });
    expect(transicionar({ desde: 'BLOQUEADO', transicion: 'CERRAR', actorId: 'a' })).toEqual({
      ok: true,
      hacia: 'CERRADO',
    });
  });

  it('no se bloquea lo que ya está cerrado', () => {
    expect(transicionar({ desde: 'CERRADO', transicion: 'BLOQUEAR', actorId: 'a' }).ok).toBe(false);
  });

  it('la reapertura exige motivo y dos personas distintas', () => {
    const base = { desde: 'CERRADO', transicion: 'REABRIR', actorId: 'contador' } as const;

    expect(transicionar({ ...base, refrendadoPor: 'admin' }).ok).toBe(false);
    expect(transicionar({ ...base, motivo: 'ajuste' }).ok).toBe(false);

    const mismaPersona = transicionar({
      ...base,
      motivo: 'ajuste de cierre',
      refrendadoPor: 'contador',
    });
    expect(mismaPersona.ok).toBe(false);
    if (!mismaPersona.ok) expect(mismaPersona.motivo).toMatch(/otra persona/);

    expect(
      transicionar({ ...base, motivo: 'ajuste de cierre', refrendadoPor: 'admin' }),
    ).toEqual({ ok: true, hacia: 'ABIERTO' });
  });

  it('solo se reabre lo que está cerrado', () => {
    expect(
      transicionar({
        desde: 'ABIERTO',
        transicion: 'REABRIR',
        actorId: 'a',
        motivo: 'x',
        refrendadoPor: 'b',
      }).ok,
    ).toBe(false);
  });
});

describe('checklist de cierre', () => {
  const limpio: HechosDelCierre = {
    asientosEnBorrador: 0,
    asientosPropuestosSinAprobar: 0,
    comprobantesSinAsiento: 0,
    documentosConHallazgoBloqueante: 0,
    duplicadosSinResolver: 0,
    propuestasDeIaSinRevisar: 0,
    bancosSinConciliar: 0,
    diferenciaSumasYSaldosEnMenor: '0',
  };

  it('con todo en orden, se puede cerrar', () => {
    expect(puedeCerrar(evaluarChecklist(limpio))).toBe(true);
  });

  it('un balance que no cuadra impide cerrar', () => {
    const checklist = evaluarChecklist({ ...limpio, diferenciaSumasYSaldosEnMenor: '100' });
    expect(puedeCerrar(checklist)).toBe(false);
    expect(checklist.find((i) => i.codigo === 'BALANCE_CUADRA')?.cumple).toBe(false);
  });

  it('una propuesta de IA sin revisar impide cerrar', () => {
    // Cerrar con propuestas sin revisar sería cerrar sobre trabajo sin decidir.
    expect(puedeCerrar(evaluarChecklist({ ...limpio, propuestasDeIaSinRevisar: 3 }))).toBe(false);
  });

  it('un banco sin conciliar advierte pero no impide', () => {
    const checklist = evaluarChecklist({ ...limpio, bancosSinConciliar: 2 });
    expect(puedeCerrar(checklist)).toBe(true);
    expect(checklist.find((i) => i.codigo === 'BANCOS_CONCILIADOS')?.cumple).toBe(false);
  });

  it('una diferencia ilegible se trata como diferencia', () => {
    expect(
      puedeCerrar(evaluarChecklist({ ...limpio, diferenciaSumasYSaldosEnMenor: 'ni idea' })),
    ).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// Balance de sumas y saldos
// ---------------------------------------------------------------------------

describe('balance de sumas y saldos', () => {
  const movimientos = [
    {
      accountId: 'acc-1',
      accountCode: '1.1.01',
      accountName: 'Caja',
      nature: 'DEUDORA' as const,
      debit: pesos(121000n),
      credit: zero('ARS'),
    },
    {
      accountId: 'acc-2',
      accountCode: '4.1.01',
      accountName: 'Ventas',
      nature: 'ACREEDORA' as const,
      debit: zero('ARS'),
      credit: pesos(121000n),
    },
  ];

  it('cumple las tres igualdades', () => {
    const balance = balanceDeSumasYSaldos(movimientos, [], 'ARS');
    expect(balance.cuadra).toBe(true);
    expect(balance.verificaciones.map((v) => v.cumple)).toEqual([true, true, true]);
    expect(balance.totalDebitos.amount).toBe(121000n);
    expect(balance.totalSaldosDeudores.amount).toBe(balance.totalSaldosAcreedores.amount);
  });

  it('arrastra el saldo inicial', () => {
    const balance = balanceDeSumasYSaldos(movimientos, [{ accountId: 'acc-1', monto: pesos(50000n) }], 'ARS');
    const caja = balance.lineas.find((l) => l.accountId === 'acc-1')!;
    expect(caja.saldoFinal.amount).toBe(171000n);
  });

  it('incluye cuentas con saldo inicial y sin movimientos', () => {
    // Omitirlas haría que los totales no cierren, sin ninguna señal de por qué.
    const balance = balanceDeSumasYSaldos(movimientos, [{ accountId: 'acc-9', monto: pesos(0n) }], 'ARS');
    expect(balance.lineas.some((l) => l.accountId === 'acc-9')).toBe(true);
  });

  it('detecta el descuadre y bloquea la emisión de estados', () => {
    const rotos = [movimientos[0]!, { ...movimientos[1]!, credit: pesos(120000n) }];
    const balance = balanceDeSumasYSaldos(rotos, [], 'ARS');
    expect(balance.cuadra).toBe(false);
    expect(diferenciaEnMenor(balance)).toBe('1000');
  });

  it('la diferencia viaja como texto: un bigint no sobrevive a JSON', () => {
    const balance = balanceDeSumasYSaldos(movimientos, [], 'ARS');
    expect(diferenciaEnMenor(balance)).toBe('0');
    expect(typeof diferenciaEnMenor(balance)).toBe('string');
  });

  it('funciona con importes por encima de 2^53', () => {
    const enormes = [
      { ...movimientos[0]!, debit: pesos(9_007_199_254_740_993n) },
      { ...movimientos[1]!, credit: pesos(9_007_199_254_740_993n) },
    ];
    const balance = balanceDeSumasYSaldos(enormes, [], 'ARS');
    expect(balance.cuadra).toBe(true);
    expect(balance.totalDebitos.amount).toBe(9_007_199_254_740_993n);
  });
});
