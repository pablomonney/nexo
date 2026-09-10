/**
 * S-35 — Una migración no es una puerta trasera.
 *
 * El motor de migración es, por definición, el módulo que **acepta datos de un
 * sistema desconocido y los escribe en la contabilidad de una empresa**. Es la
 * superficie más ancha del producto: un archivo arbitrario, nombres de columna
 * arbitrarios, y al final un INSERT. Los tres controles que siguen cubren las
 * tres formas en que eso se convierte en un agujero.
 *
 *   1. **Que escriba en la empresa equivocada.** Una migración de la empresa A
 *      jamás debe poder tocar ni ver a la B (§24), ni siquiera cuando quien pide
 *      dice explícitamente `x-company-id: B`.
 *   2. **Que la ejecute quien no debía.** Preparar una migración y ejecutarla
 *      son dos permisos, y la separación no sirve de nada si el endpoint que
 *      escribe acepta el permiso que solo prepara.
 *   3. **Que el archivo elija el SQL.** Los nombres de tabla y de columna que
 *      vienen del origen son datos, no identificadores. Ninguno puede terminar
 *      concatenado en una sentencia (§25).
 *
 * El tercero es estático a propósito: probar «esta inyección no funciona» sobre
 * las cargas que a uno se le ocurren deja pasar la que no se le ocurrió. Se
 * comprueba en cambio que no exista el mecanismo — que ninguna sentencia del
 * módulo interpole nada que no sea una constante del propio código.
 */

import { readFile, readdir } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { closePool, initPool } from '@aai/db';
import { buildServer } from '@aai/api/server';
import { totp, withCheckDigit } from '@aai/shared';
import type { FastifyInstance } from 'fastify';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { connect, hasDatabase, type Client } from '../integration/helpers/db.js';
import { sufijoUnico } from '../integration/helpers/identificadores.js';

const RAIZ = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const MODULO = join(RAIZ, 'apps', 'api', 'src', 'migracion');

const suite = hasDatabase ? describe : describe.skip;

const PASSWORD = 'una-contrasena-suficientemente-larga';

const CSV = ['Razón Social;CUIT', 'Ajena SA;30-71000001-4'].join('\n');

