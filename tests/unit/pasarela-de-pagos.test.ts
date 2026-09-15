/**
 * El adaptador de Mercado Pago, la fábrica que lo elige, y lo que ninguno de los
 * dos puede dejar escapar.
 *
 * ## Por qué acá no hay ni una llamada real, y esta vez no es solo prudencia
 *
 * **No existe una cuenta de Mercado Pago de NEXO.** Ese es el estado real al
 * escribir esto, y este archivo no lo disimula: todo lo que se ejercita es el
 * adaptador contra un `fetch` inyectado.
 *
 * Pero incluso con cuenta, estos tests seguirían siendo contra un doble. Mercado
 * Pago **usa la misma URL para prueba y producción** y las distingue solo por el
 * prefijo del token: una suite que hablara con la API de verdad estaría a un
 * `.env` mal copiado de crear suscripciones reales y cobrarle a alguien.
 *
 * Toda credencial de este archivo es sintética y lo dice en su propio valor.
 *
 * ## Las tres afirmaciones que conviene no mezclar
 *
 *     conocido     el valor de `PAYMENTS_PROVIDER` es uno de los dos.
 *     configurado  además tiene token y URL de retorno.
 *     conectado    un cobro volvió. **Ninguna variable de entorno puede decir
 *                  esto**, y ningún estado de acá lo afirma.
 */

import { createHmac } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import {
  AMBIENTES_DE_PAGO,
  crearProveedorDePagos,
  estadoDeLosPagos,
  faltantesDeMercadoPago,
  modoDePagos,
  prefijoDeToken,
  problemaDeAmbiente,
  refDelTokenDePagos,
  verificarAmbienteDePagos,
  verificarProveedorDePagos,
  type ConfiguracionDePagos,
} from '@aai/api/pagos/fabrica';
import {
  BASE_DE_MERCADO_PAGO,
  ProveedorDeMercadoPago,
  type FetchLike,
} from '@aai/api/pagos/mercadopago';
import { SinPasarela } from '@aai/api/pagos/puerto';

/**
 * Un token que grita que no es un token.
 *
 * Largo a propósito: `taparValor` no tapa valores cortos —reemplazar cada
 * aparición de un secreto de tres letras destruiría el texto sin proteger nada—
 * así que una credencial de juguete demasiado corta haría pasar los tests de
 * redacción sin que la redacción funcionara.
 */
const TOKEN_SINTETICO = 'APP_USR-TEST_SECRET_ONLY_no_es_un_token_de_verdad';
const TOKEN_DE_PRUEBA = 'TEST-TEST_SECRET_ONLY_tampoco_es_un_token_de_verdad';
const FIRMA_SINTETICA = 'whsec_TEST_SECRET_ONLY_no_es_un_secreto_de_firma';

const CONFIGURADO: ConfiguracionDePagos = {
  provider: 'mercadopago',
  ambiente: 'sandbox',
  accessTokenRef: 'env:PAYMENTS_ACCESS_TOKEN',
  webhookSecretRef: 'env:PAYMENTS_WEBHOOK_SECRET',
  backUrl: 'https://ejemplo.invalid/volver',
  timeoutMs: 5_000,
  maxRetries: 2,
};

const APAGADO: ConfiguracionDePagos = {
  provider: 'none',
  ambiente: 'sandbox',
  accessTokenRef: null,
  webhookSecretRef: null,
  backUrl: null,
  timeoutMs: 5_000,
  maxRetries: 2,
};

/** Un `fetch` que devuelve lo que se le diga y anota lo que recibió. */
function fetchQueDevuelve(
  respuestas: Array<{ ok: boolean; status: number; cuerpo: string } | Error>,
): { fetch: FetchLike; llamadas: Array<{ url: string; init: Parameters<FetchLike>[1] }> } {
  const llamadas: Array<{ url: string; init: Parameters<FetchLike>[1] }> = [];
  let i = 0;
  const fetch: FetchLike = async (url, init) => {
    llamadas.push({ url, init });
    const r = respuestas[Math.min(i, respuestas.length - 1)]!;
    i += 1;
    if (r instanceof Error) throw r;
    return { ok: r.ok, status: r.status, text: async () => r.cuerpo };
  };
  return { fetch, llamadas };
}

