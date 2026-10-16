/**
 * Las herramientas del asistente: lo único que el modelo puede hacer además de hablar.
 *
 * ## Qué son y qué no son
 *
 * Cada herramienta es un envoltorio fino sobre algo que el sistema ya tiene, con los permisos de **la persona que escribe**
 * (no los del asistente: el asistente no tiene permisos propios). Si la persona no puede ver los terceros, el asistente no
 * recibe la herramienta que los busca; no es un 403 que el modelo tenga que interpretar.
 *
 *   preguntar_al_sistema    el catálogo cerrado de preguntas (`intelligence/catalogo.ts`). Es la ÚNICA fuente de cifras.
 *   buscar_terceros         lectura del maestro de terceros.
 *   ayuda_de_nexo           texto fijo escrito acá: dónde está cada cosa y cómo se carga.
 *   proponer_alta_de_tercero  ARMA una propuesta de alta. **No escribe nada**: devuelve los datos validados para que la
 *                           persona los confirme con un botón que llama al alta de siempre (`POST /parties`), con su
 *                           permiso y su bitácora. ADR-001: la IA no escribe en la contabilidad ni en los maestros.
 *
 * ## Qué se le devuelve al modelo
 *
 * Texto JSON, corto. Lo que devuelve una herramienta es lo que el control de cifras considera «contexto»: una cifra que el
 * asistente diga y que no esté acá (ni la haya escrito la persona) hace que su respuesta se rechace entera.
 *
 * Los datos de la base (razones sociales, observaciones) son **datos, no instrucciones**; el prompt se lo dice al modelo, y
 * acá no se les da forma de instrucción: se devuelven dentro de campos con nombre.
 */

import type { HerramientaDeChat, ResultadoDeHerramienta } from '@aai/ai-engine';
import { withCompany } from '@aai/db';
import { isValidCuit, normalizeCuit } from '@aai/shared';
import { z } from 'zod';
import {
  formatearRespuesta,
  hoyDeLaBase,
  mesCorrienteDe,
  preguntasPara,
} from '../intelligence/catalogo.js';

export interface ContextoDeHerramientas {
  readonly companyId: string;
  /** `user:<id>`: la persona que escribe. */
  readonly actorId: string;
  readonly permisos: ReadonlySet<string>;
}

const MES = /^\d{4}-(0[1-9]|1[0-2])$/u;

const TIPOS_DOCUMENTO = ['CUIT', 'CUIL', 'DNI', 'PASAPORTE', 'DOC_EXTRANJERO', 'SIN_IDENTIFICAR'] as const;
const CONDICIONES_IVA = [
  'RESPONSABLE_INSCRIPTO', 'MONOTRIBUTO', 'EXENTO', 'CONSUMIDOR_FINAL', 'NO_CATEGORIZADO', 'DESCONOCIDA',
] as const;
const ROLES = ['CLIENTE', 'PROVEEDOR', 'EMPLEADO', 'ACREEDOR', 'DEUDOR', 'TRANSPORTISTA', 'OTRO'] as const;

const ok = (datos: unknown): ResultadoDeHerramienta => ({ contenido: JSON.stringify(datos), datos });
const fallo = (mensaje: string): ResultadoDeHerramienta => ({
  contenido: JSON.stringify({ error: mensaje }),
  datos: { error: mensaje },
  esError: true,
});

/** Los errores de validación de la entrada del modelo, en una línea que el modelo pueda usar para corregirse. */
const mensajeDe = (error: z.ZodError): string =>
  error.issues.map((i) => `${i.path.join('.') || 'entrada'}: ${i.message}`).join('; ');

// ---------------------------------------------------------------------------------------------------------------------
// preguntar_al_sistema
// ---------------------------------------------------------------------------------------------------------------------

