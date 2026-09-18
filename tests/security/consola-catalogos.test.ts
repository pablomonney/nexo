/**
 * Los desplegables del alta ofrecen exactamente lo que la base admite.
 *
 * ## Por qué esto es un control y no una convención
 *
 * La consola es HTML estático: no puede importar el catálogo de `@aai/shared`,
 * así que sus opciones están escritas. Una lista escrita al lado de otra lista
 * es la forma exacta del defecto que este archivo vigila — y que ya ocurrió tres
 * veces en el mismo formulario:
 *
 *   · `Tipo` ofrecía `ASOCIACION` y `OTRO`, que la columna rechaza. Elegir
 *     cualquiera de los dos devolvía `INTERNAL_ERROR`.
 *   · `Organismo` era texto libre con `IGJ` de ejemplo: escribir `igj` en
 *     minúsculas, lo mismo.
 *   · `Jurisdicción` era texto libre con `AR-C` escrito: `ar-c`, lo mismo.
 *
 * Las tres son la misma forma: **la pantalla ofrece algo que la base no
 * acepta**, y el que se entera es un cliente completando el primer formulario
 * del producto.
 *
 * Por eso acá no se comprueba que las opciones «parezcan razonables»: se
 * comparan una por una contra el catálogo compartido, que es el mismo que
 * valida la ruta. Si alguien agrega un `<option>` a mano, este test falla antes
 * de que lo haga un cliente.
 */

import { readFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  JURISDICCIONES,
  ORGANISMOS_DE_CONTRALOR,
  TIPOS_DE_ENTIDAD,
  ETIQUETA_DE_ENTIDAD,
  ETIQUETA_DE_JURISDICCION,
} from '@aai/shared';
import { beforeAll, describe, expect, it } from 'vitest';

const CONSOLA = join(
  dirname(fileURLToPath(import.meta.url)),
  '..',
  '..',
  'apps',
  'web',
  'consola.html',
);

/** Las opciones de un `<select>`, con su `value` efectivo y su texto. */
function opcionesDe(html: string, id: string): { value: string; texto: string }[] {
  const select = new RegExp(`<select id="${id}"[^>]*>([\\s\\S]*?)</select>`, 'u').exec(html);
  if (select === null) throw new Error(`no hay <select id="${id}"> en la consola`);

  const opciones: { value: string; texto: string }[] = [];
  const re = /<option(?:\s+value="([^"]*)")?[^>]*>([^<]*)<\/option>/gu;
  let m: RegExpExecArray | null;
  while ((m = re.exec(select[1]!)) !== null) {
    const texto = m[2]!.trim();
    // Sin `value`, el navegador manda el texto. Es lo que hacía el desplegable
    // de tipo de entidad antes de tener etiquetas.
    opciones.push({ value: m[1] ?? texto, texto });
  }
  return opciones;
}

describe('Los desplegables del alta ofrecen solo lo que la base admite', () => {
  let html = '';

  beforeAll(async () => {
    html = await readFile(CONSOLA, 'utf8');
  });

  it('tipo de entidad: los doce códigos canónicos, en el mismo orden', () => {
    const opciones = opcionesDe(html, 'on-tipo');
    expect(opciones.map((o) => o.value)).toEqual([...TIPOS_DE_ENTIDAD]);
  });

  it('tipo de entidad: cada opción muestra el nombre, no el código', () => {
    for (const { value, texto } of opcionesDe(html, 'on-tipo')) {
      expect(texto).toBe(ETIQUETA_DE_ENTIDAD[value as keyof typeof ETIQUETA_DE_ENTIDAD]);
    }
  });

  it('tipo de entidad: no sobrevive ninguno de los dos valores inventados', () => {
    const valores = opcionesDe(html, 'on-tipo').map((o) => o.value);
    expect(valores).not.toContain('ASOCIACION');
    expect(valores).not.toContain('OTRO');
  });

  it('jurisdicción: los tres códigos, con su nombre', () => {
    const opciones = opcionesDe(html, 'on-jurisdiccion');
    expect(opciones.map((o) => o.value)).toEqual([...JURISDICCIONES]);
    for (const { value, texto } of opciones) {
      expect(texto).toBe(ETIQUETA_DE_JURISDICCION[value as keyof typeof ETIQUETA_DE_JURISDICCION]);
    }
  });

  it('organismo: los cinco, más la opción de no tener', () => {
    const opciones = opcionesDe(html, 'on-organismo');
    // El vacío primero: la ausencia de organismo es legítima y es NULL.
    expect(opciones[0]!.value).toBe('');
    expect(opciones.slice(1).map((o) => o.value)).toEqual([...ORGANISMOS_DE_CONTRALOR]);
  });

  it('ninguno de los tres campos quedó como texto libre', () => {
    // La regresión concreta: los tres eran `<input>` o tenían opciones sueltas.
    for (const id of ['on-tipo', 'on-jurisdiccion', 'on-organismo']) {
      expect(html).not.toContain(`<input id="${id}"`);
      expect(html).toContain(`<select id="${id}"`);
    }
  });
});
