/**
 * Tests del sandbox.
 *
 * El primer `describe` es el que importa: prueba que el candado **falla cerrado**.
 * Lo que se comprueba no es que rechace producción —eso lo haría cualquier lista
 * negra— sino que rechace *todo lo que no pruebe ser un sandbox*, incluida una
 * base recién creada, una base cuyo nombre nadie configuró, y una base a la que
 * no se pudo ni consultar.
 */

import { describe, expect, it } from 'vitest';
import { money, parseCalendarDate, type CalendarDate, type Money } from '@aai/shared';
import type { CuentaParaElMayor, LineaDelLibro } from '@aai/accounting-engine';
import type { AlicuotaRelevada } from '@aai/tax-engine';
import {
  SELLO_DEL_MARCADOR,
  SELLO_DE_SIMULACION,
  explicarRechazo,
  simular,
  verificarAislamiento,
  type EscenarioDeSimulacion,
  type HuellaDelDestino,
} from './index.js';

const F = (iso: string): CalendarDate => parseCalendarDate(iso);
const ARS = (centavos: bigint): Money => money(centavos, 'ARS');

/** Una huella que sí pasa. Los tests la van rompiendo de a un campo. */
function huella(overrides: Partial<HuellaDelDestino> = {}): HuellaDelDestino {
  return {
    nombreDeBase: 'sandbox_aai',
    urlDestino: 'postgres://u:c@localhost:5432/sandbox_aai',
    urlDeProduccion: 'postgres://u:c@localhost:5432/aai',
    nombreDeBaseDeProduccion: 'aai',
    tieneMarcaDeSandbox: true,
    selloDelMarcador: SELLO_DEL_MARCADOR,
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// El candado
// ---------------------------------------------------------------------------

describe('el candado pregunta si es un sandbox, no si es producción', () => {
  it('una base marcada, con prefijo y distinta de producción, pasa', () => {
    const aislamiento = verificarAislamiento(huella());

    expect(aislamiento.aislado).toBe(true);
    if (aislamiento.aislado) expect(aislamiento.base).toBe('sandbox_aai');
  });

  it('sin marca no pasa, aunque todo lo demás esté bien', () => {
    // Es el caso central. Esta base no es producción: tiene el prefijo correcto,
    // otra URL, otro nombre. Y no pasa igual, porque la pregunta no es si es
    // producción — es si demuestra ser un sandbox.
    const aislamiento = verificarAislamiento(
      huella({ tieneMarcaDeSandbox: false, selloDelMarcador: null }),
    );

    expect(aislamiento.aislado).toBe(false);
    if (!aislamiento.aislado) {
      expect(aislamiento.rechazos.map((r) => r.motivo)).toEqual(['SIN_MARCA_DE_SANDBOX']);
    }
  });

  it('una marca fabricada a mano no sirve como prueba', () => {
    const aislamiento = verificarAislamiento(huella({ selloDelMarcador: 'SI' }));

    expect(aislamiento.aislado).toBe(false);
    if (!aislamiento.aislado) {
      expect(aislamiento.rechazos[0]?.motivo).toBe('MARCA_ADULTERADA');
      expect(aislamiento.rechazos[0]?.explicacion).toMatch(/evidencia de que alguien lo intentó/);
    }
  });

  it('detecta que dos URLs distintas apuntan a la misma base', () => {
    // `localhost` y `127.0.0.1` son la misma máquina. Comparar solo las cadenas
    // de conexión dejaría pasar exactamente este caso.
    const aislamiento = verificarAislamiento(
      huella({
        nombreDeBase: 'aai',
        urlDestino: 'postgres://u:c@127.0.0.1:5432/aai',
        nombreDeBaseDeProduccion: 'aai',
        tieneMarcaDeSandbox: false,
      }),
    );

    expect(aislamiento.aislado).toBe(false);
    if (!aislamiento.aislado) {
      expect(aislamiento.rechazos.map((r) => r.motivo)).toContain('MISMA_BASE_QUE_PRODUCCION');
    }
  });

  it('que el entorno no declare producción no es una excusa para pasar', () => {
    // Sin DATABASE_URL las dos comparaciones contra producción no aplican. La
    // marca sigue siendo obligatoria, así que el destino sigue sin pasar.
    const aislamiento = verificarAislamiento(
      huella({
        urlDeProduccion: null,
        nombreDeBaseDeProduccion: null,
        tieneMarcaDeSandbox: false,
      }),
    );

    expect(aislamiento.aislado).toBe(false);
  });

  it('junta todos los motivos en vez de cortar en el primero', () => {
    // Tres fallas a la vez dicen algo distinto que una: dicen que alguien pegó
    // una URL de otro lado, no que se equivocó en un carácter.
    const aislamiento = verificarAislamiento(
      huella({
        nombreDeBase: 'aai',
        urlDestino: 'postgres://u:c@localhost:5432/aai',
        tieneMarcaDeSandbox: false,
        selloDelMarcador: null,
      }),
    );

    expect(aislamiento.aislado).toBe(false);
    if (!aislamiento.aislado) {
      expect(aislamiento.rechazos.map((r) => r.motivo).sort()).toEqual([
        'MISMA_BASE_QUE_PRODUCCION',
        'MISMA_URL_QUE_PRODUCCION',
        'NOMBRE_SIN_PREFIJO',
        'SIN_MARCA_DE_SANDBOX',
      ]);
    }
  });

  it('una marca sin sello es una marca que no dice nada', () => {
    // La columna es NOT NULL en la base, así que este caso no debería llegar. Se
    // cubre igual porque la huella la arma un script: si algún día lee de otra
    // tabla, de una variable o de un archivo, el candado tiene que seguir
    // rechazando el vacío en vez de tratarlo como "no aplica".
    const aislamiento = verificarAislamiento(huella({ selloDelMarcador: null }));

    expect(aislamiento.aislado).toBe(false);
    if (!aislamiento.aislado) {
      expect(aislamiento.rechazos[0]?.motivo).toBe('MARCA_ADULTERADA');
      expect(aislamiento.rechazos[0]?.explicacion).toMatch(/\(vacío\)/);
    }
  });

  it('no hay nada que explicar cuando el destino pasó', () => {
    expect(explicarRechazo(verificarAislamiento(huella()))).toBe('');
  });

  it('el mensaje de rechazo enumera todo y explica la inversión', () => {
    const texto = explicarRechazo(
      verificarAislamiento(huella({ nombreDeBase: 'otra', tieneMarcaDeSandbox: false })),
    );

    expect(texto).toMatch(/SIN_MARCA_DE_SANDBOX/);
    expect(texto).toMatch(/NOMBRE_SIN_PREFIJO/);
    expect(texto).toMatch(/falla del lado seguro/);
  });
});

// ---------------------------------------------------------------------------
// El escenario
// ---------------------------------------------------------------------------

const CUENTAS: CuentaParaElMayor[] = [
  { id: 'cta-merc', code: '1.1.05.01', name: 'Mercaderías', nature: 'DEUDORA' },
  { id: 'cta-iva', code: '1.1.04.01', name: 'IVA Crédito Fiscal', nature: 'DEUDORA' },
  { id: 'cta-prov', code: '2.1.01.01', name: 'Proveedores', nature: 'ACREEDORA' },
];

const GENERAL: AlicuotaRelevada = {
  id: 'sim-general',
  numerador: 21n,
  denominador: 100n,
  etiqueta: '21%',
  vigenteDesde: F('2003-01-18'),
  vigenteHasta: null,
  normVersionId: 'sim-norma',
};

function linea(n: number, cuenta: string, debe: bigint, haber: bigint): LineaDelLibro {
  const referencia = CUENTAS.find((c) => c.id === cuenta)!;
  return {
    id: `linea-${n}`,
    lineNo: n,
    accountId: referencia.id,
    accountCode: referencia.code,
    accountName: referencia.name,
    debit: ARS(debe),
    credit: ARS(haber),
    monedaOriginal: null,
    importeOriginal: null,
    fxRate: null,
    fxSource: null,
    fxDate: null,
    costCenterCode: null,
    partyId: null,
    description: null,
    taxTransactionId: null,
  };
}

function escenario(overrides: Partial<EscenarioDeSimulacion> = {}): EscenarioDeSimulacion {
  return {
    nombre: 'compra simple',
    companyId: 'sim-company',
    fiscalYearId: 'sim-ejercicio',
    moneda: 'ARS',
    desde: F('2026-03-01'),
    hasta: F('2026-03-31'),
    cuentas: CUENTAS,
    alicuotas: [GENERAL],
    comprobantes: [],
    asientos: [
      {
        id: 'sim-1',
        journalCode: 'COMPRAS',
        entryNumber: 1,
        entryDate: F('2026-03-12'),
        description: 'Compra — SIMULACIÓN',
        kind: 'NORMAL',
        status: 'APROBADO',
        fiscalYearId: 'sim-ejercicio',
        periodId: 'sim-periodo',
        reversesEntryId: null,
        sourceType: 'INVOICE',
        sourceId: null,
        // Sin esto el Diario dispara RESPALDO_DOCUMENTAL (art. 321), que es
        // correcto y ruido para lo que este fixture quiere mostrar.
        documentId: 'sim-doc-1',
        manualJustification: null,
        aiPredictionId: null,
        createdBy: 'sandbox',
        approvedBy: 'sandbox',
        lines: [
          linea(1, 'cta-merc', 100_000_00n, 0n),
          linea(2, 'cta-iva', 21_000_00n, 0n),
          linea(3, 'cta-prov', 0n, 121_000_00n),
        ],
      },
    ],
    ...overrides,
  };
}

/** El único aislamiento que el tipo admite. Sale del candado, no de un literal. */
function aislado() {
  const resultado = verificarAislamiento(huella());
  if (!resultado.aislado) throw new Error('la huella de prueba debería pasar');
  return resultado;
}

describe('la simulación corre los mismos motores que producción', () => {
  it('encadena IVA, Diario, Mayor y Balance', () => {
    const resultado = simular(escenario(), aislado());

    expect(resultado.pasos.map((p) => p.paso)).toEqual(['IVA', 'DIARIO', 'MAYOR', 'BALANCE']);
    expect(resultado.pasos.every((p) => p.sinObservaciones)).toBe(true);
    expect(resultado.balance.cuadra).toBe(true);
  });

  it('el sello viaja en el dato, no solo en la pantalla', () => {
    // Un resultado copiado a un mail o exportado a un CSV tiene que seguir
    // diciendo qué es. La advertencia que vive únicamente en el encabezado de la
    // interfaz desaparece en el primer copiar-y-pegar.
    const resultado = simular(escenario(), aislado());

    expect(resultado.sello).toBe(SELLO_DE_SIMULACION);
    expect(resultado.resumen).toContain(SELLO_DE_SIMULACION);
  });

  it('un asiento desbalanceado se ve acá igual que en producción', () => {
    // El punto del sandbox: si el control existe en producción, existe acá. Un
    // simulador más permisivo enseñaría a confiar en un sistema que no es el que
    // se va a usar.
    const roto = escenario();
    const asiento = roto.asientos[0]!;
    const resultado = simular(
      {
        ...roto,
        asientos: [{ ...asiento, lines: asiento.lines.slice(0, 2) }],
      },
      aislado(),
    );

    const diario = resultado.pasos.find((p) => p.paso === 'DIARIO')!;
    expect(diario.sinObservaciones).toBe(false);
    expect(diario.observaciones.join(' ')).toMatch(/PARTIDA_DOBLE/);
  });

  it('sin alícuotas declaradas lo dice, y no supone 21%', () => {
    const resultado = simular(escenario({ alicuotas: [] }), aislado());

    expect(resultado.resumen).toMatch(/SIN alícuotas declaradas/);
    expect(resultado.resumen).toMatch(/No supone 21%/);
  });

  it('avisa si el Mayor y el Diario leyeron universos distintos', () => {
    // `construirLibroDiario` deja afuera los BORRADOR; `construirLibroMayor` no
    // filtra por estado —confía en que quien llama le pase los registrables—. Un
    // escenario que le da los mismos asientos a los dos hace que la diferencia
    // aparezca en los totales.
    //
    // En producción esta divergencia se descubre meses después, cuando el balance
    // no cierra y nadie sabe desde cuándo. Acá es un renglón del paso MAYOR.
    const base = escenario();
    const aprobado = base.asientos[0]!;
    const resultado = simular(
      {
        ...base,
        asientos: [
          aprobado,
          { ...aprobado, id: 'sim-2', entryNumber: 2, status: 'BORRADOR' },
        ],
      },
      aislado(),
    );

    const mayor = resultado.pasos.find((p) => p.paso === 'MAYOR')!;
    expect(mayor.sinObservaciones).toBe(false);
    expect(mayor.observaciones.join(' ')).toMatch(/no coincide con el del Diario/);
  });

  it('un paso con observaciones no es una falla del simulador', () => {
    // Distinción que el resumen tiene que sostener: el escenario que encuentra un
    // problema es un escenario que funcionó.
    const roto = escenario();
    const asiento = roto.asientos[0]!;
    const resultado = simular(
      { ...roto, asientos: [{ ...asiento, lines: asiento.lines.slice(0, 2) }] },
      aislado(),
    );

    expect(resultado.resumen).toMatch(/no es una falla del simulador/);
  });
});
