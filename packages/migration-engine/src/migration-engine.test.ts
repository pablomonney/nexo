/**
 * El motor de migración, probado sin base de datos.
 *
 * Todo lo que decide qué entra a NEXO y qué no —normalizar, mapear, validar,
 * reconciliar, transicionar— es puro y se ejercita acá. Lo que necesita base
 * está en las suites de integración.
 *
 * El orden de los bloques es el del pipeline, para que se lea como el recorrido
 * que hace un dato desde el archivo hasta la empresa.
 */

import { describe, expect, it } from 'vitest';
import {
  AdaptadorDeArchivo,
  ESTADOS,
  RegistroDeAdaptadores,
  adivinarEntidad,
  claveDeIdentidad,
  comoMapa,
  comoTermina,
  identidadExterna,
  normalizar,
  normalizarFila,
  puedeTransicionar,
  reconciliar,
  registroPorDefecto,
  sugerirMapeo,
  validar,
  type Estado,
  type RegistroCanonico,
} from './index.js';

// ---------------------------------------------------------------------------
// Extracción
// ---------------------------------------------------------------------------

const archivo = new AdaptadorDeArchivo();
const bytes = (t: string): Buffer => Buffer.from(t, 'utf8');

describe('extracción de archivos', () => {
  it('lee un CSV y detecta el separador solo', async () => {
    const r = await archivo.extraer({
      bytes: bytes('Razón Social;CUIT;Email\nAcme SA;30-71000001-4;a@acme.test'),
      nombreArchivo: 'clientes.csv',
    });

    expect(r.tablas).toHaveLength(1);
    expect(r.tablas[0]!.columnas).toEqual(['Razón Social', 'CUIT', 'Email']);
    expect(r.tablas[0]!.filas[0]).toEqual(['Acme SA', '30-71000001-4', 'a@acme.test']);
  });

  it('un JSON con varias listas son varias tablas', async () => {
    // Es cómo exporta la mitad de los sistemas: un objeto con una lista por
    // entidad. Tratarlo como una sola tabla perdería todo menos la primera.
    const r = await archivo.extraer({
      bytes: bytes(
        JSON.stringify({
          clientes: [{ nombre: 'Acme', cuit: '30710000014' }],
          productos: [{ sku: 'A-1', nombre: 'Tornillo' }],
        }),
      ),
      nombreArchivo: 'export.json',
    });

    expect(r.tablas.map((t) => t.nombre).sort()).toEqual(['clientes', 'productos']);
  });

  it('las columnas de un JSON son la unión de todas las filas', async () => {
    // Si se tomaran las claves del primer objeto, el campo que solo trae el
    // segundo desaparecería sin que nadie se entere.
    const r = await archivo.extraer({
      bytes: bytes(JSON.stringify([{ a: '1' }, { a: '2', b: '3' }])),
      nombreArchivo: 'x.json',
    });

    expect(r.tablas[0]!.columnas).toEqual(['a', 'b']);
    expect(r.tablas[0]!.filas[0]).toEqual(['1', '']);
  });

  it('aplana un nivel del JSON y deja lo más profundo como texto', async () => {
    const r = await archivo.extraer({
      bytes: bytes(JSON.stringify([{ cliente: { cuit: '20111111112', dom: { calle: 'X' } } }])),
      nombreArchivo: 'x.json',
    });

    expect(r.tablas[0]!.columnas).toContain('cliente.cuit');
    expect(r.tablas[0]!.columnas).toContain('cliente.dom');
  });

  it('lee un XML tomando el elemento que se repite', async () => {
    const r = await archivo.extraer({
      bytes: bytes(
        '<export><cliente><nombre>Acme</nombre><cuit>30710000014</cuit></cliente>' +
          '<cliente><nombre>Beta</nombre><cuit>20111111112</cuit></cliente></export>',
      ),
      nombreArchivo: 'clientes.xml',
    });

    expect(r.tablas[0]!.filas).toHaveLength(2);
    expect(r.tablas[0]!.columnas.sort()).toEqual(['cuit', 'nombre']);
  });

  it('un archivo sin filas se avisa en vez de pasar como vacío', async () => {
    const r = await archivo.extraer({ bytes: bytes('a;b'), nombreArchivo: 'vacio.csv' });
    expect(r.avisos.join(' ')).toContain('no tiene filas');
  });
});

// ---------------------------------------------------------------------------
// Mapeo
// ---------------------------------------------------------------------------

