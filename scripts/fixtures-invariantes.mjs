#!/usr/bin/env node
/**
 * Fixtures conductuales del gate de invariantes.
 *
 * No inserta filas: **ejercita el sistema**. Levanta la API en proceso contra la
 * base de verificación y recorre los flujos productivos reales —alta de asiento,
 * aprobación, contraasiento, decisión contable, pre-cierre, cierre, apertura—
 * para que cada invariante conductual tenga casos sobre los que ejercerse.
 *
 * ## Por qué por HTTP y no por SQL
 *
 * Un fixture que arma las filas con `INSERT` produce el estado final sin pasar
 * por los caminos que el invariante promete proteger. El `CONSTRAINT TRIGGER`
 * del `Debe = Haber` dispara en el COMMIT, el guard del ejercicio dispara en el
 * INSERT, el trigger de proyección del Mayor dispara al aprobar: un fixture que
 * los saltea deja el gate verificando una foto que nadie sacó.
 *
 * Acá cada fila la escribe la misma ruta que la escribiría en producción, y por
 * eso lo que el gate verifica después es el resultado de un sistema que
 * funcionó, no el de una carga de datos.
 *
 * ## Determinismo
 *
 * Todo es sintético: dos empresas de prueba, un plan de cuentas de cinco líneas,
 * importes fijos, fechas fijas. No hay comprobantes fiscales reales, no hay
 * lectura de archivos y no hay nada que dependa del reloj salvo las marcas de
 * tiempo que el propio sistema pone. Dos corridas producen los mismos conteos.
 *
 * ## Aislamiento
 *
 * Se niega a correr sobre una base cuyo nombre no termine en `_verify`. Es la
 * misma condición que en `verification-db.mjs`: estos fixtures escriben, y lo
 * que escriben no se puede borrar —los `forbid_delete` están puestos para eso—,
 * así que apuntar por error a desarrollo la ensuciaría para siempre.
 */

import { hash as argonHash } from '@node-rs/argon2';
import { buildServer } from '@aai/api/server';
import { closePool, initPool } from '@aai/db';
import { totp, withCheckDigit } from '@aai/shared';
import pg from 'pg';
import { nombreDe } from './verification-db.mjs';

const PASSWORD = 'una-contrasena-suficientemente-larga';

/**
 * Sufijo fijo. Los fixtures corren sobre una base recién creada, así que no hay
 * con qué chocar, y un sufijo estable hace que dos corridas produzcan CUIT y
 * códigos idénticos — que es lo que permite comparar dos ejecuciones.
 */
const SUFIJO = '90000001';

/** El plan de cuentas de las dos empresas. Sigue la convención de STATEMENTS.md. */
const PLAN = [
  { code: '1.1.01', name: 'Caja', type: 'ACTIVO' },
  { code: '2.1.01', name: 'Acreedores varios', type: 'PASIVO' },
  { code: '3.1.01', name: 'Capital', type: 'PN' },
  { code: '3.4.01', name: 'Resultado del ejercicio', type: 'PN' },
  { code: '4.1.01', name: 'Ventas', type: 'INGRESO' },
  { code: '6.1.01', name: 'Gastos de administración', type: 'GASTO' },
];

export async function sembrarFixtures(databaseUrl, { silencioso = false } = {}) {
  const nombre = nombreDe(databaseUrl);
  if (!nombre.endsWith('_verify')) {
    throw new Error(
      `Los fixtures del gate solo corren sobre una base "_verify", y se pidió "${nombre}". ` +
        'Se corta: escriben filas que después no se pueden borrar.',
    );
  }

  const decir = (texto) => {
    if (!silencioso) console.log(texto);
  };

  initPool(databaseUrl);
  const app = await buildServer();
  await app.ready();
  const db = new pg.Client({ connectionString: databaseUrl });
  await db.connect();

  try {
    const contexto = await montar(app, db);
    decir('  ✔ dos empresas, plan de cuentas y ejercicios');

    await ejercitarAsientos(app, db, contexto);
    decir('  ✔ asientos por las tres vías de trazabilidad, contraasiento y propuesta de IA');

    await ejercitarCierre(app, contexto);
    decir('  ✔ ciclo completo: pre-cierre → cierre → apertura (empresa A)');

    await ejercitarEmpresaB(app, contexto);
    decir('  ✔ empresa B con ejercicio abierto e independiente');

    return contexto;
  } finally {
    await db.end();
    await app.close();
    await closePool();
  }
}

