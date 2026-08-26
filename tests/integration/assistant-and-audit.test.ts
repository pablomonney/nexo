/**
 * Los candados de FASE 14, contra PostgreSQL real.
 *
 * El invariante de la fase: **no hay ningún estado en el que una cifra inventada
 * llegue al usuario**. En el motor eso lo garantiza `validarRespuesta`; acá se
 * comprueba que tampoco se pueda por SQL.
 */

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  connect,
  expectFailure,
  expectFailureCode,
  hasDatabase,
  seed,
  type Client,
  type Fixture,
} from './helpers/db.js';

const suite = hasDatabase ? describe : describe.skip;

suite('Candados del asistente y la auditoría', () => {
  let client: Client;
  let fx: Fixture;
  let promptHash = '';

  beforeAll(async () => {
    client = await connect();
    fx = await seed(client, `${Date.now() % 100000}`);
    const prompt = await client.query<{ hash: string }>(
      'SELECT hash FROM prompt_versions LIMIT 1',
    );
    promptHash = prompt.rows[0]?.hash ?? '';
  });

  afterAll(async () => {
    await client?.end();
  });

  async function insertarRespuesta(
    overrides: Partial<Record<string, unknown>> = {},
  ): Promise<string> {
    const valores = {
      respuesta: 'Vendiste 1.234.567,89 en el período.',
      abstencion: false,
      aceptada: true,
      rechazos: '[]',
      cifras_inventadas: 0,
      ...overrides,
    };
    const result = await client.query<{ id: string }>(
      `INSERT INTO ai_answers
         (company_id, pregunta, contexto, respuesta, abstencion, aceptada, rechazos,
          cifras_inventadas, model_provider, model_id, prompt_hash, created_by)
       VALUES ($1, '¿Cuánto vendí?', '{"datos":[]}'::jsonb, $2, $3, $4, $5::jsonb, $6,
               'none', 'deterministic', $7, 'tester')
       RETURNING id`,
      [
        fx.companyA,
        valores.respuesta,
        valores.abstencion,
        valores.aceptada,
        valores.rechazos,
        valores.cifras_inventadas,
        promptHash,
      ],
    );
    return result.rows[0]!.id;
  }

  it('una respuesta con cifras inventadas no se puede marcar como aceptada', () => {
    // Es el candado del módulo: no hay estado en el que una cifra inventada
    // llegue al usuario.
    return expectFailureCode(async () =>
      insertarRespuesta({ aceptada: true, cifras_inventadas: 1 }),
    ).then((codigo) => {
      expect(codigo.code).toBe('23514');
    });
  });

  it('una respuesta rechazada se guarda igual, con sus motivos', async () => {
    const id = await insertarRespuesta({
      aceptada: false,
      cifras_inventadas: 2,
      rechazos: JSON.stringify([{ codigo: 'CIFRA_INVENTADA', esAlucinacion: true }]),
    });

    // Borrarla haría que la métrica de alucinación se vea mejor de lo que es.
    const fila = await client.query<{ cifras_inventadas: number }>(
      'SELECT cifras_inventadas FROM ai_answers WHERE id = $1',
      [id],
    );
    expect(fila.rows[0]?.cifras_inventadas).toBe(2);
  });

  it('una respuesta rechazada sin motivos no se puede guardar', async () => {
    const codigo = await expectFailureCode(async () =>
      insertarRespuesta({ aceptada: false, rechazos: '[]' }),
    );

    expect(codigo.code).toBe('23514');
  });

  it('una respuesta aceptada y vacía tampoco, salvo que sea abstención', async () => {
    const codigo = await expectFailureCode(async () =>
      insertarRespuesta({ aceptada: true, respuesta: '   ', abstencion: false }),
    );
    expect(codigo.code).toBe('23514');

    // Abstenerse sí puede venir sin texto: es una salida prevista.
    const id = await insertarRespuesta({ aceptada: true, respuesta: null, abstencion: true });
    expect(id).toMatch(/^[0-9a-f-]{36}$/);
  });

  it('una respuesta guardada es inmutable', async () => {
    const id = await insertarRespuesta();
    const mensaje = await expectFailure(async () =>
      client.query(`UPDATE ai_answers SET respuesta = 'otra cosa' WHERE id = $1`, [id]),
    );

    expect(mensaje).toMatch(/no se edita/);
    expect(mensaje).toMatch(/Volvé a preguntar/);
  });

  it('la métrica separa alucinación de otros rechazos', async () => {
    const metricas = await client.query<{
      con_cifra_inventada: number;
      otros_rechazos: number;
      abstenciones: number;
    }>(
      `SELECT con_cifra_inventada, otros_rechazos, abstenciones
         FROM ai_answer_metrics WHERE company_id = $1`,
      [fx.companyA],
    );

    const fila = metricas.rows[0];
    expect(fila?.con_cifra_inventada).toBeGreaterThan(0);
    // Mezclarlas en un solo porcentaje haría invisible a la primera, que es la
    // única que no se corrige con más contexto.
    expect(fila?.abstenciones).toBeGreaterThan(0);
  });

  it('la aplicación puede insertar respuestas pero no editarlas', async () => {
    const permisos = await client.query<{ privilege_type: string }>(
      `SELECT privilege_type FROM information_schema.table_privileges
        WHERE grantee = 'aai_app' AND table_name = 'ai_answers'`,
    );
    const tipos = permisos.rows.map((fila) => fila.privilege_type);

    expect(tipos).toContain('INSERT');
    expect(tipos).not.toContain('UPDATE');
  });

  it('un hallazgo no tiene severidad ni conclusión: tiene qué se observó y qué mirar', async () => {
    const columnas = await client.query<{ column_name: string }>(
      `SELECT column_name FROM information_schema.columns WHERE table_name = 'audit_findings'`,
    );
    const nombres = columnas.rows.map((fila) => fila.column_name);

    expect(nombres).toContain('observado');
    expect(nombres).toContain('que_mirar');
    // Ponerle un puntaje de riesgo exigiría un número que el software no funda.
    expect(nombres).not.toContain('severidad');
    expect(nombres).not.toContain('conclusion');
    expect(nombres).not.toContain('riesgo');
  });

  it('cerrar un hallazgo exige quién y por qué', async () => {
    const hallazgo = await client.query<{ id: string }>(
      `INSERT INTO audit_findings (company_id, codigo, observado, que_mirar)
       VALUES ($1, 'IMPORTE_REDONDO', 'El importe es exactamente redondo.',
               'Verificar contra el comprobante.')
       RETURNING id`,
      [fx.companyA],
    );
    const id = hallazgo.rows[0]!.id;

    const codigo = await expectFailureCode(async () =>
      client.query(`UPDATE audit_findings SET estado = 'REVISADO_SIN_ACCION' WHERE id = $1`, [id]),
    );
    expect(codigo.code).toBe('23514');

    // Con comentario y firma, sí.
    await client.query(
      `UPDATE audit_findings
          SET estado = 'REVISADO_SIN_ACCION', revisado_por = 'contador',
              revisado_el = now(), comentario = 'Alquiler mensual, es redondo por contrato.'
        WHERE id = $1`,
      [id],
    );
    const estado = await client.query<{ estado: string }>(
      'SELECT estado FROM audit_findings WHERE id = $1',
      [id],
    );
    expect(estado.rows[0]?.estado).toBe('REVISADO_SIN_ACCION');
  });

  it('un hallazgo sin observado o sin qué mirar no se puede insertar', async () => {
    const codigo = await expectFailureCode(async () =>
      client.query(
        `INSERT INTO audit_findings (company_id, codigo, observado, que_mirar)
         VALUES ($1, 'IMPORTE_REDONDO', '  ', 'x')`,
        [fx.companyA],
      ),
    );

    expect(codigo.code).toBe('23514');
  });

  it('el auditor no recibe assistant:ask', async () => {
    // No es prolijidad: un auditor que consulta al asistente sobre los datos que
    // audita mete en su papel de trabajo una afirmación generada.
    const permiso = await client.query<{ n: string }>(
      `SELECT count(*)::text AS n
         FROM role_permissions rp
         JOIN roles r ON r.id = rp.role_id
         JOIN permissions p ON p.id = rp.permission_id
        WHERE r.code = 'AUDITOR' AND p.code = 'assistant:ask'`,
    );

    expect(permiso.rows[0]?.n).toBe('0');
  });

  it('nada se borra: ni hallazgos ni respuestas', async () => {
    const mensaje = await expectFailure(async () =>
      client.query('DELETE FROM ai_answers WHERE company_id = $1', [fx.companyA]),
    );

    expect(mensaje).toMatch(/[Bb]orrado/);
  });
});
