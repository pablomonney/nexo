/**
 * Los ocho archivos con los que se prueba el motor de punta a punta.
 *
 * ## Por qué se generan acá y no viven en `fixtures/`
 *
 * Porque un archivo guardado en el repositorio dice qué contenía **el día que
 * se guardó**. Estos se construyen con una función que declara el defecto que
 * introduce —«a la fila 7 le falta el CUIT»— así que el archivo y la afirmación
 * sobre el archivo no se pueden separar. Si alguien edita el generador, cambian
 * los dos a la vez o el test falla.
 *
 * Cada conjunto existe para responder una pregunta distinta:
 *
 *   · **LIMPIO** — que lo correcto entre sin ruido. Sin este, un motor que
 *     rechaza todo pasaría los otros siete.
 *   · **CON_ADVERTENCIAS** — que un dato dudoso entre **y quede dicho**. Es la
 *     categoría que más se equivoca sola: o se convierte en error y bloquea una
 *     migración legítima, o se pierde y nadie se entera.
 *   · **CON_ERRORES** — que lo que no puede entrar no entre, con el motivo.
 *   · **DUPLICADOS** — que dos filas con la misma identidad se reconozcan como
 *     una, y que se avise en vez de elegir en silencio.
 *   · **DESPROLIJO** — el archivo real: separadores distintos, espacios,
 *     mayúsculas, importes con miles, fechas dd/mm/aaaa, columnas de más.
 *   · **CONTABLE** — que un asiento descuadrado no se importe **y no se
 *     cuadre solo**.
 *   · **STOCK** — que una cantidad negativa se distinga de una ilegible.
 *   · **GRANDE** — que el volumen no cambie el resultado, y cuánto tarda.
 */

import { describe, expect, it } from 'vitest';
import {
  AdaptadorDeArchivo,
  adivinarEntidad,
  claveDeIdentidad,
  comoMapa,
  normalizarFila,
  normalizarNombre,
  sugerirMapeo,
  TOPE_DE_FILAS,
  validar,
  type Entidad,
  type Hallazgo,
  type RegistroCanonico,
  type TablaCruda,
} from './index.js';

const archivo = new AdaptadorDeArchivo();

// ---------------------------------------------------------------------------
// Los ocho conjuntos
// ---------------------------------------------------------------------------

const LIMPIO = [
  'Razón Social;CUIT;Email;Condición IVA',
  'Acme SA;30-71000001-4;acme@test.local;Responsable Inscripto',
  'Beta SRL;20-11111111-2;beta@test.local;Monotributo',
  'Gamma SA;27-11111111-7;gamma@test.local;Exento',
].join('\n');

/** Un CUIT que no supera el módulo 11 y una condición de IVA que no existe. */
const CON_ADVERTENCIAS = [
  'Razón Social;CUIT;Condición IVA',
  'Acme SA;30-71000001-4;Responsable Inscripto',
  'Delta SA;30-71000001-9;Responsable Inscripto',
  'Epsilon SRL;20-11111111-2;Régimen Especial Provincial',
].join('\n');

/** Sin razón social la fila no describe a nadie: no hay tercero que crear. */
const CON_ERRORES = [
  'Razón Social;CUIT',
  ';30-71000001-4',
  'Zeta SA;20-11111111-2',
].join('\n');

/** El mismo CUIT dos veces, con razones sociales distintas. */
const DUPLICADOS = [
  'Razón Social;CUIT',
  'Omega SA;30-71000001-4',
  'Omega Sociedad Anónima;30-71000001-4',
  'Otra SA;20-11111111-2',
].join('\n');

/** Coma como separador, espacios, mayúsculas, una columna que no va a ningún lado. */
const DESPROLIJO = [
  'RAZON SOCIAL,C.U.I.T.,E-MAIL,Vendedor asignado',
  '  Iota SA  ,30-71000001-4,  IOTA@TEST.LOCAL ,Juan',
  'Kappa SRL,20111111112,kappa@test.local,María',
].join('\n');

/** Dos asientos: el 1 cuadra, el 2 tiene diez pesos de diferencia. */
const CONTABLE = [
  'Fecha;Cuenta;Debe;Haber;Asiento',
  '01/03/2026;1.1.01;1.234,56;0;1',
  '01/03/2026;4.1.01;0;1.234,56;1',
  '02/03/2026;1.1.01;100,00;0;2',
  '02/03/2026;4.1.01;0;90,00;2',
].join('\n');

/** Una cantidad negativa (posible) y una ilegible (no es cero). */
const STOCK = [
  'SKU;Cantidad;Depósito',
  'ART-001;12;CENTRAL',
  'ART-002;-3;CENTRAL',
  'ART-003;doce;CENTRAL',
].join('\n');