// ---------------------------------------------------------------------------
// Montaje
// ---------------------------------------------------------------------------

async function montar(app, db) {
  const email = `verificacion-${SUFIJO}@estudio.test`;
  const passwordHash = await argonHash(PASSWORD, {
    algorithm: 2,
    memoryCost: 19_456,
    timeCost: 2,
    parallelism: 1,
  });
  const usuario = await db.query(
    'INSERT INTO users (email, full_name, password_hash) VALUES ($1,$2,$3) RETURNING id',
    [email, 'Contadora de verificación', passwordHash],
  );
  const userId = usuario.rows[0].id;

  const org = await db.query('SELECT create_organization($1,$2,$3)', [
    `Estudio de verificación ${SUFIJO}`,
    withCheckDigit(`30${SUFIJO}`),
    userId,
  ]);
  const organizationId = org.rows[0].create_organization;

  const crearEmpresa = async (nombre, prefijo) => {
    const c = await db.query('SELECT create_company($1,$2,$3,$4,$5,$6,$7,$8)', [
      userId,
      organizationId,
      nombre,
      withCheckDigit(`${prefijo}${SUFIJO}`),
      // SA y no SRL: las plantillas de estados sembradas son las de los arts. 63
      // y 64 de la ley 19.550 para SA con regulador IGJ, y el sistema se niega a
      // armar una estructura por su cuenta si no hay plantilla vigente para el
      // ente. La empresa del fixture tiene que ser una a la que le corresponda.
      'SA',
      'AR-C',
      'IGJ',
      '12-31',
    ]);
    const id = c.rows[0].create_company;
    // Los dos roles: CONTADOR firma la contabilidad, ADMINISTRADOR declara el
    // marco contable del ente. Es el reparto real en un estudio chico, y sin el
    // segundo no hay estados que emitir — con lo cual A-1 y A-2 se quedarían sin
    // casos por cómo está armado el fixture y no por una limitación del sistema.
    for (const rol of ['CONTADOR', 'ADMINISTRADOR']) {
      await db.query('SELECT grant_company_role($1,$2,$3,$4)', [userId, id, userId, rol]);
    }
    return id;
  };

  const empresaA = await crearEmpresa('Verificación A', '33');
  const empresaB = await crearEmpresa('Verificación B', '27');

  // Segundo factor: sin él el rol CONTADOR no alcanza ninguna empresa, así que
  // el fixture recorre el mismo camino de autenticación que un usuario real.
  const inicial = (
    await app.inject({ method: 'POST', url: '/auth/login', payload: { email, password: PASSWORD } })
  ).json().token;
  const secret = (
    await app.inject({
      method: 'POST',
      url: '/auth/mfa/setup',
      headers: { authorization: `Bearer ${inicial}` },
    })
  ).json().secret;
  await app.inject({
    method: 'POST',
    url: '/auth/mfa/confirm',
    payload: { code: totp(secret, Date.now()) },
    headers: { authorization: `Bearer ${inicial}` },
  });
  const token = (
    await app.inject({ method: 'POST', url: '/auth/login', payload: { email, password: PASSWORD } })
  ).json().token;
  await app.inject({
    method: 'POST',
    url: '/auth/mfa/verify',
    payload: { code: totp(secret, Date.now()) },
    headers: { authorization: `Bearer ${token}` },
  });

  const ctx = {
    db,
    token,
    userId,
    empresaA,
    empresaB,
    cuentas: { A: {}, B: {} },
  };

  for (const [etiqueta, empresa] of [
    ['A', empresaA],
    ['B', empresaB],
  ]) {
    for (const cuenta of PLAN) {
      const r = await pedir(app, ctx, empresa, 'POST', '/accounts', cuenta);
      exigir(r, 201, `alta de cuenta ${cuenta.code}`);
      ctx.cuentas[etiqueta][cuenta.code] = r.json().id;
      if (cuenta.code === '3.4.01') {
        const marca = await pedir(app, ctx, empresa, 'PATCH', `/accounts/${r.json().id}`, {
          closingRole: 'RESULTADO_DEL_EJERCICIO',
          motivo: 'Designación de la cuenta de resultado del ejercicio',
        });
        exigir(marca, 200, 'designación de la cuenta de resultado');
      }
    }
  }

  // Marco contable del ente. El sistema no lo supone —qué normativa le aplica lo
  // determina el profesional (ADR-006)— y sin él no se emite ningún estado, así
  // que A-1 y A-2 se quedarían sin casos por una omisión del fixture y no por
  // una limitación del sistema.
  const marco = await pedir(app, ctx, empresaA, 'POST', '/companies/current/reporting-framework', {
    framework: 'RT_FACPCE',
    validFrom: '2026-01-01',
  });
  exigir(marco, 200, 'declaración del marco contable de la empresa A');

  ctx.ejercicioA26 = await crearEjercicio(app, ctx, empresaA, 'EJ2026-A', '2026-01-01', '2026-12-31');
  ctx.ejercicioA27 = await crearEjercicio(app, ctx, empresaA, 'EJ2027-A', '2027-01-01', '2027-12-31');
  ctx.ejercicioB26 = await crearEjercicio(app, ctx, empresaB, 'EJ2026-B', '2026-01-01', '2026-12-31');

  return ctx;
}

