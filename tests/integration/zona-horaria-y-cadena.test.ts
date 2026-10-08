/**
 * La zona horaria de negocio y la cadena de auditoría — contra PostgreSQL real.
 *
 * ## Qué protege
 *
 * La aplicación abre sus conexiones en `America/Argentina/Buenos_Aires` para que
 * `CURRENT_DATE` sea el día del negocio. La base de producción está en UTC y se
 * queda así: el hash de la cadena de auditoría incluye `occurred_at::text`, y un
 * `timestamptz` en texto se escribe según la zona de la sesión. Si las funciones
 * que lo calculan dependieran de esa zona, todo el historial —hasheado en UTC—
 * se vería roto desde una sesión argentina.
 *
 * La migración 0131 fija `timezone = 'UTC'` dentro de las tres funciones. Este
 * archivo prueba que eso alcanza, y que la prueba tiene poder para detectarlo:
 * contra el estado anterior a la 0131 el mismo control **falla**.
 *
 * ## Por qué no depende de la hora a la que corre
 *
 * Todo sale de comparar dos zonas sobre el mismo dato, no de cuál es «hoy».
 * Comprobar que `CURRENT_DATE` es el de Argentina solo falla de verdad entre las
 * 21:00 y las 24:00 ART con la base en UTC, y una prueba que falla tres horas por
 * día es la que no estaba (S-37). Lo que se afirma acá es la zona de la sesión.
 *
 * Plan completo y criterios: `docs/PLAN_ZONA_HORARIA.md` (P4–P7).
 */

import { readFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { closePool, initPool, withCompany, withoutCompany } from '@aai/db';
import { ZONA_DE_NEGOCIO } from '@aai/shared';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { connect, hasDatabase, seed, type Client, type Fixture } from './helpers/db.js';

const suite = hasDatabase ? describe : describe.skip;

const UTC = 'UTC';
const CONSTANCIA = 'Revisado contra el articulo citado y su documento archivado con hash.';

const RAIZ = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const MIGRACIONES = [
  join(RAIZ, 'infrastructure', 'db', 'migrations', '0131_funciones_de_hash_en_utc.sql'),
  join(RAIZ, 'infrastructure', 'db', 'migrations', '0132_funciones_de_hash_en_formato_iso.sql'),
];

/** Zonas con medias horas, +14:00, −12:00 y horario de verano: ninguna puede cambiar un hash. */
const ZONAS_EXOTICAS = [
  UTC,
  ZONA_DE_NEGOCIO,
  'Asia/Kolkata',
  'America/St_Johns',
  'Pacific/Chatham',
  'Pacific/Kiritimati',
  'America/New_York',
  'Europe/Madrid',
  'Asia/Tokyo',
  'Etc/GMT+12',
];
/** Los seis estilos de fecha (los cinco de la auditoría más ISO, DMY): solo ISO produce el texto con el que se escribió el historial. */
const ESTILOS = ['ISO, MDY', 'ISO, DMY', 'SQL, MDY', 'SQL, DMY', 'Postgres, MDY', 'German, DMY'];

const FUNCIONES = [
  'audit_chain_link',
  'normative_audit_chain_link',
  'verify_audit_chain',
] as const;

/**
 * Recalcula el hash de la cadena por empresa **en SQL y con la misma fórmula del
 * trigger** (0025). Es una copia deliberada: si la fórmula cambia, esto tiene
 * que cambiar con ella, y que esté escrita acá es lo que permite comprobar que
 * el valor guardado no depende de la zona en que se escribió.
 */
const RECALCULO_EMPRESA = `
  SELECT id::text AS id,
         encode(digest(concat_ws('|',
           prev_hash, seq::text, company_id::text, actor_type, actor_id, action,
           object_type, object_id,
           COALESCE(old_value::text, ''), COALESCE(new_value::text, ''),
           COALESCE(motivo, ''), occurred_at::text), 'sha256'), 'hex') = hash AS coincide
    FROM audit_logs WHERE company_id = $1 ORDER BY seq`;

/** Lo mismo para la cadena normativa (0041), que no tiene `company_id` ni verificador. */
const RECALCULO_NORMATIVO = `
  SELECT id::text AS id,
         encode(digest(concat_ws('|',
           prev_hash, seq::text, actor_type, actor_id, action, object_type, object_id,
           COALESCE(old_value::text, ''), COALESCE(new_value::text, ''),
           motivo, occurred_at::text), 'sha256'), 'hex') = hash AS coincide
    FROM normative_audit_logs WHERE object_id LIKE $1 ORDER BY seq`;

async function fijarZona(client: Client, zona: string): Promise<void> {
  // `SET` no admite parámetros; la zona sale de una constante de este archivo.
  await client.query(`SET timezone = '${zona}'`);
}

async function roturas(client: Client, empresa: string): Promise<number> {
  const r = await client.query('SELECT * FROM verify_audit_chain($1)', [empresa]);
  return r.rows.length;
}

async function escribirAuditoria(client: Client, empresa: string, etiqueta: string, n: number) {
  for (let i = 0; i < n; i += 1) {
    await client.query(
      `INSERT INTO audit_logs (company_id, actor_type, actor_id, action, object_type, object_id)
       VALUES ($1, 'USER', 'contador', 'APROBAR_ASIENTO', 'journal_entry', $2)`,
      [empresa, `${etiqueta}-${i}`],
    );
  }
}

suite('Zona horaria — las funciones de hash no dependen de la sesión (0131)', () => {
  let client: Client;
  let fx: Fixture;

  beforeAll(async () => {
    client = await connect();
    fx = await seed(client, 'zona');
  });

  afterAll(async () => {
    await client?.end();
  });

  it('P6 · las tres funciones tienen fijadas la zona (UTC) y el formato de fecha (ISO)', async () => {
    const r = await client.query<{ proname: string; config: string }>(
      `SELECT proname, coalesce(array_to_string(proconfig, ','), '') AS config
         FROM pg_proc WHERE proname = ANY($1::text[])`,
      [FUNCIONES],
    );
    for (const nombre of FUNCIONES) {
      const fila = r.rows.find((x) => x.proname === nombre);
      expect(fila, `no existe la función ${nombre}`).toBeDefined();
      expect(fila!.config, `${nombre} no fija la zona`).toMatch(/(^|,)timezone=UTC(,|$)/i);
      expect(fila!.config, `${nombre} no fija el formato de fecha`).toMatch(/(^|,)datestyle=ISO(,|$)/i);
    }
  });

  it('P4 · el hash de una fila es el mismo se escriba en la zona que se escriba', async () => {
    const zonas = [UTC, ZONA_DE_NEGOCIO];
    for (const zona of zonas) {
      await fijarZona(client, zona);
      await escribirAuditoria(client, fx.companyA, `p4-${zona}`, 3);
    }

    // Recalculado desde una sesión UTC —la zona con que se escribió todo el
    // historial—: tienen que coincidir las seis filas, las de las dos zonas.
    await fijarZona(client, UTC);
    const filas = await client.query<{ coincide: boolean }>(RECALCULO_EMPRESA, [fx.companyA]);
    const mios = filas.rows.length;
    expect(mios).toBeGreaterThanOrEqual(6);
    expect(filas.rows.filter((f) => !f.coincide)).toEqual([]);

    // Control negativo: la misma comprobación desde una sesión argentina **no**
    // puede coincidir. Si coincidiera, esta prueba no distinguiría nada.
    await fijarZona(client, ZONA_DE_NEGOCIO);
    const desdeArgentina = await client.query<{ coincide: boolean }>(RECALCULO_EMPRESA, [
      fx.companyA,
    ]);
    expect(desdeArgentina.rows.filter((f) => f.coincide)).toEqual([]);

    // El verificador, en cambio, da lo mismo en las dos: es lo que la 0131 arregla.
    for (const zona of zonas) {
      await fijarZona(client, zona);
      expect(await roturas(client, fx.companyA), `roturas desde ${zona}`).toBe(0);
    }
  });

  it('P4b · matriz: escribir en 10 zonas × 6 estilos de fecha y verificar desde las 60 sesiones', async () => {
    // Una sola cadena, dentro de una transacción que se descarta. Si el hash
    // dependiera de la zona o del DateStyle de quien escribe o de quien
    // verifica, alguna de las 120 combinaciones daría una rotura.
    await client.query('BEGIN');
    try {
      let n = 0;
      for (const zona of ZONAS_EXOTICAS) {
        for (const estilo of ESTILOS) {
          await fijarZona(client, zona);
          await client.query(`SET datestyle = '${estilo}'`);
          await escribirAuditoria(client, fx.companyB, `p4b-${n}`, 1);
          n += 1;
        }
      }
      expect(n).toBe(ZONAS_EXOTICAS.length * ESTILOS.length);
      expect(n).toBe(60);

      const conRotura: string[] = [];
      for (const zona of ZONAS_EXOTICAS) {
        for (const estilo of ESTILOS) {
          await fijarZona(client, zona);
          await client.query(`SET datestyle = '${estilo}'`);
          if ((await roturas(client, fx.companyB)) !== 0) conRotura.push(`${zona} / ${estilo}`);
        }
      }
      expect(conRotura, 'verificadores que ven la cadena rota').toEqual([]);

      // Comprobación INDEPENDIENTE de las funciones: el hash de cada una de las 60
      // filas se recalcula acá, en SQL plano, desde la sesión canónica (UTC, ISO).
      // Verificar solo con `verify_audit_chain` sería circular: trigger y
      // verificador están fijados igual y podrían equivocarse juntos.
      await fijarZona(client, UTC);
      await client.query("SET datestyle = 'ISO, MDY'");
      const independiente = await client.query<{ coincide: boolean }>(RECALCULO_EMPRESA, [fx.companyB]);
      expect(independiente.rows.length).toBeGreaterThanOrEqual(60);
      expect(independiente.rows.filter((f) => !f.coincide)).toEqual([]);
    } finally {
      await client.query('ROLLBACK');
      await client.query('RESET datestyle');
    }
  });

  it('P8 · el instante que /audit/anomalias le pasa al motor sale igual desde cualquier sesión', async () => {
    // La expresión se lee del código de la ruta: si alguien la cambia por
    // `created_at::text` (que depende de TimeZone y DateStyle), este test falla.
    const ruta = await readFile(join(RAIZ, 'apps', 'api', 'src', 'routes', 'audit.ts'), 'utf8');
    const expresion = /to_char\(e\.created_at AT TIME ZONE 'UTC', '[^']+'\)/.exec(ruta)?.[0];
    expect(expresion, 'audit.ts ya no formatea cargado_el con to_char(… AT TIME ZONE UTC)').toBeDefined();
    const sql = `SELECT ${expresion!.replace('e.created_at', "TIMESTAMPTZ '2026-05-01 00:30:00.123456+00'")} AS t`;

    const vistos = new Set<string>();
    try {
      for (const zona of ZONAS_EXOTICAS) {
        for (const estilo of ESTILOS) {
          await fijarZona(client, zona);
          await client.query(`SET datestyle = '${estilo}'`);
          vistos.add((await client.query<{ t: string }>(sql)).rows[0]!.t);
        }
      }
    } finally {
      await client.query('RESET datestyle');
      await client.query('RESET timezone');
    }
    expect([...vistos]).toEqual(['2026-05-01T00:30:00.123Z']);
  });

  it('P4 · la cadena normativa tampoco depende de la zona', async () => {
    const marca = `zona-${Date.now()}-${Math.floor(Math.random() * 1e6)}`;
    await client.query('BEGIN');
    try {
      let n = 0;
      for (const zona of ZONAS_EXOTICAS) {
        for (const estilo of ESTILOS) {
          await fijarZona(client, zona);
          await client.query(`SET datestyle = '${estilo}'`);
          await client.query(
            `INSERT INTO normative_audit_logs
               (actor_type, actor_id, action, object_type, object_id, motivo, prev_hash, hash, seq)
             VALUES ('USER', 'user:revisora', 'RULE_APPROVED', 'accounting_rules', $1, $2, '', '', 0)`,
            [`${marca}-${n}`, CONSTANCIA],
          );
          n += 1;
        }
      }
      // Recalculado en SQL plano desde la sesión canónica, independiente de las funciones.
      await fijarZona(client, UTC);
      await client.query("SET datestyle = 'ISO, MDY'");
      const r = await client.query<{ coincide: boolean }>(RECALCULO_NORMATIVO, [`${marca}%`]);
      expect(r.rows).toHaveLength(ZONAS_EXOTICAS.length * ESTILOS.length);
      expect(r.rows.filter((f) => !f.coincide)).toEqual([]);
    } finally {
      await client.query('ROLLBACK');
      await client.query('RESET datestyle');
    }
  });

  it('P4c · otras variables de sesión (intervalstyle, extra_float_digits, bytea_output, lc_monetary) tampoco mueven el hash', async () => {
    await client.query('BEGIN');
    try {
      const variantes = [
        ["SET intervalstyle = 'sql_standard'", 'SET extra_float_digits = -3', "SET bytea_output = 'escape'"],
        ["SET intervalstyle = 'iso_8601'", 'SET extra_float_digits = 3', "SET bytea_output = 'hex'"],
        ["SET intervalstyle = 'postgres_verbose'", 'SET extra_float_digits = 0', "SET lc_monetary = 'C'"],
      ];
      let n = 0;
      for (const sets of variantes) {
        for (const s of sets) await client.query(s);
        await client.query(
          `INSERT INTO audit_logs (company_id, actor_type, actor_id, action, object_type, object_id, old_value, new_value, motivo)
           VALUES ($1, 'USER', 'contador', 'APROBAR_ASIENTO', 'journal_entry', $2,
                   '{"importe": 1.10, "tasa": 1e3, "nombre": "Año"}', '{"importe": 0.1, "lista": [1, 2.50]}', 'revisión ñandú')`,
          [fx.companyB, `p4c-${n}`],
        );
        n += 1;
      }
      await fijarZona(client, UTC);
      await client.query("SET datestyle = 'ISO, MDY'");
      const r = await client.query<{ coincide: boolean }>(
        `SELECT id::text AS id,
                encode(digest(concat_ws('|',
                  prev_hash, seq::text, company_id::text, actor_type, actor_id, action,
                  object_type, object_id,
                  COALESCE(old_value::text, ''), COALESCE(new_value::text, ''),
                  COALESCE(motivo, ''), occurred_at::text), 'sha256'), 'hex') = hash AS coincide
           FROM audit_logs WHERE company_id = $1 AND object_id LIKE 'p4c-%' ORDER BY seq`,
        [fx.companyB],
      );
      expect(r.rows).toHaveLength(3);
      expect(r.rows.filter((f) => !f.coincide)).toEqual([]);
      expect(await roturas(client, fx.companyB)).toBe(0);
    } finally {
      await client.query('ROLLBACK');
      for (const v of ['intervalstyle', 'extra_float_digits', 'bytea_output', 'lc_monetary', 'datestyle']) {
        await client.query(`RESET ${v}`);
      }
    }
  });

  it('P5 · filas heredadas: lo escrito antes de las migraciones verifica desde cualquier sesión después', async () => {
    // Reproduce la situación de producción sin depender del contenido de un
    // backup: se vuelve —dentro de una transacción— al estado anterior a la 0131,
    // se escribe como se escribió siempre (sesión UTC, estilo ISO) y se aplican,
    // **una por una, los archivos reales de las migraciones**, comprobando entre
    // las dos qué queda cubierto. Todo se deshace con ROLLBACK.
    const [sql0131, sql0132] = await Promise.all(MIGRACIONES.map((ruta) => readFile(ruta, 'utf8')));
    const FUNCIONES_SQL = ['audit_chain_link()', 'normative_audit_chain_link()', 'verify_audit_chain(uuid)'];
    const desde = async (zona: string, estilo: string) => {
      await fijarZona(client, zona);
      await client.query(`SET datestyle = '${estilo}'`);
      return roturas(client, fx.companyB);
    };

    await client.query('BEGIN');
    try {
      for (const funcion of FUNCIONES_SQL) {
        await client.query(`ALTER FUNCTION ${funcion} RESET timezone`);
        await client.query(`ALTER FUNCTION ${funcion} RESET datestyle`);
      }

      await desde(UTC, 'ISO, MDY');
      await escribirAuditoria(client, fx.companyB, 'p5-heredada', 4);

      // ANTES de la 0131: UTC verifica; Argentina NO. Es el control negativo
      // (P2 del plan): demuestra que el cambio ingenuo de zona rompía la cadena.
      expect(await desde(UTC, 'ISO, MDY'), 'antes de la 0131, desde UTC').toBe(0);
      expect(
        await desde(ZONA_DE_NEGOCIO, 'ISO, MDY'),
        'antes de la 0131, desde Argentina: tendría que detectar roturas',
      ).toBeGreaterThan(0);

      // DESPUÉS de la 0131: la zona ya no importa…
      await client.query(sql0131);
      for (const zona of ZONAS_EXOTICAS) {
        expect(await desde(zona, 'ISO, MDY'), `tras la 0131, desde ${zona}`).toBe(0);
      }
      // …pero el formato de fecha todavía sí: es la brecha que cierra la 0132.
      expect(
        await desde(UTC, 'SQL, DMY'),
        'tras la 0131 y antes de la 0132, un estilo SQL tendría que detectar roturas',
      ).toBeGreaterThan(0);

      // DESPUÉS de la 0132: ni la zona ni el formato.
      await client.query(sql0132);
      const resultados = new Set<string>();
      for (const zona of ZONAS_EXOTICAS) {
        for (const estilo of ESTILOS) {
          const r = await desde(zona, estilo);
          expect(r, `tras la 0132, desde ${zona} / ${estilo}`).toBe(0);
          resultados.add(String(r));
        }
      }
      expect([...resultados]).toEqual(['0']);

      // Y las TRES funciones —no solo la de la cadena por empresa— quedan con las
      // dos fijaciones: una línea que falte en cualquiera de los dos archivos se nota acá.
      const config = await client.query<{ proname: string; config: string }>(
        `SELECT proname, coalesce(array_to_string(proconfig, ','), '') AS config
           FROM pg_proc WHERE proname = ANY($1::text[])`,
        [FUNCIONES],
      );
      for (const nombre of FUNCIONES) {
        const fila = config.rows.find((x) => x.proname === nombre);
        expect(fila?.config, `${nombre} tras aplicar 0131 y 0132`).toMatch(/(^|,)timezone=UTC(,|$)/i);
        expect(fila?.config, `${nombre} tras aplicar 0131 y 0132`).toMatch(/(^|,)datestyle=ISO(,|$)/i);
      }
    } finally {
      await client.query('ROLLBACK');
      await client.query('RESET datestyle');
    }
  });
});

suite('Zona horaria — las conexiones de la aplicación (P7)', () => {
  let fx: Fixture;
  let client: Client;
  const PGOPTIONS_PREVIA = process.env['PGOPTIONS'];

  beforeAll(async () => {
    client = await connect();
    fx = await seed(client, 'zonapool');
    // El entorno es **hostil a propósito**. `tests/setup-env.ts` fija PGOPTIONS en
    // hora argentina para los clientes crudos de los tests, y con eso este suite
    // pasaría aunque `initPool` no pidiera la zona (falso PASS, hallado en la
    // auditoría del 2026-10-07). Acá el entorno dice UTC: si el pool devuelve hora
    // argentina es porque `initPool` la pidió, y porque la opción explícita le
    // gana a la variable de entorno.
    process.env['PGOPTIONS'] = '-c timezone=UTC';
    initPool(process.env['DATABASE_URL']!);
  });

  afterAll(async () => {
    await closePool();
    if (PGOPTIONS_PREVIA === undefined) delete process.env['PGOPTIONS'];
    else process.env['PGOPTIONS'] = PGOPTIONS_PREVIA;
    await client?.end();
  });

  it('el pool gana aunque el entorno pida UTC (PGOPTIONS=-c timezone=UTC)', async () => {
    expect(process.env['PGOPTIONS']).toBe('-c timezone=UTC');
    const zona = await withoutCompany(
      'system:test',
      async (tx) => (await tx.query<{ TimeZone: string }>('SHOW timezone')).rows[0]!.TimeZone,
    );
    expect(zona).toBe(ZONA_DE_NEGOCIO);
  });

  it('TODAS las conexiones del pool la reciben, no solo la primera', async () => {
    // Cinco transacciones a la vez obligan al pool a abrir varias conexiones
    // distintas; `pg_sleep` las mantiene abiertas hasta que todas están en uso.
    const filas = await Promise.all(
      Array.from({ length: 5 }, () =>
        withoutCompany('system:test', async (tx) =>
          (
            await tx.query<{ pid: number; zona: string }>(
              `SELECT pg_backend_pid() AS pid, current_setting('TimeZone') AS zona, pg_sleep(0.3)`,
            )
          ).rows[0]!,
        ),
      ),
    );
    expect(new Set(filas.map((f) => f.pid)).size, 'el pool no abrió varias conexiones').toBeGreaterThanOrEqual(3);
    expect(filas.filter((f) => f.zona !== ZONA_DE_NEGOCIO)).toEqual([]);
  });

  it('la zona no se pierde tras una transacción que la cambió y se deshizo', async () => {
    // `SET LOCAL` dentro de una transacción de la aplicación no puede contaminar la conexión.
    await withoutCompany('system:test', async (tx) => {
      await tx.query("SET LOCAL timezone = 'UTC'");
    });
    const zona = await withoutCompany(
      'system:test',
      async (tx) => (await tx.query<{ TimeZone: string }>('SHOW timezone')).rows[0]!.TimeZone,
    );
    expect(zona).toBe(ZONA_DE_NEGOCIO);
  });

  it('al reciclar las conexiones (cerrar el pool y abrir otro), las nuevas también la traen', async () => {
    // Las conexiones del pool se reciclan por inactividad, por reinicio de la
    // aplicación y por reinicio de la base. La zona es un parámetro de arranque
    // de CADA conexión: lo que importa es que una conexión nueva no dependa de
    // la anterior ni del entorno.
    const lote = () =>
      Promise.all(
        Array.from({ length: 4 }, () =>
          withoutCompany('system:test', async (tx) =>
            (
              await tx.query<{ pid: number; zona: string }>(
                `SELECT pg_backend_pid() AS pid, current_setting('TimeZone') AS zona, pg_sleep(0.2)`,
              )
            ).rows[0]!,
          ),
        ),
      );
    const antes = await lote();
    await closePool();
    initPool(process.env['DATABASE_URL']!);
    const despues = await lote();

    const pidsAntes = new Set(antes.map((f) => f.pid));
    expect(despues.filter((f) => pidsAntes.has(f.pid)), 'reutilizó una conexión del pool anterior').toEqual([]);
    expect([...antes, ...despues].filter((f) => f.zona !== ZONA_DE_NEGOCIO)).toEqual([]);
  });

  it('una transacción que falla no deja la conexión en otra zona', async () => {
    await expect(
      withoutCompany('system:test', async (tx) => {
        await tx.query("SET LOCAL timezone = 'Asia/Tokyo'");
        throw new Error('falla a propósito');
      }),
    ).rejects.toThrow('falla a propósito');
    const zonas = await Promise.all(
      Array.from({ length: 3 }, () =>
        withoutCompany('system:test', async (tx) => (await tx.query<{ z: string }>(`SELECT current_setting('TimeZone') AS z`)).rows[0]!.z),
      ),
    );
    expect(zonas).toEqual([ZONA_DE_NEGOCIO, ZONA_DE_NEGOCIO, ZONA_DE_NEGOCIO]);
  });

  it('con empresa en contexto, la sesión está en la zona del negocio', async () => {
    const zona = await withCompany(
      { companyId: fx.companyA, actorId: 'system:test' },
      async (tx) => (await tx.query<{ TimeZone: string }>('SHOW timezone')).rows[0]!.TimeZone,
    );
    expect(zona).toBe(ZONA_DE_NEGOCIO);
  });

  it('sin empresa en contexto, también', async () => {
    const zona = await withoutCompany(
      'system:test',
      async (tx) => (await tx.query<{ TimeZone: string }>('SHOW timezone')).rows[0]!.TimeZone,
    );
    expect(zona).toBe(ZONA_DE_NEGOCIO);
  });

  it('CURRENT_DATE es el día argentino, no el de UTC', async () => {
    // En una sola sentencia, así las dos fechas salen del mismo instante y la
    // prueba no cruza la medianoche a mitad de camino.
    const r = await withoutCompany('system:test', async (tx) =>
      tx.query<{ igual: boolean; hoy: string }>(
        `SELECT current_date::text = (now() AT TIME ZONE $1)::date::text AS igual,
                current_date::text AS hoy`,
        [ZONA_DE_NEGOCIO],
      ),
    );
    expect(r.rows[0]!.igual, `CURRENT_DATE devolvió ${r.rows[0]!.hoy}`).toBe(true);
  });
});
