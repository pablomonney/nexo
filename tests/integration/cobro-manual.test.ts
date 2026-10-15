/**
 * Cobro manual por transferencia: el script del operador contra una base real.
 *
 * Se ejecuta `scripts/cobro-manual.mjs` de verdad (un proceso por comando) sobre documentos de facturación creados por el
 * ciclo, y se comprueba lo que importa del lado de la base: el documento queda PAGADO una sola vez, el importe tiene que ser
 * exacto, la referencia es obligatoria, un reintento no duplica, y lo que sólo informa no escribe.
 */

import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { correrCiclo } from '@aai/api/billing/ciclo';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { connect, hasDatabase, seed, type Client, type Fixture } from './helpers/db.js';
import { sufijoUnico } from './helpers/identificadores.js';

const suite = hasDatabase ? describe : describe.skip;
const RAIZ = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const SCRIPT = join(RAIZ, 'scripts', 'cobro-manual.mjs');

const txDe = (db: Client) => ({ query: (text: string, values?: readonly unknown[]) => db.query(text, values as unknown[]) });

function cli(...args: string[]) {
  const r = spawnSync(process.execPath, [SCRIPT, ...args], {
    cwd: RAIZ,
    env: { PATH: process.env['PATH'] ?? '', DATABASE_URL: process.env['DATABASE_URL'] ?? '', USERNAME: 'prueba' },
    encoding: 'utf8',
    timeout: 60_000,
  });
  return { codigo: r.status, salida: `${r.stdout}${r.stderr}` };
}