function proveedor(
  respuestas: Array<{ ok: boolean; status: number; cuerpo: string } | Error>,
  opciones: { maxRetries?: number; secreto?: string | null } = {},
): {
  mp: ProveedorDeMercadoPago;
  llamadas: Array<{ url: string; init: Parameters<FetchLike>[1] }>;
} {
  const { fetch, llamadas } = fetchQueDevuelve(respuestas);
  const mp = new ProveedorDeMercadoPago({
    accessToken: async () => TOKEN_SINTETICO,
    webhookSecret: async () => opciones.secreto ?? null,
    timeoutMs: 5_000,
    maxRetries: opciones.maxRetries ?? 0,
    fetch,
    // Los tests no duermen.
    esperar: async () => undefined,
  });
  return { mp, llamadas };
}

const ok = (cuerpo: unknown) => ({ ok: true, status: 200, cuerpo: JSON.stringify(cuerpo) });
const error = (status: number, cuerpo: unknown = {}) => ({
  ok: false,
  status,
  cuerpo: JSON.stringify(cuerpo),
});

// ── El adaptador ────────────────────────────────────────────────────────────

describe('el adaptador manda lo que corresponde', () => {
  it('el importe viaja como decimal exacto y no pasa por punto flotante', async () => {
    // El caso que un `Number('...')` en el medio arruinaría. 199_99 centavos
    // tiene que salir como 19999 → "199.99", dígito por dígito.
    const { mp, llamadas } = proveedor([ok({ id: 'plan-1', status: 'active' })]);

    await mp.asegurarPlan({
      codigo: 'COMPLETO',
      nombre: 'Completo',
      importeCentavos: 19_999n,
      moneda: 'ARS',
      periodicidad: 'MENSUAL',
    });

    const cuerpo = llamadas[0]!.init.body!;
    // Como número JSON, sin comillas: es lo que la API espera.
    expect(cuerpo).toContain('"transaction_amount":199.99');
    expect(cuerpo).not.toContain('"199.99"');
    expect(cuerpo).not.toContain('@@importe@@');
  });

  it('un importe con centavos redondos no pierde los ceros al reconstruirse', async () => {
    const { mp, llamadas } = proveedor([ok({ id: 'plan-1', status: 'active' })]);
    await mp.asegurarPlan({
      codigo: 'COMPLETO',
      nombre: 'Completo',
      importeCentavos: 1_000_000n,
      moneda: 'ARS',
      periodicidad: 'ANUAL',
    });
    expect(llamadas[0]!.init.body).toContain('"transaction_amount":10000.00');
    // Anual se expresa en meses, no en una tercera unidad.
    expect(llamadas[0]!.init.body).toContain('"frequency":12');
    expect(llamadas[0]!.init.body).toContain('"frequency_type":"months"');
  });

  it('una moneda que NEXO no conoce no llega a la red', async () => {
    const { mp, llamadas } = proveedor([ok({ id: 'plan-1', status: 'active' })]);
    const r = await mp.asegurarPlan({
      codigo: 'X',
      nombre: 'X',
      importeCentavos: 100n,
      moneda: 'XYZ',
      periodicidad: 'MENSUAL',
    });
    expect(r.ok).toBe(false);
    expect(!r.ok && r.fallo.codigo).toBe('PEDIDO_INVALIDO');
    // Y sobre todo: no se llamó. Una excepción escapada habría subido al ciclo
    // de facturación, que la trataría como una caída del proveedor.
    expect(llamadas).toHaveLength(0);
  });

  it('la suscripción viaja con la referencia de NEXO y no con el correo como clave', async () => {
    const { mp, llamadas } = proveedor([
      ok({ id: 'sub-1', status: 'pending', init_point: 'https://mp.invalid/ir' }),
    ]);

    await mp.crearSuscripcion({
      referenciaNexo: 'suscripcion:0193abc',
      planExternoId: 'plan-1',
      correoDelPagador: 'alguien@prueba.local',
      importeCentavos: 19_999n,
      moneda: 'ARS',
      urlDeRetorno: 'https://ejemplo.invalid/volver',
    });

    const cuerpo = llamadas[0]!.init.body!;
    expect(cuerpo).toContain('"external_reference":"suscripcion:0193abc"');
    // Se pide `pending`: pedir `authorized` requeriría un `card_token_id`, o sea
    // que NEXO tocara la tarjeta.
    expect(cuerpo).toContain('"status":"pending"');
    expect(llamadas[0]!.url).toBe(`${BASE_DE_MERCADO_PAGO}/preapproval`);
  });

  it('el token va en la cabecera y en ningún otro lado', async () => {
    const { mp, llamadas } = proveedor([ok({ id: 'sub-1', status: 'authorized' })]);
    await mp.consultarSuscripcion('sub-1');

    expect(llamadas[0]!.init.headers['authorization']).toBe(`Bearer ${TOKEN_SINTETICO}`);
    expect(llamadas[0]!.url).not.toContain(TOKEN_SINTETICO);
    expect(llamadas[0]!.init.body ?? '').not.toContain(TOKEN_SINTETICO);
  });

  it('pausar, reactivar y cancelar son el mismo PUT con otro estado', async () => {
    for (const [metodo, esperado] of [
      ['pausarSuscripcion', 'paused'],
      ['reactivarSuscripcion', 'authorized'],
      ['cancelarSuscripcion', 'cancelled'],
    ] as const) {
      const { mp, llamadas } = proveedor([ok({ id: 'sub-1', status: esperado })]);
      await mp[metodo]('sub-1');
      expect(llamadas[0]!.init.method).toBe('PUT');
      expect(llamadas[0]!.init.body).toBe(JSON.stringify({ status: esperado }));
    }
  });

  it('el identificador se escapa antes de entrar en la URL', async () => {
    const { mp, llamadas } = proveedor([ok({ id: 'x', status: 'authorized' })]);
    await mp.consultarSuscripcion('../../v1/payments/1');
    expect(llamadas[0]!.url).not.toContain('../');
  });
});