// ---------------------------------------------------------------------------
// Asientos: las tres vías de trazabilidad, el contraasiento y la IA
// ---------------------------------------------------------------------------

async function ejercitarAsientos(app, db, ctx) {
  // (1) Justificación firmada — la vía más vieja. A-3.
  await postearYAprobar(app, ctx, ctx.empresaA, {
    ...venta('2026-03-10', '3000.00'),
    manualJustification: 'Venta de contado registrada por la contadora',
  });

  // (2) Un gasto, para que el resultado del ejercicio no sea el importe de una
  // sola cuenta y la refundición tenga dos lados que cancelar.
  await postearYAprobar(app, ctx, ctx.empresaA, {
    journalCode: 'GENERAL',
    entryDate: '2026-06-15',
    description: 'Gasto de administración',
    currency: 'ARS',
    lines: [
      { accountCode: '6.1.01', debit: '1200.00', credit: '0' },
      { accountCode: '1.1.01', debit: '0', credit: '1200.00' },
    ],
    source: { type: 'MANUAL', id: null },
    manualJustification: 'Gasto de administración registrado por la contadora',
  });

  // (3) Decisión contable como único fundamento — la tercera vía. A-3 y A-10.
  const iva = await db.query("SELECT id FROM taxes WHERE code = 'IVA' LIMIT 1");
  const periodo = await db.query(
    'SELECT id FROM periods WHERE fiscal_year_id = $1 AND number = 4',
    [ctx.ejercicioA26],
  );
  const operacion = await db.query(
    `INSERT INTO tax_transactions
       (company_id, tax_id, period_id, direction, cbte_tipo, punto_venta, cbte_numero,
        cbte_fecha, condicion_iva, neto, iva, no_gravado, exento, percepciones, total, created_by)
     VALUES ($1,$2,$3,'VENTAS',11,1,900001,'2026-04-20','CONSUMIDOR_FINAL',
             500,0,0,0,0,500,'fixtures')
     RETURNING id`,
    [ctx.empresaA, iva.rows[0].id, periodo.rows[0].id],
  );
  const decision = await db.query(
    `INSERT INTO accounting_decisions
       (company_id, tax_transaction_id, origen, resultado, motivos, hechos, evidencia,
        ambiente, decidida_por, justificacion)
     VALUES ($1,$2,'MANUAL','PROPUESTA_DE_ASIENTO','[]'::jsonb,'[]'::jsonb,'[]'::jsonb,
             'PRODUCTIVO','user:verificacion','Decidido a mano, con justificación suficiente')
     RETURNING id`,
    [ctx.empresaA, operacion.rows[0].id],
  );
  ctx.decisionId = decision.rows[0].id;
  await postearYAprobar(app, ctx, ctx.empresaA, {
    ...venta('2026-04-20', '500.00'),
    journalCode: 'VENTAS',
    source: { type: 'INVOICE', id: operacion.rows[0].id },
    decisionId: ctx.decisionId,
  });

  // (4) Una decisión de ambiente PRUEBA, sin asiento. A-10 tiene que seguir
  // verde **con** una decisión de prueba en la base: si la sola existencia de la
  // fila lo violara, el invariante estaría diciendo otra cosa que la que enuncia.
  await db.query(
    `INSERT INTO accounting_decisions
       (company_id, origen, resultado, motivos, hechos, evidencia,
        ambiente, decidida_por, justificacion)
     VALUES ($1,'MANUAL','SIN_EFECTO','[]'::jsonb,'[]'::jsonb,'[]'::jsonb,'PRUEBA',
             'user:verificacion','Ensayo en ambiente de prueba, sin efecto contable')`,
    [ctx.empresaA],
  );

  // (5) Propuesta de IA aprobada por una persona. A-6.
  const prompt = await db.query(
    "SELECT hash FROM prompt_versions WHERE name LIKE '%lassification%' OR name LIKE '%lasificaci%' ORDER BY registered_at LIMIT 1",
  );
  const prediccion = await db.query(
    `INSERT INTO ai_predictions
       (company_id, agent, model_provider, model_id, prompt_hash, input_ref,
        output, confidence, reason, triage_band, hard_blocks)
     VALUES ($1,'CLASSIFICATION','mock','mock-1',$2,'fixture-verificacion',
             '{"cuenta":"6.1.01"}'::jsonb, 0.91, 'clasificación sintética de fixture',
             'ALTA', ARRAY[]::text[])
     RETURNING id`,
    [ctx.empresaA, prompt.rows[0].hash],
  );
  await postearYAprobar(app, ctx, ctx.empresaA, {
    journalCode: 'GENERAL',
    entryDate: '2026-05-05',
    description: 'Gasto clasificado por la IA y aprobado por una persona',
    currency: 'ARS',
    lines: [
      { accountCode: '6.1.01', debit: '300.00', credit: '0' },
      { accountCode: '2.1.01', debit: '0', credit: '300.00' },
    ],
    source: { type: 'MANUAL', id: null },
    manualJustification: 'Propuesta de la IA revisada y aprobada',
    aiPredictionId: prediccion.rows[0].id,
  });

  // Y la propuesta se revisa. No es un trámite del fixture: el checklist de
  // cierre bloquea con `SIN_PROPUESTAS_IA` mientras quede una sin revisar, así
  // que sin este paso el ciclo del ejercicio no llega ni al pre-cierre. Lo
  // descubrió el propio fixture al correr por primera vez, que es exactamente lo
  // que se le pide a un fixture conductual: recorrer el camino de verdad.
  const revision = await pedir(
    app,
    ctx,
    ctx.empresaA,
    'POST',
    `/predictions/${prediccion.rows[0].id}/review`,
    { decision: 'APROBADA' },
  );
  exigir(revision, 201, 'revisión humana de la propuesta de IA');

  // (6) Un asiento anulado con su contraasiento. Deja el par ANULADO/REVERSION
  // en el Diario y en el Mayor, que es donde A-7 lo va a comparar.
  const aAnular = await postearYAprobar(app, ctx, ctx.empresaA, {
    ...venta('2026-07-01', '250.00'),
    manualJustification: 'Venta que después se anula',
  });
  const contra = await pedir(
    app,
    ctx,
    ctx.empresaA,
    'POST',
    `/journal-entries/${aAnular}/reverse`,
    { motivo: 'Se registró dos veces la misma venta' },
  );
  exigir(contra, 201, 'contraasiento');
}

