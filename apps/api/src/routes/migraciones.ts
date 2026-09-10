/**
 * Migraciones: traer una empresa desde otro sistema.
 *
 * ## La regla del módulo
 *
 * **Nada se escribe en la empresa hasta que alguien lo confirma.** El archivo
 * se carga, se mapea, se valida y se muestra; recién `POST /migraciones/:id/importar`
 * toca `parties` o `products`. Es la misma forma que el Integration Hub le
 * impuso a los conectores y la ADR-001 a la IA, y por el mismo motivo: lo que
 * entra de afuera no decide la contabilidad de nadie.
 *
 * ## Tres permisos y no uno
 *
 * `migration:read` mira, `migration:write` prepara y `migration:import`
 * ejecuta. Separarlos permite que alguien arme la migración —que es el trabajo
 * largo— sin poder apretar el botón que escribe.
 */

import { withCompany } from '@aai/db';
import { ENTIDADES, FORMAS, registroPorDefecto } from '@aai/migration-engine';
import type { Entidad } from '@aai/migration-engine';
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { requireAuth, requireCompany, requirePermission } from '../http/context.js';
import { badRequest, notFound } from '../http/errors.js';
import {
  cancelar,
  cargarOrigen,
  crearMigracion,
  declararMapeo,
  importar,
  leerProgreso,
  reconciliarContabilidad,
  reconciliarStock,
  revertir,
  validarMigracion,
} from '../migracion/ciclo.js';
import {
  ENTIDADES_IMPORTABLES,
  MOTIVO_SIN_ESCRITOR,
  ORDEN_DE_IMPORTACION,
} from '../migracion/escritores.js';

const REGISTRO = registroPorDefecto();

/** Lo que se admite subir. Más grande que esto no entra en una transacción. */
const MAXIMO_BYTES = 25 * 1024 * 1024;

