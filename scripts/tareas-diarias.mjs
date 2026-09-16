#!/usr/bin/env node
/**
 * Lo que hay que correr todos los días, en un solo comando.
 *
 *   npm run diario              # lo corre
 *   npm run diario -- --ensayo  # dice qué haría, sin escribir nada
 *
 * ## Por qué existe
 *
 * La auditoría B-2 preguntó una cosa muy concreta: **¿puede una empresa
 * cliente trabajar sin que el equipo fundador toque nada?** La respuesta fue
 * que no, y no por un defecto del código sino por una omisión de forma: las
 * tareas periódicas existían, cada una andaba, y **ninguna estaba agendada**.
 *
 * El caso que lo vuelve grave: la prueba de catorce días **solo termina si
 * alguien corre el ciclo de facturación**. `vencerPruebas` se llama desde
 * `correrCiclo` y desde ningún otro lado; `correrCiclo` se llama desde
 * `facturacion-ciclo.mjs` y desde ningún otro lado. Si nadie lo corre, la
 * prueba no vence, la suscripción nunca pasa a SUSPENDIDA y el producto es
 * gratis por tiempo indefinido — sin que ninguna pantalla lo diga, porque desde
 * adentro todo está funcionando bien.
 *
 * Este script no elige un agendador. Elegir cron, un timer de systemd o el
 * programador del proveedor es una decisión del despliegue y sigue sin tomarse
 * (docs/DESPLIEGUE.md §4). Lo que hace es que **lo que haya que agendar sea una
 * sola línea**, para que la decisión pendiente sea «dónde» y no también «qué».
 *
 * ## Por qué se puede correr dos veces
 *
 * Cada paso ya era idempotente por su cuenta y eso no es casualidad: es la
 * condición para poder agendar algo sin miedo. Un período ya facturado se
 * informa omitido en vez de duplicarse; vencer una prueba ya vencida no escribe
 * nada; los verificadores son de solo lectura. Correr esto dos veces el mismo
 * día no produce un cargo de más.
 *
 * ## Por qué un paso que falla no corta los demás
 *
 * Son tareas independientes y el orden es de conveniencia, no de dependencia.
 * Si la verificación del libro encuentra algo, eso **no** es motivo para no
 * haber facturado; si la facturación falla, eso no es motivo para no verificar.
 * Cortar en el primer error dejaría sin correr tareas que no tenían nada que
 * ver, y —peor— escondería el resto de los problemas atrás del primero.
 *
 * El código de salida es 1 si algo falló, y el resumen final dice qué.
 *
 * ## Lo que NO hace, y por qué
 *
 * **No saca la copia de resguardo.** `npm run db:backup` existe y funciona,
 * pero cada cuánto correrlo, cuánto retener y dónde guardarlo tienen atrás una
 * obligación legal de conservación y un costo. Meterlo acá con una frecuencia
 * inventada por este script sería tomar esa decisión sin decirlo. Se agenda
 * aparte, a sabiendas.
 *
 * **No manda avisos.** Los encola. La entrega la hace `correo:bandeja`, que
 * tiene su propio timer: un aviso que sale desde adentro de la transacción del
 * ciclo es un correo que no se puede deshacer si el ciclo se revierte.
 *
 * **No verifica el verificador.** Eso lo hace el modo conductual, que corre en
 * CI. Acá se verifican los libros de esta instalación. Ver `OBSERVACIONAL`.
 */

import { spawn } from 'node:child_process';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const RAIZ = resolve(join(dirname(fileURLToPath(import.meta.url)), '..'));
const ENSAYO = process.argv.includes('--ensayo');

/**
 * Los dos verificadores corren en modo **observacional**, y la diferencia no es
 * cosmética.
 *
 *     CONDUCTUAL     arma una base de verificación aparte, la siembra con
 *                    fixtures propios —incluida una cadena rota a propósito— y
 *                    comprueba que el verificador la detecte. Prueba **el
 *                    verificador**. Es el modo de `npm run verify`, o sea del
 *                    gate de CI, y ahí es el correcto.
 *     OBSERVACIONAL  mira la base que le pasaron, tal como está. Prueba **los
 *                    libros de esta instalación**, que es lo que a las 03:15 de
 *                    la mañana hay que saber.
 *
 * Correr el conductual en producción verificaría unos fixtures inventados y no
 * miraría ni una fila de la empresa. Además no puede: siembra con
 * `seed-norms.mjs`, que lee `docs/normative-sources/`, y `docs` está excluido
 * de la imagen por `.dockerignore`. La tarea diaria fallaba ahí, después de
 * haber hecho bien lo único que importaba —el ciclo de facturación—.
 *
 * ## Sin datos, ninguno de los dos miente
 *
 * En observacional, una instalación sin asientos aprobados contesta
 * `NO EJERCITADO` con todas las letras —«no se afirma que el Mayor coincida»— y
 * sale con 0. No es lo mismo que «coincide», y la diferencia está escrita en la
 * salida para que nadie la lea al revés.
 *
 * En conductual ese mismo caso sale con 1, y también está bien: ahí el fixture
 * prometió producir asientos y no lo hizo, así que el roto es el fixture.
 */
