/**
 * El arranque del servidor.
 *
 * Lo que este archivo defiende:
 *
 *   1. **Que el preflight frene de verdad.** Un servidor levantado contra un
 *      esquema viejo no falla: anda a medias, que es el estado más caro de
 *      diagnosticar. Se ejercita la rama roja, que contra una base al día nunca
 *      se ve — y un candado que nunca se vio frenar no está probado.
 *   2. **Que la rama verde sea verde por haber mirado**, no por no haber
 *      encontrado la tabla: se corre contra la base de tests real, migrada.
 *   3. **Que los modos degradados se vean.** `config.ts` está lleno de defaults
 *      inertes —OCR `none`, ARCA `mock`, IA `none`— que son decisiones
 *      correctas y completamente invisibles desde afuera. Alguien puede
 *      constatar un comprobante contra el mock y creer que habló con ARCA.
 */

import { closePool, initPool } from '@aai/db';
import { migracionesFaltantes, modosDeOperacion, verificarEsquema } from '@aai/api/arranque';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { DATABASE_URL, hasDatabase } from './helpers/db.js';

const suite = hasDatabase ? describe : describe.skip;

suite('Arranque del servidor', () => {
  beforeAll(() => {
    initPool(DATABASE_URL);
  });

  afterAll(async () => {
    await closePool();
  });

  it('no encuentra nada que falte contra la base de tests, que está migrada', async () => {
    const problemas = await verificarEsquema();
    expect(problemas, `no debería faltar nada: ${JSON.stringify(problemas)}`).toEqual([]);
  });

  it('frena cuando la base quedó atrás y dice cuántas y con qué comando', () => {
    const enDisco = ['0001_a.sql', '0002_b.sql', '0003_c.sql'];
    const problemas = migracionesFaltantes(enDisco, new Set(['0001_a.sql']));

    expect(problemas).toHaveLength(1);
    expect(problemas[0]!.que).toContain('faltan 2 migración(es)');
    expect(problemas[0]!.que).toContain('0002_b.sql');
    // El mensaje sirve si dice qué hacer. Un error que solo describe el estado
    // deja al operador buscando el comando en la documentación.
    expect(problemas[0]!.comoSeArregla).toBe('npm run db:migrate');
  });

  it('con muchas faltantes nombra las primeras y cuenta el resto', () => {
    const enDisco = Array.from({ length: 30 }, (_, i) => `${String(i).padStart(4, '0')}_x.sql`);
    const problemas = migracionesFaltantes(enDisco, new Set());

    expect(problemas[0]!.que).toContain('y 27 más');
  });

  it('no inventa un problema cuando la base está al día', () => {
    expect(migracionesFaltantes(['0001_a.sql'], new Set(['0001_a.sql']))).toEqual([]);
  });

  it('una base con migraciones de más tampoco es un problema', () => {
    // Pasa al volver a una rama anterior. El servidor viejo contra un esquema
    // nuevo funciona: las tablas que usa siguen ahí. Es el caso inverso —código
    // nuevo contra esquema viejo— el que rompe.
    expect(migracionesFaltantes(['0001_a.sql'], new Set(['0001_a.sql', '0002_b.sql']))).toEqual([]);
  });

  it('marca como no reales los modos simulados o apagados', () => {
    const modos = modosDeOperacion({
      arca: { environment: 'mock' },
      ai: { provider: 'none' },
      documents: { ocrEngine: 'mock' },
      isProduction: false,
    });

    const porNombre = new Map(modos.map((m) => [m.nombre, m]));
    expect(porNombre.get('ARCA')!.real, 'el mock de ARCA no habló con el organismo').toBe(false);
    expect(porNombre.get('IA')!.real).toBe(false);
    expect(porNombre.get('OCR')!.real, 'un OCR simulado no leyó el documento').toBe(false);
  });

  it('reconoce como real la homologación de ARCA', () => {
    // Homologación es un ambiente de verdad del organismo: los comprobantes no
    // tienen validez fiscal, pero la respuesta la da ARCA y no este código.
    const modos = modosDeOperacion({
      arca: { environment: 'homologacion' },
      ai: { provider: 'none' },
      documents: { ocrEngine: 'none' },
      isProduction: false,
    });

    expect(modos.find((m) => m.nombre === 'ARCA')!.real).toBe(true);
  });

  it('informa el entorno, que es lo que cambia el comportamiento de los sobres', () => {
    // No es decorativo: `desenvolver()` se niega a abrir un sobre `local:` con
    // NODE_ENV=production, así que el entorno decide si una credencial de ARCA
    // cargada en desarrollo sigue sirviendo.
    const modos = modosDeOperacion({
      arca: { environment: 'mock' },
      ai: { provider: 'none' },
      documents: { ocrEngine: 'none' },
      isProduction: true,
    });

    expect(modos.find((m) => m.nombre === 'entorno')!.valor).toBe('production');
  });
});
