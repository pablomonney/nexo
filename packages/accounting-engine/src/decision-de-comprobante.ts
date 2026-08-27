/**
 * De un comprobante a una decisión contable — o a la razón por la que no la hay.
 *
 * Es el paso que faltaba entre "el sistema leyó un papel" y "el sistema propone
 * un asiento". No decide contabilidad por su cuenta: junta lo que cada capa
 * averiguó, comprueba que alcance, y **cuando no alcanza lo dice con el nombre
 * de lo que falta**.
 *
 * ## Ningún hecho entra sin decir de dónde salió
 *
 * `HechoConOrigen` no es documentación: es la forma del dato. Un hecho sin
 * origen no se puede construir. La distinción importa porque los tres tipos
 * tienen fuerza probatoria distinta y el §11 exige no confundirlos:
 *
 *   · `DOCUMENTAL`  — lo que el papel dice. Lo extrae el motor documental.
 *   · `TRIBUTARIO`  — lo que un organismo confirma. Sale de ARCA.
 *   · `PROFESIONAL` — lo que declara quien conoce la operación. No se calcula.
 *
 * Que el total sea 34.382,52 y que la operación se vincule con gravadas son las
 * dos cosas más distintas del sistema, y en un `Record<string, unknown>` se ven
 * igual.
 *
 * ## Nunca devuelve un booleano pelado
 *
 * La salida siempre trae motivo, hechos con su origen, normativa consultada y
 * qué pasó con cada regla. Una decisión contable que no se puede explicar ante
 * un tercero no sirve, aunque sea correcta.
 */

import type { Money } from '@aai/shared';

// ---------------------------------------------------------------------------
// Hechos
// ---------------------------------------------------------------------------

export type OrigenDeHecho = 'DOCUMENTAL' | 'TRIBUTARIO' | 'PROFESIONAL';

export interface HechoConOrigen {
  readonly campo: string;
  readonly valor: string | number | boolean | null;
  readonly origen: OrigenDeHecho;
  /** Quién o qué lo afirma. Un CUIT extraído y uno confirmado no son lo mismo. */
  readonly fuente: string;
}

export interface ComprobanteNormalizado {
  readonly taxTransactionId: string;
  readonly documentId: string | null;
  readonly companyId: string;
  readonly direccion: 'COMPRAS' | 'VENTAS';
  readonly cuitContraparte: string;
  readonly razonSocial: string | null;
  readonly cbteTipo: number;
  readonly letra: string | null;
  readonly puntoVenta: number;
  readonly numero: number;
  readonly fecha: string;
  readonly moneda: string;
  readonly neto: Money;
  readonly iva: Money;
  readonly total: Money;
  readonly cae: string | null;
  readonly caeVencimiento: string | null;
}

// ---------------------------------------------------------------------------
// Lo que aportan las otras capas
// ---------------------------------------------------------------------------

/** Resultado de la constatación en ARCA, o por qué no se pudo. */
export interface SelloFiscal {
  readonly estado: 'APROBADO' | 'RECHAZADO' | 'NO_VERIFICABLE';
  readonly motivo: string | null;
}

/** Qué pasó con una regla que se consultó. Incluye las que NO se aplicaron. */
export interface ResultadoDeRegla {
  readonly ruleKey: string;
  readonly version: number | null;
  readonly estado: 'APLICADA' | 'NO_APLICA' | 'DESCARTADA' | 'SIN_FUENTE';
  readonly motivo: string;
  readonly cita: ReferenciaNormativa | null;
}

export interface ReferenciaNormativa {
  readonly organismo: string;
  readonly norma: string;
  readonly articulo: string;
  readonly inciso: string | null;
  readonly documentoSha256: string;
}

export type MotivoDeRevision =
  | 'SIN_HECHO_REQUERIDO'
  | 'SIN_REGLA_APLICABLE'
  | 'REGLA_NO_ACTIVA'
  | 'CONFLICTO_NORMATIVO'
  | 'SELLO_FISCAL_NO_APROBADO'
  | 'REQUIERE_PRORRATEO';

export interface Revision {
  readonly motivo: MotivoDeRevision;
  readonly detalle: string;
}

// ---------------------------------------------------------------------------
// La propuesta
// ---------------------------------------------------------------------------

export interface LineaPropuesta {
  readonly accountCode: string;
  readonly debit: Money;
  readonly credit: Money;
  readonly descripcion: string;
}