describe('el adaptador clasifica los fallos por lo que hay que hacer', () => {
  it('401 y 403 son problema de quien administra, no del cobro', async () => {
    for (const status of [401, 403]) {
      const { mp } = proveedor([error(status, { message: 'invalid token' })]);
      const r = await mp.consultarPago('1');
      expect(!r.ok && r.fallo.codigo).toBe('CREDENCIAL_RECHAZADA');
    }
  });

  it('cada código HTTP cae donde corresponde', async () => {
    for (const [status, codigo] of [
      [404, 'NO_ENCONTRADO'],
      [409, 'CONFLICTO'],
      [429, 'LIMITE_DE_TASA'],
      [400, 'PEDIDO_INVALIDO'],
      [422, 'PEDIDO_INVALIDO'],
      [500, 'PROVEEDOR_CAIDO'],
      [503, 'PROVEEDOR_CAIDO'],
    ] as const) {
      const { mp } = proveedor([error(status)]);
      const r = await mp.consultarSuscripcion('sub-1');
      expect(!r.ok && r.fallo.codigo, `${status} no clasifica bien`).toBe(codigo);
      expect(!r.ok && r.fallo.status).toBe(status);
    }
  });

  it('un cuerpo que no es JSON es RESPUESTA_ILEGIBLE y no un éxito vacío', async () => {
    const { mp } = proveedor([{ ok: true, status: 200, cuerpo: '<html>502 Bad Gateway</html>' }]);
    const r = await mp.consultarPago('1');
    expect(!r.ok && r.fallo.codigo).toBe('RESPUESTA_ILEGIBLE');
  });

  it('un estado que Mercado Pago no documentaba tampoco se aproxima', async () => {
    // Lo más importante de este bloque: un `default` habría mapeado esto a algo
    // plausible, y ese «algo plausible» sería una afirmación sobre el estado de
    // cobro de un cliente que nadie verificó.
    const { mp } = proveedor([ok({ id: 'sub-1', status: 'suspended_by_provider' })]);
    const r = await mp.consultarSuscripcion('sub-1');
    expect(!r.ok && r.fallo.codigo).toBe('RESPUESTA_ILEGIBLE');
    expect(!r.ok && r.fallo.detalle).toContain('suspended_by_provider');
  });

  it('una respuesta sin id no se da por buena', async () => {
    const { mp } = proveedor([ok({ status: 'authorized' })]);
    const r = await mp.consultarSuscripcion('sub-1');
    expect(!r.ok && r.fallo.codigo).toBe('RESPUESTA_ILEGIBLE');
  });

  it('un fallo de red no es una caída del proveedor', async () => {
    const { mp } = proveedor([Object.assign(new Error('ECONNREFUSED'), { name: 'Error' })]);
    const r = await mp.consultarPago('1');
    expect(!r.ok && r.fallo.codigo).toBe('RED');
  });

  it('un timeout se distingue de todo lo demás', async () => {
    const { mp } = proveedor([Object.assign(new Error('abortado'), { name: 'AbortError' })]);
    const r = await mp.crearSuscripcion({
      referenciaNexo: 'x',
      planExternoId: 'p',
      correoDelPagador: 'a@b.local',
      importeCentavos: 100n,
      moneda: 'ARS',
      urlDeRetorno: 'https://ejemplo.invalid/v',
    });
    expect(!r.ok && r.fallo.codigo).toBe('TIMEOUT');
    expect(!r.ok && r.fallo.detalle).toContain('cobrar dos veces');
  });
});