const OBSERVACIONAL = '--observacional';

/**
 * Las tareas, en orden.
 *
 * `ensayo` dice cómo se le pide a cada una que no escriba. Una tarea sin modo
 * de ensayo **no corre** en un ensayo: inventarle uno sería correrla de verdad
 * en la corrida que se pidió que no tocara nada.
 */
const TAREAS = [
  {
    nombre: 'facturación y cobranza',
    porque:
      'emite los cargos del período, vence las pruebas cumplidas y avanza la política de ' +
      'cobranza. Es el único que hace terminar una prueba de catorce días.',
    comando: ['node', [join(RAIZ, 'scripts', 'facturacion-ciclo.mjs')]],
    ensayo: ['node', [join(RAIZ, 'scripts', 'facturacion-ciclo.mjs'), '--ensayo']],
  },
  {
    nombre: 'verificación del libro',
    porque:
      'recalcula el Mayor contra los movimientos REALES de esta instalación y avisa si ' +
      'dejó de cuadrar.',
    comando: ['node', [join(RAIZ, 'scripts', 'verify-ledger.mjs'), OBSERVACIONAL]],
    // De solo lectura: en un ensayo corre igual, porque no escribe nada.
    ensayo: ['node', [join(RAIZ, 'scripts', 'verify-ledger.mjs'), OBSERVACIONAL]],
  },
  {
    nombre: 'cadena de auditoría',
    porque: 'comprueba que ninguna entrada de la bitácora de esta instalación fue alterada.',
    comando: ['node', [join(RAIZ, 'scripts', 'verify-audit-chain.mjs'), OBSERVACIONAL]],
    ensayo: ['node', [join(RAIZ, 'scripts', 'verify-audit-chain.mjs'), OBSERVACIONAL]],
  },
];

/** Corre un comando y devuelve su código de salida, dejando salir su texto. */
function correr(exe, args) {
  return new Promise((listo) => {
    const hijo = spawn(exe, args, { cwd: RAIZ, stdio: 'inherit', shell: false });
    hijo.on('close', (codigo) => listo(codigo ?? 1));
    hijo.on('error', () => listo(1));
  });
}

console.log(
  ENSAYO
    ? '\nTareas diarias — ENSAYO: nada de lo que escribe se va a escribir.\n'
    : '\nTareas diarias de NEXO.\n',
);

const resultados = [];
for (const tarea of TAREAS) {
  const par = ENSAYO ? tarea.ensayo : tarea.comando;
  console.log(`\n── ${tarea.nombre} ${'─'.repeat(Math.max(0, 60 - tarea.nombre.length))}`);
  console.log(`   ${tarea.porque}\n`);

  if (par === undefined) {
    console.log('   OMITIDA: no tiene modo de ensayo, y correrla sería escribir.');
    resultados.push({ nombre: tarea.nombre, estado: 'OMITIDA' });
    continue;
  }

  const codigo = await correr(par[0], par[1]);
  resultados.push({ nombre: tarea.nombre, estado: codigo === 0 ? 'OK' : `FALLÓ (${codigo})` });
}

console.log('\n── resumen ───────────────────────────────────────────────────\n');
for (const r of resultados) console.log(`   ${r.estado.padEnd(12)} ${r.nombre}`);

const fallaron = resultados.filter((r) => r.estado.startsWith('FALLÓ'));
if (fallaron.length > 0) {
  // El resumen se imprime igual y después se sale con error: quien agende esto
  // va a leer el correo del cron, y ahí tiene que estar qué anduvo y qué no.
  console.error(`\n${fallaron.length} tarea(s) fallaron. El detalle está arriba, en su sección.`);
  process.exitCode = 1;
} else {
  console.log('\nTodo corrió.');
}

console.log(
  '\nLa copia de resguardo se agenda aparte —`npm run db:backup`—: cada cuánto y cuánto ' +
    'retener tienen atrás una obligación legal de conservación. Ver docs/DESPLIEGUE.md §4.\n',
);
