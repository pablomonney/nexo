/**
 * `scripts/desplegar.sh` — el despliegue, ejecutado DE VERDAD contra un servidor simulado.
 *
 * Hasta el 2026-10-15 este guion no tenía ni una prueba, y tenía cuatro defectos que solo se ven cuando algo
 * sale mal: desplegaba con cualquier argumento (`--help` incluido), no hacía copia de resguardo, seguía hasta
 * `docker compose up` después de un error de migración y pisaba `nexo:production` sin guardar la imagen anterior.
 *
 * Acá se corre el guion real, de punta a punta, con:
 *   · un repositorio git de verdad (origen + servidor) para probar el avance al commit pedido;
 *   · un `docker` de mentira CON ESTADO (`tests/fixtures/shims/docker-falso`) que registra cada llamada, de modo
 *     que se puede comprobar el ORDEN: etiquetar → construir → copia → migrar → levantar;
 *   · un `respaldar.sh` de mentira dentro de ese repositorio (el real se prueba en
 *     `tests/integration/respaldar.test.ts`).
 *
 * Nada sale a la red ni toca un Docker real. Lo que se demuestra:
 *   · sin `--commit` no se despliega; un argumento desconocido no despliega nada;
 *   · `--auditar` no cambia nada;
 *   · cada camino de falla corta ANTES de `docker compose up`, y dice en qué estado queda producción;
 *   · la imagen anterior queda etiquetada y `--revertir` vuelve a ella;
 *   · el guion sobrevive a que el `git merge` lo reemplace mientras corre.
 */