describe('el adaptador no reintenta lo que podría cobrar dos veces', () => {
  it('una LECTURA sí se reintenta ante un 5xx', async () => {
    const { mp, llamadas } = proveedor(
      [error(500), error(500), ok({ id: 'sub-1', status: 'authorized' })],
      { maxRetries: 2 },
    );
    const r = await mp.consultarSuscripcion('sub-1');
    expect(r.ok).toBe(true);
    expect(llamadas).toHaveLength(3);
  });

  it('una ESCRITURA NO se reintenta ante un 5xx', async () => {
    // **El control más importante del archivo.** Un 500 al crear una suscripción
    // pudo ocurrir después de haberla creado; repetirlo deja dos cobrándole a la
    // misma empresa todos los meses.
    const { mp, llamadas } = proveedor(
      [error(500), ok({ id: 'sub-1', status: 'pending' })],
      { maxRetries: 3 },
    );
    const r = await mp.crearSuscripcion({
      referenciaNexo: 'x',
      planExternoId: 'p',
      correoDelPagador: 'a@b.local',
      importeCentavos: 100n,
      moneda: 'ARS',
      urlDeRetorno: 'https://ejemplo.invalid/v',
    });
    expect(r.ok).toBe(false);
    expect(llamadas, 'se reintentó una escritura después de un 5xx').toHaveLength(1);
  });

  it('una ESCRITURA sí se reintenta ante un 429, que se rechaza antes de procesar', async () => {
    const { mp, llamadas } = proveedor([error(429), ok({ id: 'sub-1', status: 'pending' })], {
      maxRetries: 2,
    });
    const r = await mp.crearSuscripcion({
      referenciaNexo: 'x',
      planExternoId: 'p',
      correoDelPagador: 'a@b.local',
      importeCentavos: 100n,
      moneda: 'ARS',
      urlDeRetorno: 'https://ejemplo.invalid/v',
    });
    expect(r.ok).toBe(true);
    expect(llamadas).toHaveLength(2);
  });

  it('un timeout no se reintenta ni siquiera leyendo', async () => {
    const { mp, llamadas } = proveedor(
      [Object.assign(new Error('abort'), { name: 'AbortError' })],
      { maxRetries: 3 },
    );
    await mp.consultarPago('1');
    expect(llamadas).toHaveLength(1);
  });
});

