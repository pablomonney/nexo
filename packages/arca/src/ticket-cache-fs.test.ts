import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { AccessTicket } from './credentials.js';
import { TicketCacheFs, estaAdentroDe } from './ticket-cache-fs.js';
import { WsaaAuthenticator, loginConCache } from './soap/wsaa.js';

let raiz: string;

beforeEach(() => {
  raiz = mkdtempSync(join(tmpdir(), 'aai-ta-'));
});
afterEach(() => {
  rmSync(raiz, { recursive: true, force: true });
});

function ticket(overrides: Partial<AccessTicket> = {}): AccessTicket {
  return {
    token: 'TOKEN-ABC',
    sign: 'SIGN-XYZ',
    cuit: '20452148324',
    service: 'wsfe',
    generationTime: new Date(Date.now() - 60_000),
    expirationTime: new Date(Date.now() + 3_600_000),
    ...overrides,
  };
}

describe('caché de tickets en disco', () => {
  it('sobrevive al proceso: lo guardado se lee con otra instancia', async () => {
    // El caso que importa. Una caché en memoria pasa este test solo por
    // accidente de vivir en la misma variable; ésta tiene que releer el archivo.
    const escritor = new TicketCacheFs({ directorio: raiz, ambiente: 'homologacion' });
    await escritor.put(ticket());

    const lector = new TicketCacheFs({ directorio: raiz, ambiente: 'homologacion' });
    const leido = await lector.get('20452148324', 'wsfe');
    expect(leido?.token).toBe('TOKEN-ABC');
    expect(leido?.sign).toBe('SIGN-XYZ');
    expect(leido?.expirationTime).toBeInstanceOf(Date);
  });

  it('un ticket de homologación NO se sirve como si fuera de producción', async () => {
    // El ambiente no entra en la clave de búsqueda (`get(cuit, service)`), así
    // que si no lo separara la instancia, el mismo archivo serviría para los
    // dos. Operar contra el organismo con el token del otro ambiente.
    const homo = new TicketCacheFs({ directorio: raiz, ambiente: 'homologacion' });
    await homo.put(ticket());

    const prod = new TicketCacheFs({ directorio: raiz, ambiente: 'produccion' });
    expect(await prod.get('20452148324', 'wsfe')).toBeNull();
    expect(prod.directorio).not.toBe(homo.directorio);
  });

  it('no entrega un ticket que vence dentro del margen', async () => {
    const cache = new TicketCacheFs({ directorio: raiz, ambiente: 'homologacion', margenMs: 600_000 });
    await cache.put(ticket({ expirationTime: new Date(Date.now() + 300_000) }));
    // Vivo todavía, pero no lo suficiente para aguantar un lote: renovar ahora
    // es mejor que quedarse sin ticket en el comprobante treinta y siete.
    expect(await cache.get('20452148324', 'wsfe')).toBeNull();
  });

  it('un ticket vencido no se entrega', async () => {
    const cache = new TicketCacheFs({ directorio: raiz, ambiente: 'homologacion' });
    await cache.put(ticket({ expirationTime: new Date(Date.now() - 1000) }));
    expect(await cache.get('20452148324', 'wsfe')).toBeNull();
  });

  it('separa por CUIT y por servicio', async () => {
    const cache = new TicketCacheFs({ directorio: raiz, ambiente: 'homologacion' });
    await cache.put(ticket({ token: 'DE-WSFE' }));
    await cache.put(ticket({ service: 'wscdc', token: 'DE-WSCDC' }));

    expect((await cache.get('20452148324', 'wsfe'))?.token).toBe('DE-WSFE');
    expect((await cache.get('20452148324', 'wscdc'))?.token).toBe('DE-WSCDC');
    expect(await cache.get('30710000001', 'wsfe')).toBeNull();
  });

  it('un archivo ilegible se descarta en vez de tumbar el comando', async () => {
    const cache = new TicketCacheFs({ directorio: raiz, ambiente: 'homologacion' });
    writeFileSync(cache.archivoDe('20452148324', 'wsfe'), 'esto no es json {{{');
    expect(await cache.get('20452148324', 'wsfe')).toBeNull();
  });

  it('un archivo con el ticket de otro no cuenta como acierto', async () => {
    const cache = new TicketCacheFs({ directorio: raiz, ambiente: 'homologacion' });
    writeFileSync(
      cache.archivoDe('20452148324', 'wsfe'),
      JSON.stringify({
        ...ticket({ cuit: '30710000001' }),
        generationTime: new Date().toISOString(),
        expirationTime: new Date(Date.now() + 3_600_000).toISOString(),
      }),
    );
    expect(await cache.get('20452148324', 'wsfe')).toBeNull();
  });

  it('§27: se niega a escribir credenciales dentro del repositorio', () => {
    expect(
      () =>
        new TicketCacheFs({
          directorio: join(raiz, 'var', 'tickets'),
          ambiente: 'homologacion',
          raizRepositorio: raiz,
        }),
    ).toThrow(/no puede vivir dentro del repositorio/);
  });

  it('el token queda en el archivo, así que el archivo se escribe restringido', async () => {
    const cache = new TicketCacheFs({ directorio: raiz, ambiente: 'homologacion' });
    await cache.put(ticket());
    const contenido = readFileSync(cache.archivoDe('20452148324', 'wsfe'), 'utf8');
    // Se deja explícito qué material sensible vive ahí: si alguien agrega un
    // campo nuevo, que sepa que este archivo es una credencial.
    expect(contenido).toContain('TOKEN-ABC');
    expect(contenido).toContain('SIGN-XYZ');
  });
});