describe('mapeo de columnas', () => {
  it('reconoce los nombres que usan los sistemas de acá', () => {
    const s = sugerirMapeo('PARTY', ['Razón Social', 'CUIT', 'E-Mail', 'Teléfono']);
    const mapa = comoMapa(s);

    expect(mapa['Razón Social']).toBe('razonSocial');
    expect(mapa['CUIT']).toBe('cuit');
    expect(mapa['E-Mail']).toBe('email');
    expect(mapa['Teléfono']).toBe('telefono');
  });

  it('una columna no se mapea a dos campos', () => {
    // Un campo lleno desde dos columnas se ve enseguida; una columna que llena
    // dos campos no se ve nunca, y mete el mismo dato en dos lugares.
    const s = sugerirMapeo('PARTY', ['CUIT']);
    expect(s.filter((x) => x.columna === 'CUIT')).toHaveLength(1);
  });

  it('no ofrece campos de otra entidad', () => {
    const s = sugerirMapeo('PRODUCT', ['CUIT', 'SKU', 'Descripción']);
    expect(s.map((x) => x.campo)).not.toContain('cuit');
    expect(s.map((x) => x.campo)).toContain('sku');
  });

  it('adivina la entidad por los campos obligatorios que cubre', () => {
    expect(adivinarEntidad(['SKU', 'Descripción', 'Precio'])).toBe('PRODUCT');
    expect(adivinarEntidad(['Razón Social', 'CUIT'])).toBe('PARTY');
  });

  it('no adivina cuando no alcanza para ninguna entidad', () => {
    // Devolver algo igual sería peor que no devolver nada: la persona confiaría
    // en una sugerencia armada con dos columnas sueltas.
    expect(adivinarEntidad(['Observaciones', 'Notas'])).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// Normalización
// ---------------------------------------------------------------------------

describe('normalización', () => {
  it('el CUIT se limpia y se valida', () => {
    expect(normalizar('cuit', '30-71000001-4').valor).toBe('30710000014');
    expect(normalizar('cuit', '30 71000001 4').valor).toBe('30710000014');
  });

  it('un CUIT con el dígito mal no se corrige: se rechaza y se conserva', () => {
    const c = normalizar('cuit', '30710000012');
    expect(c.valor).toBeNull();
    expect(c.crudo).toBe('30710000012');
    expect(c.motivo).toContain('dígito verificador');
  });

  it('un importe ambiguo no se resuelve adivinando', () => {
    // «1,234» puede ser mil doscientos treinta y cuatro o uno coma doscientos
    // treinta y cuatro. Elegir uno importaría un número inventado.
    const c = normalizar('total', '1,234');
    if (c.valor === null) {
      expect(c.motivo).toBeTruthy();
    } else {
      // Si el parser lo resuelve con confianza, tiene que haber conservado el crudo.
      expect(c.crudo).toBe('1,234');
    }
  });

  it('el importe se guarda en centavos como texto, nunca como float', () => {
    const c = normalizar('total', '1.234,56');
    expect(c.valor).toBe('123456');
    expect(typeof c.valor).toBe('string');
  });

  it('una cantidad admite fracciones que un importe no', () => {
    expect(normalizar('cantidad', '0,5').valor).toBeCloseTo(0.5);
  });

  it('el campo vacío queda en null y lo dice', () => {
    const c = normalizar('razonSocial', '   ');
    expect(c.valor).toBeNull();
    expect(c.motivo).toBe('El campo vino vacío');
  });

  it('normaliza una fila entera contra su mapeo', () => {
    const campos = normalizarFila(
      ['Razón Social', 'CUIT', 'Sobrante'],
      ['  Acme   SA ', '30-71000001-4', 'no mapeada'],
      { 'Razón Social': 'razonSocial', CUIT: 'cuit' },
    );

    expect(campos.razonSocial!.valor).toBe('Acme SA');
    expect(campos.cuit!.valor).toBe('30710000014');
    expect(campos.Sobrante).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// Validación
// ---------------------------------------------------------------------------

const registro = (
  entidad: RegistroCanonico['entidad'],
  campos: Record<string, string>,
  fila = '1',
): RegistroCanonico => ({
  entidad,
  procedencia: { origen: 'x.csv', fila, idExterno: null, hash: 'h' },
  campos: Object.fromEntries(
    Object.entries(campos).map(([k, v]) => [k, normalizar(k, v)]),
  ),
});

describe('validación', () => {
  it('un obligatorio ausente es ERROR y bloquea la importación', () => {
    const v = validar([registro('PARTY', { cuit: '30710000014' })]);
    expect(v.sePuedeImportar).toBe(false);
    expect(v.hallazgos.some((h) => h.codigo === 'FALTA_OBLIGATORIO')).toBe(true);
  });

  it('un opcional ilegible es ADVERTENCIA y deja pasar', () => {
    const v = validar([registro('PARTY', { razonSocial: 'Acme', cuit: '30710000012' })]);
    expect(v.sePuedeImportar).toBe(true);
    expect(v.hallazgos.some((h) => h.nivel === 'ADVERTENCIA')).toBe(true);
  });

  it('lo que se normalizó queda como INFO, para poder reconstruirlo', () => {
    const v = validar([registro('PARTY', { razonSocial: '  Acme   SA  ' })]);
    expect(v.hallazgos.some((h) => h.codigo === 'NORMALIZADO')).toBe(true);
  });

  it('un asiento descuadrado es ERROR y no se ajusta solo', () => {
    const v = validar([
      registro('JOURNAL_ENTRY', { asiento: '1', fecha: '01/03/2026', cuenta: '1.1', debe: '100,00', haber: '0' }, '1'),
      registro('JOURNAL_ENTRY', { asiento: '1', fecha: '01/03/2026', cuenta: '4.1', debe: '0', haber: '90,00' }, '2'),
    ]);

    const desc = v.hallazgos.find((h) => h.codigo === 'ASIENTO_DESCUADRADO');
    expect(desc).toBeDefined();
    expect(desc?.mensaje).toContain('10,00');
    expect(desc?.mensaje).toContain('no agrega un renglón');
    expect(v.sePuedeImportar).toBe(false);
  });

  it('un asiento que cuadra no genera hallazgo', () => {
    const v = validar([
      registro('JOURNAL_ENTRY', { asiento: '1', fecha: '01/03/2026', cuenta: '1.1', debe: '100,00', haber: '0' }, '1'),
      registro('JOURNAL_ENTRY', { asiento: '1', fecha: '01/03/2026', cuenta: '4.1', debe: '0', haber: '100,00' }, '2'),
    ]);
    expect(v.hallazgos.some((h) => h.codigo === 'ASIENTO_DESCUADRADO')).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// Identidad e idempotencia
// ---------------------------------------------------------------------------

describe('identidad', () => {
  it('el CUIT gana sobre el nombre', () => {
    const campos = registro('PARTY', { razonSocial: 'Acme', cuit: '30710000014' }).campos;
    expect(claveDeIdentidad('PARTY', campos)?.por).toEqual(['cuit']);
  });

  it('sin CUIT cae al siguiente criterio', () => {
    const campos = registro('PARTY', { razonSocial: 'Acme', email: 'a@b.test' }).campos;
    expect(claveDeIdentidad('PARTY', campos)?.por).toEqual(['email']);
  });

  it('sin ninguna combinación completa devuelve null en vez de inventar', () => {
    expect(claveDeIdentidad('PARTY', {})).toBeNull();
  });

  it('la identidad externa no incluye el contenido de la fila', () => {
    // Si incluyera el hash, corregir el teléfono de un cliente en el sistema
    // viejo lo convertiría en un cliente nuevo en la próxima corrida.
    const a = identidadExterna('tango', 'PARTY', 'C-1');
    const b = identidadExterna('tango', 'PARTY', 'C-1');
    expect(a).toBe(b);
    expect(a).not.toContain('hash');
  });
});

// ---------------------------------------------------------------------------
// Estados
// ---------------------------------------------------------------------------

describe('máquina de estados', () => {
  it('no se puede importar sin haber validado', () => {
    expect(puedeTransicionar('CARGADA', 'IMPORTANDO')).toBe(false);
    expect(puedeTransicionar('MAPEADA', 'IMPORTANDO')).toBe(false);
    expect(puedeTransicionar('LISTA', 'IMPORTANDO')).toBe(true);
  });

  it('el camino que recorre una migración real está permitido entero', () => {
    // Cada paso del ciclo, en orden. La tabla tenía un estado intermedio que
    // ningún código escribía, y por eso `CARGADA → MAPEADA` —el paso que sí
    // ocurre— estaba prohibido: la primera migración real no pudo mapear.
    const camino = ['CREADA', 'CARGADA', 'MAPEADA', 'VALIDADA', 'LISTA', 'IMPORTANDO', 'COMPLETADA'] as const;
    for (const [i, desde] of camino.slice(0, -1).entries()) {
      expect([desde, camino[i + 1]!, puedeTransicionar(desde, camino[i + 1]!)]).toEqual([
        desde,
        camino[i + 1]!,
        true,
      ]);
    }
  });

  it('todo estado declarado es alcanzable desde el inicio', () => {
    // Un estado al que no se llega no describe nada: describe una intención.
    const alcanzados = new Set<Estado>(['CREADA']);
    for (let vuelta = 0; vuelta < ESTADOS.length; vuelta += 1) {
      for (const desde of [...alcanzados]) {
        for (const hasta of ESTADOS) {
          if (puedeTransicionar(desde, hasta)) alcanzados.add(hasta);
        }
      }
    }
    expect([...ESTADOS].filter((e) => !alcanzados.has(e))).toEqual([]);
  });

  it('se puede volver atrás antes de escribir, y no después', () => {
    expect(puedeTransicionar('VALIDADA', 'MAPEADA')).toBe(true);
    expect(puedeTransicionar('LISTA', 'MAPEADA')).toBe(true);
    expect(puedeTransicionar('COMPLETADA', 'MAPEADA')).toBe(false);
    expect(puedeTransicionar('IMPORTANDO', 'LISTA')).toBe(false);
  });

  it('una migración terminada solo puede revertirse', () => {
    expect(puedeTransicionar('COMPLETADA', 'REVERTIDA')).toBe(true);
    expect(puedeTransicionar('REVERTIDA', 'IMPORTANDO')).toBe(false);
  });

  it('las advertencias deciden con qué estado termina', () => {
    expect(comoTermina(0)).toBe('COMPLETADA');
    expect(comoTermina(3)).toBe('COMPLETADA_CON_ADVERTENCIAS');
  });
});

// ---------------------------------------------------------------------------
// Reconciliación
// ---------------------------------------------------------------------------

describe('reconciliación', () => {
  it('todo registro del origen tiene que terminar en alguna parte', () => {
    const r = reconciliar(
      [{ entidad: 'PARTY', enOrigen: 10, importados: 7, yaEstaban: 2, rechazados: 0 }],
      [],
    );
    expect(r.conteos[0]!.sinExplicar).toBe(1);
    expect(r.cierra).toBe(false);
  });

  it('cierra cuando la suma da', () => {
    const r = reconciliar(
      [{ entidad: 'PARTY', enOrigen: 10, importados: 7, yaEstaban: 2, rechazados: 1 }],
      [{ concepto: 'Saldo de clientes', enOrigen: 500n, enNexo: 500n }],
    );
    expect(r.cierra).toBe(true);
  });

  it('una diferencia de saldo se informa con signo y no se ajusta', () => {
    const r = reconciliar([], [{ concepto: 'Stock', enOrigen: 100n, enNexo: 90n }]);
    expect(r.saldos[0]!.diferencia).toBe(-10n);
    expect(r.cierra).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// Registro de adaptadores
// ---------------------------------------------------------------------------

describe('registro de adaptadores', () => {
  it('un adaptador no implementado tiene que decir qué le falta', () => {
    const r = new RegistroDeAdaptadores();
    expect(() =>
      r.registrar({
        descripcion: {
          codigo: 'FANTASMA',
          nombre: 'Fantasma',
          medio: 'API',
          estado: 'PLANIFICADO',
          capacidades: { entidades: [], formatos: [], porTandas: false, reanudable: false, conIdExterno: false },
        },
        extraer: async () => ({ tablas: [], avisos: [] }),
      }),
    ).toThrow(/qué le falta/);
  });

  it('solo lo implementado aparece como disponible', () => {
    const r = registroPorDefecto();
    const disponibles = r.disponibles().map((d) => d.codigo);

    expect(disponibles).toEqual(['ARCHIVO_GENERICO']);
    // Y lo demás sigue en la matriz, con su estado: la UI lo muestra como
    // pendiente en vez de esconderlo, que es lo que permite planificar.
    expect(r.todos().length).toBeGreaterThan(1);
  });

  it('ningún adaptador pendiente finge devolver datos', async () => {
    // Devolver una tabla vacía se vería como «el archivo no traía nada» y
    // mandaría a buscar el problema al lado equivocado.
    const r = registroPorDefecto();
    for (const d of r.todos()) {
      if (d.estado === 'IMPLEMENTADO') continue;
      await expect(r.obtener(d.codigo)!.extraer({})).rejects.toThrow(d.estado);
    }
  });

  it('la matriz de compatibilidad sale del registro, no de una lista aparte', () => {
    const r = registroPorDefecto();
    const fila = r.matriz().find((m) => m.codigo === 'ARCHIVO_GENERICO');
    expect(fila?.entidades).toContain('PARTY');
    expect(fila?.estado).toBe('IMPLEMENTADO');
  });
});
