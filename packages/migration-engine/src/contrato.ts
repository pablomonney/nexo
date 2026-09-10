/**
 * El contrato que cumple toda fuente, y el registro de las que existen.
 *
 * ## La distinción que sostiene todo el módulo
 *
 * **Un formato soportado no es un sistema soportado.** NEXO puede leer un CSV;
 * eso no quiere decir que soporte Tango. Soportar Tango sería conocer su
 * estructura real de exportación, sus nombres de columna, sus códigos de
 * comprobante y sus reglas — y eso hay que verificarlo contra una exportación
 * real, no suponerlo.
 *
 * Por eso cada adaptador declara su estado y ninguno puede declarar
 * `IMPLEMENTADO` sin traer un `extraer` que funcione. La UI y la matriz de
 * compatibilidad se dibujan **desde este registro**, así que no hay forma de
 * prometer en una pantalla algo que el código no hace.
 *
 * Es la misma disciplina que ya tenía el catálogo de integraciones, donde
 * Mercado Libre y Shopify figuran `PLANIFICADO` desde el día uno en vez de
 * aparecer como disponibles.
 */

import type { Entidad, RegistroCanonico } from './canonico.js';

/**
 * Cuán real es un adaptador. Los cuatro valores son distintos y no se mezclan.
 *
 * `IMPLEMENTADO` — extrae datos de verdad y hay tests que lo demuestran.
 * `PREPARADO`    — el contrato y la infraestructura existen; falta la parte
 *                  que depende de algo externo (una credencial, un esquema
 *                  concreto, una exportación real que nadie nos dio todavía).
 * `PLANIFICADO`  — se sabe qué habría que hacer y no está hecho.
 * `BLOQUEADO`    — no se puede avanzar hasta que se resuelva algo de afuera.
 */
export type EstadoDeAdaptador = 'IMPLEMENTADO' | 'PREPARADO' | 'PLANIFICADO' | 'BLOQUEADO';

/** Cómo llegan los datos. */
export type MedioDeOrigen = 'ARCHIVO' | 'BASE_DE_DATOS' | 'API' | 'MANUAL';

export interface CapacidadesDeAdaptador {
  /** Qué entidades sabe traer. Lo que no está acá, no lo trae. */
  readonly entidades: readonly Entidad[];
  /** Extensiones o formatos que acepta, cuando el medio es un archivo. */
  readonly formatos: readonly string[];
  /** Si puede traer los datos por tandas en vez de todo junto. */
  readonly porTandas: boolean;
  /** Si puede retomar donde quedó tras un corte. */
  readonly reanudable: boolean;
  /** Si el origen trae un identificador propio por registro. */
  readonly conIdExterno: boolean;
}

export interface DescripcionDeAdaptador {
  readonly codigo: string;
  readonly nombre: string;
  readonly medio: MedioDeOrigen;
  readonly estado: EstadoDeAdaptador;
  readonly capacidades: CapacidadesDeAdaptador;
  /**
   * Qué falta para que pase a `IMPLEMENTADO`, o por qué está bloqueado.
   *
   * Obligatorio cuando el estado no es `IMPLEMENTADO`: un adaptador a medias
   * sin explicación es una promesa sin fecha, y a los seis meses nadie se
   * acuerda de qué le faltaba.
   */
  readonly queFalta?: string;
}

/** Lo que se le entrega a un adaptador para que extraiga. */
export interface EntradaDeExtraccion {
  /** El contenido, cuando el medio es un archivo. */
  readonly bytes?: Buffer;
  readonly nombreArchivo?: string;
  /** Parámetros propios del adaptador —hoja de un XLSX, separador, ruta JSON—. */
  readonly opciones?: Readonly<Record<string, string>>;
}

/** Una tabla cruda tal como salió del origen, antes de mapear a lo canónico. */
export interface TablaCruda {
  /** Nombre de la hoja, tabla o colección dentro del origen. */
  readonly nombre: string;
  readonly columnas: readonly string[];
  readonly filas: readonly (readonly string[])[];
}

