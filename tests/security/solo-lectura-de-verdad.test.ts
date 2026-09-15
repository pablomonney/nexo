/**
 * S-29 — «Solo lectura para la aplicación» comprobado contra el catálogo.
 *
 * Este control existe porque el mismo defecto ocurrió tres veces.
 *
 * La 0009 pone `ALTER DEFAULT PRIVILEGES … GRANT SELECT, INSERT, UPDATE`, así
 * que **toda tabla nueva nace escribible por `aai_app`**. Quien crea una tabla
 * que la aplicación no debe escribir escribe `GRANT SELECT ON …`, que se lee
 * como si concediera solo eso, y no quita nada: los privilegios ya estaban.
 *
 *   0086  lo encontró un 500 al recalcular el promedio ponderado.
 *   0096  lo encontró este test: tres archivos afirmaban «solo SELECT» sobre
 *         las tablas de facturación mientras `aai_app` podía emitirse cargos.
 *   0097  la corrección se olvidó de dos objetos, y lo encontró esto de nuevo.
 *
 * Un `REVOKE` por tabla es una lista que alguien tiene que acordarse de ampliar.
 * Esto no es una lista de lo que hay que revocar: es la comprobación de que lo
 * declarado y lo real coinciden, y la hace contra `information_schema`.
 *
 * ## Por qué la declaración vive acá y no en la base
 *
 * Porque «esta tabla la escribe un trigger» y «esta tabla la escribe el
 * operador» son afirmaciones de diseño, y el lugar de una afirmación de diseño
 * que hay que poder revisar es un archivo que se lee en la revisión. Lo que no
 * puede pasar es que la afirmación y la base digan cosas distintas, y eso es lo
 * que este test impide.
 */

import { describe, expect, it } from 'vitest';
import { connect, hasDatabase, type Client } from '../integration/helpers/db.js';

const suite = hasDatabase ? describe : describe.skip;

/**
 * Los objetos que la aplicación **no** debe poder escribir, con el motivo.
 *
 * El motivo no es decorativo: es lo que alguien va a leer el día que un
 * `INSERT` falle con 42501 y no entienda por qué.
 */
const SOLO_LECTURA: Readonly<Record<string, string>> = {
  // Facturación: la escribe el ciclo del operador, no un usuario de una empresa.
  // Un administrador de empresa cliente no puede emitirse un cargo ni marcarlo
  // pagado.
  billing_periods: 'La escribe el ciclo de facturación, que corre como operador',
  billing_documents: 'Un cliente no puede emitirse un cargo ni marcarlo pagado',
  billing_document_lines: 'El detalle de un cargo lo escribe quien lo emite',
  payment_intents: 'Un cliente no puede declarar que pagó',
  collection_steps: 'La cobranza la decide la política, no el cobrado',
  plan_prices: 'El precio de un plan es de NEXO, no de la empresa que lo paga',
  collection_policies: 'La política de cobranza es de NEXO',
  billing_account_status: 'Vista de lectura sobre las anteriores',
  // 0118 la creó diciendo «solo lectura para la aplicación» y escribiendo
  // `GRANT SELECT`, que no quita nada: el defecto de la cabecera de este
  // archivo, por cuarta vez. Lo corrige la 0119. Esta línea es la otra mitad de
  // la corrección — sin ella el control mira una lista donde la tabla no está y
  // no puede fallar.
  payment_plan_map: 'Crear un plan del lado de la pasarela es un acto comercial, no una petición',

  // El promedio ponderado lo escribe un trigger. Que la API pudiera escribirlo
  // sería una segunda verdad sobre el costo, capaz de contradecir al libro
  // (0086).
  stock_movement_ppp: 'La escribe el trigger de stock; una segunda verdad sobre el costo',

  // Normativa: se puebla con revisión humana desde el proceso de carga, no desde
  // un endpoint (0009).
  norms: 'Se puebla con revisión humana, no desde un endpoint',
  norm_versions: 'Se puebla con revisión humana, no desde un endpoint',
  norm_documents: 'Se puebla con revisión humana, no desde un endpoint',
  norm_articles: 'Se puebla con revisión humana, no desde un endpoint',
  norm_modifications: 'Se puebla con revisión humana, no desde un endpoint',
  norm_references: 'Se puebla con revisión humana, no desde un endpoint',
  norm_adoptions: 'Se puebla con revisión humana, no desde un endpoint',
  accounting_rules: 'Una regla sin norma no existe: la carga tiene revisión humana',
};

