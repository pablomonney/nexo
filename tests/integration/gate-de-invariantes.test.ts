/**
 * Tests del **gate**, no de los invariantes.
 *
 * Los invariantes dicen si el sistema cumple sus promesas. Esto dice si el gate
 * sabe distinguir «cumple» de «no lo probé», que es donde estuvo el falso verde:
 * catorce invariantes sobre una base vacía daban VACUO, VACUO no contaba como
 * violación, y `verify` terminaba en 0.
 *
 * Por eso la mitad de este archivo prueba la **clasificación** con un cliente
 * controlado —es una función pura sobre dos conteos, y ahí vivía el error— y la
 * otra mitad la prueba contra PostgreSQL real, con una violación fabricada que
 * tiene que hacer caer el gate.
 */

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  INVARIANTES,
  codigoDeSalida,
  evaluarInvariantes,
  resumir,
} from '../../scripts/check-invariants.mjs';
import { verificarEstructura } from '../../scripts/check-structure.mjs';
import { urlDeVerificacion } from '../../scripts/verification-db.mjs';
import { sembrarFixtures } from '../../scripts/fixtures-invariantes.mjs';
import { connect, hasDatabase, type Client } from './helpers/db.js';
import { sufijoUnico } from './helpers/identificadores.js';

const suite = hasDatabase ? describe : describe.skip;

/**
 * Un cliente de mentira que contesta lo que se le diga.
 *
 * La clasificación depende de dos números —cuántas filas hay en el universo y
 * cuántas violan— y de una declaración del invariante. Probarla con datos reales
 * obligaría a fabricar cada combinación en la base; con esto se prueban las
 * cuatro en cuatro líneas, y las combinaciones imposibles de fabricar —una
 * violación con universo cero— también.
 */
function clienteFalso(respuestas: { universo: number; violaciones: string[] }) {
  return {
    query: async (sql: string) => {
      if (/count\(\*\)/.test(sql)) return { rows: [{ n: respuestas.universo }] };
      return { rows: respuestas.violaciones.map((detalle) => ({ violacion: 'x', detalle })) };
    },
  };
}

const UNO = [{ id: 'X-1', enunciado: 'de prueba', universo: 'SELECT count(*) AS n', sql: 'SELECT 1' }];
const UNO_EXIGE = [{ ...UNO[0]!, ejercicio: 'REQUERIDO' as const }];
const UNO_PERMITE = [{ ...UNO[0]!, vacuoPermitido: 'no se puede ejercitar todavía' }];

async function estadoDe(lista: unknown[], respuestas: { universo: number; violaciones: string[] }) {
  const r = await evaluarInvariantes(clienteFalso(respuestas), lista);
  return r[0];
}

