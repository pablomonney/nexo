/**
 * El candado del sandbox: probar que el destino **es** un sandbox.
 *
 * ## La inversión que define el archivo
 *
 * La forma intuitiva de escribir esto es preguntar *"¿el destino es
 * producción?"*: comparar contra la URL de producción, revisar una lista de
 * bases prohibidas, mirar si el nombre dice `prod`. Todas esas comprobaciones
 * **fallan abiertas**. Una base nueva que nadie agregó a la lista pasa. Una base
 * de producción de otro cliente pasa. Una que alguien renombró pasa.
 *
 * Y el modo de falla no es un error visible: es una simulación que escribe
 * asientos en la contabilidad real de alguien, con la etiqueta de "prueba"
 * puesta en la interfaz y en ningún lado más.
 *
 * Acá la pregunta es la contraria: **¿hay prueba de que esto es un sandbox?**
 * La prueba es una tabla que solo existe si alguien corrió, a propósito, la
 * migración de sandbox sobre esa base. Las migraciones de producción no la crean
 * nunca. Entonces la ausencia de prueba —tabla que no está, marcador vacío,
 * conexión que ni siquiera se pudo abrir— es un rechazo, no un "seguí".
 *
 * Producción es rechazada no porque esté en una lista, sino porque no puede
 * demostrar lo que se le pide.
 *
 * ## Por qué se juntan todos los motivos
 *
 * `verificarAislamiento` no corta en el primer problema. Saber que la base
 * apunta a producción **y** no tiene marca **y** no respeta el prefijo dice algo
 * distinto que saber solo lo primero: dice que alguien copió una URL de otro
 * lado, no que se equivocó en un carácter.
 */

/** Prefijo obligatorio del nombre de la base. Legible desde `psql` sin abrir nada. */
export const PREFIJO_DE_BASE = 'sandbox_';

/**
 * Lo que tiene que decir el marcador para valer.
 *
 * No es un secreto ni cumple ninguna función criptográfica: la marca vale porque
 * está en la base correcta, no porque su contenido sea difícil de adivinar.
 * Existe para que una tabla `sandbox_marker` creada a mano, vacía o a medias, no
 * cuente como prueba.
 */
export const SELLO_DEL_MARCADOR = 'AAI_SANDBOX_V1';

/**
 * Lo que se observó del destino. Lo produce quien tiene la conexión —el script—;
 * este módulo no abre ninguna.
 *
 * `tieneMarcaDeSandbox` es `false` cuando la tabla no existe, cuando existe y
 * está vacía, y cuando la consulta falló. Los tres casos significan lo mismo:
 * no hay prueba.
 */
export interface HuellaDelDestino {
  readonly nombreDeBase: string;
  readonly urlDestino: string;
  /** `null` cuando el entorno no declara producción. No es una excusa para pasar. */
  readonly urlDeProduccion: string | null;
  readonly nombreDeBaseDeProduccion: string | null;
  readonly tieneMarcaDeSandbox: boolean;
  readonly selloDelMarcador: string | null;
}

export type MotivoDeRechazo =
  /** No hay tabla de marca, o está vacía, o no se pudo leer. El caso por defecto. */
  | 'SIN_MARCA_DE_SANDBOX'
  /** La tabla está pero dice otra cosa. Alguien la creó a mano. */
  | 'MARCA_ADULTERADA'
  | 'MISMA_URL_QUE_PRODUCCION'
  /** Misma base, distinta URL: `localhost` y `127.0.0.1` son la misma máquina. */
  | 'MISMA_BASE_QUE_PRODUCCION'
  | 'NOMBRE_SIN_PREFIJO';

export interface Rechazo {
  readonly motivo: MotivoDeRechazo;
  readonly explicacion: string;
}

/**
 * El resultado, como unión discriminada y no como booleano.
 *
 * Es lo que permite que `simular()` pida un `Aislamiento` con `aislado: true` en
 * su firma: no hay forma de correr una simulación sin haber pasado por acá,
 * porque el tipo no se puede construir de otra manera desde afuera del módulo.
 */
export type Aislamiento =
  | { readonly aislado: true; readonly base: string }
  | { readonly aislado: false; readonly rechazos: readonly Rechazo[] };

export function verificarAislamiento(huella: HuellaDelDestino): Aislamiento {
  const rechazos: Rechazo[] = [];

  if (!huella.tieneMarcaDeSandbox) {
    rechazos.push({
      motivo: 'SIN_MARCA_DE_SANDBOX',
      explicacion:
        `La base "${huella.nombreDeBase}" no tiene la marca de sandbox. No se comprueba que sea ` +
        'producción: se comprueba que sea un sandbox, y no lo demuestra. Creala con ' +
        '`npm run sandbox:create`, que aplica las mismas migraciones y además deja la marca.',
    });
  } else if (huella.selloDelMarcador !== SELLO_DEL_MARCADOR) {
    rechazos.push({
      motivo: 'MARCA_ADULTERADA',
      explicacion:
        `La tabla de marca existe pero declara "${huella.selloDelMarcador ?? '(vacío)'}" en vez de ` +
        `"${SELLO_DEL_MARCADOR}". Una tabla creada a mano para saltear este control no es una prueba ` +
        'de aislamiento; es la evidencia de que alguien lo intentó.',
    });
  }

  if (huella.urlDeProduccion !== null && huella.urlDestino === huella.urlDeProduccion) {
    rechazos.push({
      motivo: 'MISMA_URL_QUE_PRODUCCION',
      explicacion: 'El destino y la base de producción son la misma URL.',
    });
  }

  if (
    huella.nombreDeBaseDeProduccion !== null &&
    huella.nombreDeBase === huella.nombreDeBaseDeProduccion
  ) {
    rechazos.push({
      motivo: 'MISMA_BASE_QUE_PRODUCCION',
      explicacion:
        `El destino y producción son la misma base ("${huella.nombreDeBase}") aunque las URLs ` +
        'difieran. `localhost` y `127.0.0.1` son la misma máquina, y dos cadenas de conexión ' +
        'distintas pueden terminar en el mismo lugar.',
    });
  }

  if (!huella.nombreDeBase.startsWith(PREFIJO_DE_BASE)) {
    rechazos.push({
      motivo: 'NOMBRE_SIN_PREFIJO',
      explicacion:
        `La base se llama "${huella.nombreDeBase}" y no empieza con "${PREFIJO_DE_BASE}". ` +
        'El prefijo no es el control —el control es la marca— pero hace que cualquiera que ' +
        'mire un `\\l` en psql sepa qué está mirando sin abrir una tabla.',
    });
  }

  if (rechazos.length > 0) return { aislado: false, rechazos };
  return { aislado: true, base: huella.nombreDeBase };
}

/**
 * El texto que se le muestra a quien intentó correr una simulación y no pudo.
 *
 * Enumera **todos** los motivos. Un mensaje que dijera solo el primero llevaría a
 * corregirlo, reintentar, y encontrarse con el siguiente — y a la tercera vuelta
 * la conclusión razonable es que el control está roto, no que el destino está mal.
 */
export function explicarRechazo(aislamiento: Aislamiento): string {
  if (aislamiento.aislado) return '';
  const lineas = aislamiento.rechazos.map((r) => `  · ${r.motivo}: ${r.explicacion}`);
  return [
    'La simulación no corrió: el destino no probó ser un sandbox.',
    '',
    ...lineas,
    '',
    'Ninguno de estos controles pregunta si el destino es producción. Todos preguntan si es',
    'un sandbox, que es la pregunta que falla del lado seguro cuando la respuesta no está.',
  ].join('\n');
}
