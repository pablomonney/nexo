#!/usr/bin/env node
/**
 * Vigilancia normativa: qué apareció y no está archivado.
 *
 *   npm run norms:watch                       # usa las fuentes activas de la base
 *   npm run norms:watch -- --archivo lista.json   # una lista ya bajada, sin red
 *
 * El script compara lo que la fuente publicó contra lo que el archivo ya tiene y
 * **abre tareas**. No descarga documentos, no lee articulado y no escribe en
 * `norms`. Un candidato no se puede citar: el camino de candidato a norma pasa
 * por bajar el documento oficial, calcular su sha256 y registrarlo a mano.
 *
 * ## Por qué el modo sin red es el modo por defecto útil
 *
 * Salir a la red desde un script de mantenimiento tiene dos problemas. Uno es
 * técnico —el CKAN de datos.gob.ar cambia de esquema y el Boletín Oficial no
 * tiene un identificador estable por norma (R-22)—. El otro es de diseño: un
 * proceso automático que trae texto de un organismo es exactamente el que después
 * alguien "mejora" para que lo cargue solo.
 *
 * Así que la parte que decide —`vigilar()`— es una función pura sobre listas, y
 * traer la lista es un paso aparte que se puede hacer con `curl` y revisar antes
 * de pasársela.
 */

import { existsSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import pg from 'pg';

import { loQueUnCandidatoNoHabilita, vigilar } from '../packages/normative-engine/dist/index.js';

const HERE = dirname(fileURLToPath(import.meta.url));
if (existsSync(join(HERE, '..', '.env'))) {
  process.loadEnvFile(join(HERE, '..', '.env'));
}

const args = new Map();
for (let i = 2; i < process.argv.length; i += 2) {
  const key = process.argv[i]?.replace(/^--/, '');
  if (key !== undefined) args.set(key, process.argv[i + 1]);
}

const DATABASE_URL = process.env.DATABASE_URL ?? '';
if (DATABASE_URL === '') {
  console.log('norms:watch — sin DATABASE_URL no se puede saber qué está archivado.');
  process.exit(0);
}

const client = new pg.Client({ connectionString: DATABASE_URL });
await client.connect();

try {
  const archivadas = (
    await client.query(
      'SELECT organismo, tipo, numero, anio FROM norms ORDER BY organismo, numero',
    )
  ).rows;

  const fuentes = (
    await client.query('SELECT id, codigo, fuente, organismo, url FROM norm_watch_sources WHERE activa')
  ).rows;

  const archivoLocal = args.get('archivo');

  if (archivoLocal === undefined && fuentes.length === 0) {
    console.log('norms:watch — no hay fuentes activas configuradas.');
    console.log('');
    console.log(`Normas archivadas hoy: ${archivadas.length}.`);
    console.log('');
    console.log('Cargar una fuente exige haber confirmado que devuelve lo que se espera y con qué');
    console.log('frecuencia. Activarla desde una migración sería poner a andar un vigilante contra');
    console.log('una URL que nadie miró, y llenar la bandeja de candidatos que nadie revisa.');
    console.log('');
    console.log('Para probar el motor con una lista ya bajada, sin red:');
    console.log('');
    console.log('  npm run norms:watch -- --archivo ./lista.json');
    console.log('');
    console.log('El archivo es un array de { titulo, url, idExterno, publicadoEl }.');
    process.exit(0);
  }

  const items =
    archivoLocal === undefined
      ? []
      : JSON.parse(await readFile(archivoLocal, 'utf8')).map((crudo) => ({
          fuente: crudo.fuente ?? 'SITIO_ORGANISMO',
          idExterno: String(crudo.idExterno ?? crudo.id ?? crudo.titulo),
          titulo: String(crudo.titulo ?? ''),
          url: String(crudo.url ?? ''),
          publicadoEl: crudo.publicadoEl ?? null,
          crudo: JSON.stringify(crudo),
        }));

  if (archivoLocal !== undefined && items.length === 0) {
    console.log('norms:watch — el archivo no tiene ítems.');
    console.log('No se relevó nada, que no es lo mismo que no haber novedades.');
    process.exit(0);
  }

  const resultado = vigilar(items, archivadas);

  console.log(resultado.resumen);
  console.log('');

  for (const candidato of resultado.candidatos) {
    if (candidato.estado === 'YA_ARCHIVADO') continue;
    const etiqueta =
      candidato.identificada === null
        ? '(sin identificar)'
        : `${candidato.identificada.organismo} ${candidato.identificada.tipo} ${candidato.identificada.numero}/${candidato.identificada.anio}`;
    console.log(`  ${candidato.estado === 'NUEVO' ? '●' : '○'} ${etiqueta}`);
    console.log(`      ${candidato.item.titulo.slice(0, 100)}`);
    console.log(`      ${candidato.accion}`);
    console.log('');
  }

  if (resultado.nuevos + resultado.noIdentificables > 0) {
    console.log('Lo que un candidato NO habilita:');
    for (const limite of loQueUnCandidatoNoHabilita()) console.log(`  · ${limite}`);
  }
} finally {
  await client.end();
}
