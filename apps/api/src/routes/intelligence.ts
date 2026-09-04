/**
 * NEXO Intelligence — la capa que contesta preguntas sobre la empresa.
 *
 * ## Determinístico primero
 *
 * El número lo calcula el motor que ya existe: la analítica, la cuenta
 * corriente, la valuación, la bandeja. Cada respuesta viene con **de dónde
 * salió** y **qué no incluye**, porque un total sin forma de abrirlo es una
 * afirmación sin origen.
 *
 * El modelo —cuando hay proveedor configurado— redacta lo que el motor calculó,
 * y su salida pasa por el control que ya estaba escrito en `@aai/ai-engine`:
 * cada numeral de la redacción tiene que estar en el contexto, o la respuesta se
 * rechaza entera.
 *
 * ## Sin proveedor, esto igual funciona
 *
 * `AI_PROVIDER=none` es un modo de operación previsto, no una degradación: la
 * respuesta llega con sus cifras y su evidencia, y lo único que falta es el
 * párrafo. La pantalla lo dice con esas palabras. Un endpoint que contestara
 * «no disponible» sin dar el número sería esconder detrás de la IA algo que el
 * sistema ya sabe.
 *
 * ## Lo que no hace
 *
 * No arma consultas nuevas. El catálogo es cerrado: si nadie escribió cómo se
 * contesta una pregunta, el sistema dice que no la sabe contestar y muestra las
 * que sí. Dejar que un modelo escriba SQL produciría un segundo número para la
 * misma pregunta, sin forma de saber cuál está bien — y §41 lo prohíbe.
 */

import {
  AnsweringAgent,
  ErrorDeProveedor,
  type ContextoDeRespuesta,
  type ResultadoDelRespondedor,
} from '@aai/ai-engine';
import { recordAudit, withCompany } from '@aai/db';
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import {
  clientIp,
  requireAuth,
  requireCompany,
  requirePermission,
  type RequestTenant,
} from '../http/context.js';
import { forbidden, tooManyRequests } from '../http/errors.js';
import { crearProveedor } from '../ai/proveedor.js';
import { evaluarCupo, leerCupo } from '../ai/cupo.js';
import { config } from '../config.js';
import {
  CATALOGO,
  coincidencias,
  fueraDeAlcance,
  mesDe,
  preguntasPara,
  type PreguntaDelCatalogo,
  type RespuestaDeterministica,
} from '../intelligence/catalogo.js';

const mesValido = z.string().regex(/^\d{4}-(0[1-9]|1[0-2])$/u, 'Mes en formato AAAA-MM');

/** Las preguntas que este usuario puede hacer, por sus permisos. */
function disponiblesPara(tenant: RequestTenant): PreguntaDelCatalogo[] {
  return preguntasPara(tenant.permissions);
}

const mesCorriente = (): string => new Date().toISOString().slice(0, 7);

/**
 * Corta antes de preguntar, no después.
 *
 * Se evalúa aunque el proveedor sea `none`: el límite es del **acto de
 * preguntar**, y si dependiera de qué proveedor hay configurado, el día que se
 * conecte uno real el sistema cambiaría de comportamiento en un lugar que nadie
 * probó. Además `ai_answers` registra la llamada igual, así que el consumo se
 * cuenta igual.
 */
async function verificarCupo(companyId: string, actorId: string): Promise<void> {
  const corte = await evaluarCupo(companyId, actorId, config.ai.preguntasPorMinuto);
  if (corte !== null) throw tooManyRequests(`${corte.codigo}: ${corte.detalle}`);
}

/**
 * La llamada al proveedor, con su fallo convertido en un estado.
 *
 * El fallo del proveedor **no se lleva puesta la respuesta**. La cifra ya la
 * calculó el motor determinístico y es correcta con o sin narración; dejar que
 * un 429 o un timeout suba como excepción convertiría una respuesta válida en
 * un 500, y la IA pasaría a ser un punto único de fallo del ERP — que es
 * exactamente lo contrario de lo que esta capa es.
 *
 * Se informa el **código** y no el mensaje crudo del proveedor: ese texto puede
 * traer el pedido completo, y el pedido lleva la cabecera de autorización.
 */
