/**
 * El recorrido que hasta la FASE 3 era imposible.
 *
 * ```
 * LOGIN → GET /companies → elegir empresa → GET /tax-transactions
 *       → GET /work-queue → abrir la entidad por su trazaRef
 * ```
 *
 * Antes de esta fase el segundo paso no existía: la consola llamaba a
 * `GET /organizations/:id/companies`, que devolvía 404, y el selector de empresa
 * quedaba vacío. El circuito productivo andaba —hay un E2E que lo demuestra— y
 * **nadie podía entrar a usarlo**.
 *
 * Este test recorre las cinco pantallas con dos usuarios y dos empresas del
 * mismo estudio, y en cada paso comprueba las dos mitades: que cada uno ve lo
 * suyo, y que no ve lo del otro. Un test que solo comprobara la primera mitad
 * pasaría igual con el aislamiento roto.
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

interface Persona {
  readonly userId: string;
  readonly token: string;
  readonly empresa: string;
}

suite('Navegación: de la sesión al trabajo pendiente', () => {
  let app: FastifyInstance;
  let db: Client;
  let stamp: string;
  let organizationId: string;
  let fundadorId: string;
  let tokenFundador: string;

  let ana: Persona;
  let beto: Persona;

  /** Pide con la sesión de una persona y la empresa que se le indique. */
  const pedir = (
    quien: Persona,
    method: 'GET' | 'POST',
    url: string,
    empresa?: string,
    payload?: unknown,
  ) =>
    app.inject({
      method,
      url,
      headers: {
        authorization: `Bearer ${quien.token}`,
        'x-company-id': empresa ?? quien.empresa,
      },
      ...(payload === undefined ? {} : { payload }),
    });

  /**
   * Alta completa de una persona con MFA satisfecho y rol en una empresa.
   *
   * El alta va por las rutas reales del estudio —`POST /organizations/:id/users`
   * y `POST /companies/:id/roles`— y no por SQL: si el camino de alta estuviera
   * roto, este test tiene que enterarse.
   */
  async function crearPersona(etiqueta: string, empresa: string): Promise<Persona> {
    const email = `${etiqueta}-${stamp}@estudio.test`;

    const alta = await app.inject({
      method: 'POST',
      url: `/organizations/${organizationId}/users`,
      headers: { authorization: `Bearer ${tokenFundador}` },
      payload: { email, fullName: etiqueta, password: PASSWORD, level: 'MEMBER' },
    });
    expect(alta.statusCode, alta.body).toBe(200);
    const userId = alta.json<{ id: string }>().id;

    const rol = await app.inject({
      method: 'POST',
      url: `/companies/${empresa}/roles`,
      headers: { authorization: `Bearer ${tokenFundador}` },
      payload: { userId, role: 'CONTADOR' },
    });
    expect(rol.statusCode, rol.body).toBe(200);

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
    const token = (
      await app.inject({ method: 'POST', url: '/auth/login', payload: { email, password: PASSWORD } })
    ).json<{ token: string }>().token;
    await app.inject({
      method: 'POST',
      url: '/auth/mfa/verify',
      payload: { code: totp(secret, Date.now()) },
      headers: { authorization: `Bearer ${token}` },
    });

    return { userId, token, empresa };
  }

  /** Sube un XML y registra su operación fiscal. Todo por HTTP, sin un INSERT. */
  async function cargarComprobante(
    quien: Persona,
    numero: number,
    fecha: string,
  ): Promise<{ documentId: string; taxTransactionId: string }> {
    const forma =
      `--X\r\nContent-Disposition: form-data; name="file"; filename="cbte-${stamp}-${numero}.xml"\r\n` +
      `Content-Type: application/xml\r\n\r\n<comprobante><n>${numero}</n></comprobante>\r\n--X--\r\n`;

    const subida = await app.inject({
      method: 'POST',
      url: '/documents',
      headers: {
        authorization: `Bearer ${quien.token}`,
        'x-company-id': quien.empresa,
        'content-type': 'multipart/form-data; boundary=X',
      },
      payload: forma,
    });
    expect(subida.statusCode, subida.body).toBe(201);
    const documentId = subida.json<{ id: string }>().id;

    const operacion = await pedir(quien, 'POST', `/documents/${documentId}/tax-transaction`, undefined, {
      direction: 'COMPRAS',
      cbteTipo: 1,
      puntoVenta: 1,
      numero,
      fecha,
      cuitContraparte: '30710000001',
      razonSocial: `Proveedor ${numero}`,
      condicionIva: 'RESPONSABLE_INSCRIPTO',
      neto: '1000.00',
      iva: '210.00',
      noGravado: '0',
      exento: '0',
      percepciones: '0',
      total: '1210.00',
    });
    expect(operacion.statusCode, operacion.body).toBe(201);
    return { documentId, taxTransactionId: operacion.json<{ taxTransactionId: string }>().taxTransactionId };
  }

  beforeAll(async () => {
    initPool(process.env.DATABASE_URL!);
    app = await buildServer();
    await app.ready();
    db = await connect();

    stamp = await sufijoUnico(db);

    // Un usuario fundador crea el estudio y las dos empresas. Ana y Beto reciben
    // rol en una cada uno: mismo estudio, carteras distintas, que es el caso real
    // que hay que aislar.
    const { hash: argonHash } = await import('@node-rs/argon2');
    fundadorId = (
      await db.query<{ id: string }>(
        'INSERT INTO users (email, full_name, password_hash) VALUES ($1,$2,$3) RETURNING id',
        [
          `fundador-${stamp}@estudio.test`,
          'Fundador',
          await argonHash(PASSWORD, { algorithm: 2, memoryCost: 19_456, timeCost: 2, parallelism: 1 }),
        ],
      )
    ).rows[0]!.id;

    organizationId = (
      await db.query<{ create_organization: string }>('SELECT create_organization($1,$2,$3)', [
        `Estudio nav ${stamp}`,
        withCheckDigit(`30${stamp}`),
        fundadorId,
      ])
    ).rows[0]!.create_organization;

    const crearEmpresa = async (nombre: string, prefijo: string): Promise<string> =>
      (
        await db.query<{ create_company: string }>('SELECT create_company($1,$2,$3,$4,$5,$6,$7,$8)', [
          fundadorId,
          organizationId,
          nombre,
          withCheckDigit(`${prefijo}${stamp}`),
          'SA',
          'AR-C',
          'IGJ',
          '12-31',
        ])
      ).rows[0]!.create_company;

    const empresaA = await crearEmpresa(`Empresa A nav ${stamp}`, '33');
    const empresaB = await crearEmpresa(`Empresa B nav ${stamp}`, '27');

    // El fundador no tiene MFA y tampoco rol en ninguna empresa: administra el
    // estudio y nada más. Sirve para dar de alta, no para operar.
    tokenFundador = (
      await app.inject({
        method: 'POST',
        url: '/auth/login',
        payload: { email: `fundador-${stamp}@estudio.test`, password: PASSWORD },
      })
    ).json<{ token: string }>().token;

    ana = await crearPersona('ana', empresaA);
    beto = await crearPersona('beto', empresaB);

    // Un ejercicio abierto en cada empresa: sin período no se puede registrar
    // una operación fiscal, y el candado es correcto.
    for (const quien of [ana, beto]) {
      const r = await pedir(quien, 'POST', '/fiscal-years', undefined, {
        code: `EJ2026-${stamp}`,
        startDate: '2026-01-01',
        endDate: '2026-12-31',
      });
      expect(r.statusCode, r.body).toBe(201);
    }
  });

  afterAll(async () => {
    await app?.close();
    await db?.end();
    await closePool();
  });

  // ─────────────────────────────────────────────────────────────────────
  // 1 · Elegir empresa
  // ─────────────────────────────────────────────────────────────────────

  it('1 · Ana ve su empresa y solo la suya', async () => {
    const r = await app.inject({
      method: 'GET',
      url: '/companies',
      headers: { authorization: `Bearer ${ana.token}` },
    });
    expect(r.statusCode, r.body).toBe(200);

    const empresas = r.json<{ companies: { id: string; roles: string[] }[] }>().companies;
    const mias = empresas.filter((c) => c.id === ana.empresa);
    expect(mias).toHaveLength(1);
    expect(mias[0]!.roles).toContain('CONTADOR');

    // La mitad que importa: la empresa de Beto no está.
    expect(empresas.map((c) => c.id)).not.toContain(beto.empresa);
  });

  it('1 · Beto ve la suya y no la de Ana', async () => {
    const r = await app.inject({
      method: 'GET',
      url: '/companies',
      headers: { authorization: `Bearer ${beto.token}` },
    });
    expect(r.statusCode).toBe(200);
    const ids = r.json<{ companies: { id: string }[] }>().companies.map((c) => c.id);
    expect(ids).toContain(beto.empresa);
    expect(ids).not.toContain(ana.empresa);
  });

  it('1 · un usuario sin pertenencia no ve ninguna empresa', async () => {
    const { hash: argonHash } = await import('@node-rs/argon2');
    const email = `huerfano-${stamp}@estudio.test`;
    await db.query('INSERT INTO users (email, full_name, password_hash) VALUES ($1,$2,$3)', [
      email,
      'Sin empresas',
      await argonHash(PASSWORD, { algorithm: 2, memoryCost: 19_456, timeCost: 2, parallelism: 1 }),
    ]);
    const token = (
      await app.inject({ method: 'POST', url: '/auth/login', payload: { email, password: PASSWORD } })
    ).json<{ token: string }>().token;

    const r = await app.inject({
      method: 'GET',
      url: '/companies',
      headers: { authorization: `Bearer ${token}` },
    });
    // Lista vacía y 200: no tener empresas todavía no es un error.
    expect(r.statusCode).toBe(200);
    expect(r.json<{ companies: unknown[] }>().companies).toEqual([]);
  });

  it('1 · sin sesión no se listan empresas', async () => {
    const r = await app.inject({ method: 'GET', url: '/companies' });
    expect(r.statusCode).toBe(401);
  });

  it('1 · elegir la empresa ajena no alcanza: la cabecera se valida contra el rol', async () => {
    const r = await pedir(ana, 'GET', '/companies/current', beto.empresa);
    expect(r.statusCode).toBe(403);
  });

  // ─────────────────────────────────────────────────────────────────────
  // 2 · Listar operaciones
  // ─────────────────────────────────────────────────────────────────────

  it('2 · las operaciones cargadas por Ana aparecen en su listado', async () => {
    await cargarComprobante(ana, 5001, '2026-03-10');
    await cargarComprobante(ana, 5002, '2026-03-11');

    const r = await pedir(ana, 'GET', '/tax-transactions');
    expect(r.statusCode, r.body).toBe(200);
    const cuerpo = r.json<{
      operaciones: { id: string; numero: string; constatacion: string; constatacionOrigen: string }[];
      cursor: string | null;
    }>();

    expect(cuerpo.operaciones.length).toBeGreaterThanOrEqual(2);
    expect(cuerpo.operaciones.map((o) => o.numero)).toEqual(
      expect.arrayContaining(['5002', '5001']),
    );

    // Los dos sellos, separados. Un OK declarado y un OK de ARCA no son lo mismo.
    for (const operacion of cuerpo.operaciones) {
      expect(operacion.constatacion).toBe('NO_CONSULTADO');
      expect(operacion.constatacionOrigen).toBe('NO_CONSULTADO');
    }
  });

  it('2 · Beto no ve ni una operación de Ana', async () => {
    const r = await pedir(beto, 'GET', '/tax-transactions');
    expect(r.statusCode).toBe(200);
    expect(r.json<{ operaciones: unknown[] }>().operaciones).toEqual([]);
  });

  it('2 · pedir el listado con la empresa de Beto, siendo Ana, se rechaza', async () => {
    const r = await pedir(ana, 'GET', '/tax-transactions', beto.empresa);
    expect(r.statusCode).toBe(403);
  });

  it('2 · los filtros filtran, y no de más', async () => {
    const compras = await pedir(ana, 'GET', '/tax-transactions?direccion=COMPRAS');
    expect(compras.json<{ operaciones: unknown[] }>().operaciones.length).toBeGreaterThanOrEqual(2);

    const ventas = await pedir(ana, 'GET', '/tax-transactions?direccion=VENTAS');
    expect(ventas.json<{ operaciones: unknown[] }>().operaciones).toEqual([]);

    const rango = await pedir(ana, 'GET', '/tax-transactions?desde=2026-03-11&hasta=2026-03-11');
    const numeros = rango.json<{ operaciones: { numero: string }[] }>().operaciones.map((o) => o.numero);
    expect(numeros).toEqual(['5002']);

    const sinAfectacion = await pedir(ana, 'GET', '/tax-transactions?conAfectacion=no');
    expect(sinAfectacion.json<{ operaciones: unknown[] }>().operaciones.length).toBeGreaterThanOrEqual(2);
  });

  // ─────────────────────────────────────────────────────────────────────
  // 3 · La bandeja
  // ─────────────────────────────────────────────────────────────────────

  it('3 · la bandeja de Ana tiene trabajo, y todo es de su empresa', async () => {
    const r = await pedir(ana, 'GET', '/work-queue');
    expect(r.statusCode, r.body).toBe(200);
    const cuerpo = r.json<{
      items: { itemId: string; entidad: string; entityId: string; categoria: string; trazaRef: string }[];
      resumen: Record<string, number>;
    }>();

    expect(cuerpo.items.length).toBeGreaterThan(0);

    // Cada ítem tiene que poder demostrar de qué empresa es. Se comprueba contra
    // la base, no contra la propia respuesta.
    for (const item of cuerpo.items) {
      const fila = await db.query<{ company_id: string }>(
        'SELECT company_id FROM work_queue WHERE item_id = $1 AND company_id = $2',
        [item.itemId, ana.empresa],
      );
      expect(fila.rowCount, `${item.entidad}/${item.categoria}`).toBe(1);
    }

    // Faltan afectación y decisión sobre las dos operaciones cargadas.
    expect(cuerpo.resumen['REQUIERE_DECLARACION']).toBeGreaterThanOrEqual(2);
    expect(cuerpo.resumen['REQUIERE_REVISION']).toBeGreaterThanOrEqual(2);
  });

  it('3 · dos pendientes distintos sobre la misma operación son dos ítems distintos', async () => {
    // Regresión. La primera versión derivaba `item_id` de
    // `(entidad, categoría, entity_id)` y las ramas OPERACION_SIN_CONSTATAR y
    // OPERACION_SIN_AFECTACION —las dos REQUIERE_DECLARACION sobre
    // `tax_transactions`— colapsaban en un solo ítem. Lo encontró este test, no
    // una revisión del SQL.
    const r = await pedir(ana, 'GET', '/work-queue?entidad=tax_transactions');
    const items = r.json<{ items: { itemId: string; rama: string; entityId: string }[] }>().items;

    const ramas = new Set(items.map((i) => i.rama));
    expect(ramas.has('OPERACION_SIN_CONSTATAR')).toBe(true);
    expect(ramas.has('OPERACION_SIN_AFECTACION')).toBe(true);

    // Ningún itemId repetido: el orden del cursor depende de que sean únicos.
    expect(new Set(items.map((i) => i.itemId)).size).toBe(items.length);
  });

  it('3 · la bandeja de Beto no tiene una sola fila de Ana', async () => {
    const r = await pedir(beto, 'GET', '/work-queue');
    expect(r.statusCode).toBe(200);
    const items = r.json<{ items: { itemId: string; entidad: string }[] }>().items;

    for (const item of items) {
      const fila = await db.query<{ n: string }>(
        'SELECT count(*)::text AS n FROM work_queue WHERE item_id = $1 AND company_id = $2',
        [item.itemId, beto.empresa],
      );
      expect(fila.rows[0]!.n, item.entidad).toBe('1');
    }
    // Beto no cargó comprobantes: no hay ni una fila del circuito fiscal.
    expect(items.some((i) => i.entidad === 'tax_transactions')).toBe(false);
  });

  it('3 · una bandeja vacía devuelve la forma completa, no un 404', async () => {
    const r = await pedir(beto, 'GET', '/work-queue?entidad=tax_transactions');
    expect(r.statusCode).toBe(200);
    const cuerpo = r.json<{ items: unknown[]; cursor: string | null; resumen: Record<string, number> }>();
    expect(cuerpo.items).toEqual([]);
    expect(cuerpo.cursor).toBeNull();
    expect(cuerpo.resumen).toEqual({});
  });

  it('3 · filtrar por categoría no trae otras categorías', async () => {
    const r = await pedir(ana, 'GET', '/work-queue?categoria=REQUIERE_DECLARACION');
    const items = r.json<{ items: { categoria: string }[] }>().items;
    expect(items.length).toBeGreaterThan(0);
    expect(items.every((i) => i.categoria === 'REQUIERE_DECLARACION')).toBe(true);
  });

  it('3 · una categoría inexistente es un pedido mal formado, no una bandeja vacía', async () => {
    const r = await pedir(ana, 'GET', '/work-queue?categoria=INFORMATIVO');
    expect(r.statusCode).toBe(400);
  });

  // ─────────────────────────────────────────────────────────────────────
  // 4 · Abrir la entidad
  // ─────────────────────────────────────────────────────────────────────

  it('3 · un documento que ya produjo su operación deja de pedirla', async () => {
    // Regresión de un defecto que esta fase encontró y no corrigió: **nadie
    // escribe nunca `documents.status = 'IMPUTADO'`**. Si la rama mirara el
    // estado, la bandeja diría «documento sin operación fiscal» sobre los dos
    // comprobantes que Ana acaba de cargar. Pregunta por el hecho, no por el
    // rótulo.
    const conOperacion = await db.query<{ id: string }>(
      `SELECT d.id FROM documents d
        WHERE d.company_id = $1
          AND EXISTS (SELECT 1 FROM tax_transactions t WHERE t.document_id = d.id)`,
      [ana.empresa],
    );
    expect(conOperacion.rowCount, 'el fixture tiene que tener documentos imputados').toBeGreaterThan(0);

    const r = await pedir(ana, 'GET', '/work-queue?entidad=documents');
    const ids = r.json<{ items: { entityId: string; rama: string }[] }>().items
      .filter((i) => i.rama === 'DOCUMENTO_SIN_OPERACION')
      .map((i) => i.entityId);

    for (const fila of conOperacion.rows) {
      expect(ids, 'un documento con operación no puede pedir una operación').not.toContain(fila.id);
    }

    // Y el estado sigue sin moverse: el defecto está, documentado y sin tapar.
    const estados = await db.query<{ status: string }>(
      'SELECT status FROM documents WHERE id = $1',
      [conOperacion.rows[0]!.id],
    );
    expect(estados.rows[0]!.status).not.toBe('IMPUTADO');
  });

  it('4 · el trazaRef de un ítem abre la entidad real', async () => {
    // Un documento suelto, sin operación: es el que la bandeja debe reclamar.
    const suelto = await app.inject({
      method: 'POST',
      url: '/documents',
      headers: {
        authorization: `Bearer ${ana.token}`,
        'x-company-id': ana.empresa,
        'content-type': 'multipart/form-data; boundary=X',
      },
      payload:
        `--X\r\nContent-Disposition: form-data; name="file"; filename="suelto-${stamp}.xml"\r\n` +
        `Content-Type: application/xml\r\n\r\n<c>suelto</c>\r\n--X--\r\n`,
    });
    expect(suelto.statusCode, suelto.body).toBe(201);
    const documentId = suelto.json<{ id: string }>().id;

    const bandeja = await pedir(ana, 'GET', '/work-queue?entidad=documents');
    const suyos = bandeja
      .json<{ items: { trazaRef: string; entityId: string; rama: string; itemId: string }[] }>()
      .items.filter((i) => i.entityId === documentId);

    // El mismo documento puede aparecer en más de una rama —falta la operación
    // *y* la lectura tiene hallazgos bloqueantes— y son dos ítems distintos.
    // Es justamente para esto que `rama` existe.
    const ramas = suyos.map((i) => i.rama);
    expect(ramas, 'el documento sin operación tiene que estar en la bandeja').toContain(
      'DOCUMENTO_SIN_OPERACION',
    );
    expect(new Set(suyos.map((i) => i.itemId ?? i.rama)).size).toBe(suyos.length);

    const item = suyos.find((i) => i.rama === 'DOCUMENTO_SIN_OPERACION');
    const abierto = await pedir(ana, 'GET', item!.trazaRef);
    expect(abierto.statusCode, abierto.body).toBe(200);
    expect(abierto.json<{ documento: { id: string } }>().documento.id).toBe(documentId);
  });

  it('4 · el mismo trazaRef, con la sesión de Beto, no abre nada', async () => {
    const bandeja = await pedir(ana, 'GET', '/work-queue?entidad=documents');
    const ref = bandeja.json<{ items: { trazaRef: string }[] }>().items[0]!.trazaRef;

    // Con su propia empresa: el documento no existe para él.
    const propio = await pedir(beto, 'GET', ref);
    expect(propio.statusCode).toBe(404);

    // Con la empresa de Ana: ni siquiera llega a mirar.
    const ajeno = await pedir(beto, 'GET', ref, ana.empresa);
    expect(ajeno.statusCode).toBe(403);
  });

  // ─────────────────────────────────────────────────────────────────────
  // 5 · Nada de esto activó una regla
  // ─────────────────────────────────────────────────────────────────────

  it('5 · la regla de IVA sigue en DRAFT y no hay ninguna ACTIVE', async () => {
    const r = await db.query<{ status: string }>(
      `SELECT status FROM accounting_rules WHERE rule_key = 'AR-IVA-CF-VINCULACION-001'`,
    );
    expect(r.rows[0]!.status).toBe('DRAFT');

    // «ACTIVE reales» — con clave del espacio normativo `AR-`. La base de tests
    // tiene además reglas de fixture con claves `R-xxxxxxxx` que sí llegan a
    // ACTIVE, porque para eso están: ejercitan el candado que exige norma, hash
    // y aprobador. Contarlas acá haría fallar el test por el motivo equivocado.
    const activas = await db.query<{ n: string }>(
      `SELECT count(*)::text AS n
         FROM accounting_rules
        WHERE status = 'ACTIVE' AND rule_key LIKE 'AR-%'`,
    );
    expect(activas.rows[0]!.n).toBe('0');
  });
});