export interface ResultadoDeExtraccion {
  readonly tablas: readonly TablaCruda[];
  /** Avisos que no impiden seguir: hojas vacías, columnas sin nombre. */
  readonly avisos: readonly string[];
}

/**
 * Lo que cumple una fuente.
 *
 * `extraer` es lo único obligatorio, y es a propósito: un adaptador que no
 * extrae no es un adaptador. `mapeoSugerido` es opcional porque un CSV
 * cualquiera no tiene forma de saber qué significan sus columnas, mientras que
 * un adaptador de un sistema conocido sí.
 */
export interface AdaptadorDeOrigen {
  readonly descripcion: DescripcionDeAdaptador;
  /** Lee el origen y devuelve tablas crudas. No interpreta ni normaliza. */
  extraer(entrada: EntradaDeExtraccion): Promise<ResultadoDeExtraccion>;
  /**
   * Qué columna del origen corresponde a qué campo canónico, si el adaptador
   * lo sabe. Un adaptador genérico devuelve un mapeo vacío y decide la persona.
   */
  mapeoSugerido?(tabla: TablaCruda): Readonly<Record<string, string>>;
  /** A qué entidad canónica corresponde una tabla, si el adaptador lo sabe. */
  entidadSugerida?(tabla: TablaCruda): Entidad | null;
}

/**
 * El registro de adaptadores: la única fuente de verdad sobre qué soporta NEXO.
 *
 * La matriz de compatibilidad, la UI y la documentación se derivan de acá. No
 * hay una segunda lista escrita a mano en ningún lado, que es como esas listas
 * terminan diciendo cosas distintas.
 */
export class RegistroDeAdaptadores {
  readonly #porCodigo = new Map<string, AdaptadorDeOrigen>();

  registrar(adaptador: AdaptadorDeOrigen): void {
    const { codigo, estado, queFalta } = adaptador.descripcion;

    if (this.#porCodigo.has(codigo)) {
      throw new Error(`Ya hay un adaptador registrado con el código ${codigo}`);
    }
    // El candado que impide prometer de más: un adaptador que no está
    // implementado tiene que decir qué le falta, y uno que dice estar
    // implementado tiene que traer con qué extraer.
    if (estado !== 'IMPLEMENTADO' && (queFalta === undefined || queFalta.trim() === '')) {
      throw new Error(
        `El adaptador ${codigo} declara estado ${estado} y no dice qué le falta. ` +
          'Un adaptador a medias sin explicación es una promesa sin fecha.',
      );
    }
    this.#porCodigo.set(codigo, adaptador);
  }

  obtener(codigo: string): AdaptadorDeOrigen | null {
    return this.#porCodigo.get(codigo) ?? null;
  }

  /** Solo los que pueden usarse hoy. Es lo que la UI ofrece elegir. */
  disponibles(): readonly DescripcionDeAdaptador[] {
    return this.todos().filter((d) => d.estado === 'IMPLEMENTADO');
  }

  todos(): readonly DescripcionDeAdaptador[] {
    return [...this.#porCodigo.values()]
      .map((a) => a.descripcion)
      .sort((a, b) => a.codigo.localeCompare(b.codigo));
  }

  /**
   * La matriz de compatibilidad, derivada de las capacidades declaradas.
   *
   * No se escribe a mano en la documentación: se calcula. Una matriz escrita
   * aparte envejece en cuanto alguien agrega una entidad a un adaptador y se
   * olvida de la tabla.
   */
  matriz(): readonly {
    readonly codigo: string;
    readonly nombre: string;
    readonly medio: MedioDeOrigen;
    readonly estado: EstadoDeAdaptador;
    readonly entidades: readonly Entidad[];
  }[] {
    return this.todos().map((d) => ({
      codigo: d.codigo,
      nombre: d.nombre,
      medio: d.medio,
      estado: d.estado,
      entidades: d.capacidades.entidades,
    }));
  }
}

/** Lo que devuelve el pipeline después de normalizar y mapear. */
export interface Extraccion {
  readonly registros: readonly RegistroCanonico[];
  readonly avisos: readonly string[];
}