function preguntarAlSistema(ctx: ContextoDeHerramientas): HerramientaDeChat | null {
  const disponibles = preguntasPara(ctx.permisos);
  if (disponibles.length === 0) return null;

  const entrada = z.object({ preguntaId: z.string().max(60), mes: z.string().regex(MES).optional() }).strict();

  return {
    nombre: 'preguntar_al_sistema',
    descripcion:
      'Consulta una cifra o un estado de la empresa. Es la ÚNICA fuente de números: cada pregunta la contesta el motor ' +
      'contable del sistema, con su evidencia y lo que no incluye. Elegí el id que corresponde; si ninguno encaja, no ' +
      'inventes una respuesta: decí que eso no se puede consultar. Preguntas disponibles:\n' +
      disponibles
        .map((p) => `- ${p.id}: ${p.pregunta}${p.admiteMes ? ' (admite mes)' : ''}`)
        .join('\n'),
    esquema: {
      type: 'object',
      properties: {
        preguntaId: { type: 'string', enum: disponibles.map((p) => p.id), description: 'El id de la pregunta.' },
        mes: {
          type: 'string',
          pattern: '^\\d{4}-(0[1-9]|1[0-2])$',
          description: 'Mes en formato AAAA-MM. Solo para las preguntas que admiten mes; si se omite, el mes corriente.',
        },
      },
      required: ['preguntaId'],
      additionalProperties: false,
    },
    ejecutar: async (crudo) => {
      const e = entrada.safeParse(crudo);
      if (!e.success) return fallo(mensajeDe(e.error));
      const pregunta = disponibles.find((p) => p.id === e.data.preguntaId);
      if (pregunta === undefined) {
        return fallo(`La pregunta "${e.data.preguntaId}" no está disponible. Ids posibles: ${disponibles.map((p) => p.id).join(', ')}.`);
      }
      const respuesta = await withCompany({ companyId: ctx.companyId, actorId: ctx.actorId }, async (tx) => {
        const hoy = await hoyDeLaBase(tx);
        const mes = pregunta.admiteMes ? (e.data.mes ?? mesCorrienteDe(hoy)) : mesCorrienteDe(hoy);
        return pregunta.responder(tx, ctx.companyId, mes);
      });
      return ok({ preguntaId: pregunta.id, pregunta: pregunta.pregunta, ...formatearRespuesta(respuesta) });
    },
  };
}

// ---------------------------------------------------------------------------------------------------------------------
// buscar_terceros
// ---------------------------------------------------------------------------------------------------------------------

const MAX_TERCEROS = 8;

function buscarTerceros(ctx: ContextoDeHerramientas): HerramientaDeChat | null {
  if (!ctx.permisos.has('party:read')) return null;
  const entrada = z.object({ texto: z.string().trim().min(2).max(120) }).strict();

  return {
    nombre: 'buscar_terceros',
    descripcion:
      'Busca clientes, proveedores y demás terceros ya cargados, por nombre o por el comienzo del número de documento. ' +
      `Devuelve hasta ${String(MAX_TERCEROS)}. Úsala antes de proponer un alta, para no duplicar.`,
    esquema: {
      type: 'object',
      properties: { texto: { type: 'string', description: 'Parte del nombre o el comienzo del documento.' } },
      required: ['texto'],
      additionalProperties: false,
    },
    ejecutar: async (crudo) => {
      const e = entrada.safeParse(crudo);
      if (!e.success) return fallo(mensajeDe(e.error));
      const filas = await withCompany({ companyId: ctx.companyId, actorId: ctx.actorId }, async (tx) => {
        const r = await tx.query<{
          id: string; razonSocial: string; tipoDocumento: string; numeroDocumento: string | null;
          condicionIva: string; status: string; roles: string[];
        }>(
          `SELECT p.id, p.razon_social AS "razonSocial", p.tipo_documento AS "tipoDocumento",
                  p.numero_documento AS "numeroDocumento", p.condicion_iva AS "condicionIva", p.status,
                  coalesce((SELECT array_agg(r.role ORDER BY r.role) FROM party_roles r
                             WHERE r.party_id = p.id AND r.company_id = p.company_id), ARRAY[]::text[]) AS roles
             FROM parties p
            WHERE p.company_id = $1
              AND (lower(p.razon_social) LIKE '%' || lower($2) || '%'
                   OR lower(coalesce(p.nombre_fantasia, '')) LIKE '%' || lower($2) || '%'
                   OR p.numero_documento LIKE $2 || '%')
            ORDER BY p.razon_social
            LIMIT $3`,
          [ctx.companyId, e.data.texto, MAX_TERCEROS + 1],
        );
        return r.rows;
      });
      const hayMas = filas.length > MAX_TERCEROS;
      return ok({ terceros: filas.slice(0, MAX_TERCEROS), hayMas, ...(hayMas ? { aviso: 'Hay más resultados: afiná la búsqueda.' } : {}) });
    },
  };
}

