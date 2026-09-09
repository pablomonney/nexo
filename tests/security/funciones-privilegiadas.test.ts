/**
 * S-32 — Quién puede ejecutar una función que se saltea RLS.
 *
 * `SECURITY DEFINER` significa «corré con los privilegios de quien te creó».
 * Adentro de una de esas funciones **no hay RLS**: el `WHERE company_id = …`
 * que protege todas las tablas no participa. Son la única forma que tiene la
 * aplicación de tocar datos de una empresa que no es la suya, y por eso son la
 * superficie que hay que mirar cuando el aislamiento «ya está resuelto».
 *
 * ## Lo que encontró la auditoría determinística
 *
 * Nueve funciones `SECURITY DEFINER`, y tres que reciben una empresa y **no
 * comprueban al que llama**. Con el rol de la aplicación puesto y la empresa A
 * en contexto, apuntando a la B:
 *
 *     leer account_balances de B por SQL     → 0 filas   (RLS: bien)
 *     escribir stock_movement_ppp de B       → 42501     (0086: bien)
 *     rebuild_account_balances(B)            → 2 filas   ← pasó
 *     recalcular_ppp_de_producto(B, …)       → sin error ← pasó
 *     company_organization(B)                → devolvió  ← pasó
 *
 * Las dos primeras líneas son lo que hace válida a la medición: las defensas de
 * siempre funcionan, y aun así hay un camino que las rodea. `rebuild_…` y
 * `recalcular_…` **borran y rehacen** — no era una fuga de lectura, era escritura
 * destructiva sobre datos contables ajenos. Y `recalcular_ppp_de_producto` borra
 * justo la tabla que la 0086 había revocado a propósito para que no existiera
 * una segunda verdad sobre el costo.
 *
 * ## Por qué el primer arreglo no arregló nada
 *
 * La 0108 revocó `EXECUTE` a `aai_app` y las tres siguieron pasando. PostgreSQL
 * le da `EXECUTE` a **PUBLIC** sobre toda función nueva: `aai_app` la podía
 * ejecutar por ser parte de todos, y quitarle un permiso que no usaba no le
 * quitó el que sí usaba. La 0109 se lo sacó a PUBLIC.
 *
 * Es la misma forma de error que la 0097 («un GRANT no quita nada»), dada vuelta.
 * Por eso este control **no lee migraciones**: le pregunta al catálogo quién
 * puede ejecutar qué, que es lo único que después se cumple en producción.
 *
 * ## Qué se declara acá
 *
 * Las funciones privilegiadas que la aplicación **sí** puede ejecutar, con el
 * motivo por el que es seguro. Toda `SECURITY DEFINER` nueva nace ejecutable por
 * PUBLIC, así que la próxima que alguien escriba va a romper este test hasta que
 * la revoque o la declare — y declararla obliga a escribir por qué, que es el
 * momento en que se piensa.
 */

import { describe, expect, it } from 'vitest';
import { connect, hasDatabase, type Client } from '../integration/helpers/db.js';

const suite = hasDatabase ? describe : describe.skip;

/**
 * Las que la aplicación puede ejecutar, y la razón.
 *
 * La razón siempre tiene que ser la misma propiedad: **la función comprueba
 * quién la llama antes de actuar**. Si el motivo que escribís es «la necesita el
 * endpoint tal», la función no va en esta lista: va arreglada.
 */
const PERMITIDAS: Readonly<Record<string, string>> = {
  'create_organization(text,text,uuid)':
    'Crea un estudio nuevo con el actor de dueño; no recibe ningún estudio ajeno sobre el que actuar',
  'create_company(uuid,uuid,text,text,text,text,text,text)':
    'Exige que el actor tenga nivel en el estudio donde crea la empresa',
  'grant_company_role(uuid,uuid,uuid,text)':
    'Exige que el actor tenga nivel en el estudio de la empresa donde otorga el rol',
  'user_companies()':
    'No recibe parámetros: lee app.actor_id, así que no hay identificador ajeno que pasarle',
};

/**
 * Las que quedaron fuera, con el motivo — para que el que las necesite mañana
 * sepa qué le falta a la función, no cómo saltear el test.
 */
