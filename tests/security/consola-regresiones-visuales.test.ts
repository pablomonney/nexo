/**
 * Defectos de la consola que sólo aparecieron al ABRIRLA en un navegador con datos adentro (2026-10-15).
 *
 * Los 3 000 tests de integración llaman a la API; ninguno dibuja una pantalla. Al recorrer las 16 pantallas de detalle
 * contra `aai_test` con datos sintéticos (docs/VERIFICACION_VISUAL_16_PANTALLAS.md) salieron siete defectos que la API
 * no puede ver. Esta suite los fija con lo que se puede comprobar sin navegador: el código de la consola.
 *
 *   V-1  el aviso de éxito se escribía y se borraba en el mismo instante (se avisaba ANTES de releer, y la relectura
 *        limpia el contenedor del aviso): vendedor, decisión, imputación, corrección;
 *   V-2  el título de la ficha de un vendedor no se actualizaba al renombrarlo;
 *   V-3  los selects de comprobante de la ficha de un tercero acumulaban las facturas de los terceros anteriores;
 *   V-4  «Declarar el marco contable» era un botón muerto: su `onclick` se perdía con el siguiente `innerHTML +=`;
 *   V-5  el select de cuenta bancaria quedaba sin selección y «Proponer» llamaba a `/banks/accounts//…`;
 *   V-6  el select de mapeos decía «sin mapeos cargados» teniéndolos;
 *   V-7  la traza de una conciliación mostraba instantes ISO donde va una fecha.
 */

import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const RAIZ = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const consola = readFileSync(join(RAIZ, 'apps', 'web', 'consola.html'), 'utf8');

/** El texto de una función o de un handler, desde su inicio hasta el cierre de su bloque (por llaves). */
function bloqueDesde(inicio: string): string {
  const i = consola.indexOf(inicio);
  expect(i, `no encuentro «${inicio}» en consola.html`).toBeGreaterThanOrEqual(0);
  const abre = consola.indexOf('{', i);
  let profundidad = 0;
  let comilla: string | null = null;
  for (let j = abre; j < consola.length; j += 1) {
    const c = consola[j]!;
    if (comilla !== null) {
      if (c === '\\') j += 1;
      else if (c === comilla) comilla = null;
      continue;
    }
    if (c === "'" || c === '"' || c === '`') comilla = c;
    else if (c === '/' && consola[j + 1] === '/') j = consola.indexOf('\n', j);
    else if (c === '{') profundidad += 1;
    else if (c === '}') {
      profundidad -= 1;
      if (profundidad === 0) return consola.slice(i, j + 1);
    }
  }
  throw new Error(`no cierra el bloque de «${inicio}»`);
}

describe('V-1 · el aviso de éxito se escribe DESPUÉS de releer', () => {
  const casos: Array<[string, string, string]> = [
    ["E('b-cms-editar').onclick", 'abrirVendedor(', "decir('cms-ed-msg'"],
    ["E('b-op-sup').onclick", 'abrirOperacion(', "decir('op-sup-msg'"],
    ['async function cancelarImputacion', 'cargarImputaciones(', "decir('ter-imp-msg'"],
    ['async function cancelarCorreccion', 'cargarCorrecciones(', "decir('ter-corr-msg'"],
  ];

  it.each(casos)('%s relee y recién después avisa', (inicio, relectura, aviso) => {
    const cuerpo = bloqueDesde(inicio);
    const i = cuerpo.indexOf(relectura);
    const j = cuerpo.indexOf(aviso);
    expect(i, `${inicio} no vuelve a leer con ${relectura}`).toBeGreaterThanOrEqual(0);
    expect(j, `${inicio} no avisa con ${aviso}`).toBeGreaterThanOrEqual(0);
    expect(j, `${inicio}: el aviso va ANTES de la relectura y se borra en el acto`).toBeGreaterThan(i);
  });
});

describe('V-2 · renombrar un vendedor actualiza el título de la ficha', () => {
  it('el handler arma el título nuevo con el nombre que se acaba de guardar', () => {
    const cuerpo = bloqueDesde("E('b-cms-editar').onclick");
    expect(cuerpo).toMatch(/abrirVendedor\(estado\.vendedor,\s*codigo\s*\+\s*' — '\s*\+\s*E\('cms-ed-nombre'\)\.value\)/u);
    expect(cuerpo, 'sigue reusando el título viejo').not.toMatch(/abrirVendedor\(estado\.vendedor,\s*estado\.vendedorTitulo\)/u);
  });
});

describe('V-3 · los selects de comprobante no acumulan los de otros terceros', () => {
  it('los CUATRO se vacían antes de llenarse', () => {
    expect(consola).toMatch(
      /for \(const s of \[sel, E\('ter-p-cbte'\), E\('ter-imp-cbte'\), E\('ter-corr-cbte'\)\]\) s\.innerHTML = '';/u,
    );
  });

  it('todo select al que se le agregan opciones en ese bucle está en la lista que se vacía', () => {
    const bucle = /for \(const s of \[([^\]]+)\]\) \{\s*const o = document\.createElement\('option'\);/u.exec(consola);
    const vaciado = /for \(const s of \[([^\]]+)\]\) s\.innerHTML = '';/u.exec(consola);
    expect(bucle, 'no encuentro el bucle que agrega opciones').not.toBeNull();
    expect(vaciado, 'no encuentro el bucle que vacía').not.toBeNull();
    expect(vaciado![1]).toBe(bucle![1]);
  });
});

