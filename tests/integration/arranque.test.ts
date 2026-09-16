/**
 * El arranque del servidor.
 *
 * Lo que este archivo defiende:
 *
 *   1. **Que el preflight frene de verdad.** Un servidor levantado contra un
 *      esquema viejo no falla: anda a medias, que es el estado más caro de
 *      diagnosticar. Se ejercita la rama roja, que contra una base al día nunca
 *      se ve — y un candado que nunca se vio frenar no está probado.
 *   2. **Que la rama verde sea verde por haber mirado**, no por no haber
 *      encontrado la tabla: se corre contra la base de tests real, migrada.
 *   3. **Que los modos degradados se vean.** `config.ts` está lleno de defaults
 *      inertes —OCR `none`, ARCA `mock`, IA `none`— que son decisiones
 *      correctas y completamente invisibles desde afuera. Alguien puede
 *      constatar un comprobante contra el mock y creer que habló con ARCA.
 */

import { closePool, initPool } from '@aai/db';
import { migracionesFaltantes, modosDeOperacion, verificarEsquema } from '@aai/api/arranque';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { DATABASE_URL, hasDatabase } from './helpers/db.js';

const suite = hasDatabase ? describe : describe.skip;

/**
 * La IA apagada, con la forma completa que `modosDeOperacion` necesita.
 *
 * Desde que la credencial es una **referencia** y no un valor, la configuración
 * de IA tiene seis campos y no uno. Se declara acá una vez: repetirla en cada
 * caso haría que agregar un campo obligara a tocar cinco fixtures, y el sexto
 * quedaría distinto sin que nadie lo note.
 */
const IA_APAGADA = {
  provider: 'none',
  apiKeyRef: null,
  modelId: null,
  baseUrl: null,
  timeoutMs: 30_000,
  maxRetries: 2,
} as const;

/**
 * El correo apagado, con la forma completa. Mismo criterio que `IA_APAGADA`.
 *
 * **Hay que pasarlo siempre**, y omitirlo no da error: `modoDeCorreo` tiene
 * parámetro por defecto, así que un `undefined` cae en el `config` del proceso
 * en vez de en lo que el caso quiso declarar. El test seguiría en verde
 * midiendo la variable de entorno de quien lo corre, que es justo lo que estos
 * fixtures existen para no hacer. Se descubrió acá mismo, en B2.5.1, cuando
 * `correo` pasó a ser parte de la configuración.
 */
const CORREO_APAGADO = {
  provider: 'none',
  apiKeyRef: null,
  from: null,
  timeoutMs: 10_000,
  maxRetries: 2,
} as const;

/**
 * La pasarela apagada. Vale palabra por palabra lo que dice `CORREO_APAGADO`
 * arriba, y por el mismo motivo: en B2.5.5 el cobro dejó de ser una fila de
 * texto fijo y pasó a salir de la configuración, así que omitirlo acá haría que
 * estos casos midieran el `PAYMENTS_PROVIDER` de quien corre los tests.
 */
const PAGOS_APAGADOS = {
  provider: 'none',
  ambiente: 'sandbox',
  accessTokenRef: null,
  webhookSecretRef: null,
  backUrl: null,
  timeoutMs: 10_000,
  maxRetries: 2,
} as const;

