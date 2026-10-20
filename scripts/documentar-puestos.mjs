#!/usr/bin/env node
/**
 * Escribe `docs/PUESTOS.md` a partir de `infrastructure/db/datos/puestos.json` y de la consola.
 *
 *   npm run docs:puestos                       # escribe el documento
 *   node scripts/documentar-puestos.mjs --verificar   # sólo comprueba que esté al día (lo corre un test)
 *
 * Los módulos que ve cada puesto **no se escriben a mano**: salen de aplicar los permisos del puesto a la tabla permiso→pantalla que usa la
 * consola (`PERMISO_DE_LA_PANTALLA` en `apps/web/consola.html`) y a los nombres del menú. Es el mismo cálculo que hace «Dar un puesto» al
 * elegir uno, así que el documento no se puede desactualizar sin que lo note el test de documentación.
 */

import { readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const RAIZ = join(dirname(fileURLToPath(import.meta.url)), '..');
const datos = JSON.parse(readFileSync(join(RAIZ, 'infrastructure', 'db', 'datos', 'puestos.json'), 'utf8'));
const consola = readFileSync(join(RAIZ, 'apps', 'web', 'consola.html'), 'utf8');

// La tabla permiso→pantalla de la consola.
const ini = consola.indexOf('const PERMISO_DE_LA_PANTALLA = {');
const fin = consola.indexOf('\n};', ini);
const tabla = Function(`"use strict"; return (${consola.slice(consola.indexOf('{', ini), fin + 2)});`)();

// Los nombres del menú, en el orden en que se dibujan.
const menu = [...consola.matchAll(/<button data-vista="([^"]+)"[^>]*?data-nombre="([^"]*)"/g)]
  .map((m) => ({ vista: m[1], nombre: m[2] }))
  .filter((m) => m.vista !== 'propietario' && m.vista !== 'empresa');
const SIEMPRE = ['Inicio', 'Pendientes', 'Asistente', 'Preguntar', 'Configuración'];

export function modulosDe(permisos) {
  const tiene = new Set(permisos);
  return menu
    .filter((m) => tabla[m.vista] === undefined || tiene.has(tabla[m.vista]))
    .map((m) => m.nombre)
    .filter((n) => !SIEMPRE.includes(n));
}

const orden = ['Dirección', 'Ventas', 'Compras y depósito', 'Tesorería', 'Operación', 'Contabilidad'];
const porArea = new Map(orden.map((a) => [a, []]));
for (const p of datos.puestos) porArea.get(p.area).push(p);

let md = `# Puestos predeterminados y los módulos de cada persona

**Migración 0143, 2026-10-19, a pedido del titular.** Este archivo se **genera**: \`npm run docs:puestos\` lo escribe desde \`infrastructure/db/datos/puestos.json\` y desde la consola. No se edita a mano.

Hasta entonces los roles estaban pensados por nivel de acceso (administrar, contar, auditar, cargar, consultar). Una empresa se organiza por **puestos**: quien vende no maneja la caja, quien hace la tesorería no carga el stock, y quien dirige quiere ver todo sin tocar la contabilidad.

## Cómo funciona

- Un **puesto es un rol**: el mecanismo de siempre (\`user_company_roles\`, \`grant_company_role\`, \`role_permissions\`). Se da desde Configuración → «Dar un puesto» (o \`POST /companies/:id/roles\`).
- **Los módulos de cada persona salen de los permisos de su puesto.** La consola esconde lo que el rol no puede usar (\`aplicarPermisosANav\`) y el servidor lo rechaza de todos modos. La tabla permiso→pantalla es **una sola** (\`PERMISO_DE_LA_PANTALLA\` en \`consola.html\`): la usan el menú y «Dar un puesto» para decir, antes de darlo, qué va a ver la persona. \`GET /puestos\` los lista con sus permisos y su área.
- **Los puestos se suman:** una misma persona puede ser vendedora y compradora.
- Dentro de lo que el **plan** incluye: si el plan de la empresa no trae un módulo, ningún puesto lo ve.
- **Todos** ven además Inicio, Pendientes, el Asistente, Preguntar y Configuración (lo mínimo para entrar y trabajar).

## Los criterios (mínimo privilegio)

- **Ningún puesto toca la contabilidad** (aprobar o revertir asientos, períodos, estados, libros emitidos): eso es del Contador. Sólo el **Asistente contable** carga asientos, y los propone: no los aprueba.
- **Ninguno administra el sistema** (usuarios, secretos, ARCA, suscripción, migraciones): eso es del Administrador.
- **Quien propone no aprueba:** los pedidos de compra los aprueban sólo el **Gerente** y el **Jefe de compras**; las órdenes de pago, sólo el **Gerente** y el **Responsable de pagos**. El Tesorero y el Comprador arman, no aprueban.
- Los **ajustes de stock** (que cambian el inventario contable) son sólo del **Jefe de depósito**.
- Todos entran (\`company:read\`) y usan el asistente de IA (\`intelligence:ask\`).
- Los puestos que mueven plata, aprueban o tocan la contabilidad exigen **segundo factor**, como Administrador, Contador y Auditor.

## Los puestos, por área

`;
for (const [area, ps] of porArea) {
  md += `### ${area}\n\n| Puesto | Qué hace | Módulos que ve (además de los básicos) | 2.º factor |\n|---|---|---|---|\n`;
  for (const p of ps) {
    md += `| **${p.nombre}** \`${p.codigo}\` | ${p.descripcion} | ${modulosDe(p.permisos).join(', ') || '—'} | ${p.segundoFactor ? '**Sí**' : 'No'} |\n`;
  }
  md += '\n';
}
md += `### Los roles de siempre

| Rol | Qué hace |
|---|---|
| **Administrador** \`ADMINISTRADOR\` | Configuración, usuarios y reapertura de períodos con segunda firma. No firma la contabilidad |
| **Contador** \`CONTADOR\` | Aprueba, modifica, rechaza, reclasifica, cierra períodos y emite estados |
| **Auditor** \`AUDITOR\` | Lectura total más acceso completo a la bitácora. No modifica nada |
| **Usuario de empresa** \`USUARIO_EMPRESA\` | Ve su empresa, carga documentación y consulta reportes autorizados |
| **Cargador de documentación** \`CARGADOR\` | Sube documentos y ve el estado de su procesamiento |
| **Solo lectura** \`SOLO_LECTURA\` | Consulta |

## Qué lo comprueba

- \`tests/security/puestos-predeterminados.test.ts\` (S-50): la base tiene **exactamente** los permisos de \`puestos.json\` para cada puesto, ninguno tiene lo prohibido (contabilidad, administración), y cada permiso sensible —aprobar compras o pagos, ajustar stock, cargar asientos, el IVA— está sólo en los puestos que corresponde. Dar un permiso de más a un puesto pone el test en rojo.
- \`tests/integration/puestos.test.ts\`: contra la API real, una persona por puesto: lo permitido responde y lo que no le toca es 403; el segundo factor se exige donde corresponde; un puesto inexistente o dado a alguien de otro estudio se rechaza.
- \`tests/security/documentacion-veraz.test.ts\`: este documento coincide con lo que genera \`npm run docs:puestos\`.

## Qué falta

- Puestos propios de cada empresa, y agregar o quitar módulos y funciones a un puesto o a una persona: **a construir** (la siguiente entrega).
- Un puesto no limita por sucursal.
- «Facturas y comprobantes» y «Asientos» comparten el permiso de lectura de asientos (\`journal_entry:read\`): quien ve las facturas ve también el libro de asientos en lectura.
`;

const destino = join(RAIZ, 'docs', 'PUESTOS.md');
if (process.argv.includes('--verificar')) {
  // Sin escribir nada: dice si el documento coincide con lo que se generaría hoy.
  const actual = (() => { try { return readFileSync(destino, 'utf8'); } catch { return null; } })();
  if (actual !== md) {
    console.error('docs/PUESTOS.md no coincide con puestos.json y la consola. Corré: npm run docs:puestos');
    process.exit(1);
  }
  console.log('docs/PUESTOS.md está al día.');
  process.exit(0);
}
writeFileSync(destino, md);

// Para el manual del escritorio (HTML), si se pide.
if (process.argv.includes('--html')) {
  let h = '<table>\n  <thead><tr><th style="width:18%">Puesto</th><th>Qué hace</th><th style="width:36%">Módulos que ve</th></tr></thead>\n  <tbody>\n';
  for (const [area, ps] of porArea) {
    h += `    <tr><td colspan="3"><strong>${area}</strong></td></tr>\n`;
    for (const p of ps) {
      h += `    <tr><td><strong>${p.nombre}</strong>${p.segundoFactor ? '<br><small>segundo factor</small>' : ''}</td><td>${p.descripcion}</td><td>${modulosDe(p.permisos).join(', ') || '—'}</td></tr>\n`;
    }
  }
  h += '  </tbody>\n</table>\n';
  writeFileSync(process.argv[process.argv.indexOf('--html') + 1], h);
}
console.log(`docs/PUESTOS.md escrito: ${datos.puestos.length} puestos.`);