describe('la clasificación en cuatro estados', () => {
  it('con casos y sin violaciones → VERIFIED', async () => {
    const r = await estadoDe(UNO_EXIGE, { universo: 7, violaciones: [] });
    expect(r.estado).toBe('VERIFIED');
    expect(r.casos).toBe(7);
    expect(r.violaciones).toBe(0);
  });

  it('con violaciones → VIOLATED, y trae los ejemplos', async () => {
    const r = await estadoDe(UNO_EXIGE, { universo: 7, violaciones: ['GENERAL #3', 'GENERAL #9'] });
    expect(r.estado).toBe('VIOLATED');
    expect(r.violaciones).toBe(2);
    expect(r.ejemplos).toEqual(['GENERAL #3', 'GENERAL #9']);
  });

  it('sin casos y exigiendo ejercicio → NOT_EXERCISED, nunca VERIFIED', async () => {
    // El corazón del asunto. Antes esto se llamaba VACUO y no contaba.
    const r = await estadoDe(UNO_EXIGE, { universo: 0, violaciones: [] });
    expect(r.estado).toBe('NOT_EXERCISED');
    expect(r.estado).not.toBe('VERIFIED');
  });

  it('sin casos y con motivo declarado → VACUO_PERMITIDO, con el motivo a la vista', async () => {
    const r = await estadoDe(UNO_PERMITE, { universo: 0, violaciones: [] });
    expect(r.estado).toBe('VACUO_PERMITIDO');
    expect(r.motivoVacuo).toBe('no se puede ejercitar todavía');
  });

  it('dos evaluaciones sobre los mismos datos dan exactamente lo mismo', async () => {
    // Idempotencia del gate, aislada de la base: mismos conteos, mismo estado,
    // mismos ejemplos. Sobre PostgreSQL compartido esto no se puede afirmar
    // —otras suites escriben en paralelo—, y afirmarlo igual sería tener un test
    // intermitente que cada tanto acusa un problema que no existe.
    const datos = { universo: 4, violaciones: ['uno', 'otro'] };
    const primera = await evaluarInvariantes(clienteFalso(datos), UNO_EXIGE);
    const segunda = await evaluarInvariantes(clienteFalso(datos), UNO_EXIGE);
    expect(segunda).toEqual(primera);
  });

  it('una violación manda aunque el universo diga cero', async () => {
    // Si las dos consultas discrepan, el problema es el invariante. Taparlo con
    // VACUO escondería justamente el caso que hay que mirar.
    const r = await estadoDe(UNO_PERMITE, { universo: 0, violaciones: ['algo roto'] });
    expect(r.estado).toBe('VIOLATED');
  });
});

describe('el código de salida', () => {
  const resumen = (parcial: Partial<ReturnType<typeof resumir>>) => ({
    verificados: 0, violados: 0, noEjercitados: 0, vacuosPermitidos: 0, total: 1, ...parcial,
  });

  it('una violación corta el build en los dos modos', () => {
    expect(codigoDeSalida(resumen({ violados: 1 }), { conductual: true })).toBe(1);
    expect(codigoDeSalida(resumen({ violados: 1 }), { conductual: false })).toBe(1);
  });

  it('NOT_EXERCISED corta en modo conductual', () => {
    // Ahí el fixture prometió producir casos y no lo hizo: la propiedad quedó
    // sin probar, y darla por buena es el falso verde otra vez.
    expect(codigoDeSalida(resumen({ noEjercitados: 1 }), { conductual: true })).toBe(1);
  });

  it('NOT_EXERCISED no corta en modo observacional', () => {
    // Que una base real no tenga cierres no es un defecto de la base.
    expect(codigoDeSalida(resumen({ noEjercitados: 1 }), { conductual: false })).toBe(0);
  });

  it('VACUO_PERMITIDO nunca corta, y VERIFIED tampoco', () => {
    expect(codigoDeSalida(resumen({ vacuosPermitidos: 3, verificados: 11 }), { conductual: true })).toBe(0);
  });
});

describe('el catálogo de invariantes', () => {
  it('cada uno declara exactamente una política: o exige ejercicio o explica por qué no puede', () => {
    // Es lo que impide que VACUO vuelva a ser una etiqueta gratis. Un invariante
    // nuevo que se olvide de declarar cae en NOT_EXERCISED y corta el build.
    for (const inv of INVARIANTES) {
      const exige = inv.ejercicio === 'REQUERIDO';
      const permite = typeof inv.vacuoPermitido === 'string' && inv.vacuoPermitido.length > 20;
      expect([inv.id, exige !== permite]).toEqual([inv.id, true]);
    }
  });

  it('los catorce siguen ahí', () => {
    expect(INVARIANTES.map((i) => i.id)).toEqual(
      Array.from({ length: 14 }, (_, n) => `A-${n + 1}`),
    );
  });
});

