/**
 * Clasificación asistida de punta a punta.
 *
 * Lo que este test fija, y conviene que no cambie sin una conversación:
 *
 * - Sin proveedor de IA configurado el sistema **igual sugiere**, con la
 *   historia de la empresa, y no manda nada afuera.
 * - Toda propuesta cae hoy en 🔴 porque el motor normativo no existe (FASE 6).
 *   No es un bug: es lo que corresponde mientras nada pueda fundarse.
 * - Revisar una propuesta es del contador. El que administra el sistema no
 *   decide una imputación (§42).
 */

import { closePool, initPool } from '@aai/db';
import { buildServer } from '@aai/api/server';
import { totp, withCheckDigit } from '@aai/shared';
import type { FastifyInstance } from 'fastify';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { connect, hasDatabase, type Client } from './helpers/db.js';
import { sufijoUnico } from './helpers/identificadores.js';

const suite = hasDatabase ? describe : describe.skip;

const PASSWORD = 'una-contrasena-suficientemente-larga';
const LIMITE = '----aaiPredTestBoundary';
const CUIT_EMISOR = '30712345671';

const XML_FACTURA = `<?xml version="1.0" encoding="UTF-8"?>
<Comprobante>
  <Cuit>${CUIT_EMISOR}</Cuit>
  <CbteTipo>1</CbteTipo>
  <PtoVta>12</PtoVta>
  <CbteNro>77</CbteNro>
  <CbteFch>20260305</CbteFch>
  <ImpNeto>1019.83</ImpNeto>
  <ImpIVA>214.17</ImpIVA>
  <ImpTotal>1234.00</ImpTotal>
  <CAE>75123456789012</CAE>
</Comprobante>`;

