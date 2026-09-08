/**
 * El motor de facturación: períodos, prorrateo, cobranza y estados.
 *
 * Lo que estos tests defienden no es que las funciones anden, es que **no
 * inventen plata ni la pierdan**. Un prorrateo que devuelve un centavo de más
 * se ve exactamente igual que uno correcto hasta que alguien concilia el mes.
 */

import { describe, expect, it } from 'vitest';
import { money, parseCalendarDate, toDecimalString, type Money } from '@aai/shared';
import {
  contiene,
  diasDe,
  esAtrasado,
  esRepeticion,
  interseccion,
  mesesDe,
  pasoPendiente,
  periodoDe,
  periodoSiguiente,
  planDeCobranza,
  proporcionDelPeriodo,
  prorratearPorDias,
  puedeTransicionar,
  puedeTransicionarPago,
  revisarPolitica,
  puedeTransicionarDocumento,
  type PoliticaDeCobranza,
} from './index.js';

const f = parseCalendarDate;
const pesos = (centavos: bigint): Money => money(centavos, 'ARS');
const suma = (ms: readonly Money[]): bigint => ms.reduce((a, m) => a + m.amount, 0n);

describe('períodos', () => {
  it('un mes del 1 al 31', () => {
    expect(periodoDe(f('2026-01-01'), 'MENSUAL')).toEqual({
      desde: '2026-01-01',
      hasta: '2026-01-31',
    });
  });

  it('un año del 1 de enero al 31 de diciembre', () => {
    expect(periodoDe(f('2026-01-01'), 'ANUAL')).toEqual({
      desde: '2026-01-01',
      hasta: '2026-12-31',
    });
  });

  it('el que arranca un 31 de enero termina el 27 de febrero, no el 2 de marzo', () => {
    // El caso que rompe la aritmética nativa de fechas: sin recortar al último
    // día del mes destino, quien contrata un 31 se saltea febrero entero y
    // aparece facturado dos veces en marzo.
    expect(periodoDe(f('2026-01-31'), 'MENSUAL')).toEqual({
      desde: '2026-01-31',
      hasta: '2026-02-27',
    });
  });

  it('el 29 de febrero de un bisiesto más un año es el 28', () => {
    expect(periodoDe(f('2028-02-29'), 'ANUAL').hasta).toBe('2029-02-27');
  });

  it('los períodos consecutivos no dejan hueco ni se superponen', () => {
    let p = periodoDe(f('2026-01-15'), 'MENSUAL');
    for (let i = 0; i < 24; i += 1) {
      const siguiente = periodoSiguiente(p, 'MENSUAL');
      // El día después del último es el primero del siguiente. Un hueco de un
      // día es un día de servicio que nadie factura; una superposición es un día
      // cobrado dos veces.
      expect(diasDe({ desde: p.hasta, hasta: siguiente.desde })).toBe(2);
      p = siguiente;
    }
  });

  it('el recorte no se recupera: quien empieza el 31 pasa a los 28', () => {
    const enero = periodoDe(f('2026-01-31'), 'MENSUAL');
    const febrero = periodoSiguiente(enero, 'MENSUAL');
    const marzo = periodoSiguiente(febrero, 'MENSUAL');
    expect(febrero.desde).toBe('2026-02-28');
    expect(marzo.desde).toBe('2026-03-28');
  });

  it('mesesDe y diasDe', () => {
    expect(mesesDe('MENSUAL')).toBe(1);
    expect(mesesDe('ANUAL')).toBe(12);
    expect(diasDe(periodoDe(f('2026-01-01'), 'MENSUAL'))).toBe(31);
    expect(diasDe(periodoDe(f('2026-02-01'), 'MENSUAL'))).toBe(28);
    expect(diasDe(periodoDe(f('2028-02-01'), 'MENSUAL'))).toBe(29);
  });

  it('contiene incluye los dos extremos', () => {
    const p = periodoDe(f('2026-01-01'), 'MENSUAL');
    expect(contiene(p, f('2026-01-01'))).toBe(true);
    expect(contiene(p, f('2026-01-31'))).toBe(true);
    expect(contiene(p, f('2026-02-01'))).toBe(false);
  });

  it('la intersección de dos tramos que no se tocan es null, no un período vacío', () => {
    const a = { desde: f('2026-01-01'), hasta: f('2026-01-10') };
    const b = { desde: f('2026-01-11'), hasta: f('2026-01-20') };
    expect(interseccion(a, b)).toBeNull();
    expect(interseccion(a, { desde: f('2026-01-05'), hasta: f('2026-01-20') })).toEqual({
      desde: '2026-01-05',
      hasta: '2026-01-10',
    });
  });
});