suite('Arranque del servidor', () => {
  beforeAll(() => {
    initPool(DATABASE_URL);
  });

  afterAll(async () => {
    await closePool();
  });

  it('no encuentra nada que falte contra la base de tests, que está migrada', async () => {
    const problemas = await verificarEsquema();
    expect(problemas, `no debería faltar nada: ${JSON.stringify(problemas)}`).toEqual([]);
  });

  it('frena cuando la base quedó atrás y dice cuántas y con qué comando', () => {
    const enDisco = ['0001_a.sql', '0002_b.sql', '0003_c.sql'];
    const problemas = migracionesFaltantes(enDisco, new Set(['0001_a.sql']));

    expect(problemas).toHaveLength(1);
    expect(problemas[0]!.que).toContain('faltan 2 migración(es)');
    expect(problemas[0]!.que).toContain('0002_b.sql');
    // El mensaje sirve si dice qué hacer. Un error que solo describe el estado
    // deja al operador buscando el comando en la documentación.
    expect(problemas[0]!.comoSeArregla).toBe('npm run db:migrate');
  });

  it('con muchas faltantes nombra las primeras y cuenta el resto', () => {
    const enDisco = Array.from({ length: 30 }, (_, i) => `${String(i).padStart(4, '0')}_x.sql`);
    const problemas = migracionesFaltantes(enDisco, new Set());

    expect(problemas[0]!.que).toContain('y 27 más');
  });

  it('no inventa un problema cuando la base está al día', () => {
    expect(migracionesFaltantes(['0001_a.sql'], new Set(['0001_a.sql']))).toEqual([]);
  });

  it('una base con migraciones de más tampoco es un problema', () => {
    // Pasa al volver a una rama anterior. El servidor viejo contra un esquema
    // nuevo funciona: las tablas que usa siguen ahí. Es el caso inverso —código
    // nuevo contra esquema viejo— el que rompe.
    expect(migracionesFaltantes(['0001_a.sql'], new Set(['0001_a.sql', '0002_b.sql']))).toEqual([]);
  });

  it('marca como no reales los modos simulados o apagados', () => {
    const modos = modosDeOperacion({
      arca: { environment: 'mock' },
      ai: IA_APAGADA,
      correo: CORREO_APAGADO,
      pagos: PAGOS_APAGADOS,
      secrets: { provider: 'env' },
      documents: { ocrEngine: 'mock' },
      isProduction: false,
    });

    const porNombre = new Map(modos.map((m) => [m.nombre, m]));
    expect(porNombre.get('ARCA')!.real, 'el mock de ARCA no habló con el organismo').toBe(false);
    expect(porNombre.get('IA')!.real).toBe(false);
    expect(porNombre.get('OCR')!.real, 'un OCR simulado no leyó el documento').toBe(false);
  });

  it('reconoce como real la homologación de ARCA', () => {
    // Homologación es un ambiente de verdad del organismo: los comprobantes no
    // tienen validez fiscal, pero la respuesta la da ARCA y no este código.
    const modos = modosDeOperacion({
      arca: { environment: 'homologacion' },
      ai: IA_APAGADA,
      correo: CORREO_APAGADO,
      pagos: PAGOS_APAGADOS,
      secrets: { provider: 'env' },
      documents: { ocrEngine: 'none' },
      isProduction: false,
    });

    expect(modos.find((m) => m.nombre === 'ARCA')!.real).toBe(true);
  });

  it('informa el entorno, que es lo que cambia el comportamiento de los sobres', () => {
    // No es decorativo: `desenvolver()` se niega a abrir un sobre `local:` con
    // NODE_ENV=production, así que el entorno decide si una credencial de ARCA
    // cargada en desarrollo sigue sirviendo.
    const modos = modosDeOperacion({
      arca: { environment: 'mock' },
      ai: IA_APAGADA,
      correo: CORREO_APAGADO,
      pagos: PAGOS_APAGADOS,
      secrets: { provider: 'env' },
      documents: { ocrEngine: 'none' },
      isProduction: true,
    });

    expect(modos.find((m) => m.nombre === 'entorno')!.valor).toBe('production');
  });

  it('el banner nombra el correo y el cobro, que son los dos apagados de verdad', () => {
    // El defecto que encontró B-2: este banner existe para que ningún modo
    // degradado sea invisible, y recorría solo lo que tiene variable de
    // entorno. Correo y cobro no tienen ninguna —porque no hay nada que
    // configurar— así que los dos únicos que están apagados del todo eran los
    // dos que no se veían.
    const modos = modosDeOperacion({
      arca: { environment: 'produccion' },
      ai: IA_APAGADA,
      correo: CORREO_APAGADO,
      pagos: PAGOS_APAGADOS,
      secrets: { provider: 'env' },
      documents: { ocrEngine: 'none' },
      isProduction: true,
    });

    const porNombre = new Map(modos.map((m) => [m.nombre, m]));
    for (const nombre of ['correo', 'cobro']) {
      const modo = porNombre.get(nombre);
      expect(modo, `el banner no nombra «${nombre}»`).toBeDefined();
      expect(modo!.real, `«${nombre}» no está conectado y el banner dice que sí`).toBe(false);
      // Sin detalle, un `· simulado o apagado` no dice qué falta ni qué pasa
      // mientras tanto, que es lo único accionable de la línea.
      expect(modo!.detalle, `«${nombre}» no dice cuál es la consecuencia`).toBeTruthy();
    }
  });

  it('con Resend configurado, el banner lo dice y el cobro sigue apagado', () => {
    // El control positivo del anterior, y el que prueba que la fila sale de la
    // configuración y no de un texto fijo: sin él, `real: false` constante
    // pasaría los dos casos y el banner mentiría el día que haya proveedor.
    //
    // También comprueba que **inyectar la configuración funciona**: si
    // `modosDeOperacion` ignorara el `correo` que recibe, acá saldría `none`.
    const modos = modosDeOperacion({
      arca: { environment: 'mock' },
      ai: IA_APAGADA,
      correo: {
        provider: 'resend',
        apiKeyRef: 'env:EMAIL_API_KEY',
        from: 'NEXO <hola@ejemplo.invalid>',
        timeoutMs: 10_000,
        maxRetries: 2,
      },
      // `pagos` faltaba acá y estaba en los otros cuatro casos. Sin él, la
      // última afirmación —«conectar el correo no conecta el cobro»— no medía
      // el código: medía el `PAYMENTS_PROVIDER` de quien corría los tests. Dio
      // verde hasta el día que alguien configuró una credencial de sandbox en
      // su `.env`, que es exactamente cuando un test así deja de servir.
      pagos: PAGOS_APAGADOS,
      secrets: { provider: 'env' },
      documents: { ocrEngine: 'none' },
      isProduction: false,
    });

    const porNombre = new Map(modos.map((m) => [m.nombre, m]));
    expect(porNombre.get('correo')!.valor).toBe('resend');
    expect(porNombre.get('correo')!.real).toBe(true);
    // El banner va a la consola del servidor y de ahí al log del contenedor.
    expect(JSON.stringify(porNombre.get('correo'))).not.toContain('EMAIL_API_KEY');
    // Conectar el correo no conecta el cobro.
    expect(porNombre.get('cobro')!.real).toBe(false);
  });

  it('con una pasarela configurada, el banner dice el ambiente y no el token', () => {
    // El control positivo del cobro, equivalente al del correo de arriba y por
    // el mismo motivo: sin él, un `real: false` constante pasaría todos los
    // casos y el banner mentiría el día que haya pasarela.
    const modos = modosDeOperacion({
      arca: { environment: 'mock' },
      ai: IA_APAGADA,
      correo: CORREO_APAGADO,
      pagos: {
        provider: 'mercadopago',
        ambiente: 'sandbox',
        accessTokenRef: 'env:PAYMENTS_ACCESS_TOKEN',
        webhookSecretRef: 'env:PAYMENTS_WEBHOOK_SECRET',
        backUrl: 'https://ejemplo.invalid/volver',
        timeoutMs: 10_000,
        maxRetries: 2,
      },
      secrets: { provider: 'env' },
      documents: { ocrEngine: 'none' },
      isProduction: false,
    });

    const cobro = new Map(modos.map((m) => [m.nombre, m])).get('cobro')!;
    expect(cobro.valor).toBe('mercadopago');
    expect(cobro.real).toBe(true);
    // Qué ambiente es lo más importante de esta línea: en Mercado Pago la URL
    // es la misma para prueba y producción, así que el banner es el único lugar
    // donde alguien puede ver contra qué cuenta está corriendo.
    expect(cobro.detalle).toContain('sandbox');
    // El banner va a la consola y de ahí al log del contenedor. Ni el token ni
    // el secreto de firma, ni siquiera el nombre de sus variables.
    expect(JSON.stringify(cobro)).not.toContain('PAYMENTS_ACCESS_TOKEN');
    expect(JSON.stringify(cobro)).not.toContain('PAYMENTS_WEBHOOK_SECRET');
  });

  it('sin secreto de firma, el banner dice que los cobros no se van a registrar solos', () => {
    // El estado que más fácil pasa desapercibido: hay token, se cobra, y las
    // notificaciones se rechazan porque no hay con qué verificarlas. Todo
    // funciona salvo enterarse.
    const modos = modosDeOperacion({
      arca: { environment: 'mock' },
      ai: IA_APAGADA,
      correo: CORREO_APAGADO,
      pagos: {
        provider: 'mercadopago',
        ambiente: 'production',
        accessTokenRef: 'env:PAYMENTS_ACCESS_TOKEN',
        webhookSecretRef: null,
        backUrl: 'https://ejemplo.invalid/volver',
        timeoutMs: 10_000,
        maxRetries: 2,
      },
      secrets: { provider: 'env' },
      documents: { ocrEngine: 'none' },
      isProduction: true,
    });

    const cobro = new Map(modos.map((m) => [m.nombre, m])).get('cobro')!;
    expect(cobro.detalle).toContain('PAYMENTS_WEBHOOK_SECRET');
    expect(cobro.detalle).toContain('no se van a registrar solos');
  });
});
