/**
 * Ingesta de documentos de punta a punta, por HTTP.
 *
 * Sube un comprobante real —bytes, multipart, autenticación, RLS, storage— y
 * comprueba lo que la fase promete: que el archivo queda archivado, que los
 * campos salen con las cuatro dimensiones del §10, que subirlo dos veces no
 * genera dos hechos contables, y que corregir un campo agrega en vez de pisar.
 */

import { closePool, initPool } from '@aai/db';
import { buildServer } from '@aai/api/server';
import { totp } from '@aai/shared';
import type { FastifyInstance } from 'fastify';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { connect, hasDatabase, type Client } from './helpers/db.js';

const suite = hasDatabase ? describe : describe.skip;

const PASSWORD = 'una-contrasena-suficientemente-larga';
const LIMITE = '----aaiTestBoundary';

const XML_FACTURA = `<?xml version="1.0" encoding="UTF-8"?>
<Comprobante>
  <Cuit>30712345671</Cuit>
  <CbteTipo>1</CbteTipo>
  <PtoVta>12</PtoVta>
  <CbteNro>45</CbteNro>
  <CbteFch>20260305</CbteFch>
  <ImpNeto>1019.83</ImpNeto>
  <ImpIVA>214.17</ImpIVA>
  <ImpTotal>1234.00</ImpTotal>
  <CAE>75123456789012</CAE>
</Comprobante>`;