import { spawnSync } from 'node:child_process';
import { chmodSync, copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { delimiter, dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

const RAIZ_REPO = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const SHIMS = join(RAIZ_REPO, 'tests', 'fixtures', 'shims');
const GUION_REAL = join(RAIZ_REPO, 'scripts', 'desplegar.sh');

const bash = spawnSync('bash', ['-c', 'echo ok'], { encoding: 'utf8' });
const hayBash = bash.status === 0;
const suite = hayBash ? describe : describe.skip;

const aBash = (ruta: string): string => ruta.replace(/\\/g, '/');
const CLAVE = 'clave-que-no-debe-aparecer-en-ninguna-salida';

interface Entorno {
  base: string;
  servidor: string;
  origen: string;
  estado: string;
  log: string;
  bin: string;
  commit1: string;
  commit2: string;
}

function git(cwd: string, ...args: string[]): string {
  const r = spawnSync('git', args, {
    cwd,
    encoding: 'utf8',
    env: { ...process.env, GIT_AUTHOR_NAME: 't', GIT_AUTHOR_EMAIL: 't@t', GIT_COMMITTER_NAME: 't', GIT_COMMITTER_EMAIL: 't@t' },
  });
  if (r.status !== 0) throw new Error(`git ${args.join(' ')}: ${r.stderr}`);
  return r.stdout.trim();
}

const RESPALDAR_FALSO = `#!/usr/bin/env bash
printf 'RESPALDAR %s\\n' "$*" >> "$FAKE_LOG"
echo "  ok: copia simulada"
printf 'RESPALDO_ARCHIVO=/opt/nexo/var/backups/aai-FALSO-predeploy.dump\\nRESPALDO_SHA256=abc123\\nRESPALDO_RESTAURACION=%s\\n' "\${FAKE_RESPALDAR_RESTAURACION:-ok}"
# Informa su archivo AUNQUE falle: así, un código de salida ignorado por el despliegue se nota.
if [[ "\${FAKE_RESPALDAR_EXIT:-0}" != "0" ]]; then echo "respaldar simulado: falló"; exit "$FAKE_RESPALDAR_EXIT"; fi
`;

suite('desplegar.sh — ejecutado de verdad', () => {
  let trabajo: string;
  let n = 0;

  beforeAll(() => {
    trabajo = mkdtempSync(join(tmpdir(), 'desplegar-'));
  });
  afterAll(() => {
    rmSync(trabajo, { recursive: true, force: true });
  });

  /**
   * Arma un servidor: origen con dos commits (c1 < c2), servidor clonado en c1, estado de Docker simulado
   * (sirviendo la versión `b412b9e` con 130 migraciones) y un `.env` con la línea que rompía `. .env`.
   */
  function armar(opciones: { cambiarElGuionEnC2?: boolean } = {}): Entorno {
    const base = join(trabajo, `caso-${n++}`);
    mkdirSync(base);
    const origen = aBash(join(base, 'origen.git'));
    const trabajoGit = aBash(join(base, 'trabajo'));
    const servidor = aBash(join(base, 'servidor'));
    const estado = aBash(join(base, 'estado'));
    const bin = join(base, 'bin');
    const log = aBash(join(base, 'docker.log'));
    mkdirSync(estado);
    mkdirSync(bin);
    writeFileSync(log, '');

    git(base, 'init', '--bare', '-q', '-b', 'main', origen);
    git(base, 'init', '-q', '-b', 'main', trabajoGit);
    mkdirSync(join(trabajoGit, 'scripts'));
    mkdirSync(join(trabajoGit, 'infrastructure', 'systemd'), { recursive: true });
    mkdirSync(join(trabajoGit, 'infrastructure', 'db', 'migrations'), { recursive: true });
    copyFileSync(GUION_REAL, join(trabajoGit, 'scripts', 'desplegar.sh'));
    writeFileSync(join(trabajoGit, 'infrastructure', 'systemd', 'respaldar.sh'), RESPALDAR_FALSO);
    writeFileSync(join(trabajoGit, 'docker-compose.prod.yml'), 'services: {}\n');
    writeFileSync(join(trabajoGit, 'Dockerfile'), 'FROM scratch\n');
    for (let i = 1; i <= 132; i += 1) {
      writeFileSync(join(trabajoGit, 'infrastructure', 'db', 'migrations', `${String(i).padStart(4, '0')}_m.sql`), `-- ${i}\n`);
    }
    git(trabajoGit, 'add', '-A');
    git(trabajoGit, 'commit', '-q', '-m', 'c1');
    git(trabajoGit, 'remote', 'add', 'origin', origen);
    git(trabajoGit, 'push', '-q', 'origin', 'main');
    const commit1 = git(trabajoGit, 'rev-parse', 'HEAD');

    git(base, 'clone', '-q', origen, servidor);

    // c2: el commit que se quiere desplegar.
    writeFileSync(join(trabajoGit, 'novedad.txt'), 'c2\n');
    if (opciones.cambiarElGuionEnC2) {
      // Reemplaza el guion mientras el servidor lo está ejecutando: la prueba del `git merge` sobre sí mismo.
      const original = readFileSync(join(trabajoGit, 'scripts', 'desplegar.sh'), 'utf8');
      writeFileSync(join(trabajoGit, 'scripts', 'desplegar.sh'), `# línea nueva al principio\n${original}\n# y otra al final\n`.replace(/^#!.*\n/u, '#!/usr/bin/env bash\n'));
    }
    git(trabajoGit, 'add', '-A');
    git(trabajoGit, 'commit', '-q', '-m', 'c2');
    git(trabajoGit, 'push', '-q', 'origin', 'main');
    const commit2 = git(trabajoGit, 'rev-parse', 'HEAD');

    // Lo que el servidor tiene y Git no: el `.env` (con la línea que rompía `. .env`) y una copia `.bak`.
    writeFileSync(
      join(servidor, '.env'),
      ['EMAIL_FROM=NEXO <no-reply@nexointelligence.com.ar>', 'POSTGRES_USER=nexo_admin', `POSTGRES_PASSWORD=${CLAVE}`, 'POSTGRES_DB=aai', ''].join('\n'),
    );
    chmodSync(join(servidor, '.env'), 0o600);
    writeFileSync(join(servidor, 'docker-compose.prod.yml.bak.20260915131651'), 'viejo\n');
    mkdirSync(join(servidor, 'var', 'documents'), { recursive: true });

    // Estado de Docker: sirviendo `b412b9e`, 130 migraciones.
    writeFileSync(join(base, 'estado', 'tag_nexo_production'), 'sha256:vieja');
    writeFileSync(join(base, 'estado', 'app_image'), 'sha256:vieja');
    writeFileSync(join(base, 'estado', 'app_build_id'), 'b412b9e');
    writeFileSync(join(base, 'estado', 'migraciones'), '130');

    for (const [shim, nombre] of [['docker-falso', 'docker'], ['curl-falso', 'curl'], ['openssl-falso', 'openssl'], ['getent-falso', 'getent'], ['stat-falso', 'stat'], ['chown-falso', 'chown']] as const) {
      copyFileSync(join(SHIMS, shim), join(bin, nombre));
      chmodSync(join(bin, nombre), 0o755);
    }

    return { base, servidor, origen, estado, log, bin, commit1, commit2 };
  }

  function correr(e: Entorno, args: string[], extra: Record<string, string> = {}) {
    writeFileSync(e.log, ''); // cada corrida informa solo sus propias llamadas
    const r = spawnSync('bash', [`${e.servidor}/scripts/desplegar.sh`, ...args], {
      cwd: e.servidor,
      env: {
        ...process.env,
        PATH: `${e.bin}${delimiter}${process.env['PATH'] ?? ''}`,
        NEXO_RAIZ: e.servidor,
        FAKE_LOG: e.log,
        FAKE_ESTADO: e.estado,
        NEXO_SONDA_REINTENTOS: '1',
        NEXO_SONDA_ESPERA: '0',
        ...extra,
      },
      encoding: 'utf8',
      timeout: 60_000,
    });
    const registro = readFileSync(e.log, 'utf8').split('\n').filter(Boolean);
    return { codigo: r.status, salida: `${r.stdout}\n${r.stderr}`, registro };
  }

  /** La posición de la primera línea del registro que coincide, o -1. */
  /** Un servidor armado una sola vez para los casos que no cambian nada (argumentos, --auditar). */
  let compartido: Entorno | undefined;
  const soloLectura = (): Entorno => (compartido ??= armar());

  const pos = (registro: string[], patron: RegExp): number => registro.findIndex((l) => patron.test(l));
  const tocaProduccion = (registro: string[]): boolean => registro.some((l) => /^(MIGRATE|RESPALDAR)|^docker compose .* up|^docker build/u.test(l));
  const HEAD = (e: Entorno): string => git(e.servidor, 'rev-parse', 'HEAD');

  describe('argumentos: un despliegue dice QUÉ se despliega', () => {
    it('sin --commit se niega (código 2) y no llama a Docker', () => {
      const e = soloLectura();
      const r = correr(e, []);
      expect(r.codigo, r.salida).toBe(2);
      expect(r.salida).toContain('falta --commit');
      expect(r.registro).toEqual([]);
    });

    it.each(['--help', '-h', '--ayuda'])('%s muestra el uso y NO despliega (antes lo hacía)', (bandera) => {
      const e = soloLectura();
      const r = correr(e, [bandera]);
      expect(r.codigo, r.salida).toBe(0);
      expect(r.salida).toContain('uso:');
      expect(r.registro).toEqual([]);
    });

    it.each([
      [['--lo-que-sea'], 'argumento desconocido'],
      [['desplegar'], 'argumento desconocido'],
      [['--commit', 'no-es-un-hash'], 'no es válido'],
      [['--commit', 'ABCDEF1'], 'no es válido'],
      [['--commit', 'abc'], 'no es válido'],
      [['--commit'], 'falta --commit'],
    ])('los argumentos %j terminan en 2, lo dicen (%s) y no hacen nada', (args, mensaje) => {
      const e = soloLectura();
      const r = correr(e, args);
      expect(r.codigo, r.salida).toBe(2);
      expect(r.salida).toContain(mensaje);
      expect(r.registro).toEqual([]);
    });
  });

  describe('--auditar no cambia nada', () => {
    it('informa y no construye, no etiqueta, no copia, no migra, no levanta ni avanza el código', () => {
      const e = soloLectura();
      const antes = HEAD(e);
      const r = correr(e, ['--auditar']);

      expect(r.salida).toContain('Todo lo verificable pasó');
      expect(r.codigo, r.salida).toBe(0);
      expect(tocaProduccion(r.registro)).toBe(false);
      expect(pos(r.registro, /^docker tag/u)).toBe(-1);
      expect(HEAD(e)).toBe(antes);
      expect(existsSync(join(e.servidor, 'var', 'despliegues'))).toBe(false);
    });

    it('con --commit compara contra ese commit, avisa la diferencia y tampoco avanza', () => {
      const e = soloLectura();
      const antes = HEAD(e);
      const r = correr(e, ['--auditar', '--commit', e.commit2.slice(0, 7)]);
      expect(r.salida).toMatch(/se pidió/u);
      expect(HEAD(e)).toBe(antes);
      expect(tocaProduccion(r.registro)).toBe(false);
    });
  });

  describe('una carrera del propio guion no puede cortar un despliegue sano', () => {
    it('un `docker ps` que escribe despacio no da «NO está corriendo» (pipefail + grep -q)', () => {
      const e = soloLectura();
      // Con `FAKE_PS_LENTO` el productor sigue escribiendo después de que el guion ya encontró el nombre que buscaba.
      // Si el guion buscara con `docker ps | grep -q`, cerraría la tubería y la salida diría que el contenedor no corre.
      const r = correr(e, ['--auditar'], { FAKE_PS_LENTO: '1' });
      expect(r.salida, r.salida).not.toMatch(/NO está corriendo/u);
      expect(r.salida).toContain('nexo-postgres corriendo');
      expect(r.salida).toContain('nexo-app corriendo');
      expect(r.salida).toContain('Traefik corriendo');
      expect(r.codigo, r.salida).toBe(0);
    });

    it('el guion no vuelve a buscar con `productor | grep -q` (que es lo que la causa)', () => {
      const fuente = readFileSync(join(RAIZ_REPO, 'scripts', 'desplegar.sh'), 'utf8')
        .split('\n')
        .filter((l) => !l.trimStart().startsWith('#'));
      const sospechosas = fuente.filter((l) => /\|\s*grep\s+-q[a-zA-Z]*\b/u.test(l));
      expect(sospechosas, 'con `set -o pipefail` estas líneas dan falsos negativos intermitentes').toEqual([]);
    });
  });

  describe('el despliegue que sale bien', () => {
    it('hace las cosas EN ORDEN: etiqueta la anterior → construye → copia verificada → migra → levanta', () => {
      const e = armar();
      const r = correr(e, ['--commit', e.commit2]);
      expect(r.codigo, r.salida).toBe(0);

      const etiquetar = pos(r.registro, /^docker tag sha256:vieja nexo:previo-/u);
      const construir = pos(r.registro, /^docker build/u);
      const copia = pos(r.registro, /^RESPALDAR/u);
      const migrar = pos(r.registro, /^MIGRATE/u);
      const levantar = pos(r.registro, /^docker compose .*up -d/u);

      for (const [nombre, valor] of Object.entries({ etiquetar, construir, copia, migrar, levantar })) {
        expect(valor, `falta el paso «${nombre}» en: ${r.registro.join(' | ')}`).toBeGreaterThanOrEqual(0);
      }
      expect(etiquetar).toBeLessThan(construir);
      expect(construir).toBeLessThan(copia);
      expect(copia).toBeLessThan(migrar);
      expect(migrar).toBeLessThan(levantar);

      // La copia se pide con etiqueta propia (que la poda nunca borra) Y probando la restauración.
      expect(r.registro[copia]).toContain(`--etiqueta predeploy-${e.commit2.slice(0, 7)}`);
      expect(r.registro[copia]).toContain('--verificar-restauracion');

      // El servidor terminó exactamente en el commit pedido.
      expect(HEAD(e)).toBe(e.commit2);
    });

    it('deja el registro para volver atrás, con la imagen anterior y la copia', () => {
      const e = armar();
      const r = correr(e, ['--commit', e.commit2]);
      expect(r.codigo, r.salida).toBe(0);

      const registro = readFileSync(join(e.servidor, 'var', 'despliegues', 'ultimo.env'), 'utf8');
      expect(registro).toContain(`COMMIT_NUEVO=${e.commit2}`);
      expect(registro).toContain(`COMMIT_SERVIDOR_ANTES=${e.commit1}`);
      expect(registro).toContain('VERSION_ANTERIOR=b412b9e');
      expect(registro).toMatch(/^IMAGEN_ANTERIOR_TAG=nexo:previo-\d+$/mu);
      expect(registro).toContain('IMAGEN_ANTERIOR_ID=sha256:vieja');
      expect(registro).toContain('RESPALDO_SHA256=abc123');
      expect(registro).toContain('MIGRACIONES_ANTES=130');
      expect(registro).toContain('MIGRACIONES_DESPUES=132');
      // La imagen anterior sigue existiendo con su nombre, aunque `nexo:production` ya apunta a la nueva.
      const tags = readdirSync(join(e.base, 'estado')).filter((f) => f.startsWith('tag_nexo_previo-'));
      expect(tags).toHaveLength(1);
      expect(readFileSync(join(e.base, 'estado', tags[0]!), 'utf8')).toBe('sha256:vieja');
      expect(readFileSync(join(e.base, 'estado', 'tag_nexo_production'), 'utf8')).not.toBe('sha256:vieja');
    });

    it('no imprime la contraseña y tolera el `.env` con `EMAIL_FROM` sin comillas', () => {
      const e = armar();
      const r = correr(e, ['--commit', e.commit2]);
      expect(r.codigo, r.salida).toBe(0);
      expect(r.salida).not.toContain(CLAVE);
      expect(r.registro.join('\n')).not.toContain(CLAVE);
      // POSTGRES_* está DESPUÉS de la línea rota: con `. .env` no se habría leído.
      expect(r.salida).toContain('conexión administrativa a «aai»');
    });

    it('el archivo sin versionar (.bak) no estorba y no se toca', () => {
      const e = armar();
      const r = correr(e, ['--commit', e.commit2]);
      expect(r.codigo, r.salida).toBe(0);
      expect(readFileSync(join(e.servidor, 'docker-compose.prod.yml.bak.20260915131651'), 'utf8')).toBe('viejo\n');
    });

    it('sobrevive a que el `git merge` REEMPLACE el propio guion mientras corre', () => {
      const e = armar({ cambiarElGuionEnC2: true });
      const antes = readFileSync(join(e.servidor, 'scripts', 'desplegar.sh'), 'utf8');
      const r = correr(e, ['--commit', e.commit2]);
      const despues = readFileSync(join(e.servidor, 'scripts', 'desplegar.sh'), 'utf8');

      expect(despues, 'el guion tendría que haber cambiado durante la corrida').not.toBe(antes);
      expect(r.codigo, r.salida).toBe(0);
      expect(pos(r.registro, /^docker compose .*up -d/u)).toBeGreaterThanOrEqual(0);
    });
  });

  describe('cada falla corta ANTES de levantar la imagen nueva', () => {
    it('un commit que no existe', () => {
      const e = armar();
      const antes = HEAD(e);
      const r = correr(e, ['--commit', 'deadbeef']);
      expect(r.codigo, r.salida).toBe(1);
      expect(r.salida).toContain('no existe en el repositorio ni en el remoto');
      expect(r.salida).toContain('Producción: SIN CAMBIOS');
      expect(tocaProduccion(r.registro)).toBe(false);
      expect(HEAD(e)).toBe(antes);
    });

    it('un commit que no es avance rápido (el servidor divergió)', () => {
      const e = armar();
      writeFileSync(join(e.servidor, 'local.txt'), 'x\n');
      git(e.servidor, 'add', 'local.txt');
      git(e.servidor, 'commit', '-q', '-m', 'divergido');
      const antes = HEAD(e);
      const r = correr(e, ['--commit', e.commit2]);
      expect(r.codigo, r.salida).toBe(1);
      expect(r.salida).toContain('no desciende');
      expect(tocaProduccion(r.registro)).toBe(false);
      expect(HEAD(e)).toBe(antes);
    });

    it('archivos VERSIONADOS modificados en el servidor', () => {
      const e = armar();
      writeFileSync(join(e.servidor, 'Dockerfile'), 'FROM scratch\n# arreglo hecho a mano en el servidor\n');
      const antes = HEAD(e);
      const r = correr(e, ['--commit', e.commit2]);
      expect(r.codigo, r.salida).toBe(1);
      expect(r.salida).toContain('versionados modificados');
      expect(tocaProduccion(r.registro)).toBe(false);
      expect(HEAD(e)).toBe(antes);
    });

    it('la construcción de la imagen falla: la imagen en servicio no cambia', () => {
      const e = armar();
      const r = correr(e, ['--commit', e.commit2], { FAKE_BUILD_EXIT: '1' });
      expect(r.codigo, r.salida).toBe(1);
      expect(r.salida).toContain('no se pudo construir la imagen');
      expect(pos(r.registro, /^RESPALDAR|^MIGRATE|up -d/u)).toBe(-1);
      expect(readFileSync(join(e.base, 'estado', 'tag_nexo_production'), 'utf8')).toBe('sha256:vieja');
    });

    it('la imagen nueva no trae lo que tiene que traer', () => {
      const e = armar();
      const r = correr(e, ['--commit', e.commit2], { FAKE_RUTA_FALTA: '1' });
      expect(r.codigo, r.salida).toBe(1);
      expect(r.salida).toContain('la imagen nueva no pasó la inspección');
      expect(pos(r.registro, /^RESPALDAR|^MIGRATE|up -d/u)).toBe(-1);
    });

    it('el repositorio y la imagen no tienen las mismas migraciones: la imagen no es la de este commit', () => {
      const e = armar();
      const r = correr(e, ['--commit', e.commit2], { FAKE_N_MIG_IMAGEN: '131' });
      expect(r.codigo, r.salida).toBe(1);
      expect(r.salida).toContain('la imagen no es la de este commit');
      expect(pos(r.registro, /^RESPALDAR|^MIGRATE|up -d/u)).toBe(-1);
    });

    it('la base no responde', () => {
      const e = armar();
      const r = correr(e, ['--commit', e.commit2], { FAKE_DB_CAIDA: '1' });
      expect(r.codigo, r.salida).toBe(1);
      expect(r.salida).toContain('no se hace la copia, no se migra y no se levanta la imagen nueva');
      expect(pos(r.registro, /^RESPALDAR|^MIGRATE|up -d/u)).toBe(-1);
    });

    it('la copia de resguardo falla: no se migra ni se levanta', () => {
      const e = armar();
      const r = correr(e, ['--commit', e.commit2], { FAKE_RESPALDAR_EXIT: '1' });
      expect(r.codigo, r.salida).toBe(1);
      expect(r.salida).toContain('la copia de resguardo falló');
      expect(r.salida).toContain('Producción: SIN CAMBIOS');
      expect(pos(r.registro, /^MIGRATE|up -d/u)).toBe(-1);
    });

    it('la copia salió pero NO se probó restaurándola: no alcanza', () => {
      const e = armar();
      const r = correr(e, ['--commit', e.commit2], { FAKE_RESPALDAR_RESTAURACION: 'omitida' });
      expect(r.codigo, r.salida).toBe(1);
      expect(r.salida).toContain('una copia sin restaurar es una hipótesis');
      expect(pos(r.registro, /^MIGRATE|up -d/u)).toBe(-1);
    });

    it('LA MIGRACIÓN FALLA: no se levanta la imagen nueva y se dice que no hay nada que revertir en la aplicación', () => {
      const e = armar();
      const r = correr(e, ['--commit', e.commit2], { FAKE_MIGRA_EXIT: '1' });
      expect(r.codigo, r.salida).toBe(1);
      expect(r.salida).toContain('las migraciones fallaron');
      expect(r.salida).toContain('Nada que revertir en la aplicación');
      // La parte que antes salía mal: seguía hasta `up -d`.
      expect(pos(r.registro, /up -d/u)).toBe(-1);
      // Y la aplicación en servicio es la misma de antes.
      expect(readFileSync(join(e.base, 'estado', 'app_image'), 'utf8')).toBe('sha256:vieja');
    });

    it('la migración dice que anduvo pero no aplicó todo: se detecta', () => {
      const e = armar();
      const r = correr(e, ['--commit', e.commit2], { FAKE_MIGRA_NO_APLICA: '1' });
      expect(r.codigo, r.salida).toBe(1);
      expect(r.salida).toContain('después de migrar hay 130 de 132 migraciones');
      expect(pos(r.registro, /up -d/u)).toBe(-1);
    });
  });

  describe('después de levantar', () => {
    it('si la sonda no pasa a healthy: sale en rojo y ofrece la reversión', () => {
      const e = armar();
      const r = correr(e, ['--commit', e.commit2], { FAKE_SALUD: 'unhealthy' });
      expect(r.codigo, r.salida).toBe(1);
      expect(r.salida).toContain('sonda: unhealthy');
      expect(r.salida).toContain('bash scripts/desplegar.sh --revertir');
    });
  });

  describe('--revertir', () => {
    it('vuelve la imagen anterior con la versión anterior y no toca la base', () => {
      const e = armar();
      const despliegue = correr(e, ['--commit', e.commit2]);
      expect(despliegue.codigo, despliegue.salida).toBe(0);
      expect(readFileSync(join(e.base, 'estado', 'tag_nexo_production'), 'utf8')).not.toBe('sha256:vieja');

      const r = correr(e, ['--revertir']);
      expect(r.codigo, r.salida).toBe(0);
      expect(readFileSync(join(e.base, 'estado', 'tag_nexo_production'), 'utf8')).toBe('sha256:vieja');
      expect(readFileSync(join(e.base, 'estado', 'app_image'), 'utf8')).toBe('sha256:vieja');
      expect(readFileSync(join(e.base, 'estado', 'app_build_id'), 'utf8')).toBe('b412b9e');
      expect(r.salida).toContain('La base NO se tocó');
      expect(r.salida).toContain('aai-FALSO-predeploy.dump');

      // La reversión no migra, no copia y no construye.
      expect(r.registro.some((l) => /^MIGRATE|^RESPALDAR|^docker build/u.test(l))).toBe(false);
    });

    it('sin un despliegue previo no hay a qué volver', () => {
      const e = armar();
      const r = correr(e, ['--revertir']);
      expect(r.codigo, r.salida).toBe(1);
      expect(r.salida).toContain('no hay a qué volver');
      expect(r.registro.some((l) => /up -d/u.test(l))).toBe(false);
    });

    it('si la imagen anterior ya no existe, se niega', () => {
      const e = armar();
      correr(e, ['--commit', e.commit2]);
      for (const f of readdirSync(join(e.base, 'estado'))) {
        if (f.startsWith('tag_nexo_previo-')) rmSync(join(e.base, 'estado', f));
      }
      const r = correr(e, ['--revertir']);
      expect(r.codigo, r.salida).toBe(1);
      expect(r.salida).toContain('ya no existe en este servidor');
    });
  });
});
