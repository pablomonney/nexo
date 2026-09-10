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
 * **No manda avisos.** No hay proveedor de correo. El ciclo lo informa como
 * omitido, con ese motivo.
 */

import { spawn } from 'node:child_process';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const RAIZ = resolve(join(dirname(fileURLToPath(import.meta.url)), '..'));
const ENSAYO = process.argv.includes('--ensayo');

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
    porque: 'recalcula el Mayor contra los movimientos y avisa si dejó de cuadrar.',
    comando: ['node', [join(RAIZ, 'scripts', 'verify-ledger.mjs')]],
    // De solo lectura: en un ensayo corre igual, porque no escribe nada.
    ensayo: ['node', [join(RAIZ, 'scripts', 'verify-ledger.mjs')]],
  },
  {
    nombre: 'cadena de auditoría',
    porque: 'comprueba que ninguna entrada de la bitácora fue alterada.',
    comando: ['node', [join(RAIZ, 'scripts', 'verify-audit-chain.mjs')]],
    ensayo: ['node', [join(RAIZ, 'scripts', 'verify-audit-chain.mjs')]],
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
