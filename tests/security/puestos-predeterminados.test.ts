/**
 * S-50 — los puestos predeterminados (migración 0143) tienen exactamente los permisos que dicen tener.
 *
 * Un puesto es un rol con un conjunto de permisos, y de los permisos sale qué módulos ve cada persona. El control tiene dos mitades:
 *
 *   1. **El conjunto exacto.** Cada puesto está escrito acá, permiso por permiso. Si alguien le suma uno a un puesto —aunque sea con la mejor
 *      intención— el test se pone en rojo y hay que decidirlo a propósito: dar un permiso de más a un puesto es regalarle acceso.
 *   2. **Lo que ningún puesto de trabajo puede tener**, escrito aparte y por motivo: contabilidad, administrar el sistema, y aprobar lo que
 *      uno mismo propone.
 */

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { connect, hasDatabase, type Client } from '../integration/helpers/db.js';

const suite = hasDatabase ? describe : describe.skip;

const PUESTOS: Readonly<Record<string, readonly string[]>> = {
  GERENTE: [
    'account:read', 'alert:acknowledge', 'alert:read', 'allocation:read', 'analysis:read', 'analytics:read', 'asset:read', 'audit:read',
    'bank:read', 'billing:read', 'branch:read', 'cash:read', 'check:read', 'commercial:read', 'commission:read', 'company:read',
    'cost_center:read', 'crm:read', 'decision:approve', 'decision:read', 'decision:write', 'document:read', 'intelligence:ask',
    'journal_entry:read', 'party:read', 'payment_order:approve', 'payment_order:read', 'period:read', 'prediction:read', 'product:read',
    'project:read', 'purchase_request:approve', 'purchase_request:read', 'receipt:read', 'report:read', 'statement:read', 'stock:read',
    'vat_book:read',
  ],
  VENDEDOR: [
    'branch:read', 'commercial:read', 'commercial:write', 'commission:read', 'company:read', 'crm:read', 'crm:write', 'document:read',
    'intelligence:ask', 'party:read', 'party:write', 'product:read',
  ],
  COMPRADOR: [
    'company:read', 'document:read', 'document:upload', 'intelligence:ask', 'party:read', 'party:write', 'payment_order:read', 'product:read',
    'purchase_request:read', 'purchase_request:write', 'receipt:read', 'stock:read',
  ],
  TESORERO: [
    'bank:import', 'bank:read', 'bank:reconcile', 'cash:read', 'cash:write', 'check:read', 'check:write', 'company:read', 'document:read',
    'intelligence:ask', 'party:read', 'payment_order:read', 'payment_order:write',
  ],
  DEPOSITO: [
    'company:read', 'document:read', 'intelligence:ask', 'product:read', 'purchase_request:read', 'receipt:read', 'receipt:write',
    'stock:count', 'stock:read', 'stock:write',
  ],
};

/** Lo que ninguno de los cinco puestos de trabajo puede tener, y por qué. */
const PROHIBIDOS: ReadonlyArray<[RegExp, string]> = [
  [/^(journal_entry:(create|approve|reverse)|period:(write|block|close|reopen)|fiscal_year:close|statement:issue|book:emit|note:write|vat_book:generate|account:write)$/u, 'la contabilidad es del Contador'],
  [/^(user:manage|secret:manage|arca_credential:manage|company:(write|create|export)|subscription:write|migration:.+|integration:connect)$/u, 'administrar el sistema es del Administrador'],
  [/^stock:adjust$/u, 'un ajuste de stock cambia el inventario contable: no lo hace quien lo cuenta'],
];

suite('S-50 — los puestos predeterminados', () => {
  let db: Client;
  const permisosDe: Record<string, string[]> = {};

  beforeAll(async () => {
    db = await connect();
    const r = await db.query<{ rol: string; permiso: string }>(
      `SELECT r.code AS rol, p.code AS permiso FROM roles r
         JOIN role_permissions rp ON rp.role_id = r.id JOIN permissions p ON p.id = rp.permission_id
        WHERE r.code = ANY($1) ORDER BY 1, 2`,
      [Object.keys(PUESTOS)],
    );
    for (const f of r.rows) (permisosDe[f.rol] ??= []).push(f.permiso);
  });

  afterAll(async () => {
    await db.end();
  });

  for (const [puesto, esperados] of Object.entries(PUESTOS)) {
    it(`${puesto} tiene exactamente los permisos declarados`, () => {
      expect(permisosDe[puesto], `el puesto ${puesto} no existe o no tiene permisos`).toBeDefined();
      expect([...permisosDe[puesto]!].sort()).toEqual([...esperados].sort());
    });

    it(`${puesto} no tiene nada de lo que un puesto de trabajo no puede tener`, () => {
      for (const permiso of permisosDe[puesto] ?? []) {
        for (const [patron, motivo] of PROHIBIDOS) {
          expect(patron.test(permiso), `${puesto} tiene ${permiso}: ${motivo}`).toBe(false);
        }
      }
    });
  }

  it('quien propone no aprueba: sólo el Gerente aprueba pedidos de compra y órdenes de pago', () => {
    const quienAprueba = (permiso: string): string[] =>
      Object.entries(permisosDe).filter(([, ps]) => ps.includes(permiso)).map(([r]) => r).sort();
    expect(quienAprueba('purchase_request:approve')).toEqual(['GERENTE']);
    expect(quienAprueba('payment_order:approve')).toEqual(['GERENTE']);
    // Y los que arman los pagos y los pedidos no están entre los que aprueban.
    expect(permisosDe['TESORERO']).toContain('payment_order:write');
    expect(permisosDe['COMPRADOR']).toContain('purchase_request:write');
  });

  it('todos pueden entrar y usar el asistente: sin company:read no hay sesión de empresa', () => {
    for (const puesto of Object.keys(PUESTOS)) {
      expect(permisosDe[puesto], puesto).toContain('company:read');
      expect(permisosDe[puesto], puesto).toContain('intelligence:ask');
    }
  });
});