describe('prorrateo', () => {
  it('la suma de las partes es exactamente el importe: nunca sobra ni falta un centavo', () => {
    const enero = periodoDe(f('2026-01-01'), 'MENSUAL');
    // 31 días y un importe que no divide entero: el caso donde un cálculo por
    // partes redondeado a cada lado se lleva un centavo puesto.
    const total = pesos(100_00n);
    const partes = prorratearPorDias(total, enero, [
      { desde: f('2026-01-01'), hasta: f('2026-01-15') },
      { desde: f('2026-01-16'), hasta: f('2026-01-31') },
    ]);
    expect(suma(partes)).toBe(100_00n);
    expect(partes.map((p) => toDecimalString(p))).toEqual(['48.39', '51.61']);
  });

  it('la propiedad vale para cualquier corte del mes', () => {
    const enero = periodoDe(f('2026-01-01'), 'MENSUAL');
    const total = pesos(99_999n);
    for (let corte = 1; corte < 31; corte += 1) {
      const dia = String(corte).padStart(2, '0');
      const siguiente = String(corte + 1).padStart(2, '0');
      const partes = prorratearPorDias(total, enero, [
        { desde: f('2026-01-01'), hasta: f(`2026-01-${dia}`) },
        { desde: f(`2026-01-${siguiente}`), hasta: f('2026-01-31') },
      ]);
      expect(suma(partes), `corte el ${dia}`).toBe(99_999n);
    }
  });

  it('rechaza tramos que no cubren el período entero', () => {
    const enero = periodoDe(f('2026-01-01'), 'MENSUAL');
    // Prorratear sobre cobertura parcial daría un total que no es el del período
    // y se vería igual que uno correcto.
    expect(() =>
      prorratearPorDias(pesos(100_00n), enero, [
        { desde: f('2026-01-01'), hasta: f('2026-01-15') },
      ]),
    ).toThrow(/cubren 15 días y el período tiene 31/u);
  });

  it('rechaza un tramo de afuera del período', () => {
    const enero = periodoDe(f('2026-01-01'), 'MENSUAL');
    expect(() =>
      prorratearPorDias(pesos(100_00n), enero, [
        { desde: f('2026-02-01'), hasta: f('2026-02-28') },
      ]),
    ).toThrow(/no cae dentro del período/u);
  });

  it('rechaza una lista vacía de tramos', () => {
    expect(() => prorratearPorDias(pesos(1n), periodoDe(f('2026-01-01'), 'MENSUAL'), [])).toThrow(
      /al menos un tramo/u,
    );
  });

  it('el alta a mitad de mes cobra la parte usada', () => {
    const enero = periodoDe(f('2026-01-01'), 'MENSUAL');
    const desdeEl16 = { desde: f('2026-01-16'), hasta: f('2026-01-31') };
    expect(toDecimalString(proporcionDelPeriodo(pesos(100_00n), enero, desdeEl16))).toBe('51.61');
  });

  it('el alta el primer día cobra el período entero, sin pasar por el reparto', () => {
    const enero = periodoDe(f('2026-01-01'), 'MENSUAL');
    expect(proporcionDelPeriodo(pesos(100_00n), enero, enero).amount).toBe(100_00n);
  });

  it('el alta a mitad de mes y el cambio de plan a mitad de mes coinciden al centavo', () => {
    // Si estas dos cifras difirieran, un cliente que se da de alta el 16 pagaría
    // distinto que uno que cambia de plan el 16, por el mismo servicio.
    const enero = periodoDe(f('2026-01-01'), 'MENSUAL');
    const tramo = { desde: f('2026-01-16'), hasta: f('2026-01-31') };
    const porProporcion = proporcionDelPeriodo(pesos(77_777n), enero, tramo);
    const [, porReparto] = prorratearPorDias(pesos(77_777n), enero, [
      { desde: f('2026-01-01'), hasta: f('2026-01-15') },
      tramo,
    ]);
    expect(porProporcion.amount).toBe(porReparto!.amount);
  });

  it('un tramo que no toca el período es un error', () => {
    expect(() =>
      proporcionDelPeriodo(pesos(1n), periodoDe(f('2026-01-01'), 'MENSUAL'), {
        desde: f('2026-03-01'),
        hasta: f('2026-03-31'),
      }),
    ).toThrow(/no toca el período/u);
  });
});