describe('V-9 · al abrir otro tercero se borran los resultados del anterior', () => {
  it('las tablas de imputaciones y de correcciones (y sus avisos) se vacían junto con los selects', () => {
    expect(consola).toContain("for (const t of ['t-ter-imp', 't-ter-corr']) E(t).querySelector('tbody').innerHTML = '';");
    expect(consola).toContain("limpiar('ter-imp-msg');\n  limpiar('ter-corr-msg');\n  for (const c of (r.datos.comprobantes || [])) {");
  });
});

describe('V-4 · ningún botón de la pantalla de configuración se engancha con onclick sobre el hijo', () => {
  it('cargarConfig no hace `E(…).onclick =` (cada `caja.innerHTML +=` lo destruiría)', () => {
    const cuerpo = bloqueDesde('async function cargarConfig');
    const sueltos = [...cuerpo.matchAll(/E\('([^']+)'\)\.onclick\s*=/gu)].map((m) => m[1]);
    expect(sueltos, 'estos botones quedan dibujados y muertos').toEqual([]);
  });

  it('«Declarar el marco contable» va por delegación', () => {
    const cuerpo = bloqueDesde('async function cargarConfig');
    expect(cuerpo).toContain("ev.target.closest('#b-cfg-marco')");
    expect(cuerpo).toContain("caja.dataset.marcoEnganchado = 'si'");
  });
});

describe('V-5 y V-6 · los selects de banco nacen con algo elegido y dicen la verdad', () => {
  it('la cuenta se elige sola cuando no había ninguna (nunca `sel.value = previo` a secas)', () => {
    const cuerpo = bloqueDesde('async function listarBancos');
    expect(cuerpo).toMatch(/else if \(sel\.options\.length > 0\) sel\.selectedIndex = 0;/u);
    expect(cuerpo, 'vuelve el `sel.value = previo` que dejaba el select sin selección').not.toMatch(/^\s*sel\.value = previo;\s*$/mu);
  });

  it('con una conciliación abierta, queda ELEGIDA (no «— ninguna abierta —»)', () => {
    const cuerpo = bloqueDesde('async function listarConciliaciones');
    expect(cuerpo).toContain('sel.selectedIndex = sel.options.length > 1 ? 1 : 0;');
    expect(cuerpo, 'vuelve el `sel.value = previo` a secas').not.toMatch(/^s*sel.value = previo;s*$/mu);
  });

  it('con mapeos cargados la opción vacía ya no dice «sin mapeos cargados»', () => {
    const cuerpo = bloqueDesde('async function listarMapeos');
    expect(cuerpo).toContain("— elegí un mapeo —");
    expect(cuerpo).toMatch(/sel\.options\[0\]\.textContent = /u);
  });
});

describe('V-8 · «Vincular» no desvincula por defecto y deja elegido al tercero actual', () => {
  it('la opción vacía ya no dice «desvincular»: hay una para «elegí» y otra explícita para desvincular', () => {
    expect(consola).not.toContain('<option value="">— ninguno (desvincular) —</option>');
    expect(consola).toContain('<option value="__ninguno__">— desvincular (ningún tercero) —</option>');
  });

  it('con la opción «sin elegir» no se manda nada', () => {
    const cuerpo = bloqueDesde("E('b-op-party').onclick");
    expect(cuerpo).toMatch(/if \(elegido === ''\) return avisoMal\(/u);
    expect(cuerpo).toMatch(/elegido === '__ninguno__' \? null : elegido/u);
  });

  it('el tercero ya vinculado queda elegido al abrir la operación', () => {
    const cuerpo = bloqueDesde('async function abrirOperacion');
    expect(cuerpo).toContain('estado.terceroDeOperacion[id]');
    expect(cuerpo).toMatch(/E\('op-party-sel'\)\.value = vinculado/u);
    expect(consola).toContain('estado.terceroDeOperacion[o.id] = o.terceroId || null;');
  });
});

describe('V-10 · «En otras órdenes» no cuenta la orden que se edita', () => {
  it('el editor pide los pagables excluyendo la orden en edición', () => {
    expect(consola).toContain("'/payment-orders/pagables?proveedorId=' + proveedorId + '&excluirOrdenId=' + estado.ordenDePago");
  });
});

describe('V-7 · la traza de una conciliación muestra fechas, no instantes', () => {
  it('recorta a AAAA-MM-DD el movimiento y el asiento', () => {
    const cuerpo = bloqueDesde('async function mostrarTrazaDeMatch');
    expect(cuerpo).toContain('String(t.movimiento_fecha).slice(0, 10)');
    expect(cuerpo).toContain('String(t.entry_date).slice(0, 10)');
  });
});
