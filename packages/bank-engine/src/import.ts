/**
 * Importación de extractos bancarios.
 *
 * **No hay un formato de extracto en Argentina.** Cada banco exporta lo que
 * quiere: columnas distintas, fechas en dd/mm/aaaa o aaaa-mm-dd, importes con
 * coma o con punto, el signo en una columna aparte o dos columnas débito/crédito,
 * y el saldo a veces sí y a veces no.
 *
 * Frente a eso hay dos caminos. Uno es **adivinar**: mirar los encabezados,
 * probar formatos hasta que uno parsee, y quedarse con el que dio menos errores.
 * Anda casi siempre, y cuando falla mete un movimiento de $ 1.234 como $ 1,234
 * en una conciliación que después alguien firma.
 *
 * El otro es **declarar el mapeo una vez por cuenta bancaria** y que el motor
 * rechace todo lo que no encaje. Es lo que hace este archivo. La primera
 * importación de un banco nuevo cuesta cinco minutos de configuración; a cambio,
 * ninguna importación posterior interpreta nada por su cuenta.
 *
 * El control que más sirve no es ninguno de los parsers: es la **cadena de
 * saldos** (`verificarCadenaDeSaldos`). Si el extracto trae la columna de saldo,
 * cada fila tiene que explicar la diferencia con la anterior. Una fila mal leída,
 * un archivo truncado o una columna corrida rompen la cadena inmediatamente,
 * incluso cuando cada fila por separado parecía válida.
 */

import type { CalendarDate, Currency, Money, Result } from '@aai/shared';
import { add, err, isCalendarDate, money, ok, subtract, zero } from '@aai/shared';
import type { MovimientoBancario, SentidoBancario } from './contracts.js';

export type FormatoFecha = 'DD/MM/AAAA' | 'DD-MM-AAAA' | 'AAAA-MM-DD' | 'DD/MM/AA';

export type FormatoImporte =
  /** `1.234,56` — miles con punto, decimal con coma. */
  | 'ES_AR'
  /** `1,234.56` — miles con coma, decimal con punto. */
  | 'EN_US'
  /** `1234.56` — sin separador de miles. */
  | 'PLANO';

/**
 * Cómo viene el importe y su signo.
 *
 * Acá se hace **la única traducción de óptica del sistema**: las columnas del
 * extracto están escritas desde el banco, y de acá salen ya convertidas a
 * `ENTRADA`/`SALIDA` desde la caja de la empresa.
 *
 * La columna que el banco titula "Débito" es plata que **sale** de la cuenta: el
 * banco debita su deuda con la empresa. La que titula "Crédito" es plata que
 * entra. Los nombres de los campos conservan la palabra del banco porque es la
 * que el usuario ve en su archivo al configurar el mapeo; el valor que producen
 * es el de la empresa.
 *
 * `COLUMNAS_SEPARADAS` es el caso más común en los bancos argentinos y el más
 * seguro: no hay ningún signo que interpretar.
 */
export type EsquemaDeSigno =
  | {
      readonly tipo: 'COLUMNAS_SEPARADAS';
      /** Columna que el extracto titula "Débito". Produce `SALIDA`. */
      readonly debitoDelBanco: number;
      /** Columna que el extracto titula "Crédito". Produce `ENTRADA`. */
      readonly creditoDelBanco: number;
    }
  | {
      readonly tipo: 'COLUMNA_UNICA_CON_SIGNO';
      readonly importe: number;
      /** Si un número negativo significa que salió plata de la cuenta. */
      readonly negativoEsSalida: boolean;
    };

export interface MapeoDeExtracto {
  readonly nombre: string;
  /** Filas de encabezado a saltear antes de la primera fila de datos. */
  readonly filasDeEncabezado: number;
  readonly columnaFecha: number;
  readonly columnaFechaValor: number | null;
  readonly columnaDescripcion: number;
  readonly columnaReferencia: number | null;
  readonly columnaSaldo: number | null;
  readonly signo: EsquemaDeSigno;
  readonly formatoFecha: FormatoFecha;
  readonly formatoImporte: FormatoImporte;
  readonly moneda: Currency;
}

export type CodigoErrorImportacion =
  | 'FILA_CORTA'
  | 'FECHA_INVALIDA'
  | 'IMPORTE_INVALIDO'
  | 'SIN_IMPORTE'
  | 'AMBOS_LADOS'
  | 'CADENA_DE_SALDOS_ROTA'
  | 'SALDO_FINAL_NO_COINCIDE';

