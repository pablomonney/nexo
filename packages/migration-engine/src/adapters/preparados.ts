/**
 * Los adaptadores que todavía no traen datos, dichos como lo que son.
 *
 * ## Por qué existen si no funcionan
 *
 * Porque el registro es la única fuente de verdad sobre qué soporta NEXO, y una
 * fuente de verdad que solo enumera lo que ya está hecho no sirve para
 * planificar. Acá está lo que falta, con el motivo, y la UI lo muestra en gris
 * en vez de ofrecerlo.
 *
 * ## La regla que hace que esto no sea marketing
 *
 * Ninguno declara `IMPLEMENTADO`, ninguno aparece en `disponibles()`, y el
 * registro **se niega a aceptar** un adaptador no implementado que no diga qué
 * le falta. Un `extraer` que tira una excepción con el motivo es más honesto
 * que uno que devuelve una tabla vacía: el segundo se ve como un archivo sin
 * datos y manda a buscar el problema al lado equivocado.
 *
 * Esto es lo mismo que ya hacía el catálogo de integraciones, donde Mercado
 * Libre figura `PLANIFICADO` desde que existe la tabla.
 */

import type {
  AdaptadorDeOrigen,
  DescripcionDeAdaptador,
  ResultadoDeExtraccion,
} from '../contrato.js';

/**
 * Un adaptador que existe en el registro y todavía no extrae.
 *
 * No es una clase vacía para aparentar soporte: es la declaración de una
 * capacidad futura, con su estado y su motivo, que la matriz de compatibilidad
 * lee para mostrarla como pendiente.
 */
class AdaptadorPendiente implements AdaptadorDeOrigen {
  constructor(readonly descripcion: DescripcionDeAdaptador) {}

  async extraer(): Promise<ResultadoDeExtraccion> {
    throw new Error(
      `El adaptador ${this.descripcion.codigo} está en estado ${this.descripcion.estado} y no ` +
        `extrae datos. ${this.descripcion.queFalta ?? ''}`.trim(),
    );
  }
}

const sinEntidades = { entidades: [], formatos: [], porTandas: false, reanudable: false, conIdExterno: false } as const;

/**
 * Bases de datos externas.
 *
 * El contrato y el pipeline están; lo que falta es la parte que **no se puede
 * inventar**: a qué tabla de qué sistema corresponde cada entidad. Sin un
 * esquema concreto delante, un adaptador de PostgreSQL solo puede ofrecer
 * «escribí una consulta», y aceptar SQL del navegador es exactamente lo que el
 * §25 prohíbe.
 */
export const ADAPTADOR_BASE_DE_DATOS = new AdaptadorPendiente({
  codigo: 'BASE_DE_DATOS',
  nombre: 'Base de datos externa (PostgreSQL, MySQL, SQL Server, SQLite)',
  medio: 'BASE_DE_DATOS',
  estado: 'PREPARADO',
  capacidades: { ...sinEntidades, porTandas: true, reanudable: true, conIdExterno: true },
  queFalta:
    'Falta el mapa de esquema del sistema de origen: qué tabla y qué columna es cada entidad. ' +
    'Sin eso solo quedaría aceptar consultas SQL escritas desde el navegador, que es lo que ' +
    'la regla de seguridad prohíbe. Con un esquema concreto delante, se implementa.',
});

/**
 * APIs REST y GraphQL.
 *
 * Igual que arriba, y con un agregado: hace falta una credencial real contra un
 * sistema real para poder verificar la paginación, el límite de pedidos y el
 * comportamiento ante errores parciales. Escribir ese adaptador contra la
 * documentación y no contra el servicio es cómo se escriben integraciones que
 * fallan el primer día.
 */
export const ADAPTADOR_API = new AdaptadorPendiente({
  codigo: 'API_REST',
  nombre: 'API externa (REST o GraphQL)',
  medio: 'API',
  estado: 'PREPARADO',
  capacidades: { ...sinEntidades, porTandas: true, reanudable: true, conIdExterno: true },
  queFalta:
    'Falta una credencial contra un servicio real. La paginación, el límite de pedidos y los ' +
    'errores parciales no se pueden verificar contra la documentación: hay que ejercitarlos. ' +
    'La infraestructura de credenciales cifradas ya existe en el Integration Hub.',
});

/**
 * Tango.
 *
 * El sistema más pedido de la plaza, y el ejemplo exacto de la distinción del
 * §4: NEXO puede leer un CSV que exportó Tango **hoy mismo**, con el adaptador
 * genérico y mapeo manual. Lo que no puede es decir que «soporta Tango», porque
 * eso significaría conocer sus nombres de columna, sus códigos de comprobante y
 * su estructura de exportación — y eso se verifica contra una exportación real,
 * no se deduce.
 *
 * En cuanto haya un archivo exportado de Tango en la mano, este adaptador pasa
 * a `IMPLEMENTADO` reconociendo esas columnas, y el mapeo deja de ser manual.
 */
export const ADAPTADOR_TANGO = new AdaptadorPendiente({
  codigo: 'TANGO',
  nombre: 'Tango Gestión',
  medio: 'ARCHIVO',
  estado: 'PLANIFICADO',
  capacidades: { ...sinEntidades, formatos: ['csv', 'xlsx'] },
  queFalta:
    'Falta una exportación real de Tango para conocer sus nombres de columna y sus códigos. ' +
    'Mientras tanto, un archivo exportado de Tango se puede migrar hoy con el adaptador ' +
    'genérico y mapeo manual: lo que falta es el reconocimiento automático, no la capacidad.',
});

/**
 * Los extractos bancarios en formatos de banco.
 *
 * OFX y QIF son estándares y se podrían implementar sin depender de nadie; no
 * están hechos todavía. Un CSV o un XLSX del banco ya se migra con el adaptador
 * genérico.
 */
export const ADAPTADOR_BANCO = new AdaptadorPendiente({
  codigo: 'BANCO_OFX',
  nombre: 'Extracto bancario (OFX, QIF)',
  medio: 'ARCHIVO',
  estado: 'PLANIFICADO',
  capacidades: { ...sinEntidades, formatos: ['ofx', 'qif'] },
  queFalta:
    'OFX y QIF son estándares abiertos y no dependen de nadie: falta escribir el lector. ' +
    'Un extracto en CSV o XLSX ya se migra con el adaptador genérico.',
});

/**
 * Las plataformas de comercio.
 *
 * Están bloqueados, no planificados, y la diferencia importa: no se puede
 * avanzar hasta que exista una cuenta de desarrollador y una credencial. Es la
 * misma dependencia que ya tiene anotada el Integration Hub, donde figuran
 * `PLANIFICADO` con autenticación OAuth2 declarada.
 */
export const ADAPTADOR_COMERCIO = new AdaptadorPendiente({
  codigo: 'COMERCIO_API',
  nombre: 'Plataforma de comercio (Mercado Libre, Tiendanube, Shopify, WooCommerce)',
  medio: 'API',
  estado: 'BLOQUEADO',
  capacidades: { ...sinEntidades, porTandas: true, reanudable: true, conIdExterno: true },
  queFalta:
    'Bloqueado por una cuenta de desarrollador y credenciales OAuth2 en cada plataforma, que ' +
    'son un trámite de Pablo. Una exportación manual de cualquiera de ellas se migra hoy con ' +
    'el adaptador genérico.',
});

export const PENDIENTES: readonly AdaptadorDeOrigen[] = [
  ADAPTADOR_BASE_DE_DATOS,
  ADAPTADOR_API,
  ADAPTADOR_TANGO,
  ADAPTADOR_BANCO,
  ADAPTADOR_COMERCIO,
];
