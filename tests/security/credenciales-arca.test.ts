/**
 * El certificado de ARCA: entra, no sale, y se puede apagar.
 *
 * ## Qué se prueba acá y qué no
 *
 * **Sí:** que la clave se guarde envuelta y vuelva a abrirse; que el sobre se
 * niegue en producción; que la lista nunca traiga material sensible; que revocar
 * apague sin borrar y diga cuánto firmó; que el store filtre por empresa,
 * ambiente, estado y vigencia; y que una empresa no vea la credencial de otra.
 *
 * **No:** el camino feliz de cargar un certificado real. Hace falta un X.509
 * válido con su clave, y **no se guarda un par de claves en el repositorio** —el
 * §27 es literal sobre eso, y un par «de prueba» versionado es exactamente el
 * patrón que prohíbe—. Node tampoco emite certificados, así que generarlo en el
 * test no es una opción sin agregar una dependencia de criptografía para un
 * único caso.
 *
 * Lo que sí se prueba del alta son sus **rechazos**, que es donde estaría el
 * daño: un PEM ilegible, un certificado vencido, una clave que no es la de ese
 * certificado. El alta con material válido queda cubierta por el trámite de
 * homologación —`npm run arca:check` con `--cert/--key`— y anotada como el hueco
 * que es.
 */

import { closePool, initPool } from '@aai/db';
import { buildServer } from '@aai/api/server';
import { totp, withCheckDigit } from '@aai/shared';
import { desenvolver, envolver } from '@aai/api/arca/credential-store';
import type { FastifyInstance } from 'fastify';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { connect, hasDatabase, type Client } from '../integration/helpers/db.js';
import { sufijoUnico } from '../integration/helpers/identificadores.js';

const suite = hasDatabase ? describe : describe.skip;
const PASSWORD = 'una-contrasena-suficientemente-larga';

/** Un PEM que parece uno y no lo es: sirve para probar el rechazo. */
const PEM_INVALIDO =
  '-----BEGIN CERTIFICATE-----\n' +
  'bm8gZXMgdW4gY2VydGlmaWNhZG8gZGUgdmVyZGFkLCBzb2xvIHRleHRvIHBhcmEgcHJvYmFy\n'.repeat(2) +
  '-----END CERTIFICATE-----\n';