export interface ErrorImportacion {
  readonly codigo: CodigoErrorImportacion;
  /** 1-based, contando desde la primera fila del archivo. */
  readonly fila: number;
  readonly mensaje: string;
  readonly crudo: string;
}

export interface ResultadoImportacion {
  readonly movimientos: readonly MovimientoBancario[];
  readonly errores: readonly ErrorImportacion[];
}

/**
 * Interpreta filas ya separadas en columnas.
 *
 * El motor recibe `string[][]`, no un archivo: separar un CSV es un problema de
 * lectura de archivos y vive en la capa que sabe de archivos. Acá vive la
 * interpretación, que es donde están las decisiones contables.
 *
 * **Una fila que falla no aborta la importación y tampoco se saltea en
 * silencio**: se devuelve en `errores` con su contenido original. Un extracto con
 * tres filas ilegibles importado como si tuviera tres filas menos es peor que uno
 * que no importa.
 */
export function interpretarExtracto(
  filas: readonly (readonly string[])[],
  mapeo: MapeoDeExtracto,
): ResultadoImportacion {
  const movimientos: MovimientoBancario[] = [];
  const errores: ErrorImportacion[] = [];

  const maxColumna = Math.max(
    mapeo.columnaFecha,
    mapeo.columnaDescripcion,
    mapeo.columnaFechaValor ?? 0,
    mapeo.columnaReferencia ?? 0,
    mapeo.columnaSaldo ?? 0,
    mapeo.signo.tipo === 'COLUMNAS_SEPARADAS'
      ? Math.max(mapeo.signo.debitoDelBanco, mapeo.signo.creditoDelBanco)
      : mapeo.signo.importe,
  );

  for (let indice = mapeo.filasDeEncabezado; indice < filas.length; indice += 1) {
    const fila = filas[indice];
    if (fila === undefined) continue;
    const numeroDeFila = indice + 1;
    const crudo = fila.join(' | ');

    // Una fila vacía al final del archivo es normal y no es un error.
    if (fila.every((celda) => celda.trim() === '')) continue;

    if (fila.length <= maxColumna) {
      errores.push({
        codigo: 'FILA_CORTA',
        fila: numeroDeFila,
        mensaje: `La fila tiene ${fila.length} columna(s) y el mapeo "${mapeo.nombre}" necesita al menos ${maxColumna + 1}. El archivo no corresponde a este mapeo, o el separador es otro.`,
        crudo,
      });
      continue;
    }

    const fecha = interpretarFecha(fila[mapeo.columnaFecha] ?? '', mapeo.formatoFecha);
    if (fecha === null) {
      errores.push({
        codigo: 'FECHA_INVALIDA',
        fila: numeroDeFila,
        mensaje: `"${fila[mapeo.columnaFecha] ?? ''}" no es una fecha ${mapeo.formatoFecha}. El mapeo declara ese formato: si el banco cambió, hay que actualizar el mapeo, no adivinar acá.`,
        crudo,
      });
      continue;
    }

    const resuelto = resolverImporte(fila, mapeo, numeroDeFila, crudo);
    if (!resuelto.ok) {
      errores.push(resuelto.error);
      continue;
    }

    const saldoTexto = mapeo.columnaSaldo === null ? null : (fila[mapeo.columnaSaldo] ?? null);
    const saldo =
      saldoTexto === null || saldoTexto.trim() === ''
        ? null
        : interpretarImporte(saldoTexto, mapeo.formatoImporte, mapeo.moneda);

    const fechaValorTexto =
      mapeo.columnaFechaValor === null ? null : (fila[mapeo.columnaFechaValor] ?? null);

    movimientos.push({
      id: `fila-${String(numeroDeFila)}`,
      fecha,
      fechaValor:
        fechaValorTexto === null || fechaValorTexto.trim() === ''
          ? null
          : interpretarFecha(fechaValorTexto, mapeo.formatoFecha),
      descripcion: (fila[mapeo.columnaDescripcion] ?? '').trim(),
      importe: resuelto.value.importe,
      sentido: resuelto.value.sentido,
      referencia:
        mapeo.columnaReferencia === null
          ? null
          : ((fila[mapeo.columnaReferencia] ?? '').trim() || null),
      saldoPosterior: saldo,
      crudo,
    });
  }

  return { movimientos, errores };
}