describe('nada de lo que sale del adaptador lleva la credencial', () => {
  it('ni el mensaje de error del proveedor, ni el de red', async () => {
    // El caso real que esto ataja: varios proveedores devuelven el pedido
    // completo dentro del error, con la cabecera de autorización adentro.
    const { mp } = proveedor([
      error(400, { message: `falló con Authorization: Bearer ${TOKEN_SINTETICO}` }),
    ]);
    const r = await mp.consultarPago('1');
    expect(!r.ok && r.fallo.detalle).not.toContain(TOKEN_SINTETICO);

    const { mp: mp2 } = proveedor([new Error(`conexión a ...?token=${TOKEN_SINTETICO} falló`)]);
    const r2 = await mp2.consultarPago('1');
    expect(!r2.ok && r2.fallo.detalle).not.toContain(TOKEN_SINTETICO);
  });

  it('no se lee el importe que devuelve la pasarela', async () => {
    // No es un olvido: leerlo obligaría a multiplicar un `double` por cien, que
    // es lo que la Regla 4 existe para impedir.
    const { mp } = proveedor([
      ok({
        id: 9_001,
        status: 'approved',
        preapproval_id: 'sub-1',
        transaction_amount: 199.99,
        currency_id: 'ARS',
        payment_method_id: 'visa',
        card: { last_four_digits: '4242', cardholder: { name: 'QUIEN SEA' } },
      }),
    ]);
    const r = await mp.consultarPago('9001');
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.valor.importeCentavos).toBeNull();
    // Lo que sí se guarda del medio de pago, y nada más.
    expect(r.valor.medio).toBe('visa');
    expect(r.valor.ultimos4).toBe('4242');
    // El id numérico se normaliza a texto, porque la columna es texto.
    expect(r.valor.id).toBe('9001');
    expect(r.valor.estado).toBe('PAGADO');
    expect(JSON.stringify(r.valor)).not.toContain('QUIEN SEA');
  });
});

// ── La firma de los webhooks ────────────────────────────────────────────────

describe('la firma de una notificación', () => {
  const manifiesto = (id: string, requestId: string | undefined, ts: string): string =>
    `id:${id};` + (requestId === undefined ? '' : `request-id:${requestId};`) + `ts:${ts};`;

  const firmar = (id: string, requestId: string | undefined, ts: string): string =>
    createHmac('sha256', FIRMA_SINTETICA).update(manifiesto(id, requestId, ts)).digest('hex');

  it('una firma correcta verifica', async () => {
    const { mp } = proveedor([], { secreto: FIRMA_SINTETICA });
    const r = await mp.verificarFirma({
      cabeceras: {
        'x-signature': `ts=1700000000,v1=${firmar('9001', 'req-1', '1700000000')}`,
        'x-request-id': 'req-1',
      },
      cuerpoCrudo: '{}',
      recursoId: '9001',
    });
    expect(r).toBe(true);
  });

  it('cambiar el recurso invalida la firma', async () => {
    // Es lo que impide tomar la firma de una notificación real y pegarla en una
    // inventada sobre otro pago.
    const { mp } = proveedor([], { secreto: FIRMA_SINTETICA });
    const r = await mp.verificarFirma({
      cabeceras: {
        'x-signature': `ts=1700000000,v1=${firmar('9001', 'req-1', '1700000000')}`,
        'x-request-id': 'req-1',
      },
      cuerpoCrudo: '{}',
      recursoId: '9002',
    });
    expect(r).toBe(false);
  });

  it('sin secreto configurado devuelve null y NO false', async () => {
    // La distinción que evita que una instalación incompleta genere alertas de
    // suplantación todo el día — y que nadie las mire el día que sean ciertas.
    const { mp } = proveedor([], { secreto: null });
    const r = await mp.verificarFirma({
      cabeceras: { 'x-signature': 'ts=1,v1=deadbeef' },
      cuerpoCrudo: '{}',
      recursoId: '1',
    });
    expect(r).toBeNull();
  });

  it('con secreto configurado, una notificación SIN firma es false', async () => {
    // Se espera que venga firmada: la ausencia de firma es exactamente lo que se
    // está filtrando.
    const { mp } = proveedor([], { secreto: FIRMA_SINTETICA });
    expect(
      await mp.verificarFirma({ cabeceras: {}, cuerpoCrudo: '{}', recursoId: '1' }),
    ).toBe(false);
  });

  it('una cabecera rota no rompe nada', async () => {
    const { mp } = proveedor([], { secreto: FIRMA_SINTETICA });
    for (const cabecera of ['', 'basura', 'ts=1', 'v1=abc', 'ts=1,v1=no-es-hexadecimal']) {
      expect(
        await mp.verificarFirma({
          cabeceras: { 'x-signature': cabecera },
          cuerpoCrudo: '{}',
          recursoId: '1',
        }),
        `«${cabecera}» no debería verificar`,
      ).toBe(false);
    }
  });

  it('un hash del largo equivocado no tira: contesta false', async () => {
    // `timingSafeEqual` lanza si los largos difieren. Comprobarlo antes es lo
    // que evita que una firma recortada produzca un 500 en vez de un rechazo.
    const { mp } = proveedor([], { secreto: FIRMA_SINTETICA });
    expect(
      await mp.verificarFirma({
        cabeceras: { 'x-signature': 'ts=1,v1=aabb' },
        cuerpoCrudo: '{}',
        recursoId: '1',
      }),
    ).toBe(false);
  });

  it('el sello de tiempo entra en el manifiesto', async () => {
    // Sin el `ts` adentro, una firma capturada se podría reusar tal cual.
    const { mp } = proveedor([], { secreto: FIRMA_SINTETICA });
    const r = await mp.verificarFirma({
      cabeceras: {
        'x-signature': `ts=1700000099,v1=${firmar('9001', 'req-1', '1700000000')}`,
        'x-request-id': 'req-1',
      },
      cuerpoCrudo: '{}',
      recursoId: '9001',
    });
    expect(r).toBe(false);
  });

  it('sin x-request-id el segmento se omite entero', async () => {
    const { mp } = proveedor([], { secreto: FIRMA_SINTETICA });
    const r = await mp.verificarFirma({
      cabeceras: { 'x-signature': `ts=1700000000,v1=${firmar('9001', undefined, '1700000000')}` },
      cuerpoCrudo: '{}',
      recursoId: '9001',
    });
    expect(r).toBe(true);
  });
});