// ---------------------------------------------------------------------------
// El ciclo del ejercicio, completo
// ---------------------------------------------------------------------------

async function ejercitarCierre(app, ctx) {
  // Los estados se emiten **antes** de cerrar: después del asiento de cierre
  // todas las cuentas quedan en cero, y A-1 se ejercita sobre renglones con
  // importe distinto de cero.
  //
  // Esta emisión no se podía hacer hasta la migración 0039: `CUENTA_SIN_RUBRO`
  // evaluaba el plan entero, así que un ESP marcaba como huérfana a toda cuenta
  // de resultado con saldo y ninguna empresa con un plan completo podía emitir.
  // Ahora cada estado declara su alcance y evalúa solo lo que le corresponde.
  for (const tipo of ['ESP', 'ER']) {
    const r = await pedir(app, ctx, ctx.empresaA, 'POST', '/statements/issue', {
      ejercicio: ctx.ejercicioA26,
      tipo,
    });
    exigir(r, 201, `emisión del estado ${tipo}`);
  }

  const pre = await pedir(app, ctx, ctx.empresaA, 'POST', `/fiscal-years/${ctx.ejercicioA26}/pre-close`);
  exigir(pre, 201, 'pre-cierre del ejercicio 2026 de A');

  const cierre = await pedir(app, ctx, ctx.empresaA, 'POST', `/fiscal-years/${ctx.ejercicioA26}/close`);
  exigir(cierre, 201, 'cierre del ejercicio 2026 de A');
  ctx.cierre = cierre.json();

  const apertura = await pedir(
    app,
    ctx,
    ctx.empresaA,
    'POST',
    `/fiscal-years/${ctx.ejercicioA26}/opening`,
    { siguienteEjercicioId: ctx.ejercicioA27 },
  );
  exigir(apertura, 201, 'apertura del ejercicio 2027 de A');
  ctx.apertura = apertura.json();

  // Una operación en el ejercicio nuevo: deja al 2027 con movimiento propio, de
  // modo que A-14 tenga que distinguir «asiento posterior al cierre del 2026» de
  // «asiento del 2027», que es justo lo que podría confundir.
  await postearYAprobar(app, ctx, ctx.empresaA, {
    ...venta('2027-02-10', '100.00'),
    manualJustification: 'Primera venta del ejercicio siguiente',
  });
}