function resolverImporte(
  fila: readonly string[],
  mapeo: MapeoDeExtracto,
  numeroDeFila: number,
  crudo: string,
): Result<{ importe: Money; sentido: SentidoBancario }, ErrorImportacion> {
  if (mapeo.signo.tipo === 'COLUMNAS_SEPARADAS') {
    const debitoTexto = (fila[mapeo.signo.debitoDelBanco] ?? '').trim();
    const creditoTexto = (fila[mapeo.signo.creditoDelBanco] ?? '').trim();
    const debito = debitoTexto === '' ? null : interpretarImporte(debitoTexto, mapeo.formatoImporte, mapeo.moneda);
    const credito = creditoTexto === '' ? null : interpretarImporte(creditoTexto, mapeo.formatoImporte, mapeo.moneda);

    if (debitoTexto !== '' && debito === null) {
      return err(errorImporte(numeroDeFila, debitoTexto, mapeo, crudo));
    }
    if (creditoTexto !== '' && credito === null) {
      return err(errorImporte(numeroDeFila, creditoTexto, mapeo, crudo));
    }

    const hayDebito = debito !== null && debito.amount !== 0n;
    const hayCredito = credito !== null && credito.amount !== 0n;

    if (hayDebito && hayCredito) {
      // Un movimiento con importe en las dos columnas no es un movimiento: son
      // dos, o las columnas están corridas. Elegir una sería inventar.
      return err({
        codigo: 'AMBOS_LADOS',
        fila: numeroDeFila,
        mensaje: `La fila tiene importe en débito (${debitoTexto}) y en crédito (${creditoTexto}). O son dos movimientos en una línea, o el mapeo apunta a las columnas equivocadas.`,
        crudo,
      });
    }

    // Acá está la traducción: la columna "Débito" del banco es plata que sale.
    if (hayDebito) return ok({ importe: absoluto(debito), sentido: 'SALIDA' });
    if (hayCredito) return ok({ importe: absoluto(credito), sentido: 'ENTRADA' });

    return err({
      codigo: 'SIN_IMPORTE',
      fila: numeroDeFila,
      mensaje: 'La fila no tiene importe ni en débito ni en crédito.',
      crudo,
    });
  }

  const texto = (fila[mapeo.signo.importe] ?? '').trim();
  const importe = texto === '' ? null : interpretarImporte(texto, mapeo.formatoImporte, mapeo.moneda);
  if (importe === null) {
    return err(
      texto === ''
        ? { codigo: 'SIN_IMPORTE', fila: numeroDeFila, mensaje: 'La columna de importe está vacía.', crudo }
        : errorImporte(numeroDeFila, texto, mapeo, crudo),
    );
  }
  if (importe.amount === 0n) {
    return err({
      codigo: 'SIN_IMPORTE',
      fila: numeroDeFila,
      mensaje: 'El importe es cero. Un movimiento de cero no mueve el saldo: revisá si la columna es la correcta.',
      crudo,
    });
  }

  const esNegativo = importe.amount < 0n;
  const sentido: SentidoBancario = mapeo.signo.negativoEsSalida
    ? esNegativo
      ? 'SALIDA'
      : 'ENTRADA'
    : esNegativo
      ? 'ENTRADA'
      : 'SALIDA';

  return ok({ importe: absoluto(importe), sentido });
}

function errorImporte(
  fila: number,
  texto: string,
  mapeo: MapeoDeExtracto,
  crudo: string,
): ErrorImportacion {
  return {
    codigo: 'IMPORTE_INVALIDO',
    fila,
    mensaje: `"${texto}" no es un importe ${mapeo.formatoImporte}. El mapeo declara ese formato; el motor no prueba otros.`,
    crudo,
  };
}

function absoluto(valor: Money): Money {
  return valor.amount < 0n ? money(-valor.amount, valor.currency) : valor;
}

/**
 * Fecha según el formato **declarado**. No se prueban otros.
 *
 * Es la diferencia con el parser del motor documental, que sí tiene que
 * enfrentarse a un PDF donde nadie declaró nada y por eso se abstiene ante
 * `12/25/2026`. Acá el mapeo ya dijo cuál es el formato: si el valor no encaja,
 * el problema es el archivo o el mapeo, y probar el otro orden taparía justamente
 * eso.
 *
 * `DD/MM/AA` interpreta el siglo con la ventana 2000–2099. Un extracto bancario
 * de 1998 no existe en este sistema; uno de 2098 tampoco, todavía.
 */