export async function migracionRoutes(app: FastifyInstance): Promise<void> {
  /**
   * El catálogo de fuentes, con su estado real.
   *
   * Se sirve desde el registro del motor: no hay una segunda lista en la base
   * ni en la consola. Es lo que impide que una pantalla prometa un adaptador
   * que el código no tiene.
   */
  app.get('/migraciones/fuentes', async (request) => {
    const tenant = await requireCompany(request);
    requirePermission(tenant, 'migration:read');

    return {
      fuentes: REGISTRO.todos().map((d) => ({
        codigo: d.codigo,
        nombre: d.nombre,
        medio: d.medio,
        estado: d.estado,
        formatos: d.capacidades.formatos,
        entidades: d.capacidades.entidades,
        queFalta: d.queFalta ?? null,
        sePuedeUsar: d.estado === 'IMPLEMENTADO',
      })),
      // La matriz del §29, derivada de las capacidades declaradas.
      matriz: REGISTRO.matriz(),
      entidades: ENTIDADES.map((e) => ({
        codigo: e,
        seImporta: ENTIDADES_IMPORTABLES.includes(e),
        motivo: ENTIDADES_IMPORTABLES.includes(e) ? null : (MOTIVO_SIN_ESCRITOR[e] ?? null),
        // Los campos que admite cada entidad, servidos desde el modelo canónico.
        //
        // La consola los tenía copiados en una constante propia y ya habían
        // divergido: decía `padre` donde el modelo dice `codigoPadre`, y `cuit`
        // donde para una venta dice `cuitCliente`. El resultado era un selector
        // que ofrecía campos que el importador ignoraba en silencio. Una sola
        // fuente, y la pantalla la lee.
        obligatorios: FORMAS[e].obligatorios,
        opcionales: FORMAS[e].opcionales,
      })),
      // El orden en que se importan, para que la pantalla lo pueda mostrar: no
      // es una preferencia, es la dependencia entre entidades.
      orden: ORDEN_DE_IMPORTACION,
      alcance:
        'Un formato soportado no es un sistema soportado: NEXO lee un CSV exportado de ' +
        'cualquier sistema, y eso no quiere decir que conozca la estructura de ese sistema. ' +
        'Lo que dice «IMPLEMENTADO» trae datos hoy; lo demás dice qué le falta.',
    };
  });

  app.get('/migraciones', async (request) => {
    const tenant = await requireCompany(request);
    requirePermission(tenant, 'migration:read');

    return withCompany(
      { companyId: tenant.companyId, actorId: `user:${requireAuth(request).user.userId}` },
      async (tx) => {
        const { rows } = await tx.query(
          `SELECT m.id, m.adaptador, m.titulo, m.estado, m.estrategia, m.fecha_corte AS "fechaCorte",
                  m.archivo_nombre AS "archivo", m.creada_el AS "creadaEl",
                  m.importada_el AS "importadaEl", m.revertida_el AS "revertidaEl", m.error,
                  (SELECT count(*)::int FROM migration_rows r WHERE r.migration_id = m.id) AS filas,
                  (SELECT count(*)::int FROM migration_findings f
                    WHERE f.migration_id = m.id AND f.nivel = 'ERROR') AS errores
             FROM migrations m
            WHERE m.company_id = $1
            ORDER BY m.creada_el DESC
            LIMIT 100`,
          [tenant.companyId],
        );
        return { migraciones: rows };
      },
    );
  });

  app.get('/migraciones/:id', async (request) => {
    const tenant = await requireCompany(request);
    requirePermission(tenant, 'migration:read');
    const { id } = z.object({ id: z.string().uuid() }).parse(request.params);

    return withCompany(
      { companyId: tenant.companyId, actorId: `user:${requireAuth(request).user.userId}` },
      async (tx) => {
        const cabecera = await tx.query(
          `SELECT id, adaptador, titulo, estado, estrategia, fecha_corte AS "fechaCorte",
                  archivo_nombre AS "archivo", archivo_hash AS "hash", archivo_bytes AS "bytes",
                  creada_el AS "creadaEl", creada_por AS "creadaPor",
                  importada_el AS "importadaEl", revertida_el AS "revertidaEl", error
             FROM migrations WHERE id = $1`,
          [id],
        );
        if (cabecera.rows[0] === undefined) throw notFound('La migración no existe');

        const tablas = await tx.query(
          `SELECT id, nombre, columnas, entidad, mapeo, incluida, filas
             FROM migration_tables WHERE migration_id = $1 ORDER BY nombre`,
          [id],
        );
        const hallazgos = await tx.query(
          `SELECT nivel, codigo, mensaje, campo, fila
             FROM migration_findings WHERE migration_id = $1
            ORDER BY CASE nivel WHEN 'ERROR' THEN 1 WHEN 'ADVERTENCIA' THEN 2 ELSE 3 END
            LIMIT 500`,
          [id],
        );
        const resumen = await tx.query(
          `SELECT estado, count(*)::int n FROM migration_rows
            WHERE migration_id = $1 GROUP BY estado`,
          [id],
        );

        return {
          migracion: cabecera.rows[0],
          tablas: tablas.rows,
          hallazgos: hallazgos.rows,
          filasPorEstado: Object.fromEntries(resumen.rows.map((r) => [r.estado, r.n])),
        };
      },
    );
  });

  app.post('/migraciones', async (request, reply) => {
    const tenant = await requireCompany(request);
    requirePermission(tenant, 'migration:write');
    const auth = requireAuth(request);
    const body = z
      .object({
        adaptador: z.string().min(1).max(60),
        titulo: z.string().min(1).max(200),
        fechaCorte: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
        estrategia: z.enum(['HISTORICO_COMPLETO', 'APERTURA_Y_SELECTIVO', 'SOLO_SALDOS']).optional(),
      })
      .parse(request.body);

    const id = await withCompany(
      { companyId: tenant.companyId, actorId: `user:${auth.user.userId}` },
      (tx) =>
        crearMigracion(tx, tenant.companyId, `user:${auth.user.userId}`, {
          adaptador: body.adaptador,
          titulo: body.titulo,
          // `exactOptionalPropertyTypes` distingue "no vino" de "vino vacío", y
          // acá las dos cosas significan lo mismo: sin fecha de corte se trae
          // todo. Se colapsan en `null`, que es lo que guarda la columna.
          fechaCorte: body.fechaCorte ?? null,
          estrategia: body.estrategia ?? 'HISTORICO_COMPLETO',
        }),
    );

    reply.code(201);
    return { id, siguiente: 'Subí el archivo de origen para que NEXO lo analice.' };
  });

  /**
   * La carga del origen.
   *
   * El archivo se lee entero en memoria y se guarda fila por fila. Para
   * volúmenes mayores al tope haría falta procesarlo por tandas con puntos de
   * control; hoy no está, y el límite lo dice en vez de aceptar un archivo que
   * va a tumbar el proceso.
   */
  app.post('/migraciones/:id/origen', async (request) => {
    const tenant = await requireCompany(request);
    requirePermission(tenant, 'migration:write');
    const auth = requireAuth(request);
    const { id } = z.object({ id: z.string().uuid() }).parse(request.params);

    const archivo = await request.file({ limits: { fileSize: MAXIMO_BYTES } });
    if (archivo === undefined) throw badRequest('Falta el archivo de origen');

    const bytes = await archivo.toBuffer();
    if (archivo.file.truncated) {
      throw badRequest(
        `El archivo supera los ${Math.floor(MAXIMO_BYTES / 1024 / 1024)} MB. ` +
          'Partilo por entidad —clientes por un lado, productos por otro— y migrá de a uno.',
      );
    }

    return withCompany(
      { companyId: tenant.companyId, actorId: `user:${auth.user.userId}` },
      (tx) =>
        cargarOrigen(tx, tenant.companyId, `user:${auth.user.userId}`, id, {
          nombre: archivo.filename,
          bytes,
        }),
    );
  });

  app.post('/migraciones/:id/mapeo', async (request) => {
    const tenant = await requireCompany(request);
    requirePermission(tenant, 'migration:write');
    const auth = requireAuth(request);
    const { id } = z.object({ id: z.string().uuid() }).parse(request.params);
    const body = z
      .object({
        tablas: z
          .array(
            z.object({
              id: z.string().uuid(),
              entidad: z.enum(ENTIDADES).nullable(),
              mapeo: z.record(z.string().max(200), z.string().max(60)),
              incluida: z.boolean(),
            }),
          )
          .min(1),
      })
      .parse(request.body);

    await withCompany(
      { companyId: tenant.companyId, actorId: `user:${auth.user.userId}` },
      (tx) =>
        declararMapeo(
          tx,
          tenant.companyId,
          `user:${auth.user.userId}`,
          id,
          body.tablas as readonly {
            id: string;
            entidad: Entidad | null;
            mapeo: Record<string, string>;
            incluida: boolean;
          }[],
        ),
    );
    return { ok: true, siguiente: 'Validá la migración para ver qué entra y qué no.' };
  });

  /** Validar es también la vista previa: no toca un solo dato de la empresa. */
  app.post('/migraciones/:id/validar', async (request) => {
    const tenant = await requireCompany(request);
    requirePermission(tenant, 'migration:write');
    const auth = requireAuth(request);
    const { id } = z.object({ id: z.string().uuid() }).parse(request.params);

    const r = await withCompany(
      { companyId: tenant.companyId, actorId: `user:${auth.user.userId}` },
      (tx) => validarMigracion(tx, tenant.companyId, `user:${auth.user.userId}`, id),
    );

    return {
      ...r,
      alcance:
        r.errores > 0
          ? 'Con errores no se importa: se corrigen en el sistema de origen y se vuelve a subir.'
          : 'Nada de esto tocó la empresa todavía. La importación se confirma aparte.',
    };
  });

  /**
   * La importación, que ahora corre por tandas.
   *
   * No abre una transacción: la abre el importador, una por tanda. Es lo que
   * hace que el progreso se pueda consultar mientras corre y que una corrida
   * cortada se pueda reanudar. Volver a llamar a este mismo endpoint es
   * exactamente eso: reanudar.
   *
   * `topeDeTandas` existe para que un pedido HTTP no quede colgado media hora
   * con una migración de cien mil filas. La consola llama de nuevo hasta que el
   * estado deja de ser `IMPORTANDO`, mostrando el progreso entre llamada y
   * llamada.
   */
  app.post('/migraciones/:id/importar', async (request) => {
    const tenant = await requireCompany(request);
    // El permiso que escribe, separado del que prepara.
    requirePermission(tenant, 'migration:import');
    const auth = requireAuth(request);
    const { id } = z.object({ id: z.string().uuid() }).parse(request.params);
    const body = z
      .object({ topeDeTandas: z.number().int().min(1).max(10_000).optional() })
      .parse(request.body ?? {});

    const r = await importar(tenant.companyId, `user:${auth.user.userId}`, id, {
      ...(body.topeDeTandas === undefined ? {} : { topeDeTandas: body.topeDeTandas }),
    });

    return {
      ...r,
      // La consola lo lee para saber si tiene que volver a llamar.
      quedaTrabajo: r.estado === 'IMPORTANDO',
      alcance:
        r.estado === 'IMPORTANDO'
          ? 'Quedaron tandas sin correr. Volvé a llamar a importar para seguir desde donde quedó: ' +
            'lo ya escrito no se vuelve a escribir.'
          : r.cancelada
            ? 'Se canceló a pedido. Lo que alcanzó a entrar quedó en la empresa: cancelar no es ' +
              'revertir, y son dos botones distintos porque son dos decisiones distintas.'
            : 'Terminó. El reporte dice qué entró, qué ya estaba y qué no pudo entrar.',
    };
  });

  /**
   * Pide la cancelación.
   *
   * No corta nada de inmediato: el importador lo ve al terminar la tanda en
   * curso. Cortar a mitad de una tanda es lo que las tandas existen para evitar.
   */
  app.post('/migraciones/:id/cancelar', async (request) => {
    const tenant = await requireCompany(request);
    requirePermission(tenant, 'migration:import');
    const auth = requireAuth(request);
    const { id } = z.object({ id: z.string().uuid() }).parse(request.params);
    const body = z.object({ motivo: z.string().min(10).max(500) }).parse(request.body);

    const r = await withCompany(
      { companyId: tenant.companyId, actorId: `user:${auth.user.userId}` },
      (tx) => cancelar(tx, tenant.companyId, `user:${auth.user.userId}`, id, body.motivo),
    );

    return {
      ...r,
      alcance:
        'Queda pedida. La tanda que esté corriendo termina —cortarla a la mitad es lo que las ' +
        'tandas evitan— y ahí se detiene. Lo ya importado no se toca.',
    };
  });

  /** El progreso, para mirarlo mientras corre. */
  app.get('/migraciones/:id/progreso', async (request) => {
    const tenant = await requireCompany(request);
    requirePermission(tenant, 'migration:read');
    const auth = requireAuth(request);
    const { id } = z.object({ id: z.string().uuid() }).parse(request.params);

    return withCompany(
      { companyId: tenant.companyId, actorId: `user:${auth.user.userId}` },
      async (tx) => {
        const cabecera = await tx.query<{ estado: string }>(
          'SELECT estado FROM migrations WHERE id = $1',
          [id],
        );
        if (cabecera.rows[0] === undefined) throw notFound('La migración no existe');

        const progreso = await leerProgreso(tx, id);
        const tandas = await tx.query(
          `SELECT numero, estado, filas, importados, ya_estaban AS "yaEstaban",
                  rechazados, omitidos, intentos, error
             FROM migration_batches WHERE migration_id = $1
            ORDER BY numero LIMIT 200`,
          [id],
        );

        // El porcentaje se calcula acá y no en la pantalla: dos lugares que
        // dividen dan dos números distintos en cuanto uno redondea diferente.
        //
        // Y se calcula **con enteros**, en décimas de punto. No porque un
        // porcentaje de avance sea dinero, sino porque `Math.round(a / b * 1000) / 10`
        // es exactamente la forma de redondear un importe en coma flotante que
        // el resto del proyecto prohíbe, y un guardián que tiene que distinguir
        // cuándo esa expresión es inofensiva deja de ser un guardián.
        const decimas =
          progreso.total === 0 ? 0 : Math.floor((progreso.procesadas * 1000) / progreso.total);

        return {
          estado: cabecera.rows[0].estado,
          ...progreso,
          decimasDePorciento: decimas,
          porcentaje: `${Math.floor(decimas / 10)},${decimas % 10}`,
          tandasDetalle: tandas.rows,
        };
      },
    );
  });

  app.post('/migraciones/:id/revertir', async (request) => {
    const tenant = await requireCompany(request);
    requirePermission(tenant, 'migration:import');
    const auth = requireAuth(request);
    const { id } = z.object({ id: z.string().uuid() }).parse(request.params);
    // El motivo es obligatorio y la base lo vuelve a exigir: revertir deshace
    // escrituras en la empresa, y sin motivo nadie sabe después si fue un error
    // de datos o una decisión.
    const body = z.object({ motivo: z.string().min(10).max(500) }).parse(request.body);

    const r = await withCompany(
      { companyId: tenant.companyId, actorId: `user:${auth.user.userId}` },
      (tx) => revertir(tx, tenant.companyId, `user:${auth.user.userId}`, id, body.motivo),
    );

    return {
      ...r,
      alcance:
        'Lo que la migración creó quedó archivado, no borrado: un tercero puede tener ' +
        'movimientos colgando y borrarlo dejaría la reversión a medias. Lo que ya existía ' +
        'antes de migrar no se tocó.',
    };
  });

  /** El reporte del §31, consultable después. */
  app.get('/migraciones/:id/reporte', async (request) => {
    const tenant = await requireCompany(request);
    requirePermission(tenant, 'migration:read');
    const auth = requireAuth(request);
    const { id } = z.object({ id: z.string().uuid() }).parse(request.params);

    return withCompany(
      { companyId: tenant.companyId, actorId: `user:${auth.user.userId}` },
      async (tx) => {
        const m = await tx.query(
          `SELECT id, adaptador, titulo, estado, estrategia, fecha_corte AS "fechaCorte",
                  archivo_nombre AS "archivo", archivo_hash AS "hash",
                  creada_el AS "creadaEl", creada_por AS "creadaPor",
                  importada_el AS "importadaEl", revertida_el AS "revertidaEl"
             FROM migrations WHERE id = $1`,
          [id],
        );
        if (m.rows[0] === undefined) throw notFound('La migración no existe');

        const porEntidad = await tx.query(
          `SELECT t.entidad,
                  count(*)::int AS "enOrigen",
                  count(*) FILTER (WHERE r.estado = 'IMPORTADA')::int  AS importados,
                  count(*) FILTER (WHERE r.estado = 'YA_EXISTIA')::int AS "yaEstaban",
                  count(*) FILTER (WHERE r.estado = 'RECHAZADA')::int  AS rechazados,
                  count(*) FILTER (WHERE r.estado = 'OMITIDA')::int    AS omitidos
             FROM migration_rows r
             JOIN migration_tables t ON t.id = r.table_id
            WHERE r.migration_id = $1 AND t.incluida AND t.entidad IS NOT NULL
            GROUP BY t.entidad
            ORDER BY t.entidad`,
          [id],
        );

        const niveles = await tx.query(
          `SELECT nivel, count(*)::int n FROM migration_findings
            WHERE migration_id = $1 GROUP BY nivel`,
          [id],
        );

        const vinculos = await tx.query(
          `SELECT count(*)::int n, count(*) FILTER (WHERE creado)::int creados
             FROM migration_links WHERE migration_id = $1`,
          [id],
        );

        // La reconciliación: todo lo que trajo el origen tiene que haber
        // terminado en alguna parte. Lo que no, aparece como sin explicar.
        const reconciliacion = porEntidad.rows.map((e) => {
          const sinExplicar =
            e.enOrigen - (e.importados + e.yaEstaban + e.rechazados + e.omitidos);
          return { ...e, sinExplicar, cuadra: sinExplicar === 0 };
        });

        // Las dos reconciliaciones que miran **el resultado** y no el conteo.
        //
        // Que las filas cierren dice que ninguna se perdió por el camino. Que
        // el stock y el debe/haber coincidan dice que lo que quedó en NEXO es
        // lo que el sistema anterior afirmaba, que es la pregunta que importa.
        const stock = await reconciliarStock(tx, tenant.companyId, id);
        const contabilidad = await reconciliarContabilidad(tx, tenant.companyId, id);
        const progreso = await leerProgreso(tx, id);

        return {
          migracion: m.rows[0],
          reconciliacion,
          stock,
          contabilidad,
          progreso,
          cierra:
            reconciliacion.every((r) => r.cuadra) &&
            stock.every((s) => s.cuadra) &&
            contabilidad.every((c) => c.cuadra),
          hallazgos: Object.fromEntries(niveles.rows.map((r) => [r.nivel, r.n])),
          vinculos: vinculos.rows[0],
          alcance:
            'Los omitidos son filas de una entidad que NEXO todavía no sabe escribir: no las ' +
            'rechazó una regla de datos. Las rechazadas sí tienen un error que impide importarlas. ' +
            'La reconciliación de stock solo lista los productos cuya existencia el origen ' +
            'declaró: de los que no declaró no se puede afirmar que sobren ni que falten.',
        };
      },
    );
  });
}