/**
 * Una propuesta **no es** un asiento.
 *
 * No tiene número, no está en ningún libro y no afecta ningún saldo. Existe para
 * que una persona la mire. La separación es la que pide el §32 y la que evita
 * que "el sistema propuso" y "el sistema registró" se confundan.
 */
export interface PropuestaDeAsiento {
  readonly fecha: string;
  readonly descripcion: string;
  readonly lineas: readonly LineaPropuesta[];
  readonly origen: {
    readonly taxTransactionId: string;
    readonly documentId: string | null;
    readonly reglaAplicada: string | null;
    readonly reglaVersion: number | null;
    readonly documentoSha256: string | null;
    readonly propuestaPor: string;
  };
}

export interface DecisionContable {
  readonly estado: 'PROPUESTA_DE_ASIENTO' | 'REQUIERE_REVISION';
  readonly revisiones: readonly Revision[];
  readonly hechos: readonly HechoConOrigen[];
  readonly normativa: readonly ReferenciaNormativa[];
  readonly reglas: readonly ResultadoDeRegla[];
  readonly propuesta: PropuestaDeAsiento | null;
}

export interface EntradaDeDecision {
  readonly comprobante: ComprobanteNormalizado;
  readonly sello: SelloFiscal;
  /** Hechos profesionales ya resueltos, con su origen. Nunca los calcula este módulo. */
  readonly hechosProfesionales: readonly HechoConOrigen[];
  /** Lo que el motor normativo contestó, incluidas las reglas que descartó. */
  readonly reglas: readonly ResultadoDeRegla[];
  /** Motivos de revisión que las capas de arriba ya detectaron. */
  readonly revisionesPrevias: readonly Revision[];
}

// ---------------------------------------------------------------------------
// La decisión
// ---------------------------------------------------------------------------

/** Los hechos que el propio comprobante prueba, con su origen marcado. */
export function hechosDocumentales(c: ComprobanteNormalizado): readonly HechoConOrigen[] {
  const d = (campo: string, valor: string | number | boolean | null): HechoConOrigen => ({
    campo,
    valor,
    origen: 'DOCUMENTAL',
    fuente: 'comprobante normalizado',
  });
  return [
    d('comprobante.tipo', c.cbteTipo),
    d('comprobante.letra', c.letra),
    d('comprobante.puntoVenta', c.puntoVenta),
    d('comprobante.numero', c.numero),
    d('comprobante.fecha', c.fecha),
    d('comprobante.moneda', c.moneda),
    d('contraparte.cuit', c.cuitContraparte),
    d('importes.neto', c.neto.amount.toString()),
    d('importes.iva', c.iva.amount.toString()),
    d('importes.total', c.total.amount.toString()),
  ];
}

/** Los hechos que confirma el organismo. Separados a propósito de los de arriba. */
export function hechosTributarios(
  c: ComprobanteNormalizado,
  sello: SelloFiscal,
): readonly HechoConOrigen[] {
  const hechos: HechoConOrigen[] = [
    {
      campo: 'comprobante.selloFiscal',
      valor: sello.estado,
      origen: 'TRIBUTARIO',
      fuente: 'ARCA — constatación de comprobantes',
    },
  ];
  if (c.cae !== null) {
    hechos.push({
      campo: 'comprobante.cae',
      valor: c.cae,
      origen: 'TRIBUTARIO',
      fuente: 'ARCA — CAE emitido',
    });
  }
  return hechos;
}

/**
 * Junta todo y decide.
 *
 * La regla de corte es una sola: **se propone un asiento solo si ninguna capa
 * dejó un motivo de revisión y alguna regla se aplicó**. No hay un camino
 * "igual proponemos algo": sin regla aplicada no hay fundamento normativo, y una
 * propuesta sin fundamento es una sugerencia por costumbre disfrazada de
 * contabilidad.
 */
