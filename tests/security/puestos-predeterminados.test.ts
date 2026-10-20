/**
 * S-50 — los puestos predeterminados (migración 0143) tienen exactamente los permisos que dicen tener.
 *
 * Un puesto es un rol con un conjunto de permisos, y de los permisos sale qué módulos ve cada persona. La fuente de verdad es
 * `infrastructure/db/datos/puestos.json` (la migración y `docs/PUESTOS.md` se generan de ahí). El control tiene tres mitades:
 *
 *   1. **La base coincide con el archivo**, permiso por permiso. Si alguien le suma uno a un puesto —aunque sea con la mejor intención—
 *      el test se pone en rojo y hay que decidirlo a propósito: dar un permiso de más a un puesto es regalarle acceso.
 *   2. **Lo que ningún puesto puede tener**, escrito aparte y por motivo: administrar el sistema, y la firma de la contabilidad.
 *   3. **Lo sensible está sólo donde corresponde:** aprobar compras o pagos, ajustar stock, cargar asientos, el IVA. Cada uno con su lista
 *      cerrada de puestos.
 */

import { execFileSync } from 'node:child_process';
import { readFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { ROLES_REQUIRING_MFA } from '@aai/api/http/context';
import { connect, hasDatabase, type Client } from '../integration/helpers/db.js';

const suite = hasDatabase ? describe : describe.skip;
const RAIZ = join(dirname(fileURLToPath(import.meta.url)), '..', '..');

interface Puesto {
  codigo: string;
  nombre: string;
  area: string;
  descripcion: string;
  segundoFactor: boolean;
  permisos: string[];
}

/** Lo que ningún puesto puede tener, y por qué. */
const PROHIBIDOS: ReadonlyArray<[RegExp, string]> = [
  [/^(journal_entry:(approve|reverse)|period:(write|block|close|reopen)|fiscal_year:close|statement:issue|book:emit|note:write|account:write|decision:supersede|rule:activate)$/u, 'firmar y cerrar la contabilidad es del Contador'],
  [/^(user:manage|secret:manage|arca_credential:manage|company:(write|create|export)|subscription:write|migration:.+|integration:connect)$/u, 'administrar el sistema es del Administrador'],
];

/** Cada permiso sensible, y los únicos puestos que lo pueden tener. */
const SOLO_PARA: Readonly<Record<string, readonly string[]>> = {
  'purchase_request:approve': ['GERENTE', 'JEFE_DE_COMPRAS'],
  'payment_order:approve': ['GERENTE', 'RESPONSABLE_DE_PAGOS'],
  'stock:adjust': ['JEFE_DE_DEPOSITO'],
  'journal_entry:create': ['ASISTENTE_CONTABLE'],
  'vat_book:generate': ['RESPONSABLE_DE_IMPUESTOS'],
  'tax_affectation:declare': ['RESPONSABLE_DE_IMPUESTOS'],
  'tax_transaction:constatar': ['RESPONSABLE_DE_IMPUESTOS'],
  'decision:approve': ['GERENTE'],
};

suite('S-50 — los puestos predeterminados', () => {
  let db: Client;
  let puestos: Puesto[] = [];
  const permisosDe: Record<string, string[]> = {};

  beforeAll(async () => {
    const datos = JSON.parse(await readFile(join(RAIZ, 'infrastructure', 'db', 'datos', 'puestos.json'), 'utf8')) as { puestos: Puesto[] };
    puestos = datos.puestos;
    db = await connect();
    const r = await db.query<{ rol: string; permiso: string }>(
      `SELECT r.code AS rol, p.code AS permiso FROM roles r
         JOIN role_permissions rp ON rp.role_id = r.id JOIN permissions p ON p.id = rp.permission_id
        WHERE r.code = ANY($1) ORDER BY 1, 2`,
      [puestos.map((p) => p.codigo)],
    );
    for (const f of r.rows) (permisosDe[f.rol] ??= []).push(f.permiso);
  });

  afterAll(async () => {
    await db.end();
  });

  it('el archivo tiene muchos puestos, sin códigos ni nombres repetidos', () => {
    expect(puestos.length).toBeGreaterThanOrEqual(26);
    expect(new Set(puestos.map((p) => p.codigo)).size).toBe(puestos.length);
    expect(new Set(puestos.map((p) => p.nombre)).size).toBe(puestos.length);
    for (const p of puestos) {
      expect(p.descripcion.length, `${p.codigo} sin descripción`).toBeGreaterThan(20);
      expect(p.permisos, `${p.codigo} repite un permiso`).toEqual([...new Set(p.permisos)]);
    }
  });

  it('la base tiene exactamente los puestos del archivo, con su área y su descripción', async () => {
    const r = await db.query<{ code: string; name: string; area: string; description: string }>(
      `SELECT code, name, area, description FROM roles WHERE code = ANY($1) ORDER BY code`,
      [puestos.map((p) => p.codigo)],
    );
    expect(r.rows.map((f) => f.code)).toEqual(puestos.map((p) => p.codigo).sort());
    for (const f of r.rows) {
      const p = puestos.find((x) => x.codigo === f.code)!;
      expect(f, f.code).toMatchObject({ name: p.nombre, area: p.area, description: p.descripcion });
    }
  });

  it('cada puesto tiene exactamente los permisos del archivo', () => {
    for (const p of puestos) {
      expect(permisosDe[p.codigo], `el puesto ${p.codigo} no existe o no tiene permisos`).toBeDefined();
      expect([...permisosDe[p.codigo]!].sort(), p.codigo).toEqual([...p.permisos].sort());
    }
  });

  it('ningún puesto tiene lo que no puede tener', () => {
    for (const p of puestos) {
      for (const permiso of p.permisos) {
        for (const [patron, motivo] of PROHIBIDOS) {
          expect(patron.test(permiso), `${p.codigo} tiene ${permiso}: ${motivo}`).toBe(false);
        }
      }
    }
  });

  it('lo sensible está sólo en los puestos que corresponde', () => {
    for (const [permiso, permitidos] of Object.entries(SOLO_PARA)) {
      const quienes = puestos.filter((p) => p.permisos.includes(permiso)).map((p) => p.codigo).sort();
      expect(quienes, permiso).toEqual([...permitidos].sort());
    }
  });

  it('quien arma no aprueba: el Tesorero y el Comprador no aprueban lo que arman', () => {
    const por = (c: string) => puestos.find((p) => p.codigo === c)!.permisos;
    expect(por('TESORERO')).toContain('payment_order:write');
    expect(por('TESORERO')).not.toContain('payment_order:approve');
    expect(por('COMPRADOR')).toContain('purchase_request:write');
    expect(por('COMPRADOR')).not.toContain('purchase_request:approve');
    // Y el que aprueba pagos puede ver y armar los suyos solo si es el responsable de pagos: queda registrado quién fue cada uno (separación en la base).
    expect(por('RESPONSABLE_DE_PAGOS')).toContain('payment_order:approve');
  });

  it('todos pueden entrar y usar el asistente: sin company:read no hay sesión de empresa', () => {
    for (const p of puestos) {
      expect(p.permisos, p.codigo).toContain('company:read');
      expect(p.permisos, p.codigo).toContain('intelligence:ask');
    }
  });

  it('docs/PUESTOS.md coincide con lo que se genera del archivo y de la consola', () => {
    // Falla (exit 1) si el documento quedó desactualizado: la solución es `npm run docs:puestos`.
    expect(() => execFileSync('node', ['scripts/documentar-puestos.mjs', '--verificar'], { cwd: RAIZ, stdio: 'pipe' })).not.toThrow();
  });

  it('el segundo factor del servidor coincide con el del archivo', () => {
    const delArchivo = puestos.filter((p) => p.segundoFactor).map((p) => p.codigo);
    const delServidor = [...ROLES_REQUIRING_MFA].filter((r) => !['ADMINISTRADOR', 'CONTADOR', 'AUDITOR'].includes(r));
    expect(delServidor.sort()).toEqual(delArchivo.sort());
    // Y todo puesto que aprueba, ajusta stock o toca la contabilidad lo exige: no es opcional.
    for (const p of puestos) {
      const sensible = p.permisos.some((x) => /:approve$|^stock:adjust$|^journal_entry:create$|^vat_book:generate$|^tax_/u.test(x));
      if (sensible) expect(p.segundoFactor, `${p.codigo} es sensible y no exige segundo factor`).toBe(true);
    }
  });
});
