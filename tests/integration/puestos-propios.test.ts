/**
 * Puestos propios y ajustes por persona — sólo el dueño del estudio (migración 0145).
 *
 * Lo que se afirma, contra la API real y la base:
 *
 *   1. **Sólo el dueño.** Quien administra la empresa pero no es dueño del estudio recibe 403 al crear un puesto, darlo o ajustar a alguien:
 *      lo decide la base (`exigir_dueno_del_estudio`), no la pantalla.
 *   2. **Lo que nunca se da.** Una función reservada (aprobar la contabilidad, administrar el sistema…) no entra en un puesto propio ni en un
 *      ajuste, y un puesto no junta armar con aprobar. Son 400 con el motivo.
 *   3. **Funciona.** Quien sólo tiene un puesto propio (sin ningún rol) entra a la empresa y puede lo que el puesto dice, y nada más.
 *   4. **Ajustes.** Agregar una función le da acceso a esa función; quitarla se la saca; el resultado se ve en `/personas/:id/permisos`.
 *   5. **Archivar** un puesto corta el acceso que daba.
 *   6. **El segundo factor no se esquiva:** un puesto propio con una función que mueve plata exige segundo factor; uno inofensivo no.
 *   7. **Constancia:** cada acto queda en la bitácora con su motivo.
 *   8. **Aislamiento:** los puestos de una empresa no se ven desde otra.
 */

import { totp } from '@aai/shared';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { hasDatabase } from './helpers/db.js';
import { crearEntorno, type EntornoApi } from './helpers/entorno-api.js';
import { sufijoUnico } from './helpers/identificadores.js';

const suite = hasDatabase ? describe : describe.skip;
const PASSWORD = 'una-contrasena-suficientemente-larga';
const MOTIVO = 'Reorganización del área de caja, decidida por el estudio';

