#!/usr/bin/env node
/**
 * La bandeja de salida: entrega lo pendiente y dice qué pasó con cada mensaje.
 *
 *   npm run correo:bandeja                 # entrega lo PENDIENTE y muestra la bandeja
 *   npm run correo:bandeja -- --ver        # solo mira, no manda nada
 *   npm run correo:bandeja -- --todos      # también lista lo ya enviado
 *   npm run correo:bandeja -- --cuerpo     # con el cuerpo, que puede traer tokens
 *
 * ## Entregar es nuevo, y el modo de solo mirar sigue estando
 *
 * Hasta B2.5.x esto solo leía. Alcanzaba, porque lo único que se encolaba salía
 * en el mismo momento en que se escribía la fila: `encolar` manda primero y
 * registra después, así que nunca había nada `PENDIENTE` esperando a alguien.
 *
 * La cobranza rompió ese supuesto a propósito. Sus avisos se escriben con
 * `encolarSinEnviar` —adentro de la misma transacción que degrada o suspende una
 * suscripción— y quedan en `PENDIENTE` sin haberse intentado nunca. El motivo
 * está entero en `correo/puerto.ts`, y el que decide es este: si la transacción
 * se revierte después de que el proveedor aceptó el mensaje, el cliente ya
 * recibió un correo sobre algo que no pasó, y eso no se deshace.
 *
 * Alguien tiene que drenar esa cola, y es esto. Por eso entregar pasó a ser el
 * comportamiento por omisión —igual que en `pagos-bandeja.mjs`, que aplica por
 * omisión y tiene `--ver`—: un script que por omisión no hace nada, agendado
 * cada cinco minutos, es un timer que corre para nada.
 *
 * **`--ver` no manda nada.** Es el modo para mirar sin efectos.
 *
 * ## Qué se entrega y qué no
 *
 * Solo lo `PENDIENTE`. `SIN_PROVEEDOR` y `FALLIDO` se listan y **no se
 * reintentan**: reintentar un rebote sin mirar por qué rebotó es la forma más
 * rápida de que un proveedor marque el dominio entero como spam, y quien tiene
 * que decidirlo es una persona que lea el motivo.
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
 *     none      no hay proveedor. Lo que se intente entregar queda en
 *               `SIN_PROVEEDOR`: no salió, no va a salir solo, y quien se
 *               registró está esperando. Completar un alta es un trabajo manual
 *               del operador — y decirlo así es preferible a un sistema que
 *               parece mandar correos y no manda ninguno.
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
const soloVer = args.includes('--ver');

const cliente = new pg.Client({ connectionString: process.env.DATABASE_URL });
await cliente.connect();

// La entrega tiene su propio `try`, y no es ceremonia: con el de abajo, un
// fallo al entregar salía por «No se pudo leer la bandeja», que manda a mirar
// la base cuando lo que falta puede ser una variable de entorno o el proveedor.
// Medido: sin `MFA_ENCRYPTION_KEY` —que `config.js` exige en producción— el
// mensaje era exactamente ese.
//
// Y no corta la corrida: aunque la entrega falle, la bandeja se imprime igual.
// Ver qué hay encolado es justo lo que hace falta cuando la entrega no anduvo.
if (!soloVer) {
  try {
    await entregarPendientes(cliente);
  } catch (error) {
    console.error(`\nNo se pudo entregar lo pendiente: ${error.message}`);
    console.error('Los mensajes siguen PENDIENTE y se reintentan en la próxima corrida.\n');
    process.exitCode = 1;
  }
}

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
    // Se habla en pasado a propósito: la fila dice que **cuando se intentó** no
    // había proveedor. Si desde entonces se configuró uno, decir «no hay
    // proveedor en esta instalación» sería falso, y mandaría a revisar una
    // configuración que ya está bien en vez de a reenviar esos mensajes.
    console.log('  ⚠ Estos mensajes se intentaron SIN proveedor de correo configurado.');
    console.log('    NO salieron y no van a salir solos, ni siquiera si ahora hay proveedor:');
    console.log('    nada los reintenta. Quien se registró sigue esperando.\n');
  }
} catch (error) {
  console.error(`No se pudo leer la bandeja: ${error.message}`);
  process.exitCode = 1;
} finally {
  await cliente.end();
}

/**
 * Manda lo que está `PENDIENTE` y deja escrito qué contestó el proveedor.
 *
 * **Un mensaje por transacción, y el envío va adentro.** Las dos cosas por el
 * mismo motivo, que es que un correo entregado no se puede deshacer.
 *
 * Envolver los cincuenta en una sola transacción haría que el rechazo del
 * último dejara sin registrar los cuarenta y nueve que ya salieron, y esos
 * correos están en la bandeja de entrada de alguien: el `ROLLBACK` no los trae
 * de vuelta, y la próxima corrida los mandaría otra vez.
 *
 * Y el `SELECT ... FOR UPDATE SKIP LOCKED` tiene que estar **en la misma
 * transacción que el envío**, no antes: en autocommit, el lock se suelta con la
 * sentencia y no impide nada. Adentro, una segunda corrida que se pise con esta
 * —un timer cada cinco minutos y un operador impaciente— se saltea las filas
 * tomadas en vez de mandarlas dos veces. El lock dura lo que dura el envío, que
 * es el precio de que nadie reciba el mismo aviso duplicado.
 */
