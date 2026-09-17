/**
 * Lo que el alta le dice a quien se registró sobre su correo.
 *
 * ## Por qué esto tiene un test propio
 *
 * El defecto que lo motiva se midió en producción el 2026-09-17, con Resend
 * conectado y funcionando: quien se registraba con una dirección **ya
 * registrada** leía «no hay proveedor de correo configurado en esta
 * instalación». Falso, y sobre la propia configuración del sistema.
 *
 * El motivo era una cadena de ternarios con `else`: `POST /auth/signup` tiene
 * **cuatro** desenlaces —los tres estados de un envío más `null`, que es «no se
 * intentó porque la dirección ya estaba»— y había tres textos. El cuarto caía
 * en el último.
 *
 * Y la suite no lo veía, que es la parte que importa: las pruebas corren con
 * `EMAIL_PROVIDER=none`, donde el texto de `SIN_PROVEEDOR` es **cierto**. El
 * error solo aparecía con un proveedor configurado, es decir, exactamente donde
 * no hay tests corriendo. Por eso este archivo prueba el mapa directamente, sin
 * depender de cómo esté configurada la instalación que lo corre.
 */

import { describe, expect, it } from 'vitest';
import { textoDelEnvio } from '@aai/api/routes/auth';

describe('El texto del alta sobre el correo', () => {
  it('no afirma nada sobre el proveedor cuando la dirección ya estaba', () => {
    // El caso que rompía: `null` no es un estado de envío, es la ausencia de
    // uno. Decir «no hay proveedor» acá es afirmar un hecho falso sobre la
    // instalación, y manda a revisar una configuración que está bien.
    expect(textoDelEnvio(null)).not.toContain('no hay proveedor');
    expect(textoDelEnvio(null)).not.toContain('bandeja de salida');
  });

  it('contesta lo mismo si salió que si la dirección ya estaba', () => {
    // Esta es la invariante que protege de la enumeración de cuentas: si los
    // dos casos se distinguieran, cualquiera podría averiguar quién usa NEXO
    // probando direcciones y mirando la respuesta.
    expect(textoDelEnvio(null)).toBe(textoDelEnvio('ENVIADO'));
  });

  it('no promete que salió un mensaje que puede no haber salido', () => {
    // El texto compartido tiene que ser cierto en los dos casos, así que es
    // condicional. Un «el mensaje salió» seco sería mentira para la dirección
    // repetida, donde no se intentó ningún envío.
    expect(textoDelEnvio(null)).toContain('Si esa dirección no estaba registrada');
  });

  it('distingue un rechazo de una instalación sin correo', () => {
    // Llevan a acciones opuestas: el primero lo resuelve quien se registró
    // pidiendo otro; el segundo lo resuelve quien administra la instalación.
    expect(textoDelEnvio('FALLIDO')).toContain('no se pudo entregar');
    expect(textoDelEnvio('SIN_PROVEEDOR')).toContain('no hay proveedor de correo');
    expect(textoDelEnvio('FALLIDO')).not.toBe(textoDelEnvio('SIN_PROVEEDOR'));
  });

  it('los cuatro desenlaces tienen texto, y ninguno cae en otro por descarte', () => {
    const desenlaces = [null, 'ENVIADO', 'FALLIDO', 'SIN_PROVEEDOR'] as const;
    for (const desenlace of desenlaces) {
      expect(textoDelEnvio(desenlace).length).toBeGreaterThan(20);
    }
    // Tres textos distintos para cuatro desenlaces, y la coincidencia es la
    // única que está declarada arriba: `null` con `ENVIADO`.
    expect(new Set(desenlaces.map((d) => textoDelEnvio(d))).size).toBe(3);
  });
});
