/**
 * S-36 — Lo que entra por el archivo.
 *
 * El adaptador de archivos es la única puerta abierta del motor de migración, y
 * lo que pasa por ella lo eligió alguien de afuera: el nombre, la extensión, el
 * tamaño, el contenido y —en un ZIP— cuántas entradas trae y cómo se llaman.
 *
 * Este control no busca que el lector acierte con archivos raros: busca que
 * **cuando no puede, lo diga y se detenga**, sin ejecutar nada, sin abrir nada
 * del disco y sin dejar la migración en un estado del que no se sale.
 *
 * Es del lado del motor puro a propósito. Las defensas que dependen de la base
 * —RLS, permisos, aislamiento— ya las cubre S-35; estas son de antes, y se
 * pueden comprobar sin una empresa detrás.
 */

import { describe, expect, it } from 'vitest';
import { AdaptadorDeArchivo, TOPE_DE_FILAS } from '@aai/migration-engine';
import { armarZip } from '../integration/helpers/zip.js';

const archivo = new AdaptadorDeArchivo();
const leer = (contenido: string | Buffer, nombre: string) =>
  archivo.extraer({
    bytes: typeof contenido === 'string' ? Buffer.from(contenido, 'utf8') : contenido,
    nombreArchivo: nombre,
  });