async function redactar(
  contexto: ContextoDeRespuesta,
): Promise<ResultadoDelRespondedor | { readonly estado: 'FALLO'; readonly codigo: string }> {
  try {
    return await new AnsweringAgent({ provider: crearProveedor() }).responder(contexto);
  } catch (error) {
    return {
      estado: 'FALLO',
      codigo: error instanceof ErrorDeProveedor ? error.codigo : 'DESCONOCIDO',
    };
  }
}

export async function intelligenceRoutes(app: FastifyInstance): Promise<void> {
  /**
   * Qué sabe contestar el sistema.
   *
   * Se filtra por permisos, igual que la bandeja: quien no puede ver la
   * cuenta corriente no recibe la pregunta sobre cobranzas, y su lista es más
   * corta — que es la respuesta correcta, no un 403.
   */
  app.get('/intelligence/preguntas', async (request) => {
    const tenant = await requireCompany(request);
    requireAuth(request);

    return {
      preguntas: disponiblesPara(tenant).map((p) => ({
        id: p.id,
        pregunta: p.pregunta,
        admiteMes: p.admiteMes,
      })),
      narracion: {
        disponible: config.ai.provider !== 'none',
        proveedor: config.ai.provider,
        motivo:
          config.ai.provider === 'none'
            ? 'No hay proveedor de modelo configurado. Las respuestas llegan con sus cifras y ' +
              'su evidencia; lo único que falta es el párrafo redactado. Es un modo de ' +
              'operación previsto: los documentos de un estudio son secreto profesional y ' +
              'muchas empresas no quieren que salgan a un tercero.'
            : null,
      },
      alcance:
        'El catálogo es cerrado a propósito. Cada pregunta se contesta con el motor que ya ' +
        'calcula ese número —la analítica, la cuenta corriente, la valuación—, así que la ' +
        'respuesta cuadra con la pantalla que muestra lo mismo. Una pregunta fuera del ' +
        'catálogo se contesta «no la sé contestar» y no con una aproximación.',
    };
  });

  /**
   * Cuánto se consumió, y contra qué tope.
   *
   * Se lee sin decidir nada: una pantalla que dice «van 180 de 200» es distinta
   * de una que corta en la 201 sin aviso.
   */
  app.get('/intelligence/quota', async (request) => {
    const tenant = await requireCompany(request);
    requirePermission(tenant, 'intelligence:ask');
    const auth = requireAuth(request);
    const actorId = `user:${auth.user.userId}`;

    const estado = await withCompany({ companyId: tenant.companyId, actorId }, (tx) =>
      leerCupo(tx, tenant.companyId, actorId, config.ai.preguntasPorMinuto),
    );

    return {
      ...estado,
      // `null` no es «cero» ni «ilimitado por diseño»: es que la empresa no
      // declaró un tope. Decirlo con esas palabras evita que una pantalla
      // dibuje una barra de progreso sobre un denominador que no existe.
      sinTopeDeclarado: estado.topeDiario === null,
      alcance:
        'El cupo diario lo declara la empresa: cuántas preguntas entran en un día depende de ' +
        'su plan y de lo que esté dispuesta a gastar, y NEXO no lo inventa. El consumo se ' +
        'cuenta de las llamadas registradas, no de un contador aparte, y es por empresa: ' +
        'entrar con otro usuario no lo cambia.',
    };
  });

  /**
   * Declara el cupo diario.
   *
   * Es una decisión comercial y por eso exige motivo: un número sin explicación,
   * seis meses después, es una traba que nadie sabe por qué está.
   */
  app.post('/intelligence/quota', async (request, reply) => {
    const tenant = await requireCompany(request);
    // Configurar el análisis, no preguntarle: es el mismo permiso con el que se
    // declaran los umbrales, y lo tienen ADMINISTRADOR y CONTADOR.
    requirePermission(tenant, 'analysis:configure');
    const auth = requireAuth(request);
    const actorId = `user:${auth.user.userId}`;
    const body = z
      .object({
        llamadasPorDia: z.number().int().min(0).max(1_000_000),
        motivo: z.string().min(5).max(500),
      })
      .parse(request.body);

    await withCompany({ companyId: tenant.companyId, actorId }, async (tx) => {
      await tx.query(
        `INSERT INTO ai_quotas (company_id, llamadas_por_dia, motivo, declarado_por)
         VALUES ($1, $2, $3, $4)
         ON CONFLICT (company_id) DO UPDATE
           SET llamadas_por_dia = EXCLUDED.llamadas_por_dia,
               motivo = EXCLUDED.motivo,
               declarado_por = EXCLUDED.declarado_por,
               declarado_at = now()`,
        [tenant.companyId, body.llamadasPorDia, body.motivo, actorId],
      );

      await recordAudit(tx, tenant.companyId, {
        actorType: 'USER',
        actorId,
        action: 'DECLARAR_CUPO_DE_IA',
        objectType: 'ai_quotas',
        objectId: tenant.companyId,
        newValue: { llamadasPorDia: body.llamadasPorDia },
        motivo: body.motivo,
        ip: clientIp(request),
        userAgent: request.headers['user-agent'] ?? null,
      });
    });

    reply.code(201);
    return { llamadasPorDia: body.llamadasPorDia, motivo: body.motivo };
  });

  /**
   * Contesta una pregunta escrita a mano.
   *
   * Tres respuestas posibles, y las tres son honestas: la contesta, dice que no
   * entendió, o dice que entendió varias cosas y pide elegir.
   */
  app.post('/intelligence/preguntar', async (request) => {
    const tenant = await requireCompany(request);
    // Preguntar no es leer. Leer la analítica y **hacer que el sistema le
    // pregunte a un tercero** son dos actos distintos: el segundo puede costar
    // plata y saca cifras de la empresa hacia afuera. Hasta la 0094 los
    // gobernaba el mismo permiso.
    requirePermission(tenant, 'intelligence:ask');
    const auth = requireAuth(request);

    await verificarCupo(tenant.companyId, `user:${auth.user.userId}`);

    const body = z
      .object({
        pregunta: z.string().min(3).max(500),
        /** Para responder una del catálogo sin escribirla. */
        preguntaId: z.string().max(60).optional(),
        mes: mesValido.optional(),
      })
      .parse(request.body);

    const disponibles = disponiblesPara(tenant);

    // Por id: la pantalla ofrece la lista y manda la elegida. No pasa por el
    // reconocimiento de texto porque no hace falta adivinar nada.
    if (body.preguntaId !== undefined) {
      const elegida = disponibles.find((p) => p.id === body.preguntaId);
      if (elegida === undefined) {
        const existe = CATALOGO.some((p) => p.id === body.preguntaId);
        throw forbidden(
          existe
            ? 'Esa pregunta necesita un permiso que este usuario no tiene.'
            : 'Esa pregunta no está en el catálogo.',
        );
      }
      return responder(elegida);
    }

    // Antes de reconocer: hay preguntas que se entienden perfecto y que el
    // sistema no contesta. Decir «no entendí» ahí sería mentir sobre el motivo,
    // y contestar con la pregunta más parecida sería peor.
    const afuera = fueraDeAlcance(body.pregunta);
    if (afuera !== null && body.preguntaId === undefined) {
      return {
        entendida: false,
        motivo: 'FUERA_DE_ALCANCE',
        tema: afuera.tema,
        explicacion: afuera.motivo,
        preguntasPosibles: disponibles.map((p) => ({ id: p.id, pregunta: p.pregunta })),
      };
    }

    const candidatas = coincidencias(body.pregunta, disponibles);

    if (candidatas.length === 0) {
      return {
        entendida: false,
        motivo: 'NO_ENTENDIDA',
        explicacion:
          'No sé contestar eso. Prefiero decirlo antes que contestar una pregunta parecida: ' +
          'una respuesta correcta a una pregunta que nadie hizo se lee igual que la respuesta.',
        preguntasPosibles: disponibles.map((p) => ({ id: p.id, pregunta: p.pregunta })),
      };
    }

    if (candidatas.length > 1) {
      return {
        entendida: false,
        motivo: 'AMBIGUA',
        explicacion:
          'Puede ser más de una cosa y elegir sería adivinar. ¿Cuál de estas?',
        preguntasPosibles: candidatas.map((c) => ({
          id: c.pregunta.id,
          pregunta: c.pregunta.pregunta,
        })),
      };
    }

    return responder(candidatas[0]!.pregunta);

    async function responder(pregunta: PreguntaDelCatalogo) {
      const mes = pregunta.admiteMes
        ? (body.mes ?? mesDe(body.pregunta) ?? mesCorriente())
        : mesCorriente();

      const respuesta = await withCompany(
        { companyId: tenant.companyId, actorId: `user:${auth.user.userId}` },
        async (tx) => pregunta.responder(tx, tenant.companyId, mes),
      );

      const narracion = await narrar(
        tenant.companyId,
        `user:${auth.user.userId}`,
        body.pregunta,
        respuesta,
      );

      return {
        entendida: true,
        preguntaId: pregunta.id,
        pregunta: pregunta.pregunta,
        respuesta: formatear(respuesta),
        narracion,
      };
    }
  });

  /**
   * El panorama: varias respuestas juntas.
   *
   * Es «¿qué está pasando?» contestado con lo que el sistema ya sabe. Cada
   * tarjeta trae su evidencia, así que el panorama no es un resumen que hay que
   * creer: es un índice a los números que lo componen.
   */
  app.get('/intelligence/panorama', async (request) => {
    const tenant = await requireCompany(request);
    const auth = requireAuth(request);

    const orden = ['COMO_VOY', 'CUANTO_TENGO', 'CUANTO_ME_DEBEN', 'CUANTO_DEBO',
      'VALOR_DEL_STOCK', 'MARGEN', 'QUE_ESTA_EN_RIESGO', 'QUE_ME_FALTA'];
    const disponibles = disponiblesPara(tenant)
      .filter((p) => orden.includes(p.id))
      .sort((a, b) => orden.indexOf(a.id) - orden.indexOf(b.id));

    const mes = mesCorriente();
    const tarjetas = await withCompany(
      { companyId: tenant.companyId, actorId: `user:${auth.user.userId}` },
      async (tx) => {
        const salida = [];
        for (const pregunta of disponibles) {
          const respuesta = await pregunta.responder(tx, tenant.companyId, mes);
          salida.push({ preguntaId: pregunta.id, ...formatear(respuesta) });
        }
        return salida;
      },
    );

    await withCompany(
      { companyId: tenant.companyId, actorId: `user:${auth.user.userId}` },
      async (tx) => {
        await recordAudit(tx, tenant.companyId, {
          actorType: 'USER',
          actorId: `user:${auth.user.userId}`,
          action: 'CONSULTAR_PANORAMA',
          objectType: 'companies',
          objectId: tenant.companyId,
          newValue: { tarjetas: tarjetas.length },
          motivo: 'Lectura del panorama de inteligencia.',
          ip: clientIp(request),
          userAgent: request.headers['user-agent'] ?? null,
        });
      },
    );

    return {
      tarjetas,
      alcance:
        'Cada tarjeta la calcula el mismo motor que la pantalla del módulo, así que los ' +
        'números coinciden. Un valor en null no es cero: es que el sistema no puede afirmarlo, ' +
        'y la metodología dice por qué.',
    };
  });
}


