/**
 * `scripts/auditar-servidor.sh` es de SOLO LECTURA, y esto lo hace cumplir.
 *
 * Se manda por SSH a producción por la entrada estándar. La promesa de que no cambia nada no puede ser una frase en un
 * comentario: acá se vuelve a leer el archivo y se rechaza cualquier verbo que escriba, construya, reinicie o traiga código.
 * Un cambio futuro que agregue uno tiene que pasar por esta lista (y por una decisión explícita de quien la edite).
 */

import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const RAIZ = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const fuente = readFileSync(join(RAIZ, 'scripts', 'auditar-servidor.sh'), 'utf8');

/** El código, sin las líneas de comentario. */
const codigo = fuente.split('\n').filter((l) => !l.trimStart().startsWith('#')).join('\n');

describe('auditar-servidor.sh no escribe', () => {
  const PROHIBIDOS: Array<[string, RegExp]> = [
    ['borrar / mover / copiar', /\b(rm|mv|cp|rmdir|truncate|shred|ln)\s/u],
    ['editar o crear archivos', /\b(tee|touch|mkdir|install)\b|\bsed\s+-[a-z]*i|>>/u],
    ['permisos y dueños', /\b(chmod|chown|chgrp)\b/u],
    ['Docker que cambia algo', /docker\s+(run|build|tag|rmi|rm|stop|start|restart|kill|pull|push|load|save|commit|cp|compose|network\s+(create|rm)|volume\s+(create|rm)|system\s+prune|image\s+prune)\b/u],
    ['systemd que cambia algo', /systemctl\s+(start|stop|restart|reload|enable|disable|mask|daemon-reload|edit|kill)\b/u],
    ['Git que cambia algo o trae código', /git\s+(fetch|pull|merge|checkout|switch|reset|clean|commit|add|stash|gc|push|rebase|cherry-pick|apply|am|tag\s+-)/u],
    ['instalar o actualizar', /\b(apt|apt-get|dpkg|yum|dnf|npm|npx|pip)\b/u],
    ['matar procesos', /\b(kill|pkill|killall)\b/u],
    ['pedidos HTTP que escriben', /curl[^\n]*(-X\s*(POST|PUT|PATCH|DELETE)|--data|\s-d\s|--upload-file|-T\s)/u],
    ['redirecciones a archivos', /(?<![2&])>(?!\s*(\/dev\/null|&))\s*\S/u],
    ['ejecutar lo que llegue de afuera', /\b(eval|source)\b|^\s*\.\s+[^\s]/mu],
  ];

  it.each(PROHIBIDOS)('no usa: %s', (nombre, patron) => {
    // Las redirecciones se buscan FUERA de las cadenas: un `>` dentro de un programa de awk o de sed no es una redirección.
    const sinCadenas = (l: string): string => l.replace(/'[^']*'/gu, "''").replace(/"[^"]*"/gu, '""');
    const hallazgos = codigo
      .split('\n')
      .filter((l) => patron.test(nombre === 'redirecciones a archivos' ? sinCadenas(l) : l));
    expect(hallazgos, 'esta auditoría es de solo lectura').toEqual([]);
  });

  it('toda consulta a la base es un SELECT o un SHOW', () => {
    const consultas = [...codigo.matchAll(/consulta\s+(?:"([^"]*)"|'([^']*)')/gu)].map((m) => (m[1] ?? m[2] ?? '').trim());
    expect(consultas.length, 'no encuentro consultas: ¿cambió la forma de llamarlas?').toBeGreaterThan(10);
    for (const q of consultas) {
      expect(q, `consulta que no es de lectura: ${q}`).toMatch(/^(SELECT|SHOW)\b/iu);
      expect(q, `consulta con más de una sentencia: ${q}`).not.toMatch(/;\s*\S/u);
      expect(q).not.toMatch(/\b(INSERT|UPDATE|DELETE|DROP|ALTER|CREATE|TRUNCATE|GRANT|REVOKE|COPY|VACUUM|REINDEX|CALL|DO)\b/iu);
    }
  });

  it('el único `docker exec` es el de psql, y va dentro de `consulta`', () => {
    const ejecuciones = codigo.split('\n').filter((l) => /docker\s+exec/u.test(l));
    expect(ejecuciones).toHaveLength(1);
    expect(ejecuciones[0]).toMatch(/psql .*-tAc "\$1"/u);
  });

  it('nunca imprime una variable sensible', () => {
    // Los valores de estas claves sólo se leen para saber si están vacías.
    for (const clave of ['POSTGRES_PASSWORD', 'JWT_SECRET', 'EMAIL_API_KEY', 'MP_ACCESS_TOKEN', 'MASTER_KEY']) {
      const impresiones = codigo.split('\n').filter((l) => new RegExp(`(echo|printf)[^\\n]*\\$\\{?${clave}`, 'u').test(l));
      expect(impresiones, clave).toEqual([]);
    }
    expect(codigo).not.toMatch(/\bcat\s+["$]*\$?\{?ENV_FILE|\bcat\s+[^\n]*\.env\b/u);
  });

  it('una sentencia que SÍ escribiera, agregada en el futuro, haría fallar esta suite', () => {
    const mutado = `${codigo}\nrm -rf /tmp/algo\n`;
    expect(PROHIBIDOS.some(([, p]) => mutado.split('\n').some((l) => p.test(l)))).toBe(true);
  });
});
