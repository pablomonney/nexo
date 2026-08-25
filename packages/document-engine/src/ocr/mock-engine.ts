/**
 * Motor de OCR simulado, para desarrollar y probar el pipeline sin depender de
 * un proveedor.
 *
 * Igual que el mock de ARCA, **sabe fallar**. Un mock que siempre devuelve texto
 * limpio y confianza alta produce un sistema que nunca fue probado contra el
 * caso normal de este dominio: una fotocopia torcida de un remito con el total
 * medio borrado. Por eso hay escenarios de documento ilegible, de confianza
 * baja y de caracteres confundidos.
 *
 * La confusión de caracteres no es adorno: `0/O`, `1/l`, `5/S` y `8/B` son los
 * errores reales de cualquier OCR sobre comprobantes impresos, y son los que
 * hacen que un CAE de 14 dígitos falle la validación de longitud o que un CUIT
 * no verifique el dígito. Que el pipeline los enfrente en los tests es la razón
 * de que los parsers se abstengan en vez de inventar.
 */

import type {
  EntradaOcr,
  OcrEngine,
  PaginaReconocida,
  PalabraReconocida,
  ResultadoOcr,
} from './engine.js';

export interface EscenarioMock {
  readonly paginas: readonly PaginaReconocida[];
  readonly disponible?: boolean;
  readonly motivo?: ResultadoOcr['motivo'];
}

export interface OpcionesMockOcr {
  /** Escenarios por hash de contenido, para respuestas deterministas. */
  readonly escenarios?: ReadonlyMap<string, EscenarioMock>;
  /** Escenario cuando el contenido no está mapeado. */
  readonly porDefecto?: EscenarioMock;
}

export class MockOcrEngine implements OcrEngine {
  readonly nombre = 'mock';
  readonly version = '1';

  readonly #opciones: OpcionesMockOcr;
  readonly llamadas: { tipo: string; bytes: number }[] = [];

  constructor(opciones: OpcionesMockOcr = {}) {
    this.#opciones = opciones;
  }

  soporta(tipo: string): boolean {
    return tipo === 'PDF' || tipo === 'JPEG' || tipo === 'PNG';
  }

  async reconocer(entrada: EntradaOcr): Promise<ResultadoOcr> {
    this.llamadas.push({ tipo: entrada.tipo, bytes: entrada.bytes.length });

    if (!this.soporta(entrada.tipo)) {
      return { disponible: false, paginas: [], motivo: 'TIPO_NO_SOPORTADO' };
    }

    const clave = entrada.bytes.toString('utf8');
    const escenario = this.#opciones.escenarios?.get(clave) ?? this.#opciones.porDefecto;
    if (escenario === undefined) {
      return {
        disponible: false,
        paginas: [],
        motivo: 'DOCUMENTO_ILEGIBLE',
        detalle: 'El mock no tiene un escenario para este contenido',
      };
    }

    return {
      disponible: escenario.disponible ?? true,
      paginas: escenario.paginas,
      ...(escenario.motivo !== undefined ? { motivo: escenario.motivo } : {}),
    };
  }
}

/** Arma una página a partir de líneas de texto, con confianza uniforme. */
export function paginaDeTexto(
  numero: number,
  lineas: readonly string[],
  confianza = 0.92,
): PaginaReconocida {
  const palabras: PalabraReconocida[] = [];
  lineas.forEach((linea, indiceLinea) => {
    linea.split(/\s+/).forEach((texto, indicePalabra) => {
      if (texto.length === 0) return;
      palabras.push({
        texto,
        confianza,
        bbox: { x: indicePalabra * 60, y: indiceLinea * 20, ancho: texto.length * 8, alto: 14 },
      });
    });
  });
  return { numero, texto: lineas.join('\n'), palabras, ancho: 1240, alto: 1754 };
}

/** Confusiones típicas de OCR sobre comprobantes impresos. */
export const CONFUSIONES: Readonly<Record<string, string>> = {
  '0': 'O',
  O: '0',
  '1': 'l',
  l: '1',
  '5': 'S',
  S: '5',
  '8': 'B',
  B: '8',
};

/** Degrada un texto aplicando una confusión cada `cada` caracteres elegibles. */
export function degradar(texto: string, cada = 7): string {
  let elegibles = 0;
  return [...texto]
    .map((caracter) => {
      const reemplazo = CONFUSIONES[caracter];
      if (reemplazo === undefined) return caracter;
      elegibles += 1;
      return elegibles % cada === 0 ? reemplazo : caracter;
    })
    .join('');
}
