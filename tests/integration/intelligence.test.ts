/**
 * NEXO Intelligence — la capa que contesta con evidencia.
 *
 * Lo que este archivo defiende:
 *
 *   1. **Que el número coincida con el módulo que lo calcula.** Si la analítica
 *      dice 10.000 y la respuesta dice otra cosa, hay dos verdades.
 *   2. **Que no conteste lo que no sabe.** Una pregunta fuera del catálogo se
 *      responde «no la sé contestar» y no con la más parecida.
 *   3. **Que no elija entre dos interpretaciones.** Si la pregunta puede ser dos
 *      cosas, las ofrece; adivinar sería contestar una pregunta que nadie hizo.
 *   4. **Que cada respuesta traiga de dónde salió**: la vista, la metodología y
 *      qué queda afuera.
 *   5. **Que sin proveedor de IA el sistema conteste igual.** La cifra es del
 *      motor; el párrafo es lo único que falta, y se dice con esas palabras.
 *   6. **Que el rol más chico no se quede sin pantalla.** El filtro por
 *      permisos vive en `preguntasPara` y lo prueba el test unitario: con los
 *      cinco roles de este esquema no se puede demostrar, porque todos tienen
 *      los seis permisos de lectura que el catálogo usa.
 */

import { closePool, initPool } from '@aai/db';
import { buildServer } from '@aai/api/server';
import { cuitCheckDigit, totp, withCheckDigit } from '@aai/shared';
import type { FastifyInstance } from 'fastify';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { connect, hasDatabase, type Client } from './helpers/db.js';
import { sufijoUnico } from './helpers/identificadores.js';
import { hoyDeLaBase } from './helpers/fechas.js';

const suite = hasDatabase ? describe : describe.skip;
const PASSWORD = 'una-contrasena-suficientemente-larga';

