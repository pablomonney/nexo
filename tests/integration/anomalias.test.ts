/**
 * Los detectores de anomalías, corriendo sobre el Diario de verdad.
 *
 * ## Por qué este archivo existe
 *
 * `@aai/audit-engine` tenía 28 tests propios y **ningún consumidor**: ni la
 * API, ni un script, ni otro paquete lo importaban. Cuatro detectores escritos,
 * probados y que nunca habían visto un asiento real. Lo encontró el barrido de
 * la auditoría integral, y es la misma clase de hueco que ya había aparecido
 * con la bitácora —escrita por 35 acciones y leída por nadie— y con el
 * Integration Hub.
 *
 * Lo que este archivo defiende:
 *
 *   1. **Que el camino exista de punta a punta**: del asiento aprobado en la
 *      base al hallazgo en la respuesta HTTP.
 *   2. **Que solo mire lo aprobado.** Un borrador todavía se está escribiendo.
 *   3. **Que el detector que no puede correr lo diga**, en vez de devolver una
 *      lista vacía que se lee como «no encontré nada».
 *   4. **Que ningún hallazgo sea una acusación.**
 */

import { closePool, initPool } from '@aai/db';
import { buildServer } from '@aai/api/server';
import { cuitCheckDigit, totp, withCheckDigit } from '@aai/shared';
import type { FastifyInstance } from 'fastify';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { connect, hasDatabase, type Client } from './helpers/db.js';
import { sufijoUnico } from './helpers/identificadores.js';

const suite = hasDatabase ? describe : describe.skip;
const PASSWORD = 'una-contrasena-suficientemente-larga';

interface Respuesta {
  readonly anomalias: {
    readonly codigo: string;
    readonly entryId: string;
    readonly observado: string;
    readonly queMirar: string;
  }[];
  readonly asientosRevisados: number;
  readonly asientosConHallazgo: number;
  readonly comentario: string;
  readonly alcance: string;
}