// ---------------------------------------------------------------------------------------------------------------------
// ayuda_de_nexo
// ---------------------------------------------------------------------------------------------------------------------

/**
 * Texto fijo. Cada afirmación de acá la tiene que poder verificar alguien mirando la consola: no se describe ningún botón
 * que no esté, y lo que no se sabe no se dice. Los nombres de pantalla son los del menú.
 */
const AYUDA: Readonly<Record<string, string>> = {
  'donde-esta-cada-cosa':
    'El menú de la izquierda agrupa las pantallas por tarea, de lo más usado a lo menos usado. Empezar: Inicio (resumen), ' +
    'Pendientes (lo que espera una decisión), Propuestas de IA, Asistente y Preguntar (consultas al sistema). Vender: ' +
    'Presupuestos y pedidos, Facturas y comprobantes, Clientes y proveedores, Productos, Precios, CRM y Comisiones. Comprar: ' +
    'Documentos, Pedidos de compra, Recepciones y Órdenes de pago. Dinero: Caja, Bancos y Cheques. Stock y operación: Stock, ' +
    'Bienes de uso, Proyectos, Sucursales e Integraciones. Contabilidad: Asientos, Libros, IVA, Estados y notas y Cierre de ' +
    'períodos. Análisis: Analítica y Señales y escenarios. Y al final, Administración: Migraciones, Auditoría, Plan y ' +
    'Configuración. Se puede buscar cualquier pantalla con Ctrl+K. Lo que se ve depende del rol de la persona y del plan de ' +
    'la empresa: una pantalla que no aparece puede no estar incluida en su plan o en sus permisos.',
  'cargar-un-tercero':
    'Los clientes y proveedores se cargan en la pantalla Clientes y proveedores. Hacen falta: la razón social (o el nombre), el tipo y ' +
    'el número de documento, y al menos un rol (cliente, proveedor, etc.). Si el documento es un CUIT o CUIL, NEXO verifica ' +
    'que esté bien construido (dígito verificador); eso no prueba que la persona exista ni que esté activa en ARCA. Si no ' +
    'se conoce el documento se puede cargar como "sin identificar", sin número. NEXO no permite dos terceros con el mismo ' +
    'documento en una empresa. Si hay dato de contacto (correo, teléfono, domicilio) y días de pago acordados, se pueden ' +
    'cargar también, pero no son obligatorios.',
  'que-se-puede-preguntar':
    'En Preguntar se consultan cifras de la empresa (por ejemplo ventas, cobranzas, deudas, caja o stock, según el plan y ' +
    'los permisos). Cada respuesta trae de dónde salió el número y qué no incluye. El catálogo de preguntas es cerrado ' +
    'a propósito: lo que no está en la lista no se contesta con una aproximación. No se contestan proyecciones, impuestos ' +
    'a pagar a futuro, retenciones ni consejos sobre qué conviene hacer: eso es asesoramiento del contador.',
  'alcance-del-asistente':
    'El asistente puede contestar consultas con los datos registrados, buscar terceros, explicar cómo se hace algo y armar ' +
    'la propuesta de alta de un cliente o proveedor. No guarda nada por sí solo: toda carga la confirma la persona con un ' +
    'botón. No calcula, no proyecta, no da consejo fiscal ni cita normas de memoria. Sus respuestas las redacta un modelo ' +
    'de lenguaje, y las cifras se verifican contra lo que devolvió el sistema antes de mostrarse.',
};

