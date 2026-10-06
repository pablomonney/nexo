/**
 * La zona horaria de negocio, para los scripts que se conectan con `pg` directo.
 *
 * La aplicación la fija en cada conexión de su pool (`initPool`); estos scripts
 * no pasan por ahí, así que la piden con la misma opción. Sin ella, `CURRENT_DATE`
 * vuelve la fecha de UTC —la de mañana, entre las 21:00 y las 24:00 ART—.
 *
 * Es una constante repetida a propósito: `@aai/shared` es TypeScript compilado
 * y estos scripts son JavaScript plano. La igualdad con `ZONA_DE_NEGOCIO` la
 * comprueba `tests/security/zona-de-negocio-en-conexiones.test.ts`.
 *
 * Solo para scripts que deciden o comparan fechas de negocio. Los verificadores
 * de integridad no la necesitan —tras la migración 0131 el resultado de la
 * cadena de auditoría no depende de la zona— y `backup-db.mjs` sella sus
 * archivos en UTC a propósito, para coincidir con los del servidor.
 */
export const ZONA_DE_NEGOCIO = 'America/Argentina/Buenos_Aires';

/** Lo que se agrega a `new pg.Client({ connectionString, ...opcionesDeConexion() })`. */
export function opcionesDeConexion() {
  return { options: `-c timezone=${ZONA_DE_NEGOCIO}` };
}
