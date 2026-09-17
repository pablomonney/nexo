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

import { spawnSync } from 'node:child_process';
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
    // docker-compose.prod.yml. La cadena de conexión se arma **dentro** del
    // contenedor: armarla en el `ExecStart` dejaría la contraseña en `argv` de
    // un proceso del host y en el journal.
    for (const { unidad } of TAREAS) {
      const exec = execStartDe(unidad);
      expect(exec, unidad).toContain('--env-file /opt/nexo/.env');
      // La contraseña nunca aparece literal ni por nombre con valor.
      expect(exec, unidad).not.toMatch(/PGPASSWORD=\S/u);
      // La cadena que sí aparece es la plantilla, con las variables sin
      // resolver: eso es lo contrario de una credencial en la línea.
      expect(exec, unidad).toContain('postgresql://$${POSTGRES_USER}:$${CLAVE}@');
    }
  });
});

/**
 * El `ExecStart` de una unidad, con las continuaciones pegadas como las pega
 * systemd: barra al final de línea, y el espacio de la siguiente se descarta.
 */
function execStartDe(unidad: string): string {
  const texto = leer(`${unidad}.service`).replace(/\\\r?\n\s*/gu, ' ');
  const linea = /^ExecStart=(.+)$/mu.exec(texto);
  if (linea === null) throw new Error(`${unidad}.service no tiene ExecStart`);
  return linea[1]!;
}

/**
 * Lo que systemd le entrega a la shell.
 *
 * systemd expande `$VAR` y `${VAR}` contra el entorno de la **unidad** —que
 * acá no tiene ninguna— y traduce `$$` a un dólar literal. Esto es esa
 * traducción, y sirve para ver qué llega del otro lado.
 */
function comoLoVeLaShell(exec: string): string {
  // Un solo pase y un reemplazo por función: con dos pases hace falta un
  // centinela para no volver a tocar lo ya traducido, y un centinela dentro de
  // un literal es la clase de carácter que termina escrito de verdad en el
  // archivo. Pasó acá.
  return exec.replace(/\$\$|\$\{?\w+\}?/gu, (m) => (m === '$$' ? '$' : ''));
}

