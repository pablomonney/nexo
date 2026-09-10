/**
 * Qué impide importar, qué hay que mirar, y qué solo se informa.
 *
 * ## Tres niveles y no dos
 *
 * `ERROR` bloquea la importación entera. `ADVERTENCIA` la deja pasar y queda
 * escrita en el reporte. `INFO` cuenta lo que el sistema hizo con el dato.
 *
 * La tercera es la que suele faltar y la que más se agradece después: cuando
 * alguien pregunta por qué la fecha de una factura es el 3 de abril y el
 * archivo decía `03/04`, la respuesta tiene que estar en algún lado.
 *
 * ## Nada se corrige solo
 *
 * El validador no arregla datos. Puede decir que un CUIT está mal; no puede
 * inventarle el dígito verificador. Un motor de migración que corrige lo que no
 * entiende produce una empresa cuyos datos nadie puede auditar contra el
 * sistema del que vino.
 */

import type { Campo, Entidad, RegistroCanonico } from './canonico.js';
import { FORMAS } from './canonico.js';

export type Nivel = 'ERROR' | 'ADVERTENCIA' | 'INFO';

export interface Hallazgo {
  readonly nivel: Nivel;
  readonly codigo: string;
  readonly mensaje: string;
  /** Dónde: fila del origen y campo, cuando aplica. */
  readonly fila: string;
  readonly campo?: string;
}

const esCampoVacio = (c: Campo<unknown> | undefined): boolean =>
  c === undefined || (c.valor === null && c.motivo === 'El campo vino vacío');

/**
 * Valida un registro contra la forma de su entidad.
 *
 * El orden importa: primero lo que falta, después lo que no se entendió. Un
 * campo obligatorio ausente y otro ilegible son problemas distintos y quien los
 * corrige hace cosas distintas.
 */
export function validarRegistro(registro: RegistroCanonico): readonly Hallazgo[] {
  const forma = FORMAS[registro.entidad];
  const hallazgos: Hallazgo[] = [];
  const fila = registro.procedencia.fila;

  for (const obligatorio of forma.obligatorios) {
    if (esCampoVacio(registro.campos[obligatorio])) {
      hallazgos.push({
        nivel: 'ERROR',
        codigo: 'FALTA_OBLIGATORIO',
        mensaje: `Falta ${obligatorio}, que esta entidad necesita para existir`,
        fila,
        campo: obligatorio,
      });
    }
  }

  for (const [campo, valor] of Object.entries(registro.campos)) {
    if (valor.valor !== null) continue;
    if (esCampoVacio(valor)) {
      // Un opcional vacío no es un problema; un obligatorio vacío ya se reportó.
      continue;
    }
    // El campo trajo algo y no se pudo interpretar. Si es obligatorio no se
    // puede importar; si no, se importa sin él y queda dicho.
    const esObligatorio = forma.obligatorios.includes(campo);
    hallazgos.push({
      nivel: esObligatorio ? 'ERROR' : 'ADVERTENCIA',
      codigo: 'NO_INTERPRETABLE',
      mensaje: `«${valor.crudo}» no se pudo interpretar: ${valor.motivo ?? 'sin motivo'}`,
      fila,
      campo,
    });
  }

  // Lo que sí se interpretó pero cambió de forma, para poder reconstruirlo.
  for (const [campo, valor] of Object.entries(registro.campos)) {
    if (valor.valor === null) continue;
    if (String(valor.valor) !== valor.crudo.trim()) {
      hallazgos.push({
        nivel: 'INFO',
        codigo: 'NORMALIZADO',
        mensaje: `«${valor.crudo}» se interpretó como «${String(valor.valor)}»`,
        fila,
        campo,
      });
    }
  }

  return hallazgos;
}

/**
 * Un asiento tiene que cuadrar.
 *
 * Es la única validación que mira **el conjunto** y no cada fila: un renglón de
 * asiento solo no está bien ni mal, y lo que decide es la suma del asiento.
 *
 * No se ajusta la diferencia contra ninguna cuenta. Un motor de migración que
 * cuadra un asiento inventando un renglón produce una contabilidad que suma y
 * es falsa, y esa es peor que una que no suma y lo dice.
 */
