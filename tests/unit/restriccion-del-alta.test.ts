/**
 * La red: una restricción de la base que llega al `INSERT` no sale como 500.
 *
 * ## Por qué esto se prueba acá y no contra la base
 *
 * Porque, si todo está bien, **no se puede llegar**. Los tres campos
 * registrales del alta —tipo de entidad, jurisdicción y organismo— se validan
 * contra el mismo catálogo que la columna, así que ningún valor que la ruta
 * acepte puede violar un `CHECK` hoy. Un test de integración que quisiera
 * ejercitar esta rama tendría que mandar algo que la validación ya rechaza, y
 * mediría la validación, no la red.
 *
 * La red existe para la restricción que todavía no se escribió. Este archivo
 * fija lo único que se puede fijar: que su mensaje explique el caso conocido y
 * que el desconocido igual se pueda leer.
 */

import { describe, expect, it } from 'vitest';
import { mensajeDeRestriccion } from '@aai/api/routes/onboarding';
import { ORGANISMOS_EN_TEXTO } from '@aai/shared';

describe('El mensaje de una restricción de la base en el alta', () => {
  it('traduce la del organismo a la lista de valores', () => {
    expect(mensajeDeRestriccion('companies_regulator_check')).toContain(ORGANISMOS_EN_TEXTO);
  });

  it('traduce la de la jurisdicción nombrando las que se ofrecen', () => {
    expect(mensajeDeRestriccion('companies_jurisdiction_check')).toContain('AR-C');
  });

  it('una restricción que nadie tradujo se explica igual, con su nombre', () => {
    // Lo único honesto que se puede decir de una regla que este código no
    // conoce: que existe, cómo se llama, y a quién preguntarle.
    const mensaje = mensajeDeRestriccion('companies_algo_futuro_check');
    expect(mensaje).toContain('companies_algo_futuro_check');
    expect(mensaje).toContain('Revisá los valores del formulario');
  });

  it('ningún mensaje es genérico al punto de no decir nada', () => {
    for (const nombre of [
      'companies_regulator_check',
      'companies_jurisdiction_check',
      'lo_que_venga_check',
    ]) {
      expect(mensajeDeRestriccion(nombre).length).toBeGreaterThan(40);
      expect(mensajeDeRestriccion(nombre)).not.toContain('Error interno');
    }
  });
});
