/**
 * S-8 — El lint de arquitectura falla si alguien viola el ADR-001.
 *
 * Un lint configurado no es un lint que funciona. Este test escribe una violación
 * real en `packages/ai-engine/src`, corre dependency-cruiser y verifica que el
 * build se cae. Después la borra.
 *
 * Es el criterio de salida de la FASE 1 declarado en ROADMAP.md: "el lint de
 * dependencias falla si alguien viola ADR-001".
 */

import { execFileSync } from 'node:child_process';
import { existsSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it } from 'vitest';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const VIOLATION_FILE = join(ROOT, 'packages', 'ai-engine', 'src', '__adr001_probe__.ts');

// Se invoca el binario con `node` y no vía `npx`: desde Node 20.12 el spawn de
// archivos .cmd sin shell falla en Windows, y con shell:true habría que lidiar con
// el quoting. Ejecutar el .mjs directamente es determinístico en los tres SO.
const DEPCRUISE_BIN = join(ROOT, 'node_modules', 'dependency-cruiser', 'bin', 'dependency-cruise.mjs');

function runArchLint(): { code: number; output: string } {
  try {
    const output = execFileSync(
      process.execPath,
      [DEPCRUISE_BIN, 'packages', 'apps', '--config', '.dependency-cruiser.cjs'],
      { cwd: ROOT, encoding: 'utf8', stdio: 'pipe' },
    );
    return { code: 0, output };
  } catch (error) {
    const failure = error as { status?: number; stdout?: string; stderr?: string };
    return {
      code: failure.status ?? 1,
      output: `${failure.stdout ?? ''}${failure.stderr ?? ''}`,
    };
  }
}

afterEach(() => {
  if (existsSync(VIOLATION_FILE)) rmSync(VIOLATION_FILE);
});

describe('ADR-001 — la IA no puede alcanzar el motor contable', () => {
  it('el lint de arquitectura pasa con el árbol limpio', () => {
    const result = runArchLint();
    expect(result.output).toContain('no dependency violations found');
    expect(result.code).toBe(0);
  });

  it('el lint FALLA si ai-engine importa el motor contable', () => {
    writeFileSync(
      VIOLATION_FILE,
      [
        '// Archivo temporal generado por tests/security/adr-001.test.ts.',
        '// Si lo encontrás en el repositorio, el test se interrumpió: borralo.',
        "import type { JournalEntryDraft } from '@aai/accounting-engine';",
        'export type Probe = JournalEntryDraft;',
        '',
      ].join('\n'),
      'utf8',
    );

    const result = runArchLint();

    expect(result.code).not.toBe(0);
    expect(result.output).toContain('adr-001-ai-no-escribe-contabilidad');
  }, 60_000);

  it('el lint FALLA si ai-engine importa un cliente de base de datos', () => {
    writeFileSync(
      VIOLATION_FILE,
      [
        '// Archivo temporal generado por tests/security/adr-001.test.ts.',
        "import pg from 'pg';",
        'export const probe = pg;',
        '',
      ].join('\n'),
      'utf8',
    );

    const result = runArchLint();

    expect(result.code).not.toBe(0);
    expect(result.output).toContain('adr-001-ai-no-escribe-contabilidad');
  }, 60_000);

  /**
   * El hecho `vinculadaConOperacionesGravadas` lo declara una persona, y el
   * modelo que lo traduce vive en `@aai/tax-engine`. Que la IA no pueda tocarlo
   * no es una promesa del diseño: es que `tax-engine` está dentro de
   * `MOTOR_CONTABLE` y `@aai/db` dentro de `CLIENTE_DE_BASE`, así que no hay
   * import posible ni hacia el modelo ni hacia la tabla.
   *
   * Se prueba con el módulo concreto porque una regla que cubre un paquete
   * entero puede dejar de cubrir un archivo si alguien reordena los patrones.
   */
  it('el lint FALLA si ai-engine importa el modelo de afectación fiscal', () => {
    writeFileSync(
      VIOLATION_FILE,
      [
        '// Archivo temporal generado por tests/security/adr-001.test.ts.',
        "import { proveerVinculacion } from '@aai/tax-engine';",
        'export const probe = proveerVinculacion;',
        '',
      ].join('\n'),
      'utf8',
    );

    const result = runArchLint();

    expect(result.code).not.toBe(0);
    expect(result.output).toContain('adr-001-ai-no-escribe-contabilidad');
  }, 60_000);
});
