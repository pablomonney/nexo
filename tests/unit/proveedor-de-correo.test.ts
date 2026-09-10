/**
 * El adaptador de Resend, la fábrica que lo elige y lo que ninguno de los dos
 * puede dejar escapar.
 *
 * ## Por qué acá no hay ni una llamada real
 *
 * Un test que hablara con Resend necesitaría una credencial en el repositorio,
 * mandaría correo de verdad a direcciones inventadas, gastaría cupo y —lo que
 * más importa— **no podría afirmar nada**: no hay forma de preguntarle a la API
 * si el cuerpo que salió tenía el token adentro. Se inyecta `fetch`, que es el
 * mismo mecanismo que usan el cliente SOAP de ARCA y el proveedor de modelo, y
 * que además permite comprobar exactamente qué se mandó.
 *
 * Toda credencial de este archivo es sintética y lo dice en su propio valor.
 *
 * ## Las tres afirmaciones que conviene no mezclar
 *
 *     conocido     el valor de `EMAIL_PROVIDER` es uno de los dos.
 *     configurado  además tiene credencial y remitente.
 *     conectado    un envío volvió con su id. **Esto no lo puede decir una
 *                  variable de entorno**, y ningún estado de acá lo afirma.
 */

import { describe, expect, it } from 'vitest';
import {
  crearProveedorDeCorreo,
  estadoDelCorreo,
  faltantesDeResend,
  modoDeCorreo,
  refDeLaClaveDeCorreo,
  verificarProveedorDeCorreo,
  type ConfiguracionDeCorreo,
} from '@aai/api/correo/fabrica';
import { ProveedorDeResend, type FetchLike } from '@aai/api/correo/resend';
import { SinProveedorDeCorreo, type Mensaje } from '@aai/api/correo/puerto';

/**
 * Una clave que grita que no es una clave.
 *
 * Tiene más de ocho caracteres a propósito: `taparValor` no tapa valores cortos
 * —reemplazar cada aparición de un secreto de tres letras destruiría el texto
 * sin proteger nada— así que una credencial de juguete demasiado corta haría
 * pasar los tests de redacción sin que la redacción funcionara.
 */
const CLAVE_SINTETICA = 're_TEST_SECRET_ONLY_no_es_una_credencial';

/** El token que un mensaje de verificación lleva adentro. */
const TOKEN_SINTETICO = 'TOKEN_DE_PRUEBA_9f3c1a7e5b2d4008';

const MENSAJE: Mensaje = {
  destinatario: 'alguien@prueba.local',
  asunto: 'Confirmá tu dirección para entrar a NEXO',
  cuerpo: `Hola,\n\nCopiá este código:\n\n${TOKEN_SINTETICO}\n\nVence en 24 horas.`,
  tipo: 'VERIFICACION_DE_ALTA',
};

const CONFIGURADO: ConfiguracionDeCorreo = {
  provider: 'resend',
  apiKeyRef: 'env:EMAIL_API_KEY',
  from: 'NEXO <hola@ejemplo.invalid>',
  timeoutMs: 5_000,
  maxRetries: 2,
};

/** Un `fetch` que contesta lo que se le diga y anota con qué lo llamaron. */
function fetchQueContesta(
  respuestas: readonly { status: number; cuerpo: string }[],
): { fetch: FetchLike; llamadas: { url: string; headers: Record<string, string>; body: string }[] } {
  const llamadas: { url: string; headers: Record<string, string>; body: string }[] = [];
  let i = 0;
  const fetch: FetchLike = async (url, init) => {
    llamadas.push({ url, headers: init.headers, body: init.body });
    const r = respuestas[Math.min(i, respuestas.length - 1)]!;
    i += 1;
    return { ok: r.status >= 200 && r.status < 300, status: r.status, text: async () => r.cuerpo };
  };
  return { fetch, llamadas };
}

