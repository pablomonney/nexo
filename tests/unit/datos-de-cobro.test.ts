/**
 * Los datos bancarios del cobro manual: validación del CBU, lectura del entorno y texto de los avisos.
 *
 * Un CBU mal escrito en un aviso es plata de un cliente transferida a un tercero: lo que se prueba acá es sobre todo que lo
 * que no sirve **no se muestra**.
 */

import { describe, expect, it } from 'vitest';
import { cbuValido, instruccionesDeTransferencia, leerDatosBancarios } from '../../apps/api/src/billing/datos-de-cobro.js';
import { textoDelAviso, type ClaseDeAviso } from '../../apps/api/src/billing/avisos.js';

/** El CBU de ejemplo de la especificación del BCRA. */
const CBU = '2850590940090418135201';

/** Cambia un dígito: ahora tiene que dejar de ser válido (los dos bloques tienen su dígito verificador). */
const conUnDigitoDistinto = (cbu: string, posicion: number): string =>
  cbu.slice(0, posicion) + String((Number(cbu[posicion]) + 1) % 10) + cbu.slice(posicion + 1);

describe('cbuValido', () => {
  it('acepta el CBU de ejemplo de la especificación', () => {
    expect(cbuValido(CBU)).toBe(true);
  });

  it('un error de tipeo en cualquiera de los 22 dígitos lo invalida (un dígito cambiado nunca pasa los dos verificadores)', () => {
    for (let i = 0; i < 22; i += 1) {
      expect(cbuValido(conUnDigitoDistinto(CBU, i)), `el cambio en la posición ${i} no se detectó`).toBe(false);
    }
  });

  it.each(['', '123', `${CBU}0`, CBU.slice(0, 21), 'a'.repeat(22), `${CBU.slice(0, 11)} ${CBU.slice(11)}`])('«%s» no es un CBU', (x) => {
    expect(cbuValido(x)).toBe(false);
  });
});

describe('leerDatosBancarios', () => {
  it('sin nada declarado: no hay datos y tampoco problema (una instalación que todavía no cobra)', () => {
    expect(leerDatosBancarios({})).toEqual({ datos: null, problema: null });
    expect(leerDatosBancarios({ NEXO_COBRO_TITULAR: '  ', NEXO_COBRO_CBU: '' })).toEqual({ datos: null, problema: null });
  });

  it('con titular y CBU válidos: datos, con el CBU limpio de espacios y guiones', () => {
    const r = leerDatosBancarios({ NEXO_COBRO_TITULAR: ' NEXO SRL ', NEXO_COBRO_CBU: '2850 5909-4009 0418 1352 01', NEXO_COBRO_ALIAS: 'nexo.cobros', NEXO_COBRO_BANCO: 'Banco X', NEXO_COBRO_CUIT: '30-71234567-1' });
    expect(r.problema).toBeNull();
    expect(r.datos).toEqual({ titular: 'NEXO SRL', cbu: CBU, alias: 'nexo.cobros', banco: 'Banco X', cuit: '30712345671' });
  });

  it('lo que no sirve NO se muestra, y el problema dice qué: un CBU con error de tipeo, sin titular, alias o CUIT mal', () => {
    const base = { NEXO_COBRO_TITULAR: 'NEXO SRL', NEXO_COBRO_CBU: CBU };
    expect(leerDatosBancarios({ ...base, NEXO_COBRO_CBU: conUnDigitoDistinto(CBU, 5) })).toMatchObject({ datos: null, problema: expect.stringMatching(/CBU no es un CBU válido/u) });
    expect(leerDatosBancarios({ NEXO_COBRO_CBU: CBU })).toMatchObject({ datos: null, problema: expect.stringMatching(/falta NEXO_COBRO_TITULAR/u) });
    expect(leerDatosBancarios({ NEXO_COBRO_TITULAR: 'NEXO SRL' })).toMatchObject({ datos: null, problema: expect.stringMatching(/falta NEXO_COBRO_CBU/u) });
    expect(leerDatosBancarios({ ...base, NEXO_COBRO_ALIAS: 'a b' })).toMatchObject({ datos: null, problema: expect.stringMatching(/ALIAS/u) });
    expect(leerDatosBancarios({ ...base, NEXO_COBRO_CUIT: '123' })).toMatchObject({ datos: null, problema: expect.stringMatching(/CUIT/u) });
  });
});

describe('instruccionesDeTransferencia y los avisos', () => {
  const datos = leerDatosBancarios({ NEXO_COBRO_TITULAR: 'NEXO SRL', NEXO_COBRO_CBU: CBU, NEXO_COBRO_ALIAS: 'nexo.cobros' }).datos;

  it('sin datos, nada: el aviso no inventa una cuenta', () => {
    expect(instruccionesDeTransferencia(null)).toBeNull();
  });

  it('con datos: titular, CBU y alias, y el pedido del número de operación', () => {
    const texto = instruccionesDeTransferencia(datos)!;
    expect(texto).toContain('Titular: NEXO SRL');
    expect(texto).toContain(`CBU: ${CBU}`);
    expect(texto).toContain('Alias: nexo.cobros');
    expect(texto).toContain('número de operación');
  });

  const clases: ClaseDeAviso[] = ['SUSPENSION_PROXIMA', 'ACCESO_DEGRADADO', 'SUSPENSION_APLICADA'];
  it.each(clases)('el aviso %s lleva cómo pagar cuando hay datos, y nada de transferencias cuando no', (clase) => {
    const con = textoDelAviso(clase, { empresa: 'Acme', diasParaLaSuspension: 3, instruccionesDePago: instruccionesDeTransferencia(datos) });
    const sin = textoDelAviso(clase, { empresa: 'Acme', diasParaLaSuspension: 3 });
    expect(con.cuerpo).toContain(CBU);
    expect(sin.cuerpo).not.toMatch(/CBU|transferencia/u);
    // La regla de siempre de los avisos: ni importe ni número de documento.
    expect(con.cuerpo).not.toMatch(/\$\s?\d|ARS\s?\d|factura\s+N/u);
  });

  it('RECHAZO_INICIAL habla de una tarjeta y de una pasarela: no lleva la cuenta bancaria', () => {
    const r = textoDelAviso('RECHAZO_INICIAL', { empresa: 'Acme', diasParaLaSuspension: null, instruccionesDePago: instruccionesDeTransferencia(datos) });
    expect(r.cuerpo).not.toContain(CBU);
  });
});
