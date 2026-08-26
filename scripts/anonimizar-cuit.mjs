#!/usr/bin/env node
/**
 * Reemplaza los CUIT de un archivo por sustitutos con dígito verificador válido.
 *
 *   npm run cuit:anonimizar -- entrada.csv --salida anonimizado.csv --tabla ../tabla.json
 *   npm run cuit:anonimizar -- entrada.csv --verificar
 *
 * Es el paso que `corpus/README.md` pide antes de traer un comprobante real, y
 * el que más fácil sale mal a mano: reemplazar el CUIT por otro inventado hace
 * que el parser lo rechace por un motivo que no es el que se quiere medir.
 *
 * ## Las cuatro propiedades que hacen esto utilizable
 *
 * 1. **El sustituto es válido.** Mismo módulo 11 que `isValidCuit`, desde
 *    `@aai/shared`. No hay una segunda implementación que se pueda desviar.
 *
 * 2. **Es determinístico y estable.** El mismo CUIT original produce siempre el
 *    mismo sustituto. Sin eso, el mismo proveedor aparece con un CUIT distinto en
 *    cada comprobante y el corpus deja de servir para lo que más importa medir:
 *    detección de duplicados, agrupación por contraparte, historial de importes.
 *
 * 3. **Conserva el prefijo.** `20`/`23`/`24`/`27` es persona física y `30`/`33`/
 *    `34` es persona jurídica. Cambiarlo alteraría el tipo de sujeto, que es
 *    parte de lo que el sistema interpreta.
 *
 * 4. **No colisiona.** Dos CUIT originales distintos nunca comparten sustituto.
 *    Si colisionaran, dos proveedores se fusionarían en uno y el corpus mediría
 *    algo que no pasó.
 *
 * ## Lo que este script NO hace, y hay que hacer aparte
 *
 * No toca razones sociales, domicilios ni números de documento. **No es un
 * olvido.** Detectar un nombre propio dentro de texto libre es adivinar, y un
 * anonimizador que acierta el 95% es peor que ninguno: deja creer que el archivo
 * quedó limpio. Los campos que este script no puede garantizar los enumera al
 * final para que alguien los revise.
 *
 * ## La tabla de correspondencia re-identifica todo
 *
 * `--tabla` escribe el mapa original → sustituto. Ese archivo **deshace la
 * anonimización entera**, así que el script se niega a escribirlo dentro del
 * repositorio. Guardalo donde guardás credenciales, o no lo guardes.
 */

import { createHash } from 'node:crypto';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { formatCuit, isValidCuit, normalizeCuit, withCheckDigit } from '@aai/shared';

const AQUI = dirname(fileURLToPath(import.meta.url));
const RAIZ = resolve(join(AQUI, '..'));

const args = process.argv.slice(2);

/** Opciones que consumen el argumento siguiente. `--verificar` no. */
const CON_VALOR = new Set(['--salida', '--tabla', '--semilla']);

const valorDe = (nombre) => {
  const i = args.indexOf(`--${nombre}`);
  return i === -1 ? null : (args[i + 1] ?? null);
};

// El archivo de entrada es el primer argumento suelto que no sea el valor de una
// opción. Enumerar cuáles llevan valor —en vez de mirar si el anterior empieza
// con `--`— es lo que hace que `--verificar entrada.csv` funcione igual que
// `entrada.csv --verificar`.
let entrada;
for (let i = 0; i < args.length; i += 1) {
  if (CON_VALOR.has(args[i])) {
    i += 1;
    continue;
  }
  if (args[i].startsWith('--')) continue;
  entrada = args[i];
  break;
}

const soloVerificar = args.includes('--verificar');
const semilla = valorDe('semilla') ?? 'corpus';

if (entrada === undefined) {
  console.error('Uso: npm run cuit:anonimizar -- entrada.csv [--salida salida.csv] [--tabla ../tabla.json] [--verificar]');
  console.error('');
  console.error('  --verificar   solo informa qué CUIT hay y cuáles son inválidos; no escribe nada');
  console.error('  --semilla     cambia el conjunto de sustitutos; el mismo original con la misma');
  console.error('                semilla da siempre el mismo sustituto');
  process.exit(2);
}