/** Un proveedor listo para usar, con el `fetch` que se le pase. */
function resendCon(fetch: FetchLike, extra: { maxRetries?: number; timeoutMs?: number } = {}) {
  return new ProveedorDeResend({
    apiKey: async () => CLAVE_SINTETICA,
    from: CONFIGURADO.from!,
    timeoutMs: extra.timeoutMs ?? 5_000,
    maxRetries: extra.maxRetries ?? 0,
    fetch,
    // Los tests no duermen: sin esto, tres reintentos con backoff tardan casi
    // un segundo por caso y la suite paga por no haber inyectado el reloj.
    esperar: async () => undefined,
  });
}

describe('el adaptador de Resend', () => {
  it('manda el mensaje y devuelve ENVIADO con el id que dio Resend', async () => {
    const { fetch, llamadas } = fetchQueContesta([
      { status: 200, cuerpo: JSON.stringify({ id: '4ef9a417-02e9-4d39-ad75-9611e0fcc33c' }) },
    ]);

    const r = await resendCon(fetch).enviar(MENSAJE);

    expect(r.estado).toBe('ENVIADO');
    if (r.estado !== 'ENVIADO') return;
    // La referencia es lo único que permite rastrear el envío después. Si el
    // adaptador la perdiera, `email_outbox` guardaría un ENVIADO que no se
    // puede seguir hasta el proveedor.
    expect(r.referencia).toBe('4ef9a417-02e9-4d39-ad75-9611e0fcc33c');
    expect(r.proveedor).toBe('resend');
    expect(r.intentos).toBe(1);

    // Y se mandó lo que se dijo que se iba a mandar.
    const enviado = JSON.parse(llamadas[0]!.body) as Record<string, unknown>;
    expect(enviado['from']).toBe(CONFIGURADO.from);
    expect(enviado['to']).toEqual([MENSAJE.destinatario]);
    expect(enviado['subject']).toBe(MENSAJE.asunto);
    expect(enviado['text']).toBe(MENSAJE.cuerpo);
    expect(llamadas[0]!.headers['authorization']).toBe(`Bearer ${CLAVE_SINTETICA}`);
  });

  it('aceptar sin id es FALLIDO, no ENVIADO', async () => {
    // Decir ENVIADO con la referencia vacía sería afirmar más de lo que se
    // sabe, y el CHECK de la 0103 tampoco lo aceptaría.
    const { fetch } = fetchQueContesta([{ status: 200, cuerpo: JSON.stringify({ ok: true }) }]);
    const r = await resendCon(fetch).enviar(MENSAJE);
    expect(r.estado).toBe('FALLIDO');
    if (r.estado !== 'FALLIDO') return;
    expect(r.detalle).toContain('RESPUESTA_ILEGIBLE');
  });

  it('un 422 es problema del mensaje y no de la instalación', async () => {
    const { fetch } = fetchQueContesta([
      { status: 422, cuerpo: JSON.stringify({ message: 'The from address is not verified' }) },
    ]);

    const r = await resendCon(fetch).enviar(MENSAJE);

    expect(r.estado).toBe('FALLIDO');
    if (r.estado !== 'FALLIDO') return;
    expect(r.detalle).toContain('MENSAJE_RECHAZADO');
    expect(r.detalle).toContain('422');
    // El motivo del proveedor se conserva: sin él, quien lea la bandeja dentro
    // de una semana no tiene otra fuente.
    expect(r.detalle).toContain('not verified');
  });

  it('un 401 se distingue: lo arregla quien administra, no quien se registró', async () => {
    const { fetch } = fetchQueContesta([{ status: 401, cuerpo: '{}' }]);
    const r = await resendCon(fetch).enviar(MENSAJE);
    expect(r.estado).toBe('FALLIDO');
    if (r.estado !== 'FALLIDO') return;
    expect(r.detalle).toContain('CREDENCIAL_RECHAZADA');
  });

  it('reintenta un 429 y lo dice en intentos', async () => {
    const { fetch, llamadas } = fetchQueContesta([
      { status: 429, cuerpo: '{}' },
      { status: 429, cuerpo: '{}' },
      { status: 200, cuerpo: JSON.stringify({ id: 'id-al-tercer-intento' }) },
    ]);

    const r = await resendCon(fetch, { maxRetries: 2 }).enviar(MENSAJE);

    expect(r.estado).toBe('ENVIADO');
    if (r.estado !== 'ENVIADO') return;
    expect(llamadas).toHaveLength(3);
    // `intentos` es una columna de trazabilidad: si dijera 1, quien lea la
    // bandeja no vería que el proveedor estuvo limitando.
    expect(r.intentos).toBe(3);
  });

  it('NO reintenta un 422: sale igual mil veces', async () => {
    const { fetch, llamadas } = fetchQueContesta([{ status: 422, cuerpo: '{}' }]);
    const r = await resendCon(fetch, { maxRetries: 3 }).enviar(MENSAJE);
    expect(r.estado).toBe('FALLIDO');
    expect(llamadas).toHaveLength(1);
    if (r.estado !== 'FALLIDO') return;
    expect(r.intentos).toBe(1);
  });

  it('un timeout falla, y NO se reintenta para no mandar el mensaje dos veces', async () => {
    // La única diferencia de criterio con el proveedor de modelo, y la razón
    // está en el encabezado de resend.ts: un timeout no dice que Resend haya
    // rechazado el mensaje, dice que no contestó a tiempo. Puede haberlo
    // aceptado. Reintentarlo manda el mismo aviso de cobranza dos veces.
    const llamadas: number[] = [];
    const fetchQueSeCuelga: FetchLike = (_url, init) =>
      new Promise((_, rechazar) => {
        llamadas.push(1);
        init.signal.addEventListener('abort', () => {
          const e = new Error('The operation was aborted');
          e.name = 'AbortError';
          rechazar(e);
        });
      });

    const r = await resendCon(fetchQueSeCuelga, { maxRetries: 3, timeoutMs: 20 }).enviar(MENSAJE);

    expect(r.estado).toBe('FALLIDO');
    if (r.estado !== 'FALLIDO') return;
    expect(r.detalle).toContain('TIMEOUT');
    expect(r.detalle).toContain('20 ms');
    expect(llamadas).toHaveLength(1);
  });

  it('un fallo de red sí se reintenta: la conexión no se abrió', async () => {
    let veces = 0;
    const fetchCaido: FetchLike = async () => {
      veces += 1;
      throw new Error('connect ECONNREFUSED 10.0.0.1:443');
    };

    const r = await resendCon(fetchCaido, { maxRetries: 2 }).enviar(MENSAJE);

    expect(r.estado).toBe('FALLIDO');
    if (r.estado !== 'FALLIDO') return;
    expect(r.detalle).toContain('RED');
    expect(veces).toBe(3);
    expect(r.intentos).toBe(3);
  });

  it('si el gestor de secretos no tiene la clave, no dice que el proveedor está caído', async () => {
    // No es lo mismo y llevan a acciones opuestas: una la arregla configurando
    // el secreto, la otra es esperar a que el proveedor se recupere.
    const { fetch } = fetchQueContesta([{ status: 200, cuerpo: '{}' }]);
    const proveedor = new ProveedorDeResend({
      apiKey: async () => {
        throw new Error('SECRET_NOT_FOUND env:EMAIL_API_KEY');
      },
      from: CONFIGURADO.from!,
      timeoutMs: 1_000,
      maxRetries: 0,
      fetch,
    });

    const r = await proveedor.enviar(MENSAJE);
    expect(r.estado).toBe('FALLIDO');
    if (r.estado !== 'FALLIDO') return;
    expect(r.detalle).toContain('CREDENCIAL_RECHAZADA');
    expect(r.detalle).toContain('no se pudo resolver la credencial');
  });
});