/** Lo que además no se puede ni leer. */
const NI_LEER: Readonly<Record<string, string>> = {
  payment_events: 'Diario de integración del operador: la aplicación no lo mira',
};

/**
 * Bandejas: la aplicación **deja** y no **mira**.
 *
 * Es una tercera forma, y hasta ahora no estaba declarada en ninguna parte. Las
 * dos tablas de abajo dicen en su `COMMENT` «insertar sí, leer no», y eso vivía
 * únicamente en la prosa de una migración: `email_outbox` está así desde la
 * 0103 y nada comprobaba que siguiera estándolo.
 *
 * La forma existe porque hay contenido que la aplicación **produce** y no debe
 * **consultar**:
 *
 *   email_outbox            el cuerpo de un mensaje de verificación lleva el
 *                           token de alta. Poder leer la bandeja sería poder
 *                           tomar la cuenta de cualquiera.
 *   payment_webhook_inbox   poder leerla sería poder enumerar los
 *                           identificadores de cobro de todas las empresas.
 *
 * Las dos direcciones importan y por eso se comprueban las dos. Sin `INSERT` el
 * alta deja de funcionar y no se manda ningún correo; con `SELECT` se abre lo
 * que las dos tablas existen para tener cerrado.
 */
const SOLO_INSERTA: Readonly<Record<string, string>> = {
  email_outbox: 'El cuerpo de un mensaje de verificación lleva el token de alta (0103)',
  payment_webhook_inbox: 'Leerla sería enumerar los cobros de todas las empresas (0119)',
};

/**
 * Dónde la aplicación **sí** puede borrar, y por qué.
 *
 * La 0009 dice «`DELETE` no se concede en ninguna tabla», y desde la 0049 dejó
 * de ser cierto: trece tablas lo tienen concedido a propósito. Son todas
 * **renglones de un documento en preparación** o **asociaciones**, no hechos
 * económicos: sacar una línea de un presupuesto antes de emitirlo es editar un
 * borrador, no borrar historia.
 *
 * Lo que ninguna tiene es `DELETE` sobre el hecho en sí. Un asiento no se borra,
 * se anula; una factura emitida no se borra, se acredita.
 *
 * Que la lista esté escrita acá y comprobada contra el catálogo es lo que
 * convierte «no se borra nada importante» de afirmación en control: la próxima
 * migración que conceda `DELETE` sobre algo que sí es un hecho tiene que pasar
 * por agregarlo a esta lista, y ahí alguien lo va a leer.
 */
const CON_DELETE: Readonly<Record<string, string>> = {
  checks: 'Un cheque cargado por error se saca antes de moverlo; los movimientos no',
  commercial_document_lines: 'Renglón de un documento comercial en preparación',
  company_account_map: 'Asociación entre concepto y cuenta: se cambia, no es un hecho',
  goods_receipt_lines: 'Renglón de una recepción en preparación',
  migration_findings:
    'Lo que el validador opina hoy sobre una fila cruda con el mapeo de hoy: es derivado y ' +
    'se recalcula entero en cada validación. La prueba de lo que el origen traía está en ' +
    'migration_rows, que sí es inmutable y no tiene DELETE (0112)',
  party_price_lists: 'Asignación de lista a un tercero',
  payment_order_lines: 'Renglón de una orden de pago en preparación',
  payment_orders: 'Orden de pago en preparación; una vez pagada la impide el trigger',
  price_list_items: 'Ítem de una lista de precios',
  price_lists: 'Lista de precios sin uso',
  purchase_request_lines: 'Renglón de una solicitud de compra en preparación',
  stock_count_lines: 'Renglón de un recuento en preparación',
  tax_transaction_installments: 'Cuota de un plan de pagos que se rearma',
  tax_transaction_lines: 'Renglón de un comprobante en preparación',
};

