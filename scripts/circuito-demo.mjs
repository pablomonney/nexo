#!/usr/bin/env node
/**
 * Muestra el circuito completo sobre un comprobante real del corpus.
 *
 *   npm run circuito:demo
 *
 * No escribe nada: lee el comprobante, arma los hechos, consulta el estado de
 * las reglas en la base y **imprime la decisión**. Es el mismo camino que
 * ejercita `tests/integration/circuito-completo.test.ts`, pero legible.
 *
 * Existe porque una decisión contable que no se puede leer no sirve, aunque los
 * tests pasen. Lo que se ve acá es lo que vería un contador.
 */

import { readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import pg from 'pg';

import { money } from '@aai/shared';
import { decidir, explicarDecision } from '@aai/accounting-engine';

const RAIZ = resolve(join(dirname(fileURLToPath(import.meta.url)), '..'));
try {
  process.loadEnvFile(join(RAIZ, '.env'));
} catch {
  /* en CI las variables vienen del entorno */
}

const CLAVE = 'AR-IVA-CF-VINCULACION-001';

let comprobantes;
try {
  comprobantes = JSON.parse(
    readFileSync(join(RAIZ, 'var', 'corpus-homologacion', 'comprobantes.json'), 'utf8'),
  );
} catch {
  console.error('No hay corpus en var/corpus-homologacion/. Corré `npm run comprobantes:generar`.');
  process.exit(2);
}

const c = comprobantes[0];
const fecha = `${c.cbteFch.slice(0, 4)}-${c.cbteFch.slice(4, 6)}-${c.cbteFch.slice(6, 8)}`;
const totalCentavos = BigInt(Math.round(c.impTotal * 100));

console.log('COMPROBANTE (del corpus de homologación, con CAE real)');
console.log(`  Factura C ${String(c.ptoVta).padStart(4, '0')}-${String(c.cbteNro).padStart(8, '0')}`);
console.log(`  fecha ${fecha} · total $${c.impTotal.toLocaleString('es-AR')} ${c.moneda}`);
console.log(`  CAE ${c.cae} (vence ${c.caeFchVto})`);
console.log(`  receptor: DocTipo ${c.docTipo} — consumidor final sin identificar`);
console.log('');
console.log('LO QUE EL COMPROBANTE NO TRAE');
console.log('  · IVA discriminado — la clase C no lo discrimina');
console.log('  · identificación del receptor');
console.log('  · destino o aplicación de la operación');
console.log('');

// El estado de las reglas se lee de la base, no se supone.
const db = new pg.Client({ connectionString: process.env.DATABASE_URL });
await db.connect();
const regla = await db.query(
  `SELECT r.rule_key, r.version, r.status, r.action, d.sha256, n.organismo, n.tipo, n.numero
     FROM accounting_rules r
     JOIN norm_versions v ON v.id = r.norm_version_id
     JOIN norms n ON n.id = v.norm_id
     LEFT JOIN norm_documents d ON d.norm_version_id = v.id
    WHERE r.rule_key = $1`,
  [CLAVE],
);
await db.end();

const reglas =
  regla.rowCount === 0
    ? []
    : [
        {
          ruleKey: regla.rows[0].rule_key,
          version: regla.rows[0].version,
          estado: regla.rows[0].status === 'ACTIVE' ? 'APLICADA' : 'DESCARTADA',
          motivo: `La regla está en estado ${regla.rows[0].status}`,
          cita: {
            organismo: regla.rows[0].organismo,
            norma: `${regla.rows[0].tipo} ${regla.rows[0].numero}`,
            articulo: regla.rows[0].action?._cita?.articulo ?? '?',
            inciso: regla.rows[0].action?._cita?.inciso ?? null,
            documentoSha256: regla.rows[0].sha256 ?? '',
          },
        },
      ];

const decision = decidir(
  {
    comprobante: {
      taxTransactionId: '(no persistido en esta demo)',
      documentId: null,
      companyId: '(demo)',
      direccion: 'VENTAS',
      cuitContraparte: c.cuitEmisor,
      razonSocial: 'Consumidor final',
      cbteTipo: c.cbteTipo,
      letra: 'C',
      puntoVenta: c.ptoVta,
      numero: c.cbteNro,
      fecha,
      moneda: 'ARS',
      neto: money(totalCentavos, 'ARS'),
      iva: money(0n, 'ARS'),
      total: money(totalCentavos, 'ARS'),
      cae: c.cae,
      caeVencimiento: c.caeFchVto,
    },
    sello: { estado: 'APROBADO', motivo: 'CAE emitido por ARCA en homologación' },
    // Sin declaración profesional cargada para este comprobante: el hecho no está.
    hechosProfesionales: [],
    reglas,
    revisionesPrevias: [
      {
        motivo: 'SIN_HECHO_REQUERIDO',
        detalle:
          'No hay declaración de afectación para esta operación. `vinculadaConOperacionesGravadas` ' +
          'no se puede deducir del comprobante: lo declara quien conoce la operación.',
      },
    ],
  },
  () => [],
  'sistema:circuito-demo',
);

console.log(explicarDecision(decision));
console.log('');
console.log('─────────────────────────────────────────────────────────');
console.log('No se generó asiento, y esa es la respuesta correcta para este comprobante.');
console.log('Un asiento igual habría requerido inventar el hecho que falta.');
