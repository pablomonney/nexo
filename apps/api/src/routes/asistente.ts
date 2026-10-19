/**
 * El asistente conversacional: un chat con Claude que consulta, orienta y ayuda a cargar datos.
 *
 * Lo que dice el diseño (`docs/ASISTENTE.md`) y lo que este archivo hace cumplir:
 *
 *   · **Apagado por defecto, por empresa.** Aunque el servidor tenga proveedor, una empresa lo enciende recién cuando alguien
 *     con `analysis:configure` lo declara con un motivo (`assistant_settings`). Sin fila, apagado.
 *   · **No escribe.** Las herramientas leen o arman una *propuesta*; guardar es otro pedido (`POST /parties`) que hace la
 *     persona con un botón, con su permiso y su bitácora (ADR-001).
 *   · **No calcula.** Toda cifra tiene que salir de una herramienta o haberla escrito la persona; si no, el texto se rechaza
 *     entero tras UNA corrección (ADR-017, §41). Con un archivo adjunto el control se relaja —una lectura de una foto no se
 *     puede verificar contra el sistema— y la respuesta sale marcada para que la pantalla lo diga.
 *   · **Con permisos de la persona.** Las herramientas se arman con los permisos de quien escribe; las que no le tocan no
 *     existen para el modelo.
 *   · **Contado y auditado.** Cada turno entra en `ai_answers` (cupo diario por empresa, métrica de alucinación) y en la
 *     bitácora (`CONSULTAR_ASISTENTE`, sin el contenido). El costo se calcula con el precio declarado.
 *   · **El proveedor es reemplazable.** La ruta habla con el puerto `ProveedorDeChat`; el único archivo que conoce a Claude
 *     es `ai/chat-claude.ts`.
 *   · **Los archivos no se guardan.** Una foto o un PDF viaja al proveedor en el turno que lo trae; en la base queda su
 *     nombre, tipo, tamaño y huella.
 */

import { createHash } from 'node:crypto';
import {
  ADVERTENCIA_DEL_ASISTENTE,
  ASISTENTE_V1,
  ErrorDeProveedor,
  calcularCostoEnMicros,
  conducirTurno,
  revisarTextoDelAsistente,
  type MensajeDeChat,
  type ProveedorDeChat,
  type ResultadoDelTurno,
} from '@aai/ai-engine';
import { recordAudit, withCompany } from '@aai/db';
import type { FastifyInstance, FastifyRequest } from 'fastify';
import { z } from 'zod';
import { crearProveedorDeChat, estadoDelAsistente } from '../ai/asistente-proveedor.js';
import { evaluarCupo, leerCupo, precioVigente } from '../ai/cupo.js';
import { armarHerramientas } from '../asistente/herramientas.js';
import { config } from '../config.js';
import {
  clientIp,
  requireAuth,
  requireCompany,
  requirePermission,
} from '../http/context.js';
import { badRequest, conflictoTipado, notFound, tooManyRequests } from '../http/errors.js';
import { hoyDeLaBase } from '../intelligence/catalogo.js';

export interface OpcionesDelAsistente {
  /**
   * El proveedor de chat. Se inyecta **sólo en los tests** (no hay credencial, y una suite que hablara con la API real
   * gastaría plata en cada corrida). En producción sale de `config.asistente`. `null` = sin proveedor.
   */
  readonly proveedor?: ProveedorDeChat | null;
}

/** Lo que se acepta adjuntar. Una foto de celular entra por la compresión del navegador (ver la consola). */
export const ADJUNTOS = {
  maxArchivos: 3,
  maxBytes: 5 * 1024 * 1024,
  tipos: ['image/jpeg', 'image/png', 'image/webp', 'image/gif', 'application/pdf'],
} as const;

