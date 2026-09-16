/**
 * Las tareas agendadas: que existan, que apunten a algo, y que puedan correr.
 *
 * ## Por qué esto se prueba leyendo archivos
 *
 * Un test no puede instalar un timer de systemd —no hay systemd acá, y no lo
 * habría tampoco en CI—. Lo que sí puede, y es donde estuvo el defecto real, es
 * comprobar que **lo que la unidad manda a ejecutar existe**.
 *
 * El caso concreto: `scripts/` no estaba en la imagen de producción. Las tres
 * unidades habrían arrancado su contenedor, Node habría dicho «Cannot find
 * module», y systemd lo habría registrado como fallo cada cinco minutos. En
 * `systemctl list-timers` eso se ve **idéntico** a un timer que anda: tiene su
 * última activación reciente y su próxima programada. La prueba diaria no
 * vencería, la cobranza no avanzaría, y nadie se enteraría hasta contar plata.
 *
 * Así que lo que se afirma acá es la cadena entera de nombres: la unidad nombra
 * un script, el script existe en el repo, y el `Dockerfile` lo copia a la
 * imagen. Cada eslabón roto es un timer verde que no hace nada.
 */

import { existsSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const RAIZ = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const UNIDADES = join(RAIZ, 'infrastructure', 'systemd');

const leer = (archivo: string): string => readFileSync(join(UNIDADES, archivo), 'utf8');

/** Las tres, con el script que cada una manda a correr. */
const TAREAS = [
  { unidad: 'nexo-pagos', script: 'pagos-bandeja.mjs' },
  { unidad: 'nexo-correo', script: 'correo-bandeja.mjs' },
  { unidad: 'nexo-diario', script: 'tareas-diarias.mjs' },
] as const;

describe('tareas agendadas — las unidades de systemd', () => {
  it('cada tarea tiene su servicio y su timer', () => {
    for (const { unidad } of TAREAS) {
      expect(existsSync(join(UNIDADES, `${unidad}.service`)), `${unidad}.service`).toBe(true);
      expect(existsSync(join(UNIDADES, `${unidad}.timer`)), `${unidad}.timer`).toBe(true);
    }
  });

  it('el script que cada unidad ejecuta existe en el repositorio', () => {
    // Un nombre mal escrito acá es un timer que falla cada cinco minutos y que
    // en `list-timers` se ve exactamente igual que uno sano.
    for (const { unidad, script } of TAREAS) {
      const servicio = leer(`${unidad}.service`);
      expect(servicio, unidad).toContain(`node scripts/${script}`);
      expect(existsSync(join(RAIZ, 'scripts', script)), script).toBe(true);
    }
  });

  it('el Dockerfile copia scripts/ a la imagen, en las dos etapas', () => {
    // La etapa de runtime trae con `--from=build`, así que lo que no entró a la
    // etapa de build no existe para ella. Es la dependencia circular que el
    // propio Dockerfile documenta haber cometido una vez con `infrastructure`.
    const dockerfile = readFileSync(join(RAIZ, 'Dockerfile'), 'utf8');
    expect(dockerfile).toMatch(/^COPY scripts \.\/scripts$/mu);
    expect(dockerfile).toMatch(/^COPY --from=build --chown=node:node \/app\/scripts \.\/scripts$/mu);
  });

  it('los tres timers son Persistent: una corrida perdida se recupera', () => {
    // Sin esto, un servidor apagado entre las 03:00 y las 04:00 deja un día sin
    // facturar que nadie nota hasta la conciliación del mes.
    for (const { unidad } of TAREAS) {
      expect(leer(`${unidad}.timer`), unidad).toMatch(/^Persistent=true$/mu);
    }
  });

  it('ninguna unidad deja un proceso residente', () => {
    // `Type=oneshot` y `--rm`: el contenedor corre, termina y se borra. Un
    // worker vivo es un proceso más que puede morirse en silencio, y comprobar
    // que sigue vivo sería otra tarea que también habría que agendar.
    for (const { unidad } of TAREAS) {
      const servicio = leer(`${unidad}.service`);
      expect(servicio, unidad).toMatch(/^Type=oneshot$/mu);
      expect(servicio, unidad).toContain('docker run --rm');
      expect(servicio, unidad).not.toContain('docker run -d');
      expect(servicio, unidad).toMatch(/^Restart=no$/mu);
    }
  });

  it('ninguna unidad lleva credenciales en la línea de comandos', () => {
    // Las variables entran por `--env-file`, que es el mismo archivo que usa
    // docker-compose.prod.yml. Armar la cadena de conexión acá la dejaría, con
    // contraseña incluida, en `argv` de un proceso del host y en el journal.
    for (const { unidad } of TAREAS) {
      const servicio = leer(`${unidad}.service`);
      expect(servicio, unidad).toContain('--env-file /opt/nexo/.env');
      expect(servicio, unidad).not.toMatch(/postgres(ql)?:\/\//u);
      expect(servicio, unidad).not.toMatch(/PGPASSWORD=/u);
    }
  });

  it('las dos tareas frecuentes no arrancan en el mismo minuto', () => {
    // Las dos tocan la misma base cada cinco minutos. Arrancarlas juntas no gana
    // nada y hace que cualquier contención se vea como un problema del código.
    const pagos = /^OnCalendar=(.+)$/mu.exec(leer('nexo-pagos.timer'))?.[1];
    const correo = /^OnCalendar=(.+)$/mu.exec(leer('nexo-correo.timer'))?.[1];
    expect(pagos).toBeDefined();
    expect(correo).toBeDefined();
    expect(pagos).not.toBe(correo);
  });

  it('el estado se puede consultar, y cubre las tres unidades', () => {
    // `systemctl list-timers` contesta cuándo va a correr. Lo que hay que poder
    // preguntar es cuándo corrió bien por última vez, y eso está en otro lado.
    const estado = readFileSync(join(UNIDADES, 'estado-de-tareas.sh'), 'utf8');
    for (const { unidad } of TAREAS) {
      expect(estado, unidad).toContain(unidad);
    }
    expect(estado).toContain('ultimaExitosa');
    expect(estado).toContain('segundosDesdeLaUltima');
    expect(estado).toContain('--json');
  });

  it('el instalador comprueba antes de habilitar', () => {
    // Instalar sin probar deja el descubrimiento del primer fallo para dentro de
    // cinco minutos, cuando quien instaló ya cerró la sesión.
    const instalar = readFileSync(join(UNIDADES, 'instalar.sh'), 'utf8');
    for (const { script } of TAREAS) {
      expect(instalar, script).toContain(script.replace('.mjs', ''));
    }
    expect(instalar).toContain('--auditar');
    expect(instalar).toContain('--quitar');
  });

  it('el instalador exige las DOS variables que las tareas necesitan', () => {
    // `DATABASE_URL` es la obvia. `MFA_ENCRYPTION_KEY` es la que cuesta: las
    // tareas importan `apps/api/dist/config.js`, que con `NODE_ENV=production`
    // la exige al cargarse, antes de tocar la base. Sin ella el contenedor muere
    // con un error que habla de MFA, que no es donde nadie iría a buscar por qué
    // no se emitieron los cargos del día.
    //
    // Son exactamente las dos: son los únicos `required()` de `config.ts`, y
    // este caso se rompe el día que aparezca un tercero.
    const config = readFileSync(join(RAIZ, 'apps', 'api', 'src', 'config.ts'), 'utf8');
    const exigidas = [...config.matchAll(/required\('([A-Z_]+)'\)/gu)].map((m) => m[1]);
    expect(new Set(exigidas)).toEqual(new Set(['DATABASE_URL', 'MFA_ENCRYPTION_KEY']));

    const instalar = readFileSync(join(UNIDADES, 'instalar.sh'), 'utf8');
    for (const variable of exigidas) {
      expect(instalar, variable).toContain(variable);
    }
  });

  it('el instalador prueba corriendo una tarea, no una conexión escrita a mano', () => {
    // Un `pg.connect()` suelto prueba menos de lo que parece: no importa
    // `config.js`, así que una instalación a la que le falte una variable pasa
    // en verde y falla en cada corrida. Correr la tarea en modo `--ver` importa
    // la configuración entera, no escribe nada y no llama a ninguna pasarela.
    const instalar = readFileSync(join(UNIDADES, 'instalar.sh'), 'utf8');
    expect(instalar).toContain('node scripts/pagos-bandeja.mjs --ver');
    expect(instalar).toContain('--env NODE_ENV=production');
  });
});

describe('tareas agendadas — los scripts que ejecutan', () => {
  it('correo:bandeja entrega por omisión y tiene un modo de solo mirar', () => {
    // Un script que por omisión no hace nada, agendado cada cinco minutos, es un
    // timer que corre para nada. Y sin `--ver`, mirar la bandeja mandaría
    // correo, que es justo lo que alguien que solo quiere mirar no quiere.
    const s = readFileSync(join(RAIZ, 'scripts', 'correo-bandeja.mjs'), 'utf8');
    expect(s).toContain("args.includes('--ver')");
    expect(s).toContain('entregarPendientes');
    // Solo lo PENDIENTE: reintentar un rebote sin mirar por qué rebotó es la
    // forma más rápida de que un proveedor marque el dominio como spam.
    expect(s).toContain("estado = 'PENDIENTE'");
  });

  it('los scripts que conectan toleran que no haya .env dentro de la imagen', () => {
    // La imagen no lleva `.env` a propósito —S-43 lo comprueba—, así que
    // `loadEnvFile` tira adentro del contenedor y la variable llega por el
    // entorno (`--env-file`). Sin el `try`, las dos tareas frecuentes morirían
    // en la primera línea, en producción, de noche.
    for (const script of ['pagos-bandeja.mjs', 'correo-bandeja.mjs', 'facturacion-ciclo.mjs']) {
      const s = readFileSync(join(RAIZ, 'scripts', script), 'utf8');
      expect(s, script).toMatch(/try\s*\{[\s\S]{0,160}loadEnvFile[\s\S]{0,120}\}\s*catch/u);
    }
  });

  it('la tarea diaria le pasa su entorno a las que lanza', () => {
    // No conecta: lanza otros scripts. `spawn` hereda `process.env` salvo que se
    // le pase un `env` propio, y pasárselo sin `...process.env` dejaría a los
    // hijos sin `DATABASE_URL` adentro del contenedor.
    const s = readFileSync(join(RAIZ, 'scripts', 'tareas-diarias.mjs'), 'utf8');
    expect(s).toContain('spawn(');
    const opciones = /spawn\([^)]*\{([^}]*)\}/u.exec(s)?.[1] ?? '';
    expect(opciones).not.toContain('env:');
  });
});