describe('tareas agendadas — la credencial operatoria', () => {
  /**
   * El guion que arma la cadena de conexión, tal como está en las unidades.
   *
   * Las tareas son **del operador**: escriben en `payment_intents`, en
   * `payment_events` y en `email_outbox`, y el rol de la aplicación no puede
   * ninguna de las tres. Eso no es una configuración a corregir: es el candado
   * que impide que el administrador de una empresa cliente se marque un cargo
   * como pagado.
   *
   * El `DATABASE_URL` del `--env-file` es el de la aplicación, así que la
   * unidad arma otro adentro del contenedor. Medido el 2026-09-16 en el ensayo
   * aislado, con el de la aplicación: `permission denied` en las tres tareas.
   */
  const GUION =
    'CLAVE=$$(node -e "process.stdout.write(encodeURIComponent(process.env.POSTGRES_PASSWORD))"); ' +
    'export DATABASE_URL="postgresql://$${POSTGRES_USER}:$${CLAVE}@nexo-postgres:5432/$${POSTGRES_DB}";';

  it('las tres unidades arman la cadena igual, carácter por carácter', () => {
    // Tres copias de la misma línea son tres oportunidades de que una quede
    // distinta, y la que quede distinta va a fallar sola, cada cinco minutos.
    for (const { unidad } of TAREAS) {
      expect(execStartDe(unidad), unidad).toContain(GUION);
    }
  });

  it('el instalador prueba con el MISMO guion, sin los dólares dobles', () => {
    // La cuarta copia. En `instalar.sh` no hay systemd en el medio, así que los
    // dólares van sueltos; salvo por eso tiene que decir lo mismo. Sin esta
    // comprobación, el instalador podría seguir probando con una credencial que
    // los timers ya no usan, y dar verde sobre algo que falla.
    const instalar = readFileSync(join(UNIDADES, 'instalar.sh'), 'utf8');
    expect(instalar).toContain(GUION.replaceAll('$$', '$'));
  });

  it('todos los dólares van dobles: ninguno se lo come systemd', () => {
    // systemd expande `$VAR` y `${VAR}` contra el entorno de la unidad, que no
    // tiene ninguna de estas variables: un dólar suelto llega vacío a la shell
    // y la cadena queda `postgresql://:@nexo-postgres:5432/`.
    //
    // Es el defecto que este archivo tuvo y que no se ve leyendo: un `replace`
    // con cadena de reemplazo interpreta `$$` como escape y lo colapsa a `$`.
    for (const { unidad } of TAREAS) {
      const exec = execStartDe(unidad);
      for (const corrida of exec.match(/\$+/gu) ?? []) {
        expect(corrida.length % 2, `${unidad}: ${corrida.length} dólares seguidos`).toBe(0);
      }
      // Y el control por el otro lado: después de la traducción de systemd, las
      // tres variables siguen ahí para que las resuelva la shell.
      const paraLaShell = comoLoVeLaShell(exec);
      for (const v of ['${POSTGRES_USER}', '${POSTGRES_DB}', '${CLAVE}']) {
        expect(paraLaShell, `${unidad} pierde ${v}`).toContain(v);
      }
      expect(paraLaShell).toContain('$(node -e ');
    }
  });

  it('la contraseña se codifica, y una con / o + no rompe la URL', () => {
    // El defecto del 2026-09-15, que dejó producción abajo: la contraseña de
    // esta instalación es base64 de 48 caracteres y contiene `/` y `+`. Pegada
    // cruda produce `postgresql://usuario:cla/ve@host:5432/base`, donde la
    // barra corta el `userinfo` y `pg-connection-string` contesta
    // `ERR_INVALID_URL` sin poder decir por qué: el input viene redactado,
    // justamente porque lleva la credencial.
    //
    // La expresión que se ejercita **se saca del archivo de la unidad**, no se
    // escribe acá: probar una copia no prueba lo que corre.
    const exec = execStartDe('nexo-pagos');
    const expresion = /node -e "([^"]+)"/u.exec(exec)?.[1];
    expect(expresion).toBe(
      'process.stdout.write(encodeURIComponent(process.env.POSTGRES_PASSWORD))',
    );

    const CLAVES = [
      'aB3/xY+z9Q==',           // base64 con los dos caracteres que rompieron
      'a/b+c=d',                 // los tres de una vez
      '@:/?#[]!$&()*+,;=',       // todo lo que una URL trata como sintaxis
      'K7+8/vNqR2sT4uW1xY0zA3bC5dE6fG9hJ0kL2mN4oP=', // largo, como la real
      'sin-nada-raro',
    ];

    for (const clave of CLAVES) {
      // Lo que hace el `node -e` de la unidad.
      const codificada = encodeURIComponent(clave);
      // Lo que hace la shell con la plantilla, con valores de ejemplo.
      const cadena = `postgresql://nexo_admin:${codificada}@nexo-postgres:5432/aai`;

      const url = new URL(cadena);
      expect(url.protocol, clave).toBe('postgresql:');
      expect(url.hostname, clave).toBe('nexo-postgres');
      expect(url.port, clave).toBe('5432');
      expect(url.pathname, clave).toBe('/aai');
      expect(url.username, clave).toBe('nexo_admin');
      // Lo único que importa de verdad: la contraseña vuelve entera.
      expect(decodeURIComponent(url.password), clave).toBe(clave);
    }
  });

  it('sin codificar, la misma contraseña rompe la URL: el control no es decorativo', () => {
    // La contracara del caso anterior. Si esto empezara a pasar, significaría
    // que `/` dejó de cortar el `userinfo` y que `encodeURIComponent` ya no hace
    // falta — que no va a pasar, y por eso el caso vale como documentación.
    const cruda = 'postgresql://nexo_admin:aB3/xY+z9Q==@nexo-postgres:5432/aai';
    // Ni siquiera llega a parsear con otro host: la barra corta el `userinfo` y
    // lo que queda no es una URL. Del otro lado, `pg-connection-string` no puede
    // decir qué estaba mal, porque el input viene redactado — justamente porque
    // lleva la credencial.
    expect(() => new URL(cruda)).toThrow(/Invalid URL/u);
  });

  it('el instalador comprueba que el rol de la aplicación SIGA sin poder', () => {
    // Que la tarea ande con la credencial operatoria es la mitad. La otra es que
    // la de la aplicación siga sin poder: si esa empezara a andar, el candado
    // que impide que una empresa cliente se marque un cargo como pagado ya no
    // estaría, y nada más lo notaría.
    const instalar = readFileSync(join(UNIDADES, 'instalar.sh'), 'utf8');
    expect(instalar).toContain('sigue sin poder leer email_outbox');
    expect(instalar).toContain('se le ampliaron privilegios');
  });

  it('nadie le otorga permisos a aai_app para que esto funcione', () => {
    // El arreglo correcto era cambiar con qué credencial conecta la tarea, no
    // ampliarle los privilegios al rol de la aplicación. Ninguna migración
    // nueva puede tener un GRANT a `aai_app` sobre las tablas del operador.
    const migraciones = ['0124_deber_no_es_lo_mismo_que_estar_cortado.sql',
      '0125_que_sobrevive_a_la_mora.sql',
      '0126_un_aviso_no_alcanza_y_la_mora_tiene_dia.sql'];
    for (const m of migraciones) {
      const sql = readFileSync(join(RAIZ, 'infrastructure', 'db', 'migrations', m), 'utf8');
      const sinComentarios = sql.replace(/^\s*--.*$/gmu, '');
      for (const tabla of ['email_outbox', 'payment_webhook_inbox', 'payment_events',
        'payment_intents', 'billing_documents', 'collection_steps']) {
        expect(sinComentarios, `${m} otorga sobre ${tabla}`).not.toMatch(
          new RegExp(`GRANT[^;]+${tabla}[^;]+aai_app`, 'isu'),
        );
      }
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

/**
 * Los dos modos de los verificadores, y por qué la distinción importa.
 *
 *     CONDUCTUAL     arma una base de verificación aparte, la siembra con
 *                    fixtures propios —incluida una cadena de bitácora rota a
 *                    propósito— y comprueba que el verificador la detecte.
 *                    Prueba **el verificador**. Es el modo del gate de CI.
 *     OBSERVACIONAL  mira la base que le pasaron, tal como está. Prueba **los
 *                    libros de esta instalación**.
 *
 * La tarea diaria de producción corría en conductual, que es el modo
 * equivocado por dos razones independientes: verificaría fixtures inventados en
 * vez de los libros de la empresa, y no puede hacerlo —siembra con
 * `seed-norms.mjs`, que lee `docs/normative-sources/`, y `docs` está excluido
 * de la imagen por `.dockerignore`—. Fallaba todos los días después de haber
 * hecho bien el ciclo de facturación.
 */
describe('tareas agendadas — modo de verificación', () => {
  const leerScript = (nombre: string): string =>
    readFileSync(join(RAIZ, 'scripts', nombre), 'utf8');

  const VERIFICADORES = ['verify-ledger.mjs', 'verify-audit-chain.mjs'] as const;

  it('el gate de CI sigue corriendo en modo conductual', () => {
    // Lo primero que hay que no romper. `npm run verify` usa estos dos para
    // comprobar que el verificador detecta una adulteración: sin fixtures
    // malos, verificar un libro sano no prueba que el control funcione.
    const pkg = JSON.parse(readFileSync(join(RAIZ, 'package.json'), 'utf8')) as {
      scripts: Record<string, string>;
    };
    expect(pkg.scripts['ledger:verify']).toBe('node scripts/verify-ledger.mjs');
    expect(pkg.scripts['audit:cadena']).toBe('node scripts/verify-audit-chain.mjs');
    for (const s of Object.values(pkg.scripts)) {
      expect(s, s).not.toContain('--observacional');
    }
  });

  it('la tarea diaria pide observacional explícitamente, en sus dos modos', () => {
    const diarias = leerScript('tareas-diarias.mjs');
    for (const verificador of VERIFICADORES) {
      // Dos veces cada uno: en `comando` y en `ensayo`. Si el ensayo corriera
      // en otro modo que la corrida real, probaría otra cosa que la que corre.
      const apariciones = [...diarias.matchAll(new RegExp(`'${verificador}'\\), OBSERVACIONAL`, 'gu'))];
      expect(apariciones, verificador).toHaveLength(2);
    }
    expect(diarias).toContain("const OBSERVACIONAL = '--observacional'");
  });

  it('lo que necesita docs/ está detrás del modo conductual, y se importa dinámicamente', () => {
    // La propiedad estructural que hace que la tarea diaria NO dependa de
    // `docs/`: `verification-db.mjs` —que es quien llama a `seed-norms.mjs`—
    // solo se carga dentro del `if (conductual)`, y con `await import`. Un
    // `import` estático arriba del archivo lo traería siempre, y el módulo se
    // evaluaría aunque la rama no corra.
    for (const verificador of VERIFICADORES) {
      const fuente = leerScript(verificador);

      expect(fuente, verificador).not.toMatch(/^import .*verification-db/mu);
      expect(fuente, verificador).not.toMatch(/^import .*fixtures-invariantes/mu);

      const rama = /if \(conductual\) \{([\s\S]*?)\n\} else/u.exec(fuente)?.[1];
      expect(rama, `${verificador}: no encontré la rama conductual`).toBeDefined();
      expect(rama!).toContain("await import('./verification-db.mjs')");
    }
  });

  it('ningún script de la cadena diaria LEE nada de docs/', () => {
    // El control por el otro lado: que no aparezca una dependencia nueva de
    // `docs/` por otro camino. `docs` no está en la imagen y no va a estarlo.
    //
    // Lo que se busca es una **lectura**, no una mención: `tareas-diarias.mjs`
    // nombra `docs/DESPLIEGUE.md §4` en el texto que imprime al final, y eso es
    // una referencia para quien lo lee, no un archivo que abra. Prohibir la
    // palabra convertiría este caso en uno que hay que desactivar.
    const cadena = ['tareas-diarias.mjs', 'facturacion-ciclo.mjs', ...VERIFICADORES];
    const LECTURAS = /(readFile|readFileSync|createReadStream|existsSync|open|join)\s*\([^)]*docs/isu;
    for (const nombre of cadena) {
      expect(leerScript(nombre), nombre).not.toMatch(LECTURAS);
    }
  });

  // Los casos que siguen **ejecutan** los verificadores. Sin base se saltean, y
  // no se inventa un resultado: es la misma regla que los propios verificadores
  // aplican con sus datos.
  /**
   * Un CUIT con formato válido que no le pertenece a nadie.
   *
   * Es la forma barata de llegar al caso «no hay ni una empresa» sin montar
   * una base vacía, y de paso acota los dos casos que ejecutan a una consulta
   * que no devuelve filas.
   */
  const CUIT_INEXISTENTE = '99999999999';

  const conBase = (process.env.DATABASE_URL ?? '') === '' ? it.skip : it;

  const correrVerificador = (nombre: string, args: readonly string[]) =>
    spawnSync(process.execPath, [join(RAIZ, 'scripts', nombre), ...args], {
      cwd: RAIZ,
      encoding: 'utf8',
      env: process.env,
      timeout: 120_000,
    });

  conBase(
    'sin nada que verificar, el observacional dice NO EJERCITADO y NO afirma que esté bien',
    () => {
      // El requisito que más importa de los tres: que la ausencia de datos no se
      // convierta en un chequeo verde. Se usa un CUIT que no existe, que es la
      // forma barata de llegar al caso «no hay ni una empresa» sin montar una
      // base vacía.
      //
      // Sale con 0 —en observacional el comando es una pregunta, no una
      // promesa— y el texto dice las dos cosas: que no se ejercitó, y que no se
      // está afirmando nada. Un `exit 0` mudo sería exactamente la mentira.
      for (const [nombre, frase] of [
        ['verify-ledger.mjs', 'No se afirma que el Mayor coincida'],
        ['verify-audit-chain.mjs', 'No se afirma que la bitácora esté íntegra'],
      ] as const) {
        const r = correrVerificador(nombre, ['--observacional', CUIT_INEXISTENTE]);
        const salida = `${r.stdout}${r.stderr}`;
        expect(r.status, `${nombre}: ${salida}`).toBe(0);
        expect(salida, nombre).toContain('NO EJERCITADO');
        expect(salida, nombre).toContain(frase);
        // Y no dice ninguna de las frases que afirman.
        expect(salida, nombre).not.toContain('sin discrepancias');
        expect(salida, nombre).not.toContain('sin adulteraciones');
      }
    },
    180_000,
  );

  conBase(
    'el observacional corre de punta a punta sin pasar por docs/',
    () => {
      // La independencia de `docs/` se decide **antes** de mirar un solo dato:
      // la rama conductual —la que siembra normas— corre arriba de todo, y si
      // el proceso llega a imprimir «Modo OBSERVACIONAL» es porque no pasó por
      // ahí. Eso es todo lo que hay que demostrar.
      //
      // Por eso va acotado a un CUIT que no existe, y no a la base entera.
      // La primera versión barría las **9.352 empresas** que arrastra
      // `aai_test` y tardaba 54 segundos medidos; bajo cobertura, con 177
      // archivos en paralelo, pasaba los 120 del timeout y el caso fallaba por
      // el reloj, no por el sistema. Subir el timeout habría escondido que el
      // test estaba pidiendo algo que no necesitaba.
      for (const nombre of VERIFICADORES) {
        const r = correrVerificador(nombre, ['--observacional', CUIT_INEXISTENTE]);
        const salida = `${r.stdout}${r.stderr}`;
        expect(salida, nombre).toContain('Modo OBSERVACIONAL');
        // La rama que necesita `docs/` no dejó ni un rastro.
        expect(salida, nombre).not.toContain('CONDUCTUAL');
        expect(salida, nombre).not.toContain('fixtures conductuales');
        expect(salida, nombre).not.toContain('registro-de-descargas');
        expect(salida, nombre).not.toContain('ENOENT');
      }
    },
    60_000,
  );

  it('el modo conductual se sigue ejercitando, y lo hace el propio `verify`', () => {
    // La demostración de que el conductual sigue vivo **no** es correrlo otra
    // vez desde acá: es que `npm run verify` lo corre en cada pasada, con la
    // base de verificación aislada y los fixtures rotos a propósito.
    //
    // Duplicarlo en este archivo lo haría correr dos veces por suite —arma una
    // base entera cada vez— y no probaría nada que la compuerta no pruebe ya.
    // Lo que sí hay que cuidar es que siga encadenado, que es lo que se rompe
    // en silencio el día que alguien edite el script de `verify`.
    const pkg = JSON.parse(readFileSync(join(RAIZ, 'package.json'), 'utf8')) as {
      scripts: Record<string, string>;
    };
    expect(pkg.scripts['verify']).toContain('ledger:verify');
    expect(pkg.scripts['verify']).toContain('audit:cadena');
  });
});

/**
 * El lector de estado, que también tuvo un defecto de formato.
 *
 * `systemctl show --value` de `NextElapseUSecRealtime` devuelve, en systemd
 * 255, `Wed 2026-09-16 03:25:13 UTC` — texto, pese a que el nombre de la
 * propiedad promete microsegundos. El script hacía aritmética sobre eso y el
 * campo salía vacío, con un `unbound variable` en el medio.
 */
describe('tareas agendadas — el lector de estado', () => {
  const estado = (): string => readFileSync(join(UNIDADES, 'estado-de-tareas.sh'), 'utf8');

  it('no supone el formato: acepta microsegundos y fecha legible', () => {
    const s = estado();
    expect(s).toContain('microsegundos_de()');
    // La rama numérica y la de texto, las dos presentes.
    expect(s).toMatch(/\[\[ "\$valor" =~ \^\[0-9\]\+\$ \]\]/u);
    expect(s).toContain('date -d "$valor" +%s');
    // Y el caso «nunca», que no es una fecha de 1970.
    expect(s).toContain('|| "$valor" == "0"');
  });

  it('la próxima corrida sale de list-timers, que sí devuelve un número', () => {
    const s = estado();
    expect(s).toContain("systemctl list-timers 'nexo-*' --all --output=json");
    // Con respaldo, por si la versión de systemd no soporta la bandera.
    expect(s).toContain('NextElapseUSecRealtime');
    // Y sin invocar `jq`, que no tiene por qué estar en el servidor. Se busca
    // una llamada, no la palabra: el propio script explica en un comentario por
    // qué no lo usa, y prohibir la palabra rompería este caso con la
    // explicación.
    const codigo = s.replace(/^\s*#.*$/gmu, '');
    expect(codigo).not.toMatch(/(^|[|;&(\s])jq[\s|]/mu);
  });

  it('las dos salidas traen los seis datos', () => {
    const s = estado();
    for (const campo of ['última corrida', 'última exitosa', 'último resultado', 'próxima']) {
      expect(s, campo).toContain(campo);
    }
    for (const clave of [
      'ultimaCorrida',
      'segundosDesdeLaUltima',
      'ultimaExitosa',
      'segundosDesdeLaUltimaExitosa',
      'resultado',
      'proxima',
      'segundosParaLaProxima',
    ]) {
      expect(s, clave).toContain(`"${clave}"`);
    }
  });
});