// ── La fábrica ──────────────────────────────────────────────────────────────

describe('de dónde sale la pasarela', () => {
  it('sin proveedor devuelve SinPasarela y no tira', () => {
    expect(crearProveedorDePagos({ pagos: APAGADO })).toBeInstanceOf(SinPasarela);
    expect(estadoDeLosPagos(APAGADO)).toBe('DESHABILITADO');
  });

  it('preparado tampoco tira: el ciclo tiene que poder seguir facturando', () => {
    const preparado = { ...CONFIGURADO, backUrl: null };
    expect(estadoDeLosPagos(preparado)).toBe('PREPARADO');
    expect(crearProveedorDePagos({ pagos: preparado })).toBeInstanceOf(SinPasarela);
    // Y dice **qué** falta, con el nombre de la variable: «preparado» a secas
    // obliga a adivinar entre tres.
    expect(faltantesDeMercadoPago(preparado)).toEqual(['PAYMENTS_BACK_URL']);
  });

  it('el secreto de firma no hace falta para cobrar, y su ausencia se dice', () => {
    const sinFirma = { ...CONFIGURADO, webhookSecretRef: null };
    expect(estadoDeLosPagos(sinFirma)).toBe('CONFIGURADO');
    expect(modoDePagos(sinFirma).detalle).toContain('no se van a registrar solos');
  });

  it('un proveedor desconocido impide arrancar', () => {
    for (const malo of ['mercadoPago', 'mercado_pago', 'stripe', '']) {
      expect(verificarProveedorDePagos({ ...APAGADO, provider: malo })).toContain(malo);
    }
    expect(verificarProveedorDePagos(APAGADO)).toBeNull();
    expect(verificarProveedorDePagos(CONFIGURADO)).toBeNull();
    expect(() => crearProveedorDePagos({ pagos: { ...APAGADO, provider: 'stripe' } })).toThrow();
  });

  it('SinPasarela contesta SIN_PASARELA en todo y null en la firma', async () => {
    const sin = new SinPasarela();
    const operaciones = [
      sin.asegurarPlan(),
      sin.crearSuscripcion(),
      sin.consultarSuscripcion(),
      sin.pausarSuscripcion(),
      sin.reactivarSuscripcion(),
      sin.cancelarSuscripcion(),
      sin.consultarPago(),
    ];
    for (const op of operaciones) {
      const r = await op;
      expect(r.ok).toBe(false);
      expect(!r.ok && r.fallo.codigo).toBe('SIN_PASARELA');
    }
    // `null` y no `false`: sin proveedor no hay nada que verificar, y decir
    // `false` haría que el webhook registrara «firma inválida».
    expect(await sin.verificarFirma()).toBeNull();
  });

  it('la referencia al secreto no lleva empresa', () => {
    // La pasarela es del despliegue: NEXO cobra sus propias suscripciones con su
    // propia cuenta, y las empresas clientes no cobran a través de NEXO.
    expect(refDelTokenDePagos('env:PAYMENTS_ACCESS_TOKEN', 'access-token')).toEqual({
      companyId: null,
      scope: 'env',
      name: 'PAYMENTS_ACCESS_TOKEN',
    });
    // Sin prefijo se asume el entorno: es lo que alguien escribe primero.
    expect(refDelTokenDePagos('PAYMENTS_ACCESS_TOKEN', 'access-token').scope).toBe('env');
    expect(refDelTokenDePagos('kms:arn:algo', 'access-token')).toEqual({
      companyId: null,
      scope: 'pagos',
      name: 'access-token',
    });
  });
});