/** La firma de cada formato. Se mira el contenido, no lo que el navegador dice que es. */
function tipoReal(bytes: Buffer): (typeof ADJUNTOS.tipos)[number] | null {
  if (bytes.length >= 3 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) return 'image/jpeg';
  if (bytes.length >= 8 && bytes.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))) return 'image/png';
  if (bytes.length >= 6 && ['GIF87a', 'GIF89a'].includes(bytes.subarray(0, 6).toString('latin1'))) return 'image/gif';
  if (bytes.length >= 12 && bytes.subarray(0, 4).toString('latin1') === 'RIFF' && bytes.subarray(8, 12).toString('latin1') === 'WEBP') return 'image/webp';
  if (bytes.length >= 5 && bytes.subarray(0, 5).toString('latin1') === '%PDF-') return 'application/pdf';
  return null;
}

interface Adjunto {
  readonly nombre: string;
  readonly mediaType: (typeof ADJUNTOS.tipos)[number];
  readonly bytes: number;
  readonly sha256: string;
  readonly base64: string;
}

/** Lo que se le muestra a la persona cuando el turno no terminó en una respuesta. El texto del modelo NO se muestra. */
const EXPLICACION: Readonly<Record<string, string>> = {
  RECHAZADA:
    'No pude darte una respuesta confiable: lo que armé incluía cifras que no salen de los datos del sistema, así que ' +
    'prefiero no mostrarlo. Probá preguntarlo de otra forma o usá la pantalla Preguntar.',
  TRUNCADA: 'La respuesta se cortó por largo. Probá pedirme algo más acotado.',
  RECHAZO_DEL_PROVEEDOR: 'El proveedor del modelo no quiso contestar esto. Probá reformularlo.',
  SIN_CONCLUSION: 'No llegué a una respuesta con las consultas que pude hacer. Probá reformular o ser más específico.',
  FALLO_DEL_PROVEEDOR:
    'El asistente no está disponible en este momento. Tu mensaje quedó guardado; lo que consulta el sistema en las demás pantallas no se ve afectado.',
};

const CODIGOS_DE_FALLO: Readonly<Record<string, string>> = {
  TIMEOUT: 'tardó demasiado en contestar',
  LIMITE_DE_TASA: 'está recibiendo demasiados pedidos',
  PROVEEDOR_CAIDO: 'tuvo un problema',
  CREDENCIAL_RECHAZADA: 'rechazó la credencial configurada',
  PEDIDO_INVALIDO: 'rechazó el pedido',
  RESPUESTA_ILEGIBLE: 'devolvió algo ilegible',
  RED: 'no se pudo alcanzar',
};

const mensajeEntrante = z.object({
  mensaje: z.string().trim().max(4000),
  conversacionId: z.string().uuid().optional(),
});

interface Entrada {
  readonly mensaje: string;
  readonly conversacionId: string | undefined;
  readonly adjuntos: Adjunto[];
}

/** JSON (sólo texto) o multipart (texto + archivos). */
async function leerEntrada(request: FastifyRequest): Promise<Entrada> {
  if (!request.isMultipart()) {
    const b = mensajeEntrante.parse(request.body);
    if (b.mensaje === '') throw badRequest('Escribí un mensaje.');
    return { mensaje: b.mensaje, conversacionId: b.conversacionId, adjuntos: [] };
  }

  const campos: Record<string, string> = {};
  const adjuntos: Adjunto[] = [];
  for await (const parte of request.parts({
    limits: { fileSize: ADJUNTOS.maxBytes, files: ADJUNTOS.maxArchivos, fields: 6 },
  })) {
    if (parte.type === 'field') {
      if (typeof parte.value === 'string') campos[parte.fieldname] = parte.value;
      continue;
    }
    const bytes = await parte.toBuffer();
    if (parte.file.truncated) {
      throw badRequest(`Cada archivo puede pesar hasta ${String(ADJUNTOS.maxBytes / 1024 / 1024)} MB.`);
    }
    if (bytes.length === 0) continue;
    const real = tipoReal(bytes);
    if (real === null) throw badRequest(`"${parte.filename}" no es una imagen (JPG, PNG, WEBP, GIF) ni un PDF.`);
    adjuntos.push({
      nombre: parte.filename.slice(0, 200),
      mediaType: real,
      bytes: bytes.length,
      sha256: createHash('sha256').update(bytes).digest('hex'),
      base64: bytes.toString('base64'),
    });
  }

  const b = mensajeEntrante.parse({ mensaje: campos['mensaje'] ?? '', conversacionId: campos['conversacionId'] || undefined });
  if (b.mensaje === '' && adjuntos.length === 0) throw badRequest('Escribí un mensaje o adjuntá un archivo.');
  return { mensaje: b.mensaje, conversacionId: b.conversacionId, adjuntos };
}

