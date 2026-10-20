/**
 * Cada plan tiene los módulos que le corresponden, y los demás están cerrados de verdad.
 *
 * Es la auditoría de la lista comercial (docs/PLANES_Y_PRECIOS.md) contra el sistema, plan por plan:
 *
 *   1. Lo DECLARADO: las funcionalidades y los topes de los cinco planes son los de la tabla comercial.
 *   2. Lo que HACE LA API: para una empresa con ese plan, cada módulo incluido contesta y cada módulo excluido contesta
 *      `FUERA_DEL_PLAN` — con una ruta real de cada módulo, no con el nombre de un dominio.
 *   3. Lo que VE LA CONSOLA: cada pantalla del menú está atada a un dominio, y esos dominios son los que corta la API.
 *   4. Lo que CONTESTA EL ASISTENTE: sólo preguntas de los módulos del plan.
 *
 * Si un test de acá falla es porque una de las dos puertas (la pantalla y la API) se separó de la otra, o la lista comercial cambió sin que el
 * sistema se enterara.
 */

import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { preguntasDelPlan, preguntasPara, CATALOGO, FUNCIONALIDAD_DEL_PERMISO } from '@aai/api/intelligence/catalogo';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { connect, hasDatabase, type Client } from './helpers/db.js';
import { crearEntorno, type EntornoApi } from './helpers/entorno-api.js';

const suite = hasDatabase ? describe : describe.skip;

/** La lista comercial: qué funcionalidades trae cada plan. */
const BASE = ['contabilidad', 'fiscal', 'terceros', 'documentos', 'auditoria', 'integraciones', 'arca', 'asistente'];
const GESTION = ['comercial', 'compras', 'stock', 'tesoreria', 'precios'];
const TODO = ['sucursales', 'proyectos', 'comisiones', 'crm', 'analitica', 'analisis', 'inteligencia'];

const MATRIZ: Readonly<Record<string, { nombre: string; funcionalidades: readonly string[]; empresas: number; usuarios: number }>> = {
  CONTABLE: { nombre: 'NEXO Esencial', funcionalidades: BASE, empresas: 1, usuarios: 2 },
  GESTION: { nombre: 'NEXO Gestión', funcionalidades: [...BASE, ...GESTION], empresas: 1, usuarios: 5 },
  ESTUDIO: { nombre: 'NEXO Estudio', funcionalidades: [...BASE, 'analitica'], empresas: 50, usuarios: 5 },
  EMPRESA_B1: { nombre: 'NEXO Empresa', funcionalidades: [...BASE, ...GESTION, ...TODO], empresas: 5, usuarios: 15 },
  COMPLETO: { nombre: 'NEXO Empresa Plus', funcionalidades: [...BASE, ...GESTION, ...TODO], empresas: 20, usuarios: 50 },
};

/** Una ruta real (GET, sin parámetros) de cada módulo. */
const RUTAS: Readonly<Record<string, readonly string[]>> = {
  contabilidad: ['/accounts', '/journal-entries', '/periods', '/statements', '/accounting-map', '/fiscal-years'],
  fiscal: ['/tax-transactions'],
  terceros: ['/parties'],
  documentos: ['/documents'],
  auditoria: ['/audit'],
  comercial: ['/commercial-documents'],
  compras: ['/purchase-requests', '/goods-receipts', '/payment-orders'],
  stock: ['/stock', '/warehouses', '/stock-counts', '/stock-valuation', '/fixed-assets'],
  tesoreria: ['/cash-boxes', '/banks/accounts', '/checks'],
  precios: ['/products', '/price-lists'],
  sucursales: ['/branches'],
  proyectos: ['/projects'],
  comisiones: ['/salespeople'],
  crm: ['/crm/opportunities'],
  analitica: ['/analytics/resumen'],
  analisis: ['/analysis/signals', '/decision-records'],
  inteligencia: ['/intelligence/preguntas', '/predictions'],
  integraciones: ['/integrations'],
  asistente: ['/asistente/estado'],
  arca: ['/companies/current/arca/capabilities'],
};

