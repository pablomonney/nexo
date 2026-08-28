/**
 * Las plantillas del art. 63 y del art. 64, contra PostgreSQL real.
 *
 * Este archivo prueba algo distinto que los tests unitarios de
 * `@aai/financial-statements`. Aquéllos prueban el motor con plantillas de
 * fixture; éste prueba **la plantilla que está sembrada en la base**, que es la
 * que un estado contable real va a usar.
 *
 * La distinción importa porque `statement_templates.structure` es una columna
 * `jsonb`: entre el archivo que escribimos y lo que el motor lee hay una
 * serialización, un `INSERT` y una lectura. Un test que valide el objeto del
 * archivo no prueba ninguno de esos tres pasos.
 */

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { money, parseCalendarDate, type CalendarDate, type Money } from '@aai/shared';
import {
  construirEstado,
  plantillaAplicable,
  validarPlantilla,
  type PlantillaEstado,
  type SaldoDeCuenta,
} from '@aai/financial-statements';
import { connect, hasDatabase, type Client } from './helpers/db.js';

const suite = hasDatabase ? describe : describe.skip;

const F = (iso: string): CalendarDate => parseCalendarDate(iso);
const ARS = (centavos: bigint): Money => money(centavos, 'ARS');

/** Un saldo. Positivo = deudor, que es la convención del Mayor. */
function saldo(
  codigo: string,
  nombre: string,
  tipo: SaldoDeCuenta['tipo'],
  centavos: bigint,
): SaldoDeCuenta {
  return {
    accountId: `cta-${codigo}`,
    codigo,
    nombre,
    tipo,
    saldo: ARS(centavos),
    imputable: true,
  };
}

/**
 * Un plan chico que sigue la convención declarada.
 *
 * Activo 350.000 = Pasivo 120.000 + PN 230.000.
 */
const SALDOS_ESP: SaldoDeCuenta[] = [
  saldo('1.1.01.01', 'Caja', 'ACTIVO', 100_000_00n),
  saldo('1.1.05.01', 'Mercaderías', 'ACTIVO', 50_000_00n),
  saldo('1.2.05.01', 'Rodados', 'ACTIVO', 200_000_00n),
  saldo('2.1.01.01', 'Proveedores', 'PASIVO', -120_000_00n),
  saldo('3.1.01', 'Capital social', 'PN', -200_000_00n),
  saldo('3.4.01', 'Resultados no asignados', 'PN', -30_000_00n),
];

/** Ventas 500.000 − costo 300.000 − gastos 120.000 = 80.000. */
const SALDOS_ER: SaldoDeCuenta[] = [
  saldo('4.1.01', 'Ventas', 'INGRESO', -500_000_00n),
  saldo('5.1.01', 'Costo de mercaderías vendidas', 'COSTO', 300_000_00n),
  saldo('6.1.01', 'Sueldos de administración', 'GASTO', 80_000_00n),
  saldo('6.2.01', 'Publicidad', 'GASTO', 40_000_00n),
];

const CIERRE = F('2026-12-31');

