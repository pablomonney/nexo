/**
 * La exportación completa de una empresa — de punta a punta, sobre una empresa que **entró con información anterior**.
 *
 * Lo que se afirma, y por qué importa:
 *
 *   1. **Está todo**: cada tabla con `company_id` sale, con tantas líneas como filas tiene en la base, y la lista de lo que
 *      no se pudo leer está vacía. Una exportación que cree estar completa y no lo está es peor que no tenerla.
 *   2. **Está verificado**: el sha256 de cada archivo coincide con el manifiesto.
 *   3. **Es de ella y de nadie más**: ni una fila de la empresa de al lado.
 *   4. **No se lleva un secreto**: ni tokens de integraciones ni contraseñas de usuarios.
 *   5. **Incluye lo migrado y los documentos**: las tablas de la migración y los archivos subidos, byte a byte.
 *   6. **Deja rastro**: motivo obligatorio y bitácora; sólo quien administra puede pedirla.
 *   7. **Los importes salen exactos**, tal como los guarda PostgreSQL.
 */

import { createHash } from 'node:crypto';
import { closePool, withCompany } from '@aai/db';
import { ArchivoZip } from '@aai/document-engine';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  cargarOrigen,
  crearMigracion,
  declararMapeo,
  importar,
  validarMigracion,
} from '@aai/api/migracion/ciclo';
import type { Entidad } from '@aai/migration-engine';
import { hasDatabase, seed, type Client } from './helpers/db.js';
import { crearEntorno, type EntornoApi } from './helpers/entorno-api.js';
import { ARCHIVOS, ENTIDAD_DE, FECHA_ISO, MAPEO_DE } from './helpers/empresa-migrada.js';
import { armarZip } from './helpers/zip.js';

const suite = hasDatabase ? describe : describe.skip;
const actor = 'user:migrador';

/** Un PNG de 1×1, válido. */
const PNG = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==',
  'base64',
);
const LIMITES = { maxTotalDescomprimido: 1 << 30, maxPorEntrada: 1 << 28, maxEntradas: 70_000 };
const MOTIVO = 'Llevarnos los datos a nuestro archivo propio';