describe('lo que el adaptador no puede dejar escapar', () => {
  /**
   * Todo el texto que el adaptador produce para afuera.
   *
   * Se junta en un solo string porque la afirmación es «no está en ningún
   * lado», y comprobarla campo por campo deja el campo que se agregue mañana
   * sin cubrir.
   */
  const todoLoQueSale = (r: { estado: string } & Record<string, unknown>): string =>
    JSON.stringify(r);

  it('la clave no aparece aunque el proveedor la devuelva en su propio error', async () => {
    // No es hipotético: hay proveedores que devuelven el pedido completo —con
    // la cabecera de autorización adentro— en el cuerpo del error.
    const { fetch } = fetchQueContesta([
      {
        status: 400,
        cuerpo: JSON.stringify({
          message: `Bad request. Received: Authorization: Bearer ${CLAVE_SINTETICA}`,
        }),
      },
    ]);

    const r = await resendCon(fetch).enviar(MENSAJE);
    const texto = todoLoQueSale(r);

    expect(texto).not.toContain(CLAVE_SINTETICA);
    expect(texto).toContain('REDACTADO');
  });

  it('la clave no aparece cuando viaja en la URL de un error de red', async () => {
    const fetchCaido: FetchLike = async () => {
      throw new Error(`request to https://api.resend.com/emails?api_key=${CLAVE_SINTETICA} failed`);
    };

    const r = await resendCon(fetchCaido).enviar(MENSAJE);
    expect(todoLoQueSale(r)).not.toContain(CLAVE_SINTETICA);
  });

  it('el token del mensaje no aparece en NINGÚN resultado', async () => {
    // El que más importa. Un cuerpo de verificación contiene el token de alta:
    // si apareciera en el detalle, ese detalle va a `email_outbox.detalle` y a
    // cualquier log que lo toque, y con eso se activa la cuenta de otro.
    const casos: FetchLike[] = [
      fetchQueContesta([{ status: 200, cuerpo: JSON.stringify({ id: 'ok' }) }]).fetch,
      fetchQueContesta([{ status: 422, cuerpo: JSON.stringify({ message: 'invalid to' }) }]).fetch,
      fetchQueContesta([{ status: 500, cuerpo: 'no es json' }]).fetch,
      async () => {
        throw new Error('boom');
      },
    ];

    for (const fetch of casos) {
      const r = await resendCon(fetch).enviar(MENSAJE);
      expect(todoLoQueSale(r), `el token salió con ${r.estado}`).not.toContain(TOKEN_SINTETICO);
    }
  });

  it('el cuerpo del mensaje no se copia al detalle de un fallo', async () => {
    // La regla general de la que el token es un caso: el cuerpo no sale, ni
    // siquiera recortado. «Los primeros 40 caracteres» dejan de ser inocuos el
    // día que el token quede entre los primeros 40.
    const { fetch } = fetchQueContesta([
      { status: 422, cuerpo: JSON.stringify({ message: 'nope' }) },
    ]);
    const r = await resendCon(fetch).enviar(MENSAJE);
    if (r.estado !== 'FALLIDO') throw new Error('se esperaba FALLIDO');
    expect(r.detalle).not.toContain('Copiá este código');
  });
});