suite('Cobro manual por transferencia', () => {
  let db: Client;
  let fx: Fixture;
  let planId: string;
  let stamp: string;
  let carpeta: string;

  beforeAll(async () => {
    db = await connect();
    fx = await seed(db, 'cobro-manual');
    stamp = await sufijoUnico(db);
    planId = (await db.query<{ id: string }>("SELECT id FROM subscription_plans WHERE code = 'PYME'")).rows[0]!.id;
    carpeta = mkdtempSync(join(tmpdir(), 'cobro-manual-'));
  });

  afterAll(async () => {
    await db?.end();
    rmSync(carpeta, { recursive: true, force: true });
  });

  /** Una empresa con una suscripción y su cargo ya emitido (por el ciclo, como en producción). */
  async function documentoEmitido(importe: string, desde = '2026-05-01'): Promise<{ id: string; numero: string; empresa: string; cuit: string }> {
    const sufijo = await sufijoUnico(db);
    const emp = await db.query<{ id: string; cuit: string }>(
      `INSERT INTO companies (organization_id, legal_name, cuit, entity_type, jurisdiction, regulator, fiscal_year_end)
       VALUES ($1, $2, $3, 'SRL', 'AR-C', 'IGJ', '12-31') RETURNING id, cuit`,
      [fx.organizationId, `Cliente de cobro ${sufijo}`, `30${sufijo}4`],
    );
    const sub = await db.query<{ id: string }>(
      `INSERT INTO company_subscriptions (company_id, plan_id, estado, vigencia_desde, created_by, periodicidad, moneda, importe_acordado, proxima_facturacion)
       VALUES ($1, $2, 'ACTIVA', $3::date, 'test', 'MENSUAL', 'ARS', $4::numeric, $3::date) RETURNING id`,
      [emp.rows[0]!.id, planId, desde, importe],
    );
    await correrCiclo(txDe(db), desde, 'test:ciclo', { soloOrganizacion: fx.organizationId });
    const doc = await db.query<{ id: string; numero: string }>('SELECT id, numero::text FROM billing_documents WHERE subscription_id = $1', [sub.rows[0]!.id]);
    return { id: doc.rows[0]!.id, numero: doc.rows[0]!.numero, empresa: `Cliente de cobro ${sufijo}`, cuit: emp.rows[0]!.cuit };
  }

  /** La referencia bancaria es única por proveedor (0096): una transferencia paga UN documento. Cada corrida usa las suyas. */
  const ref = (n: string): string => `OP-${stamp}-${n}`;

  const estadoDe = async (id: string): Promise<string> => (await db.query<{ estado: string }>('SELECT estado FROM billing_documents WHERE id = $1', [id])).rows[0]!.estado;
  const intentos = async (id: string): Promise<number> => Number((await db.query<{ n: string }>('SELECT count(*)::text AS n FROM payment_intents WHERE document_id = $1', [id])).rows[0]!.n);

  it('pendientes lista el cargo emitido y NO escribe', async () => {
    const d = await documentoEmitido('3210.00');
    const antes = await db.query<{ n: string }>('SELECT count(*)::text AS n FROM payment_intents');
    const r = cli('pendientes');
    expect(r.codigo, r.salida).toBe(0);
    expect(r.salida).toContain(`N.° ${d.numero}`);
    expect(r.salida).toContain(d.empresa);
    expect((await db.query<{ n: string }>('SELECT count(*)::text AS n FROM payment_intents')).rows[0]!.n).toBe(antes.rows[0]!.n);
  });

  it('registrar SIN --confirmar es un simulacro: no cambia nada', async () => {
    const d = await documentoEmitido('1500.00');
    const r = cli('registrar', '--documento', d.numero, '--importe', '1500.00', '--fecha', '2026-05-03', '--referencia', ref('000111'));
    expect(r.codigo, r.salida).toBe(0);
    expect(r.salida).toContain('SIMULACRO');
    expect(await estadoDe(d.id)).toBe('EMITIDO');
    expect(await intentos(d.id)).toBe(0);
  });

  it('con --confirmar y el importe exacto: queda PAGADO, con su referencia, y el comprobante lo dice', async () => {
    const d = await documentoEmitido('2000.00');
    const r = cli('registrar', '--documento', d.numero, '--importe', '2.000,00', '--fecha', '2026-05-03', '--referencia', ref('000222'), '--confirmar');
    expect(r.codigo, r.salida).toBe(0);
    expect(r.salida).toContain('REGISTRADO');
    expect(await estadoDe(d.id)).toBe('PAGADO');

    const pago = await db.query<{ proveedor: string; referencia_externa: string; estado: string }>(
      'SELECT proveedor, referencia_externa, estado FROM payment_intents WHERE document_id = $1',
      [d.id],
    );
    expect(pago.rows).toEqual([{ proveedor: 'TRANSFERENCIA', referencia_externa: ref('000222'), estado: 'PAGADO' }]);
    const auditoria = await db.query<{ n: string }>("SELECT count(*)::text AS n FROM audit_logs WHERE action = 'REGISTRAR_COBRO' AND object_id = $1", [d.id]);
    expect(auditoria.rows[0]!.n).toBe('1');

    const salida = join(carpeta, `comprobante-${d.numero}.txt`);
    const c = cli('comprobante', '--documento', d.numero, '--salida', salida);
    expect(c.codigo, c.salida).toBe(0);
    const texto = readFileSync(salida, 'utf8');
    expect(texto).toContain('NO ES UN COMPROBANTE FISCAL');
    expect(texto).toContain(d.empresa);
    expect(texto).toContain('ARS 2000.00');
    expect(texto).toContain(ref('000222'));
    expect(texto).toMatch(/Huella \(SHA-256 del texto de arriba\): [0-9a-f]{64}/u);
  });

  it('repetir el registro con la MISMA referencia no duplica el cobro; con OTRA sobre un documento pagado, se rechaza', async () => {
    const d = await documentoEmitido('900.00');
    const args = ['registrar', '--documento', d.numero, '--importe', '900.00', '--fecha', '2026-05-04', '--confirmar'];
    expect(cli(...args, '--referencia', ref('000333')).codigo).toBe(0);

    const repetido = cli(...args, '--referencia', ref('000333').toLowerCase());
    expect(repetido.codigo, repetido.salida).toBe(0);
    expect(repetido.salida).toContain('YA ESTABA REGISTRADO');
    expect(await intentos(d.id)).toBe(1);

    const otra = cli(...args, '--referencia', ref('000444'));
    expect(otra.codigo, otra.salida).toBe(3);
    expect(otra.salida).toContain('NO SE REGISTRÓ');
    expect(await intentos(d.id)).toBe(1);
  });

  it('la misma referencia bancaria en OTRO documento se rechaza con un mensaje claro: una transferencia paga un solo documento', async () => {
    const a = await documentoEmitido('610.00');
    const b = await documentoEmitido('610.00');
    const comun = ['registrar', '--importe', '610.00', '--fecha', '2026-05-04', '--referencia', ref('000777'), '--confirmar'];
    expect(cli(...comun, '--documento', a.numero).codigo).toBe(0);
    const r = cli(...comun, '--documento', b.numero);
    expect(r.codigo, r.salida).toBe(3);
    expect(r.salida).toContain('ya está en OTRO cobro');
    expect(await estadoDe(b.id)).toBe('EMITIDO');
    expect(await intentos(b.id)).toBe(0);
  });

  it('un importe distinto (parcial o de más) NO se registra', async () => {
    const d = await documentoEmitido('1000.00');
    for (const importe of ['999.99', '1000.01', '500.00']) {
      const r = cli('registrar', '--documento', d.numero, '--importe', importe, '--fecha', '2026-05-03', '--referencia', ref('000555'), '--confirmar');
      expect(r.codigo, r.salida).toBe(3);
      expect(r.salida).toContain('no es el del documento');
    }
    expect(await estadoDe(d.id)).toBe('EMITIDO');
    expect(await intentos(d.id)).toBe(0);
  });

  it('sin referencia, con fecha futura o anterior a la emisión: no se registra', async () => {
    const d = await documentoEmitido('1100.00');
    const base = ['registrar', '--documento', d.numero, '--importe', '1100.00', '--confirmar'];
    expect(cli(...base, '--fecha', '2026-05-03').codigo).toBe(2); // falta la referencia
    expect(cli(...base, '--fecha', '2099-01-01', '--referencia', ref('000666')).codigo).toBe(3); // futura
    expect(cli(...base, '--fecha', '2026-04-30', '--referencia', ref('000666')).codigo).toBe(3); // antes de emitir
    expect(await estadoDe(d.id)).toBe('EMITIDO');
  });

  it('un documento que no existe, o sin pagar, no da comprobante', async () => {
    const d = await documentoEmitido('1200.00');
    expect(cli('comprobante', '--documento', d.numero).codigo).toBe(3);
    expect(cli('comprobante', '--documento', '999999999').codigo).toBe(3);
  });

  /** Un importe que ningún documento de corridas anteriores (la base se arrastra) tiene: si no, «única» daría «ambigua». */
  const importeUnico = (): string => `${20_000 + Math.floor(Math.random() * 70_000)}.${String(Math.floor(Math.random() * 100)).padStart(2, '0')}`;
  const esAr = (importe: string): string => {
    const [entero, dec] = importe.split('.') as [string, string];
    return `${entero.replace(/B(?=(d{3})+(?!d))/gu, '.')},${dec}`;
  };

  it('conciliar propone y NO escribe: única, ambigua, sin documento y ya registrada', async () => {
    const [iU, iA, iYa] = [importeUnico(), importeUnico(), importeUnico()];
    const iS = '0.07'; // ningún cargo vale siete centavos
    const unica = await documentoEmitido(iU);
    const a = await documentoEmitido(iA);
    const b = await documentoEmitido(iA);
    const ya = await documentoEmitido(iYa);
    expect(cli('registrar', '--documento', ya.numero, '--importe', iYa, '--fecha', '2026-05-03', '--referencia', `OP-YA-${stamp}`, '--confirmar').codigo).toBe(0);

    const csv = join(carpeta, 'extracto.csv');
    writeFileSync(
      csv,
      [
        'fecha;descripcion;importe;referencia',
        `2026-05-05;TRANSFERENCIA RECIBIDA;${esAr(iU)};OP-U-1`,
        `2026-05-05;TRANSFERENCIA RECIBIDA;${esAr(iA)};OP-A-1`,
        `2026-05-05;TRANSFERENCIA ${b.cuit} PAGO;${esAr(iA)};OP-A-2`,
        `2026-05-05;TRANSFERENCIA RECIBIDA;${esAr(iS)};OP-S-1`,
        `2026-05-05;TRANSFERENCIA RECIBIDA;${esAr(iYa)};OP-YA-${stamp}`,
        '2026-05-06;DEBITO COMISION;-150,00;',
      ].join('\n'),
    );
    const antes = await db.query<{ n: string }>('SELECT count(*)::text AS n FROM payment_intents');
    const r = cli('conciliar', '--extracto', csv);
    expect(r.codigo, r.salida).toBe(0);
    expect(r.salida).toContain(`UNICA: documento N.° ${unica.numero}`);
    expect(r.salida).toMatch(new RegExp(`AMBIGUA: .*N\\.° ${a.numero}.*N\\.° ${b.numero}|AMBIGUA: .*N\\.° ${b.numero}.*N\\.° ${a.numero}`, 'u'));
    expect(r.salida).toContain(`UNICA: documento N.° ${b.numero}`); // la desambiguó el CUIT del texto
    expect(r.salida).toContain('elegido por el CUIT');
    expect(r.salida).toContain('SIN DOCUMENTO');
    expect(r.salida).toContain('YA REGISTRADO');
    expect(r.salida).toContain('Esto sólo PROPONE');
    expect((await db.query<{ n: string }>('SELECT count(*)::text AS n FROM payment_intents')).rows[0]!.n).toBe(antes.rows[0]!.n);
  });

  it('un subcomando desconocido o ninguno: uso y código de salida correcto', () => {
    expect(cli().codigo).toBe(0);
    expect(cli('--help').codigo).toBe(0);
    expect(cli('borrar-todo').codigo).toBe(2);
  });
});
