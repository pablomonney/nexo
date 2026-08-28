/**
 * Tests de los estados contables.
 *
 * El criterio de la fase es *"dos empresas con marcos distintos generan
 * estructuras distintas **sin cambiar código**; todo renglón tiene lineage no
 * nulo"*. Los dos primeros `describe` son esa frase, verificada.
 *
 * Las plantillas de este archivo son **fixtures de test**, chicas a propósito:
 * prueban el motor, no la transcripción. Las de producción —el ESP y el ER
 * completos de los arts. 63 y 64— viven en `scripts/statement-templates.mjs` y se
 * ejercitan desde `tests/integration/statement-templates.test.ts`, que las lee
 * **de la base**: entre el archivo y lo que el motor recibe hay una
 * serialización, un `INSERT` y una lectura, y un test sobre el objeto del archivo
 * no prueba ninguno de esos tres pasos.
 */

import { describe, expect, it } from 'vitest';
import { money, parseCalendarDate, type CalendarDate, type Money } from '@aai/shared';
import {
  aplanar,
  cifraDeRenglon,
  cifrasDeLasNotas,
  construirEstado,
  desagregarRenglon,
  remisiones,
  renglonDe,
  verificarNotas,
  type Nota,
  plantillaAplicable,
  totalDe,
  validarPlantilla,
  type PlantillaEstado,
  type SaldoDeCuenta,
} from './index.js';

const fecha = (iso: string): CalendarDate => parseCalendarDate(iso);
const pesos = (centavos: bigint): Money => money(centavos, 'ARS');

const ART_63 = 'Ley 19.550 (T.O. 1984), art. 63';

function cuenta(
  codigo: string,
  tipo: SaldoDeCuenta['tipo'],
  saldo: bigint,
  overrides: Partial<SaldoDeCuenta> = {},
): SaldoDeCuenta {
  return {
    accountId: `acc-${codigo}`,
    codigo,
    nombre: `Cuenta ${codigo}`,
    tipo,
    saldo: pesos(saldo),
    imputable: true,
    ...overrides,
  };
}

/**
 * Un plan chico que cierra: Activo 300.000 = Pasivo 120.000 + PN 180.000.
 *
 * Los pasivos y el PN tienen saldo **negativo** porque en el Mayor un saldo
 * acreedor es negativo. La plantilla los expone con `INVERTIDO`.
 */
const PLAN: readonly SaldoDeCuenta[] = [
  cuenta('1.1.01', 'ACTIVO', 50_000n), // Caja
  cuenta('1.1.02', 'ACTIVO', 70_000n), // Banco
  cuenta('1.1.10', 'ACTIVO', 80_000n), // Deudores por ventas
  cuenta('1.2.01', 'ACTIVO', 100_000n), // Bienes de uso
  cuenta('2.1.01', 'PASIVO', -120_000n), // Proveedores
  cuenta('3.1.01', 'PN', -150_000n), // Capital
  cuenta('3.2.01', 'PN', -30_000n), // Resultados acumulados
];

/** ESP con la estructura del art. 63: corriente / no corriente. */
const ESP_LGS: PlantillaEstado = {
  id: 'tpl-esp-lgs',
  tipo: 'ESP',
  marco: 'RT_FACPCE',
  tipoEnte: 'SA',
  regulador: 'IGJ',
  version: 1,
  vigenteDesde: fecha('2024-01-01'),
  vigenteHasta: null,
  normVersionId: 'nv-lgs',
  articulo: 'Art. 63',
  // El alcance es de la plantilla: sobre qué tipos de cuenta se pronuncia este
  // estado. Sin él, una cuenta de resultado en el plan saldría marcada como
  // huérfana del ESP, que es el defecto que esta fase cierra.
  alcance: {
    tipos: ['ACTIVO', 'PASIVO', 'PN', 'ORDEN'],
    fundamento: `: activo, pasivo, patrimonio neto y cuentas de orden`,
  },
  ecuacion: { activo: 'A', pasivo: 'P', patrimonioNeto: 'PN' },
  raiz: [
    {
      codigo: 'A',
      etiqueta: 'ACTIVO',
      tipo: 'RUBRO',
      fundamento: `${ART_63} inc. 1`,
      hijos: [
        {
          codigo: 'AC',
          etiqueta: 'Activo corriente',
          tipo: 'RUBRO',
          fundamento: `${ART_63} inc. 4 ap. a`,
          hijos: [
            {
              codigo: 'AC.CAJA',
              etiqueta: 'Caja y bancos',
              tipo: 'RENGLON',
              selector: { prefijos: ['1.1.0'] },
            },
            {
              codigo: 'AC.CRED',
              etiqueta: 'Créditos por ventas',
              tipo: 'RENGLON',
              selector: { prefijos: ['1.1.1'] },
            },
          ],
        },
        {
          codigo: 'ANC',
          etiqueta: 'Activo no corriente',
          tipo: 'RUBRO',
          fundamento: `${ART_63} inc. 1 ap. e`,
          hijos: [
            {
              codigo: 'ANC.BU',
              etiqueta: 'Bienes de uso',
              tipo: 'RENGLON',
              selector: { prefijos: ['1.2.'] },
            },
          ],
        },
      ],
    },
    {
      codigo: 'P',
      etiqueta: 'PASIVO',
      tipo: 'RUBRO',
      fundamento: `${ART_63} inc. 2 ap. I`,
      hijos: [
        {
          codigo: 'P.COM',
          etiqueta: 'Deudas comerciales',
          tipo: 'RENGLON',
          presentacion: 'INVERTIDO',
          selector: { prefijos: ['2.'] },
        },
      ],
    },
    {
      codigo: 'PN',
      etiqueta: 'PATRIMONIO NETO',
      tipo: 'RUBRO',
      fundamento: `${ART_63} inc. 2 ap. II`,
      hijos: [
        {
          codigo: 'PN.CAP',
          etiqueta: 'Capital social',
          tipo: 'RENGLON',
          presentacion: 'INVERTIDO',
          selector: { prefijos: ['3.1.'] },
        },
        {
          codigo: 'PN.RES',
          etiqueta: 'Resultados acumulados',
          tipo: 'RENGLON',
          presentacion: 'INVERTIDO',
          selector: { prefijos: ['3.2.'] },
        },
      ],
    },
    {
      codigo: 'TOTAL.PPN',
      etiqueta: 'Total pasivo más patrimonio neto',
      tipo: 'TOTAL',
      suma: ['P', 'PN'],
    },
  ],
};

