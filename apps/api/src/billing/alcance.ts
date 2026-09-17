/**
 * Hasta dónde llega una corrida del ciclo.
 *
 * ## El ciclo es global, y eso es lo correcto
 *
 * Ninguna de las tres fases —vencer pruebas, emitir, avanzar la cobranza—
 * recibe una empresa. Recorren **toda la instalación**, y tiene que ser así:
 * una facturación que hay que acordarse de correr por cliente no se corre, y el
 * día que se olvide una nadie se va a enterar hasta la conciliación del mes.
 *
 * En producción esta opción no se pasa nunca. `facturacion-ciclo.mjs` llama a
 * `correrCiclo(tx, fecha, actor)` y punto.
 *
 * ## Por qué existe, entonces
 *
 * Porque la suite corre **178 archivos en paralelo contra una sola base**, y
 * «global» ahí significa «también las filas de las otras suites». Medido el
 * 2026-09-17: una corrida de `test:coverage` falló con una violación de clave
 * foránea en `billing_periods` porque el ciclo de una suite emitió un período
 * para una suscripción que otra estaba borrando.
 *
 * No es una fragilidad de los tests: es lo que la función hace, ejercitado en
 * un entorno donde la base no es de nadie. Subir el timeout no lo arregla y
 * reintentar tampoco; lo único que lo arregla es que cada suite le diga al
 * ciclo hasta dónde llegar.
 *
 * ## Por qué por organización y no por empresa
 *
 * Porque es el borde que las pruebas ya tienen: `seed()` crea **una
 * organización por suite** y todas sus empresas cuelgan de ella. Un solo valor
 * por archivo alcanza para aislarlo entero, mientras que por empresa habría que
 * acertarle en cada una de las veintiséis llamadas.
 *
 * Es además el borde que el producto reconoce: un estudio contable con sus
 * empresas clientes es exactamente una organización.
 *
 * ## Por qué vive en su propio archivo
 *
 * Lo necesitan `ciclo.ts` y `prueba.ts`, y `ciclo` ya importa `prueba`.
 * Declararlo en cualquiera de los dos cerraría un ciclo de imports que
 * `lint:arch` rechaza — y con razón.
 */

/** Hasta dónde llega una corrida. Sin opciones, hasta el final. */
export interface OpcionesDelCiclo {
  /** Solo las empresas de esta organización. Sin esto, todas. */
  readonly soloOrganizacion?: string;
}

/**
 * El filtro, escrito una vez.
 *
 * Devuelve el fragmento de `WHERE` y el valor, para que las tres fases lo
 * apliquen igual. Con tres copias a mano, la que quede distinta va a filtrar de
 * más o de menos y el síntoma va a aparecer en otra suite.
 *
 * `posicion` es el número de parámetro que le toca en la consulta que lo usa.
 * Se pasa en vez de asumir `$2` porque las tres consultas tienen distinta
 * cantidad de parámetros antes de este.
 *
 * La subconsulta contra `companies` y no un `JOIN`: las tres consultas ya
 * tienen su `FROM`, y agregarle una tabla a cada una cambiaría el `GROUP BY` de
 * la de cobranza. Con `IN` el fragmento es el mismo en las tres.
 */
export function filtroDeOrganizacion(
  opciones: OpcionesDelCiclo,
  posicion: number,
): { readonly sql: string; readonly valor: string | null } {
  return {
    sql:
      `AND ($${posicion}::uuid IS NULL OR company_id IN ` +
      `(SELECT id FROM companies WHERE organization_id = $${posicion}::uuid))`,
    valor: opciones.soloOrganizacion ?? null,
  };
}
