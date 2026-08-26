/**
 * Lint de arquitectura — hace cumplir los ADR en el grafo de dependencias.
 *
 * La regla más importante del producto (ADR-001: la IA no escribe en la
 * contabilidad) no se sostiene con disciplina del equipo. Se sostiene porque no
 * existe una arista en el grafo de módulos que lo permita, y porque el build
 * falla si alguien la crea.
 *
 * Verificado por tests/security/adr-001.test.ts, que introduce una violación real
 * y comprueba que el lint se cae.
 */

// Los paquetes del dominio contable, tal como pueden aparecer resueltos: por ruta
// del workspace o a través del symlink que npm crea en node_modules.
const MOTOR_CONTABLE =
  '^(packages/(accounting-engine|tax-engine|bank-engine|financial-statements)|' +
  'node_modules/@aai/(accounting-engine|tax-engine|bank-engine|financial-statements))';

const CLIENTE_DE_BASE =
  '^(packages/db|node_modules/(@aai/db|pg|postgres|prisma|@prisma|knex|typeorm|drizzle-orm))';

const CLIENTE_DE_RED = '^node_modules/(axios|node-fetch|undici|got|superagent)';

// Los agentes reciben contexto ya resuelto; no consultan al organismo por su
// cuenta. Si lo hicieran, saltearían la bitácora de consultas y el modelo de
// capacidades por empresa.
const CLIENTE_ARCA = '^(packages/arca|node_modules/@aai/arca)';

// El motor documental escribe en el object storage y decide qué se archiva. Un
// agente que pudiera invocarlo saltearía la bitácora de ingesta y podría
// producir documentos sin actor humano detrás.
const MOTOR_DOCUMENTAL = '^(packages/document-engine|node_modules/@aai/document-engine)';

/** @type {import('dependency-cruiser').IConfiguration} */
module.exports = {
  forbidden: [
    {
      name: 'adr-001-ai-no-escribe-contabilidad',
      comment:
        'ADR-001: ningún agente de IA puede alcanzar el motor contable, el motor fiscal ' +
        'ni un cliente de base de datos. La IA solo produce filas en ai_predictions y su ' +
        'propuesta atraviesa la Validation Layer. Si necesitás esta dependencia, el ' +
        'diseño está roto: revisá AI_ARCHITECTURE.md §1.',
      severity: 'error',
      from: { path: '^packages/ai-engine' },
      to: { path: `${MOTOR_CONTABLE}|${CLIENTE_DE_BASE}|${CLIENTE_ARCA}|${MOTOR_DOCUMENTAL}` },
    },
    {
      name: 'motor-normativo-independiente-de-ia',
      comment:
        'NORMATIVE_ENGINE.md: el motor de normativa es independiente del motor de IA. ' +
        'Si importara un agente, la vigencia de una norma pasaría a depender de la ' +
        'salida de un modelo.',
      severity: 'error',
      from: { path: '^packages/normative-engine' },
      to: { path: '^(packages/ai-engine|node_modules/@aai/ai-engine)' },
    },
    {
      name: 'dominio-sin-io',
      comment:
        'Los paquetes de dominio son funciones puras sobre datos: sin red, sin disco, ' +
        'sin base. Es la condición para poder testearlos de forma exhaustiva.',
      severity: 'error',
      from: { path: '^packages/(accounting-engine|tax-engine|normative-engine|bank-engine|audit-engine|financial-statements|sandbox|shared)' },
      to: { path: `${CLIENTE_DE_BASE}|${CLIENTE_DE_RED}` },
    },
    {
      name: 'sandbox-no-abre-conexiones',
      comment:
        'El candado del §34 decide si un destino probó ser un sandbox; no es quien ' +
        'lo consulta. Si este paquete abriera la conexión, el mismo módulo que ' +
        'juzga el aislamiento podría escribir en el destino que está juzgando, y la ' +
        'garantía se sostendría en que nadie agregue una línea. La conexión la abre ' +
        '`scripts/sandbox.mjs` y le pasa lo que observó. Ver packages/sandbox/src/aislamiento.ts.',
      severity: 'error',
      from: { path: '^packages/sandbox' },
      to: { path: `${CLIENTE_DE_BASE}|${CLIENTE_DE_RED}` },
    },
    {
      name: 'dominio-no-depende-de-apps',
      comment: 'La dependencia va en un solo sentido: apps → packages, nunca al revés.',
      severity: 'error',
      from: { path: '^packages' },
      to: { path: '^apps' },
    },
    {
      name: 'sin-dependencias-circulares',
      severity: 'error',
      from: {},
      to: { circular: true },
    },
    {
      name: 'sin-dependencias-de-desarrollo-en-produccion',
      severity: 'error',
      from: { path: '^(packages|apps)', pathNot: '\\.test\\.ts$' },
      to: { dependencyTypes: ['npm-dev'] },
    },
  ],

  options: {
    // No se recorre hacia adentro de node_modules ni de dist, pero las aristas
    // HACIA ellos sí se reportan: son justamente las que las reglas vigilan.
    doNotFollow: { path: '(^|/)(node_modules|dist)(/|$)' },
    // `exclude` saca módulos del grafo por completo. Nunca poner node_modules acá:
    // haría invisibles las dependencias prohibidas en vez de detectarlas.
    exclude: { path: '(^|/)(coverage|\\.turbo)(/|$)' },
    tsPreCompilationDeps: true,
    enhancedResolveOptions: {
      exportsFields: ['exports'],
      conditionNames: ['import', 'require', 'node', 'default', 'types'],
      extensions: ['.js', '.ts', '.mjs'],
    },
    reporterOptions: {
      text: { highlightFocused: true },
    },
  },
};