describe('el ambiente declarado y la credencial que hay', () => {
  it('sandbox con un token de producción impide arrancar', () => {
    // El error que de verdad ocurre: creer que se está probando y estar
    // cobrando. Mercado Pago usa la misma URL para los dos ambientes, así que no
    // hay ninguna otra barrera.
    const problema = problemaDeAmbiente('sandbox', prefijoDeToken(TOKEN_SINTETICO));
    expect(problema).toContain('mueve plata real');
  });

  it('production con un token de prueba también', () => {
    // El opuesto es menos peligroso y igual de invisible: no entra ningún cobro
    // y nada falla.
    const problema = problemaDeAmbiente('production', prefijoDeToken(TOKEN_DE_PRUEBA));
    expect(problema).toContain('no va a entrar');
  });

  it('las combinaciones correctas no molestan', () => {
    expect(problemaDeAmbiente('sandbox', prefijoDeToken(TOKEN_DE_PRUEBA))).toBeNull();
    expect(problemaDeAmbiente('production', prefijoDeToken(TOKEN_SINTETICO))).toBeNull();
  });

  it('un prefijo desconocido no se rechaza: no se puede afirmar nada', () => {
    // Mercado Pago puede cambiar sus prefijos. Romperle el arranque a una
    // instalación que funciona por un cambio cosmético del proveedor sería peor
    // que el problema que este control resuelve.
    for (const ambiente of AMBIENTES_DE_PAGO) {
      expect(problemaDeAmbiente(ambiente, 'OTRA-COSA')).toBeNull();
    }
  });

  it('un ambiente que no es ninguno de los dos impide arrancar', () => {
    // `PAYMENTS_ENV=prod` —así, abreviado— dejaría de coincidir con
    // `ambiente_pago` en la base y ninguna suscripción se podría consultar.
    expect(problemaDeAmbiente('prod', '')).toContain('no es un ambiente conocido');
    expect(problemaDeAmbiente('', '')).toContain('no es un ambiente conocido');
  });

  it('el prefijo que se compara no alcanza para reconstruir el token', () => {
    expect(prefijoDeToken(TOKEN_SINTETICO).length).toBeLessThan(10);
    expect(TOKEN_SINTETICO).not.toBe(prefijoDeToken(TOKEN_SINTETICO));
  });

  it('sin pasarela configurada solo se comprueba el ambiente', async () => {
    expect(await verificarAmbienteDePagos(APAGADO)).toBeNull();
    expect(await verificarAmbienteDePagos({ ...APAGADO, ambiente: 'prod' })).toContain(
      'no es un ambiente conocido',
    );
  });

  it('un gestor que no puede resolver el token no impide arrancar', async () => {
    // No es un error de ambiente sino de configuración de secretos, se ve en la
    // primera llamada, y dejar caído todo el ERP por no poder *comprobar* una
    // integración opcional sería desproporcionado.
    const roto = {
      get: async () => {
        throw new Error('no está');
      },
    };
    expect(
      await verificarAmbienteDePagos(CONFIGURADO, roto as never),
    ).toBeNull();
  });

  it('con el gestor andando, el desajuste se detecta', async () => {
    const gestor = { get: async () => ({ valor: TOKEN_SINTETICO }) };
    expect(await verificarAmbienteDePagos(CONFIGURADO, gestor as never)).toContain(
      'mueve plata real',
    );
  });
});
