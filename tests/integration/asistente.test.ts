/**
 * El asistente conversacional, de punta a punta (con un proveedor guionado: no hay credencial ni se gasta plata).
 *
 * Lo que se prueba es lo que el sistema PROMETE alrededor del modelo, no lo que el modelo diga:
 *
 *   · apagado por defecto y encendido por una persona con permiso, con motivo y bitácora;
 *   · quién puede usarlo, y que una conversación es de quien la abrió;
 *   · que una cifra que ninguna herramienta devolvió NO llega a la pantalla (tras una corrección);
 *   · que armar una propuesta de alta no guarda nada;
 *   · que el fallo del proveedor es un estado y no un 500;
 *   · que un archivo adjunto viaja al modelo, no se guarda y se marca como lectura sin verificar;
 *   · que cada turno queda contado (cupo), auditado (sin contenido) y con su costo.
 */

import {
  ASISTENTE_V1,
  ErrorDeProveedor,
  type PedidoDeChat,
} from '@aai/ai-engine';
import { closePool, initPool } from '@aai/db';
import { buildServer } from '@aai/api/server';
import { totp, withCheckDigit } from '@aai/shared';
import type { FastifyInstance } from 'fastify';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { ProveedorDeChatGuionado, dicho, pidiendo } from './helpers/chat-guionado.js';
import { connect, hasDatabase, type Client } from './helpers/db.js';
import { sufijoUnico } from './helpers/identificadores.js';

// El tope técnico por minuto (12 por defecto) lo alcanzaría esta misma suite; acá se prueba el cupo diario, no el bucle.
vi.hoisted(() => {
  process.env['ASSISTANT_MENSAJES_POR_MINUTO'] = '1000';
});

const PASSWORD = 'una-contrasena-suficientemente-larga';
const suite = hasDatabase ? describe : describe.skip;

/** Como `dicho`, pero con el modelo real: el precio declarado en la 0136 es el de `claude-haiku-5-5`. */
const haiku = (texto: string, uso: { entrada: number; salida: number } = { entrada: 10, salida: 5 }) => ({
  ...dicho(texto, uso),
  modeloId: 'claude-haiku-5-5',
});

/** Un PNG de 1×1, válido. */
const PNG = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==',
  'base64',
);

interface RespuestaDeMensaje {
  conversacionId: string;
  estado: string;
  respuesta: {
    texto: string;
    advertencia: string | null;
    lecturaDeArchivoSinVerificar: boolean;
    consultas: { nombre: string; error: boolean }[];
    propuestas: { tipo: string; ruta: string; metodo: string; datos: Record<string, unknown> }[];
  };
  uso: { entrada: number; salida: number; costoMicros: number | null } | null;
  motivoDelFallo?: string;
}

