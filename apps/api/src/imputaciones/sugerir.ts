/**
 * Propone imputaciones. **No imputa.**
 *
 * Imputar a mano es el cuello de botella real de la cuenta corriente: una
 * empresa con cien cobros por mes tiene cien decisiones tediosas y casi todas
 * obvias. ADR-015 §7 dejó anotado que proponer y que una persona confirme es la
 * forma admitida, y no estaba hecha.
 *
 * ## La decisión que gobierna todo el archivo
 *
 * **El importe exacto es una precondición, no un componente del puntaje.**
 *
 * Es la misma que toma el motor de conciliación bancaria, y por el mismo
 * motivo. Un cobro de $ 300 contra una factura de $ 900 «encaja» —entra— pero
 * proponerlo sería elegir esa factura entre todas las que también admiten
 * $ 300. Eso no es una sugerencia: es una suposición sobre qué se pagó, que es
 * exactamente lo que ADR-015 §7 prohíbe.
 *
 * Entonces: un pago parcial **no produce propuesta**. Produce una línea en
 * `sinPropuesta` que dice por qué, y la persona lo imputa a mano. Es menos
 * cómodo y es lo único honesto.
 *
 * ## El empate no se rompe
 *
 * Un cliente que debe tres facturas de $ 1.000 y paga $ 1.000 tiene tres
 * candidatos igual de exactos. La convención de la más vieja primero existe y
 * es una convención — no un hecho — y aplicarla en silencio haría que el
 * sistema afirme algo que nadie decidió.
 *
 * Esos casos van a `ambiguas`, con **todos** los candidatos y sin ordenarlos por
 * un criterio inventado. La persona elige. La antigüedad viaja como señal
 * visible, no como desempate aplicado.
 *
 * ## Qué NO hace
 *
 * - No guarda nada. Se puede volver a pedir cuantas veces haga falta.
 * - No agrupa cobros. Que dos cobros juntos cancelen una factura es plausible y
 *   abre el mismo espacio combinatorio que el motor bancario tuvo que acotar;
 *   sin necesidad demostrada, no se hace.
 * - No usa ningún modelo. Es aritmética sobre hechos, igual que las señales
 *   (ADR-017).
 */

/** Un movimiento del Mayor con saldo sin imputar. */
export interface MovimientoDisponible {
  readonly lineaId: string;
  readonly fecha: string;
  readonly disponible: string;
  readonly numeroAsiento: number;
}

/** Algo que se puede cancelar: un comprobante entero o una de sus cuotas. */
export interface PendienteImputable {
  readonly taxTransactionId: string;
  /** `null` cuando el comprobante no tiene plan de cuotas. */
  readonly installmentId: string | null;
  readonly etiqueta: string;
  readonly pendiente: string;
  readonly fecha: string;
  /** `null` si nadie declaró plazo ni plan: entonces no se afirma mora. */
  readonly diasDeMora: number | null;
}

export interface SenalDeImputacion {
  readonly clave: string;
  readonly detalle: string;
}

export interface PropuestaImputacion {
  readonly lineaId: string;
  readonly taxTransactionId: string;
  readonly installmentId: string | null;
  readonly etiqueta: string;
  readonly importe: string;
  readonly score: number;
  readonly senales: readonly SenalDeImputacion[];
}

export interface ImputacionAmbigua {
  readonly lineaId: string;
  readonly candidatos: readonly PropuestaImputacion[];
  readonly motivo: string;
}

export interface MovimientoSinPropuesta {
  readonly lineaId: string;
  readonly motivo: string;
}

export interface Sugerencias {
  readonly propuestas: readonly PropuestaImputacion[];
  readonly ambiguas: readonly ImputacionAmbigua[];
  readonly sinPropuesta: readonly MovimientoSinPropuesta[];
}

/**
 * Pesos del puntaje. Enteros, y suman 100 con el importe adentro.
 *
 * El importe vale 60 aunque sea precondición: el puntaje se le muestra a una
 * persona, y un 40 sobre 40 se lee peor que un 100 sobre 100 para el mismo
 * caso. Es la misma decisión —y la misma explicación— que en el motor bancario.
 *
 * Ninguno de estos números afirma nada sobre el mundo: son un criterio de
 * **orden** entre candidatos que ya coinciden en importe. Por eso el puntaje
 * viaja siempre con sus señales, que sí son hechos.
 */
const PESOS = {
  importe: 60,
  posterior: 15,
  cerca: 15,
  vencida: 10,
} as const;

/** Cuántos días después del comprobante siguen leyéndose como «este cobro». */
const VENTANA_DIAS = 45;

/** Compara importes decimales sin pasar por punto flotante. */
function mismoImporte(a: string, b: string): boolean {
  return centavos(a) === centavos(b);
}

/**
 * Un decimal a centavos enteros.
 *
 * `Number(a) * 100` daría 30099.999999999996 para «300.99». Acá la plata se
 * compara por igualdad, así que un centavo de deriva cambia el resultado.
 */
