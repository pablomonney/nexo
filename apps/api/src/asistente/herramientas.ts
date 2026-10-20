/**
 * Las herramientas del asistente: lo único que el modelo puede hacer además de hablar.
 *
 * ## Qué son y qué no son
 *
 * Cada herramienta es un envoltorio fino sobre algo que el sistema ya tiene, con los permisos de **la persona que escribe**
 * (no los del asistente: el asistente no tiene permisos propios). Si la persona no puede ver los terceros, el asistente no
 * recibe la herramienta que los busca; no es un 403 que el modelo tenga que interpretar.
 *
 *   preguntar_al_sistema    el catálogo cerrado de preguntas (`intelligence/catalogo.ts`). Es la ÚNICA fuente de cifras. Con `empresa`
 *                           contesta sobre otra empresa del estudio.
 *   empresas_del_estudio    las empresas del estudio a las que esta persona puede llegar con el asistente (ver `estudio.ts`).
 *   preguntar_a_todas_las_empresas  la misma pregunta en cada empresa, con el total consolidado calculado por el sistema.
 *   buscar_terceros         lectura del maestro de terceros (de esta empresa, o de otra del estudio).
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
  CATALOGO,
  formatearRespuesta,
  hoyDeLaBase,
  mesCorrienteDe,
  preguntasDelPlan,
  preguntasPara,
  type PreguntaDelCatalogo,
} from '../intelligence/catalogo.js';
import { consolidar } from './consolidar.js';
import { accesoDelEstudio, resolverEmpresa, type AccesoDelEstudio, type EmpresaAccesible } from './estudio.js';

export interface ContextoDeHerramientas {
  readonly companyId: string;
  /** `user:<id>`: la persona que escribe. */
  readonly actorId: string;
  readonly permisos: ReadonlySet<string>;
  /**
   * Para llegar a otras empresas del estudio hace falta saber quién es la persona (sus permisos valen empresa por empresa) y si tiene
   * segundo factor. Sin estos datos el asistente trabaja sólo sobre la empresa actual.
   */
  readonly usuarioId?: string;
  readonly mfaActivado?: boolean;
  /** Los módulos que tiene contratados esta empresa (`null`/ausente = sin restricción de plan). */
  readonly funcionalidades?: ReadonlySet<string> | null;
}

/** Las preguntas que ofrece una empresa: por lo que PUEDE la persona y por lo que CONTRATÓ la empresa. */
const preguntasDe = (permisos: ReadonlySet<string>, funcionalidades: ReadonlySet<string> | null | undefined): PreguntaDelCatalogo[] =>
  preguntasDelPlan(preguntasPara(permisos), funcionalidades ?? null);

/** El contexto con la lista de empresas del estudio ya resuelta (una vez por turno). */
interface ContextoInterno extends ContextoDeHerramientas {
  readonly estudio: () => Promise<AccesoDelEstudio>;
}

/** Las empresas a las que se puede llegar. Con la actual siempre, aunque no se pueda resolver el estudio. */
async function empresasDe(ctx: ContextoInterno): Promise<readonly EmpresaAccesible[]> {
  const acceso = await ctx.estudio();
  if (acceso.empresas.some((e) => e.id === ctx.companyId)) return acceso.empresas;
  return [{ id: ctx.companyId, razonSocial: 'Esta empresa', cuit: '', permisos: ctx.permisos, funcionalidades: ctx.funcionalidades ?? null }, ...acceso.empresas];
}

/** Una empresa destino: la actual si no se indica otra. */
async function destino(ctx: ContextoInterno, referencia: string | undefined): Promise<{ empresa: EmpresaAccesible } | { error: string }> {
  const todas = await empresasDe(ctx);
  if (referencia === undefined || referencia.trim() === '') return { empresa: todas.find((e) => e.id === ctx.companyId)! };
  return resolverEmpresa(todas, referencia);
}

const ESQUEMA_EMPRESA = {
  type: 'string',
  description:
    'Opcional. Otra empresa del estudio sobre la que contestar (razón social, parte de ella, CUIT o id, como figura en ' +
    'empresas_del_estudio). Si se omite, la empresa en la que está la persona.',
} as const;

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