suite('clasificación asistida por HTTP', () => {
  let app: FastifyInstance;
  let raw: Client;
  let tokenContador: string;
  let tokenCargador: string;
  let companyId: string;
  let documentId: string;
  let cuentaId: string;
  let predictionId: string;

  const cabeceras = (token: string) => ({
    authorization: `Bearer ${token}`,
    'x-company-id': companyId,
  });

  beforeAll(async () => {
    initPool(process.env.DATABASE_URL!);
    app = await buildServer();
    await app.ready();
    raw = await connect();

    const stamp = await sufijoUnico(raw);
    const { hash: argonHash } = await import('@node-rs/argon2');
    const passwordHash = await argonHash(PASSWORD, {
      algorithm: 2,
      memoryCost: 19_456,
      timeCost: 2,
      parallelism: 1,
    });

    const emailContador = `contador-pred-${stamp}@estudio.test`;
    const emailCargador = `cargador-pred-${stamp}@estudio.test`;

    const contador = await raw.query<{ id: string }>(
      'INSERT INTO users (email, full_name, password_hash) VALUES ($1, $2, $3) RETURNING id',
      [emailContador, 'Contador', passwordHash],
    );
    const cargador = await raw.query<{ id: string }>(
      'INSERT INTO users (email, full_name, password_hash) VALUES ($1, $2, $3) RETURNING id',
      [emailCargador, 'Cargador', passwordHash],
    );
    const contadorId = contador.rows[0]!.id;

    const org = await raw.query<{ create_organization: string }>(
      'SELECT create_organization($1, $2, $3)',
      [`Estudio pred ${stamp}`, withCheckDigit(`30${stamp}`), contadorId],
    );
    const organizationId = org.rows[0]!.create_organization;
    await raw.query(
      'INSERT INTO organization_members (organization_id, user_id, level) VALUES ($1, $2, $3)',
      [organizationId, cargador.rows[0]!.id, 'MEMBER'],
    );

    const company = await raw.query<{ create_company: string }>(
      'SELECT create_company($1, $2, $3, $4, $5, $6, $7, $8)',
      [
        contadorId, organizationId, 'Empresa pred', withCheckDigit(`33${stamp}`),
        'SRL', 'AR-C', 'IGJ', '12-31',
      ],
    );
    companyId = company.rows[0]!.create_company;

    await raw.query('SELECT grant_company_role($1, $2, $3, $4)', [
      contadorId, companyId, contadorId, 'CONTADOR',
    ]);
    await raw.query('SELECT grant_company_role($1, $2, $3, $4)', [
      contadorId, companyId, cargador.rows[0]!.id, 'CARGADOR',
    ]);

    tokenCargador = (
      await app.inject({
        method: 'POST',
        url: '/auth/login',
        payload: { email: emailCargador, password: PASSWORD },
      })
    ).json<{ token: string }>().token;

    // El contador necesita segundo factor para llegar a la empresa.
    const inicial = (
      await app.inject({
        method: 'POST',
        url: '/auth/login',
        payload: { email: emailContador, password: PASSWORD },
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
    tokenContador = (
      await app.inject({
        method: 'POST',
        url: '/auth/login',
        payload: { email: emailContador, password: PASSWORD },
      })
    ).json<{ token: string }>().token;
    await app.inject({
      method: 'POST',
      url: '/auth/mfa/verify',
      payload: { code: totp(secret, Date.now()) },
      headers: { authorization: `Bearer ${tokenContador}` },
    });

    // Una cuenta imputable y un documento con campos extraídos.
    cuentaId = (
      await app.inject({
        method: 'POST',
        url: '/accounts',
        headers: cabeceras(tokenContador),
        payload: { code: '5.1.01', name: 'Servicios', type: 'GASTO' },
      })
    ).json<{ id: string }>().id;

    const subida = await app.inject({
      method: 'POST',
      url: '/documents',
      headers: {
        ...cabeceras(tokenContador),
        'content-type': `multipart/form-data; boundary=${LIMITE}`,
      },
      payload: Buffer.from(
        [
          `--${LIMITE}`,
          'Content-Disposition: form-data; name="file"; filename="comprobante.xml"',
          'Content-Type: application/xml',
          '',
          XML_FACTURA,
          `--${LIMITE}--`,
          '',
        ].join('\r\n'),
        'utf8',
      ),
    });
    documentId = subida.json<{ id: string }>().id;
  });

  afterAll(async () => {
    await app?.close();
    await raw?.end();
    await closePool();
  });

  it('sin proveedor de IA y sin historia, no inventa una sugerencia', async () => {
    const respuesta = await app.inject({
      method: 'POST',
      url: `/documents/${documentId}/classify`,
      headers: cabeceras(tokenContador),
    });
    expect(respuesta.statusCode).toBe(200);
    expect(respuesta.json<{ estado: string; motivo: string }>()).toMatchObject({
      estado: 'SIN_SUGERENCIA',
      motivo: 'IA_DESHABILITADA',
    });
  });

  it('con historia de la empresa sugiere, sin mandar nada afuera', async () => {
    await raw.query(
      `INSERT INTO classification_preferences
         (company_id, signal, suggested_account_id, support_count, last_confirmed_at)
       VALUES ($1, $2, $3, 6, now())`,
      [companyId, `proveedor:${CUIT_EMISOR}`, cuentaId],
    );

    const respuesta = await app.inject({
      method: 'POST',
      url: `/documents/${documentId}/classify`,
      headers: cabeceras(tokenContador),
    });
    expect(respuesta.statusCode, respuesta.body).toBe(201);

    const cuerpo = respuesta.json<{
      id: string;
      output: { cuentaId: string; cuentaCodigo: string };
      triage: { band: string; hardBlocks: string[] };
      normativeSources: unknown[];
      aviso: string;
    }>();
    predictionId = cuerpo.id;

    expect(cuerpo.output.cuentaCodigo).toBe('5.1.01');
    expect(cuerpo.normativeSources).toHaveLength(0);
    // Hoy toda propuesta cae en 🔴: sin motor normativo nada puede fundarse.
    expect(cuerpo.triage.band).toBe('BAJA');
    expect(cuerpo.triage.hardBlocks).toContain('MOTOR_NORMATIVO_NO_DISPONIBLE');
    // §42: nunca se presenta como asesoramiento profesional.
    expect(cuerpo.aviso).toMatch(/aprobación profesional/i);
  });

  it('la propuesta queda en la bitácora con actor de IA, no del usuario', async () => {
    const auditado = await raw.query<{ actor_type: string; actor_id: string }>(
      `SELECT actor_type, actor_id FROM audit_logs
        WHERE company_id = $1 AND action = 'PROPONER_CLASIFICACION'
        ORDER BY occurred_at DESC LIMIT 1`,
      [companyId],
    );
    expect(auditado.rows[0]).toMatchObject({
      actor_type: 'AI',
      actor_id: 'ai:CLASSIFICATION',
    });
  });

  it('la bandeja muestra la propuesta con su aviso', async () => {
    const respuesta = await app.inject({
      method: 'GET',
      url: '/predictions',
      headers: cabeceras(tokenContador),
    });
    expect(respuesta.statusCode).toBe(200);
    const cuerpo = respuesta.json<{ predicciones: { id: string }[]; aviso: string }>();
    expect(cuerpo.predicciones.map((p) => p.id)).toContain(predictionId);
    expect(cuerpo.aviso).toMatch(/Ninguna de estas propuestas está contabilizada/);
  });

  it('quien carga documentos no decide una imputación', async () => {
    const respuesta = await app.inject({
      method: 'POST',
      url: `/predictions/${predictionId}/review`,
      headers: cabeceras(tokenCargador),
      payload: { decision: 'APROBADA' },
    });
    expect(respuesta.statusCode).toBe(403);
  });

  it('aprobar refuerza la preferencia de la empresa', async () => {
    const antes = await raw.query<{ support_count: number }>(
      'SELECT support_count FROM classification_preferences WHERE company_id = $1 AND suggested_account_id = $2',
      [companyId, cuentaId],
    );

    const respuesta = await app.inject({
      method: 'POST',
      url: `/predictions/${predictionId}/review`,
      headers: cabeceras(tokenContador),
      payload: { decision: 'APROBADA' },
    });
    expect(respuesta.statusCode, respuesta.body).toBe(201);

    const despues = await raw.query<{ support_count: number }>(
      'SELECT support_count FROM classification_preferences WHERE company_id = $1 AND suggested_account_id = $2',
      [companyId, cuentaId],
    );
    expect(despues.rows[0]!.support_count).toBe(antes.rows[0]!.support_count + 1);
  });

  it('una propuesta se revisa una sola vez', async () => {
    const respuesta = await app.inject({
      method: 'POST',
      url: `/predictions/${predictionId}/review`,
      headers: cabeceras(tokenContador),
      payload: { decision: 'RECHAZADA', motivo: 'me arrepentí' },
    });
    expect(respuesta.statusCode).toBe(409);
  });

  it('un rechazo sin motivo y una modificación sin cuenta se rechazan', async () => {
    const otra = await app.inject({
      method: 'POST',
      url: `/documents/${documentId}/classify`,
      headers: cabeceras(tokenContador),
    });
    const otraId = otra.json<{ id: string }>().id;

    const sinMotivo = await app.inject({
      method: 'POST',
      url: `/predictions/${otraId}/review`,
      headers: cabeceras(tokenContador),
      payload: { decision: 'RECHAZADA' },
    });
    expect(sinMotivo.statusCode).toBe(400);

    const sinCuenta = await app.inject({
      method: 'POST',
      url: `/predictions/${otraId}/review`,
      headers: cabeceras(tokenContador),
      payload: { decision: 'MODIFICADA' },
    });
    expect(sinCuenta.statusCode).toBe(400);
  });

  it('publica la deriva separando invención, error de criterio y rechazo humano', async () => {
    const respuesta = await app.inject({
      method: 'GET',
      url: '/predictions/metrics',
      headers: cabeceras(tokenContador),
    });
    expect(respuesta.statusCode).toBe(200);
    const cuerpo = respuesta.json<{
      rechazosAutomaticos: unknown[];
      revisionesHumanas: { decision: string; total: number }[];
      distribucionPorBanda: { banda: string; total: number }[];
    }>();
    expect(cuerpo.revisionesHumanas.some((fila) => fila.decision === 'APROBADA')).toBe(true);
    expect(cuerpo.distribucionPorBanda.some((fila) => fila.banda === 'BAJA')).toBe(true);
  });
});
