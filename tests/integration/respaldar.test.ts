/**
 * `infrastructure/systemd/respaldar.sh` — la copia de resguardo, ejecutada DE VERDAD.
 *
 * Hasta ahora este guion solo se probaba leyendo su texto (`tests/unit/tareas-agendadas.test.ts`):
 * que mencione `pg_restore --list`, que no use `rm -rf`. Eso no prueba que haga lo que dice. Acá
 * se corre el guion real, de punta a punta, con un `docker` de mentira (`tests/fixtures/shims/docker-pg`)
 * que traduce cada llamada a los binarios locales de PostgreSQL. Es el mismo código que corre en el
 * servidor; lo único que cambia es quién ejecuta `pg_dump`.
 *
 * La base «viva» es una **copia aislada** de `aai_test` creada para este archivo, así que ninguna otra
 * suite le cambia filas mientras se compara.
 *
 * Qué se demuestra:
 *   · una copia buena queda con su `.sha256`, restaurada de verdad y con las filas dentro de rango;
 *   · cada camino de falla termina en código 1 **y no deja una copia que parezca buena**;
 *   · la base descartable de la prueba de restauración se borra siempre;
 *   · el `.env` con `EMAIL_FROM=NEXO <no-reply@…>` sin comillas ya no rompe la carga.
 */