function preguntarAlSistema(ctx: ContextoInterno): HerramientaDeChat | null {
  const disponibles = preguntasDe(ctx.permisos, ctx.funcionalidades);
  if (disponibles.length === 0) return null;

  const entrada = z.object({ preguntaId: z.string().max(60), mes: z.string().regex(MES).optional(), empresa: z.string().max(200).optional() }).strict();

  return {
    nombre: 'preguntar_al_sistema',
    descripcion:
      'Una cifra o estado de la empresa. Es la ÚNICA fuente de números. Elegí el id; si ninguno encaja, decí que eso no se ' +
      'puede consultar. (m) = admite mes.\n' +
      disponibles
        .map((p) => `${p.id}: ${p.pregunta}${p.admiteMes ? ' (m)' : ''}`)
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
        empresa: ESQUEMA_EMPRESA,
      },
      required: ['preguntaId'],
      additionalProperties: false,
    },
    ejecutar: async (crudo) => {
      const e = entrada.safeParse(crudo);
      if (!e.success) return fallo(mensajeDe(e.error));
      const d = await destino(ctx, e.data.empresa);
      if ('error' in d) return fallo(d.error);
      // Las preguntas de ESA empresa: lo que la persona puede ahí, no lo que puede en la que está.
      const deEsa = preguntasDe(d.empresa.permisos, d.empresa.funcionalidades);
      const pregunta = deEsa.find((p) => p.id === e.data.preguntaId);
      if (pregunta === undefined) {
        return fallo(
          `La pregunta "${e.data.preguntaId}" no está disponible${d.empresa.id === ctx.companyId ? '' : ` en ${d.empresa.razonSocial}`}. Ids posibles: ${deEsa.map((p) => p.id).join(', ')}.`,
        );
      }
      const respuesta = await withCompany({ companyId: d.empresa.id, actorId: ctx.actorId }, async (tx) => {
        const hoy = await hoyDeLaBase(tx);
        const mes = pregunta.admiteMes ? (e.data.mes ?? mesCorrienteDe(hoy)) : mesCorrienteDe(hoy);
        return pregunta.responder(tx, d.empresa.id, mes);
      });
      return ok({
        ...(d.empresa.id === ctx.companyId ? {} : { empresa: d.empresa.razonSocial }),
        preguntaId: pregunta.id,
        pregunta: pregunta.pregunta,
        ...formatearRespuesta(respuesta),
      });
    },
  };
}

// ---------------------------------------------------------------------------------------------------------------------
// buscar_terceros
// ---------------------------------------------------------------------------------------------------------------------

const MAX_TERCEROS = 8;

/** Cuántos renglones de detalle trae cada empresa en una consulta a todas. */
const DETALLE_POR_EMPRESA = 5;

function buscarTerceros(ctx: ContextoInterno): HerramientaDeChat | null {
  if (!ctx.permisos.has('party:read')) return null;
  const entrada = z.object({ texto: z.string().trim().min(2).max(120), empresa: z.string().max(200).optional() }).strict();

  return {
    nombre: 'buscar_terceros',
    descripcion:
      'Busca clientes, proveedores y demás terceros ya cargados, por nombre o por el comienzo del número de documento. ' +
      `Devuelve hasta ${String(MAX_TERCEROS)}. Úsala antes de proponer un alta, para no duplicar.`,
    esquema: {
      type: 'object',
      properties: { texto: { type: 'string', description: 'Parte del nombre o el comienzo del documento.' }, empresa: ESQUEMA_EMPRESA },
      required: ['texto'],
      additionalProperties: false,
    },
    ejecutar: async (crudo) => {
      const e = entrada.safeParse(crudo);
      if (!e.success) return fallo(mensajeDe(e.error));
      const d = await destino(ctx, e.data.empresa);
      if ('error' in d) return fallo(d.error);
      if (!d.empresa.permisos.has('party:read')) return fallo(`Esta persona no puede ver los terceros de ${d.empresa.razonSocial}.`);
      const empresaId = d.empresa.id;
      const filas = await withCompany({ companyId: empresaId, actorId: ctx.actorId }, async (tx) => {
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
          [empresaId, e.data.texto, MAX_TERCEROS + 1],
        );
        return r.rows;
      });
      const hayMas = filas.length > MAX_TERCEROS;
      return ok({ ...(empresaId === ctx.companyId ? {} : { empresa: d.empresa.razonSocial }), terceros: filas.slice(0, MAX_TERCEROS), hayMas, ...(hayMas ? { aviso: 'Hay más resultados: afiná la búsqueda.' } : {}) });
    },
  };
}