export function interpretarFecha(texto: string, formato: FormatoFecha): CalendarDate | null {
  const limpio = texto.trim();
  let anio: number;
  let mes: number;
  let dia: number;

  if (formato === 'AAAA-MM-DD') {
    const partes = /^(\d{4})-(\d{2})-(\d{2})$/u.exec(limpio);
    if (partes === null) return null;
    anio = Number(partes[1]);
    mes = Number(partes[2]);
    dia = Number(partes[3]);
  } else {
    const separador = formato === 'DD-MM-AAAA' ? '-' : '/';
    const partes = limpio.split(separador);
    if (partes.length !== 3) return null;
    const [d, m, a] = partes;
    if (d === undefined || m === undefined || a === undefined) return null;
    if (!/^\d{1,2}$/u.test(d) || !/^\d{1,2}$/u.test(m)) return null;
    if (formato === 'DD/MM/AA') {
      if (!/^\d{2}$/u.test(a)) return null;
      anio = 2000 + Number(a);
    } else {
      if (!/^\d{4}$/u.test(a)) return null;
      anio = Number(a);
    }
    mes = Number(m);
    dia = Number(d);
  }

  const iso = `${String(anio).padStart(4, '0')}-${String(mes).padStart(2, '0')}-${String(dia).padStart(2, '0')}`;
  return isCalendarDate(iso) ? iso : null;
}

/**
 * Importe según el formato **declarado**, en unidades menores.
 *
 * Todo en enteros: se separan la parte entera y la decimal como texto y se
 * concatenan. En ningún punto hay un `parseFloat`, que es como
 * `1234.565` se convierte en `1234.5649999999998` y de ahí en un centavo de
 * diferencia que rompe la cadena de saldos.
 *
 * Los paréntesis son negativos: `(1.234,56)` es la convención contable y varios
 * bancos la usan en sus exportaciones.
 */
export function interpretarImporte(
  texto: string,
  formato: FormatoImporte,
  moneda: Currency,
): Money | null {
  // `\p{Zs}` cubre el espacio duro que varios bancos meten como separador de
  // miles. Escrito como carácter literal sería invisible en el fuente.
  let limpio = texto.trim().replace(/[\s\p{Zs}]/gu, '');
  if (limpio === '') return null;

  let negativo = false;
  if (/^\(.*\)$/u.test(limpio)) {
    negativo = true;
    limpio = limpio.slice(1, -1);
  }
  if (limpio.startsWith('-')) {
    negativo = true;
    limpio = limpio.slice(1);
  } else if (limpio.startsWith('+')) {
    limpio = limpio.slice(1);
  }

  // Se descartan símbolos de moneda; el mapeo ya declaró cuál es.
  limpio = limpio.replace(/[$₪€£]|ARS|USD/gu, '');

  if (formato === 'ES_AR') limpio = limpio.replace(/\./gu, '').replace(/,/u, '.');
  else if (formato === 'EN_US') limpio = limpio.replace(/,/gu, '');

  const partes = /^(\d+)(?:\.(\d{1,2}))?$/u.exec(limpio);
  if (partes === null) return null;

  const entera = partes[1] ?? '0';
  const decimal = (partes[2] ?? '').padEnd(2, '0');
  const unidades = BigInt(entera + decimal);

  return money(negativo ? -unidades : unidades, moneda);
}

// ---------------------------------------------------------------------------
// El control que más sirve
// ---------------------------------------------------------------------------

export interface VerificacionDeSaldos {
  readonly verificable: boolean;
  readonly errores: readonly ErrorImportacion[];
  readonly saldoFinalCalculado: Money;
}

/**
 * La cadena de saldos: cada fila explica la diferencia con la anterior.
 *
 * Es el control de integridad del extracto, y es mucho más fuerte que validar
 * cada fila por separado. Una columna corrida, un archivo truncado a la mitad o
 * un importe leído con el formato equivocado rompen la cadena en la primera fila
 * afectada, aunque esa fila —vista sola— parezca perfectamente válida.
 *
 * Cuando el extracto no trae columna de saldo, esto no se puede hacer, y el
 * resultado lo dice con `verificable: false` en vez de devolver "todo bien". No
 * es lo mismo haber controlado y que dé bien, que no haber podido controlar.
 */