import { spawnSync } from 'node:child_process';
import { chmodSync, copyFileSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, utimesSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { delimiter, dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
// @ts-expect-error — módulo .mjs sin tipos, a propósito: es JavaScript plano.
import { binarioDePostgres } from '../../scripts/lib/postgres-cli.mjs';
import { DATABASE_URL, hasDatabase } from './helpers/db.js';

const suite = hasDatabase ? describe : describe.skip;

const RAIZ = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const GUION = join(RAIZ, 'infrastructure', 'systemd', 'respaldar.sh').replace(/\\/g, '/');
const SHIM = join(RAIZ, 'tests', 'fixtures', 'shims', 'docker-pg');

const bin = (nombre: string): string => binarioDePostgres(nombre) as string;
const PG_BIN = dirname(bin('psql')).replace(/\\/g, '/');

const url = new URL(DATABASE_URL);
const USUARIO = decodeURIComponent(url.username);
const CLAVE = decodeURIComponent(url.password);
const HOST = url.hostname;
const PUERTO = url.port || '5432';
const VIVA = `aai_respaldo_${Date.now().toString(36)}_${Math.floor(Math.random() * 1e4).toString(36)}`;

function pgBin(nombre: string, args: string[], entrada?: Buffer) {
  return spawnSync(bin(nombre), ['-h', HOST, '-p', PUERTO, '-U', USUARIO, ...args], {
    env: { ...process.env, PGPASSWORD: CLAVE },
    input: entrada,
    maxBuffer: 256 * 1024 * 1024,
  });
}

interface Corrida {
  codigo: number | null;
  salida: string;
  carpeta: string;
}

suite('respaldar.sh — ejecutado de verdad', () => {
  let admin: pg.Client;
  let trabajo: string;
  let bindir: string;

  beforeAll(async () => {
    trabajo = mkdtempSync(join(tmpdir(), 'respaldar-'));
    bindir = join(trabajo, 'bin');
    mkdirSync(bindir);
    copyFileSync(SHIM, join(bindir, 'docker'));
    chmodSync(join(bindir, 'docker'), 0o755);

    // La base «viva»: una copia de aai_test, aislada de las demás suites.
    admin = new pg.Client({ connectionString: DATABASE_URL.replace(/\/[^/?]+(\?|$)/u, '/postgres$1') });
    await admin.connect();
    await admin.query(`CREATE DATABASE "${VIVA}"`);
    const volcado = pgBin('pg_dump', ['-d', url.pathname.slice(1), '-Fc', '--no-owner']);
    expect(volcado.status, String(volcado.stderr)).toBe(0);
    const restauracion = pgBin('pg_restore', ['-d', VIVA, '--no-owner'], volcado.stdout as Buffer);
    expect([0, 1], String(restauracion.stderr)).toContain(restauracion.status);
  }, 120_000);

  afterAll(async () => {
    await admin?.query(`DROP DATABASE IF EXISTS "${VIVA}" WITH (FORCE)`);
    await admin?.end();
    rmSync(trabajo, { recursive: true, force: true });
  });

  /** Corre el guion con un destino y un `.env` propios. `envExtra` inyecta fallas en el `docker` de mentira. */
  function correr(args: string[], envExtra: Record<string, string> = {}, opciones: { envTexto?: string; carpeta?: string } = {}): Corrida {
    const carpeta = opciones.carpeta ?? mkdtempSync(join(trabajo, 'destino-'));
    const archivoEnv = join(carpeta, '..', `env-${Math.random().toString(36).slice(2)}`).replace(/\\/g, '/');
    writeFileSync(
      archivoEnv,
      opciones.envTexto ??
        // El orden importa: la línea que no es shell-válida va PRIMERO. Con `. .env` se perdía todo lo de después.
        [`EMAIL_FROM=NEXO <no-reply@nexointelligence.com.ar>`, `POSTGRES_USER=${USUARIO}`, `POSTGRES_PASSWORD=${CLAVE}`, `POSTGRES_DB=${VIVA}`, ''].join('\n'),
    );
    const r = spawnSync('bash', [GUION, ...args], {
      env: {
        ...process.env,
        PATH: `${bindir}${delimiter}${process.env['PATH'] ?? ''}`,
        NEXO_BACKUP_DIR: carpeta.replace(/\\/g, '/'),
        NEXO_ENV_FILE: archivoEnv,
        PG_BIN,
        FAKE_PGHOST: HOST,
        FAKE_PGPORT: PUERTO,
        ...envExtra,
      },
      encoding: 'utf8',
      timeout: 110_000,
    });
    return { codigo: r.status, salida: `${r.stdout}\n${r.stderr}`, carpeta };
  }

  const archivos = (carpeta: string, sufijo: string): string[] => readdirSync(carpeta).filter((f) => f.endsWith(sufijo));
  const descartables = async (): Promise<string[]> =>
    (await admin.query<{ datname: string }>("SELECT datname FROM pg_database WHERE datname LIKE 'aai_restauracion_verif_%'")).rows.map((r) => r.datname);

  // Otros archivos de prueba (el de desplegar.sh, que corre este mismo guion contra el mismo servidor) crean y borran sus
  // propias descartables a la vez. Comparar «lo que había antes» con «lo que hay después» daba falsos rojos cuando una
  // ajena desaparecía en el medio. Lo que se defiende es que NINGUNA descartable NUEVA sobreviva a esta corrida.
  const nuevas = async (antes: string[]): Promise<string[]> => (await descartables()).filter((n) => !antes.includes(n));

  it('copia manual con prueba de restauración: queda con su huella, restaurada de verdad y sin base descartable', async () => {
    const antes = await descartables();
    const r = correr(['--etiqueta', 'predeploy-prueba', '--verificar-restauracion']);

    expect(r.codigo, r.salida).toBe(0);
    expect(r.salida).toContain('RESPALDO_RESTAURACION=ok');
    expect(r.salida).toMatch(/restauración comprobada: \d+ tablas y \d+ filas/u);

    const dumps = archivos(r.carpeta, '-predeploy-prueba.dump');
    expect(dumps).toHaveLength(1);
    const dump = join(r.carpeta, dumps[0]!);
    expect(statSync(dump).size).toBeGreaterThan(1_000_000);
    expect(existsSync(`${dump}.sha256`)).toBe(true);

    // La suma que quedó escrita es la del archivo: se verifica con la herramienta del sistema, no con el guion.
    const suma = spawnSync('sha256sum', ['-c', `${dumps[0]}.sha256`], { cwd: r.carpeta, encoding: 'utf8' });
    expect(suma.status, suma.stderr).toBe(0);
    expect(r.salida).toContain(`RESPALDO_SHA256=${readFileSync(`${dump}.sha256`, 'utf8').split(' ')[0]}`);

    // La base descartable se borró.
    expect(await nuevas(antes), "quedó una base descartable de ESTA corrida").toEqual([]);
    // La contraseña nunca se imprime.
    expect(r.salida).not.toContain(CLAVE);
  }, 120_000);

  it('el `.env` con `EMAIL_FROM` sin comillas ya no rompe la carga (regresión de `. .env`)', () => {
    // Lo prueba el caso anterior (la línea rota va primero), y esto lo dice sin rodeos: con el guion viejo,
    // POSTGRES_* quedaban sin leer y salía «no declara POSTGRES_USER».
    const r = correr(['--ver']);
    expect(r.codigo, r.salida).toBe(0);
    expect(r.salida).not.toMatch(/no declara/u);
  });

  it('--ver no escribe nada', () => {
    const r = correr(['--ver']);
    expect(r.codigo, r.salida).toBe(0);
    expect(r.salida).toContain('no se escribió ni se borró nada');
    expect(readdirSync(r.carpeta)).toEqual([]);
  });

  it('la copia diaria (-auto) poda las automáticas viejas y NUNCA las manuales', () => {
    const carpeta = mkdtempSync(join(trabajo, 'destino-'));
    const antiguo = (nombre: string, dias: number) => {
      const ruta = join(carpeta, nombre);
      writeFileSync(ruta, 'x');
      writeFileSync(`${ruta}.sha256`, 'x');
      const t = new Date(Date.now() - dias * 86_400_000);
      utimesSync(ruta, t, t);
    };
    antiguo('viva-20200101T000000Z-auto.dump', 30);
    antiguo('viva-20200102T000000Z-auto.dump', 20);
    antiguo('viva-20200103T000000Z-auto.dump', 10);
    antiguo('viva-20190101T000000Z-predeploy-viejo.dump', 900);

    const r = correr([], { NEXO_BACKUP_RETENER: '2' }, { carpeta });
    expect(r.codigo, r.salida).toBe(0);

    const autos = archivos(carpeta, '-auto.dump');
    expect(autos).toHaveLength(2); // retención 2: la nueva y la más reciente de las viejas
    expect(autos).not.toContain('viva-20200101T000000Z-auto.dump');
    expect(autos).not.toContain('viva-20200102T000000Z-auto.dump');
    // Se llevó su huella con ella, y la manual, por antigua que sea, sigue ahí.
    expect(existsSync(join(carpeta, 'viva-20200101T000000Z-auto.dump.sha256'))).toBe(false);
    expect(existsSync(join(carpeta, 'viva-20190101T000000Z-predeploy-viejo.dump'))).toBe(true);
  }, 120_000);

  describe('caminos de falla: terminan en 1 y no dejan una copia que parezca buena', () => {
    it('pg_dump falla', () => {
      const r = correr(['--etiqueta', 'falla'], { FAKE_PGDUMP_MAL: '1' });
      expect(r.codigo, r.salida).toBe(1);
      expect(r.salida).toContain('pg_dump falló');
      expect(readdirSync(r.carpeta)).toEqual([]);
    });

    it('el índice del volcado no se puede leer: se borra', () => {
      const r = correr(['--etiqueta', 'falla'], { FAKE_LISTA_MAL: '1' });
      expect(r.codigo, r.salida).toBe(1);
      expect(r.salida).toContain('no se puede leer');
      expect(readdirSync(r.carpeta)).toEqual([]);
    });

    it('pg_restore termina con error: se descarta la copia y se limpia la base descartable', async () => {
      const antes = await descartables();
      const r = correr(['--etiqueta', 'falla', '--verificar-restauracion'], { FAKE_RESTORE_MAL: '1' });
      expect(r.codigo, r.salida).toBe(1);
      expect(r.salida).toContain('pg_restore terminó con errores');
      expect(archivos(r.carpeta, '.dump')).toEqual([]);
      expect(await nuevas(antes), "quedó una base descartable de ESTA corrida").toEqual([]);
    }, 120_000);

    it('la restauración trae menos filas que la base viva: se detecta, se borra la copia y se limpia la descartable', async () => {
      const antes = await descartables();
      const r = correr(['--etiqueta', 'alterada', '--verificar-restauracion'], { FAKE_RESTORE_SQL: 'DELETE FROM schema_migrations' });
      expect(r.codigo, r.salida).toBe(1);
      expect(r.salida).toMatch(/filas fuera de rango en schema_migrations/u);
      expect(r.salida).toContain('NO coincide con la base viva');
      expect(archivos(r.carpeta, '.dump')).toEqual([]);
      expect(archivos(r.carpeta, '.sha256')).toEqual([]);
      expect(await nuevas(antes), "quedó una base descartable de ESTA corrida").toEqual([]);
    }, 120_000);

    it('a la restauración le falta una tabla: se detecta', async () => {
      const antes = await descartables();
      const r = correr(['--etiqueta', 'incompleta', '--verificar-restauracion'], { FAKE_RESTORE_SQL: 'DROP TABLE public.email_outbox CASCADE' });
      expect(r.codigo, r.salida).toBe(1);
      expect(r.salida).toMatch(/falta en la restauración: email_outbox/u);
      expect(archivos(r.carpeta, '.dump')).toEqual([]);
      expect(await nuevas(antes), 'quedó una base descartable de ESTA corrida').toEqual([]);
    }, 120_000);
  });

  describe('argumentos y entorno', () => {
    it('un argumento desconocido termina en 2 y no hace nada', () => {
      const r = correr(['--desplegar-todo']);
      expect(r.codigo, r.salida).toBe(2);
      expect(r.salida).toContain('argumento desconocido');
      expect(readdirSync(r.carpeta)).toEqual([]);
    });

    it.each(['Mayusculas', 'con espacio', '../fuera', ''])('la etiqueta «%s» no es válida', (etiqueta) => {
      const r = correr(['--etiqueta', etiqueta]);
      expect(r.codigo, r.salida).toBe(2);
      expect(r.salida).toContain('etiqueta no válida');
    });

    it('si el `.env` no declara una variable, lo dice por su nombre y no escribe nada', () => {
      const r = correr(['--etiqueta', 'x'], {}, { envTexto: `POSTGRES_USER=${USUARIO}\nPOSTGRES_DB=${VIVA}\n` });
      expect(r.codigo, r.salida).toBe(1);
      expect(r.salida).toContain('no declara POSTGRES_PASSWORD');
      expect(readdirSync(r.carpeta)).toEqual([]);
    });

    it('lee un valor entre comillas sin las comillas y sin interpretar el `$` de una contraseña', () => {
      // Una contraseña con `$` y comillas, como las que genera un gestor. `. .env` la habría expandido.
      const r = correr(['--ver'], {}, { envTexto: `POSTGRES_USER="${USUARIO}"\nPOSTGRES_PASSWORD='a$b"c'\nPOSTGRES_DB=${VIVA}\n` });
      expect(r.codigo, r.salida).toBe(0);
      expect(r.salida).not.toMatch(/no declara/u);
    });
  });
});