suite('Las plantillas sembradas de la Ley 19.550', () => {
  let client: Client;
  let todas: PlantillaEstado[] = [];
  const plantillas = new Map<string, PlantillaEstado>();

  beforeAll(async () => {
    client = await connect();
    const filas = await client.query<{
      id: string;
      statement_kind: string;
      framework: string;
      entity_type: string;
      regulator: string;
      version: number;
      valid_from: string;
      valid_to: string | null;
      structure: unknown;
      norm_version_id: string;
      articulo: string;
      scope_types: string[];
      scope_fundamento: string;
      equation: PlantillaEstado['ecuacion'] | null;
    }>(
      `SELECT id, statement_kind, framework, entity_type, regulator, version,
              valid_from::text AS valid_from, valid_to::text AS valid_to,
              structure, norm_version_id, articulo,
              scope_types, scope_fundamento, equation
         FROM statement_templates
        WHERE company_id IS NULL`,
    );

    todas = filas.rows.map((fila) => ({
      id: fila.id,
      tipo: fila.statement_kind as PlantillaEstado['tipo'],
      marco: fila.framework as PlantillaEstado['marco'],
      tipoEnte: fila.entity_type as PlantillaEstado['tipoEnte'],
      regulador: fila.regulator as PlantillaEstado['regulador'],
      version: fila.version,
      vigenteDesde: F(fila.valid_from),
      vigenteHasta: fila.valid_to === null ? null : F(fila.valid_to),
      normVersionId: fila.norm_version_id,
      articulo: fila.articulo,
      raiz: fila.structure as PlantillaEstado['raiz'],
      alcance: {
        tipos: fila.scope_types as PlantillaEstado['alcance']['tipos'],
        fundamento: fila.scope_fundamento,
      },
      ...(fila.equation === null ? {} : { ecuacion: fila.equation }),
    }));

    // Se resuelve con `plantillaAplicable`, no con el `version` más alto ni con
    // la última fila. Es lo que hace la aplicación, y es lo que hace que una
    // versión cerrada por corrección quede efectivamente afuera.
    for (const tipo of ['ESP', 'ER'] as const) {
      const elegida = plantillaAplicable(todas, {
        tipo,
        marco: 'RT_FACPCE',
        tipoEnte: 'SA',
        regulador: 'IGJ',
        fecha: CIERRE,
      });
      if (elegida !== null) plantillas.set(tipo, elegida);
    }
  });

  afterAll(async () => {
    await client?.end();
  });

  it('están sembradas y citan el artículo del que salen', () => {
    expect([...plantillas.keys()].sort()).toEqual(['ER', 'ESP']);
    expect(plantillas.get('ESP')?.articulo).toMatch(/art\. 63/);
    expect(plantillas.get('ER')?.articulo).toMatch(/art\. 64/);
  });

  it('una versión cerrada por corrección no vuelve a elegirse', () => {
    // El ER se corrigió: la v1 tomaba el prefijo "4." entero y excluía "4.9",
    // pero `excluir` compara códigos exactos y la ganancia extraordinaria sumaba
    // en dos renglones. Se cerró con valid_to = valid_from —nunca tuvo un día
    // aplicable— porque el art. 64 no cambió: cambió la transcripción.
    //
    // Si alguna vez se reabriera esa ventana "desde hoy", un estado de un
    // ejercicio anterior emitido mañana volvería a tomar la versión defectuosa.
    const cerradas = todas.filter((p) => p.vigenteHasta !== null);
    for (const cerrada of cerradas) {
      expect(cerrada.vigenteHasta).toBe(cerrada.vigenteDesde);
      expect(plantillas.get(cerrada.tipo)?.id).not.toBe(cerrada.id);
    }
  });

  it('lo que hay en la base pasa el validador, no solo lo que hay en el archivo', () => {
    // Entre el objeto que escribimos y el que el motor lee hay una
    // serialización, un INSERT y una lectura. Validar el archivo no prueba
    // ninguno de esos tres pasos.
    for (const [tipo, plantilla] of plantillas) {
      expect({ tipo, errores: validarPlantilla(plantilla) }).toEqual({ tipo, errores: [] });
    }
  });

  it('cada rubro cita su inciso: la base guardó los fundamentos', () => {
    // `RUBRO_SIN_FUNDAMENTO` ya lo cubre el validador, pero eso comprueba que el
    // campo no esté vacío. Acá se comprueba que diga de qué artículo sale, que es
    // lo que hace utilizable la cita.
    const rubros: string[] = [];
    const recorrer = (nodos: readonly { tipo: string; fundamento?: string; hijos?: unknown }[]): void => {
      for (const nodo of nodos) {
        if (nodo.tipo === 'RUBRO' || nodo.tipo === 'RENGLON') rubros.push(nodo.fundamento ?? '');
        recorrer((nodo.hijos ?? []) as never[]);
      }
    };
    recorrer(plantillas.get('ESP')!.raiz as never[]);

    expect(rubros.length).toBeGreaterThan(10);
    expect(rubros.every((f) => /Ley 19\.550 \(T\.O\. 1984\), art\. 6[34]/.test(f))).toBe(true);
  });

  it('el ESP cierra la ecuación patrimonial', () => {
    const estado = construirEstado(plantillas.get('ESP')!, {
      companyId: 'test',
      moneda: 'ARS',
      fechaCierre: F('2026-12-31'),
      saldos: SALDOS_ESP,
      ecuacion: { activo: 'TOTAL_ACTIVO', pasivo: 'TOTAL_PASIVO', patrimonioNeto: 'TOTAL_PN' },
    });

    const ecuacion = estado.controles.find((c) => c.codigo === 'ECUACION_PATRIMONIAL');
    expect(ecuacion?.cumple).toBe(true);
    expect(estado.emisible).toBe(true);

    const importe = (codigo: string): bigint =>
      estado.renglones.find((r) => r.codigo === codigo)?.importe.amount ?? -1n;

    // El pasivo y el PN se exponen POSITIVOS aunque su saldo sea acreedor. Es lo
    // que hace `presentacion: 'INVERTIDO'`, y sin eso la ecuación cerraría con
    // los tres términos en cero y nadie lo notaría.
    expect(importe('TOTAL_ACTIVO')).toBe(350_000_00n);
    expect(importe('TOTAL_PASIVO')).toBe(120_000_00n);
    expect(importe('TOTAL_PN')).toBe(230_000_00n);
    expect(importe('TOTAL_PASIVO_Y_PN')).toBe(350_000_00n);
  });

  it('separa corriente de no corriente, que es lo que pide el inc. 4) a)', () => {
    const estado = construirEstado(plantillas.get('ESP')!, {
      companyId: 'test',
      moneda: 'ARS',
      fechaCierre: F('2026-12-31'),
      saldos: SALDOS_ESP,
    });

    const importe = (codigo: string): bigint =>
      estado.renglones.find((r) => r.codigo === codigo)?.importe.amount ?? -1n;

    expect(importe('AC')).toBe(150_000_00n);
    expect(importe('ANC')).toBe(200_000_00n);
  });

  it('una cuenta fuera de la convención de códigos se marca, no se pierde', () => {
    // Es el modo de falla que importa. Estas plantillas asumen una codificación
    // de plan de cuentas, y una empresa que use otra tiene que enterarse — no
    // recibir un balance que cierra porque la cuenta simplemente no entró en
    // ningún renglón.
    const estado = construirEstado(plantillas.get('ESP')!, {
      companyId: 'test',
      moneda: 'ARS',
      fechaCierre: F('2026-12-31'),
      saldos: [...SALDOS_ESP, saldo('9.9.99', 'Cuenta de otro plan', 'ACTIVO', 1_000_00n)],
      ecuacion: { activo: 'TOTAL_ACTIVO', pasivo: 'TOTAL_PASIVO', patrimonioNeto: 'TOTAL_PN' },
    });

    const cobertura = estado.controles.find((c) => c.codigo === 'CUENTA_SIN_RUBRO');
    expect(cobertura?.cumple).toBe(false);
    expect(cobertura?.involucrados).toContain('9.9.99');
    expect(estado.emisible).toBe(false);
  });

  it('ninguna cuenta cae en dos renglones a la vez', () => {
    // El renglón de ventas toma el prefijo "4." entero y excluye 4.8 y 4.9, que
    // tienen rubro propio. Sin ese `excluir`, una ganancia extraordinaria sumaría
    // dos veces y el resultado del ejercicio saldría inflado.
    const estado = construirEstado(plantillas.get('ER')!, {
      companyId: 'test',
      moneda: 'ARS',
      fechaCierre: F('2026-12-31'),
      saldos: [
        ...SALDOS_ER,
        saldo('4.9.01', 'Ganancia extraordinaria', 'INGRESO', -10_000_00n),
        saldo('4.8.01', 'Ganancia de ejercicios anteriores', 'INGRESO', -5_000_00n),
      ],
    });

    const duplicadas = estado.controles.find((c) => c.codigo === 'CUENTA_EN_DOS_RUBROS');
    expect(duplicadas?.cumple).toBe(true);

    const importe = (codigo: string): bigint =>
      estado.renglones.find((r) => r.codigo === codigo)?.importe.amount ?? -1n;

    expect(importe('VENTAS')).toBe(500_000_00n);
    expect(importe('EXTRA_GAN')).toBe(10_000_00n);
    expect(importe('AEA_GAN')).toBe(5_000_00n);
  });

  it('el ER separa el resultado ordinario del extraordinario, y suma llano', () => {
    const estado = construirEstado(plantillas.get('ER')!, {
      companyId: 'test',
      moneda: 'ARS',
      fechaCierre: F('2026-12-31'),
      saldos: [...SALDOS_ER, saldo('6.9.01', 'Pérdida extraordinaria', 'GASTO', 25_000_00n)],
    });

    const importe = (codigo: string): bigint =>
      estado.renglones.find((r) => r.codigo === codigo)?.importe.amount ?? -1n;

    // Todo el ER va INVERTIDO, así que cada TOTAL es una suma llana: los costos y
    // gastos ya vienen negativos. La alternativa era que los totales supieran
    // restar según el nodo, y eso es volver a poner contabilidad en el código.
    expect(importe('VENTAS')).toBe(500_000_00n);
    expect(importe('COSTO')).toBe(-300_000_00n);
    expect(importe('RESULTADO_BRUTO')).toBe(200_000_00n);
    expect(importe('GASTOS')).toBe(-120_000_00n);
    expect(importe('RESULTADO_ORDINARIO')).toBe(80_000_00n);

    // El art. 64 exige mostrar por separado lo ordinario de lo extraordinario.
    expect(importe('EXTRA')).toBe(-25_000_00n);
    expect(importe('RESULTADO_EJERCICIO')).toBe(55_000_00n);
  });

  it('el resultado del ER es el que mueve el PN del ESP', () => {
    // No es un control del motor: es la coherencia entre los dos estados, y si no
    // se sostiene, las dos plantillas están describiendo empresas distintas.
    const er = construirEstado(plantillas.get('ER')!, {
      companyId: 'test',
      moneda: 'ARS',
      fechaCierre: F('2026-12-31'),
      saldos: SALDOS_ER,
    });

    const resultado = er.renglones.find((r) => r.codigo === 'RESULTADO_FINAL')?.importe.amount;
    expect(resultado).toBe(80_000_00n);

    const esp = construirEstado(plantillas.get('ESP')!, {
      companyId: 'test',
      moneda: 'ARS',
      fechaCierre: F('2026-12-31'),
      saldos: [
        ...SALDOS_ESP.filter((s) => s.codigo !== '3.4.01'),
        // El resultado del ejercicio, acreedor, entra a resultados acumulados.
        saldo('3.4.01', 'Resultado del ejercicio', 'PN', -80_000_00n),
        // Y el activo tiene que acompañar, o la ecuación no cierra.
        saldo('1.1.03.01', 'Deudores por ventas', 'ACTIVO', 50_000_00n),
      ],
      ecuacion: { activo: 'TOTAL_ACTIVO', pasivo: 'TOTAL_PASIVO', patrimonioNeto: 'TOTAL_PN' },
    });

    const pn = esp.renglones.find((r) => r.codigo === 'PN_RESULTADOS')?.importe.amount;
    expect(pn).toBe(resultado);
    expect(esp.controles.find((c) => c.codigo === 'ECUACION_PATRIMONIAL')?.cumple).toBe(true);
  });
});