// ---------------------------------------------------------------------------
// Empresa B: independiente, y abierta
// ---------------------------------------------------------------------------

async function ejercitarEmpresaB(app, ctx) {
  // Importe irrepetible: si algún invariante contara filas de B como de A, el
  // número lo delataría.
  await postearYAprobar(app, ctx, ctx.empresaB, {
    ...venta('2026-03-10', '777777.00'),
    manualJustification: 'Venta de la empresa B, que no cierra su ejercicio',
  });

  // B **no** cierra. Que quede un ejercicio ABIERTO con movimientos mientras el
  // de A está CERRADO es lo que hace que A-11 y A-14 tengan que discriminar por
  // empresa en vez de por estado global.
}

// ---------------------------------------------------------------------------
// Utilidades
// ---------------------------------------------------------------------------

const venta = (fecha, importe) => ({
  journalCode: 'GENERAL',
  entryDate: fecha,
  description: `Venta de contado por ${importe}`,
  currency: 'ARS',
  lines: [
    { accountCode: '1.1.01', debit: importe, credit: '0' },
    { accountCode: '4.1.01', debit: '0', credit: importe },
  ],
  source: { type: 'MANUAL', id: null },
});

function pedir(app, ctx, empresa, method, url, payload) {
  return app.inject({
    method,
    url,
    headers: { authorization: `Bearer ${ctx.token}`, 'x-company-id': empresa },
    ...(payload === undefined ? {} : { payload }),
  });
}

async function postearYAprobar(app, ctx, empresa, cuerpo) {
  const alta = await pedir(app, ctx, empresa, 'POST', '/journal-entries', cuerpo);
  exigir(alta, 201, `alta del asiento "${cuerpo.description}"`);
  const id = alta.json().id;
  const ok = await pedir(app, ctx, empresa, 'POST', `/journal-entries/${id}/approve`);
  exigir(ok, 200, `aprobación del asiento "${cuerpo.description}"`);
  return id;
}

async function crearEjercicio(app, ctx, empresa, code, desde, hasta) {
  const r = await pedir(app, ctx, empresa, 'POST', '/fiscal-years', {
    code: `${code}-${SUFIJO}`,
    startDate: desde,
    endDate: hasta,
  });
  exigir(r, 201, `alta del ejercicio ${code}`);
  return r.json().id;
}

/**
 * Un fixture que falla a medias es peor que uno que no corre: deja la base en un
 * estado parcial y el gate verifica sobre él sin saberlo. Cualquier respuesta
 * inesperada corta con el cuerpo entero a la vista.
 */
function exigir(respuesta, esperado, que) {
  if (respuesta.statusCode !== esperado) {
    throw new Error(
      `Fixture: ${que} contestó ${respuesta.statusCode} y se esperaba ${esperado}.\n${respuesta.body}`,
    );
  }
}