suite('el gate contra PostgreSQL real', () => {
  let db: Client;
  let empresa: string;
  let ejercicio: string;
  let aperturaHuerfana: string;

  beforeAll(async () => {
    db = await connect();
    const stamp = await sufijoUnico(db);

    // Una empresa propia con su ejercicio. Las consultas de los invariantes son
    // globales, así que lo que se fabrique acá tiene que poder señalarse por su
    // id: si el test afirmara sobre conteos totales, cualquier otra suite lo
    // volvería intermitente.
    const org = await db.query<{ id: string }>(
      `INSERT INTO organizations (name, tax_id) VALUES ($1,$2) RETURNING id`,
      [`Estudio gate ${stamp}`, `30${stamp}9`],
    );
    const co = await db.query<{ id: string }>(
      `INSERT INTO companies (organization_id, legal_name, cuit, entity_type, jurisdiction, regulator, fiscal_year_end)
       VALUES ($1,$2,$3,'SRL','AR-C','IGJ','12-31') RETURNING id`,
      [org.rows[0]!.id, `Empresa gate ${stamp}`, `33${stamp}1`],
    );
    empresa = co.rows[0]!.id;

    const chart = await db.query<{ id: string }>(
      `INSERT INTO account_charts (company_id, name) VALUES ($1,'Plan gate') RETURNING id`,
      [empresa],
    );
    const cuenta = async (code: string, tipo: string, nature: string): Promise<string> => {
      const r = await db.query<{ id: string }>(
        `INSERT INTO accounts (company_id, chart_id, code, name, type, nature)
         VALUES ($1,$2,$3,$3,$4,$5) RETURNING id`,
        [empresa, chart.rows[0]!.id, code, tipo, nature],
      );
      return r.rows[0]!.id;
    };
    const caja = await cuenta('1.1.01', 'ACTIVO', 'DEUDORA');
    const capital = await cuenta('3.1.01', 'PN', 'ACREEDORA');

    const fy = await db.query<{ id: string }>(
      `INSERT INTO fiscal_years (company_id, code, start_date, end_date)
       VALUES ($1,$2,'2030-01-01','2030-12-31') RETURNING id`,
      [empresa, `EJ2030-GATE-${stamp}`],
    );
    ejercicio = fy.rows[0]!.id;
    const periodo = await db.query<{ id: string }>(
      `INSERT INTO periods (company_id, fiscal_year_id, number, start_date, end_date)
       VALUES ($1,$2,1,'2030-01-01','2030-01-31') RETURNING id`,
      [empresa, ejercicio],
    );

    // La violación fabricada: una APERTURA sin cierre que la origine. Es lo que
    // A-13 existe para encontrar — un patrimonio que aparece sin venir de ningún
    // lado, en un asiento que cuadra perfectamente.
    //
    // Va con COMMIT real: el `CONSTRAINT TRIGGER` del Debe = Haber solo dispara
    // ahí, así que un fixture envuelto en ROLLBACK dejaría el candado sin
    // ejercitar y este test pasaría sin probar nada.
    await db.query('BEGIN');
    const cabecera = await db.query<{ id: string }>(
      `INSERT INTO journal_entries
         (company_id, journal_code, period_id, fiscal_year_id, entry_number, entry_date,
          description, kind, status, total_debit, total_credit, source_type,
          manual_justification, created_by, approved_by, approved_at)
       VALUES ($1,'APERTURA',$2,$3, next_entry_number($1,'APERTURA',$3), '2030-01-01',
               'Apertura sin cierre detrás','APERTURA','APROBADO',900,900,'CLOSING',
               'Fabricada para probar que el gate la encuentra','tester','tester',now())
       RETURNING id`,
      [empresa, periodo.rows[0]!.id, ejercicio],
    );
    aperturaHuerfana = cabecera.rows[0]!.id;
    await db.query(
      `INSERT INTO journal_entry_lines (company_id, entry_id, line_no, account_id, debit, credit)
       VALUES ($1,$2,1,$3,900,0), ($1,$2,2,$4,0,900)`,
      [empresa, aperturaHuerfana, caja, capital],
    );
    await db.query('COMMIT');
  });

  afterAll(async () => {
    await db?.end();
  });

  it('una violación real hace que el gate falle', async () => {
    const resultados = await evaluarInvariantes(db, INVARIANTES);
    const a13 = resultados.find((r) => r.id === 'A-13')!;

    expect(a13.estado).toBe('VIOLATED');
    expect(a13.violaciones).toBeGreaterThan(0);
    expect(codigoDeSalida(resumir(resultados), { conductual: true })).toBe(1);
    expect(codigoDeSalida(resumir(resultados), { conductual: false })).toBe(1);
  });

  it('la señala por su asiento, no con un contador', async () => {
    const violaciones = await db.query<{ violacion: string }>(
      INVARIANTES.find((i) => i.id === 'A-13')!.sql,
    );
    expect(violaciones.rows.map((v) => v.violacion)).toContain(aperturaHuerfana);
  });

  it('dos corridas consecutivas ven la misma violación', async () => {
    // La idempotencia exacta se prueba con el cliente controlado, más arriba.
    // Acá no se pueden comparar los conteos: la base de tests la comparten todas
    // las suites, que corren en paralelo, y una fila que entra entre las dos
    // llamadas haría intermitente al test sin que nada esté mal.
    //
    // Lo que sí es estable es que una violación fabricada siga estando: el gate
    // no la ve una vez sí y otra no.
    const primera = await evaluarInvariantes(db, INVARIANTES);
    const segunda = await evaluarInvariantes(db, INVARIANTES);
    expect(primera.find((r) => r.id === 'A-13')!.estado).toBe('VIOLATED');
    expect(segunda.find((r) => r.id === 'A-13')!.estado).toBe('VIOLATED');
    expect(codigoDeSalida(resumir(segunda), { conductual: true })).toBe(1);
  });

  it('los invariantes de cierre no atribuyen a una empresa lo de otra', async () => {
    // La base de tests tiene varias empresas, unas con el ejercicio cerrado y
    // otras abiertas. A-11, A-12 y A-14 tienen que seguir verdes: si alguno
    // comparara estados sin acotar por empresa, esta mezcla lo rompería.
    const resultados = await evaluarInvariantes(db, INVARIANTES);
    for (const id of ['A-11', 'A-12', 'A-14']) {
      const r = resultados.find((x) => x.id === id)!;
      expect([id, r.estado]).toEqual([id, 'VERIFIED']);
    }

    const empresas = await db.query<{ n: string }>(
      `SELECT count(DISTINCT company_id)::text AS n FROM accounting_closures WHERE status = 'COMPLETADO'`,
    );
    expect(Number(empresas.rows[0]!.n)).toBeGreaterThan(1);
  });

  it('la verificación estructural pasa sin depender de ningún dato', async () => {
    const hallazgos = await verificarEstructura(db);
    expect(hallazgos.filter((h) => !h.ok)).toEqual([]);
    expect(hallazgos.length).toBeGreaterThan(50);
  });
});

describe('los fixtures no pueden tocar la base de desarrollo', () => {
  it('la base de verificación es otra, y su nombre lo dice', () => {
    const url = urlDeVerificacion({ DATABASE_URL: 'postgres://u:p@h:5432/aai' });
    expect(url.endsWith('/aai_verify')).toBe(true);
  });

  it('no acumula sufijos si ya se le pasa una base derivada', () => {
    expect(urlDeVerificacion({ DATABASE_URL: 'postgres://u:p@h:5432/aai_test' })).toMatch(
      /\/aai_verify$/,
    );
  });

  it('sembrar sobre una base que no termina en _verify se niega', async () => {
    // El candado que impide que un `VERIFY_DATABASE_URL` mal puesto ensucie la
    // base de alguien. Los fixtures escriben filas que después no se pueden
    // borrar: los `forbid_delete` están puestos justamente para eso.
    await expect(sembrarFixtures('postgres://u:p@h:5432/aai')).rejects.toThrow(/_verify/);
  });
});