describe('la fábrica: qué proveedor sale de qué configuración', () => {
  it('sin configurar nada, sigue saliendo SinProveedorDeCorreo', async () => {
    const p = crearProveedorDeCorreo({
      correo: { ...CONFIGURADO, provider: 'none', apiKeyRef: null, from: null },
    });
    expect(p).toBeInstanceOf(SinProveedorDeCorreo);
    expect(p.id).toBe('ninguno');

    // Y sigue sin romper nada: es un modo de operación, no un error.
    const r = await p.enviar(MENSAJE);
    expect(r.estado).toBe('SIN_PROVEEDOR');
    if (r.estado !== 'SIN_PROVEEDOR') return;
    expect(r.detalle).toContain('correo:bandeja');
  });

  it('resend sin credencial o sin remitente NO rompe el alta: queda preparado', async () => {
    for (const incompleto of [
      { ...CONFIGURADO, apiKeyRef: null },
      { ...CONFIGURADO, from: null },
      { ...CONFIGURADO, apiKeyRef: null, from: null },
    ]) {
      expect(estadoDelCorreo(incompleto)).toBe('PREPARADO');
      // Lo importante: devuelve el sin-proveedor en vez de tirar. Una
      // instalación a la que le falta EMAIL_FROM tiene que poder seguir
      // registrando usuarios contra la bandeja de salida.
      const p = crearProveedorDeCorreo({ correo: incompleto });
      expect(p).toBeInstanceOf(SinProveedorDeCorreo);
      const r = await p.enviar(MENSAJE);
      expect(r.estado).toBe('SIN_PROVEEDOR');
    }
  });

  it('dice qué falta, con el nombre de la variable', () => {
    expect(faltantesDeResend({ ...CONFIGURADO, apiKeyRef: null })).toEqual(['EMAIL_API_KEY']);
    expect(faltantesDeResend({ ...CONFIGURADO, from: '' })).toEqual(['EMAIL_FROM']);
    expect(faltantesDeResend(CONFIGURADO)).toEqual([]);
  });

  it('con las dos cosas, sale el adaptador de Resend', () => {
    const p = crearProveedorDeCorreo({ correo: CONFIGURADO });
    expect(p).toBeInstanceOf(ProveedorDeResend);
    expect(p.id).toBe('resend');
  });

  it('un proveedor desconocido NO cae a none: tira, y el arranque lo corta', () => {
    const raro = { ...CONFIGURADO, provider: 'sendgrid' };
    expect(verificarProveedorDeCorreo(raro)).toContain('no es un proveedor de correo conocido');
    expect(verificarProveedorDeCorreo(raro)).toContain('none, resend');
    expect(() => crearProveedorDeCorreo({ correo: raro })).toThrow(/no es un proveedor/u);

    // Y los dos que sí existen pasan.
    expect(verificarProveedorDeCorreo(CONFIGURADO)).toBeNull();
    expect(verificarProveedorDeCorreo({ ...CONFIGURADO, provider: 'none' })).toBeNull();
  });

  it('la referencia del secreto sigue el mismo formato que la de la IA', () => {
    expect(refDeLaClaveDeCorreo('env:EMAIL_API_KEY')).toEqual({
      companyId: null,
      scope: 'env',
      name: 'EMAIL_API_KEY',
    });
    // Sin prefijo se asume el entorno: es lo que alguien escribe primero.
    expect(refDeLaClaveDeCorreo('EMAIL_API_KEY').scope).toBe('env');
    // Y el secreto del correo es del despliegue, no de una empresa.
    expect(refDeLaClaveDeCorreo('kms:algo').companyId).toBeNull();
  });

  it('la fábrica resuelve la credencial por llamada, no al construir', async () => {
    // Este objeto puede vivir tanto como el proceso; el secreto vive el tiempo
    // del envío. Si se resolviera en el constructor, una rotación no se vería
    // hasta reiniciar.
    let pedidos = 0;
    const { fetch } = fetchQueContesta([{ status: 200, cuerpo: JSON.stringify({ id: 'x' }) }]);
    const p = crearProveedorDeCorreo({
      correo: CONFIGURADO,
      fetch,
      secretos: {
        get: async () => {
          pedidos += 1;
          return { valor: CLAVE_SINTETICA, ref: refDeLaClaveDeCorreo('env:EMAIL_API_KEY') };
        },
        existe: async () => true,
      } as never,
    });

    expect(pedidos, 'la clave se pidió al construir').toBe(0);
    await p.enviar(MENSAJE);
    expect(pedidos).toBe(1);
    await p.enviar(MENSAJE);
    expect(pedidos).toBe(2);
  });
});

