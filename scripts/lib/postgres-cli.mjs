/**
 * Lo que comparten `backup-db.mjs` y `restaurar-backup.mjs`.
 *
 * Existe para que el candado de nombres y la ubicación de los binarios estén
 * escritos **una sola vez**: dos copias de la regla que impide restaurar encima
 * de la base de producción es una copia de más, y la que se olvida de
 * actualizar es la que borra los datos.
 */

import { existsSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';

/** Dónde van las copias si nadie dice otra cosa. */
export const DESTINO_POR_DEFECTO = 'C:\\Users\\SaludCapilar\\Backups\\NEXO';

/**
 * El espacio de nombres donde este proyecto tiene permiso para borrar bases.
 *
 * Es el mismo diseño que el sufijo `_test` de `test-db.mjs`, y por el mismo
 * motivo: el script de restauración **crea y destruye** bases, y una
 * restauración apuntada por error a `aai` es irrecuperable. No se comprueba
 * "que no sea la de producción" —esa lista negra siempre queda corta— sino que
 * el destino esté dentro de un prefijo que ninguna base real usa.
 */
export const PREFIJO_DESCARTABLE = 'aai_restauracion';

/** `true` si esta base puede ser creada y destruida por el verificador. */
export function esDescartable(nombre) {
  return nombre === PREFIJO_DESCARTABLE || nombre.startsWith(`${PREFIJO_DESCARTABLE}_`);
}

/** El nombre de la base que hay dentro de una URL de conexión. */
export function nombreDeBase(url) {
  return decodeURIComponent(new URL(url).pathname.replace(/^\//, ''));
}

/** La misma URL apuntando a otra base, con las mismas credenciales. */
export function apuntandoA(url, base) {
  const otra = new URL(url);
  otra.pathname = `/${base}`;
  return otra.toString();
}

/**
 * Dónde está `pg_dump` / `pg_restore`.
 *
 * En Windows los binarios de PostgreSQL no quedan en el `PATH` al instalar, así
 * que se busca en las rutas del instalador oficial, de la versión más nueva a la
 * más vieja. `PG_BIN` gana sobre todo lo demás para el caso en que estén en otro
 * lado. Si no aparece ninguno se devuelve el nombre pelado y que falle el
 * `spawn` con su mensaje, que es más útil que uno inventado acá.
 */
export function binarioDePostgres(nombre) {
  const exe = process.platform === 'win32' ? `${nombre}.exe` : nombre;

  if (process.env.PG_BIN !== undefined && process.env.PG_BIN !== '') {
    return join(process.env.PG_BIN, exe);
  }

  const raiz = 'C:\\Program Files\\PostgreSQL';
  if (process.platform === 'win32' && existsSync(raiz)) {
    const versiones = readdirSync(raiz)
      .filter((v) => /^\d+$/.test(v))
      .sort((a, b) => Number(b) - Number(a));
    for (const version of versiones) {
      const ruta = join(raiz, version, 'bin', exe);
      if (existsSync(ruta)) return ruta;
    }
  }

  return nombre;
}

/** El backup más reciente de una carpeta, o `null` si no hay ninguno. */
export function backupMasReciente(carpeta) {
  if (!existsSync(carpeta)) return null;
  const archivos = readdirSync(carpeta)
    .filter((f) => f.endsWith('.backup'))
    .map((f) => {
      const ruta = join(carpeta, f);
      return { ruta, mtime: statSync(ruta).mtimeMs };
    })
    .sort((a, b) => b.mtime - a.mtime);
  return archivos[0] ?? null;
}