suite('S-29 — lo declarado de solo lectura lo es de verdad', () => {
  const conectar = async (): Promise<Client> => connect();

  it('ninguna tabla declarada de solo lectura acepta escritura de aai_app', async () => {
    const db = await conectar();
    try {
      const { rows } = await db.query<{ table_name: string; privilege_type: string }>(
        `SELECT table_name, privilege_type
           FROM information_schema.role_table_grants
          WHERE grantee = 'aai_app'
            AND privilege_type IN ('INSERT', 'UPDATE', 'DELETE')
            AND table_name = ANY($1::text[])
          ORDER BY table_name, privilege_type`,
        [Object.keys(SOLO_LECTURA)],
      );

      const sobrantes = rows.map((r) => `${r.table_name}: ${r.privilege_type}`);
      expect(
        sobrantes,
        'estos objetos se declaran de solo lectura para la aplicación y la base dice ' +
          'otra cosa. Casi siempre es un `GRANT SELECT` puesto donde hacía falta un ' +
          '`REVOKE INSERT, UPDATE, DELETE`: la 0009 concede escritura sobre toda tabla ' +
          'nueva con ALTER DEFAULT PRIVILEGES, y un GRANT no quita lo que ya estaba',
      ).toEqual([]);
    } finally {
      await db.end();
    }
  });

  it('sí las puede leer: un revoke de más rompe la aplicación en silencio', async () => {
    // El control positivo. Sin él, este archivo daría verde con `REVOKE ALL`
    // sobre todo, que también deja la lista vacía — y la consola quedaría
    // mostrando pantallas en blanco sin un solo error en el log.
    const db = await conectar();
    try {
      const { rows } = await db.query<{ table_name: string }>(
        `SELECT table_name FROM information_schema.role_table_grants
          WHERE grantee = 'aai_app' AND privilege_type = 'SELECT'
            AND table_name = ANY($1::text[])`,
        [Object.keys(SOLO_LECTURA)],
      );
      expect(new Set(rows.map((r) => r.table_name))).toEqual(new Set(Object.keys(SOLO_LECTURA)));
    } finally {
      await db.end();
    }
  });

  it('lo que no se debe ni leer, no se lee', async () => {
    const db = await conectar();
    try {
      const { rows } = await db.query<{ table_name: string; privilege_type: string }>(
        `SELECT table_name, privilege_type FROM information_schema.role_table_grants
          WHERE grantee = 'aai_app' AND table_name = ANY($1::text[])`,
        [Object.keys(NI_LEER)],
      );
      expect(rows).toEqual([]);
    } finally {
      await db.end();
    }
  });

  it('en una bandeja la aplicación deja y no mira', async () => {
    const db = await conectar();
    try {
      const { rows } = await db.query<{ table_name: string; privilege_type: string }>(
        `SELECT table_name, privilege_type FROM information_schema.role_table_grants
          WHERE grantee = 'aai_app' AND table_name = ANY($1::text[])
          ORDER BY table_name, privilege_type`,
        [Object.keys(SOLO_INSERTA)],
      );

      const porTabla = new Map<string, string[]>();
      for (const r of rows) {
        porTabla.set(r.table_name, [...(porTabla.get(r.table_name) ?? []), r.privilege_type]);
      }

      // Se comprueban las dos direcciones en una sola aserción para que el
      // mensaje de error muestre lo que la tabla tiene, no solo que difiere.
      const real = Object.fromEntries(
        Object.keys(SOLO_INSERTA).map((t) => [t, (porTabla.get(t) ?? []).sort()]),
      );
      const esperado = Object.fromEntries(Object.keys(SOLO_INSERTA).map((t) => [t, ['INSERT']]));

      expect(
        real,
        'una bandeja se escribe y no se lee. Con SELECT de más se abre lo que la tabla ' +
          'existe para tener cerrado; sin INSERT, la aplicación deja de poder encolar y ' +
          'el alta se rompe en silencio',
      ).toEqual(esperado);
    } finally {
      await db.end();
    }
  });

  it('la secuencia de numeración de cobros no la consume la aplicación', async () => {
    // Un número consumido sin documento que lo use es un hueco imposible de
    // explicar después.
    const db = await conectar();
    try {
      const { rows } = await db.query<{ n: string }>(
        `SELECT count(*)::text AS n FROM information_schema.usage_privileges
          WHERE grantee = 'aai_app' AND object_name = 'billing_documents_numero_seq'`,
      );
      expect(rows[0]!.n).toBe('0');
    } finally {
      await db.end();
    }
  });

  it('DELETE se concede solo donde está declarado, y en ningún otro lado', async () => {
    const db = await conectar();
    try {
      const { rows } = await db.query<{ table_name: string }>(
        `SELECT DISTINCT table_name FROM information_schema.role_table_grants
          WHERE grantee = 'aai_app' AND privilege_type = 'DELETE'
          ORDER BY table_name`,
      );
      expect(
        rows.map((r) => r.table_name),
        'una tabla con DELETE que no está en CON_DELETE. Si es a propósito, agregala ahí ' +
          'con el motivo; si no, el `GRANT` de su migración concedió de más',
      ).toEqual(Object.keys(CON_DELETE).sort());
    } finally {
      await db.end();
    }
  });
});