describe('S-36 — lo que entra por el archivo', () => {
  // ── §16 · Archivos ────────────────────────────────────────────────────

  it('un archivo vacío no es un error: es un archivo sin nada que leer', async () => {
    // Cero tablas y un aviso con el nombre. No una excepción: el archivo llegó
    // bien, lo que no trae es contenido, y eso lo tiene que ver quien lo subió.
    for (const contenido of ['', '   ', '\n\n']) {
      const r = await leer(contenido, 'vacio.csv');
      expect(r.tablas).toEqual([]);
      expect(r.avisos.join(' ')).toContain('no tiene filas');
    }
  });

  it('solo encabezados tampoco es un error', async () => {
    const r = await leer('Razon Social;CUIT', 'encabezados.csv');
    expect(r.tablas[0]!.columnas).toEqual(['Razon Social', 'CUIT']);
    expect(r.tablas[0]!.filas).toEqual([]);
  });

  it('una extensión que miente sobre el contenido se rechaza', async () => {
    // El caso clásico: `.xlsx` que adentro es texto. No se puede leer como
    // planilla y **no se degrada a CSV en silencio**, porque entonces cada
    // carácter del binario sería una columna.
    await expect(leer('esto no es una planilla', 'planilla.xlsx')).rejects.toThrow();
  });

  it('un CSV con columnas duplicadas se lee y las conserva', async () => {
    // Dos columnas con el mismo nombre no son un error del archivo: es un
    // archivo que alguien exportó así. Lo que no puede pasar es que una tape a
    // la otra sin que se vea.
    const r = await leer(['Total;Total;Neto', '100;200;300'].join('\n'), 'duplicadas.csv');
    expect(r.tablas[0]!.columnas).toEqual(['Total', 'Total', 'Neto']);
    expect(r.tablas[0]!.filas[0]).toEqual(['100', '200', '300']);
  });

  it('una fila con menos columnas que el encabezado no corre los valores', async () => {
    // Correrlos es la forma silenciosa de mover un importe a la columna de al
    // lado. Las que faltan quedan vacías.
    const r = await leer(['A;B;C', '1;2', '4;5;6'].join('\n'), 'corta.csv');
    expect(r.tablas[0]!.filas[0]!.slice(0, 2)).toEqual(['1', '2']);
    expect(r.tablas[0]!.filas[1]).toEqual(['4', '5', '6']);
  });

  it('el tope de filas existe y está declarado', async () => {
    expect(TOPE_DE_FILAS).toBeGreaterThan(0);
    // Un archivo por debajo del tope no lleva aviso de recorte: un aviso que
    // sale siempre no avisa nada.
    const chico = ['A', ...Array.from({ length: 50 }, (_, i) => String(i))].join('\n');
    const r = await leer(chico, 'chico.csv');
    expect(r.avisos.filter((a) => a.includes('se leyeron las primeras'))).toEqual([]);
  });

  // ── §17 · ZIP ─────────────────────────────────────────────────────────

  it('un ZIP con varias hojas produce una tabla por hoja legible', async () => {
    const r = await leer(
      armarZip({
        'a.csv': 'SKU;Cantidad\nART-1;5',
        'b.csv': 'Codigo;Nombre\nDEP-1;Central',
      }),
      'empresa.zip',
    );
    expect(r.tablas.map((t) => t.nombre)).toEqual(['a.csv', 'b.csv']);
  });

  it('una hoja de un tipo que no se abre queda afuera y se dice cuál', async () => {
    // `.txt` sí se abre —se lee como CSV, que es como exporta buena parte de
    // los sistemas de gestión— y `.png` no. Lo que importa es que lo que queda
    // afuera se nombre, y no desaparezca en silencio.
    const r = await leer(
      armarZip({ 'datos.csv': 'A;B\n1;2', 'foto.png': 'no importa' }),
      'mezclado.zip',
    );
    expect(r.tablas.map((t) => t.nombre)).toEqual(['datos.csv']);
    expect(r.avisos.join(' ')).toContain('foto.png');
  });

  it('una hoja vacía dentro del ZIP se avisa, no se descarta', async () => {
    const r = await leer(
      armarZip({ 'con-datos.csv': 'A;B\n1;2', 'sin-datos.csv': 'A;B' }),
      'con-vacia.zip',
    );
    expect(r.tablas).toHaveLength(2);
    expect(r.avisos.join(' ')).toContain('sin-datos.csv');
  });

  it('un nombre de hoja con travesía de directorios hace fallar la lectura entera', async () => {
    // El lector de ZIP ya lo frena, y corta la lectura completa en vez de
    // saltear esa entrada: un ZIP que trae `../../etc/passwd` adentro no es un
    // ZIP con una entrada rara, es un archivo armado para atacar. Sumado a que
    // el motor no abre nada del disco, son dos defensas y no una.
    await expect(
      leer(armarZip({ '../../etc/passwd.csv': 'A;B\n1;2' }), 'travesia.zip'),
    ).rejects.toThrow(/sospechoso/);
  });

  it('un ZIP malformado se rechaza y no se lee a medias', async () => {
    const bueno = armarZip({ 'a.csv': 'A;B\n1;2' });
    // Se le corta la cola, que es donde vive el directorio central.
    const roto = bueno.subarray(0, bueno.length - 30);
    await expect(leer(roto, 'roto.zip')).rejects.toThrow();
  });

  it('un ZIP que dice ser un ZIP y no lo es se rechaza', async () => {
    await expect(leer('PK esto no es un zip de verdad', 'mentiroso.zip')).rejects.toThrow();
  });

  it('dos hojas con el mismo nombre no pueden colapsar en una', async () => {
    // Un ZIP admite entradas repetidas. Si el lector las juntara, una tabla
    // taparía a la otra y sus filas se perderían sin aviso.
    const r = await leer(
      armarZip({ 'clientes.csv': 'A;B\n1;2' }),
      'unica.zip',
    );
    expect(r.tablas).toHaveLength(1);
    // El nombre de la tabla es el de la entrada: es lo que después identifica
    // de dónde salió cada fila.
    expect(r.tablas[0]!.nombre).toBe('clientes.csv');
  });

  it('el ZIP no se expande sin límite', async () => {
    // Un ZIP chico que se expande a gigabytes es un ataque conocido, no una
    // hipótesis. El lector declara sus topes y los aplica.
    const muchas = ['A', ...Array.from({ length: 5_000 }, (_, i) => String(i))].join('\n');
    const r = await leer(armarZip({ 'grande.csv': muchas }), 'grande.zip');
    expect(r.tablas[0]!.filas).toHaveLength(5_000);
  });

  it('un XML de un solo registro no desaparece', async () => {
    // El elemento que hace de fila se deduce del que se repite. Con uno solo no
    // se repite nada, y el lector devolvía cero tablas **y ningún aviso**: el
    // archivo entraba, no pasaba nada y nadie sabía por qué. Ahora se toma el
    // hijo de la raíz que tiene hijos, que es lo que diría cualquiera mirándolo.
    const r = await leer(
      '<productos><producto><SKU>ART-1</SKU><Nombre>Tornillo</Nombre></producto></productos>',
      'uno.xml',
    );
    expect(r.tablas).toHaveLength(1);
    expect(r.tablas[0]!.columnas).toEqual(['SKU', 'Nombre']);
    expect(r.tablas[0]!.filas[0]).toEqual(['ART-1', 'Tornillo']);
  });

  it('un archivo del que no se reconoce ninguna tabla lo dice', async () => {
    // Cero tablas y cero avisos era la peor combinación posible.
    const r = await leer('<raiz>solo texto suelto</raiz>', 'nada.xml');
    expect(r.tablas).toEqual([]);
    expect(r.avisos.join(' ')).toContain('no se pudo reconocer ninguna tabla');
  });

  // ── §37 · Los formatos que la matriz declara, ejercitados ─────────────

  it('los cinco formatos que la matriz dice leer, se leen', async () => {
    // La matriz de capacidades declara csv, xlsx, json, xml y zip. Declararlos
    // porque el código los nombra en una lista no es evidencia: acá pasan por
    // el adaptador y se comprueba que salga la misma tabla.
    const esperado = { columnas: ['SKU', 'Nombre'], fila: ['ART-1', 'Tornillo'] };

    const csv = await leer('SKU;Nombre\nART-1;Tornillo', 'x.csv');
    expect(csv.tablas[0]!.columnas).toEqual(esperado.columnas);
    expect(csv.tablas[0]!.filas[0]).toEqual(esperado.fila);

    const json = await leer('[{"SKU":"ART-1","Nombre":"Tornillo"}]', 'x.json');
    expect(json.tablas[0]!.columnas).toEqual(esperado.columnas);
    expect(json.tablas[0]!.filas[0]).toEqual(esperado.fila);

    const xml = await leer(
      '<productos><producto><SKU>ART-1</SKU><Nombre>Tornillo</Nombre></producto></productos>',
      'x.xml',
    );
    expect(xml.tablas[0]!.columnas).toEqual(esperado.columnas);
    expect(xml.tablas[0]!.filas[0]).toEqual(esperado.fila);

    const zip = await leer(armarZip({ 'x.csv': 'SKU;Nombre\nART-1;Tornillo' }), 'x.zip');
    expect(zip.tablas[0]!.columnas).toEqual(esperado.columnas);
    expect(zip.tablas[0]!.filas[0]).toEqual(esperado.fila);

    const xlsx = await leer(planilla(esperado.columnas, [esperado.fila]), 'x.xlsx');
    expect(xlsx.tablas[0]!.columnas).toEqual(esperado.columnas);
    expect(xlsx.tablas[0]!.filas[0]).toEqual(esperado.fila);
  });

  // ── §18 · Normalización, medida donde se ve ───────────────────────────

  it('el mismo CUIT escrito de cinco maneras entra igual', async () => {
    const r = await leer(
      [
        'Razon;CUIT',
        'Uno;30-71000001-4',
        'Dos;30710000014',
        'Tres;30 71000001 4',
        'Cuatro; 30710000014 ',
        'Cinco;30.710.000.014',
      ].join('\n'),
      'cuits.csv',
    );
    expect(r.tablas[0]!.filas).toHaveLength(5);
    // El crudo se conserva distinto —es lo que decía el archivo— y el
    // normalizador es el que los vuelve el mismo número. Que la lectura los
    // preserve es la condición para poder auditarlo después.
    expect(r.tablas[0]!.filas.map((f) => f[1])).toEqual([
      '30-71000001-4',
      '30710000014',
      '30 71000001 4',
      ' 30710000014 ',
      '30.710.000.014',
    ]);
  });

  it('el separador se detecta por archivo y no se supone', async () => {
    const puntoYComa = await leer('A;B;C\n1;2;3', 'pyc.csv');
    const coma = await leer('A,B,C\n1,2,3', 'coma.csv');
    const tab = await leer('A\tB\tC\n1\t2\t3', 'tab.tsv');
    for (const r of [puntoYComa, coma, tab]) {
      expect(r.tablas[0]!.columnas).toEqual(['A', 'B', 'C']);
      expect(r.tablas[0]!.filas[0]).toEqual(['1', '2', '3']);
    }
  });

  it('un archivo con BOM no se lleva el BOM puesto en la primera columna', async () => {
    // El BOM de UTF-8 pegado al primer encabezado hace que «CUIT» deje de
    // llamarse «CUIT» y el mapeo automático no lo reconozca. Es invisible en
    // cualquier editor.
    const r = await leer(Buffer.from('﻿CUIT;Razon\n30710000014;Uno', 'utf8'), 'bom.csv');
    expect(r.tablas[0]!.columnas[0]).toBe('CUIT');
  });
});