/**
 * La MISMA información con otra estructura: un ente pequeño que no separa
 * corriente de no corriente.
 *
 * Es el fixture que prueba el criterio de la fase. Nada del código cambia entre
 * los dos: cambia la fila de `statement_templates`.
 */
const ESP_ENTE_PEQUENO: PlantillaEstado = {
  ...ESP_LGS,
  id: 'tpl-esp-pequeno',
  marco: 'ENTE_PEQUENO',
  tipoEnte: 'SRL',
  regulador: 'NINGUNO',
  raiz: [
    {
      codigo: 'A',
      etiqueta: 'ACTIVO',
      tipo: 'RUBRO',
      fundamento: `${ART_63} inc. 1`,
      hijos: [
        { codigo: 'A.TODO', etiqueta: 'Activo', tipo: 'RENGLON', selector: { tipos: ['ACTIVO'] } },
      ],
    },
    {
      codigo: 'P',
      etiqueta: 'PASIVO',
      tipo: 'RUBRO',
      fundamento: `${ART_63} inc. 2 ap. I`,
      hijos: [
        {
          codigo: 'P.TODO',
          etiqueta: 'Pasivo',
          tipo: 'RENGLON',
          presentacion: 'INVERTIDO',
          selector: { tipos: ['PASIVO'] },
        },
      ],
    },
    {
      codigo: 'PN',
      etiqueta: 'PATRIMONIO NETO',
      tipo: 'RUBRO',
      fundamento: `${ART_63} inc. 2 ap. II`,
      hijos: [
        {
          codigo: 'PN.TODO',
          etiqueta: 'Patrimonio neto',
          tipo: 'RENGLON',
          presentacion: 'INVERTIDO',
          selector: { tipos: ['PN'] },
        },
      ],
    },
    {
      codigo: 'TOTAL.PPN',
      etiqueta: 'Total pasivo más patrimonio neto',
      tipo: 'TOTAL',
      suma: ['P', 'PN'],
    },
  ],
};

const DATOS = {
  companyId: 'co-1',
  moneda: 'ARS' as const,
  fechaCierre: fecha('2026-12-31'),
  saldos: PLAN,
};

// ---------------------------------------------------------------------------
// El criterio de la fase
// ---------------------------------------------------------------------------

describe('dos marcos distintos, estructuras distintas, sin tocar el código', () => {
  it('la misma información produce dos estados con distintos renglones', () => {
    const conLgs = construirEstado(ESP_LGS, DATOS);
    const conPequeno = construirEstado(ESP_ENTE_PEQUENO, DATOS);

    expect(conLgs.renglones.map((r) => r.codigo)).toEqual([
      'A',
      'AC',
      'AC.CAJA',
      'AC.CRED',
      'ANC',
      'ANC.BU',
      'P',
      'P.COM',
      'PN',
      'PN.CAP',
      'PN.RES',
      'TOTAL.PPN',
    ]);
    expect(conPequeno.renglones.map((r) => r.codigo)).toEqual([
      'A',
      'A.TODO',
      'P',
      'P.TODO',
      'PN',
      'PN.TODO',
      'TOTAL.PPN',
    ]);

    // Distinta estructura, mismos totales: es la misma empresa.
    expect(totalDe(conLgs, ['A']).amount).toBe(300_000n);
    expect(totalDe(conPequeno, ['A']).amount).toBe(300_000n);
    expect(conLgs.emisible).toBe(true);
    expect(conPequeno.emisible).toBe(true);
  });

  it('la ecuación patrimonial cierra en los dos', () => {
    for (const plantilla of [ESP_LGS, ESP_ENTE_PEQUENO]) {
      const estado = construirEstado(plantilla, DATOS);
      const ecuacion = estado.controles.find((c) => c.codigo === 'ECUACION_PATRIMONIAL');
      expect(ecuacion?.cumple).toBe(true);
      expect(totalDe(estado, ['TOTAL.PPN']).amount).toBe(300_000n);
    }
  });

  it('la plantilla aplicable sale de la fecha, no de la de hoy', () => {
    const vieja: PlantillaEstado = {
      ...ESP_LGS,
      id: 'tpl-vieja',
      version: 1,
      vigenteDesde: fecha('2020-01-01'),
      vigenteHasta: fecha('2023-12-31'),
    };
    const nueva: PlantillaEstado = { ...ESP_LGS, id: 'tpl-nueva', version: 2 };
    const criterio = {
      tipo: 'ESP' as const,
      marco: 'RT_FACPCE' as const,
      tipoEnte: 'SA' as const,
      regulador: 'IGJ' as const,
    };

    expect(plantillaAplicable([vieja, nueva], { ...criterio, fecha: fecha('2022-06-30') })?.id).toBe(
      'tpl-vieja',
    );
    expect(plantillaAplicable([vieja, nueva], { ...criterio, fecha: fecha('2026-12-31') })?.id).toBe(
      'tpl-nueva',
    );
    expect(
      plantillaAplicable([vieja, nueva], { ...criterio, fecha: fecha('2015-01-01') }),
    ).toBeNull();
  });
});