function centavos(valor: string): number {
  const [entera, decimal = ''] = valor.trim().split('.');
  const relleno = (decimal + '00').slice(0, 2);
  const signo = entera!.startsWith('-') ? -1 : 1;
  return signo * (Math.abs(Number(entera)) * 100 + Number(relleno));
}

function diasEntre(desde: string, hasta: string): number {
  const a = Date.parse(`${desde}T00:00:00Z`);
  const b = Date.parse(`${hasta}T00:00:00Z`);
  return Math.round((b - a) / 86_400_000);
}

/**
 * Arma las propuestas.
 *
 * Función pura: recibe los hechos y devuelve el resultado. No toca la base, no
 * escribe nada y se puede ejercitar sin PostgreSQL — que es lo que permite
 * probar el empate de tres facturas iguales sin montar tres facturas iguales.
 */
export function sugerirImputaciones(
  movimientos: readonly MovimientoDisponible[],
  pendientes: readonly PendienteImputable[],
): Sugerencias {
  const propuestas: PropuestaImputacion[] = [];
  const ambiguas: ImputacionAmbigua[] = [];
  const sinPropuesta: MovimientoSinPropuesta[] = [];

  // Lo ya propuesto no se vuelve a ofrecer: dos movimientos distintos no pueden
  // cancelar el mismo pendiente sin que la suma se pase.
  const tomados = new Set<string>();

  for (const mov of movimientos) {
    const clave = (p: PendienteImputable): string =>
      p.installmentId ?? p.taxTransactionId;

    const exactos = pendientes.filter(
      (p) => !tomados.has(clave(p)) && mismoImporte(p.pendiente, mov.disponible),
    );

    if (exactos.length === 0) {
      const alcanza = pendientes.some(
        (p) => !tomados.has(clave(p)) && centavos(p.pendiente) > centavos(mov.disponible),
      );
      sinPropuesta.push({
        lineaId: mov.lineaId,
        motivo: alcanza
          ? 'El importe no coincide exactamente con ningún pendiente. Entra en varios como ' +
            'pago parcial, y elegir uno sería suponer qué se pagó: imputalo a mano.'
          : 'No hay ningún pendiente que este movimiento cancele por su importe exacto.',
      });
      continue;
    }

    const candidatos = exactos.map((p) => armar(mov, p));

    if (candidatos.length > 1) {
      ambiguas.push({
        lineaId: mov.lineaId,
        candidatos,
        motivo:
          `Hay ${String(candidatos.length)} pendientes por exactamente este importe. ` +
          'La convención de cancelar la más vieja primero es una convención, no un hecho: ' +
          'el sistema no la aplica sola porque cambia qué se reclama después.',
      });
      continue;
    }

    const unica = candidatos[0]!;
    tomados.add(unica.installmentId ?? unica.taxTransactionId);
    propuestas.push(unica);
  }

  // Mayor puntaje primero: es lo que se confirma sin mirar dos veces.
  return {
    propuestas: [...propuestas].sort((a, b) => b.score - a.score),
    ambiguas,
    sinPropuesta,
  };
}

function armar(mov: MovimientoDisponible, p: PendienteImputable): PropuestaImputacion {
  const senales: SenalDeImputacion[] = [
    { clave: 'IMPORTE_EXACTO', detalle: `El movimiento y el pendiente son ${p.pendiente}.` },
  ];
  let score = PESOS.importe;

  const dias = diasEntre(p.fecha, mov.fecha);
  if (dias >= 0) {
    score += PESOS.posterior;
    senales.push({
      clave: 'POSTERIOR_AL_COMPROBANTE',
      detalle: `El cobro es ${String(dias)} día(s) posterior al comprobante.`,
    });
    if (dias <= VENTANA_DIAS) {
      score += PESOS.cerca;
      senales.push({
        clave: 'DENTRO_DE_VENTANA',
        detalle: `Dentro de los ${String(VENTANA_DIAS)} días siguientes al comprobante.`,
      });
    }
  } else {
    // No descalifica: un anticipo es un cobro anterior a la factura y existe.
    senales.push({
      clave: 'ANTERIOR_AL_COMPROBANTE',
      detalle: `El cobro es ${String(-dias)} día(s) anterior al comprobante.`,
    });
  }

  if (p.diasDeMora !== null && p.diasDeMora > 0) {
    score += PESOS.vencida;
    senales.push({
      clave: 'PENDIENTE_VENCIDO',
      detalle: `Lleva ${String(p.diasDeMora)} día(s) de mora declarada.`,
    });
  }

  return {
    lineaId: mov.lineaId,
    taxTransactionId: p.taxTransactionId,
    installmentId: p.installmentId,
    etiqueta: p.etiqueta,
    importe: p.pendiente,
    score,
    senales,
  };
}