const texto = readFileSync(entrada, 'utf8');

/**
 * Un CUIT en el texto: once dígitos con o sin separadores.
 *
 * No se buscan números sueltos de once dígitos sin separadores dentro de otras
 * cifras: un importe largo o un CAE de catorce no son un CUIT, y reemplazarlos
 * corrompería el archivo en silencio.
 */
const PATRON = /\b(\d{2})[-. ]?(\d{8})[-. ]?(\d)\b/g;

const originales = new Map();
for (const m of texto.matchAll(PATRON)) {
  const digitos = normalizeCuit(m[0]);
  if (digitos.length !== 11) continue;
  originales.set(digitos, (originales.get(digitos) ?? 0) + 1);
}

const invalidos = [...originales.keys()].filter((c) => !isValidCuit(c));

console.log(`Archivo: ${entrada}`);
console.log(`CUIT distintos encontrados: ${originales.size} (${[...originales.values()].reduce((a, b) => a + b, 0)} apariciones)`);
console.log(`  con dígito verificador válido:   ${originales.size - invalidos.length}`);
console.log(`  con dígito verificador inválido: ${invalidos.length}`);

if (soloVerificar) {
  if (invalidos.length > 0) {
    console.log('');
    console.log('Inválidos:');
    for (const c of invalidos.slice(0, 20)) console.log(`  · ${formatCuit(c)}`);
    if (invalidos.length > 20) console.log(`  … y ${invalidos.length - 20} más`);
    console.log('');
    console.log('Un CUIT inválido lo rechaza el parser por un motivo que no es el que se quiere');
    console.log('medir. Corré sin --verificar para reemplazarlos por sustitutos válidos.');
  }
  process.exit(0);
}

// ---------------------------------------------------------------------------
// Sustitución
// ---------------------------------------------------------------------------

/**
 * Ocho dígitos derivados del original por hash, no al azar.
 *
 * Determinístico para que el mismo proveedor conserve su identidad a lo largo de
 * todo el corpus; con semilla para que dos corpus distintos no compartan la
 * correspondencia.
 */
function cuerpoDerivado(original, intento) {
  const h = createHash('sha256').update(`${semilla}|${original}|${intento}`).digest();
  // Ocho dígitos desde los primeros bytes, en enteros.
  let n = 0n;
  for (const byte of h.subarray(0, 8)) n = n * 256n + BigInt(byte);
  return String(n % 100_000_000n).padStart(8, '0');
}

const usados = new Set();
const tabla = new Map();

for (const original of [...originales.keys()].sort()) {
  const prefijo = original.slice(0, 2);
  let sustituto = null;

  // El bucle existe por la propiedad 4: si el derivado ya se usó para otro
  // original, se reintenta. Sin esto dos proveedores distintos podrían fusionarse
  // en uno, y el corpus mediría algo que no pasó.
  for (let intento = 0; intento < 1000; intento += 1) {
    const candidato = withCheckDigit(prefijo + cuerpoDerivado(original, intento));
    if (!isValidCuit(candidato)) continue;
    if (usados.has(candidato)) continue;
    // Un sustituto que coincida con otro original del archivo confundiría dos
    // sujetos igual que una colisión entre sustitutos.
    if (originales.has(candidato) && candidato !== original) continue;
    sustituto = candidato;
    break;
  }

  if (sustituto === null) {
    console.error(`No se pudo derivar un sustituto para ${formatCuit(original)} en 1000 intentos.`);
    process.exit(1);
  }

  usados.add(sustituto);
  tabla.set(original, sustituto);
}

// Se reemplaza conservando el formato de cada aparición: si el original venía con
// guiones, el sustituto también. Cambiar el formato sería una diferencia más
// entre el corpus y el documento del que salió.
const anonimizado = texto.replace(PATRON, (coincidencia) => {
  const digitos = normalizeCuit(coincidencia);
  const sustituto = tabla.get(digitos);
  if (sustituto === undefined) return coincidencia;
  return /[-. ]/.test(coincidencia) ? formatCuit(sustituto) : sustituto;
});

