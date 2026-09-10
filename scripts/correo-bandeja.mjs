#!/usr/bin/env node
/**
 * La bandeja de salida: qué correo se encoló y qué pasó con cada mensaje.
 *
 *   npm run correo:bandeja                 # lo que no salió
 *   npm run correo:bandeja -- --todos      # también lo enviado
 *   npm run correo:bandeja -- --cuerpo     # con el cuerpo, que puede traer tokens
 *
 * ## Por qué esto es un script y no una pantalla
 *
 * El cuerpo de un mensaje de verificación **contiene el token de activación**.
 * Una pantalla que mostrara la bandeja sería una forma de activar la cuenta de
 * cualquiera sin pasar por el correo, así que `aai_app` —el rol con el que corre
 * la aplicación— tiene `INSERT` sobre `email_outbox` y **no tiene `SELECT`**.
 *
 * No es disciplina: es un privilegio que no está. Este script conecta como
 * operador de la instalación, que es otra cosa.
 *
 * ## Lo que hay que entender antes de usarlo
 *
 * **Depende de `EMAIL_PROVIDER`, y los dos casos se leen distinto.**
 *
 *     none      no hay proveedor. Todo lo encolado queda en `SIN_PROVEEDOR`:
 *               no salió, no va a salir solo, y quien se registró está
 *               esperando. Completar un alta es un trabajo manual del operador
 *               — y decirlo así es preferible a un sistema que parece mandar
 *               correos y no manda ninguno.
 *     resend    hay proveedor (B2.5.1). Lo que aparezca acá con `FALLIDO` es lo
 *               que **se intentó mandar y rebotó**, con su motivo y su cuenta
 *               de intentos. Eso ya no lo arregla el operador entregando el
 *               mensaje a mano: hay que mirar el motivo.
 *
 * `SIN_PROVEEDOR` y `FALLIDO` no son sinónimos y esta pantalla es donde más
 * importa: el primero dice que falta contratar algo, el segundo que el mensaje
 * o la dirección tienen un problema.
 *
 * Por eso el cuerpo **no se muestra salvo que se lo pida**: leerlo es leer un
 * token de otra persona, y conviene que ese acto sea deliberado.
 */

import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import pg from 'pg';

const RAIZ = resolve(join(dirname(fileURLToPath(import.meta.url)), '..'));
try {
  process.loadEnvFile(join(RAIZ, '.env'));
} catch {
  /* en CI las variables vienen del entorno */
}

const args = process.argv.slice(2);
const todos = args.includes('--todos');
const conCuerpo = args.includes('--cuerpo');

const cliente = new pg.Client({ connectionString: process.env.DATABASE_URL });
await cliente.connect();

try {
  const { rows } = await cliente.query(
    `SELECT id, destinatario, asunto, tipo, estado, detalle, creado_el, enviado_el,
            ${conCuerpo ? 'cuerpo' : "'(no se pidió)'::text AS cuerpo"}
       FROM email_outbox
      WHERE $1::bool OR estado IN ('PENDIENTE', 'SIN_PROVEEDOR', 'FALLIDO')
      ORDER BY creado_el DESC
      LIMIT 200`,
    [todos],
  );

  const resumen = await cliente.query(
    'SELECT estado, count(*)::text AS n FROM email_outbox GROUP BY estado ORDER BY estado',
  );

  console.log('\n══ Bandeja de salida ════════════════════════════════════════\n');

  if (resumen.rows.length === 0) {
    console.log('  Todavía no se encoló ningún mensaje.\n');
  } else {
    for (const r of resumen.rows) console.log(`  ${r.estado.padEnd(16)} ${r.n}`);
    console.log('');
  }

  if (rows.length === 0) {
    console.log('  Nada pendiente.\n');
  } else {
    for (const m of rows) {
      console.log(`  ${m.creado_el.toISOString().slice(0, 19)}  ${m.estado}`);
      console.log(`    para   ${m.destinatario}`);
      console.log(`    asunto ${m.asunto}   [${m.tipo}]`);
      if (m.detalle) console.log(`    ${m.detalle}`);
      if (conCuerpo) {
        console.log('    ── cuerpo ──');
        for (const linea of String(m.cuerpo).split('\n')) console.log(`    ${linea}`);
      }
      console.log('');
    }
    if (!conCuerpo) {
      console.log('  El cuerpo no se muestra: puede contener un token de activación de otra');
      console.log('  persona. Para verlo: npm run correo:bandeja -- --cuerpo\n');
    }
  }

  const sinProveedor = resumen.rows.find((r) => r.estado === 'SIN_PROVEEDOR');
  if (sinProveedor !== undefined && Number(sinProveedor.n) > 0) {
    // Se habla en pasado a propósito: la fila dice que **cuando se encoló** no
    // había proveedor. Si desde entonces se configuró uno, decir «no hay
    // proveedor en esta instalación» sería falso, y mandaría a revisar una
    // configuración que ya está bien en vez de a reenviar esos mensajes.
    console.log('  ⚠ Estos mensajes se encolaron SIN proveedor de correo configurado.');
    console.log('    NO salieron y no van a salir solos, ni siquiera si ahora hay proveedor:');
    console.log('    nada los reintenta. Quien se registró sigue esperando.\n');
  }
} catch (error) {
  console.error(`No se pudo leer la bandeja: ${error.message}`);
  process.exitCode = 1;
} finally {
  await cliente.end();
}