suite('Asistente conversacional', () => {
  let app: FastifyInstance;
  let db: Client;
  let guion: ProveedorDeChatGuionado;
  let stamp = '';
  let empresa = '';
  let tokenContadora = '';
  let tokenOtraContadora = '';
  let tokenLector = '';
  /** AUDITOR: puede preguntar (`intelligence:ask`) y NO puede dar de alta terceros (`party:write`). */
  let tokenAuditor = '';
  let preguntaId = '';

  /** El proveedor que usa el servidor: cada prueba lo reemplaza con su guion. */
  let proveedorActual: ProveedorDeChatGuionado;
  const proveedorProxy = {
    id: 'anthropic',
    conversar: (p: PedidoDeChat) => proveedorActual.conversar(p),
  };
  const con = (...pasos: ConstructorParameters<typeof ProveedorDeChatGuionado>[0]): ProveedorDeChatGuionado => {
    guion = new ProveedorDeChatGuionado(pasos);
    proveedorActual = guion;
    return guion;
  };

  const pedir = (metodo: 'GET' | 'POST', url: string, token: string, cuerpo?: unknown) =>
    app.inject({
      method: metodo,
      url,
      headers: { authorization: `Bearer ${token}`, 'x-company-id': empresa },
      ...(cuerpo === undefined ? {} : { payload: cuerpo }),
    });

  const escribir = async (token: string, mensaje: string, conversacionId?: string) => {
    const r = await pedir('POST', '/asistente/mensajes', token, { mensaje, ...(conversacionId ? { conversacionId } : {}) });
    return { r, v: r.statusCode === 200 ? r.json<RespuestaDeMensaje>() : null };
  };

  const multipart = (campos: Record<string, string>, archivos: { nombre: string; tipo: string; datos: Buffer }[]) => {
    const limite = `----nexo${Date.now()}`;
    const partes: Buffer[] = [];
    for (const [k, v] of Object.entries(campos)) {
      partes.push(Buffer.from(`--${limite}\r\nContent-Disposition: form-data; name="${k}"\r\n\r\n${v}\r\n`));
    }
    for (const a of archivos) {
      partes.push(Buffer.from(`--${limite}\r\nContent-Disposition: form-data; name="adjunto"; filename="${a.nombre}"\r\nContent-Type: ${a.tipo}\r\n\r\n`));
      partes.push(a.datos, Buffer.from('\r\n'));
    }
    partes.push(Buffer.from(`--${limite}--\r\n`));
    return { payload: Buffer.concat(partes), 'content-type': `multipart/form-data; boundary=${limite}` };
  };

  beforeAll(async () => {
    initPool(process.env.DATABASE_URL!);
    proveedorActual = new ProveedorDeChatGuionado([dicho('inicial')]);
    app = await buildServer({ asistente: { proveedor: proveedorProxy } });
    await app.ready();
    db = await connect();
    stamp = await sufijoUnico(db);
    // El prompt lo archiva la migración 0136 (el despliegue no corre `prompts:register`). Si el texto del código cambió y la
    // migración no, esto falla acá y no en producción como «el cupo no cuenta».
    const archivado = await db.query<{ texto: string }>('SELECT texto FROM prompt_versions WHERE hash = $1', [ASISTENTE_V1.hash]);
    expect(archivado.rows, 'La 0136 tiene que archivar EXACTAMENTE el texto de ASISTENTE_V1').toHaveLength(1);
    expect(archivado.rows[0]!.texto).toBe(ASISTENTE_V1.texto);

    const { hash: argonHash } = await import('@node-rs/argon2');
    const clave = await argonHash(PASSWORD, { algorithm: 2, memoryCost: 19_456, timeCost: 2, parallelism: 1 });

    const fundadorId = (
      await db.query<{ id: string }>('INSERT INTO users (email, full_name, password_hash) VALUES ($1,$2,$3) RETURNING id', [
        `fundador-as-${stamp}@estudio.test`, 'Fundador', clave,
      ])
    ).rows[0]!.id;
    const organizationId = (
      await db.query<{ create_organization: string }>('SELECT create_organization($1,$2,$3)', [
        `Estudio as ${stamp}`, withCheckDigit(`30${stamp}`), fundadorId,
      ])
    ).rows[0]!.create_organization;
    empresa = (
      await db.query<{ create_company: string }>('SELECT create_company($1,$2,$3,$4,$5,$6,$7,$8)', [
        fundadorId, organizationId, `Empresa as ${stamp}`, withCheckDigit(`27${stamp}`), 'SA', 'AR-C', 'IGJ', '12-31',
      ])
    ).rows[0]!.create_company;

    const tokenFundador = (
      await app.inject({ method: 'POST', url: '/auth/login', payload: { email: `fundador-as-${stamp}@estudio.test`, password: PASSWORD } })
    ).json<{ token: string }>().token;

    const alta = async (correo: string, roles: string[]): Promise<string> => {
      const userId = (
        await app.inject({
          method: 'POST', url: `/organizations/${organizationId}/users`,
          headers: { authorization: `Bearer ${tokenFundador}` },
          payload: { email: correo, fullName: correo, password: PASSWORD, level: 'MEMBER' },
        })
      ).json<{ id: string }>().id;
      for (const role of roles) {
        await app.inject({
          method: 'POST', url: `/companies/${empresa}/roles`,
          headers: { authorization: `Bearer ${tokenFundador}` }, payload: { userId, role },
        });
      }
      const inicial = (await app.inject({ method: 'POST', url: '/auth/login', payload: { email: correo, password: PASSWORD } })).json<{ token: string }>().token;
      if (!roles.some((r) => ['CONTADOR', 'ADMINISTRADOR', 'AUDITOR'].includes(r))) return inicial;

      const secret = (await app.inject({ method: 'POST', url: '/auth/mfa/setup', headers: { authorization: `Bearer ${inicial}` } })).json<{ secret: string }>().secret;
      await app.inject({ method: 'POST', url: '/auth/mfa/confirm', payload: { code: totp(secret, Date.now()) }, headers: { authorization: `Bearer ${inicial}` } });
      const token = (await app.inject({ method: 'POST', url: '/auth/login', payload: { email: correo, password: PASSWORD } })).json<{ token: string }>().token;
      await app.inject({ method: 'POST', url: '/auth/mfa/verify', payload: { code: totp(secret, Date.now()) }, headers: { authorization: `Bearer ${token}` } });
      return token;
    };

    tokenContadora = await alta(`contadora-as-${stamp}@estudio.test`, ['CONTADOR']);
    tokenOtraContadora = await alta(`otra-as-${stamp}@estudio.test`, ['CONTADOR']);
    tokenLector = await alta(`lector-as-${stamp}@estudio.test`, ['SOLO_LECTURA']);
    tokenAuditor = await alta(`auditor-as-${stamp}@estudio.test`, ['AUDITOR']);

    const lista = await pedir('GET', '/intelligence/preguntas', tokenContadora);
    preguntaId = lista.json<{ preguntas: { id: string }[] }>().preguntas[0]!.id;
  }, 240_000);

  afterAll(async () => {
    await db?.end();
    await app?.close();
    await closePool();
  });

  describe('apagado por defecto', () => {
    it('sin encenderlo, escribir devuelve ASISTENTE_APAGADO y NO llama al modelo', async () => {
      const g = con(dicho('no debería llegar'));
      const { r } = await escribir(tokenContadora, 'hola');
      expect(r.statusCode, r.body).toBe(409);
      expect(r.json<{ error: string }>().error).toBe('ASISTENTE_APAGADO');
      expect(g.pedidos).toHaveLength(0);
    });

    it('el estado dice que está apagado y qué herramientas tendría esta persona', async () => {
      const r = await pedir('GET', '/asistente/estado', tokenContadora);
      expect(r.statusCode, r.body).toBe(200);
      const v = r.json<{ habilitado: boolean; disponible: boolean; herramientas: string[]; puedeConfigurar: boolean; advertencia: string }>();
      expect(v.habilitado).toBe(false);
      expect(v.disponible).toBe(false);
      expect(v.puedeConfigurar).toBe(true);
      expect(v.herramientas).toEqual(expect.arrayContaining(['preguntar_al_sistema', 'ayuda_de_nexo']));
      expect(v.advertencia.length).toBeGreaterThan(20);
    });
  });

  describe('quién puede', () => {
    it('un usuario de solo lectura no puede usar el asistente ni configurarlo', async () => {
      expect((await pedir('GET', '/asistente/estado', tokenLector)).statusCode).toBe(403);
      expect((await pedir('POST', '/asistente/mensajes', tokenLector, { mensaje: 'hola' })).statusCode).toBe(403);
      expect((await pedir('POST', '/asistente/configuracion', tokenLector, { habilitado: true, motivo: 'quiero probarlo' })).statusCode).toBe(403);
    });

    it('encenderlo exige un motivo, y queda en la bitácora', async () => {
      const sinMotivo = await pedir('POST', '/asistente/configuracion', tokenContadora, { habilitado: true, motivo: 'no' });
      expect(sinMotivo.statusCode).toBe(400);

      const r = await pedir('POST', '/asistente/configuracion', tokenContadora, {
        habilitado: true,
        motivo: 'Probar el asistente con el equipo contable',
      });
      expect(r.statusCode, r.body).toBe(200);

      const bit = await db.query(
        `SELECT motivo FROM audit_logs WHERE company_id = $1 AND action = 'CONFIGURAR_ASISTENTE'`,
        [empresa],
      );
      expect(bit.rows).toHaveLength(1);
      expect(bit.rows[0].motivo).toContain('Probar el asistente');
    });
  });

  describe('un turno', () => {
    it('contesta, guarda la conversación, cuenta el consumo y audita SIN el contenido', async () => {
      const g = con(haiku('Hola, soy el asistente de NEXO. ¿En qué te ayudo?', { entrada: 1000, salida: 200 }));
      const { r, v } = await escribir(tokenContadora, 'Hola, ¿qué podés hacer?');
      expect(r.statusCode, r.body).toBe(200);
      expect(v!.estado).toBe('RESPONDIDA');
      expect(v!.respuesta.texto).toContain('asistente de NEXO');
      // §42: toda respuesta lleva la advertencia.
      expect(v!.respuesta.advertencia).toContain('asistente');
      // El precio de Haiku 5.5 está declarado para el proveedor `anthropic`: 1000×100/1000 + 200×500/1000 = 200 micros.
      expect(v!.uso).toMatchObject({ entrada: 1000, salida: 200 });
      expect(v!.uso!.costoMicros).toBe(200);

      // El system lleva el prompt versionado + el contexto (fecha, herramientas); nunca datos de la empresa.
      expect(g.pedidos[0]!.system).toContain('Sos el asistente de NEXO');
      expect(g.pedidos[0]!.system).toMatch(/Hoy es \d{4}-\d{2}-\d{2}/u);

      const msgs = await db.query(
        `SELECT rol, estado, texto, costo_micros FROM assistant_messages WHERE conversation_id = $1 ORDER BY created_at, id`,
        [v!.conversacionId],
      );
      expect(msgs.rows.map((m: { rol: string }) => m.rol)).toEqual(['usuario', 'asistente']);
      expect(msgs.rows[1].estado).toBe('RESPONDIDA');
      expect(Number(msgs.rows[1].costo_micros)).toBe(200);

      const resp = await db.query(
        `SELECT aceptada, model_provider, cifras_inventadas FROM ai_answers WHERE company_id = $1 AND contexto->>'conversacionId' = $2`,
        [empresa, v!.conversacionId],
      );
      expect(resp.rows).toEqual([{ aceptada: true, model_provider: 'anthropic', cifras_inventadas: 0 }]);

      const bit = await db.query(
        `SELECT new_value FROM audit_logs WHERE company_id = $1 AND action = 'CONSULTAR_ASISTENTE' AND object_id = $2`,
        [empresa, v!.conversacionId],
      );
      expect(bit.rows).toHaveLength(1);
      expect(JSON.stringify(bit.rows[0])).not.toContain('qué podés hacer');
      expect(JSON.stringify(bit.rows[0])).not.toContain('Hola, soy el asistente');
    });

    it('la conversación sigue: el segundo mensaje lleva lo anterior como historial', async () => {
      const g = con(dicho('Primera respuesta.'), dicho('Segunda respuesta.'));
      const a = (await escribir(tokenContadora, 'primer mensaje'))!.v!;
      const b = (await escribir(tokenContadora, 'segundo mensaje', a.conversacionId)).v!;
      expect(b.conversacionId).toBe(a.conversacionId);

      const textos = g.pedidos[1]!.mensajes.map((m) =>
        m.bloques.map((x) => (x.tipo === 'texto' ? x.texto : `[${x.tipo}]`)).join(''),
      );
      expect(textos).toEqual(['primer mensaje', 'Primera respuesta.', 'segundo mensaje']);
    });

    it('una cifra de la herramienta se puede decir; una cifra inventada NO llega a la pantalla', async () => {
      // 1) El modelo consulta y habla de lo que la herramienta devolvió: pasa.
      const g = con(
        pidiendo('preguntar_al_sistema', { preguntaId }),
        (pedido) => {
          const resultado = pedido.mensajes.at(-1)!.bloques.find((b) => b.tipo === 'resultado');
          if (resultado?.tipo !== 'resultado') throw new Error('el resultado de la herramienta no volvió al modelo');
          const valor = (JSON.parse(resultado.contenido) as { valor: string | null }).valor;
          return dicho(valor === null ? 'El sistema no puede afirmarlo.' : `El resultado es ${valor}.`);
        },
      );
      const ok = (await escribir(tokenContadora, '¿cómo estamos?')).v!;
      expect(ok.estado).toBe('RESPONDIDA');
      expect(ok.respuesta.consultas).toEqual([{ nombre: 'preguntar_al_sistema', error: false }]);
      expect(g.pedidos).toHaveLength(2);

      // 2) El modelo inventa una cifra de siete dígitos: una corrección y, si insiste, se rechaza ENTERA.
      const g2 = con(dicho('Vendiste 987.654.321 este mes.'), dicho('Perdón: vendiste 987.654.321 este mes.'));
      const mal = (await escribir(tokenContadora, '¿cuánto vendí?')).v!;
      expect(mal.estado).toBe('RECHAZADA');
      expect(JSON.stringify(mal)).not.toContain('987.654.321');
      expect(mal.respuesta.advertencia).toBeNull();
      expect(g2.pedidos).toHaveLength(2); // el original + UNA corrección

      // Lo inventado queda para la métrica, no para la pantalla.
      const r = await db.query(
        `SELECT aceptada, cifras_inventadas, respuesta FROM ai_answers WHERE company_id = $1 AND contexto->>'conversacionId' = $2`,
        [empresa, mal.conversacionId],
      );
      expect(r.rows[0]).toMatchObject({ aceptada: false, cifras_inventadas: 1, respuesta: null });
      const m = await db.query(`SELECT texto, estado FROM assistant_messages WHERE conversation_id = $1 AND rol = 'asistente'`, [mal.conversacionId]);
      expect(m.rows[0].estado).toBe('RECHAZADA');
      expect(m.rows[0].texto).not.toContain('987.654.321');
    });

    it('una cifra que escribió la persona sí se puede repetir', async () => {
      con(dicho('Entendido: el importe de 456.789 que mencionás.'));
      const v = (await escribir(tokenContadora, 'Tengo una factura por 456.789 pesos')).v!;
      expect(v.estado).toBe('RESPONDIDA');
    });

    it('el fallo del proveedor es un estado, no un 500; el mensaje de la persona queda guardado', async () => {
      con(() => {
        throw new ErrorDeProveedor('TIMEOUT', 'el proveedor no contestó a tiempo', 1);
      });
      const { r, v } = await escribir(tokenContadora, 'hola, ¿estás?');
      expect(r.statusCode, r.body).toBe(200);
      expect(v!.estado).toBe('FALLO_DEL_PROVEEDOR');
      expect(v!.motivoDelFallo).toBe('TIMEOUT');
      expect(v!.respuesta.texto).toContain('no está disponible');
      const m = await db.query(`SELECT rol, texto FROM assistant_messages WHERE conversation_id = $1 ORDER BY created_at, id`, [v!.conversacionId]);
      expect(m.rows[0]).toMatchObject({ rol: 'usuario', texto: 'hola, ¿estás?' });
    });
  });

  describe('lo que no hace: escribir', () => {
    // CUIT válido: prefijo 20 + 8 dígitos + verificador.
    const cuit = withCheckDigit('2012345678');

    it('armar una propuesta de alta NO crea el tercero, y la propuesta es el cuerpo exacto de POST /parties', async () => {
      con(
        pidiendo('proponer_alta_de_tercero', { razonSocial: 'Ferretería del Centro', tipoDocumento: 'CUIT', numeroDocumento: cuit, roles: ['PROVEEDOR'] }),
        dicho('Armé la propuesta. Revisala y confirmala: todavía no se guardó nada.'),
      );
      const v = (await escribir(tokenContadora, `Cargá a Ferretería del Centro, CUIT ${cuit}, proveedor`)).v!;
      expect(v.estado).toBe('RESPONDIDA');
      expect(v.respuesta.propuestas).toHaveLength(1);
      expect(v.respuesta.propuestas[0]).toMatchObject({ tipo: 'ALTA_DE_TERCERO', ruta: '/parties', metodo: 'POST' });
      expect(v.respuesta.propuestas[0]!.datos).toMatchObject({ razonSocial: 'Ferretería del Centro', numeroDocumento: cuit, roles: ['PROVEEDOR'] });

      const creado = await db.query(`SELECT 1 FROM parties WHERE company_id = $1 AND numero_documento = $2`, [empresa, cuit]);
      expect(creado.rows).toHaveLength(0);

      // Y el cuerpo propuesto es aceptado tal cual por el alta de siempre.
      const alta = await pedir('POST', '/parties', tokenContadora, v.respuesta.propuestas[0]!.datos);
      expect(alta.statusCode, alta.body).toBe(201);
    });

    it('si el tercero ya existe, no hay propuesta', async () => {
      con(
        pidiendo('proponer_alta_de_tercero', { razonSocial: 'Ferretería del Centro SRL', tipoDocumento: 'CUIT', numeroDocumento: cuit, roles: ['PROVEEDOR'] }),
        dicho('Ese proveedor ya está cargado.'),
      );
      const v = (await escribir(tokenContadora, 'cargalo de nuevo')).v!;
      expect(v.respuesta.propuestas).toHaveLength(0);
    });

    it('un CUIT con dígito verificador incorrecto es un error de la herramienta que el modelo lee, y no hay propuesta', async () => {
      const g = con(
        pidiendo('proponer_alta_de_tercero', { razonSocial: 'X', tipoDocumento: 'CUIT', numeroDocumento: '20123456780', roles: ['CLIENTE'] }),
        dicho('El CUIT no pasa la verificación. ¿Podés revisarlo?'),
      );
      const v = (await escribir(tokenContadora, 'cargá un cliente con ese CUIT')).v!;
      expect(v.respuesta.propuestas).toHaveLength(0);
      expect(v.respuesta.consultas[0]).toEqual({ nombre: 'proponer_alta_de_tercero', error: true });
      const r = g.pedidos[1]!.mensajes.at(-1)!.bloques[0]!;
      expect(r.tipo === 'resultado' && r.esError).toBe(true);
    });

    it('buscar_terceros encuentra lo cargado, y el modelo no recibe herramientas que la persona no tiene', async () => {
      const g = con(pidiendo('buscar_terceros', { texto: 'Ferretería' }), dicho('Encontré un proveedor.'));
      const v = (await escribir(tokenContadora, '¿tengo cargada a Ferretería?')).v!;
      expect(v.respuesta.consultas).toEqual([{ nombre: 'buscar_terceros', error: false }]);
      const res = g.pedidos[1]!.mensajes.at(-1)!.bloques[0]!;
      expect(res.tipo === 'resultado' && res.contenido).toContain('Ferretería del Centro');
      // Una herramienta que el modelo inventa no se ejecuta.
      con(pidiendo('borrar_todo', {}), dicho('No pude.'));
      const w = (await escribir(tokenContadora, 'borrá todo')).v!;
      expect(w.respuesta.consultas).toEqual([{ nombre: 'borrar_todo', error: true }]);
    });
  });

  describe('con los permisos de quien escribe', () => {
    it('quien no puede dar de alta terceros no recibe la herramienta que arma el alta, y el modelo no puede usarla igual', async () => {
      const estado = (await pedir('GET', '/asistente/estado', tokenAuditor)).json<{ herramientas: string[] }>();
      expect(estado.herramientas).not.toContain('proponer_alta_de_tercero');
      expect(estado.herramientas).toContain('ayuda_de_nexo');

      const g = con(
        pidiendo('proponer_alta_de_tercero', { razonSocial: 'Intruso SA', tipoDocumento: 'SIN_IDENTIFICAR', roles: ['CLIENTE'] }),
        dicho('No pude armarla.'),
      );
      const v = (await escribir(tokenAuditor, 'cargá un cliente')).v!;
      expect(v.respuesta.propuestas).toHaveLength(0);
      expect(v.respuesta.consultas).toEqual([{ nombre: 'proponer_alta_de_tercero', error: true }]);
      // Y el modelo ni siquiera la vio en su lista.
      expect(g.pedidos[0]!.herramientas.map((h) => h.nombre)).not.toContain('proponer_alta_de_tercero');
    });
  });

  describe('conversaciones', () => {
    it('cada una es de quien la abrió: otra contadora de la misma empresa recibe 404', async () => {
      con(dicho('Hola.'));
      const v = (await escribir(tokenContadora, 'una conversación mía')).v!;

      const mia = await pedir('GET', `/asistente/conversaciones/${v.conversacionId}`, tokenContadora);
      expect(mia.statusCode, mia.body).toBe(200);
      expect(mia.json<{ mensajes: unknown[] }>().mensajes).toHaveLength(2);

      expect((await pedir('GET', `/asistente/conversaciones/${v.conversacionId}`, tokenOtraContadora)).statusCode).toBe(404);
      const ajena = await pedir('POST', '/asistente/mensajes', tokenOtraContadora, { mensaje: 'me meto', conversacionId: v.conversacionId });
      expect(ajena.statusCode).toBe(404);

      const lista = await pedir('GET', '/asistente/conversaciones', tokenOtraContadora);
      expect(JSON.stringify(lista.json())).not.toContain('una conversación mía');
    });

    it('al leerla, un turno rechazado muestra la explicación y no el texto del modelo', async () => {
      con(dicho('Facturaste 111.222.333.'), dicho('Facturaste 111.222.333.'));
      const v = (await escribir(tokenContadora, '¿cuánto facturé?')).v!;
      const c = await pedir('GET', `/asistente/conversaciones/${v.conversacionId}`, tokenContadora);
      expect(c.body).not.toContain('111.222.333');
    });
  });

  describe('archivos adjuntos', () => {
    it('una foto viaja al modelo, no se guarda, y la respuesta sale marcada como lectura sin verificar', async () => {
      const g = con(dicho('Leí en la imagen un comprobante con el número 123456. Confirmalo contra el original.'));
      const m = multipart({ mensaje: '¿Qué dice esta foto?' }, [{ nombre: 'foto.png', tipo: 'image/png', datos: PNG }]);
      const r = await app.inject({
        method: 'POST', url: '/asistente/mensajes',
        headers: { authorization: `Bearer ${tokenContadora}`, 'x-company-id': empresa, 'content-type': m['content-type'] },
        payload: m.payload,
      });
      expect(r.statusCode, r.body).toBe(200);
      const v = r.json<RespuestaDeMensaje>();
      // El número 123456 NO salió de ninguna herramienta: con un adjunto el control se relaja y se avisa.
      expect(v.estado).toBe('RESPONDIDA');
      expect(v.respuesta.lecturaDeArchivoSinVerificar).toBe(true);

      const enviado = g.pedidos[0]!.mensajes.at(-1)!.bloques;
      expect(enviado[0]).toMatchObject({ tipo: 'adjunto', clase: 'imagen', mediaType: 'image/png' });
      expect(enviado[0]!.tipo === 'adjunto' && enviado[0]!.base64).toBe(PNG.toString('base64'));

      const guardado = await db.query(`SELECT adjuntos FROM assistant_messages WHERE conversation_id = $1 AND rol = 'usuario'`, [v.conversacionId]);
      expect(guardado.rows[0].adjuntos).toEqual([
        expect.objectContaining({ nombre: 'foto.png', tipo: 'image/png', bytes: PNG.length, sha256: expect.stringMatching(/^[0-9a-f]{64}$/u) }),
      ]);
      expect(JSON.stringify(guardado.rows[0])).not.toContain(PNG.toString('base64'));
    });

    it('se mira el contenido, no lo que el navegador dice: un texto con nombre .png se rechaza', async () => {
      con(dicho('no debería llegar'));
      const m = multipart({ mensaje: 'mirá' }, [{ nombre: 'fake.png', tipo: 'image/png', datos: Buffer.from('esto no es una imagen') }]);
      const r = await app.inject({
        method: 'POST', url: '/asistente/mensajes',
        headers: { authorization: `Bearer ${tokenContadora}`, 'x-company-id': empresa, 'content-type': m['content-type'] },
        payload: m.payload,
      });
      expect(r.statusCode, r.body).toBe(400);
      expect(guion.pedidos).toHaveLength(0);
    });
  });

  describe('el cupo', () => {
    it('al llegar al tope declarado por la empresa, el asistente corta ANTES de llamar al modelo', async () => {
      const estado = (await pedir('GET', '/asistente/estado', tokenContadora)).json<{ cupo: { usadasHoy: number } }>();
      const decl = await pedir('POST', '/intelligence/quota', tokenContadora, {
        llamadasPorDia: estado.cupo.usadasHoy,
        motivo: 'Tope de la prueba del asistente',
      });
      expect(decl.statusCode, decl.body).toBe(201);

      const g = con(dicho('no debería llegar'));
      const { r } = await escribir(tokenContadora, 'una más');
      expect(r.statusCode, r.body).toBe(429);
      expect(r.json<{ message: string }>().message).toContain('CUPO_DIARIO_AGOTADO');
      expect(g.pedidos).toHaveLength(0);
    });

    it('el cupo de TOKENS por día: el turno que cruza se completa, el siguiente se corta ANTES de llamar al modelo', async () => {
      type Estado = { cupo: { tokensUsadosHoy: number; topeTokensPorDia: number | null; sinTopeDeTokensDeclarado: boolean } };
      const antes = (await pedir('GET', '/asistente/estado', tokenContadora)).json<Estado>();
      const base = antes.cupo.tokensUsadosHoy;

      // Cada declaración dice la política entera: sólo tokens, así que el tope de preguntas de la prueba anterior desaparece.
      const decl = await pedir('POST', '/intelligence/quota', tokenContadora, {
        tokensPorDia: base + 1000,
        motivo: 'Tope de tokens de la prueba del asistente',
      });
      expect(decl.statusCode, decl.body).toBe(201);
      expect(decl.json<{ llamadasPorDia: number | null; tokensPorDia: number }>()).toMatchObject({ llamadasPorDia: null, tokensPorDia: base + 1000 });

      // Primer turno: consume 1000 + 200 = 1200 y cruza el tope, pero se completa (los tokens se conocen después de llamar).
      const g1 = con(haiku('Primer turno', { entrada: 1000, salida: 200 }));
      const uno = await escribir(tokenContadora, 'Primera pregunta');
      expect(uno.r.statusCode, uno.r.body).toBe(200);
      expect(g1.pedidos).toHaveLength(1);

      const despues = (await pedir('GET', '/asistente/estado', tokenContadora)).json<Estado>();
      expect(despues.cupo).toMatchObject({ tokensUsadosHoy: base + 1200, topeTokensPorDia: base + 1000, sinTopeDeTokensDeclarado: false });

      // Segundo turno: el tope ya está superado, corta sin gastar.
      const g2 = con(dicho('no debería llegar'));
      const dos = await escribir(tokenContadora, 'Segunda pregunta');
      expect(dos.r.statusCode, dos.r.body).toBe(429);
      expect(dos.r.json<{ message: string }>().message).toContain('CUPO_DE_TOKENS_AGOTADO');
      expect(g2.pedidos).toHaveLength(0);

      // Subir el tope libera el asistente.
      const sube = await pedir('POST', '/intelligence/quota', tokenContadora, { tokensPorDia: base + 1_000_000, motivo: 'Se amplía el tope de la prueba' });
      expect(sube.statusCode, sube.body).toBe(201);
      const g3 = con(haiku('Tercer turno', { entrada: 10, salida: 5 }));
      const tres = await escribir(tokenContadora, 'Tercera pregunta');
      expect(tres.r.statusCode, tres.r.body).toBe(200);
      expect(g3.pedidos).toHaveLength(1);
    });

    it('sin tope propio rige el del PLAN, y el tope que declara la empresa gana', async () => {
      type Estado = { cupo: { tokensUsadosHoy: number; topeTokensPorDia: number | null; origenDelTopeDeTokens: string | null } };
      const base = (await pedir('GET', '/asistente/estado', tokenContadora)).json<Estado>().cupo.tokensUsadosHoy;

      // Un plan propio de la prueba: la tabla de planes es global y las suites corren en paralelo.
      const plan = (
        await db.query<{ id: string }>(
          `INSERT INTO subscription_plans (code, name, descripcion, orden) VALUES ($1, $2, 'Plan de la prueba del tope de IA', $3) RETURNING id`,
          [`T_IA_${stamp}`, `Plan IA ${stamp}`, 5000 + Math.floor(Math.random() * 90000)],
        )
      ).rows[0]!.id;
      try {
      await db.query(
        `INSERT INTO plan_features (plan_id, feature_code, declarado_por, motivo) VALUES ($1, 'asistente', 'test', 'La prueba necesita el asistente en su plan')`,
        [plan],
      );
      await db.query(
        `INSERT INTO company_subscriptions (company_id, plan_id, estado, vigencia_desde, created_by)
         VALUES ($1, $2, 'ACTIVA', CURRENT_DATE, 'test')`,
        [empresa, plan],
      );
      await db.query('DELETE FROM ai_quotas WHERE company_id = $1', [empresa]);
      await db.query(
        `INSERT INTO plan_ai_quotas (plan_id, tokens_por_dia, declarado_por, motivo) VALUES ($1, $2, 'test', 'Tope de la prueba del plan')`,
        [plan, base + 1000],
      );

      const e1 = (await pedir('GET', '/asistente/estado', tokenContadora)).json<Estado>().cupo;
      expect(e1).toMatchObject({ topeTokensPorDia: base + 1000, origenDelTopeDeTokens: 'PLAN' });

      // Primer turno: cruza el tope del plan y se completa. El segundo se corta antes de llamar al modelo.
      const g1 = con(haiku('Primero', { entrada: 1000, salida: 200 }));
      const uno = await escribir(tokenContadora, 'Primera pregunta');
      expect(uno.r.statusCode, uno.r.body).toBe(200);
      expect(g1.pedidos).toHaveLength(1);

      const g2 = con(dicho('no debería llegar'));
      const dos = await escribir(tokenContadora, 'Segunda pregunta');
      expect(dos.r.statusCode, dos.r.body).toBe(429);
      expect(dos.r.json<{ message: string }>().message).toContain('CUPO_DE_TOKENS_AGOTADO');
      expect(g2.pedidos).toHaveLength(0);

      // La empresa declara uno propio más alto: gana sobre el del plan.
      const decl = await pedir('POST', '/intelligence/quota', tokenContadora, { tokensPorDia: base + 1_000_000, motivo: 'La empresa amplía su tope' });
      expect(decl.statusCode, decl.body).toBe(201);
      const e2 = (await pedir('GET', '/asistente/estado', tokenContadora)).json<Estado>().cupo;
      expect(e2).toMatchObject({ topeTokensPorDia: base + 1_000_000, origenDelTopeDeTokens: 'EMPRESA' });
      const g3 = con(haiku('Tercero', { entrada: 10, salida: 5 }));
      const tres = await escribir(tokenContadora, 'Tercera pregunta');
      expect(tres.r.statusCode, tres.r.body).toBe(200);
      expect(g3.pedidos).toHaveLength(1);
      } finally {
        // Un plan de prueba no puede quedar a la venta (S-31).
        await db.query(`UPDATE subscription_plans SET status = 'DISCONTINUADO' WHERE id = $1`, [plan]);
      }
    });

    it('declarar un cupo sin ningún tope es un 400', async () => {
      const r = await pedir('POST', '/intelligence/quota', tokenContadora, { motivo: 'Sin tope alguno, esto no vale' });
      expect(r.statusCode, r.body).toBe(400);
    });
  });
});