describe('cobranza', () => {
  const politica: PoliticaDeCobranza = {
    reintentosEnDias: [3, 7],
    avisoEnDias: 10,
    diasDeGracia: 14,
  };

  it('el plan sale de la política, en orden', () => {
    const plan = planDeCobranza(f('2026-03-01'), politica);
    expect(plan).toEqual([
      { tipo: 'REINTENTO', el: '2026-03-04', numero: 1 },
      { tipo: 'REINTENTO', el: '2026-03-08', numero: 2 },
      { tipo: 'AVISO', el: '2026-03-11' },
      { tipo: 'SUSPENSION', el: '2026-03-15' },
    ]);
  });

  it('los reintentos son días desde el fallo, no desde el reintento anterior', () => {
    // Con offsets relativos, agregar un reintento en el medio correría todos los
    // siguientes y cambiaría el calendario de clientes que ya estaban en curso.
    const plan = planDeCobranza(f('2026-03-01'), {
      ...politica,
      reintentosEnDias: [3, 5, 7],
    });
    expect(plan.filter((p) => p.tipo === 'REINTENTO').map((p) => p.el)).toEqual([
      '2026-03-04',
      '2026-03-06',
      '2026-03-08',
    ]);
  });

  it('a igual fecha, primero se reintenta y después se avisa', () => {
    // Avisar de una suspensión que el reintento del mismo día va a evitar es
    // peor que no avisar.
    const plan = planDeCobranza(f('2026-03-01'), {
      reintentosEnDias: [5],
      avisoEnDias: 5,
      diasDeGracia: 9,
    });
    expect(plan.map((p) => p.tipo)).toEqual(['REINTENTO', 'AVISO', 'SUSPENSION']);
  });

  it('una política sin reintentos es válida: suspende y ya', () => {
    const plan = planDeCobranza(f('2026-03-01'), {
      reintentosEnDias: [],
      avisoEnDias: 0,
      diasDeGracia: 0,
    });
    expect(plan.map((p) => p.tipo)).toEqual(['AVISO', 'SUSPENSION']);
  });

  it('rechaza suspender antes del último reintento', () => {
    // Cobraría bien y el cliente seguiría afuera.
    expect(revisarPolitica({ reintentosEnDias: [3, 20], avisoEnDias: 5, diasDeGracia: 10 })).toContain(
      'GRACIA_ANTES_DEL_ULTIMO_REINTENTO',
    );
  });

  it('rechaza avisar después de suspender', () => {
    expect(revisarPolitica({ reintentosEnDias: [3], avisoEnDias: 20, diasDeGracia: 10 })).toContain(
      'AVISO_DESPUES_DE_LA_SUSPENSION',
    );
  });

  it('rechaza días negativos y reintentos desordenados', () => {
    expect(revisarPolitica({ reintentosEnDias: [-1], avisoEnDias: 1, diasDeGracia: 2 })).toContain(
      'DIAS_NEGATIVOS',
    );
    expect(revisarPolitica({ reintentosEnDias: [7, 3], avisoEnDias: 8, diasDeGracia: 9 })).toContain(
      'REINTENTOS_DESORDENADOS',
    );
  });

  it('informa todos los motivos juntos, no el primero', () => {
    // Quien declara la política tiene que poder arreglarla de una vez, no
    // descubrir el segundo problema después de corregir el primero.
    const motivos = revisarPolitica({
      reintentosEnDias: [-5, -9],
      avisoEnDias: 30,
      diasDeGracia: 1,
    });
    expect(motivos.length).toBeGreaterThan(1);
  });

  it('planDeCobranza se niega con una política inconsistente', () => {
    expect(() =>
      planDeCobranza(f('2026-03-01'), { reintentosEnDias: [30], avisoEnDias: 1, diasDeGracia: 2 }),
    ).toThrow(/inconsistente/u);
  });

  it('el ciclo que corre tarde ejecuta el paso más viejo, no el de hoy', () => {
    // Una máquina apagada un fin de semana largo deja tres pasos vencidos.
    // Saltar al último dejaría al cliente suspendido sin haber intentado
    // cobrarle.
    const plan = planDeCobranza(f('2026-03-01'), politica);
    const paso = pasoPendiente(plan, [], f('2026-03-20'));
    expect(paso).toEqual({ tipo: 'REINTENTO', el: '2026-03-04', numero: 1 });
  });

  it('no repite un paso ya hecho', () => {
    const plan = planDeCobranza(f('2026-03-01'), politica);
    const paso = pasoPendiente(plan, [{ tipo: 'REINTENTO', el: '2026-03-04', numero: 1 }], f('2026-03-20'));
    expect(paso?.numero).toBe(2);
  });

  it('no adelanta un paso futuro', () => {
    const plan = planDeCobranza(f('2026-03-01'), politica);
    expect(pasoPendiente(plan, [], f('2026-03-02'))).toBeNull();
  });
});

