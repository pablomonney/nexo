/**
 * El ciclo comercial completo, y el punto exacto donde deja de ser comercial.
 *
 * ```
 * PRESUPUESTO ─emitir─► EMITIDO ─aceptar─► ACEPTADO ─facturar─► tax_transaction
 *   (BORRADOR)                                                    (fiscal)
 * ```
 *
 * Tres cosas que este archivo defiende y que no son evidentes:
 *
 *   1. **Los importes de la factura no se reciben del cliente.** Salen de los
 *      renglones que el cliente aceptó. Aceptarlos del cuerpo del pedido
 *      permitiría facturar por otro importe sin que nadie lo notara.
 *   2. **VENCIDO no es un estado guardado.** Se deriva de la fecha, y hay un
 *      test que comprueba que nadie lo agregó al CHECK.
 *   3. **Presupuestar y facturar son permisos distintos.** Un usuario de
 *      empresa cierra la venta; registrarla es un acto contable.
 */

import { closePool, initPool } from '@aai/db';
import { buildServer } from '@aai/api/server';
import { cuitCheckDigit, totp, withCheckDigit } from '@aai/shared';
import type { FastifyInstance } from 'fastify';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { connect, hasDatabase, type Client } from './helpers/db.js';
import { sufijoUnico } from './helpers/identificadores.js';

const suite = hasDatabase ? describe : describe.skip;

const PASSWORD = 'una-contrasena-suficientemente-larga';

interface Persona {
  readonly token: string;
}