export function verificarCadenaDeSaldos(
  movimientos: readonly MovimientoBancario[],
  saldoInicial: Money,
  saldoFinalDeclarado: Money | null,
): VerificacionDeSaldos {
  const errores: ErrorImportacion[] = [];
  let acumulado = saldoInicial;
  let verificable = false;

  for (const movimiento of movimientos) {
    acumulado =
      movimiento.sentido === 'ENTRADA'
        ? add(acumulado, movimiento.importe)
        : subtract(acumulado, movimiento.importe);

    if (movimiento.saldoPosterior === null) continue;
    verificable = true;

    if (movimiento.saldoPosterior.amount !== acumulado.amount) {
      errores.push({
        codigo: 'CADENA_DE_SALDOS_ROTA',
        fila: Number(movimiento.id.replace('fila-', '')),
        mensaje: `El extracto declara un saldo de ${movimiento.saldoPosterior.amount} y el acumulado da ${acumulado.amount} (unidades menores). Diferencia: ${movimiento.saldoPosterior.amount - acumulado.amount}. Desde acá, todo lo que sigue está corrido: no importes este extracto hasta resolverlo.`,
        crudo: movimiento.crudo,
      });
      // Se corta en la primera rotura. Seguir produciría un error por cada fila
      // restante, todos consecuencia del mismo problema, y el listado dejaría de
      // señalar dónde empezó.
      break;
    }
  }

  if (saldoFinalDeclarado !== null && errores.length === 0) {
    verificable = true;
    if (saldoFinalDeclarado.amount !== acumulado.amount) {
      errores.push({
        codigo: 'SALDO_FINAL_NO_COINCIDE',
        fila: movimientos.length,
        mensaje: `El extracto declara un saldo final de ${saldoFinalDeclarado.amount} y los movimientos importados dan ${acumulado.amount}. Faltan movimientos, o sobran.`,
        crudo: '',
      });
    }
  }

  return {
    verificable,
    errores,
    saldoFinalCalculado: movimientos.length === 0 ? saldoInicial : acumulado,
  };
}

/**
 * Huella de un movimiento, para detectar reimportaciones.
 *
 * Deliberadamente **no** incluye el id de fila: el mismo movimiento reimportado
 * desde un archivo con una fila de encabezado más tiene otro número de fila y
 * sigue siendo el mismo movimiento.
 *
 * Tampoco incluye la descripción completa: algunos bancos la recortan distinto
 * entre exportaciones. Fecha, importe, sentido y referencia alcanzan, y cuando no
 * hay referencia se acepta que dos movimientos idénticos del mismo día sean
 * legítimamente dos —por eso esto detecta, y no bloquea.
 */
export function huellaDeMovimiento(movimiento: MovimientoBancario): string {
  return [
    movimiento.fecha,
    movimiento.sentido,
    movimiento.importe.amount.toString(),
    movimiento.referencia ?? '',
  ].join('|');
}

/** Cuenta movimientos con la misma huella dentro del mismo lote. */
export function repetidosEnElLote(
  movimientos: readonly MovimientoBancario[],
): { huella: string; ids: readonly string[] }[] {
  const porHuella = new Map<string, string[]>();
  for (const movimiento of movimientos) {
    const huella = huellaDeMovimiento(movimiento);
    const previos = porHuella.get(huella);
    if (previos === undefined) porHuella.set(huella, [movimiento.id]);
    else previos.push(movimiento.id);
  }
  return [...porHuella.entries()]
    .filter(([, ids]) => ids.length > 1)
    .map(([huella, ids]) => ({ huella, ids }));
}

/** Suma de movimientos por sentido, para el resumen de la importación. */
export function totalesDelLote(
  movimientos: readonly MovimientoBancario[],
  moneda: Currency,
): { entradas: Money; salidas: Money } {
  let creditos = zero(moneda);
  let debitos = zero(moneda);
  for (const movimiento of movimientos) {
    if (movimiento.sentido === 'ENTRADA') creditos = add(creditos, movimiento.importe);
    else debitos = add(debitos, movimiento.importe);
  }
  return { entradas: creditos, salidas: debitos };
}