// ---------------------------------------------------------------------------------------------------------------------
// empresas_del_estudio
// ---------------------------------------------------------------------------------------------------------------------

function empresasDelEstudio(ctx: ContextoInterno): HerramientaDeChat | null {
  if (ctx.usuarioId === undefined) return null;
  return {
    nombre: 'empresas_del_estudio',
    descripcion:
      'Lista las empresas del estudio sobre las que podés contestar: las que esta persona lleva y donde el asistente está encendido. ' +
      'Usala cuando la persona nombre otra empresa, pregunte por "todas mis empresas" o por un cliente del estudio. Para ' +
      'consultar otra empresa pasá su nombre en el parámetro "empresa" de preguntar_al_sistema.',
    esquema: { type: 'object', properties: {}, additionalProperties: false },
    ejecutar: async () => {
      const acceso = await ctx.estudio();
      const lista = await empresasDe(ctx);
      return ok({
        empresaActual: lista.find((e) => e.id === ctx.companyId)?.razonSocial ?? null,
        empresas: lista.map((e) => ({
          razonSocial: e.razonSocial,
          cuit: e.cuit,
          esLaActual: e.id === ctx.companyId,
          preguntasDisponibles: preguntasDe(e.permisos, e.funcionalidades).length,
        })),
        ...(acceso.hayMas ? { aviso: `El estudio tiene más empresas; se listan las primeras ${String(lista.length)}.` } : {}),
        ...(acceso.sinAsistente > 0
          ? { sinAsistente: `${String(acceso.sinAsistente)} empresa(s) del estudio no están disponibles para el asistente (está apagado, el plan no lo incluye o esta persona no tiene acceso).` }
          : {}),
      });
    },
  };
}

// ---------------------------------------------------------------------------------------------------------------------
// preguntar_a_todas_las_empresas
// ---------------------------------------------------------------------------------------------------------------------