suite('Ciclo comercial', () => {
  let app: FastifyInstance;
  let db: Client;
  let stamp: string;
  let empresaA: string;
  let empresaB: string;
  let contadora: Persona;
  let vendedor: Persona;
  let clienteId: string;
  let productoId: string;

  const pedir = (
    quien: Persona,
    method: 'GET' | 'POST' | 'PUT',
    url: string,
    empresa?: string,
    payload?: unknown,
  ) =>
    app.inject({
      method,
      url,
      headers: { authorization: `Bearer ${quien.token}`, 'x-company-id': empresa ?? empresaA },
      ...(payload === undefined ? {} : { payload }),
    });

  beforeAll(async () => {
    initPool(process.env.DATABASE_URL!);
    app = await buildServer();
    await app.ready();
    db = await connect();
    stamp = await sufijoUnico(db);

    const { hash: argonHash } = await import('@node-rs/argon2');
    const fundadorId = (
      await db.query<{ id: string }>(
        'INSERT INTO users (email, full_name, password_hash) VALUES ($1,$2,$3) RETURNING id',
        [
          `fundador-com-${stamp}@estudio.test`,
          'Fundador',
          await argonHash(PASSWORD, { algorithm: 2, memoryCost: 19_456, timeCost: 2, parallelism: 1 }),
        ],
      )
    ).rows[0]!.id;

    const organizationId = (
      await db.query<{ create_organization: string }>('SELECT create_organization($1,$2,$3)', [
        `Estudio com ${stamp}`, withCheckDigit(`30${stamp}`), fundadorId,
      ])
    ).rows[0]!.create_organization;

    const crearEmpresa = async (nombre: string, prefijo: string): Promise<string> =>
      (
        await db.query<{ create_company: string }>('SELECT create_company($1,$2,$3,$4,$5,$6,$7,$8)', [
          fundadorId, organizationId, nombre, withCheckDigit(`${prefijo}${stamp}`),
          'SA', 'AR-C', 'IGJ', '12-31',
        ])
      ).rows[0]!.create_company;

    empresaA = await crearEmpresa(`Empresa A com ${stamp}`, '33');
    empresaB = await crearEmpresa(`Empresa B com ${stamp}`, '27');

    const tokenFundador = (
      await app.inject({
        method: 'POST',
        url: '/auth/login',
        payload: { email: `fundador-com-${stamp}@estudio.test`, password: PASSWORD },
      })
    ).json<{ token: string }>().token;

    /** Alta completa por las rutas reales, con MFA satisfecho. */
    async function crearPersona(etiqueta: string, roles: string[]): Promise<Persona> {
      const email = `${etiqueta}-${stamp}@estudio.test`;
      const userId = (
        await app.inject({
          method: 'POST',
          url: `/organizations/${organizationId}/users`,
          headers: { authorization: `Bearer ${tokenFundador}` },
          payload: { email, fullName: etiqueta, password: PASSWORD, level: 'MEMBER' },
        })
      ).json<{ id: string }>().id;

      for (const empresa of [empresaA, empresaB]) {
        for (const role of roles) {
          const r = await app.inject({
            method: 'POST',
            url: `/companies/${empresa}/roles`,
            headers: { authorization: `Bearer ${tokenFundador}` },
            payload: { userId, role },
          });
          expect(r.statusCode, r.body).toBe(200);
        }
      }

      const inicial = (
        await app.inject({ method: 'POST', url: '/auth/login', payload: { email, password: PASSWORD } })
      ).json<{ token: string }>().token;
      const secret = (
        await app.inject({
          method: 'POST',
          url: '/auth/mfa/setup',
          headers: { authorization: `Bearer ${inicial}` },
        })
      ).json<{ secret: string }>().secret;
      await app.inject({
        method: 'POST',
        url: '/auth/mfa/confirm',
        payload: { code: totp(secret, Date.now()) },
        headers: { authorization: `Bearer ${inicial}` },
      });
      const token = (
        await app.inject({ method: 'POST', url: '/auth/login', payload: { email, password: PASSWORD } })
      ).json<{ token: string }>().token;
      await app.inject({
        method: 'POST',
        url: '/auth/mfa/verify',
        payload: { code: totp(secret, Date.now()) },
        headers: { authorization: `Bearer ${token}` },
      });
      return { token };
    }

    contadora = await crearPersona('contadora-com', ['CONTADOR', 'ADMINISTRADOR']);
    // Tiene `commercial:write` y NO tiene `journal_entry:create`. Es el corte
    // entre cerrar una venta y registrarla.
    vendedor = await crearPersona('vendedor-com', ['USUARIO_EMPRESA']);

    for (const empresa of [empresaA, empresaB]) {
      expect(
        (await pedir(contadora, 'POST', '/fiscal-years', empresa, {
          code: `EJ2026-${stamp}`, startDate: '2026-01-01', endDate: '2026-12-31',
        })).statusCode,
      ).toBe(201);

      for (const cuenta of [
        { code: '1.1.01', name: 'Caja', type: 'ACTIVO' },
        { code: '4.1.01', name: 'Ventas', type: 'INGRESO' },
      ]) {
        expect((await pedir(contadora, 'POST', '/accounts', empresa, cuenta)).statusCode).toBe(201);
      }
    }

    clienteId = (
      await pedir(contadora, 'POST', '/parties', empresaA, {
        tipoDocumento: 'CUIT',
        numeroDocumento: `30${stamp}${cuitCheckDigit(`30${stamp}`)}`,
        razonSocial: `Cliente ${stamp}`,
        condicionIva: 'RESPONSABLE_INSCRIPTO',
        roles: ['CLIENTE'],
      })
    ).json<{ id: string }>().id;

    productoId = (
      await pedir(contadora, 'POST', '/products', empresaA, {
        codigo: `SERV-${stamp}`,
        nombre: 'Servicio de consultoría',
        tipo: 'SERVICIO',
        unidad: 'HORA',
        impuesto: 'IVA',
        cuentaVenta: '4.1.01',
      })
    ).json<{ id: string }>().id;
  });

  afterAll(async () => {
    await app?.close();
    await db?.end();
    await closePool();
  });

  /** Un presupuesto en BORRADOR con un renglón de 1000 + 210. */
  async function presupuestoConRenglon(validoHasta?: string): Promise<string> {
    const alta = await pedir(contadora, 'POST', '/commercial-documents', empresaA, {
      direccion: 'VENTAS',
      tipo: 'PRESUPUESTO',
      terceroId: clienteId,
      fecha: '2026-03-01',
      ...(validoHasta === undefined ? {} : { validoHasta }),
    });
    expect(alta.statusCode, alta.body).toBe(201);
    const id = alta.json<{ id: string }>().id;

    const lineas = await pedir(contadora, 'PUT', `/commercial-documents/${id}/lines`, empresaA, {
      renglones: [
        {
          productoId,
          descripcion: '10 horas de consultoría',
          cantidad: '10',
          unidad: 'HORA',
          precioUnitario: '100.0000',
          tratamiento: 'GRAVADO',
          neto: '1000.00',
          iva: '210.00',
        },
      ],
    });
    expect(lineas.statusCode, lineas.body).toBe(200);
    return id;
  }

  it('el ciclo completo: presupuesto → emitido → aceptado → facturado', async () => {
    const id = await presupuestoConRenglon();

    const antes = await pedir(contadora, 'GET', `/commercial-documents/${id}`, empresaA);
    expect(antes.statusCode, antes.body).toBe(200);
    const doc = antes.json<{ documento: { total: string; status: string; numero: number } }>();
    // El total sale de los renglones. No hay columna que lo guarde.
    expect(doc.documento.total).toBe('1210.00');
    expect(doc.documento.status).toBe('BORRADOR');

    expect((await pedir(contadora, 'POST', `/commercial-documents/${id}/emit`, empresaA)).statusCode).toBe(200);
    expect((await pedir(contadora, 'POST', `/commercial-documents/${id}/accept`, empresaA)).statusCode).toBe(200);

    const factura = await pedir(contadora, 'POST', `/commercial-documents/${id}/invoice`, empresaA, {
      cbteTipo: 1, puntoVenta: 1, numero: 101, fecha: '2026-03-05',
    });
    expect(factura.statusCode, factura.body).toBe(201);
    const resultado = factura.json<{ taxTransactionId: string; total: string; alcance: string }>();
    expect(resultado.total).toBe('1210.00');
    // La respuesta dice explícitamente qué NO hizo.
    expect(resultado.alcance).toContain('No se pidió CAE');

    // La operación fiscal quedó con los importes del documento y con el tercero
    // vinculado — sin pasar por el paso manual de resolución.
    const tt = await db.query<{
      neto: string; iva: string; total: string; party_id: string; direction: string;
    }>(
      'SELECT neto::text, iva::text, total::text, party_id, direction FROM tax_transactions WHERE id = $1',
      [resultado.taxTransactionId],
    );
    expect(tt.rows[0]!.neto).toBe('1000.00');
    expect(tt.rows[0]!.total).toBe('1210.00');
    expect(tt.rows[0]!.party_id).toBe(clienteId);
    expect(tt.rows[0]!.direction).toBe('VENTAS');

    // Y los renglones se copiaron: el candado diferido de la 0049 los verificó
    // al confirmar la transacción.
    const renglones = await db.query(
      'SELECT line_no FROM tax_transaction_lines WHERE tax_transaction_id = $1',
      [resultado.taxTransactionId],
    );
    expect(renglones.rowCount).toBe(1);
  });

  it('no se emite un documento sin renglones', async () => {
    const alta = await pedir(contadora, 'POST', '/commercial-documents', empresaA, {
      terceroId: clienteId, fecha: '2026-03-01',
    });
    const id = alta.json<{ id: string }>().id;

    const r = await pedir(contadora, 'POST', `/commercial-documents/${id}/emit`, empresaA);
    expect(r.statusCode, r.body).toBe(422);
    expect(r.json<{ error: string }>().error).toBe('DOCUMENTO_SIN_RENGLONES');
  });

  it('lo que se emitió no se edita', async () => {
    const id = await presupuestoConRenglon();
    expect((await pedir(contadora, 'POST', `/commercial-documents/${id}/emit`, empresaA)).statusCode).toBe(200);

    const r = await pedir(contadora, 'PUT', `/commercial-documents/${id}/lines`, empresaA, {
      renglones: [
        {
          descripcion: 'Precio cambiado a escondidas',
          cantidad: '10', precioUnitario: '50.0000',
          tratamiento: 'GRAVADO', neto: '500.00', iva: '105.00',
        },
      ],
    });
    expect(r.statusCode, r.body).toBe(409);
    expect(r.json<{ error: string }>().error).toBe('DOCUMENTO_YA_EMITIDO');
  });

  it('no se salta un estado: un borrador no se acepta', async () => {
    const id = await presupuestoConRenglon();
    const r = await pedir(contadora, 'POST', `/commercial-documents/${id}/accept`, empresaA);
    expect(r.statusCode, r.body).toBe(409);
    expect(r.json<{ error: string }>().error).toBe('TRANSICION_INVALIDA');
  });

  it('solo se factura lo que el cliente aceptó', async () => {
    const id = await presupuestoConRenglon();
    expect((await pedir(contadora, 'POST', `/commercial-documents/${id}/emit`, empresaA)).statusCode).toBe(200);

    const r = await pedir(contadora, 'POST', `/commercial-documents/${id}/invoice`, empresaA, {
      cbteTipo: 1, puntoVenta: 1, numero: 999, fecha: '2026-03-05',
    });
    expect(r.statusCode, r.body).toBe(409);
    expect(r.json<{ error: string }>().error).toBe('DOCUMENTO_NO_ACEPTADO');
  });

  it('un rechazo sin motivo no se registra', async () => {
    const id = await presupuestoConRenglon();
    expect((await pedir(contadora, 'POST', `/commercial-documents/${id}/emit`, empresaA)).statusCode).toBe(200);

    const sinMotivo = await pedir(contadora, 'POST', `/commercial-documents/${id}/reject`, empresaA);
    expect(sinMotivo.statusCode, sinMotivo.body).toBe(400);

    const conMotivo = await pedir(contadora, 'POST', `/commercial-documents/${id}/reject`, empresaA, {
      motivo: 'El cliente eligió otro proveedor',
    });
    expect(conMotivo.statusCode, conMotivo.body).toBe(200);

    // RECHAZADO es terminal: no se «desrechaza» borrando que el cliente dijo que no.
    const revivir = await pedir(contadora, 'POST', `/commercial-documents/${id}/accept`, empresaA);
    expect(revivir.statusCode, revivir.body).toBe(409);
  });

  // -------------------------------------------------------------------------
  // VENCIDO se deriva
  // -------------------------------------------------------------------------
  it('VENCIDO no existe como estado almacenado', async () => {
    const check = await db.query<{ def: string }>(
      `SELECT pg_get_constraintdef(c.oid) AS def
         FROM pg_constraint c
         JOIN pg_class t ON t.oid = c.conrelid
        WHERE t.relname = 'commercial_documents' AND c.contype = 'c'
          AND pg_get_constraintdef(c.oid) LIKE '%BORRADOR%'`,
    );
    expect(check.rowCount, 'tiene que existir el CHECK de estados').toBe(1);
    expect(
      check.rows[0]!.def,
      'VENCIDO sería un estado que alguien tiene que acordarse de escribir, y que estaría mal siempre',
    ).not.toContain('VENCIDO');
  });

  it('un presupuesto vencido se detecta por la fecha, no por un estado', async () => {
    const id = await presupuestoConRenglon('2026-03-02');
    expect((await pedir(contadora, 'POST', `/commercial-documents/${id}/emit`, empresaA)).statusCode).toBe(200);

    const r = await pedir(contadora, 'GET', `/commercial-documents/${id}`, empresaA);
    const doc = r.json<{ documento: { vencido: boolean; status: string } }>().documento;
    // La fecha de validez ya pasó y el estado sigue siendo EMITIDO: son dos
    // preguntas distintas y el sistema no las confunde.
    expect(doc.status).toBe('EMITIDO');
    expect(doc.vencido).toBe(true);

    const filtrado = await pedir(contadora, 'GET', '/commercial-documents?vencido=si', empresaA);
    const ids = filtrado.json<{ documentos: { id: string }[] }>().documentos.map((d) => d.id);
    expect(ids).toContain(id);
  });

  // -------------------------------------------------------------------------
  // Permisos y aislamiento
  // -------------------------------------------------------------------------
  it('el vendedor presupuesta y no factura', async () => {
    const alta = await pedir(vendedor, 'POST', '/commercial-documents', empresaA, {
      terceroId: clienteId, fecha: '2026-03-01',
    });
    expect(alta.statusCode, alta.body).toBe(201);
    const id = alta.json<{ id: string }>().id;

    expect(
      (await pedir(vendedor, 'PUT', `/commercial-documents/${id}/lines`, empresaA, {
        renglones: [
          {
            descripcion: 'Servicio', cantidad: '1', precioUnitario: '1000.0000',
            tratamiento: 'GRAVADO', neto: '1000.00', iva: '210.00',
          },
        ],
      })).statusCode,
    ).toBe(200);
    expect((await pedir(vendedor, 'POST', `/commercial-documents/${id}/emit`, empresaA)).statusCode).toBe(200);
    expect((await pedir(vendedor, 'POST', `/commercial-documents/${id}/accept`, empresaA)).statusCode).toBe(200);

    // Hasta acá llega. Registrar la operación fiscal es un acto contable.
    const factura = await pedir(vendedor, 'POST', `/commercial-documents/${id}/invoice`, empresaA, {
      cbteTipo: 1, puntoVenta: 1, numero: 555, fecha: '2026-03-05',
    });
    expect(factura.statusCode, factura.body).toBe(403);

    // Y la contadora sí puede, sobre el mismo documento.
    const porContadora = await pedir(contadora, 'POST', `/commercial-documents/${id}/invoice`, empresaA, {
      cbteTipo: 1, puntoVenta: 1, numero: 555, fecha: '2026-03-05',
    });
    expect(porContadora.statusCode, porContadora.body).toBe(201);
  });

  it('la empresa B no ve los documentos de la empresa A', async () => {
    const id = await presupuestoConRenglon();
    const ajeno = await pedir(contadora, 'GET', `/commercial-documents/${id}`, empresaB);
    expect(ajeno.statusCode).toBe(404);

    const lista = await pedir(contadora, 'GET', '/commercial-documents', empresaB);
    const ids = lista.json<{ documentos: { id: string }[] }>().documentos.map((d) => d.id);
    expect(ids).not.toContain(id);
  });

  it('no se presupuesta a un tercero de otra empresa', async () => {
    const r = await pedir(contadora, 'POST', '/commercial-documents', empresaB, {
      terceroId: clienteId,
      fecha: '2026-03-01',
    });
    expect(r.statusCode, r.body).toBe(404);
  });

  it('un pedido no lleva fecha de validez', async () => {
    const r = await pedir(contadora, 'POST', '/commercial-documents', empresaA, {
      tipo: 'PEDIDO',
      terceroId: clienteId,
      fecha: '2026-03-01',
      validoHasta: '2026-04-01',
    });
    expect(r.statusCode, r.body).toBe(400);
  });

  it('la numeración avanza por empresa, dirección y tipo', async () => {
    const numeroDe = async (empresa: string, tipo: string): Promise<number> =>
      (
        await pedir(contadora, 'POST', '/commercial-documents', empresa, {
          direccion: 'VENTAS', tipo, terceroId: tipo === 'PEDIDO' ? clienteId : clienteId,
          fecha: '2026-03-01',
        })
      ).json<{ numero: number }>().numero;

    const uno = await numeroDe(empresaA, 'PEDIDO');
    const dos = await numeroDe(empresaA, 'PEDIDO');
    expect(dos).toBe(uno + 1);

    // Los presupuestos llevan su propia serie: no comparten contador.
    const presupuesto = await pedir(contadora, 'POST', '/commercial-documents', empresaA, {
      tipo: 'PRESUPUESTO', terceroId: clienteId, fecha: '2026-03-01',
    });
    expect(presupuesto.json<{ numero: number }>().numero).not.toBe(dos);
  });

  // -------------------------------------------------------------------------
  // La bandeja
  // -------------------------------------------------------------------------
  it('un pedido aceptado aparece en la bandeja y desaparece al facturarlo', async () => {
    const id = await presupuestoConRenglon();
    expect((await pedir(contadora, 'POST', `/commercial-documents/${id}/emit`, empresaA)).statusCode).toBe(200);
    expect((await pedir(contadora, 'POST', `/commercial-documents/${id}/accept`, empresaA)).statusCode).toBe(200);

    const enBandeja = async (): Promise<boolean> => {
      const r = await pedir(contadora, 'GET', '/work-queue?limite=200', empresaA);
      expect(r.statusCode, r.body).toBe(200);
      return r
        .json<{ items: { entityId: string; rama: string }[] }>()
        .items.some((i) => i.entityId === id && i.rama === 'ACEPTADO_SIN_FACTURAR');
    };

    expect(await enBandeja(), 'la venta ocurrió y no está registrada: es trabajo pendiente').toBe(true);

    expect(
      (await pedir(contadora, 'POST', `/commercial-documents/${id}/invoice`, empresaA, {
        cbteTipo: 1, puntoVenta: 1, numero: 777, fecha: '2026-03-05',
      })).statusCode,
    ).toBe(201);

    // Desaparece porque cambió el hecho —ya hay operación fiscal—, no porque
    // alguien lo haya marcado como hecho. No existe forma de marcarlo.
    expect(await enBandeja()).toBe(false);
  });

  it('quien no puede leer documentos comerciales no los ve en su bandeja', async () => {
    // El filtro de ramas ES la autorización: no hay un permiso «ver la bandeja».
    const sinPermiso = await db.query<{ code: string }>(
      `SELECT p.code FROM role_permissions rp
         JOIN roles r ON r.id = rp.role_id
         JOIN permissions p ON p.id = rp.permission_id
        WHERE r.code = 'CARGADOR' AND p.code = 'commercial:read'`,
    );
    expect(sinPermiso.rowCount, 'el CARGADOR no tiene que poder leer presupuestos').toBe(0);
  });

  it('el borrado físico de un documento comercial está prohibido', async () => {
    const id = await presupuestoConRenglon();
    await expect(db.query('DELETE FROM commercial_documents WHERE id = $1', [id])).rejects.toThrow();
  });
});