describe('ningún renglón existe sin origen', () => {
  it('cada renglón trae las cuentas que lo formaron', () => {
    const estado = construirEstado(ESP_LGS, DATOS);
    const caja = estado.renglones.find((r) => r.codigo === 'AC.CAJA');

    expect(caja?.importe.amount).toBe(120_000n);
    expect(caja?.origen.map((o) => o.codigo)).toEqual(['1.1.01', '1.1.02']);
    expect(caja?.origen[0]?.aporte.amount).toBe(50_000n);
    expect(caja?.origen[0]?.accountId).toBe('acc-1.1.01');
  });

  it('el origen de un rubro llega hasta las cuentas, no hasta otro subtotal', () => {
    const estado = construirEstado(ESP_LGS, DATOS);
    const activo = estado.renglones.find((r) => r.codigo === 'A');

    // Hacer clic en "ACTIVO" tiene que llevar a las cuatro cuentas, no a dos
    // subtotales que después hay que volver a abrir.
    expect(activo?.origen.map((o) => o.codigo)).toEqual(['1.1.01', '1.1.02', '1.1.10', '1.2.01']);
  });

  it('un total también arrastra el origen de lo que suma', () => {
    const estado = construirEstado(ESP_LGS, DATOS);
    const total = estado.renglones.find((r) => r.codigo === 'TOTAL.PPN');

    expect(total?.importe.amount).toBe(300_000n);
    expect(total?.origen.map((o) => o.codigo)).toEqual(['2.1.01', '3.1.01', '3.2.01']);
  });

  it('un rubro sin cuentas tiene origen vacío, que es distinto de un importe escrito', () => {
    const sinBienesDeUso = PLAN.filter((c) => c.codigo !== '1.2.01');
    const conRenglonVacio: PlantillaEstado = {
      ...ESP_LGS,
      raiz: ESP_LGS.raiz.map((nodo) =>
        nodo.codigo === 'PN'
          ? {
              ...nodo,
              hijos: [
                ...(nodo.hijos ?? []),
                {
                  codigo: 'PN.AJ',
                  etiqueta: 'Ajuste de capital',
                  tipo: 'RENGLON' as const,
                  presentacion: 'INVERTIDO' as const,
                  selector: { prefijos: ['3.9.'] },
                },
              ],
            }
          : nodo,
      ),
    };

    const estado = construirEstado(conRenglonVacio, {
      ...DATOS,
      saldos: [...sinBienesDeUso, cuenta('1.2.01', 'ACTIVO', 100_000n)],
    });
    const ajuste = estado.renglones.find((r) => r.codigo === 'PN.AJ');

    expect(ajuste?.importe.amount).toBe(0n);
    expect(ajuste?.origen).toEqual([]);
    // Se preguntó y no hubo cuentas. No es lo mismo que alguien haya escrito 0.
    expect(estado.emisible).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Los dos controles de cobertura
// ---------------------------------------------------------------------------

describe('cobertura del plan de cuentas', () => {
  it('una cuenta que ningún renglón captura bloquea la emisión', () => {
    const conHuerfana = [...PLAN, cuenta('9.9.99', 'ACTIVO', 0n)];
    const estado = construirEstado(ESP_LGS, { ...DATOS, saldos: conHuerfana });
    const control = estado.controles.find((c) => c.codigo === 'CUENTA_SIN_RUBRO');

    expect(control?.cumple).toBe(false);
    expect(control?.involucrados).toEqual(['9.9.99']);
    expect(estado.emisible).toBe(false);
  });

  it('lo detecta aunque el estado cierre igual: es el caso peligroso', () => {
    // Dos cuentas huérfanas que se compensan. La ecuación patrimonial da bien y
    // los totales se ven normales: sin este control, nadie se entera nunca.
    const conHuerfanasQueSeCompensan = [
      ...PLAN,
      cuenta('9.1.00', 'ACTIVO', 45_000n),
      cuenta('9.2.00', 'ACTIVO', -45_000n),
    ];
    const estado = construirEstado(ESP_LGS, { ...DATOS, saldos: conHuerfanasQueSeCompensan });

    expect(estado.controles.find((c) => c.codigo === 'ECUACION_PATRIMONIAL')?.cumple).toBe(true);
    expect(estado.controles.find((c) => c.codigo === 'CUENTA_SIN_RUBRO')?.cumple).toBe(false);
    expect(estado.emisible).toBe(false);
    expect(
      estado.controles.find((c) => c.codigo === 'CUENTA_SIN_RUBRO')?.detalle,
    ).toMatch(/nadie lo nota/);
  });

  it('una cuenta capturada por dos renglones también bloquea', () => {
    const solapada: PlantillaEstado = {
      ...ESP_LGS,
      raiz: ESP_LGS.raiz.map((nodo) =>
        nodo.codigo === 'A'
          ? {
              ...nodo,
              hijos: [
                {
                  codigo: 'AC',
                  etiqueta: 'Activo corriente',
                  tipo: 'RUBRO' as const,
                  fundamento: ART_63,
                  hijos: [
                    {
                      codigo: 'AC.CAJA',
                      etiqueta: 'Caja y bancos',
                      tipo: 'RENGLON' as const,
                      selector: { prefijos: ['1.1.'] },
                    },
                    {
                      codigo: 'AC.CRED',
                      etiqueta: 'Créditos',
                      tipo: 'RENGLON' as const,
                      // Demasiado ancho: vuelve a capturar 1.1.10.
                      selector: { prefijos: ['1.1.1'] },
                    },
                  ],
                },
                ...(nodo.hijos ?? []).filter((hijo) => hijo.codigo === 'ANC'),
              ],
            }
          : nodo,
      ),
    };

    const estado = construirEstado(solapada, DATOS);
    const control = estado.controles.find((c) => c.codigo === 'CUENTA_EN_DOS_RUBROS');

    expect(control?.cumple).toBe(false);
    expect(control?.involucrados).toEqual(['1.1.10']);
    expect(control?.detalle).toMatch(/selector demasiado ancho/);
    expect(estado.emisible).toBe(false);
  });

  it('las cuentas de agrupación no entran: ya están en sus hijas', () => {
    const conAgrupacion = [
      ...PLAN,
      cuenta('1.1', 'ACTIVO', 200_000n, { imputable: false }),
    ];
    const estado = construirEstado(ESP_LGS, { ...DATOS, saldos: conAgrupacion });

    expect(estado.emisible).toBe(true);
    expect(totalDe(estado, ['A']).amount).toBe(300_000n);
  });

  it('sin la ecuación declarada, el control no corre y lo dice', () => {
    // Una plantilla sin ecuación es legítima —el ER no tiene ninguna que
    // verificar—, y lo que no puede pasar es que informe "verificada" sin
    // haberla verificado.
    const estado = construirEstado({ ...ESP_LGS, ecuacion: undefined }, DATOS);
    const control = estado.controles.find((c) => c.codigo === 'ECUACION_PATRIMONIAL');

    expect(control?.cumple).toBe(true);
    expect(control?.detalle).toMatch(/no se verificó/);
    expect(control?.detalle).toMatch(/no es lo mismo que se verificó y da bien/);
  });

  it('un código mal escrito en la ecuación la rompe, no la desactiva', () => {
    // Sin este control, `{ activo: 'ACTIVO' }` —que no existe; el nodo es 'A'—
    // daría "0 = 0 + 0" y pasaría. Un control que se apaga con un error de tipeo
    // se ve exactamente igual que uno que da bien.
    // La ecuación es de la plantilla desde la migración 0039, así que el error
    // de tipeo se prueba donde puede ocurrir: en la plantilla publicada.
    const estado = construirEstado(
      { ...ESP_LGS, ecuacion: { activo: 'ACTIVO', pasivo: 'P', patrimonioNeto: 'PN' } },
      DATOS,
    );
    const control = estado.controles.find((c) => c.codigo === 'ECUACION_PATRIMONIAL');

    expect(control?.cumple).toBe(false);
    expect(control?.involucrados).toEqual(['ACTIVO']);
    expect(control?.detalle).toMatch(/no correrlo en silencio sería peor/);
    expect(estado.emisible).toBe(false);
  });

  it('totalDe ignora los códigos que no existen en vez de romper', () => {
    const estado = construirEstado(ESP_LGS, DATOS);

    expect(totalDe(estado, ['A', 'NO_EXISTE']).amount).toBe(300_000n);
    expect(totalDe(estado, []).amount).toBe(0n);
  });

  it('un activo que no cierra contra pasivo más PN se señala con la diferencia', () => {
    const desbalanceado = PLAN.map((c) =>
      c.codigo === '3.1.01' ? cuenta('3.1.01', 'PN', -140_000n) : c,
    );
    const estado = construirEstado(ESP_LGS, { ...DATOS, saldos: desbalanceado });
    const control = estado.controles.find((c) => c.codigo === 'ECUACION_PATRIMONIAL');

    expect(control?.cumple).toBe(false);
    expect(control?.detalle).toMatch(/Diferencia: 10000/);
    expect(estado.emisible).toBe(false);
    expect(estado.motivo).toMatch(/no se emite/);
  });
});

// ---------------------------------------------------------------------------
// Comparativo
// ---------------------------------------------------------------------------

describe('información comparativa', () => {
  const ANTERIOR: readonly SaldoDeCuenta[] = [
    cuenta('1.1.01', 'ACTIVO', 30_000n),
    cuenta('1.1.02', 'ACTIVO', 40_000n),
    cuenta('1.1.10', 'ACTIVO', 60_000n),
    cuenta('1.2.01', 'ACTIVO', 100_000n),
    cuenta('2.1.01', 'PASIVO', -80_000n),
    cuenta('3.1.01', 'PN', -150_000n),
    cuenta('3.2.01', 'PN', 0n),
  ];

  it('las dos columnas salen de la MISMA plantilla', () => {
    const estado = construirEstado(ESP_LGS, {
      ...DATOS,
      saldosComparativos: ANTERIOR,
      fechaCierreComparativo: fecha('2025-12-31'),
    });

    expect(estado.fechaCierreComparativo).toBe('2025-12-31');
    expect(estado.renglones.find((r) => r.codigo === 'A')?.comparativo?.amount).toBe(230_000n);
    expect(estado.renglones.find((r) => r.codigo === 'A')?.importe.amount).toBe(300_000n);
    expect(estado.emisible).toBe(true);
  });

  it('sin comparativo la columna es null, no cero', () => {
    const estado = construirEstado(ESP_LGS, DATOS);

    // `0` diría "el año pasado no había nada"; `null` dice "no hay comparativo".
    expect(estado.renglones[0]?.comparativo).toBeNull();
  });

  it('una cuenta que la plantilla no cubre en el comparativo también bloquea', () => {
    // El riesgo real del comparativo no es la estructura —las dos columnas usan
    // la misma plantilla— sino el plan de cuentas del ejercicio anterior.
    const anteriorConHuerfana = [...ANTERIOR, cuenta('9.9.99', 'ACTIVO', 12_000n)];
    const estado = construirEstado(ESP_LGS, {
      ...DATOS,
      saldosComparativos: anteriorConHuerfana,
      fechaCierreComparativo: fecha('2025-12-31'),
    });
    const control = estado.controles.find((c) => c.codigo === 'CUENTA_SIN_RUBRO');

    expect(control?.cumple).toBe(false);
    expect(control?.detalle).toMatch(/comparativo/);
    expect(estado.emisible).toBe(false);
  });

  it('un rubro en cero se oculta solo si también lo está en el comparativo', () => {
    const conOculto: PlantillaEstado = {
      ...ESP_LGS,
      raiz: ESP_LGS.raiz.map((nodo) =>
        nodo.codigo === 'PN'
          ? {
              ...nodo,
              hijos: (nodo.hijos ?? []).map((hijo) =>
                hijo.codigo === 'PN.RES' ? { ...hijo, ocultarSiCero: true } : hijo,
              ),
            }
          : nodo,
      ),
    };

    // Este año 30.000, el anterior 0: se muestra, porque la aparición es el dato.
    const conMovimiento = construirEstado(conOculto, {
      ...DATOS,
      saldosComparativos: ANTERIOR,
      fechaCierreComparativo: fecha('2025-12-31'),
    });
    expect(conMovimiento.renglones.some((r) => r.codigo === 'PN.RES')).toBe(true);

    // Cero en las dos: se oculta.
    const sinMovimiento = construirEstado(conOculto, {
      ...DATOS,
      saldos: PLAN.map((c) => (c.codigo === '3.2.01' ? cuenta('3.2.01', 'PN', 0n) : c)),
      saldosComparativos: ANTERIOR,
      fechaCierreComparativo: fecha('2025-12-31'),
    });
    expect(sinMovimiento.renglones.some((r) => r.codigo === 'PN.RES')).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// Validación de la plantilla
// ---------------------------------------------------------------------------

describe('la plantilla se valida antes de usarla', () => {
  it('la del art. 63 es válida', () => {
    expect(validarPlantilla(ESP_LGS)).toEqual([]);
    expect(aplanar(ESP_LGS)).toHaveLength(12);
  });

  it('un rubro sin fundamento es una agrupación inventada', () => {
    const sinCita: PlantillaEstado = {
      ...ESP_LGS,
      raiz: [{ ...ESP_LGS.raiz[0]!, fundamento: undefined }, ...ESP_LGS.raiz.slice(1)],
    };
    const errores = validarPlantilla(sinCita);

    expect(errores.map((e) => e.codigo)).toContain('RUBRO_SIN_FUNDAMENTO');
    expect(errores.find((e) => e.codigo === 'RUBRO_SIN_FUNDAMENTO')?.mensaje).toMatch(
      /agrupación inventada/,
    );
  });

  it('un código repetido rompe los totales y se rechaza', () => {
    const duplicado: PlantillaEstado = {
      ...ESP_LGS,
      raiz: [
        ...ESP_LGS.raiz,
        { codigo: 'P', etiqueta: 'Otro pasivo', tipo: 'RENGLON', selector: { tipos: ['PASIVO'] } },
      ],
    };

    expect(validarPlantilla(duplicado).map((e) => e.codigo)).toContain('CODIGO_DUPLICADO');
  });

  it('un total que referencia un nodo inexistente se rechaza', () => {
    const roto: PlantillaEstado = {
      ...ESP_LGS,
      raiz: [
        ...ESP_LGS.raiz,
        { codigo: 'T2', etiqueta: 'Total raro', tipo: 'TOTAL', suma: ['NO_EXISTE'] },
      ],
    };

    expect(validarPlantilla(roto).map((e) => e.codigo)).toContain('TOTAL_REFERENCIA_INEXISTENTE');
  });

  it('un total puede sumar otro total declarado más adelante', () => {
    // El caso real: "Total general" suma "Total activo" y "Total pasivo", y uno de
    // ellos aparece después en el árbol. Por eso los totales se resuelven en
    // varias pasadas y no en el orden de aparición.
    const encadenados: PlantillaEstado = {
      ...ESP_LGS,
      raiz: [
        { codigo: 'T.GRAL', etiqueta: 'Total general', tipo: 'TOTAL', suma: ['TOTAL.PPN'] },
        ...ESP_LGS.raiz,
      ],
    };
    const estado = construirEstado(encadenados, DATOS);

    expect(validarPlantilla(encadenados)).toEqual([]);
    expect(estado.renglones.find((r) => r.codigo === 'T.GRAL')?.importe.amount).toBe(300_000n);
    expect(estado.renglones.find((r) => r.codigo === 'T.GRAL')?.origen).toHaveLength(3);
  });

  it('un ciclo entre totales se detecta antes de colgar la construcción', () => {
    const circular: PlantillaEstado = {
      ...ESP_LGS,
      raiz: [
        ...ESP_LGS.raiz,
        { codigo: 'T1', etiqueta: 'T1', tipo: 'TOTAL', suma: ['T2'] },
        { codigo: 'T2', etiqueta: 'T2', tipo: 'TOTAL', suma: ['T1'] },
      ],
    };

    const errores = validarPlantilla(circular);
    expect(errores.map((e) => e.codigo)).toContain('TOTAL_CIRCULAR');
    expect(errores.find((e) => e.codigo === 'TOTAL_CIRCULAR')?.mensaje).toMatch(/→/);
  });

  it('un renglón sin selector y un rubro sin hijos se rechazan', () => {
    const rota: PlantillaEstado = {
      ...ESP_LGS,
      raiz: [
        { codigo: 'X', etiqueta: 'Sin selector', tipo: 'RENGLON' },
        { codigo: 'Y', etiqueta: 'Sin hijos', tipo: 'RUBRO', fundamento: ART_63 },
        { codigo: 'Z', etiqueta: 'Total vacío', tipo: 'TOTAL' },
      ],
    };
    const codigos = validarPlantilla(rota).map((e) => e.codigo);

    expect(codigos).toContain('RENGLON_SIN_SELECTOR');
    expect(codigos).toContain('RUBRO_SIN_HIJOS');
    expect(codigos).toContain('TOTAL_SIN_REFERENCIAS');
  });

  it('un nodo con hijos y selector a la vez es ambiguo', () => {
    const ambiguo: PlantillaEstado = {
      ...ESP_LGS,
      raiz: [
        {
          codigo: 'X',
          etiqueta: 'Ambiguo',
          tipo: 'RENGLON',
          selector: { tipos: ['ACTIVO'] },
          hijos: [{ codigo: 'X.1', etiqueta: 'Hijo', tipo: 'RENGLON', selector: { tipos: ['ACTIVO'] } }],
        },
      ],
    };

    expect(validarPlantilla(ambiguo).map((e) => e.codigo)).toContain('NODO_CON_HIJOS_Y_SELECTOR');
  });

  it('un árbol más profundo que el máximo se rechaza, no se trunca', () => {
    // El bug que tenía la primera versión: el recorrido cortaba en el nivel 6, así
    // que los nodos de abajo no se validaban NI capturaban cuentas, y el control
    // de profundidad —que existía para rechazar esta plantilla— nunca corría.
    let nodo = {
      codigo: 'N7',
      etiqueta: 'Nivel 7',
      tipo: 'RENGLON' as const,
      selector: { tipos: ['ACTIVO' as const] },
    };
    for (let nivel = 6; nivel >= 1; nivel -= 1) {
      nodo = {
        codigo: `N${String(nivel)}`,
        etiqueta: `Nivel ${String(nivel)}`,
        tipo: 'RUBRO',
        fundamento: ART_63,
        hijos: [nodo],
      } as never;
    }

    const errores = validarPlantilla({ ...ESP_LGS, raiz: [nodo as never] });
    expect(errores.map((e) => e.codigo)).toContain('PROFUNDIDAD_EXCESIVA');
    expect(errores.find((e) => e.codigo === 'PROFUNDIDAD_EXCESIVA')?.nodo).toBe('N7');
  });

  it('una plantilla vacía no es un estado contable', () => {
    const errores = validarPlantilla({ ...ESP_LGS, raiz: [] });

    expect(errores).toHaveLength(1);
    expect(errores[0]?.codigo).toBe('PLANTILLA_VACIA');
  });

  it('construir sobre una plantilla inválida no produce renglones', () => {
    const estado = construirEstado({ ...ESP_LGS, raiz: [] }, DATOS);

    expect(estado.renglones).toEqual([]);
    expect(estado.emisible).toBe(false);
    expect(estado.motivo).toMatch(/se vería normal y estaría mal/);
  });

  it('un selector sin ningún criterio no captura todo el plan', () => {
    const vacio: PlantillaEstado = {
      ...ESP_LGS,
      raiz: [
        {
          codigo: 'A',
          etiqueta: 'ACTIVO',
          tipo: 'RUBRO',
          fundamento: ART_63,
          hijos: [{ codigo: 'A.X', etiqueta: 'Sin criterio', tipo: 'RENGLON', selector: {} }],
        },
      ],
    };
    const estado = construirEstado({ ...vacio, ecuacion: undefined }, DATOS);

    expect(estado.renglones.find((r) => r.codigo === 'A.X')?.importe.amount).toBe(0n);
    // Y todas las cuentas quedan sin rubro, que es lo que hay que ver.
    expect(estado.controles.find((c) => c.codigo === 'CUENTA_SIN_RUBRO')?.cumple).toBe(false);
  });

  it('un selector con solo códigos no captura todo el plan', () => {
    // El bug que encontró el fixture del test de exclusión: sin `tipos` ni
    // `prefijos`, los dos criterios restantes no filtran y su conjunción es
    // verdadera para cualquier cuenta. `codigos` es una vía alternativa, no un
    // criterio más.
    const soloCodigos: PlantillaEstado = {
      ...ESP_ENTE_PEQUENO,
      raiz: [
        {
          codigo: 'A',
          etiqueta: 'ACTIVO',
          tipo: 'RUBRO',
          fundamento: ART_63,
          hijos: [
            { codigo: 'A.BU', etiqueta: 'Bienes de uso', tipo: 'RENGLON', selector: { codigos: ['1.2.01'] } },
          ],
        },
      ],
    };
    const estado = construirEstado({ ...soloCodigos, ecuacion: undefined }, DATOS);
    const renglon = estado.renglones.find((r) => r.codigo === 'A.BU');

    expect(renglon?.importe.amount).toBe(100_000n);
    expect(renglon?.origen.map((o) => o.codigo)).toEqual(['1.2.01']);
  });

  it('un selector puede excluir un código que su prefijo captura', () => {
    const conExclusion: PlantillaEstado = {
      ...ESP_ENTE_PEQUENO,
      raiz: ESP_ENTE_PEQUENO.raiz.map((nodo) =>
        nodo.codigo === 'A'
          ? {
              ...nodo,
              hijos: [
                {
                  codigo: 'A.TODO',
                  etiqueta: 'Activo salvo bienes de uso',
                  tipo: 'RENGLON' as const,
                  selector: { tipos: ['ACTIVO' as const], excluir: ['1.2.01'] },
                },
                {
                  codigo: 'A.BU',
                  etiqueta: 'Bienes de uso',
                  tipo: 'RENGLON' as const,
                  selector: { codigos: ['1.2.01'] },
                },
              ],
            }
          : nodo,
      ),
    };
    const estado = construirEstado(conExclusion, DATOS);

    expect(estado.renglones.find((r) => r.codigo === 'A.TODO')?.importe.amount).toBe(200_000n);
    expect(estado.renglones.find((r) => r.codigo === 'A.BU')?.importe.amount).toBe(100_000n);
    expect(estado.emisible).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Notas complementarias — art. 65 e invariante A-2
// ---------------------------------------------------------------------------

describe('una cifra de nota no se escribe: se referencia', () => {
  const estado = construirEstado(
    {
      ...ESP_LGS,
      raiz: ESP_LGS.raiz.map((nodo) =>
        nodo.codigo === 'A'
          ? {
              ...nodo,
              hijos: (nodo.hijos ?? []).map((hijo) =>
                hijo.codigo === 'AC'
                  ? {
                      ...hijo,
                      hijos: (hijo.hijos ?? []).map((nieto) =>
                        nieto.codigo === 'AC.CAJA' ? { ...nieto, nota: 3 } : nieto,
                      ),
                    }
                  : hijo,
              ),
            }
          : nodo,
      ),
    },
    DATOS,
  );

  function nota(overrides: Partial<Nota> = {}): Nota {
    return {
      numero: 3,
      titulo: 'Caja y bancos',
      fundamento: 'Ley 19.550 (T.O. 1984), art. 65',
      referidaPor: ['AC.CAJA'],
      bloques: [
        { tipo: 'TEXTO', contenido: 'Se compone de:', origenTexto: 'HUMANO' },
        {
          tipo: 'CIFRAS',
          cifras: [cifraDeRenglon(estado, 'AC.CAJA')!],
        },
      ],
      ...overrides,
    };
  }

  it('la cifra hereda importe y linaje del renglón', () => {
    const cifra = cifraDeRenglon(estado, 'AC.CAJA');

    expect(cifra?.importe.amount).toBe(120_000n);
    expect(cifra?.origen.map((o) => o.codigo)).toEqual(['1.1.01', '1.1.02']);
    // No hay forma de construir una cifra con un importe propio: la única vía es
    // esta, y falla cuando el renglón no existe.
    expect(cifraDeRenglon(estado, 'NO_EXISTE')).toBeNull();
  });

  it('desagregar un renglón produce una fila por cuenta, y suman el renglón', () => {
    const filas = desagregarRenglon(estado, 'AC.CAJA');
    const suma = filas.reduce((acc, fila) => acc + fila.importe.amount, 0n);

    expect(filas.map((f) => f.etiqueta)).toEqual(['1.1.01', '1.1.02']);
    expect(suma).toBe(120_000n);
    // Cada fila arrastra su propia cuenta: el cuadro es navegable célula a célula.
    expect(filas[0]?.origen).toHaveLength(1);
    expect(desagregarRenglon(estado, 'NO_EXISTE')).toEqual([]);
  });

  it('un juego de notas coherente pasa', () => {
    const resultado = verificarNotas(estado, [nota()]);

    expect(resultado.errores).toEqual([]);
    expect(resultado.consistente).toBe(true);
  });

  it('un renglón que remite a una nota inexistente se detecta', () => {
    const resultado = verificarNotas(estado, []);

    expect(resultado.errores.map((e) => e.codigo)).toContain('REMISION_SIN_NOTA');
  });

  it('una nota a la que nadie remite también se detecta', () => {
    // El control que casi nadie mira: delata la nota que quedó del ejercicio
    // anterior, con las cifras del ejercicio anterior adentro.
    const resultado = verificarNotas(estado, [nota(), nota({ numero: 9, referidaPor: [] })]);
    const huerfana = resultado.errores.find((e) => e.codigo === 'NOTA_NO_REFERIDA');

    expect(huerfana?.nota).toBe(9);
    expect(huerfana?.mensaje).toMatch(/ejercicio anterior/);
  });

  it('una cifra que referencia un renglón inexistente se detecta', () => {
    const conCifraVieja = nota({
      bloques: [
        { tipo: 'TEXTO', contenido: 'x', origenTexto: 'HUMANO' },
        {
          tipo: 'CIFRAS',
          cifras: [
            {
              etiqueta: 'Rubro de otro ejercicio',
              renglonCodigo: 'RUBRO_VIEJO',
              importe: pesos(1n),
              comparativo: null,
              origen: [],
            },
          ],
        },
      ],
    });

    const resultado = verificarNotas(estado, [conCifraVieja]);
    expect(resultado.errores.map((e) => e.codigo)).toContain('RENGLON_INEXISTENTE');
  });

  it('una nota sin texto es una tabla suelta, no una nota', () => {
    const soloCifras = nota({
      bloques: [{ tipo: 'CIFRAS', cifras: [cifraDeRenglon(estado, 'AC.CAJA')!] }],
    });

    const resultado = verificarNotas(estado, [soloCifras]);
    expect(resultado.errores.map((e) => e.codigo)).toContain('NOTA_SIN_TEXTO');
  });

  it('un borrador de IA no llega a un estado emitido', () => {
    const conBorrador = nota({
      bloques: [
        { tipo: 'TEXTO', contenido: 'Redactado por el modelo', origenTexto: 'IA_BORRADOR' },
      ],
    });

    const resultado = verificarNotas(estado, [conBorrador]);
    const error = resultado.errores.find((e) => e.codigo === 'BORRADOR_DE_IA_SIN_REVISAR');

    expect(error?.mensaje).toMatch(/afirmación profesional/);
    expect(resultado.consistente).toBe(false);
  });

  it('dos notas con el mismo número rompen las remisiones', () => {
    const resultado = verificarNotas(estado, [nota(), nota()]);
    expect(resultado.errores.map((e) => e.codigo)).toContain('NUMERO_DUPLICADO');
  });

  it('una nota vacía se detecta', () => {
    const resultado = verificarNotas(estado, [nota({ bloques: [] })]);
    const codigos = resultado.errores.map((e) => e.codigo);

    expect(codigos).toContain('NOTA_SIN_BLOQUES');
    expect(codigos).toContain('NOTA_SIN_TEXTO');
  });

  it('las cifras de un cuadro también se verifican', () => {
    const conCuadro = nota({
      bloques: [
        { tipo: 'TEXTO', contenido: 'Composición:', origenTexto: 'HUMANO' },
        {
          tipo: 'CUADRO',
          encabezados: ['Cuenta', 'Importe'],
          filas: [desagregarRenglon(estado, 'AC.CAJA')],
        },
      ],
    });

    const resultado = verificarNotas(estado, [conCuadro]);
    expect(resultado.consistente).toBe(true);
    // Y todas sus cifras salen con linaje para el invariante A-2.
    const cifras = cifrasDeLasNotas([conCuadro]);
    expect(cifras).toHaveLength(2);
    expect(cifras.every((entrada) => entrada.cifra.origen.length > 0)).toBe(true);
  });

  it('las remisiones se derivan del estado, no se mantienen a mano', () => {
    const mapa = remisiones(estado);

    expect(mapa.get(3)).toEqual(['AC.CAJA']);
    expect(mapa.size).toBe(1);
  });

  it('desde una cifra se vuelve al renglón del estado', () => {
    const cifra = cifraDeRenglon(estado, 'AC.CAJA')!;

    expect(renglonDe(estado, cifra)?.etiqueta).toBe('Caja y bancos');
    expect(
      renglonDe(estado, { ...cifra, renglonCodigo: 'NO_EXISTE' }),
    ).toBeUndefined();
  });
});