suite('cada plan tiene los módulos que le corresponden', () => {
  let db: Client;

  beforeAll(async () => {
    db = await connect();
  });
  afterAll(async () => {
    await db?.end();
  });

  describe('1 · lo declarado', () => {
    it.each(Object.entries(MATRIZ))('%s trae exactamente sus funcionalidades', async (codigo, plan) => {
      const r = await db.query<{ feature_code: string }>(
        `SELECT pf.feature_code FROM plan_features pf JOIN subscription_plans p ON p.id = pf.plan_id WHERE p.code = $1 ORDER BY 1`,
        [codigo],
      );
      expect(r.rows.map((f) => f.feature_code), `${plan.nombre} (${codigo})`).toEqual([...plan.funcionalidades].sort());
    });

    it.each(Object.entries(MATRIZ))('%s: empresas y usuarios son los de la lista, y comprobantes, documentos e integraciones son ilimitados', async (codigo, plan) => {
      const r = await db.query<{ recurso: string; tope: number | null; ilimitado: boolean }>(
        `SELECT l.recurso, l.tope, l.ilimitado FROM plan_limits l JOIN subscription_plans p ON p.id = l.plan_id WHERE p.code = $1`,
        [codigo],
      );
      const por = new Map(r.rows.map((f) => [f.recurso, f]));
      expect(por.get('EMPRESAS')).toMatchObject({ tope: plan.empresas, ilimitado: false });
      expect(por.get('USUARIOS')).toMatchObject({ tope: plan.usuarios, ilimitado: false });
      for (const recurso of ['COMPROBANTES_MES', 'DOCUMENTOS_MES', 'INTEGRACIONES']) expect(por.get(recurso)?.ilimitado, `${codigo} ${recurso}`).toBe(true);
    });

    it('los cinco planes están a la venta, con nombre y descripción', async () => {
      const r = await db.query<{ code: string; name: string; descripcion: string; status: string }>(
        `SELECT code, name, descripcion, status FROM subscription_plans WHERE code = ANY ($1)`,
        [Object.keys(MATRIZ)],
      );
      expect(r.rows).toHaveLength(5);
      for (const p of r.rows) {
        expect(p.status, p.code).toBe('DISPONIBLE');
        expect(p.name, p.code).toBe(MATRIZ[p.code]!.nombre);
        expect(p.descripcion.length, p.code).toBeGreaterThan(40);
      }
    });
  });

  describe('2 · lo que hace la API, plan por plan', () => {
    for (const [codigo, plan] of Object.entries(MATRIZ)) {
      it(`${plan.nombre}: abre sus módulos y cierra el resto`, async () => {
        const env: EntornoApi = await crearEntorno(`plan-${codigo.toLowerCase()}`);
        try {
          const planId = (await env.db.query<{ id: string }>('SELECT id FROM subscription_plans WHERE code = $1', [codigo])).rows[0]!.id;
          await env.db.query(
            `INSERT INTO company_subscriptions (company_id, plan_id, estado, vigencia_desde, created_by) VALUES ($1, $2, 'ACTIVA', CURRENT_DATE, 'test')`,
            [env.empresa, planId],
          );

          const incluidas = new Set(plan.funcionalidades);
          const errores: string[] = [];
          for (const [funcionalidad, rutas] of Object.entries(RUTAS)) {
            for (const ruta of rutas) {
              const r = await env.pedir('GET', ruta);
              const cerrada = r.statusCode === 403 && r.json<{ error?: string }>().error === 'FUERA_DEL_PLAN';
              if (incluidas.has(funcionalidad) && cerrada) errores.push(`${ruta} (${funcionalidad}) está cerrada y el plan la incluye`);
              if (!incluidas.has(funcionalidad) && !cerrada) errores.push(`${ruta} (${funcionalidad}) NO está cerrada y el plan no la incluye (respondió ${r.statusCode})`);
            }
          }
          expect(errores, `${plan.nombre}: la API y la lista comercial no coinciden`).toEqual([]);
        } finally {
          await env.cerrar();
        }
      }, 120_000);
    }
  });

  describe('3 · lo que ve la consola', () => {
    it('cada pantalla del menú atada a un módulo usa un dominio que la API corta, y viceversa', async () => {
      const html = await readFile(join(import.meta.dirname, '..', '..', 'apps', 'web', 'consola.html'), 'utf8');
      const mapa = html.slice(html.indexOf('const dominioDe = {'), html.indexOf("const fuera = estado.fueraDelPlan || [];"));
      const dominiosDeLaConsola = [...mapa.matchAll(/:\s*'([a-z-]+)'/gu)].map((m) => m[1]!);
      const catalogo = await db.query<{ code: string; dominios: string[] }>('SELECT code, dominios FROM product_features');
      const dominiosCortables = new Set(catalogo.rows.flatMap((f) => f.dominios));
      const sinCorte = dominiosDeLaConsola.filter((d) => !dominiosCortables.has(d));
      expect(sinCorte, 'pantallas atadas a un dominio que ninguna funcionalidad corta: el menú las oculta pero la API no las cierra').toEqual([]);
    });
  });

  describe('4 · lo que contesta el asistente', () => {
    it('todo permiso que usa el catálogo está atado a una funcionalidad del plan (o declarado sin plan)', () => {
      const usados = new Set(CATALOGO.flatMap((p) => p.permisos));
      const sinDecidir = [...usados].filter((p) => !(p in FUNCIONALIDAD_DEL_PERMISO));
      expect(sinDecidir, 'un permiso nuevo en el catálogo exige decidir qué módulo del plan lo cubre').toEqual([]);
    });

    it('las funcionalidades que nombra el mapa existen en el catálogo comercial', async () => {
      const r = await db.query<{ code: string }>('SELECT code FROM product_features');
      const existentes = new Set(r.rows.map((f) => f.code));
      for (const f of Object.values(FUNCIONALIDAD_DEL_PERMISO)) if (f !== null) expect(existentes.has(f), f).toBe(true);
    });

    it('Esencial no ofrece preguntas de stock, de cheques ni de proyectos; Empresa las ofrece todas', () => {
      const todos = new Set(CATALOGO.flatMap((p) => p.permisos));
      const conTodo = preguntasPara(todos);
      const esencial = preguntasDelPlan(conTodo, new Set(MATRIZ['CONTABLE']!.funcionalidades)).map((p) => p.id);
      expect(esencial).not.toContain('VALOR_DEL_STOCK');
      expect(esencial).not.toContain('QUE_CHEQUES_TENGO');
      expect(esencial).not.toContain('COMO_VAN_LOS_PROYECTOS');
      const empresa = preguntasDelPlan(conTodo, new Set(MATRIZ['EMPRESA_B1']!.funcionalidades)).map((p) => p.id);
      expect(empresa).toHaveLength(conTodo.length);
      // Sin suscripción no se restringe (falla abierta, como la puerta comercial).
      expect(preguntasDelPlan(conTodo, null)).toHaveLength(conTodo.length);
    });
  });
});
