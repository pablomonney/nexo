#!/usr/bin/env node
/**
 * El ensayo del circuito de cobro, contra la cuenta de PRUEBA.
 *
 *   npm run pagos:ensayo
 *
 * ## Qué es y qué no
 *
 * **No es un test.** Los tests corren contra dobles y no necesitan cuenta; están
 * en `tests/integration/` y comprueban el contrato del puerto. Esto es lo otro:
 * la lista de comprobaciones que hay que poder marcar antes de decir que la
 * integración está probada **contra Mercado Pago de verdad**, en sandbox.
 *
 * La diferencia importa porque los dos pueden dar verde y significar cosas
 * distintas: un doble confirma que NEXO hace lo que cree que hace; solo la
 * cuenta real confirma que Mercado Pago está de acuerdo.
 *
 * ## Por qué se niega a correr en producción
 *
 * Porque su trabajo es crear suscripciones y mirar qué pasa. Hecho contra la
 * cuenta real, eso es cobrarle a alguien. Mercado Pago **usa la misma URL para
 * prueba y producción** y solo los distingue el prefijo del token, así que no
 * hay ninguna barrera de red que ataje el error: la barrera es esta línea.
 *
 * ## Lo que no puede hacer solo
 *
 * Autorizar un medio de pago exige un navegador y una persona: el `init_point`
 * es una pantalla de Mercado Pago donde el comprador de prueba pone la tarjeta.
 * El ensayo llega hasta ahí, imprime el enlace, y dice qué mirar después.
 * Fingir ese paso —marcar la suscripción como autorizada a mano— probaría el
 * código de NEXO contra sí mismo, que es exactamente lo que este archivo existe
 * para no hacer.
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

const { crearProveedorDePagos, estadoDeLosPagos, verificarAmbienteDePagos, faltantesDeMercadoPago } =
  await import(new URL('../apps/api/dist/pagos/fabrica.js', import.meta.url).href);
const { config } = await import(new URL('../apps/api/dist/config.js', import.meta.url).href);

let fallos = 0;
let pendientes = 0;
const ok = (t) => console.log(`  \x1b[32m✔\x1b[0m ${t}`);
const mal = (t) => {
  console.log(`  \x1b[31m✘\x1b[0m ${t}`);
  fallos += 1;
};
const falta = (t) => {
  console.log(`  \x1b[33m·\x1b[0m ${t}`);
  pendientes += 1;
};
const info = (t) => console.log(`    ${t}`);
const titulo = (t) => console.log(`\n\x1b[1m── ${t} ${'─'.repeat(Math.max(0, 58 - t.length))}\x1b[0m`);

console.log('\n\x1b[1mNEXO — ensayo del circuito de cobro (sandbox)\x1b[0m');

// ── 1 · La barrera ──────────────────────────────────────────────────────────

titulo('1 · Ambiente');

const ambiente = config.pagos.ambiente;
info(`PAYMENTS_ENV = ${ambiente}`);

if (ambiente === 'production') {
  console.error(
    '\n\x1b[31m  ✘ ESTE ENSAYO NO CORRE CONTRA PRODUCCIÓN.\x1b[0m\n\n' +
      '    Crea suscripciones para ver qué pasa. Contra la cuenta real eso es\n' +
      '    cobrarle a alguien. Mercado Pago usa la misma URL para prueba y\n' +
      '    producción: la única barrera es esta.\n',
  );
  process.exit(2);
}
ok('no es producción: se puede ensayar');

const estado = estadoDeLosPagos(config.pagos);
info(`estado de la pasarela: ${estado}`);

if (estado !== 'CONFIGURADO') {
  const pendiente = faltantesDeMercadoPago(config.pagos);
  falta(
    `la pasarela está ${estado}` + (pendiente.length > 0 ? `; falta: ${pendiente.join(', ')}` : ''),
  );
  info('Sin credenciales de prueba el ensayo solo revisa lo que hay del lado de NEXO.');
} else {
  const problema = await verificarAmbienteDePagos(config.pagos);
  if (problema !== null) mal(problema);
  else ok('el prefijo del token coincide con el ambiente declarado');
}

// ── 2 · Lo que tiene que estar del lado de NEXO ─────────────────────────────

titulo('2 · Datos comerciales');

const cliente = new pg.Client({ connectionString: process.env.DATABASE_URL });
await cliente.connect();

try {
  const planes = await cliente.query(
    `SELECT p.code, p.name, p.dias_de_prueba,
            (SELECT count(*) FROM plan_prices pr
              WHERE pr.plan_id = p.id AND pr.vigente_desde <= CURRENT_DATE
                AND (pr.vigente_hasta IS NULL OR pr.vigente_hasta > CURRENT_DATE)) AS precios,
            (SELECT count(*) FROM plan_limits l WHERE l.plan_id = p.id)   AS topes,
            (SELECT count(*) FROM plan_features f WHERE f.plan_id = p.id) AS features,
            (SELECT count(*) FROM payment_plan_map m
              WHERE m.plan_id = p.id AND m.ambiente = $1)                 AS en_pasarela
       FROM subscription_plans p
      WHERE p.status = 'DISPONIBLE'
      ORDER BY p.orden`,
    [ambiente],
  );

  for (const p of planes.rows) {
    const dias = p.dias_de_prueba === null ? '14 (por defecto)' : `${p.dias_de_prueba}`;
    const linea =
      `${p.code.padEnd(12)} precio:${String(p.precios).padStart(2)}  topes:${String(p.topes).padStart(2)}` +
      `  funciones:${String(p.features).padStart(2)}  prueba:${dias}  en ${ambiente}:${p.en_pasarela}`;
    if (Number(p.precios) === 0) falta(`${linea}   ← sin precio vigente, no se puede crear el plan`);
    else if (Number(p.en_pasarela) === 0) falta(`${linea}   ← falta: npm run pagos:plan`);
    else ok(linea);
  }

  const politica = await cliente.query(
    `SELECT count(*) AS n FROM collection_policies
      WHERE vigente_desde <= CURRENT_DATE
        AND (vigente_hasta IS NULL OR vigente_hasta > CURRENT_DATE)`,
  );
  if (Number(politica.rows[0].n) === 0) {
    falta('no hay política de cobranza vigente: un pago fallido se registra y no dispara nada');
  } else {
    ok('hay política de cobranza vigente');
  }

  // ── 3 · La credencial, sin crear nada ────────────────────────────────────

  titulo('3 · La cuenta de prueba responde');

  if (estado !== 'CONFIGURADO') {
    falta('sin credenciales: no se le puede preguntar nada a la pasarela');
  } else {
    /**
     * Se consulta una suscripción que no existe, **a propósito**.
     *
     * Es la forma de saber si el token sirve sin crear ni tocar nada: si la
     * credencial está bien, Mercado Pago contesta «no la encuentro»; si está
     * mal o vencida, contesta que la rechaza. Los dos son errores para el
     * puerto y significan cosas opuestas para quien está configurando.
     */
    const proveedor = crearProveedorDePagos();
    const sonda = await proveedor.consultarSuscripcion('ensayo-que-no-existe');
    if (sonda.ok) {
      mal('la pasarela dice que existe una suscripción llamada "ensayo-que-no-existe"');
    } else if (sonda.fallo.codigo === 'NO_ENCONTRADO') {
      ok('la credencial sirve: la pasarela contestó y no encontró el recurso');
    } else if (sonda.fallo.codigo === 'CREDENCIAL_RECHAZADA') {
      mal('la pasarela rechazó la credencial: revisá PAYMENTS_ACCESS_TOKEN');
    } else {
      mal(`no se pudo hablar con la pasarela (${sonda.fallo.codigo}): ${sonda.fallo.detalle}`);
    }
  }

  // ── 4 · El webhook ───────────────────────────────────────────────────────

  titulo('4 · Notificaciones');

  if (config.pagos.webhookSecretRef === null || config.pagos.webhookSecretRef === '') {
    falta('sin PAYMENTS_WEBHOOK_SECRET: el webhook contesta 503 y no guarda nada');
  } else {
    ok('hay secreto de firma declarado');
  }

  if (config.pagos.backUrl === null || config.pagos.backUrl === '') {
    falta('sin PAYMENTS_BACK_URL: no se puede crear ninguna suscripción');
  } else {
    ok(`URL de retorno: ${config.pagos.backUrl}`);
  }

  const bandeja = await cliente.query(
    `SELECT estado, count(*) AS n FROM payment_webhook_inbox GROUP BY estado ORDER BY estado`,
  );
  if (bandeja.rows.length === 0) info('la bandeja de notificaciones está vacía');
  else for (const f of bandeja.rows) info(`bandeja ${f.estado}: ${f.n}`);

  // ── 5 · Lo que sigue, y lo hace una persona ──────────────────────────────

  titulo('5 · Los pasos que necesitan un navegador');

  console.log(`
    Estos no se pueden automatizar: autorizar un medio de pago es una pantalla
    de Mercado Pago. El orden es:

      1. Crear el plan en sandbox        npm run pagos:plan -- <PLAN> MENSUAL ARS "<motivo>"
      2. Dar de alta una empresa y dejar correr su prueba
      3. Convertirla                     POST /subscription/convertir
      4. Conectar la pasarela            POST /subscription/pasarela
         → devuelve urlDeAutorizacion
      5. Abrir esa URL con el COMPRADOR DE PRUEBA y autorizar
      6. Mirar que llegue la notificación   payment_webhook_inbox
      7. Drenarla                        npm run pagos:bandeja
      8. Comprobar el estado             GET /subscription
      9. Repetir el paso 7 sobre la misma fila: tiene que decir REPETIDO
     10. Probar un pago rechazado con una tarjeta de prueba de rechazo
     11. Cancelar                        POST /subscription/:id/estado
         → y verificar en el panel de Mercado Pago que quedó cancelada allá

    El paso 9 es el que más vale: un evento repetido no puede activar dos veces,
    cobrar dos veces ni extender el período dos veces.
`);

  // ── Resumen ──────────────────────────────────────────────────────────────

  titulo('Resumen');
  console.log(`  fallos: ${fallos}   pendientes: ${pendientes}\n`);

  if (fallos > 0) {
    console.log('  Hay comprobaciones en rojo: cada una dice qué está mal.\n');
    process.exitCode = 1;
  } else if (pendientes > 0) {
    console.log(
      '  Nada está mal; faltan datos o credenciales. Cada línea amarilla dice cuál.\n',
    );
  } else {
    console.log('  Todo lo verificable sin navegador pasó. Seguí por el paso 5.\n');
  }
} catch (error) {
  console.error(`\n  ✘ ${error.message}\n`);
  process.exitCode = 1;
} finally {
  await cliente.end();
}
