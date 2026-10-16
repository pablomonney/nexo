/**
 * El bucle del turno del asistente y el control de cifras de su texto. Sin base, sin red.
 *
 * Lo que se afirma: el modelo no puede ejecutar nada que la aplicación no le ofreció, un fallo de herramienta no filtra su
 * mensaje, un modelo que no termina no cuelga el pedido, y una cifra que no salió de ningún lado no llega a la pantalla.
 */

import {
  conducirTurno,
  revisarTextoDelAsistente,
  type HerramientaDeChat,
  type LlamadaEjecutada,
  type RespuestaDeChat,
} from '@aai/ai-engine';
import { describe, expect, it } from 'vitest';
import { ProveedorDeChatGuionado, dicho, pidiendo } from '../integration/helpers/chat-guionado.js';

const ventas: HerramientaDeChat = {
  nombre: 'ventas',
  descripcion: 'Ventas del mes.',
  esquema: { type: 'object', properties: {}, additionalProperties: false },
  ejecutar: async () => ({ contenido: JSON.stringify({ valor: '1.234.567,89' }) }),
};

const turno = (guion: ConstructorParameters<typeof ProveedorDeChatGuionado>[0], extra: Partial<Parameters<typeof conducirTurno>[0]> = {}) => {
  const proveedor = new ProveedorDeChatGuionado(guion);
  return { proveedor, hecho: conducirTurno({ proveedor, system: 's', historial: [], mensajeDelUsuario: 'hola', herramientas: [ventas], ...extra }) };
};

describe('conducirTurno', () => {
  it('un texto directo termina en una iteración', async () => {
    const { hecho } = turno([dicho('Hola.')]);
    expect(await hecho).toMatchObject({ estado: 'RESPONDIDA', texto: 'Hola.', iteraciones: 1, llamadas: [] });
  });

  it('ejecuta la herramienta pedida y le devuelve el resultado al modelo; suma el uso de cada vuelta', async () => {
    const { proveedor, hecho } = turno([pidiendo('ventas', {}, 'id1', { entrada: 100, salida: 10 }), dicho('Son 1.234.567,89.', { entrada: 150, salida: 20 })]);
    const r = await hecho;
    expect(r.estado).toBe('RESPONDIDA');
    expect(r.llamadas.map((l) => l.nombre)).toEqual(['ventas']);
    expect(r.uso).toEqual({ entrada: 250, salida: 30 });
    const vuelta = proveedor.pedidos[1]!.mensajes.at(-1)!.bloques[0]!;
    expect(vuelta).toMatchObject({ tipo: 'resultado', id: 'id1', esError: false });
  });

  it('una herramienta que no se ofreció no existe, aunque el modelo la nombre', async () => {
    const { proveedor, hecho } = turno([pidiendo('borrar_todo', {}), dicho('No pude.')]);
    const r = await hecho;
    expect(r.llamadas[0]!.resultado.esError).toBe(true);
    expect(proveedor.pedidos[1]!.mensajes.at(-1)!.bloques[0]).toMatchObject({ tipo: 'resultado', esError: true });
  });

  it('si la herramienta lanza, el modelo recibe un error genérico: el mensaje original no se filtra', async () => {
    const rota: HerramientaDeChat = { ...ventas, ejecutar: async () => { throw new Error('SELECT * FROM secretos WHERE clave = abc123'); } };
    const { proveedor, hecho } = turno([pidiendo('ventas', {}), dicho('No pude consultarlo.')], { herramientas: [rota] });
    await hecho;
    const leido = JSON.stringify(proveedor.pedidos[1]!.mensajes);
    expect(leido).not.toContain('secretos');
    expect(leido).not.toContain('abc123');
  });

  it('un modelo que pide herramientas sin parar termina en SIN_CONCLUSION en el tope de iteraciones', async () => {
    const { proveedor, hecho } = turno([pidiendo('ventas', {})], { maxIteraciones: 3 });
    const r = await hecho;
    expect(r.estado).toBe('SIN_CONCLUSION');
    expect(proveedor.pedidos).toHaveLength(3);
  });

  it('cortar por max_tokens es TRUNCADA; un rechazo del proveedor es RECHAZO_DEL_PROVEEDOR', async () => {
    const corte: RespuestaDeChat = { ...dicho('Vendiste mucho y además'), razonDeCorte: 'maxTokens' };
    expect((await turno([corte]).hecho).estado).toBe('TRUNCADA');
    const no: RespuestaDeChat = { ...dicho(''), razonDeCorte: 'rechazo' };
    expect((await turno([no]).hecho).estado).toBe('RECHAZO_DEL_PROVEEDOR');
  });

  it('un texto rechazado por el control recibe UNA corrección; si la acepta, RESPONDIDA', async () => {
    const control = (t: string) => (t.includes('999') ? { ok: false, motivo: 'cifra 999 inventada' } : { ok: true });
    const { proveedor, hecho } = turno([dicho('Son 999.'), dicho('No tengo ese dato.')], { revisarTexto: control });
    const r = await hecho;
    expect(r).toMatchObject({ estado: 'RESPONDIDA', texto: 'No tengo ese dato.', motivosDeRechazo: ['cifra 999 inventada'] });
    const correccion = proveedor.pedidos[1]!.mensajes.at(-1)!.bloques[0]!;
    expect(correccion.tipo === 'texto' && correccion.texto).toContain('cifra 999 inventada');
  });

  it('si la corrección también falla, RECHAZADA, y no hay tercera oportunidad', async () => {
    const { proveedor, hecho } = turno([dicho('Son 999.')], { revisarTexto: () => ({ ok: false, motivo: 'mal' }) });
    const r = await hecho;
    expect(r.estado).toBe('RECHAZADA');
    expect(proveedor.pedidos).toHaveLength(2);
  });

  it('los archivos adjuntos van en el mensaje de la persona, antes del texto', async () => {
    const { proveedor, hecho } = turno([dicho('Vi la imagen.')], {
      adjuntos: [{ tipo: 'adjunto', clase: 'imagen', mediaType: 'image/png', base64: 'AAAA' }],
    });
    await hecho;
    const bloques = proveedor.pedidos[0]!.mensajes.at(-1)!.bloques;
    expect(bloques.map((b) => b.tipo)).toEqual(['adjunto', 'texto']);
  });

  it('un fallo del proveedor se propaga: lo decide quien llama', async () => {
    const roto = { id: 'roto', conversar: async () => { throw new Error('caído'); } };
    await expect(conducirTurno({ proveedor: roto, system: 's', historial: [], mensajeDelUsuario: 'x', herramientas: [] })).rejects.toThrow('caído');
  });
});