const salida = valorDe('salida');
if (salida === null) {
  console.error('');
  console.error('Falta --salida. El script no sobrescribe el archivo original: si algo sale mal,');
  console.error('el documento del que se partió tiene que seguir estando.');
  process.exit(2);
}
writeFileSync(salida, anonimizado, 'utf8');

console.log('');
console.log(`Escrito: ${salida}`);
console.log(`Sustituciones: ${tabla.size} CUIT distintos, todos con dígito verificador válido.`);

// ---------------------------------------------------------------------------
// La tabla de correspondencia
// ---------------------------------------------------------------------------

const rutaTabla = valorDe('tabla');
if (rutaTabla !== null) {
  const destino = resolve(rutaTabla);
  const dentroDelRepo = !relative(RAIZ, destino).startsWith('..');
  if (dentroDelRepo) {
    console.error('');
    console.error(`La tabla de correspondencia NO se escribe dentro del repositorio.`);
    console.error(`  destino pedido: ${destino}`);
    console.error('');
    console.error('Ese archivo deshace la anonimización entera: con él, cada CUIT sustituto');
    console.error('vuelve a ser el real. Un corpus anonimizado con su tabla al lado en el mismo');
    console.error('repositorio no está anonimizado — está ordenado.');
    console.error('');
    console.error('Elegí una ruta fuera del repositorio, o no la guardes: la sustitución es');
    console.error('determinística y se puede reproducir con el mismo --semilla.');
    process.exit(1);
  }

  writeFileSync(
    destino,
    `${JSON.stringify(
      {
        advertencia: 'Este archivo re-identifica el corpus. Tratar como credencial.',
        semilla,
        generado: new Date().toISOString(),
        correspondencia: Object.fromEntries([...tabla].map(([o, s]) => [formatCuit(o), formatCuit(s)])),
      },
      null,
      2,
    )}\n`,
    'utf8',
  );
  console.log(`Tabla de correspondencia: ${destino}`);
  console.log('  Re-identifica el corpus entero. Tratala como una credencial.');
} else {
  console.log('');
  console.log('Sin --tabla: no se guardó la correspondencia. La sustitución es determinística,');
  console.log(`así que se reproduce corriendo lo mismo con --semilla ${semilla}.`);
}

// ---------------------------------------------------------------------------
// Lo que queda por revisar a mano
// ---------------------------------------------------------------------------

console.log('');
console.log('LO QUE ESTE SCRIPT NO ANONIMIZÓ, y hay que revisar antes de traer el archivo:');
console.log('');
console.log('  · Razón social y nombre de fantasía');
console.log('  · Domicilio comercial y domicilio del receptor');
console.log('  · Número de documento (DNI) cuando el receptor no tiene CUIT');
console.log('  · Número de Ingresos Brutos, que suele contener el CUIT sin verificador');
console.log('  · Cualquier dato en el detalle de los ítems');
console.log('');
console.log('No es un olvido: detectar un nombre propio dentro de texto libre es adivinar, y un');
console.log('anonimizador que acierta el 95% deja creer que el archivo quedó limpio. Estos');
console.log('campos los mira una persona.');

const iibb = [...anonimizado.matchAll(/\b\d{3}-\d{8}-\d\b/g)];
if (iibb.length > 0) {
  console.log('');
  console.log(`Atención: hay ${iibb.length} número(s) con forma de Ingresos Brutos en el archivo`);
  console.log('anonimizado. Suelen incluir el CUIT real con otro prefijo, y este script no los tocó.');
}

if (existsSync(join(RAIZ, 'corpus', 'ground-truth.json'))) {
  console.log('');
  console.log('Recordá actualizar corpus/ground-truth.json con los CUIT sustitutos: el esperado');
  console.log('tiene que ser lo que el documento dice ahora, no lo que decía antes.');
}