describe('la decisión de qué proveedor usar vive en un solo lugar', () => {
  /**
   * El defecto que este control existe para que no vuelva.
   *
   * Antes de B2.5.1 la decisión estaba escrita como `new SinProveedorDeCorreo()`
   * en medio de una función de `routes/auth.ts`. Con un solo proveedor eso
   * alcanzaba. Con dos, el próximo lugar que necesite mandar un correo —el
   * aviso de cobranza, la recuperación de contraseña— va a copiar esa línea, y
   * el resultado es una instalación con Resend configurado donde **una parte
   * del sistema manda correos y la otra no**, sin que nadie lo note: las dos
   * siguen contestando 200.
   *
   * Es literalmente el bug que `ai/proveedor.ts` documenta en su encabezado,
   * que ya pasó una vez con `predictions.ts` e `intelligence.ts`. Un control
   * estático es lo único que lo ataja antes de que pase de nuevo.
   */
  const RAIZ = new URL('../../apps/api/src/', import.meta.url);

  it('nadie construye un proveedor de correo fuera de la fábrica', async () => {
    const { readdir, readFile } = await import('node:fs/promises');
    const { join } = await import('node:path');

    const sospechosos: string[] = [];
    const recorrer = async (carpeta: string, relativo: string): Promise<void> => {
      for (const entrada of await readdir(carpeta, { withFileTypes: true })) {
        const ruta = join(carpeta, entrada.name);
        const rel = `${relativo}${entrada.name}`;
        if (entrada.isDirectory()) {
          await recorrer(ruta, `${rel}/`);
          continue;
        }
        if (!entrada.name.endsWith('.ts')) continue;
        // La fábrica es el único que puede: es su trabajo.
        if (rel === 'correo/fabrica.ts') continue;

        const fuente = await readFile(ruta, 'utf8');
        for (const clase of ['SinProveedorDeCorreo', 'ProveedorDeResend']) {
          if (new RegExp(`new\\s+${clase}\\s*\\(`, 'u').test(fuente)) {
            sospechosos.push(`${rel}: new ${clase}()`);
          }
        }
      }
    };

    // `fileURLToPath` y no `.pathname`: la ruta de este repositorio tiene un
    // espacio —«proyecto uca»— y `pathname` lo deja como `%20`, con lo que
    // `readdir` no encuentra nada y el control pasaría por no haber mirado.
    const { fileURLToPath } = await import('node:url');
    await recorrer(fileURLToPath(RAIZ), '');

    expect(
      sospechosos,
      'Estos archivos construyen un proveedor de correo por su cuenta. La decisión de cuál se ' +
        'usa vive en `correo/fabrica.ts` y en ningún otro lado: una segunda copia se ' +
        'desincroniza, y el síntoma es una instalación donde una parte manda correos y la ' +
        'otra no. Pedí el proveedor con `crearProveedorDeCorreo()`:\n  ' +
        sospechosos.join('\n  '),
    ).toEqual([]);
  });

  it('el alta pide el proveedor a la fábrica y se lo pasa a encolar', async () => {
    const { readFile } = await import('node:fs/promises');
    const auth = await readFile(new URL('routes/auth.ts', RAIZ), 'utf8');

    expect(auth).toContain('crearProveedorDeCorreo');
    // `encolar` es lo que deja la constancia en `email_outbox`. Un envío que no
    // pase por ahí es un usuario esperando un correo que nadie sabe que no
    // salió, que es justo lo que el puerto existe para impedir.
    expect(auth).toContain('encolar(tx, correo,');
  });
});

describe('el banner del arranque dice en qué modo corre el correo', () => {
  it('sin proveedor: apagado, y con la consecuencia escrita', () => {
    const m = modoDeCorreo({ ...CONFIGURADO, provider: 'none' });
    expect(m.real).toBe(false);
    expect(m.valor).toBe('none');
    expect(m.detalle).toContain('correo:bandeja');
  });

  it('preparado: nombra la variable que falta', () => {
    const m = modoDeCorreo({ ...CONFIGURADO, from: null });
    expect(m.real).toBe(false);
    expect(m.detalle).toContain('EMAIL_FROM');
  });

  it('configurado: real, y muestra el remitente y NO la clave', () => {
    const m = modoDeCorreo(CONFIGURADO);
    expect(m.real).toBe(true);
    expect(m.valor).toBe('resend');
    expect(m.detalle).toContain('hola@ejemplo.invalid');
    // El banner se imprime en la consola del servidor y termina en el log del
    // contenedor.
    expect(JSON.stringify(m)).not.toContain(CLAVE_SINTETICA);
    expect(JSON.stringify(m)).not.toContain('EMAIL_API_KEY');
  });
});
