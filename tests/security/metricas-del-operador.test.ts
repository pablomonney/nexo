/**
 * S-30 — Las métricas del negocio no las ve ninguna empresa.
 *
 * Las vistas `saas_*` agregan sobre **todas** las empresas: MRR, altas, bajas,
 * cobranza. Son del negocio de NEXO, no de sus clientes.
 *
 * Y son las únicas vistas del repositorio **sin `security_invoker`**, porque su
 * propósito es exactamente el contrario al de las demás: atravesar el RLS en vez
 * de respetarlo. Eso las vuelve el objeto más peligroso del esquema si alguna
 * vez fueran legibles por la aplicación — un usuario de cualquier empresa vería
 * la facturación de todas, sin nada que lo filtrara.
 *
 * Lo único que lo impide es el `REVOKE` de la 0100, y un `REVOKE` es
 * exactamente el tipo de línea que una migración posterior deshace sin querer:
 * la 0009 concede `SELECT, INSERT, UPDATE` sobre **todo objeto nuevo**, así que
 * basta con recrear una de estas vistas para que vuelva a ser legible.
 *
 * Por eso el control no es leer la migración: es preguntarle al catálogo.
 */

import { describe, expect, it } from 'vitest';
import { connect, hasDatabase } from '../integration/helpers/db.js';

const suite = hasDatabase ? describe : describe.skip;

/**
 * Las vistas del operador, con lo que cada una atraviesa.
 *
 * La lista está acá y no se deduce del prefijo `saas_` a propósito: agregar una
 * vista con ese prefijo no debería alcanzar para declararla del operador sin que
 * alguien lo escriba. Pero el test **también** barre por prefijo, más abajo, para
 * que una vista nueva que se olvide de declararse tampoco pase.
 */
const DEL_OPERADOR: Readonly<Record<string, string>> = {
  saas_suscripciones_vigentes: 'Las suscripciones de todas las empresas, con su importe',
  saas_ingreso_recurrente: 'MRR, ARR y ARPU del negocio entero',
  saas_sin_importe: 'Qué suscripciones quedaron afuera del MRR',
  saas_movimientos: 'Altas y bajas de todas las empresas, desde la bitácora',
  saas_cobranza_mensual: 'Lo emitido y lo cobrado, mes a mes, a todos los clientes',
};

suite('S-30 — las métricas del negocio no las ve ninguna empresa', () => {
  it('aai_app no tiene ningún privilegio sobre las vistas del operador', async () => {
    const db = await connect();
    try {
      const { rows } = await db.query<{ table_name: string; privilege_type: string }>(
        `SELECT table_name, privilege_type FROM information_schema.role_table_grants
          WHERE grantee = 'aai_app' AND table_name = ANY($1::text[])
          ORDER BY table_name, privilege_type`,
        [Object.keys(DEL_OPERADOR)],
      );
      expect(
        rows.map((r) => `${r.table_name}: ${r.privilege_type}`),
        'estas vistas atraviesan el RLS de todas las empresas y la aplicación puede ' +
          'leerlas. Casi siempre es una migración que recreó la vista: la 0009 concede ' +
          'sobre todo objeto nuevo, así que hay que volver a revocar',
      ).toEqual([]);
    } finally {
      await db.end();
    }
  });

  it('ninguna vista saas_* quedó legible, ni siquiera una que nadie declaró', async () => {
    // El barrido por prefijo. La lista de arriba dice qué hay; esto encuentra lo
    // que alguien agregó sin decirlo.
    const db = await connect();
    try {
      const { rows } = await db.query<{ table_name: string }>(
        `SELECT DISTINCT table_name FROM information_schema.role_table_grants
          WHERE grantee = 'aai_app' AND table_name LIKE 'saas\\_%'
          ORDER BY table_name`,
      );
      expect(rows.map((r) => r.table_name)).toEqual([]);
    } finally {
      await db.end();
    }
  });

  it('siguen existiendo: un REVOKE no sirve si la vista se borró', async () => {
    // El control positivo. Sin él, este archivo daría verde si alguien borrara
    // las cinco vistas: cero privilegios sobre cero objetos.
    const db = await connect();
    try {
      const { rows } = await db.query<{ table_name: string }>(
        `SELECT table_name FROM information_schema.views
          WHERE table_schema = 'public' AND table_name = ANY($1::text[])`,
        [Object.keys(DEL_OPERADOR)],
      );
      expect(new Set(rows.map((r) => r.table_name))).toEqual(new Set(Object.keys(DEL_OPERADOR)));
    } finally {
      await db.end();
    }
  });

  it('no hay ninguna ruta que devuelva métricas del negocio', async () => {
    // Si existiera, tendría que leerlas con un rol que las pueda leer, y ese rol
    // no es el de la aplicación. Un endpoint así es la señal de que alguien
    // aflojó el REVOKE de arriba para hacerlo andar.
    const { readFile } = await import('node:fs/promises');
    const { join, dirname } = await import('node:path');
    const { fileURLToPath } = await import('node:url');
    const raiz = join(dirname(fileURLToPath(import.meta.url)), '..', '..');

    const { readdir } = await import('node:fs/promises');
    const rutas = await readdir(join(raiz, 'apps', 'api', 'src', 'routes'));
    const culpables: string[] = [];
    for (const archivo of rutas.filter((f) => f.endsWith('.ts'))) {
      const texto = await readFile(join(raiz, 'apps', 'api', 'src', 'routes', archivo), 'utf8');
      if (/\bsaas_[a-z_]+/u.test(texto)) culpables.push(archivo);
    }
    expect(
      culpables,
      'una ruta nombra una vista del operador. Las métricas del negocio salen por ' +
        '`npm run metricas:saas`, que corre con el rol del operador',
    ).toEqual([]);
  });
});