suite('puestos propios y ajustes por persona', () => {
  let env: EntornoApi;
  let otro: EntornoApi;
  let hash = '';
  let tokenDueno = '';
  let encargado: { id: string; email: string; token: string };

  const entrar = async (email: string): Promise<string> =>
    (await env.app.inject({ method: 'POST', url: '/auth/login', payload: { email, password: PASSWORD } })).json<{ token: string }>().token;

  const conSegundoFactor = async (email: string): Promise<string> => {
    const t = await entrar(email);
    const secret = (await env.app.inject({ method: 'POST', url: '/auth/mfa/setup', headers: { authorization: `Bearer ${t}` } })).json<{ secret: string }>().secret;
    await env.app.inject({ method: 'POST', url: '/auth/mfa/confirm', payload: { code: totp(secret, Date.now()) }, headers: { authorization: `Bearer ${t}` } });
    const nuevo = await entrar(email);
    await env.app.inject({ method: 'POST', url: '/auth/mfa/verify', payload: { code: totp(secret, Date.now()) }, headers: { authorization: `Bearer ${nuevo}` } });
    return nuevo;
  };

  /** Una persona del estudio SIN ningún rol en la empresa. */
  const personaSinRol = async (nombre: string): Promise<{ id: string; email: string }> => {
    const stamp = await sufijoUnico(env.db);
    const email = `${nombre}-${stamp}@estudio.test`;
    const id = (await env.db.query<{ id: string }>('INSERT INTO users (email, full_name, password_hash) VALUES ($1,$2,$3) RETURNING id', [email, nombre, hash])).rows[0]!.id;
    await env.db.query(`INSERT INTO organization_members (organization_id, user_id, level) VALUES ($1, $2, 'MEMBER')`, [env.organizationId, id]);
    return { id, email };
  };

  const como = (token: string, method: 'GET' | 'POST' | 'PUT', url: string, payload?: unknown, empresa = env.empresa) =>
    env.app.inject({
      method,
      url,
      headers: { authorization: `Bearer ${token}`, 'x-company-id': empresa },
      ...(payload === undefined ? {} : { payload: payload as object }),
    });

  const crearPuesto = (token: string, nombre: string, permisos: string[]) =>
    como(token, 'POST', '/puestos-propios', { nombre, descripcion: 'Puesto de prueba para el área de caja de la empresa', permisos });

  beforeAll(async () => {
    env = await crearEntorno('puestos-propios');
    otro = await crearEntorno('puestos-propios-b');
    const { hash: argon } = await import('@node-rs/argon2');
    hash = await argon(PASSWORD, { algorithm: 2, memoryCost: 19_456, timeCost: 2, parallelism: 1 });

    // El dueño del estudio es el fundador (OWNER). Para entrar a la empresa necesita un rol: administra, y tiene segundo factor.
    const fundador = `fundador-puestos-propios-${env.stamp}@estudio.test`;
    const fundadorId = (await env.db.query<{ id: string }>('SELECT id FROM users WHERE email = $1', [fundador])).rows[0]!.id;
    const dado = await env.pedir('POST', `/companies/${env.empresa}/roles`, { userId: fundadorId, role: 'ADMINISTRADOR' });
    expect(dado.statusCode, dado.body).toBe(200);
    tokenDueno = await conSegundoFactor(fundador);

    const p = await personaSinRol('encargado');
    encargado = { ...p, token: await entrar(p.email) };
  });

  afterAll(async () => {
    await env.cerrar();
    await otro.cerrar();
  });

  it('el catálogo de funciones viene por módulo y marca las reservadas', async () => {
    const r = await como(tokenDueno, 'GET', '/permisos');
    expect(r.statusCode, r.body).toBe(200);
    const { modulos } = r.json<{ modulos: Array<{ modulo: string; permisos: Array<{ codigo: string; funcion: string; reservado: string | null }> }> }>();
    const caja = modulos.find((m) => m.modulo === 'Caja')!;
    expect(caja.permisos.map((x) => x.codigo)).toContain('cash:write');
    const todas = modulos.flatMap((m) => m.permisos);
    expect(todas.find((x) => x.codigo === 'journal_entry:approve')?.reservado).toMatch(/Contador/u);
    expect(todas.find((x) => x.codigo === 'cash:read')?.reservado).toBeNull();
  });

  describe('sólo el dueño del estudio', () => {
    it('quien administra la empresa pero no es dueño recibe 403 al crear un puesto', async () => {
      // El operador del entorno es CONTADOR + ADMINISTRADOR (con segundo factor) y MIEMBRO del estudio, no dueño.
      const r = await crearPuesto(env.token, 'Encargado de caja', ['cash:read', 'cash:write']);
      expect(r.statusCode, r.body).toBe(403);
      expect(r.body).toMatch(/dueño del estudio/u);
    });

    it('ni darlo ni ajustar a alguien: 403', async () => {
      const creado = await crearPuesto(tokenDueno, 'Puesto del dueño', ['cash:read']);
      expect(creado.statusCode, creado.body).toBe(201);
      const id = creado.json<{ id: string }>().id;

      const dar = await como(env.token, 'POST', `/puestos-propios/${id}/personas`, { userId: encargado.id, motivo: MOTIVO });
      expect(dar.statusCode, dar.body).toBe(403);
      const ajustar = await como(env.token, 'POST', `/personas/${encargado.id}/ajustes`, { agrega: ['document:read'], quita: [], motivo: MOTIVO });
      expect(ajustar.statusCode, ajustar.body).toBe(403);
    });

    it('una persona sin permiso de administrar ni lo intenta: 403 antes de llegar a la base', async () => {
      const r = await crearPuesto(encargado.token, 'Intruso', ['cash:read']);
      expect(r.statusCode, r.body).toBe(403);
    });
  });

  describe('lo que nunca se da', () => {
    it('una función reservada no entra en un puesto propio', async () => {
      const r = await crearPuesto(tokenDueno, 'Con firma', ['cash:read', 'journal_entry:approve']);
      expect(r.statusCode, r.body).toBe(400);
      expect(r.body).toMatch(/Contador y Administrador/u);
    });

    it('un puesto no junta armar con aprobar', async () => {
      const r = await crearPuesto(tokenDueno, 'Todo en uno', ['purchase_request:read', 'decision:write', 'decision:approve']);
      expect(r.statusCode, r.body).toBe(400);
    });

    it('una función que no existe es un 400', async () => {
      const r = await crearPuesto(tokenDueno, 'Fantasma', ['cash:read', 'cosa:inexistente']);
      expect(r.statusCode, r.body).toBe(400);
    });

    it('el nombre no se repite entre puestos vivos de la empresa', async () => {
      const uno = await crearPuesto(tokenDueno, 'Nombre único', ['cash:read']);
      expect(uno.statusCode, uno.body).toBe(201);
      const dos = await crearPuesto(tokenDueno, 'nombre único', ['cash:read']);
      expect(dos.statusCode, dos.body).toBe(409);
    });
  });

  describe('un puesto propio funciona', () => {
    let puesto = '';

    it('quien sólo tiene un puesto propio, sin ningún rol, entra y puede lo que el puesto dice y nada más', async () => {
      const antes = await como(encargado.token, 'GET', '/cash-boxes');
      expect(antes.statusCode, 'sin rol ni puesto no entra').toBe(403);

      const creado = await crearPuesto(tokenDueno, 'Encargado de caja', ['cash:read', 'cash:write']);
      expect(creado.statusCode, creado.body).toBe(201);
      puesto = creado.json<{ id: string }>().id;
      const dado = await como(tokenDueno, 'POST', `/puestos-propios/${puesto}/personas`, { userId: encargado.id, motivo: MOTIVO });
      expect(dado.statusCode, dado.body).toBe(200);

      expect((await como(encargado.token, 'GET', '/cash-boxes')).statusCode).toBe(200);
      expect((await como(encargado.token, 'GET', '/companies/current')).statusCode, 'el puesto siempre trae ver la empresa').toBe(200);
      expect((await como(encargado.token, 'GET', '/documents')).statusCode, 'lo que el puesto no dice, no lo puede').toBe(403);
    });

    it('la lista de puestos propios trae sus funciones y sus personas', async () => {
      const r = await como(tokenDueno, 'GET', '/puestos-propios');
      const { puestos } = r.json<{ puestos: Array<{ id: string; permisos: string[]; personas: Array<{ userId: string }> }> }>();
      const p = puestos.find((x) => x.id === puesto)!;
      expect(p.permisos).toEqual(['cash:read', 'cash:write', 'company:read']);
      expect(p.personas.map((x) => x.userId)).toEqual([encargado.id]);
    });

    it('a la persona le aparece en la lista de usuarios de la empresa y el dueño se reconoce como tal', async () => {
      const r = await como(tokenDueno, 'GET', '/companies/current/users');
      const d = r.json<{ esDuenoDelEstudio: boolean; users: Array<{ id: string; puestosPropios: string[] }> }>();
      expect(d.esDuenoDelEstudio).toBe(true);
      expect(d.users.find((u) => u.id === encargado.id)?.puestosPropios).toEqual(['Encargado de caja']);
      const comoOperador = (await como(env.token, 'GET', '/companies/current/users')).json<{ esDuenoDelEstudio: boolean }>();
      expect(comoOperador.esDuenoDelEstudio, 'quien administra pero no es dueño no lo ve').toBe(false);
    });

    it('ajustes: agregar una función da acceso a esa función; quitar una se la saca', async () => {
      const agrega = await como(tokenDueno, 'POST', `/personas/${encargado.id}/ajustes`, { agrega: ['document:read'], quita: ['cash:write'], motivo: MOTIVO });
      expect(agrega.statusCode, agrega.body).toBe(200);

      expect((await como(encargado.token, 'GET', '/documents')).statusCode).toBe(200);
      expect((await como(encargado.token, 'GET', '/cash-boxes')).statusCode, 'sigue viendo caja').toBe(200);

      const ver = await como(tokenDueno, 'GET', `/personas/${encargado.id}/permisos`);
      const d = ver.json<{ base: string[]; agrega: Array<{ code: string }>; quita: Array<{ code: string }>; efectivos: string[]; puestosPropios: Array<{ nombre: string }> }>();
      expect(d.base).toContain('cash:write');
      expect(d.agrega.map((x) => x.code)).toEqual(['document:read']);
      expect(d.quita.map((x) => x.code)).toEqual(['cash:write']);
      expect(d.efectivos).toContain('document:read');
      expect(d.efectivos).not.toContain('cash:write');
      expect(d.puestosPropios.map((x) => x.nombre)).toEqual(['Encargado de caja']);
    });

    it('un ajuste no puede agregar una función reservada ni dejar a la persona armando y aprobando', async () => {
      const reservada = await como(tokenDueno, 'POST', `/personas/${encargado.id}/ajustes`, { agrega: ['period:close'], quita: [], motivo: MOTIVO });
      expect(reservada.statusCode, reservada.body).toBe(400);
      const sinMotivo = await como(tokenDueno, 'POST', `/personas/${encargado.id}/ajustes`, { agrega: ['document:read'], quita: [], motivo: 'corto' });
      expect(sinMotivo.statusCode, sinMotivo.body).toBe(400);
      const mismaFuncion = await como(tokenDueno, 'POST', `/personas/${encargado.id}/ajustes`, { agrega: ['cash:read'], quita: ['cash:read'], motivo: MOTIVO });
      expect(mismaFuncion.statusCode, mismaFuncion.body).toBe(400);
    });

    it('archivar el puesto corta el acceso que daba', async () => {
      const r = await como(tokenDueno, 'POST', `/puestos-propios/${puesto}/archivar`, { motivo: MOTIVO });
      expect(r.statusCode, r.body).toBe(200);
      const despues = await como(encargado.token, 'GET', '/cash-boxes');
      expect(despues.statusCode, 'sin puesto ni rol no entra').toBe(403);
    });
  });

  describe('cambiar un puesto y sacárselo a alguien', () => {
    it('modificar el puesto cambia lo que pueden las personas que lo tienen; quitárselo les corta el acceso', async () => {
      const creado = await crearPuesto(tokenDueno, 'Caja y bancos', ['cash:read']);
      const id = creado.json<{ id: string }>().id;
      const p = await personaSinRol('cambiante');
      const token = await entrar(p.email);
      await como(tokenDueno, 'POST', `/puestos-propios/${id}/personas`, { userId: p.id, motivo: MOTIVO });
      expect((await como(token, 'GET', '/cash-boxes')).statusCode).toBe(200);
      expect((await como(token, 'GET', '/banks/accounts')).statusCode, 'todavía no tiene bancos').toBe(403);

      const sinMotivo = await como(tokenDueno, 'PUT', `/puestos-propios/${id}`, { nombre: 'Caja y bancos', descripcion: 'Caja diaria y conciliación bancaria', permisos: ['cash:read', 'bank:read'], motivo: 'corto' });
      expect(sinMotivo.statusCode, sinMotivo.body).toBe(400);
      const ok = await como(tokenDueno, 'PUT', `/puestos-propios/${id}`, { nombre: 'Caja y bancos', descripcion: 'Caja diaria y conciliación bancaria', permisos: ['cash:read', 'bank:read'], motivo: MOTIVO });
      expect(ok.statusCode, ok.body).toBe(200);
      expect((await como(token, 'GET', '/banks/accounts')).statusCode, 'el cambio rige en el acto').toBe(200);

      const quitado = await como(tokenDueno, 'POST', `/puestos-propios/${id}/personas/quitar`, { userId: p.id, motivo: MOTIVO });
      expect(quitado.statusCode, quitado.body).toBe(200);
      expect((await como(token, 'GET', '/cash-boxes')).statusCode, 'sin el puesto no entra').toBe(403);

      const acciones = (await env.db.query<{ action: string }>(`SELECT DISTINCT action FROM audit_logs WHERE company_id = $1 AND action IN ('MODIFICAR_PUESTO_PROPIO','QUITAR_PUESTO_PROPIO')`, [env.empresa])).rows.map((f) => f.action).sort();
      expect(acciones).toEqual(['MODIFICAR_PUESTO_PROPIO', 'QUITAR_PUESTO_PROPIO']);
    });
  });

  describe('el segundo factor no se esquiva con un puesto a medida', () => {
    it('un puesto con una función que mueve el inventario exige segundo factor; uno inofensivo no', async () => {
      const sensible = await crearPuesto(tokenDueno, 'Ajustador de stock', ['stock:read', 'stock:adjust']);
      expect(sensible.statusCode, sensible.body).toBe(201);
      const inocuo = await crearPuesto(tokenDueno, 'Mirón de stock', ['stock:read']);
      expect(inocuo.statusCode, inocuo.body).toBe(201);

      const a = await personaSinRol('ajustador');
      const b = await personaSinRol('miron');
      await como(tokenDueno, 'POST', `/puestos-propios/${sensible.json<{ id: string }>().id}/personas`, { userId: a.id, motivo: MOTIVO });
      await como(tokenDueno, 'POST', `/puestos-propios/${inocuo.json<{ id: string }>().id}/personas`, { userId: b.id, motivo: MOTIVO });

      const sin2fa = await como(await entrar(a.email), 'GET', '/companies/current');
      expect(sin2fa.statusCode, sin2fa.body).toBe(403);
      expect(sin2fa.body).toMatch(/MFA_SETUP_REQUIRED/u);
      expect((await como(await entrar(b.email), 'GET', '/companies/current')).statusCode).toBe(200);
    });
  });

  it('cada acto deja constancia en la bitácora, con su motivo', async () => {
    const r = await env.db.query<{ action: string; motivo: string | null }>(
      `SELECT action, motivo FROM audit_logs WHERE company_id = $1 AND action IN ('CREAR_PUESTO_PROPIO','ASIGNAR_PUESTO_PROPIO','AJUSTAR_PERMISOS_DE_PERSONA','ARCHIVAR_PUESTO_PROPIO')`,
      [env.empresa],
    );
    const acciones = new Set(r.rows.map((f) => f.action));
    for (const a of ['CREAR_PUESTO_PROPIO', 'ASIGNAR_PUESTO_PROPIO', 'AJUSTAR_PERMISOS_DE_PERSONA', 'ARCHIVAR_PUESTO_PROPIO']) expect(acciones.has(a), a).toBe(true);
    expect(r.rows.every((f) => (f.motivo ?? '').length >= 10)).toBe(true);
  });

  it('los puestos de una empresa no se ven desde otra', async () => {
    const r = await otro.pedir('GET', '/puestos-propios');
    expect(r.statusCode, r.body).toBe(200);
    expect(r.json<{ puestos: unknown[] }>().puestos).toEqual([]);
    // Y quien es dueño en una no puede crear en la otra.
    const cruzado = await como(tokenDueno, 'POST', '/puestos-propios', { nombre: 'Cruzado', descripcion: 'Intento desde otra empresa del sistema', permisos: ['cash:read'] }, otro.empresa);
    expect(cruzado.statusCode, cruzado.body).toBe(403);
  });
});
