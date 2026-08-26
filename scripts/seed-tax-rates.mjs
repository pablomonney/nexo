#!/usr/bin/env node
/**
 * Siembra de alícuotas de IVA.
 *
 *   npm run tax:seed
 *
 * Las alícuotas salen del **art. 28 de la Ley de Impuesto al Valor Agregado,
 * texto ordenado en 1997** (Decreto 280/97), archivada con hash en
 * `INFOLEG_LEY_IVA_23349_TO_1997_texto_actualizado.htm`. Hasta que ese documento
 * entró al archivo, `tax_rates` estaba vacía a propósito y el motor respondía
 * `SIN_ALICUOTAS_RELEVADAS` en vez de suponer 21%.
 *
 * ## Por qué las alícuotas empiezan en 2003-01-18 y no antes
 *
 * Es la parte que importa entender antes de tocar este archivo.
 *
 * El documento archivado es un **texto actualizado**: dice qué establece el art.
 * 28 *hoy*, y sus antecedentes normativos figuran listados pero **no
 * transcriptos**. Que el primer párrafo diga hoy "veintiuno por ciento" no
 * prueba que dijera veintiuno en 2010, ni en 1999.
 *
 * Lo único que el documento sí permite afirmar sobre el pasado es lo que
 * transcribe en su propia Nota Infoleg: el art. 1° del **Decreto N° 2312/2002**
 * (B.O. 15/11/2002) fijó la alícuota en 19% *"para los hechos imponibles que se
 * perfeccionen a partir del 18 de noviembre de 2002 y hasta el 17 de enero de
 * 2003, ambas fechas, inclusive"*. Esa ventana cerrada es la que ancla el resto:
 * el 18 de enero de 2003 vuelve a regir el texto del artículo.
 *
 * Para hechos imponibles anteriores al 2002-11-18 el motor sigue respondiendo
 * `SIN_ALICUOTAS_RELEVADAS`. Es correcto: nadie relevó qué decía el artículo
 * entonces, y una alícuota inventada para 1998 se ve exactamente igual que una
 * verificada.
 *
 * ## Por qué la reducida es 21/200 y no 105/1000
 *
 * El art. 28 no dice "diez coma cinco por ciento". Dice *"una alícuota
 * equivalente al cincuenta por ciento (50%) de la establecida en el primer
 * párrafo"*. La razón entera 21/200 **es** esa frase; 0,105 es una traducción
 * nuestra. Cuando la general fue 19%, la reducida fue 19/200 — y la propia Nota
 * Infoleg lo aclara para no dejarlo librado a interpretación.
 */

import { existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import pg from 'pg';

const AQUI = dirname(fileURLToPath(import.meta.url));
if (existsSync(join(AQUI, '..', '.env'))) {
  process.loadEnvFile(join(AQUI, '..', '.env'));
}

const connectionString = process.env.DATABASE_URL ?? '';
if (connectionString === '') {
  console.log('tax:seed — sin DATABASE_URL. Nada que sembrar.');
  process.exit(0);
}

/** La norma de la que sale cada alícuota. Sin ella no se siembra ninguna. */
const NORMA = { organismo: 'CONGRESO', tipo: 'LEY', numero: '23349' };

/**
 * Las alícuotas del art. 28, por ventana de vigencia.
 *
 * `valid_to` cerrado significa que la ventana terminó y está relevada. `null`
 * significa que sigue abierta *según el texto archivado* — no que sea eterna.
 */
const ALICUOTAS = [
  {
    label: 'General 19% (Decreto 2312/2002)',
    numerator: 19n,
    denominator: 100n,
    validFrom: '2002-11-18',
    validTo: '2003-01-17',
    articulo:
      'Art. 28, Nota Infoleg que transcribe el art. 1° del Decreto N° 2312/2002 (B.O. 15/11/2002)',
  },
  {
    label: 'Reducida 9,5% — 50% de la general (Decreto 2312/2002)',
    numerator: 19n,
    denominator: 200n,
    validFrom: '2002-11-18',
    validTo: '2003-01-17',
    articulo:
      'Art. 28, Nota Infoleg del art. 1° del Decreto N° 2312/2002: aclara que en esa ventana el 50% se calcula sobre la alícuota reducida al 19%',
  },
  {
    label: 'General 21%',
    numerator: 21n,
    denominator: 100n,
    validFrom: '2003-01-18',
    validTo: null,
    articulo: 'Art. 28, primer párrafo',
  },
  {
    label: 'Reducida 10,5% — 50% de la general',
    numerator: 21n,
    denominator: 200n,
    validFrom: '2003-01-18',
    validTo: null,
    articulo:
      'Art. 28, cuarto párrafo: "una alícuota equivalente al cincuenta por ciento (50%) de la establecida en el primer párrafo"',
  },
  {
    label: 'Incrementada 27% — gas, energía eléctrica y aguas por medidor',
    numerator: 27n,
    denominator: 100n,
    // No se extiende hacia atrás de 2003-01-18 aunque el Decreto 2312/2002 solo
    // haya tocado el primer párrafo: deducir que el 27% siguió intacto durante
    // esa ventana es leer entre líneas, y este archivo no lee entre líneas.
    validFrom: '2003-01-18',
    validTo: null,
    articulo: 'Art. 28, segundo párrafo',
  },
];

const client = new pg.Client({ connectionString });
await client.connect();

try {
  const norma = await client.query(
    `SELECT v.id, n.titulo
       FROM norm_versions v
       JOIN norms n ON n.id = v.norm_id
      WHERE n.organismo = $1 AND n.tipo = $2 AND n.numero = $3
      ORDER BY v.version DESC LIMIT 1`,
    [NORMA.organismo, NORMA.tipo, NORMA.numero],
  );

  if (norma.rows.length === 0) {
    console.log('');
    console.log('Alícuotas sembradas: 0. La Ley de IVA no está sembrada en `norms`.');
    console.log('');
    console.log('  Corré `npm run norms:seed` primero. Si tampoco la carga, revisá que');
    console.log('  INFOLEG_LEY_IVA_23349_TO_1997_texto_actualizado.htm tenga su fila en');
    console.log('  docs/normative-sources/vigencias.csv con fecha_emision verificada.');
    console.log('');
    console.log('  El motor sigue respondiendo SIN_ALICUOTAS_RELEVADAS, que es correcto:');
    console.log('  es la diferencia entre un sistema que no sabe y uno que supone 21%.');
    process.exit(0);
  }

  const normVersionId = norma.rows[0].id;
  const iva = await client.query(`SELECT id FROM taxes WHERE code = 'IVA'`);
  const taxId = iva.rows[0].id;

  const nuevas = [];
  const yaEstaban = [];

  await client.query('BEGIN');

  for (const alicuota of ALICUOTAS) {
    // La 0021 prohíbe reescribir una alícuota publicada: se cierra con valid_to y
    // se carga la nueva. Por eso acá no hay UPDATE — solo se inserta lo que falta.
    const existente = await client.query(
      `SELECT id FROM tax_rates
        WHERE tax_id = $1 AND numerator = $2 AND denominator = $3 AND valid_from = $4`,
      [taxId, alicuota.numerator, alicuota.denominator, alicuota.validFrom],
    );

    if (existente.rows.length > 0) {
      yaEstaban.push(alicuota.label);
      continue;
    }

    await client.query(
      `INSERT INTO tax_rates
         (tax_id, label, numerator, denominator, valid_from, valid_to,
          norm_version_id, articulo, created_by)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, 'seed-tax-rates')`,
      [
        taxId,
        alicuota.label,
        alicuota.numerator,
        alicuota.denominator,
        alicuota.validFrom,
        alicuota.validTo,
        normVersionId,
        alicuota.articulo,
      ],
    );
    nuevas.push(alicuota.label);
  }

  await client.query('COMMIT');

  console.log('');
  console.log(`Alícuotas sembradas: ${nuevas.length}${yaEstaban.length > 0 ? ` (${yaEstaban.length} ya estaban)` : ''}`);
  for (const label of nuevas) console.log(`  + ${label}`);
  for (const label of yaEstaban) console.log(`  = ${label}`);

  console.log('');
  console.log('Todas citan: ' + norma.rows[0].titulo);
  console.log('');
  console.log('Lo que el motor sigue SIN poder responder, y hay que saberlo:');
  console.log('');
  console.log('  · Hechos imponibles anteriores al 2002-11-18 → SIN_ALICUOTAS_RELEVADAS.');
  console.log('    El texto archivado es un texto ACTUALIZADO: sus antecedentes están');
  console.log('    listados pero no transcriptos, y nadie relevó qué decía el art. 28');
  console.log('    entonces.');
  console.log('');
  console.log('  · QUÉ operación va a cada alícuota. El art. 28 enumera bienes y');
  console.log('    servicios; mapearlos a un plan de cuentas es trabajo normativo con');
  console.log('    revisión humana. El motor identifica la alícuota desde el IVA que el');
  console.log('    comprobante discrimina — no la elige por el rubro.');
} catch (error) {
  await client.query('ROLLBACK');
  throw error;
} finally {
  await client.end();
}