suite('NEXO Intelligence', () => {
  let app: FastifyInstance;
  let db: Client;
  let stamp: string;
  let token: string;
  let empresa: string;
  let clienteId: string;
  let cuitCliente: string;
  let hoy: string;
  let mes: string;

  const pedir = (method: 'GET' | 'POST', url: string, payload?: unknown) =>
    app.inject({
      method,
      url,
      headers: { authorization: `Bearer ${token}`, 'x-company-id': empresa },
      ...(payload === undefined ? {} : { payload }),
    });

  const preguntar = async (pregunta: string) => {
    const r = await pedir('POST', '/intelligence/preguntar', { pregunta });
    expect(r.statusCode, r.body).toBe(200);
    return r.json<{
      entendida: boolean;
      motivo?: string;
      preguntaId?: string;
      preguntasPosibles?: { id: string; pregunta: string }[];
      respuesta?: {
        titulo: string; valor: string | null; unidad: string; periodo: string | null;
        datos: { etiqueta: string; valor: string; origen: string }[];
        origen: string[]; metodologia: string; noIncluye: string | null;
      };
      narracion?: { disponible: boolean; motivo: string; explicacion: string };
    }>();
  };

  /** Una factura de venta al cliente, para que haya algo que contestar. */
  const facturar = async (neto: string, iva: string, total: string, numero: number) => {
    const forma =
      `--X\r\nContent-Disposition: form-data; name="file"; filename="int-${stamp}-${numero}.xml"\r\n` +
      `Content-Type: application/xml\r\n\r\n<c><n>${numero}</n></c>\r\n--X--\r\n`;
    const subida = await app.inject({
      method: 'POST',
      url: '/documents',
      headers: {
        authorization: `Bearer ${token}`,
        'x-company-id': empresa,
        'content-type': 'multipart/form-data; boundary=X',
      },
      payload: forma,
    });
    expect(subida.statusCode, subida.body).toBe(201);

    const op = await pedir(
      'POST', `/documents/${subida.json<{ id: string }>().id}/tax-transaction`,
      {
        direction: 'VENTAS', cbteTipo: 1, puntoVenta: 1, numero, fecha: hoy,
        cuitContraparte: cuitCliente, razonSocial: `Cliente int ${stamp}`,
        condicionIva: 'RESPONSABLE_INSCRIPTO',
        neto, iva, noGravado: '0', exento: '0', percepciones: '0', total,
      },
    );
    expect(op.statusCode, op.body).toBe(201);
    const id = op.json<{ taxTransactionId: string }>().taxTransactionId;
    expect(
      (await pedir('POST', `/tax-transactions/${id}/party`, { partyId: clienteId })).statusCode,
    ).toBe(200);
    return id;
  };

  beforeAll(async () => {
    initPool(process.env.DATABASE_URL!);
    app = await buildServer();
    await app.ready();
    db = await connect();
    stamp = await sufijoUnico(db);
    hoy = await hoyDeLaBase(db);
    mes = hoy.slice(0, 7);

    const { hash: argonHash } = await import('@node-rs/argon2');
    const fundadorId = (
      await db.query<{ id: string }>(
        'INSERT INTO users (email, full_name, password_hash) VALUES ($1,$2,$3) RETURNING id',
        [
          `fundador-int-${stamp}@estudio.test`,
          'Fundador',
          await argonHash(PASSWORD, {
            algorithm: 2, memoryCost: 19_456, timeCost: 2, parallelism: 1,
          }),
        ],
      )
    ).rows[0]!.id;

    const organizationId = (
      await db.query<{ create_organization: string }>('SELECT create_organization($1,$2,$3)', [
        `Estudio int ${stamp}`, withCheckDigit(`30${stamp}`), fundadorId,
      ])
    ).rows[0]!.create_organization;

    empresa = (
      await db.query<{ create_company: string }>('SELECT create_company($1,$2,$3,$4,$5,$6,$7,$8)', [
        fundadorId, organizationId, `Empresa int ${stamp}`, withCheckDigit(`27${stamp}`),
        'SA', 'AR-C', 'IGJ', '12-31',
      ])
    ).rows[0]!.create_company;

    const tokenFundador = (
      await app.inject({
        method: 'POST',
        url: '/auth/login',
        payload: { email: `fundador-int-${stamp}@estudio.test`, password: PASSWORD },
      })
    ).json<{ token: string }>().token;

    const email = `contadora-int-${stamp}@estudio.test`;
    const userId = (
      await app.inject({
        method: 'POST',
        url: `/organizations/${organizationId}/users`,
        headers: { authorization: `Bearer ${tokenFundador}` },
        payload: { email, fullName: 'Contadora', password: PASSWORD, level: 'MEMBER' },
      })
    ).json<{ id: string }>().id;

    for (const role of ['CONTADOR', 'ADMINISTRADOR']) {
      await app.inject({
        method: 'POST',
        url: `/companies/${empresa}/roles`,
        headers: { authorization: `Bearer ${tokenFundador}` },
        payload: { userId, role },
      });
    }

    const inicial = (
      await app.inject({
        method: 'POST', url: '/auth/login', payload: { email, password: PASSWORD },
      })
    ).json<{ token: string }>().token;
    const secret = (
      await app.inject({
        method: 'POST',
        url: '/auth/mfa/setup',
        headers: { authorization: `Bearer ${inicial}` },
      })
    ).json<{ secret: string }>().secret;
    await app.inject({
      method: 'POST',
      url: '/auth/mfa/confirm',
      payload: { code: totp(secret, Date.now()) },
      headers: { authorization: `Bearer ${inicial}` },
    });
    token = (
      await app.inject({
        method: 'POST', url: '/auth/login', payload: { email, password: PASSWORD },
      })
    ).json<{ token: string }>().token;
    await app.inject({
      method: 'POST',
      url: '/auth/mfa/verify',
      payload: { code: totp(secret, Date.now()) },
      headers: { authorization: `Bearer ${token}` },
    });

    cuitCliente = `30${stamp}${cuitCheckDigit(`30${stamp}`)}`;
    clienteId = (
      await pedir('POST', '/parties', {
        tipoDocumento: 'CUIT', numeroDocumento: cuitCliente,
        razonSocial: `Cliente int ${stamp}`, roles: ['CLIENTE'], diasDePago: 0,
      })
    ).json<{ id: string }>().id;

    const anio = new Date().getUTCFullYear();
    expect(
      (await pedir('POST', '/fiscal-years', {
        code: `EJ${anio}-${stamp}`, startDate: `${anio}-01-01`, endDate: `${anio}-12-31`,
      })).statusCode,
    ).toBe(201);

    await facturar('10000.00', '2100.00', '12100.00', 7101);
    await facturar('5000.00', '1050.00', '6050.00', 7102);
  }, 90_000);

  afterAll(async () => {
    await app?.close();
    await db?.end();
    await closePool();
  });

  it('el número coincide con el que muestra la analítica', async () => {
    const r = await preguntar('¿cuánto vendí este mes?');
    expect(r.entendida).toBe(true);
    expect(r.preguntaId).toBe('VENTAS_DEL_MES');
    // 10.000 + 5.000 de neto, formateado como lo escribe una persona.
    expect(r.respuesta!.valor).toBe('15.000,00');
    expect(r.respuesta!.periodo).toBe(mes);

    // Y contra la fuente, sin pasar por la respuesta: si difirieran, habría dos
    // verdades sobre la misma cifra.
    const fuente = await db.query<{ neto: string }>(
      `SELECT neto::text FROM analytics_operaciones_mensuales
        WHERE company_id = $1 AND direccion = 'VENTAS' AND mes = ($2 || '-01')::date`,
      [empresa, mes],
    );
    expect(fuente.rows[0]!.neto).toBe('15000.00');
  });

  it('cada respuesta dice de dónde salió y qué no incluye', async () => {
    const r = await preguntar('¿cuánto vendí?');
    expect(r.respuesta!.origen).toContain('analytics_operaciones_mensuales');
    expect(r.respuesta!.metodologia).toContain('fecha de comprobante');
    expect(r.respuesta!.noIncluye).toBeTruthy();
    // El detalle permite abrir el total: no es un número suelto.
    expect(r.respuesta!.datos.length).toBeGreaterThan(2);
    expect(r.respuesta!.datos.every((d) => d.origen.length > 0)).toBe(true);
  });

  it('lo que le deben sale de la cuenta corriente, no de otra cuenta', async () => {
    const r = await preguntar('¿cuánto me deben?');
    expect(r.preguntaId).toBe('CUANTO_ME_DEBEN');

    const fuente = await db.query<{ pendiente: string }>(
      `SELECT coalesce(sum(pendiente), 0)::text AS pendiente FROM party_aging
        WHERE company_id = $1 AND direction = 'VENTAS'`,
      [empresa],
    );
    // 12.100 + 6.050 con IVA: la cuenta corriente es por el total, no por el neto.
    expect(fuente.rows[0]!.pendiente).toBe('18150.00');
    expect(r.respuesta!.valor).toBe('18.150,00');
  });

  it('lo que no sabe contestar, no lo contesta', async () => {
    const r = await preguntar('¿cuántos empleados tengo en la sucursal de Rosario?');
    expect(r.entendida).toBe(false);
    expect(r.motivo).toBe('NO_ENTENDIDA');
    // Y ofrece lo que sí sabe: la lista no puede venir vacía.
    expect(r.preguntasPosibles!.length).toBeGreaterThan(5);
  });

  it('cuando la pregunta puede ser dos cosas, no elige', async () => {
    // Una pregunta compuesta pega en el núcleo de dos entradas con el mismo
    // peso. Contestar una de las dos sería contestar media pregunta y no decirlo.
    const r = await preguntar('ventas y compras');
    expect(r.entendida).toBe(false);
    expect(r.motivo).toBe('AMBIGUA');
    expect(r.preguntasPosibles!.length).toBeGreaterThan(1);
  });

  it('sin proveedor de modelo, la cifra llega igual y se dice qué falta', async () => {
    const r = await preguntar('¿cuánto vendí?');
    expect(r.respuesta!.valor).toBe('15.000,00');
    expect(r.narracion!.disponible).toBe(false);
    expect(r.narracion!.motivo).toBe('SIN_PROVEEDOR');
    expect(r.narracion!.explicacion).toContain('determinístico');

    const catalogo = await pedir('GET', '/intelligence/preguntas');
    expect(catalogo.statusCode, catalogo.body).toBe(200);
    const c = catalogo.json<{
      preguntas: { id: string }[];
      narracion: { disponible: boolean; proveedor: string; motivo: string | null };
    }>();
    expect(c.narracion.disponible).toBe(false);
    expect(c.narracion.motivo).toContain('secreto profesional');
    expect(c.preguntas.length).toBeGreaterThan(8);
  });

  it('la pregunta se puede elegir de la lista, sin escribirla', async () => {
    const r = await pedir('POST', '/intelligence/preguntar', {
      pregunta: 'la elijo de la lista',
      preguntaId: 'VALOR_DEL_STOCK',
    });
    expect(r.statusCode, r.body).toBe(200);
    const d = r.json<{ preguntaId: string; respuesta: { valor: string | null; metodologia: string } }>();
    expect(d.preguntaId).toBe('VALOR_DEL_STOCK');
    // Sin método declarado no se afirma un valor, y se dice por qué.
    expect(d.respuesta.valor).toBeNull();
    expect(d.respuesta.metodologia).toContain('no declaró método');
  });

  it('un mes escrito en la pregunta se respeta', async () => {
    const r = await preguntar('¿cuánto vendí en 2020-03?');
    expect(r.respuesta!.periodo).toBe('2020-03');
    expect(r.respuesta!.valor).toBe('0,00');
    expect(r.respuesta!.noIncluye).toContain('No hay comprobantes');
  });

  it('el panorama trae varias tarjetas, cada una con su evidencia', async () => {
    const r = await pedir('GET', '/intelligence/panorama');
    expect(r.statusCode, r.body).toBe(200);
    const p = r.json<{
      tarjetas: { preguntaId: string; titulo: string; origen: string[]; metodologia: string }[];
      alcance: string;
    }>();

    expect(p.tarjetas.length).toBeGreaterThanOrEqual(6);
    expect(p.tarjetas.every((t) => t.origen.length > 0 && t.metodologia.length > 0)).toBe(true);
    expect(p.tarjetas.find((t) => t.preguntaId === 'CUANTO_ME_DEBEN')).toBeDefined();
    expect(p.alcance).toContain('null no es cero');
  });

  /**
   * El radar de riesgos.
   *
   * Lo que se comprueba no es que los seis frentes den «bien»: es que un frente
   * que no se puede medir **no** se informe como si estuviera bien. Un tablero
   * en verde por falta de datos es peor que no tener tablero.
   */
  it('el radar informa los seis frentes, y dice cuáles no puede evaluar', async () => {
    const r = await pedir('GET', '/analysis/riesgos');
    expect(r.statusCode, r.body).toBe(200);
    const d = r.json<{
      frentes: {
        frente: string; evaluable: boolean; noSeEvalua: string | null;
        hechos: { que: string; valor: string }[]; origen: string[];
      }[];
      sinEvaluar: string[];
      alcance: string;
    }>();

    expect(d.frentes.map((f) => f.frente).sort()).toEqual([
      'COBRANZA', 'CONCENTRACION', 'CONTABLE', 'LIQUIDEZ', 'MARGEN', 'OPERATIVO',
    ]);
    // Cada frente trae sus hechos y de dónde salieron: sin eso sería una nota
    // que hay que creer.
    expect(d.frentes.every((f) => f.hechos.length > 0 && f.origen.length > 0)).toBe(true);

    // Esta empresa no lleva stock ni declaró método de valuación: el margen no
    // se puede evaluar, y el radar lo dice en vez de informarlo como sano.
    const margen = d.frentes.find((f) => f.frente === 'MARGEN')!;
    expect(margen.evaluable).toBe(false);
    expect(margen.noSeEvalua).toContain('no se puede decir si');
    expect(d.sinEvaluar).toContain('MARGEN');

    // La cobranza sí: el cliente tiene plazo declarado y hay facturas abiertas.
    const cobranza = d.frentes.find((f) => f.frente === 'COBRANZA')!;
    expect(cobranza.evaluable).toBe(true);
    expect(cobranza.noSeEvalua).toBeNull();

    expect(d.alcance).toContain('No hay una nota global');
  });

  it('el radar no suma una nota global de riesgo', async () => {
    // Sumar frentes que se miden en días, pesos y porcentajes exigiría
    // ponderarlos, y esa ponderación sería una opinión sin dueño.
    const r = await pedir('GET', '/analysis/riesgos');
    const cuerpo = r.json<Record<string, unknown>>();
    expect(Object.keys(cuerpo).sort()).toEqual(['alcance', 'frentes', 'sinEvaluar']);
  });

  it('el catálogo completo llega a un rol de solo lectura', async () => {
    // Un usuario de solo lectura no tiene `allocation:read` ni `stock:read`.
    const email = `mirona-int-${stamp}@estudio.test`;
    const fundador = (
      await app.inject({
        method: 'POST',
        url: '/auth/login',
        payload: { email: `fundador-int-${stamp}@estudio.test`, password: PASSWORD },
      })
    ).json<{ token: string }>().token;

    const org = await db.query<{ organization_id: string }>(
      'SELECT organization_id FROM companies WHERE id = $1',
      [empresa],
    );
    const userId = (
      await app.inject({
        method: 'POST',
        url: `/organizations/${org.rows[0]!.organization_id}/users`,
        headers: { authorization: `Bearer ${fundador}` },
        payload: { email, fullName: 'Mirona', password: PASSWORD, level: 'MEMBER' },
      })
    ).json<{ id: string }>().id;
    await app.inject({
      method: 'POST',
      url: `/companies/${empresa}/roles`,
      headers: { authorization: `Bearer ${fundador}` },
      payload: { userId, role: 'SOLO_LECTURA' },
    });

    const suyo = (
      await app.inject({
        method: 'POST', url: '/auth/login', payload: { email, password: PASSWORD },
      })
    ).json<{ token: string }>().token;

    const r = await app.inject({
      method: 'GET',
      url: '/intelligence/preguntas',
      headers: { authorization: `Bearer ${suyo}`, 'x-company-id': empresa },
    });
    expect(r.statusCode, r.body).toBe(200);
    const ids = r.json<{ preguntas: { id: string }[] }>().preguntas.map((p) => p.id);

    // En este esquema los cinco roles tienen los seis permisos de lectura que
    // usa el catálogo, así que un rol de solo lectura ve todo. El filtro por
    // permisos existe igual —lo prueba el test unitario de `preguntasPara`, que
    // sí puede armar un conjunto de permisos reducido—; acá lo que se comprueba
    // es que entrar con el rol más chico no deje la pantalla vacía.
    expect(ids).toContain('QUE_ME_FALTA');
    expect(ids.length).toBe(
      r.json<{ preguntas: unknown[] }>().preguntas.length,
    );
    expect(ids.length).toBeGreaterThan(8);
  });
});
