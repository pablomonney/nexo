#!/usr/bin/env node
/**
 * Crea el plan del lado de la pasarela y guarda el vínculo con el de NEXO.
 *
 *   node scripts/declarar-plan-de-pasarela.mjs COMPLETO MENSUAL ARS "Alta de octubre"
 *                                              │        │       │   └ motivo
 *                                              │        │       └ moneda ISO
 *                                              │        └ MENSUAL | ANUAL
 *                                              └ código del plan de NEXO
 *
 *   ... --ensayo      arma el pedido y no llama a nadie
 *
 * ## Por qué es un script y no una ruta
 *
 * Porque crear un plan del lado de una pasarela **define lo que se le va a
 * cobrar a alguien todos los meses**. Es un acto comercial que ocurre una vez
 * por plan, no algo que pase en el medio de una petición HTTP: si la aplicación
 * pudiera hacerlo, el reintento de cualquier pedido podría crear un segundo plan
 * sin que nadie lo pidiera. Por eso `aai_app` tiene `SELECT` y nada más sobre
 * `payment_plan_map` (0119).
 *
 * ## El importe no se pasa por parámetro
 *
 * Sale de `plan_prices`, que es donde vive el precio con su vigencia y su
 * motivo. Pasarlo a mano acá crearía **una segunda verdad sobre el precio**: el
 * día que las dos difirieran, la pasarela cobraría una cosa y los documentos
 * dirían otra, y nadie sabría cuál está mal.
 *
 * Sin precio vigente esto no corre. No inventa cero ni pregunta: dice que falta
 * declararlo y con qué comando.
 *
 * ## Correrlo dos veces no crea dos planes
 *
 * Si ya hay un mapeo para esa combinación, no llama a la pasarela. Es la única
 * protección de verdad contra el duplicado: la API no tiene una operación «creá
 * este plan si no existe», así que dos POST crean dos planes y a partir de ahí
 * hay dos precios vivos para lo mismo.
 *
 * ## Qué comprueba antes de llamar
 *
 * Que el ambiente declarado coincida con la credencial que hay. Mercado Pago usa
 * la misma URL para prueba y producción: crear un plan «de prueba» con un token
 * real deja un plan real, visible para cualquiera que después suscriba contra él.
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

const args = process.argv.slice(2);
const ensayo = args.includes('--ensayo');
const [plan, periodicidad, moneda, ...resto] = args.filter((a) => !a.startsWith('--'));
const motivo = resto.join(' ');

const uso =
  'Uso: node scripts/declarar-plan-de-pasarela.mjs <PLAN> <MENSUAL|ANUAL> <MONEDA> <motivo> ' +
  '[--ensayo]';

if (plan === undefined || periodicidad === undefined || moneda === undefined) {
  console.error(uso);
  process.exit(2);
}
if (periodicidad !== 'MENSUAL' && periodicidad !== 'ANUAL') {
  console.error(`La periodicidad es MENSUAL o ANUAL, no "${periodicidad}".`);
  process.exit(2);
}
if (!/^[A-Z]{3}$/u.test(moneda)) {
  console.error(`La moneda es un código ISO de tres letras, no "${moneda}".`);
  process.exit(2);
}
if (motivo.trim().length < 5) {
  console.error('Falta el motivo. Dentro de seis meses es lo único que explica este plan.');
  process.exit(2);
}

// ── Que haya pasarela, y que sea la que se cree que es ──────────────────────

const estado = estadoDeLosPagos(config.pagos);
if (estado !== 'CONFIGURADO') {
  const falta = faltantesDeMercadoPago(config.pagos);
  console.error(
    `\nNo hay pasarela configurada (${estado}).` +
      (falta.length > 0 ? ` Falta: ${falta.join(', ')}.` : '') +
      '\nMientras tanto el ciclo emite y lleva la cobranza igual, y los cobros por ' +
      'transferencia se registran a mano.\n',
  );
  process.exit(1);
}

const problemaDeAmbiente = await verificarAmbienteDePagos(config.pagos);
if (problemaDeAmbiente !== null) {
  console.error(`\n  ✘ ${problemaDeAmbiente}\n`);
  process.exit(1);
}

const cliente = new pg.Client({ connectionString: process.env.DATABASE_URL });
await cliente.connect();

try {
  const proveedor = crearProveedorDePagos();
  const ambiente = config.pagos.ambiente;

  const planFila = await cliente.query(
    'SELECT id, name FROM subscription_plans WHERE code = $1 AND status = $2',
    [plan, 'DISPONIBLE'],
  );
  if (planFila.rows.length === 0) {
    throw new Error(
      `No existe un plan DISPONIBLE con código "${plan}". Un plan discontinuado no se ` +
        'vuelve a poner a la venta: se crea uno nuevo.',
    );
  }
  const { id: planId, name: nombre } = planFila.rows[0];

  const yaEsta = await cliente.query(
    `SELECT referencia_externa, importe_declarado::text AS importe
       FROM payment_plan_map
      WHERE plan_id = $1 AND proveedor = $2 AND ambiente = $3
        AND periodicidad = $4 AND moneda = $5`,
    [planId, proveedor.id, ambiente, periodicidad, moneda],
  );
  if (yaEsta.rows.length > 0) {
    const f = yaEsta.rows[0];
    console.log(
      `\n  Ya existe: ${plan} ${periodicidad} ${moneda} en ${ambiente} → ` +
        `${f.referencia_externa} (${f.importe} ${moneda})\n` +
        '  No se llamó a la pasarela: crear otro dejaría dos precios vivos para lo mismo.\n',
    );
    process.exit(0);
  }

  // El precio vigente hoy, según la base. `CURRENT_DATE` y no una fecha de
  // JavaScript: Argentina es UTC−3, y después de las nueve de la noche `Date`
  // ya está en el día siguiente. Es el mismo defecto que dejó a los planes sin
  // precio el 2026-09-09 a las 22:07.
  const precio = await cliente.query(
    `SELECT importe::text AS importe, incluye_impuestos
       FROM plan_prices
      WHERE plan_id = $1 AND periodicidad = $2 AND moneda = $3
        AND vigente_desde <= CURRENT_DATE
        AND (vigente_hasta IS NULL OR vigente_hasta > CURRENT_DATE)
      ORDER BY vigente_desde DESC
      LIMIT 1`,
    [planId, periodicidad, moneda],
  );
  if (precio.rows.length === 0) {
    throw new Error(
      `El plan "${plan}" no tiene precio ${periodicidad} vigente en ${moneda}. ` +
        'Declaralo primero:\n  npm run plan:precio -- ' +
        `${plan} ${periodicidad} ${moneda} <importe> <si|no> <AAAA-MM-DD> "<motivo>"`,
    );
  }
  const { importe, incluye_impuestos: incluyeImpuestos } = precio.rows[0];

  // A centavos sin pasar por punto flotante: el importe viene como texto
  // decimal desde `numeric(18,2)` y se convierte con aritmética de enteros.
  const [entera, decimales] = importe.split('.');
  const centavos = BigInt(entera) * 100n + BigInt((decimales ?? '').padEnd(2, '0'));

  console.log(`\n══ Plan de pasarela ═════════════════════════════════════════\n`);
  console.log(`  plan        ${plan} — ${nombre}`);
  console.log(`  condiciones ${periodicidad} ${moneda} ${importe}`);
  console.log(`  impuestos   ${incluyeImpuestos ? 'incluidos en el importe' : 'por fuera'}`);
  console.log(`  pasarela    ${proveedor.id}  ambiente ${ambiente}`);

  if (ensayo) {
    console.log('\n  ENSAYO: no se llamó a la pasarela y no se escribió nada.\n');
    process.exit(0);
  }

  const salida = await proveedor.asegurarPlan({
    codigo: plan,
    nombre,
    importeCentavos: centavos,
    moneda,
    periodicidad,
  });

  if (!salida.ok) {
    // El mapeo **no se escribe** si la llamada falló. Escribirlo dejaría una
    // referencia a un plan que no existe, y el próximo intento no volvería a
    // crearlo porque creería que ya está.
    throw new Error(
      `La pasarela rechazó la creación (${salida.fallo.codigo}): ${salida.fallo.detalle}`,
    );
  }

  await cliente.query(
    `INSERT INTO payment_plan_map
       (plan_id, proveedor, ambiente, periodicidad, moneda, referencia_externa,
        importe_declarado, declarado_por, motivo)
     VALUES ($1, $2, $3, $4, $5, $6, $7::numeric, $8, $9)`,
    [
      planId,
      proveedor.id,
      ambiente,
      periodicidad,
      moneda,
      salida.valor.id,
      importe,
      'script:declarar-plan-de-pasarela',
      motivo,
    ],
  );

  console.log(`\n  Creado: ${salida.valor.id}  (estado ${salida.valor.estado})`);
  console.log('  El vínculo quedó guardado en payment_plan_map.\n');
  console.log(
    '  Si más adelante cambia el precio en plan_prices, la pasarela va a seguir cobrando\n' +
      '  este importe: la divergencia aparece en la bandeja de trabajo de cada empresa\n' +
      '  afectada (work_queue_pasarela).\n',
  );
} catch (error) {
  console.error(`\n  ✘ ${error.message}\n`);
  process.exit(1);
} finally {
  await cliente.end();
}