export function validarPartidaDoble(
  registros: readonly RegistroCanonico[],
): readonly Hallazgo[] {
  const porAsiento = new Map<string, { debe: bigint; haber: bigint; filas: string[] }>();

  for (const r of registros) {
    if (r.entidad !== 'JOURNAL_ENTRY') continue;
    const asiento = String(r.campos.asiento?.valor ?? r.procedencia.fila);
    const acc = porAsiento.get(asiento) ?? { debe: 0n, haber: 0n, filas: [] };
    acc.debe += aCentavos(r.campos.debe);
    acc.haber += aCentavos(r.campos.haber);
    acc.filas.push(r.procedencia.fila);
    porAsiento.set(asiento, acc);
  }

  const hallazgos: Hallazgo[] = [];
  for (const [asiento, { debe, haber, filas }] of porAsiento) {
    if (debe === haber) continue;
    const diferencia = debe - haber;
    hallazgos.push({
      nivel: 'ERROR',
      codigo: 'ASIENTO_DESCUADRADO',
      mensaje:
        `El asiento ${asiento} no cuadra: debe ${comoImporte(debe)} contra haber ` +
        `${comoImporte(haber)}, diferencia ${comoImporte(diferencia)}. ` +
        'Se corrige en el origen: NEXO no agrega un renglón para cuadrarlo.',
      fila: filas.join(', '),
    });
  }
  return hallazgos;
}

const aCentavos = (c: Campo<unknown> | undefined): bigint =>
  c?.valor === null || c?.valor === undefined ? 0n : BigInt(String(c.valor));

const comoImporte = (centavos: bigint): string => {
  const negativo = centavos < 0n;
  const abs = negativo ? -centavos : centavos;
  const entero = abs / 100n;
  const resto = (abs % 100n).toString().padStart(2, '0');
  return `${negativo ? '-' : ''}${entero.toString()},${resto}`;
};

export interface Veredicto {
  readonly hallazgos: readonly Hallazgo[];
  readonly errores: number;
  readonly advertencias: number;
  readonly informativos: number;
  /** Falso cuando hay al menos un error: la importación no puede empezar. */
  readonly sePuedeImportar: boolean;
}

export function validar(registros: readonly RegistroCanonico[]): Veredicto {
  const hallazgos = [
    ...registros.flatMap(validarRegistro),
    ...validarPartidaDoble(registros),
  ];
  const errores = hallazgos.filter((h) => h.nivel === 'ERROR').length;
  return {
    hallazgos,
    errores,
    advertencias: hallazgos.filter((h) => h.nivel === 'ADVERTENCIA').length,
    informativos: hallazgos.filter((h) => h.nivel === 'INFO').length,
    sePuedeImportar: errores === 0,
  };
}

/**
 * La clave por la que dos registros son el mismo.
 *
 * Devuelve la primera combinación de la lista de identidad que esté completa,
 * en orden de confianza: el CUIT antes que el nombre, porque dos empresas
 * pueden llamarse igual y no pueden compartir CUIT.
 *
 * `null` cuando ninguna combinación está completa. Ahí el registro no se puede
 * comparar con nada y entra como nuevo, que es lo correcto: inventarle una
 * identidad por parecido es cómo se fusionan dos clientes distintos.
 */
/** ASCII 31. No aparece en ningún dato y la base lo admite; el NUL no. */
const SEPARADOR_DE_IDENTIDAD = '\u001f';

export function claveDeIdentidad(
  entidad: Entidad,
  campos: Readonly<Record<string, Campo<unknown>>>,
): { readonly por: readonly string[]; readonly valor: string } | null {
  for (const combinacion of FORMAS[entidad].identidad) {
    const partes = combinacion.map((c) => campos[c]?.valor);
    if (partes.some((p) => p === null || p === undefined || String(p) === '')) continue;
    // El separador es el ASCII 31, «unit separator», que es exactamente para
    // esto. **No** puede ser el NUL que había antes: PostgreSQL no admite el
    // byte cero en una columna `text` y la identidad se guarda en una. En el
    // V1 no se notaba porque las dos entidades importables tenían identidad de
    // un solo campo y el separador nunca aparecía; la primera entidad con
    // identidad compuesta —una existencia de stock, que es SKU más depósito—
    // abortaba la importación con un error de codificación.
    return { por: combinacion, valor: partes.map((p) => String(p)).join(SEPARADOR_DE_IDENTIDAD) };
  }
  return null;
}