function preguntarATodasLasEmpresas(ctx: ContextoInterno): HerramientaDeChat | null {
  if (ctx.usuarioId === undefined) return null;
  const disponibles = preguntasDe(ctx.permisos, ctx.funcionalidades);
  if (disponibles.length === 0) return null;
  const entrada = z.object({ preguntaId: z.string().max(60), mes: z.string().regex(MES).optional() }).strict();

  return {
    nombre: 'preguntar_a_todas_las_empresas',
    descripcion:
      'La misma pregunta en TODAS las empresas del estudio a las que esta persona puede llegar: trae cada respuesta (con sus primeros ' +
      'renglones de detalle) y el TOTAL CONSOLIDADO ya calculado cuando la unidad es la misma. Para "en total", "entre todas", "qué ' +
      'empresa…". No sumes vos. Mismos ids que preguntar_al_sistema.',
    esquema: {
      type: 'object',
      properties: {
        preguntaId: { type: 'string', description: 'El id de la pregunta.' },
        mes: { type: 'string', pattern: '^\\d{4}-(0[1-9]|1[0-2])$', description: 'AAAA-MM; si se omite, el corriente.' },
      },
      required: ['preguntaId'],
      additionalProperties: false,
    },
    ejecutar: async (crudo) => {
      const e = entrada.safeParse(crudo);
      if (!e.success) return fallo(mensajeDe(e.error));
      if (!CATALOGO.some((p) => p.id === e.data.preguntaId)) {
        return fallo(`La pregunta "${e.data.preguntaId}" no existe. Usá los ids de preguntar_al_sistema.`);
      }
      const acceso = await ctx.estudio();
      const empresas = await empresasDe(ctx);

      const filas: Array<{
        empresa: string; cuit: string; valor: string | null; unidad: string; periodo: string | null; noIncluye: string | null;
        detalle: Array<{ etiqueta: string; valor: string }>;
      }> = [];
      const sinEstaPregunta: string[] = [];
      let titulo = '';
      for (const emp of empresas) {
        const pregunta: PreguntaDelCatalogo | undefined = preguntasDe(emp.permisos, emp.funcionalidades).find((p) => p.id === e.data.preguntaId);
        if (pregunta === undefined) { sinEstaPregunta.push(emp.razonSocial); continue; }
        const r = await withCompany({ companyId: emp.id, actorId: ctx.actorId }, async (tx) => {
          const hoy = await hoyDeLaBase(tx);
          const mes = pregunta.admiteMes ? (e.data.mes ?? mesCorrienteDe(hoy)) : mesCorrienteDe(hoy);
          return pregunta.responder(tx, emp.id, mes);
        });
        titulo = r.titulo;
        filas.push({
          empresa: emp.razonSocial, cuit: emp.cuit, valor: r.valor, unidad: r.unidad, periodo: r.periodo, noIncluye: r.noIncluye,
          // Los primeros renglones, para poder contestar «cuál es la que más…» y «a quién»: sin ellos el modelo sólo ve el total de cada una.
          detalle: r.datos.slice(0, DETALLE_POR_EMPRESA).map((d) => ({ etiqueta: d.etiqueta, valor: d.valor })),
        });
      }
      if (filas.length === 0) return fallo('Ninguna empresa puede contestar esa pregunta con los permisos de esta persona.');

      const { consolidado, motivoSinTotal } = consolidar(filas);

      return ok({
        preguntaId: e.data.preguntaId,
        titulo,
        empresas: filas,
        totalConsolidado: consolidado,
        ...(motivoSinTotal === null ? {} : { motivoSinTotal }),
        ...(sinEstaPregunta.length === 0 ? {} : { sinPermisoParaEstaPregunta: sinEstaPregunta }),
        ...(acceso.hayMas ? { aviso: 'El estudio tiene más empresas de las que se miran en una consulta: el total NO las incluye.' } : {}),
      });
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
export const AYUDA: Readonly<Record<string, string>> = {
  'donde-esta-cada-cosa':
    'El menú de la izquierda agrupa las pantallas por tarea, de lo más usado a lo menos usado. General: Inicio (resumen), ' +
    'Pendientes (lo que espera una decisión), Propuestas de IA, Asistente y Consultas (preguntas al sistema). Ventas: ' +
    'Presupuestos y pedidos, Facturas y comprobantes, Clientes y proveedores, Productos, Precios, CRM y Comisiones. Compras: ' +
    'Documentos, Pedidos de compra, Recepciones y Órdenes de pago. Tesorería: Caja, Bancos y Cheques. Inventario y operaciones: Stock, ' +
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
    'En General › Consultas se preguntan cifras de la empresa (por ejemplo ventas, cobranzas, deudas, caja o stock, según el plan y ' +
    'los permisos). Cada respuesta trae de dónde salió el número y qué no incluye. El catálogo de preguntas es cerrado ' +
    'a propósito: lo que no está en la lista no se contesta con una aproximación. No se contestan proyecciones, impuestos ' +
    'a pagar a futuro, retenciones ni consejos sobre qué conviene hacer: eso es asesoramiento del contador.',
  'alcance-del-asistente':
    'El asistente puede contestar consultas con los datos registrados, buscar terceros, explicar cómo se hace algo y armar ' +
    'la propuesta de alta de un cliente o proveedor. No guarda nada por sí solo: toda carga la confirma la persona con un ' +
    'botón. No calcula, no proyecta, no da consejo fiscal ni cita normas de memoria. Sus respuestas las redacta un modelo ' +
    'de lenguaje, y las cifras se verifican contra lo que devolvió el sistema antes de mostrarse.',
  // Los procedimientos: cada uno nombra la pantalla como figura en el menú («Grupo › Pantalla») y los botones como se llaman. Salen de las guías
  // de la consola (GUIAS en consola.html); un test comprueba que cada «Grupo › Pantalla» de acá exista en el menú.
  'cargar-una-factura-de-compra':
    'Compras › Documentos. Se sube el archivo: los XML de ARCA se leen solos; un PDF o una foto queda archivado y los datos se cargan a mano o con ' +
    'ayuda del asistente. Se abre desde la lista, se revisa «Lo que se leyó» (el sistema nunca da por bueno un dato dudoso) y, si algo está mal, se ' +
    'usa «Corregir un campo» con su motivo. Cuando está bien, «Registrar el comprobante» lo carga como factura o nota. Si el proveedor no está ' +
    'cargado, primero se da de alta en Ventas › Clientes y proveedores.',
  'hacer-un-presupuesto-o-una-venta':
    'Ventas › Presupuestos y pedidos. «Nuevo presupuesto o pedido»: se elige si es venta o compra, el tipo y el cliente o proveedor, y «Crear en ' +
    'borrador». Se abre desde la lista y en «Cargar el detalle» se suman los productos con cantidad y precio («Traer el precio» lo busca en la lista ' +
    'de precios); «Guardar el detalle». Cuando el cliente acepta, se completa «Facturar» y «Registrar la operación fiscal». Esto registra la ' +
    'operación en NEXO: todavía no emite la factura electrónica con CAE.',
  'conciliar-el-banco':
    'Tesorería › Bancos. Se da de alta la cuenta bancaria con su cuenta contable; se crea un «mapeo» que le explica al sistema qué columna del archivo ' +
    'del banco es cada cosa; se pega el contenido del extracto y «Importar». Después se pide la «Propuesta de conciliación» y se confirma una por ' +
    'una: no existe «aceptar todas», porque la norma exige intervención humana.',
  'cargar-un-cheque':
    'Tesorería › Cheques. Se carga el cheque (tipo, banco, número, importe y fechas) y queda en la cartera. Después se registra qué le pasó: se ' +
    'depositó, se endosó, lo rechazaron. El estado sale del último movimiento; no se elige.',
  'usar-la-caja':
    'Tesorería › Caja. La primera vez se da de alta una caja (código, nombre y cuenta contable). Se abre con el saldo inicial, se registra cada ' +
    'ingreso y egreso con su concepto y, al cerrar, se ingresa lo contado; si no coincide, se explica por qué. Arquear no genera asientos.',
  'pagar-a-un-proveedor':
    'Compras › Órdenes de pago. Se elige el proveedor y «Ver qué se le debe»; se marcan los comprobantes a pagar y «Armar el borrador»; se abre la ' +
    'orden y «Aprobar» (la aprueba otra persona de quien la armó); cuando se hace el pago, «Registrar el pago». La orden no mueve fondos: el dinero ' +
    'sale con el asiento.',
  'pedir-una-compra':
    'Compras › Pedidos de compra. Se indica para cuándo se necesita y para qué, se agregan los renglones (producto o descripción y cantidad) y «Crear ' +
    'la solicitud». Se abre desde la lista y «Enviar a aprobar»; quien aprueba la aprueba o la rechaza, y si se aprueba se cita la orden de compra. ' +
    'Pedir no es comprar: no lleva precios.',
  'registrar-una-recepcion':
    'Compras › Recepciones. Se elige el proveedor y, si la hay, la orden de compra; se carga el remito y «Crear en borrador»; en «Cargar lo que ' +
    'llegó» se agrega cada producto con su cantidad y «Guardar». Cuando coincide con lo que llegó, se confirma desde la lista.',
  'mover-el-stock':
    'Inventario y operaciones › Stock. La primera vez se da de alta el depósito. Cada entrada, salida o transferencia se registra en «Registrar un ' +
    'movimiento»; «Ver existencias» muestra cuánto hay. De tanto en tanto se hace un recuento físico: se cuenta y el sistema ajusta las diferencias. ' +
    'La cantidad se calcula de los movimientos: nunca se pisa.',
  'registrar-un-asiento':
    'Contabilidad › Asientos. En «Cargar un asiento» se completa libro, fecha, cuenta al Debe, cuenta al Haber e importe y «Registrar»: queda en ' +
    'borrador y no toca el Mayor hasta que alguien lo aprueba. Un asiento aprobado no se edita: se anula con otro asiento (contraasiento) y el ' +
    'número se conserva.',
  'ver-los-libros-y-el-iva':
    'Contabilidad › Libros muestra el Diario, el Mayor y el balance de sumas y saldos por rango de fechas, con descarga en CSV; emitir un libro le ' +
    'calcula una huella y deja constancia, y es un acto del profesional. Contabilidad › IVA arma el Libro IVA Digital y los subdiarios del mes: se ' +
    'elige año y mes, «Ver el período», y el sistema dice qué lo bloquea antes de poder generarlo.',
  'cerrar-un-periodo':
    'Contabilidad › Cierre de períodos. Primero se abre el ejercicio («Abrir el ejercicio»: se crean sus períodos). Cada período pasa de abierto a ' +
    'bloqueado y a cerrado, sin saltear pasos. Reabrir uno cerrado exige un motivo y la firma de otra persona.',
  'traer-datos-de-otro-sistema':
    'Administración › Migraciones. Se elige de qué sistema viene y «Crear»; se sube el archivo exportado; se le dice al sistema qué es cada columna ' +
    '(«Guardar la correspondencia»); «Validar» muestra qué entraría y qué se rechaza sin escribir nada; si está todo bien, «Importar». Después se ' +
    'puede ver el reporte o revertir todo.',
  'dar-un-puesto-a-una-persona':
    'Administración › Configuración › «Dar un puesto». Cada puesto trae sus módulos: la persona ve en el menú sólo lo que le toca, y los puestos se ' +
    'suman. Hay puestos predeterminados para los trabajos más comunes (vendedor, tesorero, comprador, depósito, gerente…). El dueño del estudio ' +
    'puede además armar puestos propios y agregar o quitar funciones a una persona puntual, siempre con un motivo; las funciones de firmar la ' +
    'contabilidad y administrar el sistema siguen siendo de los roles Contador y Administrador.',
  'mi-plan-y-mis-limites':
    'Administración › Plan. Muestra el plan de la empresa, cuánto se usó contra los topes y cómo pagar. Exceder un tope no bloquea nada: sólo ' +
    'avisa. Los comprobantes, los documentos y las integraciones son ilimitados en todos los planes. La inteligencia artificial tiene un tope ' +
    'diario de tokens que es del contrato: se comparte entre todas las empresas del estudio.',
  'exportar-los-datos-de-la-empresa':
    'Administración › Configuración › «Exportar la empresa». Genera un archivo ZIP con todo lo de la empresa (asientos, maestros, lo migrado y los ' +
    'documentos) y un manifiesto con la huella de cada archivo para comprobar que está completo. No incluye claves privadas ni contraseñas. Queda ' +
    'registrado quién lo pidió y por qué.',
};

function ayudaDeNexo(): HerramientaDeChat {
  const temas = Object.keys(AYUDA);
  const entrada = z.object({ tema: z.enum(temas as [string, ...string[]]) }).strict();
  return {
    nombre: 'ayuda_de_nexo',
    descripcion:
      'Devuelve una explicación escrita de cómo se usa NEXO: dónde está cada pantalla y cómo se hace cada tarea. Temas: ' +
      temas.join(', ') +
      '. Si el tema que necesitás no está, decí que no tenés esa explicación en vez de inventar un procedimiento.',
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
      'Arma la propuesta de alta de un cliente o proveedor. NO lo guarda: la persona la confirma con un botón. Usá sólo datos que ' +
      'ella te dio. Verifica el CUIT/CUIL y avisa si ya existe. Después decile que revise y confirme: todavía no se guardó nada.',
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
export function armarHerramientas(base: ContextoDeHerramientas): HerramientaDeChat[] {
  // La lista de empresas se resuelve una vez por turno, la primera vez que alguna herramienta la necesita.
  let memo: Promise<AccesoDelEstudio> | null = null;
  const ctx: ContextoInterno = {
    ...base,
    estudio: () => {
      memo ??=
        base.usuarioId === undefined
          ? Promise.resolve({ empresas: [], hayMas: false, sinAsistente: 0 })
          : accesoDelEstudio({ companyId: base.companyId, usuarioId: base.usuarioId, mfaActivado: base.mfaActivado === true });
      return memo;
    },
  };
  return [
    preguntarAlSistema(ctx),
    preguntarATodasLasEmpresas(ctx),
    empresasDelEstudio(ctx),
    buscarTerceros(ctx),
    ayudaDeNexo(),
    proponerAltaDeTercero(ctx),
  ].filter((h): h is HerramientaDeChat => h !== null);
}