describe('estaAdentroDe', () => {
  it('reconoce la propia carpeta y las de adentro, y no las de afuera', () => {
    expect(estaAdentroDe(join(raiz, 'a', 'b'), raiz)).toBe(true);
    expect(estaAdentroDe(raiz, raiz)).toBe(true);
    expect(estaAdentroDe(join(raiz, '..'), raiz)).toBe(false);
  });
});

describe('loginConCache', () => {
  const certificado = {
    companyId: 'test',
    cuit: '20452148324',
    certificatePem: '',
    privateKeyPem: '',
    notAfter: new Date(Date.now() + 86_400_000),
  };

  it('con ticket vivo en la caché NO sale a la red', async () => {
    // Pedir un TA teniendo uno vivo no es derroche: el WSAA lo rechaza con
    // `coe.alreadyAuthenticated`, y pedir de más es motivo de bloqueo.
    const cache = new TicketCacheFs({ directorio: raiz, ambiente: 'homologacion' });
    await cache.put(ticket());

    const autenticador = new WsaaAuthenticator({
      endpoint: 'https://no-se-usa.invalid',
      fetchImpl: () => {
        throw new Error('no debería llegar a la red');
      },
    });

    const resultado = await loginConCache(autenticador, cache, certificado, 'wsfe');
    expect(resultado.deLaCache).toBe(true);
    expect(resultado.ticket.token).toBe('TOKEN-ABC');
  });

  it('sin ticket guardado pide uno y lo deja guardado para el comando siguiente', async () => {
    const cache = new TicketCacheFs({ directorio: raiz, ambiente: 'homologacion' });
    const nuevo = ticket({ token: 'RECIEN-PEDIDO' });
    const autenticador = {
      async login() {
        return nuevo;
      },
    } as unknown as WsaaAuthenticator;

    const primero = await loginConCache(autenticador, cache, certificado, 'wsfe');
    expect(primero.deLaCache).toBe(false);

    // La segunda llamada es la que prueba el punto: ya no necesita al WSAA.
    const otraCache = new TicketCacheFs({ directorio: raiz, ambiente: 'homologacion' });
    const segundo = await loginConCache(
      {
        async login() {
          throw new Error('no debería pedir un segundo ticket');
        },
      } as unknown as WsaaAuthenticator,
      otraCache,
      certificado,
      'wsfe',
    );
    expect(segundo.deLaCache).toBe(true);
    expect(segundo.ticket.token).toBe('RECIEN-PEDIDO');
  });
});