describe('revisarTextoDelAsistente', () => {
  const llamada = (contenido: string): LlamadaEjecutada => ({ nombre: 'ventas', entrada: {}, resultado: { contenido } });
  const revisar = (texto: string, extra: Partial<Parameters<typeof revisarTextoDelAsistente>[0]> = {}) =>
    revisarTextoDelAsistente({ texto, llamadas: [], mensajeDelUsuario: '', historial: [], ...extra });

  it('una cifra que devolvió una herramienta pasa, escrita en cualquier formato', () => {
    const l = [llamada('{"valor":"1.234.567,89"}')];
    expect(revisar('Vendiste 1.234.567,89.', { llamadas: l }).ok).toBe(true);
    expect(revisar('Vendiste 1234567.89.', { llamadas: l }).ok).toBe(true);
  });

  it('una cifra inventada se rechaza entera, y el motivo la nombra para que el modelo se corrija', () => {
    const v = revisar('Vendiste 7.654.321.', { llamadas: [llamada('{"valor":"1.234.567,89"}')] });
    expect(v.ok).toBe(false);
    expect(v.motivo).toContain('7654321');
  });

  it('lo que escribió la persona y lo que ya se dijo antes se puede repetir', () => {
    expect(revisar('El CUIT 20123456786 que me diste.', { mensajeDelUsuario: 'mi cuit es 20-12345678-6' }).ok).toBe(true);
    expect(revisar('Como te dije, 456.789.', { historial: ['Eran 456.789 pesos.'] }).ok).toBe(true);
  });

  it('los números de una o dos cifras no se verifican (ordinales, cantidades)', () => {
    expect(revisar('Hay 3 cuentas y 12 movimientos.').ok).toBe(true);
  });

  it('un texto vacío no pasa', () => {
    expect(revisar('   ').ok).toBe(false);
  });

  it('una cifra de tres dígitos sin origen no pasa aunque parezca chica', () => {
    expect(revisar('Fueron 250.').ok).toBe(false);
  });
});