function ayudaDeNexo(): HerramientaDeChat {
  const temas = Object.keys(AYUDA);
  const entrada = z.object({ tema: z.enum(temas as [string, ...string[]]) }).strict();
  return {
    nombre: 'ayuda_de_nexo',
    descripcion:
      'Devuelve una explicación escrita de cómo se usa NEXO. Temas: ' +
      'donde-esta-cada-cosa (el menú), cargar-un-tercero (qué datos hacen falta), que-se-puede-preguntar (el catálogo de ' +
      'consultas y sus límites), alcance-del-asistente (qué hace y qué no). Si el tema que necesitás no está, decí que no ' +
      'tenés esa explicación en vez de inventar un procedimiento.',
    esquema: {
      type: 'object',
      properties: { tema: { type: 'string', enum: temas } },
      required: ['tema'],
      additionalProperties: false,
    },
    ejecutar: async (crudo) => {
      const e = entrada.safeParse(crudo);
      if (!e.success) return fallo(mensajeDe(e.error));
      return ok({ tema: e.data.tema, explicacion: AYUDA[e.data.tema] });
    },
  };
}

// ---------------------------------------------------------------------------------------------------------------------
// proponer_alta_de_tercero
// ---------------------------------------------------------------------------------------------------------------------

const alta = z
  .object({
    tipoDocumento: z.enum(TIPOS_DOCUMENTO).default('CUIT'),
    numeroDocumento: z.string().max(40).nullish(),
    razonSocial: z.string().trim().min(1).max(200),
    roles: z.array(z.enum(ROLES)).min(1),
    nombreFantasia: z.string().max(200).nullish(),
    condicionIva: z.enum(CONDICIONES_IVA).optional(),
    email: z.string().email().max(200).nullish(),
    telefono: z.string().max(60).nullish(),
    domicilio: z.string().max(300).nullish(),
    localidad: z.string().max(120).nullish(),
    provincia: z.string().max(120).nullish(),
    diasDePago: z.number().int().min(0).max(3650).nullish(),
  })
  .strict();