const NEGADAS: Readonly<Record<string, string>> = {
  'company_organization(uuid)': 'Contestaría por cualquier empresa; sin llamadores',
  'rebuild_account_balances(uuid)': 'Borra y rehace los saldos de la empresa que le pases',
  'recalcular_ppp_de_producto(uuid,uuid)': 'Borra y rehace el costo de la empresa que le pases',
  'project_ledger_movements()': 'De trigger: el EXECUTE no la dispara',
  'proyectar_ppp()': 'De trigger: el EXECUTE no la dispara',
};

interface Fila {
  readonly firma: string;
  readonly app: boolean;
  readonly publico: boolean;
}

const CONSULTA = `
  -- regprocedure imprime la firma con los tipos y sin los nombres de los
  -- parámetros: es la forma en que se identifica una función cuando hay varias
  -- con el mismo nombre, y la que hay que escribir en un REVOKE.
  SELECT p.oid::regprocedure::text AS firma,
         has_function_privilege('aai_app', p.oid, 'EXECUTE') AS app,
         has_function_privilege('public',  p.oid, 'EXECUTE') AS publico
    FROM pg_proc p
    JOIN pg_namespace n ON n.oid = p.pronamespace
   WHERE p.prosecdef
     AND n.nspname NOT IN ('pg_catalog', 'information_schema')
   ORDER BY 1`;

suite('S-32 — las funciones que se saltean RLS tienen dueño declarado', () => {
  const barrer = async (): Promise<readonly Fila[]> => {
    const db: Client = await connect();
    try {
      return (await db.query<Fila>(CONSULTA)).rows;
    } finally {
      await db.end();
    }
  };

  it('la aplicación solo ejecuta las declaradas', async () => {
    const sobrantes = (await barrer()).filter((f) => f.app && PERMITIDAS[f.firma] === undefined);

    expect(
      sobrantes.map((f) => f.firma),
      'estas funciones SECURITY DEFINER las puede ejecutar aai_app y no están declaradas. ' +
        'Adentro de ellas no hay RLS: si reciben un identificador de empresa y no comprueban ' +
        'al que llama, son una puerta a los datos de cualquier otro cliente. Comprobá que la ' +
        'función verifique al actor y declarala arriba con el motivo, o revocale EXECUTE a ' +
        'PUBLIC en una migración (a aai_app no alcanza: PUBLIC lo tiene por defecto)',
    ).toEqual([]);
  });

  it('ninguna la puede ejecutar PUBLIC', async () => {
    // PUBLIC incluye a todo rol presente y futuro. Una función privilegiada
    // abierta a PUBLIC es un permiso que nadie decidió dar y que nadie va a
    // encontrar leyendo la migración que la creó, porque no está escrito ahí.
    const abiertas = (await barrer()).filter((f) => f.publico);

    expect(
      abiertas.map((f) => f.firma),
      'PostgreSQL le concede EXECUTE a PUBLIC sobre toda función nueva. Sobre una ' +
        'SECURITY DEFINER eso alcanza cualquier rol que exista después. Agregá ' +
        'REVOKE EXECUTE … FROM PUBLIC en la migración que la crea',
    ).toEqual([]);
  });

  it('las declaradas se pueden ejecutar de verdad', async () => {
    // El control positivo. Sin esto, un `REVOKE ALL` sobre todo dejaría los dos
    // tests de arriba en verde y el alta de empresas rota: la consola mostraría
    // «no se pudo crear» sin una sola línea que explique por qué.
    const barrido = await barrer();
    const ejecutables = new Set(barrido.filter((f) => f.app).map((f) => f.firma));

    expect(ejecutables).toEqual(new Set(Object.keys(PERMITIDAS)));
  });

  it('las negadas siguen existiendo: se les quitó el permiso, no la utilidad', async () => {
    // `rebuild_account_balances` es la herramienta con la que un operador rehace
    // los saldos si algo se corrompe. Borrarla sería perder la reparación para
    // cerrar la puerta; lo que se cerró es que la llame la aplicación.
    const presentes = new Set((await barrer()).map((f) => f.firma));
    const faltantes = Object.keys(NEGADAS).filter((f) => !presentes.has(f));

    expect(faltantes, 'una función declarada en NEGADAS ya no existe: sacala de la lista').toEqual(
      [],
    );
  });
});