export function decidir(
  entrada: EntradaDeDecision,
  armarLineas: (c: ComprobanteNormalizado) => readonly LineaPropuesta[],
  propuestaPor: string,
): DecisionContable {
  const { comprobante, sello, reglas } = entrada;

  const hechos = [
    ...hechosDocumentales(comprobante),
    ...hechosTributarios(comprobante, sello),
    ...entrada.hechosProfesionales,
  ];

  const revisiones: Revision[] = [...entrada.revisionesPrevias];

  if (sello.estado !== 'APROBADO') {
    revisiones.push({
      motivo: 'SELLO_FISCAL_NO_APROBADO',
      detalle:
        `La constatación fiscal está en ${sello.estado}` +
        (sello.motivo === null ? '' : ` (${sello.motivo})`) +
        '. Un comprobante sin sello aprobado no funda un asiento.',
    });
  }

  const aplicadas = reglas.filter((r) => r.estado === 'APLICADA');
  const descartadasPorEstado = reglas.filter(
    (r) => r.estado === 'DESCARTADA' && /estado (DRAFT|IN_REVIEW|SUPERSEDED)/.test(r.motivo),
  );

  if (aplicadas.length === 0) {
    revisiones.push(
      descartadasPorEstado.length > 0
        ? {
            motivo: 'REGLA_NO_ACTIVA',
            detalle:
              `Hay ${descartadasPorEstado.length} regla(s) que cubrirían el caso pero no están ` +
              `activas: ${descartadasPorEstado.map((r) => r.ruleKey).join(', ')}. ` +
              'Una regla en DRAFT no resuelve: activarla exige la aprobación del §32.',
          }
        : {
            motivo: 'SIN_REGLA_APLICABLE',
            detalle:
              'El motor normativo no encontró ninguna regla vigente que resuelva este caso. ' +
              'No es un error: es que la norma que lo funda todavía no está cargada.',
          },
    );
  }

  const normativa = reglas
    .map((r) => r.cita)
    .filter((c): c is ReferenciaNormativa => c !== null);

  if (revisiones.length > 0) {
    return {
      estado: 'REQUIERE_REVISION',
      revisiones,
      hechos,
      normativa,
      reglas,
      // Sin propuesta. Devolver una "por las dudas" invitaría a aprobarla sin
      // leer el motivo, que es exactamente lo que la revisión quiere evitar.
      propuesta: null,
    };
  }

  const regla = aplicadas[0]!;
  return {
    estado: 'PROPUESTA_DE_ASIENTO',
    revisiones: [],
    hechos,
    normativa,
    reglas,
    propuesta: {
      fecha: comprobante.fecha,
      descripcion: `${comprobante.razonSocial ?? comprobante.cuitContraparte} — ${comprobante.letra ?? ''}${comprobante.puntoVenta}-${comprobante.numero}`,
      lineas: armarLineas(comprobante),
      origen: {
        taxTransactionId: comprobante.taxTransactionId,
        documentId: comprobante.documentId,
        reglaAplicada: regla.ruleKey,
        reglaVersion: regla.version,
        documentoSha256: regla.cita?.documentoSha256 ?? null,
        propuestaPor,
      },
    },
  };
}

/** Render legible de una decisión. Es la salida que mira una persona. */
export function explicarDecision(decision: DecisionContable): string {
  const lineas: string[] = [`DECISIÓN: ${decision.estado}`, ''];

  if (decision.revisiones.length > 0) {
    lineas.push('MOTIVO:');
    for (const r of decision.revisiones) lineas.push(`  [${r.motivo}] ${r.detalle}`);
    lineas.push('');
  }

  lineas.push('HECHOS:');
  for (const origen of ['DOCUMENTAL', 'TRIBUTARIO', 'PROFESIONAL'] as const) {
    const delOrigen = decision.hechos.filter((h) => h.origen === origen);
    if (delOrigen.length === 0) {
      lineas.push(`  ${origen}: (ninguno)`);
      continue;
    }
    lineas.push(`  ${origen}:`);
    for (const h of delOrigen) lineas.push(`    ${h.campo} = ${String(h.valor)}  ← ${h.fuente}`);
  }
  lineas.push('');

  lineas.push('NORMATIVA CONSULTADA:');
  if (decision.normativa.length === 0) lineas.push('  (ninguna aportó cita)');
  for (const n of decision.normativa) {
    lineas.push(
      `  ${n.organismo} ${n.norma}, art. ${n.articulo}${n.inciso === null ? '' : ` inc. ${n.inciso}`}` +
        ` — sha256 ${n.documentoSha256.slice(0, 16)}…`,
    );
  }
  lineas.push('');

  lineas.push('REGLAS:');
  if (decision.reglas.length === 0) lineas.push('  (ninguna consultada)');
  for (const r of decision.reglas) {
    lineas.push(`  ${r.ruleKey}${r.version === null ? '' : ` v${r.version}`}: ${r.estado} — ${r.motivo}`);
  }

  if (decision.propuesta !== null) {
    lineas.push('', 'PROPUESTA DE ASIENTO (no es un asiento):');
    for (const l of decision.propuesta.lineas) {
      lineas.push(`  ${l.accountCode}  D ${l.debit.amount}  H ${l.credit.amount}  ${l.descripcion}`);
    }
  }

  return lineas.join('\n');
}
