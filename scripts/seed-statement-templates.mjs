#!/usr/bin/env node
/**
 * Siembra de plantillas de estados contables.
 *
 *   npm run statements:seed
 *
 * Las estructuras salen de la **Ley 19.550 (T.O. 1984), arts. 63 y 64**,
 * archivada con sha256 en `INFOLEG_LGS_19550_texto_actualizado.htm`. Viven en
 * `scripts/statement-templates.mjs`, donde cada rubro cita su inciso.
 *
 * ## Por qué este script tardó tanto en poder correr
 *
 * `statement_templates.norm_version_id` es `NOT NULL`, y la Ley 19.550 no se
 * sembraba: su texto actualizado declara la **publicación** del Decreto 841/84
 * (30/03/1984) y no su dictado, y `norm_versions.fecha_emision` también es NOT
 * NULL. Completar una con la otra habría sido afirmar un hecho que nadie
 * verificó, así que la norma quedaba afuera y esta tabla vacía río abajo.
 *
 * Se destrabó archivando la **ficha oficial del Decreto 841/84**, que sí declara
 * el dictado: 20/03/1984. Un documento más, no un campo completado de memoria.
 *
 * ## Lo que el script sigue sin hacer solo
 *
 * Validar. Toda plantilla pasa por `validarPlantilla()` antes de insertarse, y si
 * hay un error no se inserta ninguna. La estructura viene de un archivo del
 * repositorio, pero termina en una columna `jsonb` que el motor lee en cada
 * emisión: confiar en que está bien formada porque la escribimos nosotros es
 * exactamente la confianza que el validador existe para no necesitar.
 */

import { existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import pg from 'pg';

import { validarPlantilla } from '@aai/financial-statements';
import {
  ALCANCE,
  CONVENCION_DE_CODIGOS,
  LO_QUE_ESTAS_PLANTILLAS_NO_EXPONEN,
  PLANTILLAS,
} from './statement-templates.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
if (existsSync(join(HERE, '..', '.env'))) {
  process.loadEnvFile(join(HERE, '..', '.env'));
}

const DATABASE_URL = process.env.DATABASE_URL ?? '';
if (DATABASE_URL === '') {
  console.log('statements:seed — sin DATABASE_URL. Nada que sembrar.');
  process.exit(0);
}

const NORMA = { organismo: 'CONGRESO', tipo: 'LEY', numero: '19550' };

/**
 * Forma canónica de un árbol, para comparar lo que hay con lo que iría.
 *
 * `jsonb` no conserva el orden de las claves, así que comparar el JSON tal cual
 * daría "distinto" en cada corrida y el script publicaría una versión nueva cada
 * vez. Se ordenan las claves de cada objeto; el orden de los arrays **sí**
 * importa —es el orden de los renglones del estado— y se respeta.
 */
function canonico(valor) {
  if (Array.isArray(valor)) return `[${valor.map(canonico).join(',')}]`;
  if (valor !== null && typeof valor === 'object') {
    const claves = Object.keys(valor).sort();
    return `{${claves.map((clave) => `${JSON.stringify(clave)}:${canonico(valor[clave])}`).join(',')}}`;
  }
  return JSON.stringify(valor);
}

const client = new pg.Client({ connectionString: DATABASE_URL });
await client.connect();

try {
  const norma = await client.query(
    `SELECT v.id
       FROM norm_versions v
       JOIN norms n ON n.id = v.norm_id
      WHERE n.organismo = $1 AND n.tipo = $2 AND n.numero = $3
      ORDER BY v.version DESC LIMIT 1`,
    [NORMA.organismo, NORMA.tipo, NORMA.numero],
  );

  if (norma.rows.length === 0) {
    console.log('');
    console.log('Plantillas sembradas: 0. La Ley 19.550 no está sembrada en `norms`.');
    console.log('');
    console.log('  Corré `npm run norms:seed`. Si tampoco la carga, revisá que');
    console.log('  INFOLEG_LGS_19550_texto_actualizado.htm tenga su fila en');
    console.log('  docs/normative-sources/vigencias.csv con fecha_emision verificada — la del');
    console.log('  Decreto 841/84 que aprobó el T.O., que surge de la ficha oficial archivada.');
    console.log('');
    console.log('  Mientras tanto el motor responde FUENTE NO ENCONTRADA en vez de armar una');
    console.log('  estructura por su cuenta.');
    process.exit(0);
  }

  const normVersionId = norma.rows[0].id;

  // ---------------------------------------------------------------------------
  // Validar antes de tocar la base
  // ---------------------------------------------------------------------------
  const problemas = [];
  for (const plantilla of PLANTILLAS) {
    const errores = validarPlantilla({
      id: `${plantilla.tipo}-${ALCANCE.marco}-${ALCANCE.tipoEnte}-${ALCANCE.regulador}`,
      tipo: plantilla.tipo,
      marco: ALCANCE.marco,
      tipoEnte: ALCANCE.tipoEnte,
      regulador: ALCANCE.regulador,
      version: 1,
      vigenteDesde: ALCANCE.vigenteDesde,
      vigenteHasta: null,
      normVersionId,
      articulo: plantilla.articulo,
      raiz: plantilla.raiz,
      alcance: plantilla.alcance,
      ...(plantilla.ecuacion === undefined ? {} : { ecuacion: plantilla.ecuacion }),
    });
    for (const error of errores) {
      problemas.push(`${plantilla.tipo} · ${error.codigo} en "${error.nodo}": ${error.mensaje}`);
    }
  }

  if (problemas.length > 0) {
    console.error('');
    console.error(`La validación encontró ${problemas.length} problema(s). No se sembró ninguna.`);
    console.error('');
    for (const problema of problemas) console.error(`  ✘ ${problema}`);
    console.error('');
    console.error('Se aborta entero y no plantilla por plantilla: un ESP sin su ER es un estado');
    console.error('contable incompleto, y dejarlo a medias es peor que no tener ninguno.');
    process.exit(1);
  }

  // ---------------------------------------------------------------------------
  // Insertar
  // ---------------------------------------------------------------------------
  const nuevas = [];
  const yaEstaban = [];
  const corregidas = [];

  await client.query('BEGIN');

  for (const plantilla of PLANTILLAS) {
    const previa = await client.query(
      `SELECT id, version, structure, valid_from::text AS valid_from, valid_to
         FROM statement_templates
        WHERE company_id IS NULL AND statement_kind = $1 AND framework = $2
          AND entity_type = $3 AND regulator = $4
        ORDER BY version DESC LIMIT 1`,
      [plantilla.tipo, ALCANCE.marco, ALCANCE.tipoEnte, ALCANCE.regulador],
    );

    const anterior = previa.rows[0];
    let version = 1;

    if (anterior !== undefined) {
      // `jsonb` reordena las claves, así que comparar el JSON tal cual daría
      // "distinto" siempre y el script publicaría una versión nueva en cada
      // corrida. Se compara una forma canónica.
      if (canonico(anterior.structure) === canonico(plantilla.raiz)) {
        yaEstaban.push(`${plantilla.tipo} v${anterior.version}`);
        continue;
      }

      // La estructura cambió. La base prohíbe reescribirla —y prohíbe borrarla—
      // porque hacerlo cambiaría todos los estados ya emitidos con ella. El
      // camino es el que la 0023 deja abierto: cerrar la vigente y publicar la
      // siguiente.
      //
      // Se cierra con `valid_to = valid_from`, una ventana de largo cero, y eso
      // es una afirmación precisa: **esta versión nunca tuvo un día aplicable**.
      // Corregir una plantilla defectuosa no es lo mismo que un cambio de norma:
      // el art. 63 no cambió, cambió nuestra transcripción. Cerrarla "desde hoy"
      // diría que hasta hoy era la correcta, y un estado de un ejercicio anterior
      // emitido mañana volvería a tomarla.
      if (anterior.valid_to === null) {
        await client.query('UPDATE statement_templates SET valid_to = valid_from WHERE id = $1', [
          anterior.id,
        ]);
      }
      version = anterior.version + 1;
      corregidas.push(`${plantilla.tipo}: v${anterior.version} → v${version}`);
    }

    await client.query(
      `INSERT INTO statement_templates
         (company_id, statement_kind, framework, entity_type, regulator, version,
          valid_from, structure, norm_version_id, articulo, created_by,
          scope_types, scope_fundamento, equation)
       VALUES (NULL, $1, $2, $3, $4, $5, $6, $7::jsonb, $8, $9, 'seed-statement-templates',
               $10, $11, $12::jsonb)`,
      [
        plantilla.tipo,
        ALCANCE.marco,
        ALCANCE.tipoEnte,
        ALCANCE.regulador,
        version,
        ALCANCE.vigenteDesde,
        JSON.stringify(plantilla.raiz),
        normVersionId,
        plantilla.articulo,
        // El alcance viaja con la plantilla desde la migración 0039: sin él, el
        // control de cobertura vuelve a evaluar el plan entero y marca como
        // huérfana a toda cuenta que el estado no trata.
        plantilla.alcance.tipos,
        plantilla.alcance.fundamento,
        plantilla.ecuacion === undefined ? null : JSON.stringify(plantilla.ecuacion),
      ],
    );
    nuevas.push(`${plantilla.tipo} v${version}`);
  }

  await client.query('COMMIT');

  console.log('');
  console.log(
    `Plantillas del sistema publicadas: ${nuevas.length}${yaEstaban.length > 0 ? ` (${yaEstaban.length} sin cambios)` : ''}`,
  );
  for (const etiqueta of nuevas) console.log(`  + ${etiqueta} — ${ALCANCE.tipoEnte} / ${ALCANCE.regulador} / ${ALCANCE.marco}`);
  for (const etiqueta of yaEstaban) console.log(`  = ${etiqueta}`);

  if (corregidas.length > 0) {
    console.log('');
    console.log('Versiones cerradas por corrección de la transcripción:');
    for (const etiqueta of corregidas) console.log(`  · ${etiqueta}`);
    console.log('');
    console.log('  Se cerraron con valid_to = valid_from: nunca tuvieron un día aplicable. El');
    console.log('  art. 63 no cambió — cambió nuestra transcripción, y son cosas distintas.');
    console.log('  Los estados ya emitidos con la versión anterior siguen apuntando a ella.');
  }

  console.log('');
  console.log('Estas plantillas ASUMEN esta codificación del plan de cuentas:');
  console.log('');
  for (const linea of CONVENCION_DE_CODIGOS) console.log(`  ${linea}`);
  console.log('');
  console.log('  El art. 63 pide separar créditos de bienes de cambio y bienes de uso de');
  console.log('  inmateriales, y eso no sale de `accounts.type`. Los selectores usan prefijos,');
  console.log('  así que una empresa con otra codificación NO puede usar estas plantillas.');
  console.log('');
  console.log('  Falla ruidosa, no silenciosa: el control CUENTA_SIN_RUBRO marca cada cuenta');
  console.log('  que ningún renglón capturó. Un plan que no sigue la convención produce un');
  console.log('  estado con decenas de cuentas señaladas, imposible de leer como correcto.');
  console.log('  Esa empresa carga la suya: statement_templates.company_id existe para eso.');

  console.log('');
  console.log('Lo que estas plantillas NO exponen, y el artículo sí exige:');
  console.log('');
  for (const gap of LO_QUE_ESTAS_PLANTILLAS_NO_EXPONEN) console.log(`  · ${gap}`);
  console.log('');
  console.log('  Ninguno se resuelve con un renglón más: los tres primeros piden datos que el');
  console.log('  plan de cuentas no lleva. Van en nota, que es la salida que el propio art. 64');
  console.log('  prevé cuando el monto no se expone en el cuerpo del estado.');

  console.log('');
  console.log(`Sin plantilla propia, los otros once tipos de ente siguen sin cobertura. Copiar`);
  console.log('la de una SA cambiándole la etiqueta sería afirmar que una cooperativa expone su');
  console.log('patrimonio igual, y la RT 62 capítulo 12 dice que no.');
} catch (error) {
  await client.query('ROLLBACK').catch(() => {});
  console.error(String(error instanceof Error ? error.message : error));
  process.exitCode = 1;
} finally {
  await client.end();
}