function proponerAltaDeTercero(ctx: ContextoDeHerramientas): HerramientaDeChat | null {
  if (!ctx.permisos.has('party:write')) return null;

  return {
    nombre: 'proponer_alta_de_tercero',
    descripcion:
      'Arma la propuesta de alta de un cliente o proveedor. NO lo guarda: la persona ve la propuesta y la confirma con un ' +
      'botón. Antes de usarla tenés que tener los datos que la persona te dio; no inventes ninguno. Si el documento es ' +
      'CUIT o CUIL se verifica; si ya existe un tercero con ese documento, te lo informa y no hay propuesta. Después de ' +
      'llamarla, decile a la persona que revise y confirme: todavía no se guardó nada.',
    esquema: {
      type: 'object',
      properties: {
        razonSocial: { type: 'string', description: 'Razón social o nombre y apellido.' },
        tipoDocumento: { type: 'string', enum: [...TIPOS_DOCUMENTO], description: 'Por defecto CUIT.' },
        numeroDocumento: { type: 'string', description: 'Solo dígitos o con guiones; sin número si es SIN_IDENTIFICAR.' },
        roles: { type: 'array', items: { type: 'string', enum: [...ROLES] }, minItems: 1 },
        nombreFantasia: { type: 'string' },
        condicionIva: { type: 'string', enum: [...CONDICIONES_IVA] },
        email: { type: 'string' },
        telefono: { type: 'string' },
        domicilio: { type: 'string' },
        localidad: { type: 'string' },
        provincia: { type: 'string' },
        diasDePago: { type: 'integer', minimum: 0 },
      },
      required: ['razonSocial', 'roles'],
      additionalProperties: false,
    },
    ejecutar: async (crudo) => {
      const e = alta.safeParse(crudo);
      if (!e.success) return fallo(mensajeDe(e.error));
      const d = e.data;

      let numero: string | null = d.numeroDocumento === undefined || d.numeroDocumento === null || d.numeroDocumento.trim() === ''
        ? null
        : d.numeroDocumento.trim();

      if (d.tipoDocumento === 'SIN_IDENTIFICAR') {
        if (numero !== null) return fallo('Un tercero SIN_IDENTIFICAR no lleva número de documento.');
      } else if (numero === null) {
        return fallo('Falta el número de documento. Pedíselo a la persona; si no lo tiene, el tipo es SIN_IDENTIFICAR.');
      } else if (d.tipoDocumento === 'CUIT' || d.tipoDocumento === 'CUIL') {
        if (!isValidCuit(numero)) {
          return fallo(`El ${d.tipoDocumento} ${numero} no pasa la verificación (dígito verificador). Pedile a la persona que lo revise.`);
        }
        // Se guarda sólo con dígitos: así lo exige la tabla.
        numero = normalizeCuit(numero);
      } else if (d.tipoDocumento === 'DNI') {
        numero = numero.replace(/\D/gu, '');
        if (!/^\d{1,8}$/u.test(numero)) return fallo('Un DNI tiene hasta ocho dígitos.');
      }

      if (numero !== null) {
        const existente = await withCompany({ companyId: ctx.companyId, actorId: ctx.actorId }, async (tx) => {
          const r = await tx.query<{ id: string; razonSocial: string }>(
            `SELECT id, razon_social AS "razonSocial" FROM parties
              WHERE company_id = $1 AND tipo_documento = $2 AND numero_documento = $3`,
            [ctx.companyId, d.tipoDocumento, numero],
          );
          return r.rows[0];
        });
        if (existente !== undefined) {
          return ok({
            propuesta: false,
            motivo: 'YA_EXISTE',
            terceroExistente: existente,
            aviso: 'Ya hay un tercero con ese documento en esta empresa. No se arma ninguna propuesta de alta.',
          });
        }
      }

      // El cuerpo es EXACTAMENTE el de `POST /parties`: la consola lo envía tal cual cuando la persona confirma.
      const datos = {
        tipoDocumento: d.tipoDocumento,
        ...(numero === null ? {} : { numeroDocumento: numero }),
        razonSocial: d.razonSocial,
        roles: [...new Set(d.roles)],
        ...(d.nombreFantasia ? { nombreFantasia: d.nombreFantasia } : {}),
        ...(d.condicionIva ? { condicionIva: d.condicionIva } : {}),
        ...(d.email ? { email: d.email } : {}),
        ...(d.telefono ? { telefono: d.telefono } : {}),
        ...(d.domicilio ? { domicilio: d.domicilio } : {}),
        ...(d.localidad ? { localidad: d.localidad } : {}),
        ...(d.provincia ? { provincia: d.provincia } : {}),
        ...(d.diasDePago === undefined || d.diasDePago === null ? {} : { diasDePago: d.diasDePago }),
      };

      return {
        contenido: JSON.stringify({
          propuesta: true,
          estado: 'PENDIENTE_DE_CONFIRMACION',
          datos,
          aviso: 'Todavía NO se guardó nada. La persona tiene que revisar los datos y confirmar con el botón.',
        }),
        datos: { propuesta: true },
        propuesta: { tipo: 'ALTA_DE_TERCERO', ruta: '/parties', metodo: 'POST', datos },
      };
    },
  };
}

// ---------------------------------------------------------------------------------------------------------------------

/** Las herramientas que ESTA persona tiene en ESTA empresa. El resto no existe para el modelo. */
export function armarHerramientas(ctx: ContextoDeHerramientas): HerramientaDeChat[] {
  return [preguntarAlSistema(ctx), buscarTerceros(ctx), ayudaDeNexo(), proponerAltaDeTercero(ctx)].filter(
    (h): h is HerramientaDeChat => h !== null,
  );
}