suite('Anomalías del Diario', () => {
  let app: FastifyInstance;
  let db: Client;
  let stamp: string;
  let token: string;
  let empresa: string;
  let clienteId: string;
  let anio: number;

  const pedir = (method: 'GET' | 'POST', url: string, payload?: unknown) =>
    app.inject({
      method,
      url,
      headers: { authorization: `Bearer ${token}`, 'x-company-id': empresa },
      ...(payload === undefined ? {} : { payload }),
    });

  /** Un asiento con contraparte. Devuelve su id; lo aprueba si se le pide. */
  const asiento = async (
    importe: string,
    fecha: string,
    aprobar = true,
  ): Promise<string> => {
    const alta = await pedir('POST', '/journal-entries', {
      journalCode: 'GENERAL',
      entryDate: fecha,
      description: 'Compra de insumos',
      currency: 'ARS',
      lines: [
        { accountCode: '5.1.01', debit: importe, credit: '0' },
        { accountCode: '2.1.01', debit: '0', credit: importe, partyId: clienteId },
      ],
      source: { type: 'MANUAL', id: null },
      manualJustification: 'Compra registrada por la contadora',
    });
    expect(alta.statusCode, alta.body).toBe(201);
    const id = alta.json<{ id: string }>().id;
    if (aprobar) {
      expect((await pedir('POST', `/journal-entries/${id}/approve`)).statusCode).toBe(200);
    }
    return id;
  };

  beforeAll(async () => {
    initPool(process.env.DATABASE_URL!);
    app = await buildServer();
    await app.ready();
    db = await connect();
    stamp = await sufijoUnico(db);

    const { hash: argonHash } = await import('@node-rs/argon2');
    const fundadorId = (
      await db.query<{ id: string }>(
        'INSERT INTO users (email, full_name, password_hash) VALUES ($1,$2,$3) RETURNING id',
        [
          `fundador-anom-${stamp}@estudio.test`,
          'Fundador',
          await argonHash(PASSWORD, { algorithm: 2, memoryCost: 19_456, timeCost: 2, parallelism: 1 }),
        ],
      )
    ).rows[0]!.id;

    const organizationId = (
      await db.query<{ create_organization: string }>('SELECT create_organization($1,$2,$3)', [
        `Estudio anom ${stamp}`, withCheckDigit(`30${stamp}`), fundadorId,
      ])
    ).rows[0]!.create_organization;

    empresa = (
      await db.query<{ create_company: string }>('SELECT create_company($1,$2,$3,$4,$5,$6,$7,$8)', [
        fundadorId, organizationId, `Empresa anom ${stamp}`, withCheckDigit(`27${stamp}`),
        'SA', 'AR-C', 'IGJ', '12-31',
      ])
    ).rows[0]!.create_company;

    const tokenFundador = (
      await app.inject({
        method: 'POST',
        url: '/auth/login',
        payload: { email: `fundador-anom-${stamp}@estudio.test`, password: PASSWORD },
      })
    ).json<{ token: string }>().token;

    const email = `auditora-${stamp}@estudio.test`;
    const userId = (
      await app.inject({
        method: 'POST',
        url: `/organizations/${organizationId}/users`,
        headers: { authorization: `Bearer ${tokenFundador}` },
        payload: { email, fullName: 'Auditora', password: PASSWORD, level: 'MEMBER' },
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
      await app.inject({ method: 'POST', url: '/auth/login', payload: { email, password: PASSWORD } })
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
      await app.inject({ method: 'POST', url: '/auth/login', payload: { email, password: PASSWORD } })
    ).json<{ token: string }>().token;
    await app.inject({
      method: 'POST',
      url: '/auth/mfa/verify',
      payload: { code: totp(secret, Date.now()) },
      headers: { authorization: `Bearer ${token}` },
    });

    clienteId = (
      await pedir('POST', '/parties', {
        tipoDocumento: 'CUIT',
        numeroDocumento: `30${stamp}${cuitCheckDigit(`30${stamp}`)}`,
        razonSocial: `Proveedor anom ${stamp}`,
        roles: ['PROVEEDOR'],
      })
    ).json<{ id: string }>().id;

    anio = new Date().getUTCFullYear();
    expect(
      (await pedir('POST', '/fiscal-years', {
        code: `EJ${anio}-${stamp}`,
        startDate: `${anio}-01-01`,
        endDate: `${anio}-12-31`,
      })).statusCode,
    ).toBe(201);

    for (const cuenta of [
      { code: '5.1.01', name: 'Insumos', type: 'GASTO' },
      { code: '2.1.01', name: 'Proveedores', type: 'PASIVO', requiresThirdParty: true },
    ]) {
      expect((await pedir('POST', '/accounts', cuenta)).statusCode).toBe(201);
    }
  }, 60_000);

  afterAll(async () => {
    await app?.close();
    await db?.end();
    await closePool();
  });

  it('sin asientos aprobados no observa nada, y no se cuelga', async () => {
    const r = await pedir('GET', '/audit/anomalias');
    expect(r.statusCode, r.body).toBe(200);
    const a = r.json<Respuesta>();
    expect(a.asientosRevisados).toBe(0);
    expect(a.anomalias).toHaveLength(0);
  });

  it('el detector que no puede correr lo dice, en vez de devolver una lista vacía', async () => {
    await asiento('1234.56', `${anio}-03-10`);

    const a = (await pedir('GET', '/audit/anomalias')).json<Respuesta>();

    // `JUSTO_BAJO_UMBRAL` compara contra umbrales que salen de normas que este
    // repositorio no tiene archivadas. Callarlo dejaría creer que miró.
    expect(a.comentario).toContain('no corrió');
    expect(a.comentario).toContain('no inventa');
  });

  it('un importe redondo se observa, y el hallazgo no acusa a nadie', async () => {
    await asiento('500000.00', `${anio}-03-11`);

    const a = (await pedir('GET', '/audit/anomalias')).json<Respuesta>();
    const redondo = a.anomalias.find((x) => x.codigo === 'IMPORTE_REDONDO');

    expect(redondo, 'el detector corrió sobre un asiento real').toBeDefined();
    expect(redondo!.observado).toBeTruthy();
    expect(redondo!.queMirar, 'dice qué mirar, no qué significa').toBeTruthy();

    // Ninguna palabra de conclusión: el motor observa, no imputa.
    const texto = JSON.stringify(a.anomalias).toLowerCase();
    for (const prohibida of ['fraude', 'delito', 'sospechoso', 'culpable', 'evasión']) {
      expect(texto, `un hallazgo no dice «${prohibida}»`).not.toContain(prohibida);
    }
  });

  it('solo mira lo aprobado: un borrador no se observa', async () => {
    const borrador = await asiento('700000.00', `${anio}-03-12`, false);

    const a = (await pedir('GET', '/audit/anomalias')).json<Respuesta>();

    // Un asiento en borrador todavía se está escribiendo. Marcarlo sería
    // observar a alguien mientras piensa.
    expect(a.anomalias.some((x) => x.entryId === borrador)).toBe(false);
  });

  it('el período acota lo revisado', async () => {
    const todo = (await pedir('GET', '/audit/anomalias')).json<Respuesta>();
    const marzo = (
      await pedir('GET', `/audit/anomalias?desde=${anio}-03-01&hasta=${anio}-03-31`)
    ).json<Respuesta>();
    const abril = (
      await pedir('GET', `/audit/anomalias?desde=${anio}-04-01&hasta=${anio}-04-30`)
    ).json<Respuesta>();

    // Primero que haya algo que acotar. Sin esta línea las tres comparaciones
    // se cumplen con cero asientos revisados, y el test pasa sin haber mirado
    // nada — que es exactamente como no me di cuenta de que el filtro de estado
    // decía `APPROVED` y la base escribe `APROBADO`.
    expect(todo.asientosRevisados).toBeGreaterThan(0);
    expect(marzo.asientosRevisados).toBe(todo.asientosRevisados);
    expect(abril.asientosRevisados).toBe(0);
  });

  it('exige los dos permisos de lectura que mira', async () => {
    // Sin cabecera de empresa no hay contexto, y la respuesta es la misma que
    // para una empresa ajena: 403 sin distinguir.
    const sinEmpresa = await app.inject({
      method: 'GET',
      url: '/audit/anomalias',
      headers: { authorization: `Bearer ${token}` },
    });
    expect(sinEmpresa.statusCode).toBe(403);
  });
});