suite('ingesta de documentos por HTTP', () => {
  let app: FastifyInstance;
  let raw: Client;
  let token: string;
  /** Sesión de un CONTADOR con MFA cumplido: es el único que puede descargar. */
  let tokenContador: string;
  let companyId: string;
  let documentId: string;
  let extractionId: string;

  function withCheckDigit(firstTen: string): string {
    const weights = [5, 4, 3, 2, 7, 6, 5, 4, 3, 2];
    const total = weights.reduce((acc, w, i) => acc + Number(firstTen[i]) * w, 0);
    const remainder = total % 11;
    return `${firstTen}${remainder === 0 ? 0 : remainder === 1 ? 9 : 11 - remainder}`;
  }

  /** Cuerpo multipart armado a mano: evita sumar una dependencia solo para el test. */
  function multipart(nombre: string, mime: string, contenido: string): Buffer {
    return Buffer.from(
      [
        `--${LIMITE}`,
        `Content-Disposition: form-data; name="file"; filename="${nombre}"`,
        `Content-Type: ${mime}`,
        '',
        contenido,
        `--${LIMITE}--`,
        '',
      ].join('\r\n'),
      'utf8',
    );
  }

  const subir = (nombre: string, mime: string, contenido: string) =>
    app.inject({
      method: 'POST',
      url: '/documents',
      headers: {
        authorization: `Bearer ${token}`,
        'x-company-id': companyId,
        'content-type': `multipart/form-data; boundary=${LIMITE}`,
      },
      payload: multipart(nombre, mime, contenido),
    });

  beforeAll(async () => {
    initPool(process.env.DATABASE_URL!);
    app = await buildServer();
    await app.ready();
    raw = await connect();

    const stamp = `${process.pid}${Date.now()}`.replace(/\D/g, '').slice(-8);
    const email = `cargador-doc-${stamp}@estudio.test`;

    const { hash: argonHash } = await import('@node-rs/argon2');
    const passwordHash = await argonHash(PASSWORD, {
      algorithm: 2,
      memoryCost: 19_456,
      timeCost: 2,
      parallelism: 1,
    });

    const usuario = await raw.query<{ id: string }>(
      'INSERT INTO users (email, full_name, password_hash) VALUES ($1, $2, $3) RETURNING id',
      [email, 'Cargador de documentos', passwordHash],
    );
    const userId = usuario.rows[0]!.id;

    const org = await raw.query<{ create_organization: string }>(
      'SELECT create_organization($1, $2, $3)',
      [`Estudio doc ${stamp}`, withCheckDigit(`30${stamp}`), userId],
    );
    const organizationId = org.rows[0]!.create_organization;

    const company = await raw.query<{ create_company: string }>(
      'SELECT create_company($1, $2, $3, $4, $5, $6, $7, $8)',
      [
        userId, organizationId, 'Empresa doc', withCheckDigit(`33${stamp}`),
        'SRL', 'AR-C', 'IGJ', '12-31',
      ],
    );
    companyId = company.rows[0]!.create_company;

    // CARGADOR: tiene document:upload y document:read, y no exige segundo factor.
    await raw.query('SELECT grant_company_role($1, $2, $3, $4)', [
      userId, companyId, userId, 'CARGADOR',
    ]);

    const login = await app.inject({
      method: 'POST',
      url: '/auth/login',
      payload: { email, password: PASSWORD },
    });
    token = login.json<{ token: string }>().token;

    // Segundo usuario, CONTADOR, con segundo factor: el rol lo exige y sin él
    // no llega ni a la empresa.
    const emailContador = `contador-doc-${stamp}@estudio.test`;
    const contador = await raw.query<{ id: string }>(
      'INSERT INTO users (email, full_name, password_hash) VALUES ($1, $2, $3) RETURNING id',
      [emailContador, 'Contador', passwordHash],
    );
    // Un rol en una empresa solo se le puede dar a alguien del estudio.
    await raw.query(
      'INSERT INTO organization_members (organization_id, user_id, level) VALUES ($1, $2, $3)',
      [organizationId, contador.rows[0]!.id, 'MEMBER'],
    );
    await raw.query('SELECT grant_company_role($1, $2, $3, $4)', [
      userId, companyId, contador.rows[0]!.id, 'CONTADOR',
    ]);

    const inicial = (
      await app.inject({
        method: 'POST',
        url: '/auth/login',
        payload: { email: emailContador, password: PASSWORD },
      })
    ).json<{ token: string }>().token;

    const setup = await app.inject({
      method: 'POST',
      url: '/auth/mfa/setup',
      headers: { authorization: `Bearer ${inicial}` },
    });
    const secret = setup.json<{ secret: string }>().secret;
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
  });

  afterAll(async () => {
    await app?.close();
    await raw?.end();
    await closePool();
  });

  it('archiva el comprobante y extrae sus campos', async () => {
    const respuesta = await subir('comprobante.xml', 'application/xml', XML_FACTURA);
    expect(respuesta.statusCode).toBe(201);

    const cuerpo = respuesta.json<{
      id: string;
      extractionId: string;
      documento: { sha256: string; tipo: string };
      extraccion: {
        disponible: boolean;
        campos: { fieldPath: string; rawValue: string | null; confidence: number; method: string }[];
      };
      hallazgos: { bloquea: boolean }[];
    }>();

    documentId = cuerpo.id;
    extractionId = cuerpo.extractionId;

    expect(cuerpo.documento.tipo).toBe('XML');
    expect(cuerpo.documento.sha256).toHaveLength(64);
    expect(cuerpo.extraccion.disponible).toBe(true);

    const total = cuerpo.extraccion.campos.find((c) => c.fieldPath === 'importes.total');
    expect(total?.rawValue).toBe('1234.00');
    expect(total?.method).toBe('XML');
    expect(total?.confidence).toBe(1);

    // Neto + IVA da el total: nada que frene la imputación.
    expect(cuerpo.hallazgos.filter((h) => h.bloquea)).toHaveLength(0);
  });

  it('el mismo archivo subido de nuevo devuelve el documento existente, no uno nuevo', async () => {
    const respuesta = await subir('otro-nombre.xml', 'application/xml', XML_FACTURA);
    expect(respuesta.statusCode).toBe(200);
    expect(respuesta.json<{ id: string }>().id).toBe(documentId);
    expect(respuesta.json<{ nivel: string }>().nivel).toBe('ARCHIVO_IDENTICO');

    const cuantos = await raw.query<{ n: string }>(
      'SELECT count(*)::text AS n FROM documents WHERE company_id = $1',
      [companyId],
    );
    expect(cuantos.rows[0]!.n).toBe('1');
  });

  it('rechaza un archivo cuyo contenido no coincide con lo declarado', async () => {
    const respuesta = await subir('factura.pdf', 'application/pdf', XML_FACTURA);
    expect(respuesta.statusCode).toBe(400);
    expect(respuesta.json<{ details: { motivo: string } }>().details.motivo).toBe(
      'TIPO_DECLARADO_NO_COINCIDE',
    );

    // El rechazo también queda en la bitácora: que un archivo no haya entrado
    // es información, y sin registro nadie puede reconstruir por qué falta.
    const auditado = await raw.query<{ n: string }>(
      `SELECT count(*)::text AS n FROM audit_logs
        WHERE company_id = $1 AND action = 'RECHAZAR_DOCUMENTO'`,
      [companyId],
    );
    expect(Number(auditado.rows[0]!.n)).toBeGreaterThan(0);
  });

  it('ver un documento y bajarlo son permisos distintos', async () => {
    const respuesta = await app.inject({
      method: 'GET',
      url: `/documents/${documentId}/content`,
      headers: { authorization: `Bearer ${token}`, 'x-company-id': companyId },
    });
    // El CARGADOR sube y ve la ficha, pero no se lleva el original.
    expect(respuesta.statusCode).toBe(403);
  });

  it('devuelve el original como attachment, nunca inline', async () => {
    const respuesta = await app.inject({
      method: 'GET',
      url: `/documents/${documentId}/content`,
      headers: { authorization: `Bearer ${tokenContador}`, 'x-company-id': companyId },
    });
    expect(respuesta.statusCode, respuesta.body).toBe(200);
    expect(respuesta.body).toBe(XML_FACTURA);

    // `inline` haría que un XML o un SVG subido por un tercero se ejecutara en
    // el origen de la aplicación.
    expect(respuesta.headers['content-disposition']).toMatch(/^attachment;/);
    expect(respuesta.headers['x-content-type-options']).toBe('nosniff');
  });

  it('la corrección de un campo agrega una fila MANUAL y conserva la original', async () => {
    const respuesta = await app.inject({
      method: 'POST',
      url: `/documents/${documentId}/fields`,
      headers: { authorization: `Bearer ${token}`, 'x-company-id': companyId },
      payload: {
        extractionId,
        fieldPath: 'importes.total',
        rawValue: '1334.00',
        parsedValue: { kind: 'MONEY', amount: '133400', currency: 'ARS' },
        motivo: 'El XML del proveedor traía el total sin el recargo',
      },
    });
    expect(respuesta.statusCode).toBe(201);

    const filas = await raw.query<{ method: string; raw_value: string }>(
      `SELECT method, raw_value FROM document_extraction_fields
        WHERE extraction_id = $1 AND field_path = 'importes.total' ORDER BY method`,
      [extractionId],
    );
    expect(filas.rows.map((f) => f.method)).toEqual(['MANUAL', 'XML']);
    expect(filas.rows.map((f) => f.raw_value)).toEqual(['1334.00', '1234.00']);
  });

  it('lista el documento con su estado de revisión', async () => {
    const respuesta = await app.inject({
      method: 'GET',
      url: '/documents',
      headers: { authorization: `Bearer ${token}`, 'x-company-id': companyId },
    });
    expect(respuesta.statusCode).toBe(200);

    const documentos = respuesta.json<{
      documentos: { id: string; extraccionDisponible: boolean; tieneHallazgoBloqueante: boolean }[];
    }>().documentos;

    const nuestro = documentos.find((doc) => doc.id === documentId);
    expect(nuestro?.extraccionDisponible).toBe(true);
    expect(nuestro?.tieneHallazgoBloqueante).toBe(false);
  });

  it('no deja ver el documento desde otra empresa', async () => {
    const otra = await raw.query<{ id: string }>(
      'SELECT id FROM companies WHERE id <> $1 LIMIT 1',
      [companyId],
    );
    if (otra.rowCount === 0) return;

    const respuesta = await app.inject({
      method: 'GET',
      url: `/documents/${documentId}`,
      headers: { authorization: `Bearer ${token}`, 'x-company-id': otra.rows[0]!.id },
    });
    // 403 porque el usuario no tiene rol en esa empresa; nunca 200.
    expect(respuesta.statusCode).toBe(403);
  });
});