async function entregarPendientes(cliente) {
  const { crearProveedorDeCorreo, modoDeCorreo } = await import(
    new URL('../apps/api/dist/correo/fabrica.js', import.meta.url).href
  );

  const candidatos = await cliente.query(
    `SELECT id FROM email_outbox WHERE estado = 'PENDIENTE' ORDER BY creado_el LIMIT 200`,
  );
  if (candidatos.rows.length === 0) return;

  const modo = modoDeCorreo();
  const proveedor = crearProveedorDeCorreo();

  console.log(`\n══ Entrega ══════════════════════════════════════════════════\n`);
  console.log(`  correo: ${modo.valor}${modo.real ? '' : '  (no conectado)'}`);
  console.log(`  ${modo.detalle}\n`);

  let salieron = 0;
  let fallaron = 0;
  let tomadas = 0;

  for (const { id } of candidatos.rows) {
    await cliente.query('BEGIN');
    try {
      // Vuelve a pedir la fila con el estado en el `WHERE`: entre el listado y
      // esta línea, otra corrida pudo tomarla y entregarla.
      const tomada = await cliente.query(
        `SELECT id, destinatario, asunto, cuerpo, tipo
           FROM email_outbox
          WHERE id = $1 AND estado = 'PENDIENTE'
          FOR UPDATE SKIP LOCKED`,
        [id],
      );
      const m = tomada.rows[0];
      if (m === undefined) {
        await cliente.query('ROLLBACK');
        tomadas += 1;
        continue;
      }

      const resultado = await proveedor.enviar({
        destinatario: m.destinatario,
        asunto: m.asunto,
        cuerpo: m.cuerpo,
        tipo: m.tipo,
      });

      await cliente.query(
        `UPDATE email_outbox
            SET estado = $1,
                proveedor = $2,
                referencia_externa = $3,
                detalle = $4,
                intentos = intentos + $5,
                enviado_el = CASE WHEN $1 = 'ENVIADO' THEN now() ELSE enviado_el END
          WHERE id = $6`,
        [
          resultado.estado,
          resultado.estado === 'ENVIADO' ? resultado.proveedor : proveedor.id,
          resultado.estado === 'ENVIADO' ? resultado.referencia : null,
          resultado.estado === 'ENVIADO' ? null : resultado.detalle,
          // Un adaptador que reintenta un 429 hizo más de un intento, y la
          // columna existe para contestar «¿cuántas veces se probó?». Sin el
          // campo se asume uno, que es lo cierto para el que no reintenta.
          resultado.estado === 'SIN_PROVEEDOR' ? 1 : (resultado.intentos ?? 1),
          m.id,
        ],
      );
      await cliente.query('COMMIT');

      if (resultado.estado === 'ENVIADO') salieron += 1;
      else fallaron += 1;
    } catch (error) {
      await cliente.query('ROLLBACK');
      // El mensaje queda `PENDIENTE` y se vuelve a intentar en la corrida
      // siguiente, que es lo correcto: lo que falló acá no es el proveedor
      // —eso tiene su propio estado— sino la base o el código.
      console.error(`  ✗ no se pudo procesar ${id}: ${error.message}`);
      fallaron += 1;
    }
  }

  console.log(
    `  ${salieron} entregado(s), ${fallaron} sin entregar` +
      (tomadas > 0 ? `, ${tomadas} ya tomado(s) por otra corrida` : '') +
      '.\n',
  );
}