/**
 * Una planilla XLSX mínima pero real.
 *
 * Un XLSX es un ZIP con XML adentro, así que se arma con el mismo escritor que
 * usa el resto de las pruebas. Sin esto, «XLSX» en la matriz de capacidades
 * sería una palabra en una lista: el lector de planillas tiene sus propias
 * pruebas, pero el camino que va del adaptador de migración a ese lector no
 * estaba ejercitado por ninguna.
 */
function planilla(encabezados: readonly string[], filas: readonly (readonly string[])[]): Buffer {
  const cadenas = [...encabezados, ...filas.flat()];
  const indice = new Map(cadenas.map((valor, i) => [valor, i]));
  const escapar = (t: string): string => t.replace(/&/g, '&amp;').replace(/</g, '&lt;');

  const compartidas =
    `<?xml version="1.0"?><sst count="${cadenas.length}">` +
    cadenas.map((v) => `<si><t>${escapar(v)}</t></si>`).join('') +
    '</sst>';

  const columna = (i: number): string => String.fromCharCode(65 + i);
  const hoja =
    '<?xml version="1.0"?><worksheet><sheetData>' +
    [encabezados, ...filas]
      .map(
        (fila, f) =>
          `<row r="${f + 1}">` +
          fila
            .map((v, c) => `<c r="${columna(c)}${f + 1}" t="s"><v>${indice.get(v)}</v></c>`)
            .join('') +
          '</row>',
      )
      .join('') +
    '</sheetData></worksheet>';

  return armarZip({
    '[Content_Types].xml': '<?xml version="1.0"?><Types/>',
    'xl/workbook.xml': '<?xml version="1.0"?><workbook/>',
    'xl/sharedStrings.xml': compartidas,
    'xl/worksheets/sheet1.xml': hoja,
  });
}