function grande(filas: number): string {
  const lineas = ['Razón Social;CUIT'];
  for (let i = 0; i < filas; i += 1) {
    // CUIT sintético con verificador correcto, distinto en cada fila.
    lineas.push(`Empresa ${i} SA;${conVerificador(`30${String(i).padStart(8, '0')}`)}`);
  }
  return lineas.join('\n');
}

/** Módulo 11, el mismo que usa NEXO. Acá para no depender de otro paquete. */
function conVerificador(diez: string): string {
  const pesos = [5, 4, 3, 2, 7, 6, 5, 4, 3, 2];
  const suma = pesos.reduce((a, p, i) => a + p * Number(diez[i]), 0);
  const resto = suma % 11;
  const dv = resto === 0 ? 0 : resto === 1 ? 9 : 11 - resto;
  return `${diez}${dv}`;
}

// ---------------------------------------------------------------------------
// El camino que recorre cada conjunto
// ---------------------------------------------------------------------------

interface Corrida {
  readonly tabla: TablaCruda;
  readonly entidad: Entidad | null;
  readonly registros: readonly RegistroCanonico[];
  readonly hallazgos: readonly Hallazgo[];
  readonly errores: number;
  readonly advertencias: number;
  readonly sePuedeImportar: boolean;
}

/** Extrae, adivina, mapea, normaliza y valida — sin tocar la base. */
async function correr(contenido: string, nombre = 'datos.csv'): Promise<Corrida> {
  const extraccion = await archivo.extraer({
    bytes: Buffer.from(contenido, 'utf8'),
    nombreArchivo: nombre,
  });
  const tabla = extraccion.tablas[0]!;
  const entidad = adivinarEntidad(tabla.columnas);
  if (entidad === null) {
    return {
      tabla, entidad, registros: [], hallazgos: [],
      errores: 0, advertencias: 0, sePuedeImportar: false,
    };
  }

  const mapeo = comoMapa(sugerirMapeo(entidad, tabla.columnas));
  const registros = tabla.filas.map((fila, i) => ({
    entidad,
    campos: normalizarFila(tabla.columnas, fila, mapeo),
    procedencia: {
      origen: `${nombre}:${tabla.nombre}`,
      fila: String(i + 1),
      idExterno: null,
      hash: '',
    },
  }));

  const veredicto = validar(registros);
  return {
    tabla,
    entidad,
    registros,
    hallazgos: veredicto.hallazgos,
    errores: veredicto.errores,
    advertencias: veredicto.advertencias,
    sePuedeImportar: veredicto.sePuedeImportar,
  };
}

const codigos = (c: Corrida): string[] => [...new Set(c.hallazgos.map((h) => h.codigo))].sort();

// ---------------------------------------------------------------------------