suite('exportación completa de la empresa', () => {
  let env: EntornoApi;
  let db: Client;
  let otra = '';
  let marcaDeLaOtra = '';
  let respuesta: Awaited<ReturnType<EntornoApi['pedir']>>;
  let zip: ArchivoZip;
  let manifiesto: Manifiesto;

  interface TablaDelManifiesto { tabla: string; archivo: string; filas: number; bytes: number; sha256: string; columnasExcluidas: string[] }
  interface Manifiesto {
    formato: string;
    empresa: { id: string; razonSocial: string };
    exportadoPor: string;
    motivo: string;
    tablas: TablaDelManifiesto[];
    catalogos: TablaDelManifiesto[];
    noLegibles: string[];
    tablasExcluidas: { tabla: string }[];
    archivosFijos: { archivo: string; filas: number; sha256: string }[];
    archivos: { incluidos: number; faltantes: string[] };
    totales: { tablas: number; filas: number };
  }

  const lineasDe = (nombre: string): string[] => zip.leer(nombre).toString('utf8').split('\n').filter((l) => l !== '');
  const sha = (b: Buffer | string): string => createHash('sha256').update(b).digest('hex');

  /** La migración de otro sistema, igual que en `migracion-empresa-completa.test.ts`. */
  async function migrar(companyId: string): Promise<void> {
    const id = await withCompany({ companyId, actorId: actor }, async (tx) => {
      const id = await crearMigracion(tx, companyId, actor, {
        adaptador: 'ARCHIVO_GENERICO',
        titulo: 'Empresa completa del sistema anterior',
        fechaCorte: FECHA_ISO,
      });
      await cargarOrigen(tx, companyId, actor, id, { nombre: 'empresa.zip', bytes: armarZip(ARCHIVOS) });
      const { rows } = await tx.query<{ id: string; nombre: string }>('SELECT id, nombre FROM migration_tables WHERE migration_id = $1', [id]);
      await declararMapeo(
        tx,
        companyId,
        actor,
        id,
        rows.map((t) => ({ id: t.id, entidad: ENTIDAD_DE[t.nombre] as Entidad, mapeo: MAPEO_DE[t.nombre]!, incluida: true })),
      );
      const veredicto = await validarMigracion(tx, companyId, actor, id);
      expect(veredicto.sePuedeImportar, JSON.stringify(veredicto)).toBe(true);
      return id;
    });
    const r = await importar(companyId, actor, id);
    expect(r.estado, JSON.stringify(r.conteos)).toMatch(/^COMPLETADA/);
  }

  beforeAll(async () => {
    env = await crearEntorno('exportacion');
    db = env.db;

    // La empresa entra con información anterior…
    await migrar(env.empresa);

    // …y además tiene datos cargados a mano, un documento subido y una integración con su token.
    const alta = await env.pedir('POST', '/parties', {
      tipoDocumento: 'SIN_IDENTIFICAR',
      razonSocial: 'Cliente cargado a mano SA',
      roles: ['CLIENTE'],
    });
    expect(alta.statusCode, alta.body).toBe(201);

    const limite = `----nexo${Date.now()}`;
    const cuerpo = Buffer.concat([
      Buffer.from(`--${limite}\r\nContent-Disposition: form-data; name="origen"\r\n\r\nUPLOAD\r\n`),
      Buffer.from(`--${limite}\r\nContent-Disposition: form-data; name="file"; filename="comprobante.png"\r\nContent-Type: image/png\r\n\r\n`),
      PNG,
      Buffer.from(`\r\n--${limite}--\r\n`),
    ]);
    const doc = await env.pedir('POST', '/documents', cuerpo as never, { 'content-type': `multipart/form-data; boundary=${limite}` });
    expect(doc.statusCode, doc.body).toBeLessThan(300);

    const proveedor = (await db.query<{ code: string }>('SELECT code FROM integration_providers LIMIT 1')).rows[0]!.code;
    await db.query(
      `INSERT INTO company_integrations (company_id, provider, external_account_id, alias, access_token_encrypted, refresh_token_encrypted, key_encryption_ref, created_by)
       VALUES ($1, $2, 'cuenta-de-prueba', 'Mi integración', 'TOKEN-SECRETO-QUE-NO-DEBE-SALIR', 'REFRESH-SECRETO-QUE-NO-DEBE-SALIR', 'kms:clave-que-no-debe-salir', 'user:prueba')`,
      [env.empresa, proveedor],
    );

    // La empresa de al lado, con una marca inconfundible.
    const fx = await seed(db, 'exportacion-otra');
    otra = fx.companyB;
    marcaDeLaOtra = `MARCA-DE-LA-OTRA-${env.stamp}`;
    await db.query(
      `INSERT INTO parties (company_id, tipo_documento, razon_social, created_by) VALUES ($1, 'SIN_IDENTIFICAR', $2, 'user:prueba')`,
      [otra, marcaDeLaOtra],
    );

    respuesta = await env.pedir('POST', '/companies/current/exportacion-completa', { motivo: MOTIVO });
    expect(respuesta.statusCode, respuesta.body.slice(0, 300)).toBe(200);
    zip = new ArchivoZip(respuesta.rawPayload, LIMITES);
    manifiesto = JSON.parse(zip.leer('manifiesto.json').toString('utf8')) as Manifiesto;
  }, 300_000);

  afterAll(async () => {
    await env?.cerrar();
    await closePool().catch(() => undefined);
  });

  describe('la respuesta', () => {
    it('es un ZIP descargable, sin caché, con el formato declarado', () => {
      expect(respuesta.headers['content-type']).toBe('application/zip');
      expect(String(respuesta.headers['content-disposition'])).toBe('attachment; filename="nexo-exportacion.zip"');
      expect(respuesta.headers['cache-control']).toBe('no-store');
      expect(manifiesto.formato).toBe('nexo-exportacion-completa/1');
      expect(manifiesto.empresa.id).toBe(env.empresa);
      expect(manifiesto.motivo).toBe(MOTIVO);
      for (const f of ['LEEME.txt', 'manifiesto.json', 'esquema.json', 'empresa.ndjson', 'usuarios.ndjson']) {
        expect(zip.tiene(f), f).toBe(true);
      }
    });
  });

  describe('1 · está todo', () => {
    it('sale cada tabla con company_id, ninguna se quedó sin leer y los totales cierran', async () => {
      const esperadas = (
        await db.query<{ tabla: string }>(
          `SELECT c.relname AS tabla FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace AND n.nspname = 'public'
            WHERE c.relkind IN ('r','p') AND EXISTS (SELECT 1 FROM pg_attribute a WHERE a.attrelid = c.oid AND a.attname = 'company_id' AND NOT a.attisdropped)
            ORDER BY 1`,
        )
      ).rows.map((r) => r.tabla);
      const excluidas = new Set(manifiesto.tablasExcluidas.map((t) => t.tabla));
      expect(manifiesto.noLegibles, 'Hay tablas de la empresa que la aplicación no puede leer: la exportación estaría incompleta').toEqual([]);
      expect(manifiesto.tablas.map((t) => t.tabla)).toEqual(esperadas.filter((t) => !excluidas.has(t)));
      expect(manifiesto.totales.filas).toBe(manifiesto.tablas.reduce((s, t) => s + t.filas, 0));
    });

    it('cada archivo tiene tantas líneas como filas hay en la base para esa empresa', async () => {
      for (const t of manifiesto.tablas) {
        // La bitácora de la propia exportación se escribe DESPUÉS de leerla (en la misma transacción): no puede estar adentro.
        const filtro = t.tabla === 'audit_logs' ? " AND action <> 'EXPORTAR_EMPRESA'" : '';
        const enLaBase = Number((await db.query<{ n: string }>(`SELECT count(*)::text AS n FROM "${t.tabla}" WHERE company_id = $1${filtro}`, [env.empresa])).rows[0]!.n);
        expect(lineasDe(t.archivo).length, t.tabla).toBe(enLaBase);
        expect(t.filas, t.tabla).toBe(enLaBase);
      }
    });

    it('lleva lo que entró por la migración y lo que se cargó a mano', () => {
      const terceros = lineasDe('datos/parties.ndjson').map((l) => JSON.parse(l) as { razon_social: string });
      expect(terceros.length).toBeGreaterThan(1);
      expect(terceros.some((p) => p.razon_social === 'Cliente cargado a mano SA')).toBe(true);
      for (const t of ['migrations', 'migration_batches', 'migration_rows', 'migration_tables']) {
        expect(manifiesto.tablas.find((x) => x.tabla === t)?.filas ?? 0, t).toBeGreaterThan(0);
      }
      expect(manifiesto.tablas.find((x) => x.tabla === 'products')?.filas ?? 0).toBeGreaterThan(0);
      expect(manifiesto.tablas.find((x) => x.tabla === 'warehouses')?.filas ?? 0).toBeGreaterThan(0);
    });

    it('los catálogos globales a los que apuntan los datos también salen', () => {
      expect(manifiesto.catalogos.length).toBeGreaterThan(0);
      expect(manifiesto.catalogos.every((c) => c.archivo.startsWith('catalogos/'))).toBe(true);
    });
  });

  describe('2 · está verificado', () => {
    it('el sha256 y las filas del manifiesto coinciden con lo que hay adentro del ZIP', () => {
      for (const t of [...manifiesto.tablas, ...manifiesto.catalogos]) {
        expect(sha(zip.leer(t.archivo)), t.archivo).toBe(t.sha256);
        expect(zip.leer(t.archivo).length, t.archivo).toBe(t.bytes);
      }
      for (const f of manifiesto.archivosFijos) expect(sha(zip.leer(f.archivo)), f.archivo).toBe(f.sha256);
    });

    it('todos los archivos del ZIP están en el manifiesto (no hay nada suelto sin verificar)', () => {
      const declarados = new Set([
        'LEEME.txt', 'manifiesto.json', 'esquema.json',
        ...manifiesto.archivosFijos.map((f) => f.archivo),
        ...manifiesto.tablas.map((t) => t.archivo),
        ...manifiesto.catalogos.map((c) => c.archivo),
      ]);
      const sueltos = zip.nombres.filter((n) => !declarados.has(n) && !n.startsWith('archivos/'));
      expect(sueltos).toEqual([]);
    });
  });

  describe('3 · es de ella y de nadie más', () => {
    it('ninguna fila ni texto es de la empresa de al lado', () => {
      for (const nombre of zip.nombres) {
        const texto = zip.leer(nombre);
        expect(texto.includes(Buffer.from(marcaDeLaOtra)), nombre).toBe(false);
        expect(texto.includes(Buffer.from(otra)), nombre).toBe(false);
      }
      for (const t of manifiesto.tablas) {
        for (const l of lineasDe(t.archivo)) {
          const fila = JSON.parse(l) as { company_id?: string };
          if (fila.company_id !== undefined) expect(fila.company_id, t.tabla).toBe(env.empresa);
        }
      }
    });
  });

  describe('4 · no se lleva un secreto', () => {
    it('el token y la referencia de la integración NO salen, y el manifiesto dice que se sacaron', () => {
      const integraciones = lineasDe('datos/company_integrations.ndjson');
      expect(integraciones).toHaveLength(1);
      const fila = JSON.parse(integraciones[0]!) as Record<string, unknown>;
      expect(fila['alias']).toBe('Mi integración');
      for (const c of ['access_token_encrypted', 'refresh_token_encrypted', 'key_encryption_ref']) expect(c in fila, c).toBe(false);
      const t = manifiesto.tablas.find((x) => x.tabla === 'company_integrations')!;
      expect(t.columnasExcluidas.sort()).toEqual(['access_token_encrypted', 'key_encryption_ref', 'refresh_token_encrypted']);
      for (const nombre of zip.nombres) {
        const b = zip.leer(nombre);
        for (const secreto of ['TOKEN-SECRETO-QUE-NO-DEBE-SALIR', 'REFRESH-SECRETO-QUE-NO-DEBE-SALIR', 'kms:clave-que-no-debe-salir']) {
          expect(b.includes(Buffer.from(secreto)), `${nombre} contiene ${secreto}`).toBe(false);
        }
      }
    });

    it('de los usuarios sale quiénes son y su rol; nunca la contraseña ni el segundo factor', async () => {
      const usuarios = lineasDe('usuarios.ndjson').map((l) => JSON.parse(l) as Record<string, unknown>);
      const yo = usuarios.find((u) => u['user_id'] === env.userId);
      expect(yo).toBeDefined();
      expect(String(yo!['email'])).toContain('operador-exportacion');
      expect((yo!['roles'] as { role: string }[]).map((r) => r.role).sort()).toEqual(['ADMINISTRADOR', 'CONTADOR']);
      for (const c of ['password_hash', 'mfa_secret_encrypted', 'mfa_enabled']) expect(c in yo!, c).toBe(false);

      const { password_hash: hash } = (await db.query<{ password_hash: string }>('SELECT password_hash FROM users WHERE id = $1', [env.userId])).rows[0]!;
      for (const nombre of zip.nombres) expect(zip.leer(nombre).includes(Buffer.from(hash)), nombre).toBe(false);
    });

    it('la tabla de referencias a secretos no se exporta, y figura con su motivo', () => {
      expect(manifiesto.tablasExcluidas.map((t) => t.tabla)).toContain('secret_refs');
      expect(zip.tiene('datos/secret_refs.ndjson')).toBe(false);
    });
  });

  describe('5 · incluye los documentos', () => {
    it('el archivo subido sale idéntico byte a byte', () => {
      expect(manifiesto.archivos.incluidos).toBeGreaterThanOrEqual(1);
      expect(manifiesto.archivos.faltantes).toEqual([]);
      const adjuntos = zip.nombres.filter((n) => n.startsWith('archivos/'));
      expect(adjuntos.length).toBe(manifiesto.archivos.incluidos);
      expect(adjuntos.some((n) => zip.leer(n).equals(PNG))).toBe(true);
    });

    it('con incluirArchivos=false sale todo menos los archivos (y lo dice)', async () => {
      const r = await env.pedir('POST', '/companies/current/exportacion-completa', { motivo: MOTIVO, incluirArchivos: false });
      expect(r.statusCode).toBe(200);
      const z = new ArchivoZip(r.rawPayload, LIMITES);
      expect(z.nombres.some((n) => n.startsWith('archivos/'))).toBe(false);
      expect((JSON.parse(z.leer('manifiesto.json').toString('utf8')) as Manifiesto).archivos.incluidos).toBe(0);
    });
  });

  describe('6 · deja rastro y no la pide cualquiera', () => {
    it('sin motivo no hay exportación', async () => {
      expect((await env.pedir('POST', '/companies/current/exportacion-completa', {})).statusCode).toBe(400);
      expect((await env.pedir('POST', '/companies/current/exportacion-completa', { motivo: 'no' })).statusCode).toBe(400);
    });

    it('queda en la bitácora con el motivo y los totales, sin el contenido', async () => {
      const { rows } = await db.query<{ motivo: string; new_value: { tablas: number; filas: number; noLegibles: number; archivos: number } }>(
        `SELECT motivo, new_value FROM audit_logs WHERE company_id = $1 AND action = 'EXPORTAR_EMPRESA'`,
        [env.empresa],
      );
      // Dos exportaciones pidieron motivo en este archivo: la completa y la sin archivos.
      expect(rows.length).toBeGreaterThanOrEqual(1);
      const completa = rows.find((r) => r.new_value.archivos >= 1);
      expect(completa, 'la exportación completa quedó en la bitácora').toBeDefined();
      expect(completa!.motivo).toBe(MOTIVO);
      expect(completa!.new_value.tablas).toBe(manifiesto.totales.tablas);
      expect(completa!.new_value.filas).toBe(manifiesto.totales.filas);
      expect(completa!.new_value.noLegibles).toBe(0);
      expect(JSON.stringify(rows)).not.toContain('Cliente cargado a mano');
    });

    it('quien no tiene el permiso recibe 403, aunque pueda ver todo (un lector no se lleva la contabilidad)', async () => {
      const PASSWORD = 'una-contrasena-suficientemente-larga';
      const login = async (email: string): Promise<string> =>
        (await env.app.inject({ method: 'POST', url: '/auth/login', payload: { email, password: PASSWORD } })).json<{ token: string }>().token;
      const tokenFundador = await login(`fundador-exportacion-${env.stamp}@estudio.test`);
      const correo = `lector-exportacion-${env.stamp}@estudio.test`;
      const lector = (
        await env.app.inject({
          method: 'POST',
          url: `/organizations/${env.organizationId}/users`,
          headers: { authorization: `Bearer ${tokenFundador}` },
          payload: { email: correo, fullName: 'Lector', password: PASSWORD, level: 'MEMBER' },
        })
      ).json<{ id: string }>().id;
      await env.app.inject({
        method: 'POST',
        url: `/companies/${env.empresa}/roles`,
        headers: { authorization: `Bearer ${tokenFundador}` },
        payload: { userId: lector, role: 'SOLO_LECTURA' },
      });
      const token = await login(correo);
      const r = await env.app.inject({
        method: 'POST',
        url: '/companies/current/exportacion-completa',
        headers: { authorization: `Bearer ${token}`, 'x-company-id': env.empresa },
        payload: { motivo: MOTIVO },
      });
      expect(r.statusCode, r.body.slice(0, 200)).toBe(403);
      expect(r.body).toContain('company:export');
    });

    it('una sola exportación por empresa a la vez: la segunda recibe 409 EXPORTACION_EN_CURSO (determinista: la primera queda a medio leer)', async () => {
      // La primera se pide como flujo y NO se consume: con la contrapresión, el servidor queda esperando que alguien lea, y el
      // candado sigue tomado. Así la segunda llega con la primera en curso sin depender de cuánto tarde cada una.
      const primera = await env.app.inject({
        method: 'POST',
        url: '/companies/current/exportacion-completa',
        headers: { authorization: `Bearer ${env.token}`, 'x-company-id': env.empresa },
        payload: { motivo: MOTIVO, incluirArchivos: false },
        payloadAsStream: true,
      });
      expect(primera.statusCode).toBe(200);

      // Pase lo que pase, la primera se cierra: si quedara a medio leer, el servidor no terminaría nunca y colgaría la suite.
      const trozos: Buffer[] = [];
      try {
        const segunda = await env.pedir('POST', '/companies/current/exportacion-completa', { motivo: MOTIVO, incluirArchivos: false });
        expect(segunda.statusCode, segunda.body.slice(0, 200)).toBe(409);
        expect(segunda.json<{ error: string }>().error).toBe('EXPORTACION_EN_CURSO');

        // Se lee la primera hasta el final (libera el candado) y entonces se puede pedir otra.
        for await (const t of primera.stream()) trozos.push(Buffer.from(t as Buffer));
        expect(() => new ArchivoZip(Buffer.concat(trozos), LIMITES)).not.toThrow();
        expect((await env.pedir('POST', '/companies/current/exportacion-completa', { motivo: MOTIVO, incluirArchivos: false })).statusCode).toBe(200);
      } finally {
        primera.stream().destroy();
      }
    });

    it('sólo ADMINISTRADOR tiene el permiso company:export', async () => {
      const { rows } = await db.query<{ code: string }>(
        `SELECT r.code FROM role_permissions rp JOIN roles r ON r.id = rp.role_id JOIN permissions p ON p.id = rp.permission_id
          WHERE p.code = 'company:export' ORDER BY 1`,
      );
      expect(rows.map((r) => r.code)).toEqual(['ADMINISTRADOR']);
    });
  });

  describe('7 · los importes salen exactos', () => {
    it('un importe con decimales sale tal como lo guarda PostgreSQL, sin pasar por punto flotante', async () => {
      const conFilas = manifiesto.tablas.filter((t) => t.filas > 0 && t.tabla !== 'audit_logs').map((t) => t.tabla);
      const numericas = await db.query<{ tabla: string; columna: string }>(
        `SELECT table_name AS tabla, column_name AS columna FROM information_schema.columns
          WHERE table_schema = 'public' AND data_type = 'numeric' AND table_name = ANY($1::text[])
          ORDER BY table_name, ordinal_position`,
        [conFilas],
      );
      let comprobados = 0;
      for (const { tabla, columna } of numericas.rows) {
        const r = await db.query<{ v: string }>(
          `SELECT "${columna}"::text AS v FROM "${tabla}" WHERE company_id = $1 AND "${columna}" IS NOT NULL AND "${columna}" <> 0 AND "${columna}"::text LIKE '%.%' LIMIT 1`,
          [env.empresa],
        );
        if (r.rows[0] === undefined) continue;
        expect(zip.leer(`datos/${tabla}.ndjson`).toString('utf8'), `${tabla}.${columna}`).toContain(`"${columna}": ${r.rows[0].v}`);
        comprobados += 1;
      }
      expect(comprobados, 'no se encontró ningún importe con decimales para comparar: la prueba no probó nada').toBeGreaterThan(0);
    });
  });
});