/** Une los mensajes seguidos del mismo rol y descarta lo que no empieza con la persona: la API alterna roles. */
function normalizarHistorial(filas: readonly { rol: string; texto: string }[]): MensajeDeChat[] {
  const salida: { rol: 'usuario' | 'asistente'; texto: string }[] = [];
  for (const f of filas) {
    const rol = f.rol === 'usuario' ? 'usuario' : 'asistente';
    const ultimo = salida[salida.length - 1];
    if (ultimo !== undefined && ultimo.rol === rol) ultimo.texto += `\n\n${f.texto}`;
    else salida.push({ rol, texto: f.texto });
  }
  while (salida.length > 0 && salida[0]!.rol !== 'usuario') salida.shift();
  return salida.map((m) => ({ rol: m.rol, bloques: [{ tipo: 'texto' as const, texto: m.texto }] }));
}

const HISTORIAL_MAXIMO = 12;

export function asistenteRoutes(opciones: OpcionesDelAsistente = {}) {
  return async function asistente(app: FastifyInstance): Promise<void> {
    const proveedor = opciones.proveedor !== undefined ? opciones.proveedor : crearProveedorDeChat();
    const modeloId = config.asistente.modelId;

    const estaHabilitado = (companyId: string, actorId: string): Promise<boolean> =>
      withCompany({ companyId, actorId }, async (tx) => {
        const r = await tx.query<{ habilitado: boolean }>('SELECT habilitado FROM assistant_settings WHERE company_id = $1', [companyId]);
        return r.rows[0]?.habilitado === true;
      });

    // ── Estado ──────────────────────────────────────────────────────────────
    app.get('/asistente/estado', async (request) => {
      const tenant = await requireCompany(request);
      requirePermission(tenant, 'intelligence:ask');
      const auth = requireAuth(request);
      const actorId = `user:${auth.user.userId}`;

      const [habilitado, cupo] = await Promise.all([
        estaHabilitado(tenant.companyId, actorId),
        withCompany({ companyId: tenant.companyId, actorId }, (tx) =>
          leerCupo(tx, tenant.companyId, actorId, config.asistente.mensajesPorMinuto),
        ),
      ]);

      return {
        proveedor: {
          // `DESHABILITADO` (sin asistente en este servidor), `PREPARADO` (falta la credencial), `CONFIGURADO`. Con un
          // proveedor inyectado (tests) es siempre `CONFIGURADO`.
          estado: proveedor !== null && opciones.proveedor !== undefined ? 'CONFIGURADO' : estadoDelAsistente(config.asistente),
          id: proveedor?.id ?? null,
          modelo: proveedor === null ? null : modeloId,
        },
        habilitado,
        disponible: proveedor !== null && habilitado,
        puedeConfigurar: tenant.permissions.has('analysis:configure'),
        herramientas: armarHerramientas({ companyId: tenant.companyId, actorId, permisos: tenant.permissions }).map((h) => h.nombre),
        cupo: {
          usadasHoy: cupo.usadasHoy,
          topeDiario: cupo.topeDiario,
          sinTopeDeclarado: cupo.topeDiario === null,
          tokensUsadosHoy: cupo.tokensUsadosHoy,
          topeTokensPorDia: cupo.topeTokensPorDia,
          sinTopeDeTokensDeclarado: cupo.topeTokensPorDia === null,
        },
        adjuntos: ADJUNTOS,
        advertencia: ADVERTENCIA_DEL_ASISTENTE,
        alcance:
          'El asistente consulta con los permisos de quien le escribe, no guarda nada por sí solo y no calcula: las cifras ' +
          'salen del motor contable del sistema. Cada respuesta la redacta un modelo de lenguaje de un proveedor externo ' +
          '(Anthropic): los mensajes y los archivos que le mandes salen de NEXO hacia ese proveedor.',
      };
    });

    // ── Encender / apagar ───────────────────────────────────────────────────
    app.post('/asistente/configuracion', async (request) => {
      const tenant = await requireCompany(request);
      requirePermission(tenant, 'analysis:configure');
      const auth = requireAuth(request);
      const actorId = `user:${auth.user.userId}`;
      const body = z.object({ habilitado: z.boolean(), motivo: z.string().trim().min(5).max(500) }).parse(request.body);

      await withCompany({ companyId: tenant.companyId, actorId }, async (tx) => {
        await tx.query(
          `INSERT INTO assistant_settings (company_id, habilitado, motivo, declarado_por)
           VALUES ($1, $2, $3, $4)
           ON CONFLICT (company_id) DO UPDATE
             SET habilitado = EXCLUDED.habilitado, motivo = EXCLUDED.motivo,
                 declarado_por = EXCLUDED.declarado_por, declarado_at = now()`,
          [tenant.companyId, body.habilitado, body.motivo, actorId],
        );
        await recordAudit(tx, tenant.companyId, {
          actorType: 'USER',
          actorId,
          action: 'CONFIGURAR_ASISTENTE',
          objectType: 'assistant_settings',
          objectId: tenant.companyId,
          newValue: { habilitado: body.habilitado },
          motivo: body.motivo,
          ip: clientIp(request),
          userAgent: request.headers['user-agent'] ?? null,
        });
      });

      return { habilitado: body.habilitado, motivo: body.motivo };
    });

    // ── Conversaciones ──────────────────────────────────────────────────────
    app.get('/asistente/conversaciones', async (request) => {
      const tenant = await requireCompany(request);
      requirePermission(tenant, 'intelligence:ask');
      const auth = requireAuth(request);
      const actorId = `user:${auth.user.userId}`;
      return withCompany({ companyId: tenant.companyId, actorId }, async (tx) => {
        const r = await tx.query(
          `SELECT id, titulo, created_at AS "creadaEn", updated_at AS "actualizadaEn"
             FROM assistant_conversations
            WHERE company_id = $1 AND created_by = $2
            ORDER BY updated_at DESC, id DESC
            LIMIT 30`,
          [tenant.companyId, actorId],
        );
        return { conversaciones: r.rows };
      });
    });

    app.get('/asistente/conversaciones/:conversacionId', async (request) => {
      const tenant = await requireCompany(request);
      requirePermission(tenant, 'intelligence:ask');
      const auth = requireAuth(request);
      const actorId = `user:${auth.user.userId}`;
      const { conversacionId } = z.object({ conversacionId: z.string().uuid() }).parse(request.params);

      return withCompany({ companyId: tenant.companyId, actorId }, async (tx) => {
        const c = await tx.query<{ id: string; titulo: string }>(
          `SELECT id, titulo FROM assistant_conversations WHERE company_id = $1 AND id = $2 AND created_by = $3`,
          [tenant.companyId, conversacionId, actorId],
        );
        // Una conversación ajena se contesta igual que una que no existe.
        if (c.rows[0] === undefined) throw notFound('No existe esa conversación.');
        const m = await tx.query<{ rol: string; estado: string | null; texto: string }>(
          `SELECT id, rol, texto, estado, adjuntos, propuestas, created_at AS "creadoEn"
             FROM assistant_messages
            WHERE company_id = $1 AND conversation_id = $2
            ORDER BY created_at, id`,
          [tenant.companyId, conversacionId],
        );
        return {
          conversacion: c.rows[0],
          // El texto de un turno que no pasó el control NO se devuelve: se devuelve la explicación.
          mensajes: m.rows.map((f) =>
            f.rol === 'asistente' && f.estado !== 'RESPONDIDA' ? { ...f, texto: EXPLICACION[f.estado ?? ''] ?? '' } : f,
          ),
        };
      });
    });

    // ── Un mensaje ──────────────────────────────────────────────────────────
    app.post('/asistente/mensajes', async (request, reply) => {
      const tenant = await requireCompany(request);
      requirePermission(tenant, 'intelligence:ask');
      const auth = requireAuth(request);
      const actorId = `user:${auth.user.userId}`;

      if (proveedor === null) {
        throw conflictoTipado(
          'ASISTENTE_SIN_PROVEEDOR',
          'Este servidor no tiene conectado un proveedor para el asistente. El resto de NEXO funciona igual.',
        );
      }
      if (!(await estaHabilitado(tenant.companyId, actorId))) {
        throw conflictoTipado(
          'ASISTENTE_APAGADO',
          'El asistente está apagado para esta empresa. Quien administra puede encenderlo desde la pantalla Asistente.',
        );
      }

      // El tope técnico por minuto y el cupo diario de la empresa se miran ANTES de gastar.
      const corte = await evaluarCupo(tenant.companyId, actorId, config.asistente.mensajesPorMinuto);
      if (corte !== null) throw tooManyRequests(`${corte.codigo}: ${corte.detalle}`);

      const entrada = await leerEntrada(request);
      const textoDelUsuario = entrada.mensaje === '' ? '(archivo adjunto sin mensaje)' : entrada.mensaje;
      const conAdjuntos = entrada.adjuntos.length > 0;

      // Conversación + historial (lo de antes, en texto).
      const previo = await withCompany({ companyId: tenant.companyId, actorId }, async (tx) => {
        const hoy = await hoyDeLaBase(tx);
        if (entrada.conversacionId === undefined) return { hoy, historial: [] as { rol: string; texto: string }[] };
        const c = await tx.query(
          `SELECT 1 FROM assistant_conversations WHERE company_id = $1 AND id = $2 AND created_by = $3`,
          [tenant.companyId, entrada.conversacionId, actorId],
        );
        if (c.rows[0] === undefined) throw notFound('No existe esa conversación.');
        const m = await tx.query<{ rol: string; texto: string }>(
          `SELECT rol, texto FROM (
             SELECT rol, texto, created_at, id FROM assistant_messages
              WHERE company_id = $1 AND conversation_id = $2 AND (rol = 'usuario' OR estado = 'RESPONDIDA')
              ORDER BY created_at DESC, id DESC LIMIT $3) t
           ORDER BY created_at, id`,
          [tenant.companyId, entrada.conversacionId, HISTORIAL_MAXIMO],
        );
        return { hoy, historial: m.rows };
      });

      const herramientas = armarHerramientas({ companyId: tenant.companyId, actorId, permisos: tenant.permissions });
      const historial = normalizarHistorial(previo.historial);
      const system =
        `${ASISTENTE_V1.texto}\n\nCONTEXTO DE ESTA CONVERSACIÓN\n- Hoy es ${String(previo.hoy)}.\n` +
        `- Herramientas que tenés en esta conversación: ${herramientas.map((h) => h.nombre).join(', ')}.`;

      let huboCifraInventada = false;
      let turno: ResultadoDelTurno | null = null;
      let fallo: ErrorDeProveedor | null = null;
      try {
        turno = await conducirTurno({
          proveedor,
          system,
          historial,
          mensajeDelUsuario: textoDelUsuario,
          adjuntos: entrada.adjuntos.map((a) => ({
            tipo: 'adjunto' as const,
            clase: a.mediaType === 'application/pdf' ? ('documento' as const) : ('imagen' as const),
            mediaType: a.mediaType,
            base64: a.base64,
          })),
          herramientas,
          maxTokens: config.asistente.maxTokens,
          // Con un archivo adjunto la lectura de una foto no se puede verificar contra el sistema (ver el encabezado).
          revisarTexto: (texto, llamadas) => {
            if (conAdjuntos) return texto.trim() === '' ? { ok: false, motivo: 'La respuesta está vacía.' } : { ok: true };
            const v = revisarTextoDelAsistente({
              texto,
              llamadas,
              mensajeDelUsuario: textoDelUsuario,
              historial: previo.historial.map((h) => h.texto),
            });
            if (!v.ok) huboCifraInventada = true;
            return v;
          },
        });
      } catch (error) {
        if (!(error instanceof ErrorDeProveedor)) throw error;
        fallo = error;
      }

      const estado = fallo !== null ? 'FALLO_DEL_PROVEEDOR' : turno!.estado;
      const aceptada = estado === 'RESPONDIDA';
      const textoModelo = turno?.texto ?? '';
      // Lo que se guarda del asistente: el texto del modelo si pasó el control; si no, el texto queda para el registro
      // (no para la pantalla) en `ai_answers`, y en el mensaje va la explicación.
      const textoMostrable = aceptada ? textoModelo : (EXPLICACION[estado] ?? '');
      const propuestas = (turno?.llamadas ?? [])
        .map((l) => l.resultado.propuesta)
        .filter((p): p is NonNullable<typeof p> => p !== undefined && p !== null);
      const consultas = (turno?.llamadas ?? []).map((l) => ({ nombre: l.nombre, error: l.resultado.esError === true }));
      const uso = turno?.uso ?? null;
      const modeloUsado = turno?.modeloId !== undefined && turno.modeloId !== '' ? turno.modeloId : modeloId;

      const registro = await withCompany({ companyId: tenant.companyId, actorId }, async (tx) => {
        const precio = await precioVigente(tx, proveedor.id, modeloUsado);
        const costo = calcularCostoEnMicros(
          uso === null ? null : { tokensDeEntrada: uso.entrada, tokensDeSalida: uso.salida, tokensTotales: uso.entrada + uso.salida },
          precio,
        );

        let conversacionId = entrada.conversacionId;
        if (conversacionId === undefined) {
          const titulo = (entrada.mensaje === '' ? 'Archivo adjunto' : entrada.mensaje).replace(/\s+/gu, ' ').slice(0, 60);
          const c = await tx.query<{ id: string }>(
            `INSERT INTO assistant_conversations (company_id, created_by, titulo) VALUES ($1, $2, $3) RETURNING id`,
            [tenant.companyId, actorId, titulo],
          );
          conversacionId = c.rows[0]!.id;
        } else {
          await tx.query(`UPDATE assistant_conversations SET updated_at = now() WHERE company_id = $1 AND id = $2`, [tenant.companyId, conversacionId]);
        }

        await tx.query(
          `INSERT INTO assistant_messages (company_id, conversation_id, rol, texto, adjuntos, created_at)
           VALUES ($1, $2, 'usuario', $3, $4::jsonb, clock_timestamp())`,
          [
            tenant.companyId,
            conversacionId,
            textoDelUsuario,
            JSON.stringify(entrada.adjuntos.map((a) => ({ nombre: a.nombre, tipo: a.mediaType, bytes: a.bytes, sha256: a.sha256 }))),
          ],
        );
        await tx.query(
          `INSERT INTO assistant_messages
             (company_id, conversation_id, rol, texto, estado, herramientas, propuestas, correcciones,
              model_provider, model_id, tokens_entrada, tokens_salida, costo_micros, created_at)
           VALUES ($1, $2, 'asistente', $3, $4, $5::jsonb, $6::jsonb, $7, $8, $9, $10, $11, $12, clock_timestamp())`,
          [
            tenant.companyId,
            conversacionId,
            // El texto del modelo que NO pasó el control no se guarda acá: queda en `ai_answers`, para la métrica.
            textoMostrable === '' ? '(sin texto)' : textoMostrable,
            estado,
            JSON.stringify(consultas),
            JSON.stringify(propuestas),
            turno?.motivosDeRechazo.length ?? 0,
            proveedor.id,
            modeloUsado,
            uso?.entrada ?? null,
            uso?.salida ?? null,
            costo,
          ],
        );

        await recordAudit(tx, tenant.companyId, {
          actorType: 'USER',
          actorId,
          action: 'CONSULTAR_ASISTENTE',
          objectType: 'assistant_conversations',
          objectId: conversacionId,
          // Sin el contenido: la bitácora dice QUE se consultó, no qué se dijo.
          newValue: {
            estado,
            herramientas: consultas.map((c) => c.nombre),
            adjuntos: entrada.adjuntos.length,
            tokensEntrada: uso?.entrada ?? null,
            tokensSalida: uso?.salida ?? null,
            costoMicros: costo,
          },
          motivo: 'Consulta al asistente.',
          ip: clientIp(request),
          userAgent: request.headers['user-agent'] ?? null,
        });

        return { conversacionId, costo };
      });

      // `ai_answers` cuenta para el cupo y para la métrica de alucinación. Es un hecho aparte: si el prompt no está
      // archivado (`npm run prompts:register`) la FK lo rechaza, y eso no se lleva puesta la respuesta.
      let registrada = true;
      try {
        await withCompany({ companyId: tenant.companyId, actorId }, async (tx) => {
          const rechazos =
            fallo !== null
              ? [{ codigo: `PROVEEDOR_${fallo.codigo}`, detalle: CODIGOS_DE_FALLO[fallo.codigo] ?? 'falló', esAlucinacion: false }]
              : (turno?.motivosDeRechazo ?? []).map((m) => ({ codigo: 'CIFRA_INVENTADA', detalle: m, esAlucinacion: true }));
          const rechazosFinal = aceptada ? [] : rechazos.length > 0 ? rechazos : [{ codigo: estado, detalle: EXPLICACION[estado] ?? estado, esAlucinacion: false }];
          await tx.query(
            `INSERT INTO ai_answers
               (company_id, pregunta, contexto, respuesta, abstencion, aceptada, rechazos,
                cifras_inventadas, model_provider, model_id, prompt_hash, created_by)
             VALUES ($1,$2,$3::jsonb,$4,false,$5,$6::jsonb,$7,$8,$9,$10,$11)`,
            [
              tenant.companyId,
              textoDelUsuario,
              JSON.stringify({
                origen: 'asistente',
                conversacionId: registro.conversacionId,
                adjuntos: entrada.adjuntos.map((a) => ({ nombre: a.nombre, tipo: a.mediaType, sha256: a.sha256 })),
                consultas: (turno?.llamadas ?? []).map((l) => ({ nombre: l.nombre, entrada: l.entrada, resultado: l.resultado.contenido })),
              }),
              aceptada ? textoModelo : null,
              aceptada,
              JSON.stringify(rechazosFinal),
              !aceptada && huboCifraInventada ? 1 : 0,
              proveedor.id,
              modeloUsado,
              ASISTENTE_V1.hash,
              actorId,
            ],
          );
        });
      } catch {
        registrada = false;
      }

      reply.code(200);
      return {
        conversacionId: registro.conversacionId,
        estado,
        // Sólo si pasó el control. Si no, la explicación.
        respuesta: {
          texto: textoMostrable,
          advertencia: aceptada ? ADVERTENCIA_DEL_ASISTENTE : null,
          // Lo leído de un archivo no se verificó contra el sistema: la pantalla lo dice.
          lecturaDeArchivoSinVerificar: aceptada && conAdjuntos,
          consultas,
          propuestas,
        },
        uso: uso === null ? null : { entrada: uso.entrada, salida: uso.salida, costoMicros: registro.costo },
        registrada,
        ...(fallo === null ? {} : { motivoDelFallo: fallo.codigo }),
      };
    });
  };
}