/**
 * La redacción, cuando hay con qué.
 *
 * El contexto que ve el modelo es **exactamente** la respuesta determinística:
 * las mismas cifras, ya formateadas, con su origen. No se le pasa la base ni un
 * resumen aparte, porque entonces la respuesta hablaría de otros números que
 * los que la pantalla muestra.
 *
 * Toda llamada queda en `ai_answers` con ese contexto, aceptada o rechazada.
 * Guardar solo las aceptadas haría que la métrica de alucinación se vea mejor de
 * lo que es.
 */
async function narrar(
  companyId: string,
  actorId: string,
  preguntaTexto: string,
  respuesta: RespuestaDeterministica,
): Promise<Record<string, unknown>> {
  const contexto: ContextoDeRespuesta = {
    companyId,
    pregunta: preguntaTexto,
    datos: [
      { etiqueta: respuesta.titulo, valor: respuesta.valor ?? 'no se puede afirmar',
        origen: respuesta.origen.join(', ') },
      ...respuesta.datos,
      ...(respuesta.noIncluye === null
        ? []
        : [{ etiqueta: 'Salvedad', valor: respuesta.noIncluye, origen: 'metodología' }]),
    ],
    // Ninguna: esta capa no interpreta normativa. Con el enum vacío, el schema
    // no admite ninguna cita, que es más fuerte que pedirle que no cite.
    normas: [],
    periodo: respuesta.periodo,
  };

  /**
   * El fallo del proveedor no se lleva puesta la respuesta.
   *
   * La cifra ya está calculada por el motor determinístico y es correcta con o
   * sin narración. Dejar que un 429 o un timeout suba como excepción convertiría
   * una respuesta válida en un 500: la IA pasaría a ser un punto único de fallo
   * del ERP, que es exactamente lo contrario de lo que esta capa es.
   *
   * El motivo se informa con su código —`TIMEOUT`, `LIMITE_DE_TASA`,
   * `PROVEEDOR_CAIDO`— y no con el mensaje crudo del proveedor: ese texto puede
   * traer el pedido completo, y el pedido lleva la cabecera de autorización.
   */
  const resultado = await redactar(contexto);

  if (resultado.estado === 'FALLO') {
    return {
      disponible: false,
      motivo: 'PROVEEDOR_FALLO',
      codigo: resultado.codigo,
      explicacion:
        'La cifra y su evidencia son del motor determinístico y siguen siendo correctas. ' +
        'El proveedor de modelo no pudo redactar el párrafo, y eso no cambia el número.',
    };
  }

  if (resultado.estado === 'SIN_PROVEEDOR') {
    return {
      disponible: false,
      motivo: 'SIN_PROVEEDOR',
      explicacion:
        'La cifra y su evidencia son del motor determinístico. La redacción en prosa exige ' +
        'un proveedor de modelo configurado, y su salida se verifica cifra por cifra contra ' +
        'este mismo contexto antes de mostrarse.',
    };
  }

  const aceptada = resultado.estado === 'RESPONDIDA';
  const abstencion = aceptada && resultado.respuesta.abstencion;
  const texto = aceptada ? resultado.respuesta.texto : resultado.texto;
  const rechazos = aceptada ? [] : resultado.rechazos;

  // El registro es un hecho aparte de la lectura: se escribe en su propia
  // transacción para que un fallo al guardar no se lleve puesta la respuesta
  // determinística, que es correcta con o sin narración.
  let registrada = false;
  try {
    await withCompany({ companyId, actorId }, async (tx) => {
      await tx.query(
        `INSERT INTO ai_answers
           (company_id, pregunta, contexto, respuesta, abstencion, aceptada, rechazos,
            cifras_inventadas, model_provider, model_id, prompt_hash, created_by)
         VALUES ($1,$2,$3::jsonb,$4,$5,$6,$7::jsonb,$8,$9,$10,$11,$12)`,
        [
          companyId,
          preguntaTexto,
          JSON.stringify(contexto),
          aceptada && !abstencion ? texto : null,
          abstencion,
          aceptada,
          JSON.stringify(rechazos),
          rechazos.filter((r) => r.esAlucinacion).length,
          config.ai.provider,
          resultado.modelId,
          resultado.promptHash,
          actorId,
        ],
      );
    });
    registrada = true;
  } catch {
    // El prompt tiene que estar archivado (`npm run prompts:register`): sin él
    // la FK rechaza la fila. Se informa y no se pierde la respuesta.
    registrada = false;
  }

  if (!aceptada) {
    return {
      disponible: false,
      motivo: 'RECHAZADA',
      registrada,
      explicacion:
        'El modelo respondió algo que no pasó el control: cada cifra de la redacción tiene ' +
        'que estar en el contexto. La respuesta se descarta entera, no se le tacha el número.',
      rechazos: rechazos.map((r) => ({
        codigo: r.codigo, detalle: r.detalle, esAlucinacion: r.esAlucinacion,
      })),
    };
  }

  if (abstencion) {
    return {
      disponible: false,
      motivo: 'ABSTENCION',
      registrada,
      explicacion:
        config.ai.provider === 'mock'
          ? 'El proveedor simulado se abstiene siempre: no proviene de ningún modelo y no ' +
            'tiene valor. La cifra de arriba sí es real — la calculó el motor.'
          : 'El modelo se abstuvo: con estos datos no puede redactar la respuesta. La cifra ' +
            'de arriba no depende de eso.',
    };
  }

  return {
    disponible: true,
    motivo: 'REDACTADA',
    registrada,
    texto,
    advertencia: resultado.advertencia,
    datosUsados: resultado.respuesta.datosUsados,
  };
}

/** La forma que ve la pantalla. Separa el número de su evidencia. */
function formatear(r: RespuestaDeterministica) {
  return {
    titulo: r.titulo,
    valor: r.valor,
    unidad: r.unidad,
    periodo: r.periodo,
    datos: r.datos,
    origen: r.origen,
    metodologia: r.metodologia,
    noIncluye: r.noIncluye,
  };
}