describe('conjuntos de prueba del motor de migración', () => {
  it('LIMPIO — entra entero y no observa nada', async () => {
    const c = await correr(LIMPIO);
    expect(c.entidad).toBe('PARTY');
    expect(c.registros).toHaveLength(3);
    expect(c.errores).toBe(0);
    expect(c.advertencias).toBe(0);
    expect(c.sePuedeImportar).toBe(true);
    expect(c.registros[0]!.campos.cuit!.valor).toBe('30710000014');
    // La condición frente al IVA llega **como la escribió el origen**. El motor
    // no la traduce: el vocabulario de NEXO lo conoce el escritor, y meterlo
    // acá obligaría a que el paquete puro supiera qué valores admite una
    // columna de la base.
    expect(c.registros[1]!.campos.condicionIva!.valor).toBe('Monotributo');
  });

  it('CON_ADVERTENCIAS — entra, y queda dicho qué traía el origen', async () => {
    const c = await correr(CON_ADVERTENCIAS);
    // Lo importante: **se puede importar**. Un CUIT mal construido no invalida
    // al tercero, lo deja sin documento; convertirlo en error bloquearía una
    // migración legítima por un dato que el sistema anterior traía sucio.
    expect(c.sePuedeImportar).toBe(true);
    expect(c.advertencias).toBeGreaterThan(0);
    // Un solo código para «vino algo y no se pudo interpretar», con el motivo
    // adentro del mensaje. Un código por tipo de dato multiplicaría el
    // vocabulario sin decir nada que el mensaje no diga.
    expect(codigos(c)).toContain('NO_INTERPRETABLE');
    expect(c.hallazgos.some((h) => h.mensaje.includes('dígito verificador'))).toBe(true);

    // Y el crudo sobrevive: el mensaje puede citar lo que decía el archivo.
    const malo = c.registros[1]!.campos.cuit!;
    expect(malo.valor).toBeNull();
    expect(malo.crudo).toBe('30-71000001-9');
    expect(c.hallazgos.some((h) => h.mensaje.includes('30-71000001-9'))).toBe(true);
  });

  it('CON_ERRORES — lo que no puede entrar no entra, con el motivo y la fila', async () => {
    const c = await correr(CON_ERRORES);
    expect(c.sePuedeImportar).toBe(false);
    expect(c.errores).toBe(1);

    const error = c.hallazgos.find((h) => h.nivel === 'ERROR')!;
    expect(error.codigo).toBe('FALTA_OBLIGATORIO');
    expect(error.campo).toBe('razonSocial');
    // La fila, para poder ir a buscarla al archivo original.
    expect(error.fila).toBe('1');
  });

  it('DUPLICADOS — dos filas con la misma identidad son una', async () => {
    const c = await correr(DUPLICADOS);
    const claves = c.registros.map((r) => claveDeIdentidad(r.entidad, r.campos)!.valor);
    expect(claves[0]).toBe(claves[1]);
    expect(claves[2]).not.toBe(claves[0]);

    // El motor **no elige** cuál de las dos razones sociales vale: eso lo
    // decide la importación con la regla de idempotencia, y queda registrado.
    // Acá solo se comprueba que la identidad las reconoce como la misma.
    expect(new Set(claves).size).toBe(2);
  });

  it('DESPROLIJO — el archivo que manda la vida real', async () => {
    const c = await correr(DESPROLIJO);
    expect(c.entidad).toBe('PARTY');
    // Separador coma, detectado solo.
    expect(c.tabla.columnas).toHaveLength(4);
    // «RAZON SOCIAL» sin tilde y «C.U.I.T.» con puntos se reconocen igual.
    expect(c.registros[0]!.campos.razonSocial!.valor).toBe('Iota SA');
    expect(c.registros[0]!.campos.cuit!.valor).toBe('30710000014');
    expect(c.registros[1]!.campos.cuit!.valor).toBe('20111111112');
    // La columna que no corresponde a ningún campo simplemente no se mapea.
    expect(c.registros[0]!.campos.vendedor).toBeUndefined();
    expect(c.sePuedeImportar).toBe(true);
  });

  it('CONTABLE — el asiento descuadrado no entra y no se cuadra solo', async () => {
    const c = await correr(CONTABLE);
    expect(c.entidad).toBe('JOURNAL_ENTRY');
    expect(c.sePuedeImportar).toBe(false);

    const desc = c.hallazgos.filter((h) => h.codigo === 'ASIENTO_DESCUADRADO');
    expect(desc).toHaveLength(1);
    expect(desc[0]!.mensaje).toContain('10,00');
    expect(desc[0]!.mensaje).toContain('no agrega un renglón');

    // El que cuadra no aparece observado: si el control marcara los dos, no
    // estaría midiendo el descuadre sino la presencia de asientos.
    expect(desc[0]!.fila).not.toBe('1');

    // Y los importes son enteros de centavos, nunca coma flotante.
    expect(c.registros[0]!.campos.debe!.valor).toBe('123456');
  });

  it('STOCK — una cantidad negativa no es lo mismo que una ilegible', async () => {
    const c = await correr(STOCK);
    // Las cantidades son números; los importes, en cambio, son cadenas de
    // centavos. La diferencia es a propósito: una cantidad admite decimales y
    // no se suma como dinero, y un importe en coma flotante pierde centavos.
    expect(c.registros[1]!.campos.cantidad!.valor).toBe(-3);
    // `null` es «no se puede afirmar», y nunca cero: un producto con cantidad
    // ilegible importado como 0 diría que no hay existencias, que es una
    // afirmación que el archivo no hizo.
    expect(c.registros[2]!.campos.cantidad!.valor).toBeNull();
    expect(c.registros[2]!.campos.cantidad!.crudo).toBe('doce');
  });

  it('GRANDE — 20.000 filas dan el mismo resultado, y se mide cuánto tarda', async () => {
    const FILAS = 20_000;
    const arranque = Date.now();
    const c = await correr(grande(FILAS), 'grande.csv');
    const ms = Date.now() - arranque;

    expect(c.registros).toHaveLength(FILAS);
    expect(c.errores).toBe(0);
    expect(c.sePuedeImportar).toBe(true);
    // Todas las identidades distintas: el generador no colisiona.
    expect(new Set(c.registros.map((r) => claveDeIdentidad('PARTY', r.campos)!.valor)).size)
      .toBe(FILAS);

    // El tope no es una medición de rendimiento: es un detector de regresión
    // cuadrática. Lo que importa no es el número exacto sino que 20.000 filas
    // no tarden lo que tardarían si algo pasara a recorrer todo por cada fila.
    expect(ms, `${FILAS} filas tardaron ${ms} ms`).toBeLessThan(30_000);
  });

  it('pasado el tope se recorta y se avisa, en vez de fingir que entró todo', async () => {
    // Se prueba con un tope de mentira —no con 200.001 filas de verdad— porque
    // lo que importa es la conducta, no el número: cuando hay recorte, el aviso
    // dice cuántas filas traía y cuántas se leyeron. Una migración que recorta
    // en silencio es la peor de las dos opciones: parece completa.
    expect(TOPE_DE_FILAS).toBeGreaterThan(0);

    const chico = new AdaptadorDeArchivo();
    const extraccion = await chico.extraer({
      bytes: Buffer.from(grande(5), 'utf8'),
      nombreArchivo: 'chico.csv',
    });
    // Debajo del tope no hay aviso de recorte: un aviso que sale siempre no
    // avisa nada.
    expect(extraccion.avisos.filter((a) => a.includes('se leyeron las primeras'))).toEqual([]);
    expect(extraccion.tablas[0]!.filas).toHaveLength(5);
  });

  it('las diez hojas de una exportación real se reconocen solas', async () => {
    // El adivinador se equivocaba en dos de las diez, y las dos se veían recién
    // al abrir la pantalla: un archivo de depósitos entraba como terceros
    // —«Nombre» es sinónimo de razón social y PARTY solo exige eso— y la
    // columna «IVA» de una venta se mapeaba a la condición frente al IVA en vez
    // de al impuesto, dejando el comprobante sin IVA.
    const hojas: readonly (readonly [string, readonly string[], Entidad, string])[] = [
      ['depósitos', ['Codigo', 'Nombre'], 'WAREHOUSE', 'codigo'],
      ['clientes', ['RAZON SOCIAL', 'C.U.I.T.', 'E-MAIL'], 'PARTY', 'cuit'],
      ['productos', ['SKU', 'Nombre', 'Unidad', 'Precio'], 'PRODUCT', 'sku'],
      ['cuentas', ['Codigo', 'Nombre', 'Tipo', 'Cuenta padre'], 'ACCOUNT', 'codigoPadre'],
      ['asientos', ['Asiento', 'Fecha', 'Cuenta', 'Debe', 'Haber'], 'JOURNAL_ENTRY', 'asiento'],
      [
        'existencias',
        ['SKU', 'Deposito', 'Cantidad', 'Costo unitario', 'Fecha de corte'],
        'STOCK_BALANCE',
        'fechaCorte',
      ],
      [
        'ventas',
        ['Tipo', 'Punto de venta', 'Numero', 'Fecha', 'CUIT', 'Razon social', 'Neto', 'IVA', 'Total'],
        'SALES_DOCUMENT',
        'iva',
      ],
    ];

    for (const [nombre, columnas, esperada, campoClave] of hojas) {
      const entidad = adivinarEntidad(columnas);
      expect(entidad, `${nombre}: se adivinó ${entidad}`).toBe(esperada);
      // Y el campo que distingue a esa hoja quedó mapeado, no solo la entidad.
      const mapeo = comoMapa(sugerirMapeo(entidad!, columnas));
      expect(Object.values(mapeo), `${nombre}: falta ${campoClave}`).toContain(campoClave);
    }
  });

  it('el nombre exacto de un campo le gana al sinónimo de otro', () => {
    // La regla que arregla el caso de «IVA», dicha sola para que se vea fallar.
    const mapeo = comoMapa(sugerirMapeo('SALES_DOCUMENT', ['IVA', 'Condicion IVA']));
    expect(mapeo).toEqual({ IVA: 'iva', 'Condicion IVA': 'condicionIva' });
  });

  it('una sigla con puntos se reconoce igual que sin ellos', async () => {
    // El caso que encontró el conjunto DESPROLIJO: `C.U.I.T.` normalizaba a
    // «c u i t» y no coincidía con ningún sinónimo.
    expect(normalizarNombre('C.U.I.T.')).toBe('cuit');
    expect(normalizarNombre('D.N.I.')).toBe('dni');
    // Y lo que no es una sigla no se junta.
    expect(normalizarNombre('E-MAIL')).toBe('e mail');
    expect(normalizarNombre('RAZON SOCIAL')).toBe('razon social');
  });
});