describe('estados', () => {
  it('de CANCELADA no se vuelve, a ningún lado', () => {
    // Reactivar dejaría un período sin cobertura que ningún documento explica.
    for (const destino of ['PRUEBA', 'ACTIVA', 'SUSPENDIDA', 'CANCELADA'] as const) {
      expect(puedeTransicionar('CANCELADA', destino), destino).toBe(false);
    }
  });

  it('de SUSPENDIDA sí se vuelve: se levanta pagando', () => {
    expect(puedeTransicionar('SUSPENDIDA', 'ACTIVA')).toBe(true);
  });

  it('de PRUEBA no se salta a SUSPENDIDA', () => {
    expect(puedeTransicionar('PRUEBA', 'SUSPENDIDA')).toBe(false);
  });

  it('un documento pagado no vuelve a ningún estado anterior', () => {
    // Volver atrás dejaría el pago cobrado apuntando a un documento impago.
    for (const destino of ['BORRADOR', 'EMITIDO', 'ANULADO', 'INCOBRABLE'] as const) {
      expect(puedeTransicionarDocumento('PAGADO', destino), destino).toBe(false);
    }
  });

  it('incobrable no es anulado: de uno se cobra después y del otro no', () => {
    // Anular dice «esto no debió emitirse»; incobrable dice «se emitió bien y no
    // se va a cobrar». Confundirlos borra la deuda en vez de reconocer la pérdida.
    expect(puedeTransicionarDocumento('INCOBRABLE', 'PAGADO')).toBe(true);
    expect(puedeTransicionarDocumento('ANULADO', 'PAGADO')).toBe(false);
  });

  it('un pago fallido es terminal: el reintento es un intento nuevo', () => {
    expect(puedeTransicionarPago('FALLIDO', 'PAGADO')).toBe(false);
  });

  it('un webhook repetido no es un error de integración', () => {
    expect(esRepeticion('PAGADO', 'PAGADO')).toBe(true);
    expect(esAtrasado('PAGADO', 'PAGADO')).toBe(false);
  });

  it('el AUTORIZADO que llega después del PAGADO está atrasado, no es inválido', () => {
    expect(esAtrasado('PAGADO', 'AUTORIZADO')).toBe(true);
    expect(esRepeticion('PAGADO', 'AUTORIZADO')).toBe(false);
    expect(puedeTransicionarPago('PAGADO', 'AUTORIZADO')).toBe(false);
  });

  it('un evento que no es ni repetido ni atrasado ni válido es un conflicto real', () => {
    // REEMBOLSADO sobre PENDIENTE: nunca se cobró. No se aplica en silencio.
    expect(esRepeticion('PENDIENTE', 'REEMBOLSADO')).toBe(false);
    expect(esAtrasado('PENDIENTE', 'REEMBOLSADO')).toBe(false);
    expect(puedeTransicionarPago('PENDIENTE', 'REEMBOLSADO')).toBe(false);
  });
});