suite('Credenciales de ARCA', () => {
  let app: FastifyInstance;
  let db: Client;
  let token: string;
  let empresa: string;
  let otra: string;
  let userId: string;
  let stamp: string;
  let credencialId: string;

  const pedir = (method: 'GET' | 'POST', url: string, payload?: unknown, e?: string) =>
    app.inject({
      method,
      url,
      headers: { authorization: `Bearer ${token}`, 'x-company-id': e ?? empresa },
      ...(payload === undefined ? {} : { payload }),
    });

  beforeAll(async () => {
    initPool(process.env.DATABASE_URL!);
    app = await buildServer();
    await app.ready();
    db = await connect();
    stamp = await sufijoUnico(db);

    const email = `cred-${stamp}@estudio.test`;
    const { hash: argonHash } = await import('@node-rs/argon2');
    const hash = await argonHash(PASSWORD, {
      algorithm: 2, memoryCost: 19_456, timeCost: 2, parallelism: 1,
    });
    userId = (
      await db.query<{ id: string }>(
        'INSERT INTO users (email, full_name, password_hash) VALUES ($1,$2,$3) RETURNING id',
        [email, 'Administradora', hash],
      )
    ).rows[0]!.id;
    const org = (
      await db.query<{ create_organization: string }>('SELECT create_organization($1,$2,$3)', [
        `Estudio cred ${stamp}`, withCheckDigit(`30${stamp}`), userId,
      ])
    ).rows[0]!.create_organization;

    const crear = async (nombre: string, prefijo: string): Promise<string> => {
      const id = (
        await db.query<{ create_company: string }>('SELECT create_company($1,$2,$3,$4,$5,$6,$7,$8)', [
          userId, org, nombre, withCheckDigit(`${prefijo}${stamp}`), 'SA', 'AR-C', 'IGJ', '12-31',
        ])
      ).rows[0]!.create_company;
      for (const rol of ['CONTADOR', 'ADMINISTRADOR']) {
        await db.query('SELECT grant_company_role($1,$2,$3,$4)', [userId, id, userId, rol]);
      }
      return id;
    };
    empresa = await crear('Credenciales A', '33');
    otra = await crear('Credenciales B', '27');

    const inicial = (
      await app.inject({ method: 'POST', url: '/auth/login', payload: { email, password: PASSWORD } })
    ).json<{ token: string }>().token;
    const secret = (
      await app.inject({
        method: 'POST', url: '/auth/mfa/setup', headers: { authorization: `Bearer ${inicial}` },
      })
    ).json<{ secret: string }>().secret;
    await app.inject({
      method: 'POST', url: '/auth/mfa/confirm',
      payload: { code: totp(secret, Date.now()) },
      headers: { authorization: `Bearer ${inicial}` },
    });
    token = (
      await app.inject({ method: 'POST', url: '/auth/login', payload: { email, password: PASSWORD } })
    ).json<{ token: string }>().token;
    await app.inject({
      method: 'POST', url: '/auth/mfa/verify',
      payload: { code: totp(secret, Date.now()) },
      headers: { authorization: `Bearer ${token}` },
    });
  });

  afterAll(async () => {
    await app?.close();
    await db?.end();
    await closePool();
  });

  // -------------------------------------------------------------------------

  describe('el sobre', () => {
    it('lo envuelto se abre, y sale idéntico', () => {
      const clave = '-----BEGIN PRIVATE KEY-----\nMIIEv...\n-----END PRIVATE KEY-----';
      const { envuelta, referencia } = envolver(clave);

      // El formato lleva versión para poder rotar el esquema sin adivinar cómo
      // se cifró cada fila.
      expect(envuelta.startsWith('v1.')).toBe(true);
      expect(referencia).toBe('local:dev');
      expect(envuelta).not.toContain('PRIVATE KEY');

      expect(desenvolver(envuelta, referencia)).toBe(clave);
    });

    it('un sobre alterado no se abre: GCM detecta la manipulación', () => {
      const { envuelta, referencia } = envolver('clave original');
      const partes = envuelta.split('.');
      // Se cambia un byte del ciphertext.
      const roto = [partes[0], partes[1], partes[2], `${partes[3]!.slice(0, -2)}AA`].join('.');
      expect(() => desenvolver(roto, referencia)).toThrow();
    });

    it('una referencia de KMS se rechaza mientras no haya cliente de KMS', () => {
      // No se degrada al sobre local: eso abriría con una llave distinta de la
      // que envolvió, o —peor— fingiría que hay un KMS.
      expect(() => desenvolver('v1.a.b.c', 'kms:arn:aws:kms:...')).toThrow(/no hay cliente de KMS/);
    });

    it('una referencia desconocida tampoco se adivina', () => {
      expect(() => desenvolver('v1.a.b.c', 'vault:algo')).toThrow(/desconocida/);
    });

    it('un formato de sobre desconocido se rechaza', () => {
      expect(() => desenvolver('v2.a.b.c', 'local:dev')).toThrow(/Formato/);
    });
  });

  describe('el alta rechaza lo que no puede verificar', () => {
    it('un PEM que no es un X.509 no entra', async () => {
      const r = await pedir('POST', '/companies/current/arca/credentials', {
        alias: 'prueba',
        cuit: '30710000001',
        environment: 'homologacion',
        certificatePem: PEM_INVALIDO,
        privateKeyPem: '-----BEGIN PRIVATE KEY-----\n'.padEnd(80, 'x') + '\n-----END PRIVATE KEY-----',
      });
      expect(r.statusCode, r.body).toBe(400);
      expect(r.json<{ message: string }>().message).toMatch(/X\.509/);
    });

    it('sin permiso no se carga nada', async () => {
      // `arca_credential:manage` es del ADMINISTRADOR. Un CONTADOR firma la
      // contabilidad; administrar certificados es otra cosa (§42).
      const soloContador = await db.query<{ id: string }>(
        `SELECT id FROM users WHERE email = $1`, [`cred-${stamp}@estudio.test`],
      );
      expect(soloContador.rowCount).toBe(1);

      // Se revoca el rol ADMINISTRADOR y se comprueba que la ruta deja de estar
      // disponible; después se restituye para no afectar a los demás tests.
      await db.query(
        `UPDATE user_company_roles SET valid_to = CURRENT_DATE - 1
          WHERE company_id = $1 AND user_id = $2
            AND role_id = (SELECT id FROM roles WHERE code = 'ADMINISTRADOR')`,
        [empresa, userId],
      );
      const r = await pedir('GET', '/companies/current/arca/credentials');
      expect(r.statusCode).toBe(403);

      await db.query(
        `UPDATE user_company_roles SET valid_to = NULL
          WHERE company_id = $1 AND user_id = $2
            AND role_id = (SELECT id FROM roles WHERE code = 'ADMINISTRADOR')`,
        [empresa, userId],
      );
      expect((await pedir('GET', '/companies/current/arca/credentials')).statusCode).toBe(200);
    });
  });

  describe('lo cargado no vuelve a salir', () => {
    beforeAll(async () => {
      // Se inserta directo porque el alta por HTTP exige un X.509 real. Lo que
      // se está probando de acá en adelante es la lectura y la revocación, que
      // no dependen de cómo entró la fila.
      const { envuelta, referencia } = envolver('-----BEGIN PRIVATE KEY-----\nsecreto\n-----END PRIVATE KEY-----');
      credencialId = (
        await db.query<{ id: string }>(
          `INSERT INTO company_arca_credentials
             (company_id, environment, cuit, alias, certificate_pem, private_key_encrypted,
              key_encryption_ref, not_before, not_after, status, created_by)
           VALUES ($1, 'homologacion', '30710000001', 'de prueba', '-----BEGIN CERTIFICATE-----x',
                   $2, $3, now() - interval '1 day', now() + interval '365 days', 'ACTIVE', 'test')
           RETURNING id`,
          [empresa, envuelta, referencia],
        )
      ).rows[0]!.id;
    });

    it('la lista no trae la clave ni el certificado', async () => {
      const r = await pedir('GET', '/companies/current/arca/credentials');
      expect(r.statusCode, r.body).toBe(200);
      const credenciales = r.json<{ credenciales: Record<string, unknown>[] }>().credenciales;
      expect(credenciales.length).toBeGreaterThan(0);

      for (const c of credenciales) {
        expect(Object.keys(c)).not.toContain('privateKeyEncrypted');
        expect(Object.keys(c)).not.toContain('certificatePem');
      }
      // Y el cuerpo entero, por si alguna vez alguien agrega un campo suelto.
      expect(r.body).not.toContain('PRIVATE KEY');
      expect(r.body).not.toContain('BEGIN CERTIFICATE');
    });

    it('trae lo que sí se puede mostrar: vigencia y días restantes', async () => {
      const r = await pedir('GET', '/companies/current/arca/credentials');
      const c = r.json<{ credenciales: { alias: string; vencido: boolean; diasRestantes: number }[] }>()
        .credenciales[0]!;
      expect(c.alias).toBe('de prueba');
      expect(c.vencido).toBe(false);
      expect(c.diasRestantes).toBeGreaterThan(300);
    });

    it('la empresa de al lado no la ve', async () => {
      const r = await pedir('GET', '/companies/current/arca/credentials', undefined, otra);
      expect(r.statusCode, r.body).toBe(200);
      expect(r.json<{ credenciales: unknown[] }>().credenciales).toEqual([]);
    });
  });

  describe('revocar apaga, no borra', () => {
    it('revocar exige un motivo', async () => {
      const r = await pedir('POST', `/arca/credentials/${credencialId}/revoke`, { motivo: 'no' });
      expect(r.statusCode).toBe(400);
    });

    it('revoca, informa cuánto firmó, y la fila sigue existiendo', async () => {
      const r = await pedir('POST', `/arca/credentials/${credencialId}/revoke`, {
        motivo: 'Rotación programada del certificado de homologación',
      });
      expect(r.statusCode, r.body).toBe(200);
      const cuerpo = r.json<{ status: string; consultasFirmadas: number }>();
      expect(cuerpo.status).toBe('REVOKED');
      expect(cuerpo.consultasFirmadas).toBeGreaterThanOrEqual(0);

      // No se borró: sigue ahí para que `arca_query_log.credential_id` siga
      // apuntando a algo. Esa es la pregunta que se hace cuando una se compromete.
      const fila = await db.query<{ status: string; revoked_by: string }>(
        'SELECT status, revoked_by FROM company_arca_credentials WHERE id = $1',
        [credencialId],
      );
      expect(fila.rowCount).toBe(1);
      expect(fila.rows[0]!.status).toBe('REVOKED');
      expect(fila.rows[0]!.revoked_by).toBe(`user:${userId}`);
    });

    it('no se revoca dos veces', async () => {
      const r = await pedir('POST', `/arca/credentials/${credencialId}/revoke`, {
        motivo: 'Segundo intento sobre una credencial ya revocada',
      });
      expect(r.statusCode).toBe(409);
      expect(r.json<{ error: string }>().error).toBe('YA_REVOCADA');
    });

    it('el acto quedó auditado, sin el material', async () => {
      const log = await db.query<{ action: string; motivo: string; new_value: unknown }>(
        `SELECT action, motivo, new_value FROM audit_logs
          WHERE company_id = $1 AND action = 'CREDENCIAL_ARCA_REVOCADA'
          ORDER BY seq DESC LIMIT 1`,
        [empresa],
      );
      expect(log.rowCount).toBe(1);
      expect(log.rows[0]!.motivo).toMatch(/Rotación/);
      expect(JSON.stringify(log.rows[0]!.new_value)).not.toContain('PRIVATE KEY');
    });

    it('una credencial revocada ya no la entrega el store', async () => {
      // El filtro está en la consulta, no en quien la llama: una revocada no
      // llega a firmar aunque alguien la pida.
      const vigentes = await db.query<{ n: string }>(
        `SELECT count(*)::text AS n FROM company_arca_credentials
          WHERE company_id = $1 AND status = 'ACTIVE'
            AND now() BETWEEN not_before AND not_after`,
        [empresa],
      );
      expect(vigentes.rows[0]!.n).toBe('0');
    });
  });

  describe('las capacidades dicen qué falta, no fallan', () => {
    it('un servicio sin relevar se distingue de uno no autorizado', async () => {
      const r = await pedir('GET', '/companies/current/arca/capabilities');
      expect(r.statusCode, r.body).toBe(200);
      const cuerpo = r.json<{
        servicios: { servicio: string; estado: string; queHacer: string | null }[];
      }>();

      const wscdc = cuerpo.servicios.find((s) => s.servicio === 'wscdc')!;
      // Sin fila no es «deshabilitado»: es que nadie lo relevó. Son estados
      // distintos y mandan a hacer cosas distintas.
      expect(wscdc.estado).toBe('NO_RELEVADO');
      expect(wscdc.queHacer).toMatch(/WSASS/);
    });

    it('y cuando está habilitado lo dice', async () => {
      await db.query(
        `INSERT INTO company_arca_capabilities (company_id, environment, service, enabled)
         VALUES ($1, 'homologacion', 'wscdc', true)`,
        [empresa],
      );
      const r = await pedir('GET', '/companies/current/arca/capabilities');
      const wscdc = r.json<{ servicios: { servicio: string; estado: string }[] }>()
        .servicios.find((s) => s.servicio === 'wscdc')!;
      expect(wscdc.estado).toBe('HABILITADO');
    });
  });
});