suite('S-35 — una migración no es una puerta trasera', () => {
  let app: FastifyInstance;
  let db: Client;

  let tokenA = '';
  let tokenAuditor = '';
  let empresaA = '';
  let empresaB = '';
  let migracionDeA = '';

  beforeAll(async () => {
    initPool(process.env.DATABASE_URL!);
    app = await buildServer();
    await app.ready();
    db = await connect();

    const stamp = await sufijoUnico(db);
    const dueño = await crearUsuario(`s35-admin-${stamp}@test.local`);
    const auditor = await crearUsuario(`s35-auditor-${stamp}@test.local`);

    // Por `create_organization` y no por un INSERT: la función deja al usuario
    // como administrador del estudio, que es la condición para crear empresas.
    const organizationId = (
      await db.query<{ create_organization: string }>('SELECT create_organization($1,$2,$3)', [
        `Estudio S35 ${stamp}`,
        withCheckDigit(`30${stamp}`),
        dueño,
      ])
    ).rows[0]!.create_organization;

    tokenA = await ingresar(`s35-admin-${stamp}@test.local`);
    tokenAuditor = await ingresar(`s35-auditor-${stamp}@test.local`);

    empresaA = await crearEmpresa(dueño, organizationId, `Empresa A ${stamp}`, `30${stamp}`);
    empresaB = await crearEmpresa(dueño, organizationId, `Empresa B ${stamp}`, `33${stamp}`);

    // El auditor solo tiene rol en A. En B no tiene ninguno, que es lo que hace
    // significativa la prueba de `x-company-id`.
    await db.query(
      'INSERT INTO organization_members (organization_id, user_id, level) VALUES ($1,$2,$3)',
      [organizationId, auditor, 'MEMBER'],
    );
    await db.query('SELECT grant_company_role($1,$2,$3,$4)', [
      dueño, // quien otorga
      empresaA,
      auditor, // a quién
      'AUDITOR',
    ]);

    // Una migración real de la empresa A, importada, para poder pedirla desde B.
    const creada = await pedir(tokenA, empresaA, 'POST', '/migraciones', {
      adaptador: 'ARCHIVO_GENERICO',
      titulo: 'Clientes del sistema anterior',
    });
    expect(creada.statusCode, creada.body).toBe(201);
    migracionDeA = creada.json<{ id: string }>().id;
    await subir(tokenA, empresaA, migracionDeA, CSV, 'clientes.csv');
  });

  afterAll(async () => {
    await app?.close();
    await db?.end();
    await closePool();
  });

  // ── 1. La empresa equivocada ──────────────────────────────────────────

  it('la migración de A no existe para B, ni pidiéndola por su id', async () => {
    const r = await pedir(tokenA, empresaB, 'GET', `/migraciones/${migracionDeA}`);
    // 404 y no 403: desde B esa migración no existe. Un 403 confirmaría que sí.
    expect(r.statusCode, r.body).toBe(404);
  });

  it('el listado de B no trae nada de A', async () => {
    const r = await pedir(tokenA, empresaB, 'GET', '/migraciones');
    expect(r.statusCode, r.body).toBe(200);
    const ids = r.json<{ migraciones: { id: string }[] }>().migraciones.map((m) => m.id);
    expect(ids).not.toContain(migracionDeA);
  });

  it('tampoco se puede importar la migración de A poniéndose en B', async () => {
    // El caso peligroso de verdad: no leer de más, sino **escribir** los
    // clientes de una empresa dentro de otra.
    const r = await pedir(tokenA, empresaB, 'POST', `/migraciones/${migracionDeA}/mapeo`, {
      tablas: [
        { id: migracionDeA, entidad: 'PARTY', mapeo: { CUIT: 'cuit' }, incluida: true },
      ],
    });
    expect(r.statusCode, r.body).toBe(404);

    const importada = await pedir(tokenA, empresaB, 'POST', `/migraciones/${migracionDeA}/importar`);
    expect(importada.statusCode, importada.body).toBe(404);

    // Y en B no quedó ningún tercero.
    const { rows } = await db.query<{ n: string }>(
      'SELECT count(*)::text n FROM parties WHERE company_id = $1',
      [empresaB],
    );
    expect(rows[0]!.n).toBe('0');
  });

  it('un usuario sin rol en la empresa no entra aunque la nombre', async () => {
    const r = await pedir(tokenAuditor, empresaB, 'GET', '/migraciones');
    expect(r.statusCode, r.body).toBe(403);
  });

  // ── 2. El permiso equivocado ──────────────────────────────────────────

  it('quien solo puede mirar no puede crear ni importar', async () => {
    expect((await pedir(tokenAuditor, empresaA, 'GET', '/migraciones')).statusCode).toBe(200);

    const creando = await pedir(tokenAuditor, empresaA, 'POST', '/migraciones', {
      adaptador: 'ARCHIVO_GENERICO',
      titulo: 'No debería poder',
    });
    expect(creando.statusCode, creando.body).toBe(403);

    const importando = await pedir(
      tokenAuditor,
      empresaA,
      'POST',
      `/migraciones/${migracionDeA}/importar`,
    );
    expect(importando.statusCode, importando.body).toBe(403);

    const revirtiendo = await pedir(
      tokenAuditor,
      empresaA,
      'POST',
      `/migraciones/${migracionDeA}/revertir`,
      { motivo: 'Un motivo suficientemente largo para pasar la validación' },
    );
    expect(revirtiendo.statusCode, revirtiendo.body).toBe(403);
  });

  it('preparar e importar son permisos distintos en el catálogo', async () => {
    // La separación tiene que existir en los datos, no solo en el código: si
    // los tres permisos cuelgan siempre de los mismos roles, separarlos en el
    // endpoint no le da a nadie la posibilidad de armar sin ejecutar.
    const { rows } = await db.query<{ code: string; roles: string[] }>(
      `SELECT p.code, array_agg(r.code ORDER BY r.code) roles
         FROM permissions p
         JOIN role_permissions rp ON rp.permission_id = p.id
         JOIN roles r ON r.id = rp.role_id
        WHERE p.code LIKE 'migration:%'
        GROUP BY p.code ORDER BY p.code`,
    );

    const porCodigo = new Map(rows.map((r) => [r.code, r.roles]));
    expect([...porCodigo.keys()]).toEqual([
      'migration:import',
      'migration:read',
      'migration:write',
    ]);
    // El que escribe alcanza a menos roles que el que mira. Si fueran iguales,
    // los tres permisos serían un solo permiso escrito tres veces.
    expect(porCodigo.get('migration:import')!.length).toBeLessThan(
      porCodigo.get('migration:read')!.length,
    );
    expect(porCodigo.get('migration:read')).toContain('AUDITOR');
    expect(porCodigo.get('migration:import')).not.toContain('AUDITOR');
  });

  // ── 3. El SQL equivocado ──────────────────────────────────────────────

  it('un nombre de columna con SQL adentro es un dato y nada más', async () => {
    // La carga no lleva ni comillas dobles ni punto y coma: en un CSV son el
    // delimitador de campo y el separador de columnas, y el archivo dejaría de
    // significar lo que quiero probar —el parser lo partiría en cuatro columnas
    // inocentes—. Queda la comilla simple, que es la que cierra un literal en
    // SQL, y un comentario que anularía el resto de la sentencia.
    const hostil = ["Razón Social;CUIT' OR 1=1 --", 'Hostil SA;30-71000001-4'].join('\n');

    const creada = await pedir(tokenA, empresaA, 'POST', '/migraciones', {
      adaptador: 'ARCHIVO_GENERICO',
      titulo: 'Encabezado hostil',
    });
    const id = creada.json<{ id: string }>().id;
    const carga = await subir(tokenA, empresaA, id, hostil, 'hostil.csv');
    expect(carga.statusCode, carga.body).toBe(200);

    // La columna se guardó **entera y literal**: ni se ejecutó ni se recortó.
    const { rows } = await db.query<{ columnas: string[] }>(
      'SELECT columnas FROM migration_tables WHERE migration_id = $1',
      [id],
    );
    expect(rows[0]!.columnas).toEqual(['Razón Social', "CUIT' OR 1=1 --"]);

    const sigue = await db.query('SELECT to_regclass($1) t', ['public.parties']);
    expect(sigue.rows[0]).not.toEqual({ t: null });
  });

  it('ninguna sentencia del módulo interpola algo que no sea una constante', async () => {
    // El control que no depende de que se me ocurra la carga correcta.
    //
    // Se leen todas las plantillas SQL del módulo y se exige que lo que se
    // interpole —`${...}`— sea un identificador simple que el propio archivo
    // declare como `const`. `$1` sigue siendo la única forma de meter un valor.
    const archivos = (await readdir(MODULO)).filter((f) => f.endsWith('.ts'));
    expect(archivos.length).toBeGreaterThan(0);

    const sospechosas: string[] = [];
    for (const archivo of archivos) {
      const fuente = await readFile(join(MODULO, archivo), 'utf8');

      // Las listas blancas del archivo: `const NOMBRE_EN_MAYUSCULAS = ...` en
      // el nivel superior. Son literales del código fuente, no datos.
      const listasBlancas = new Set(
        [...fuente.matchAll(/^const ([A-Z][A-Z0-9_]*)\s*[:=]/gm)].map((m) => m[1]!),
      );

      // Y las variables locales que salen de una de esas listas. Es el patrón
      // legítimo: `const tabla = TABLAS_REVERSIBLES.get(loQueSea)` devuelve una
      // cadena del código o `undefined`, nunca lo que traía el dato.
      const derivadas = new Map<string, string>();
      for (const asignacion of fuente.matchAll(
        /\bconst ([a-z][A-Za-z0-9_]*)\s*=\s*([A-Z][A-Z0-9_]*)\b/g,
      )) {
        derivadas.set(asignacion[1]!, asignacion[2]!);
      }

      for (const sentencia of fuente.matchAll(/`[^`]*\b(?:SELECT|INSERT|UPDATE|DELETE)\b[^`]*`/gis)) {
        for (const interpolado of sentencia[0].matchAll(/\$\{([^}]*)\}/g)) {
          const expresion = interpolado[1]!.trim();
          // Un `${marcas.join(', ')}` de una lista de `$n` no es un valor: es
          // la forma de armar un INSERT de varias filas. Se admite por nombre.
          if (expresion === "marcas.join(', ')") continue;

          const origen = derivadas.get(expresion);
          const seguro =
            listasBlancas.has(expresion) || (origen !== undefined && listasBlancas.has(origen));
          if (!seguro) sospechosas.push(`${archivo}: \${${expresion}}`);
        }
      }
    }

    expect(sospechosas).toEqual([]);
  });

  it('la tabla que toca una reversión sale de una lista blanca del código', async () => {
    // El complemento del control anterior: ahí se comprueba que lo interpolado
    // sea una constante; acá, que esa constante no se pueda elegir desde la
    // base. `migration_links.tabla_destino` es texto que alguien podría llegar
    // a escribir; solo entra al UPDATE si el mapa literal lo reconoce.
    const fuente = await readFile(join(MODULO, 'ciclo.ts'), 'utf8');
    const mapa = /const COMO_SE_DESHACE = new Map<string, FormaDeDeshacer>\(\[([\s\S]*?)\n\]\);/.exec(
      fuente,
    );
    expect(mapa, 'no se encontró la lista blanca de tablas reversibles').not.toBeNull();

    // Las claves del mapa son las únicas tablas que una reversión toca, y cada
    // una tiene su propia forma de deshacerse escrita al lado.
    const permitidas = [...mapa![1]!.matchAll(/^\s*\[?\s*'([a-z_]+)',/gm)].map((m) => m[1]!);
    expect([...new Set(permitidas)].sort()).toEqual([
      'accounts',
      'journal_entries',
      'parties',
      'payment_orders',
      'products',
      'stock_movements',
      'warehouses',
    ]);
    // La forma se elige por el nombre que trae la fila, y una que no esté en el
    // mapa no toca nada: se cuenta como no reversible.
    expect(fuente).toContain('COMO_SE_DESHACE.get(v.tabla_destino)');
    // Y ninguna sentencia arma su tabla con ese texto: las tres del archivador
    // están escritas literales, una por rama.
    expect(fuente).not.toMatch(/UPDATE \$\{|FROM \$\{|INTO \$\{/);
  });

  // ── El archivo ────────────────────────────────────────────────────────

  it('el nombre del archivo se guarda como texto y no se usa como ruta', async () => {
    // Hay dos defensas y conviene no confundirlas.
    //
    // La primera es de busboy, que descarta el directorio del `filename` que
    // venga en el multipart (`preservePath` en false). Medido: se sube
    // `../../../etc/passwd.csv` y llega `passwd.csv`.
    //
    // La segunda —la que de verdad importa— es que el módulo **no abre ningún
    // archivo**: lee los bytes del cuerpo en memoria y guarda filas. El nombre
    // es texto que se muestra, nunca una ruta. Si mañana alguien agregara un
    // `writeFile` para conservar el original, la primera defensa sola no
    // alcanzaría, y por eso el control mira las dos.
    const creada = await pedir(tokenA, empresaA, 'POST', '/migraciones', {
      adaptador: 'ARCHIVO_GENERICO',
      titulo: 'Nombre con travesía',
    });
    const id = creada.json<{ id: string }>().id;
    await subir(tokenA, empresaA, id, CSV, '../../../etc/passwd.csv');

    const { rows } = await db.query<{ archivo_nombre: string }>(
      'SELECT archivo_nombre FROM migrations WHERE id = $1',
      [id],
    );
    expect(rows[0]!.archivo_nombre).toBe('passwd.csv');
    expect(rows[0]!.archivo_nombre).not.toMatch(/[/\\]|\.\./);

    for (const archivo of (await readdir(MODULO)).filter((f) => f.endsWith('.ts'))) {
      const fuente = await readFile(join(MODULO, archivo), 'utf8');
      expect(fuente, `${archivo} escribe o lee del disco`).not.toMatch(
        /from 'node:fs|require\('fs'|writeFile|createWriteStream/,
      );
    }
  });

  it('un adaptador que no está implementado no acepta una migración', async () => {
    // Lo que impide que la consola ofrezca un origen que el código no tiene, y
    // que alguien cargue un archivo esperando que se conecte a su ERP.
    const r = await pedir(tokenA, empresaA, 'POST', '/migraciones', {
      adaptador: 'TANGO',
      titulo: 'Traer todo de Tango',
    });
    expect(r.statusCode, r.body).toBe(422);
    const cuerpo = r.json<{ error: string; message: string }>();
    expect(cuerpo.error).toBe('ADAPTADOR_NO_IMPLEMENTADO');
    // Y dice qué le falta, en vez de «todavía no».
    expect(cuerpo.message.length).toBeGreaterThan('El adaptador TANGO está en estado X'.length);
  });

  // ── §23 · La API con entradas que no debería aceptar ──────────────────

  it('un id que no es un uuid es un pedido mal armado, no un 500', async () => {
    for (const ruta of [
      '/migraciones/no-es-un-uuid',
      '/migraciones/no-es-un-uuid/reporte',
      '/migraciones/no-es-un-uuid/progreso',
    ]) {
      const r = await pedir(tokenA, empresaA, 'GET', ruta);
      expect(r.statusCode, `${ruta} contestó ${r.statusCode}`).toBe(400);
      expect(r.json<{ error: string }>().error).toBe('VALIDATION_ERROR');
    }
  });

  it('un uuid bien formado que no existe es 404 y no 500', async () => {
    const inexistente = '01900000-0000-7000-8000-000000000000';
    for (const ruta of [`/migraciones/${inexistente}`, `/migraciones/${inexistente}/reporte`]) {
      const r = await pedir(tokenA, empresaA, 'GET', ruta);
      expect(r.statusCode, `${ruta} contestó ${r.statusCode}`).toBe(404);
    }
  });

  it('revertir sin motivo, o con uno de dos letras, se rechaza', async () => {
    // El motivo lo exige la base para esa acción de bitácora. Que además lo
    // exija la ruta cambia el momento en que se entera quien lo escribió: con
    // un 400 y el campo señalado, en vez de un error de la base.
    for (const cuerpo of [{}, { motivo: 'no' }, { motivo: 'x'.repeat(600) }]) {
      const r = await pedir(tokenA, empresaA, 'POST', `/migraciones/${migracionDeA}/revertir`, cuerpo);
      expect(r.statusCode, JSON.stringify(cuerpo)).toBe(400);
    }
  });

  it('el tope de tandas no acepta cualquier número', async () => {
    for (const tope of [0, -1, 10_001, 'muchas']) {
      const r = await pedir(tokenA, empresaA, 'POST', `/migraciones/${migracionDeA}/importar`, {
        topeDeTandas: tope,
      });
      expect(r.statusCode, `topeDeTandas=${tope}`).toBe(400);
    }
  });

  it('el mapeo rechaza una entidad que no existe en el modelo canónico', async () => {
    const r = await pedir(tokenA, empresaA, 'POST', `/migraciones/${migracionDeA}/mapeo`, {
      tablas: [
        { id: migracionDeA, entidad: 'INVENTADA', mapeo: { A: 'b' }, incluida: true },
      ],
    });
    expect(r.statusCode).toBe(400);
  });

  it('crear una migración con un adaptador que no existe es 404, no 500', async () => {
    const r = await pedir(tokenA, empresaA, 'POST', '/migraciones', {
      adaptador: 'NO_EXISTE_ESTE_ADAPTADOR',
      titulo: 'Inventado',
    });
    expect(r.statusCode).toBe(404);
  });

  // ── La bitácora ───────────────────────────────────────────────────────

  it('cada paso que escribe queda en la bitácora con su vocabulario', async () => {
    const { rows } = await db.query<{ action: string }>(
      `SELECT DISTINCT action FROM audit_logs
        WHERE company_id = $1 AND object_type = 'migration' ORDER BY action`,
      [empresaA],
    );
    const acciones = rows.map((r) => r.action);
    expect(acciones).toContain('CREAR_MIGRACION');
    expect(acciones).toContain('CARGAR_ORIGEN');

    // Y las ocho acciones del módulo están declaradas, no inventadas al vuelo:
    // `recordAudit` tiene una clave foránea contra este catálogo, así que una
    // acción sin declarar no se anota mal — aborta la operación entera.
    const catalogo = await db.query<{ id: string; requiere_motivo: boolean }>(
      `SELECT id, requiere_motivo FROM audit_actions WHERE dominio = 'migracion' ORDER BY id`,
    );
    expect(catalogo.rows.map((a) => a.id)).toEqual([
      'CANCELAR_MIGRACION',
      'CARGAR_ORIGEN',
      'CREAR_MIGRACION',
      'IMPORTAR_MIGRACION',
      'MAPEAR_MIGRACION',
      'REANUDAR_MIGRACION',
      'REVERTIR_MIGRACION',
      'VALIDAR_MIGRACION',
    ]);
    // Las dos que dejan la empresa distinta de como habría quedado sola exigen
    // motivo: sin él no se sabe si fue un error de datos o una decisión.
    expect(catalogo.rows.filter((a) => a.requiere_motivo).map((a) => a.id)).toEqual([
      'CANCELAR_MIGRACION',
      'REVERTIR_MIGRACION',
    ]);
  });

  // ── Auxiliares ────────────────────────────────────────────────────────

  function pedir(
    token: string,
    empresa: string,
    method: 'GET' | 'POST',
    url: string,
    payload?: unknown,
  ) {
    return app.inject({
      method,
      url,
      headers: { authorization: `Bearer ${token}`, 'x-company-id': empresa },
      ...(payload === undefined ? {} : { payload }),
    });
  }

  function subir(token: string, empresa: string, id: string, contenido: string, nombre: string) {
    return app.inject({
      method: 'POST',
      url: `/migraciones/${id}/origen`,
      headers: {
        authorization: `Bearer ${token}`,
        'x-company-id': empresa,
        'content-type': 'multipart/form-data; boundary=X',
      },
      payload:
        `--X\r\nContent-Disposition: form-data; name="file"; filename="${nombre}"\r\n` +
        `Content-Type: text/csv\r\n\r\n${contenido}\r\n--X--\r\n`,
    });
  }

  async function crearUsuario(email: string): Promise<string> {
    const { hash: argonHash } = await import('@node-rs/argon2');
    const hash = await argonHash(PASSWORD, {
      algorithm: 2,
      memoryCost: 19_456,
      timeCost: 2,
      parallelism: 1,
    });
    const r = await db.query<{ id: string }>(
      'INSERT INTO users (email, full_name, password_hash) VALUES ($1,$2,$3) RETURNING id',
      [email, 'Persona', hash],
    );
    return r.rows[0]!.id;
  }

  /** Login + MFA, el mismo camino que hace una persona. */
  async function ingresar(email: string): Promise<string> {
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
    return token;
  }

  async function crearEmpresa(
    userId: string,
    organizationId: string,
    nombre: string,
    prefijoCuit: string,
  ): Promise<string> {
    const c = await db.query<{ create_company: string }>(
      'SELECT create_company($1,$2,$3,$4,$5,$6,$7,$8)',
      [userId, organizationId, nombre, withCheckDigit(prefijoCuit), 'SA', 'AR-C', 'IGJ', '12-31'],
    );
    const companyId = c.rows[0]!.create_company;
    await db.query('SELECT grant_company_role($1,$2,$3,$4)', [
      userId,
      companyId,
      userId,
      'ADMINISTRADOR',
    ]);
    return companyId;
  }
});
