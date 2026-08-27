import { describe, expect, it } from 'vitest';
import { deflateRawSync } from 'node:zlib';
import { ingerir, type EntradaIngesta } from './ingest.js';
import { InMemoryDocumentStore, claveDe, claveEsDeEmpresa } from './storage.js';
import { MockOcrEngine, degradar, paginaDeTexto } from './ocr/mock-engine.js';
import { NullOcrEngine } from './ocr/engine.js';
import { sniff, verificarCoherencia } from './sniff.js';
import { leerCsv, leerXlsx } from './readers/tabular.js';
import { leerXml } from './readers/xml.js';
import { bloqueaAprobacion, controlarCoherencia, importeDe } from './coherencia.js';
import { bloqueaImputacion, detectarDuplicados, type HuellaDocumento } from './duplicates.js';
import { calcularMetricas, reporteMarkdown } from './metrics.js';
import { tipoComprobanteSemilla } from './catalogo.js';
import type { CampoExtraido } from './types.js';

const EMPRESA = '018f3a2b-4c5d-7e8f-9a0b-1c2d3e4f5a6b';
const OTRA_EMPRESA = '018f3a2b-4c5d-7e8f-9a0b-000000000000';

// ---------------------------------------------------------------------------
// Documentos de prueba
// ---------------------------------------------------------------------------

/** CUIT con dígito verificador correcto. El `-9` no lo es: sirve de contraejemplo. */
const CUIT_VALIDO = '30-71234567-1';
const CUIT_INVALIDO = '30-71234567-9';

const FACTURA_LINEAS = [
  'FACTURA',
  'A',
  'PROVEEDOR DEMO SA',
  `CUIT: ${CUIT_VALIDO}`,
  'Comp. Nro: 0012-00000045',
  'Fecha de Emisión: 05/03/2026',
  'Descripción                      Importe',
  'Servicio de consultoría          1.019,83',
  'Importe Neto Gravado: $ 1.019,83',
  'IVA 21%: $ 214,17',
  'Importe Total: $ 1.234,00',
  'CAE N°: 75123456789012',
];

/**
 * El encabezado tal como lo imprime un comprobante de ARCA.
 *
 * La diferencia con `FACTURA_LINEAS` es una sola línea, y es la que importa:
 * ARCA **no** imprime `0010-00000001`. Imprime punto de venta y número como dos
 * campos etiquetados en la misma línea.
 */
const FACTURA_LINEAS_ARCA = [
  'LIBRERÍA CENTRAL SRL',
  'FACTURA',
  'B',
  'Cod. 06',
  'Punto de Venta:   0010      Comp. Nro:   00000001',
  'Fecha de Emisión:   27/06/2025',
  `CUIT:   ${CUIT_VALIDO}`,
  'Subtotal:  $ 1,015,000.00',
  'Importe Total:  $ 1,015,000.00',
  'CAE:   65169642435761',
  'Fecha de Vto. de CAE:   07/07/2025',
];

function pdfDePrueba(marca: string, extra = ''): Buffer {
  return Buffer.from(`%PDF-1.4 ${marca}${extra}`);
}

function ocrCon(lineas: readonly string[], marca: string, confianza = 0.95): MockOcrEngine {
  return new MockOcrEngine({
    escenarios: new Map([
      [`%PDF-1.4 ${marca}`, { paginas: [paginaDeTexto(1, lineas, confianza)] }],
    ]),
  });
}

function entrada(bytes: Buffer, nombre: string): EntradaIngesta {
  return { companyId: EMPRESA, nombreOriginal: nombre, origen: 'UPLOAD', bytes };
}

function campo(campos: readonly CampoExtraido[], fieldPath: string): CampoExtraido {
  const encontrado = campos.find((candidato) => candidato.fieldPath === fieldPath);
  if (encontrado === undefined) throw new Error(`Falta el campo ${fieldPath}`);
  return encontrado;
}

// ---------------------------------------------------------------------------
// Detección de tipo
// ---------------------------------------------------------------------------

describe('detección del tipo por contenido', () => {
  it('reconoce los tipos admitidos por su firma', () => {
    expect(sniff(Buffer.from('%PDF-1.7 x'), 'a.pdf').tipo).toBe('PDF');
    expect(sniff(Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0x00]), 'a.jpg').tipo).toBe('JPEG');
    expect(
      sniff(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00]), 'a.png').tipo,
    ).toBe('PNG');
    expect(sniff(Buffer.from('<?xml version="1.0"?><a/>'), 'a.xml').tipo).toBe('XML');
    expect(sniff(Buffer.from('a;b;c\n1;2;3\n'), 'a.csv').tipo).toBe('CSV');
  });

  it('registra los PDF que ejecutan algo al abrirse, sin bloquearlos', () => {
    const resultado = sniff(Buffer.from('%PDF-1.4 /OpenAction /JavaScript'), 'a.pdf');
    expect(resultado.tipo).toBe('PDF');
    expect(resultado.riesgos.map((riesgo) => riesgo.codigo)).toContain('PDF_ACTIVO');
    expect(resultado.riesgos).toHaveLength(2);
  });

  it('no procesa un XML con DOCTYPE ni entidades', () => {
    const bomba = Buffer.from('<?xml version="1.0"?><!DOCTYPE a [<!ENTITY x "y">]><a>&x;</a>');
    const resultado = sniff(bomba, 'a.xml');
    expect(resultado.tipo).toBe('DESCONOCIDO');
    expect(resultado.riesgos[0]?.codigo).toBe('XML_CON_DOCTYPE');
  });

  it('no acepta un ZIP cualquiera como planilla', () => {
    expect(sniff(Buffer.from('PKcualquier cosa'), 'a.xlsx').tipo).toBe('DESCONOCIDO');
  });

  it('detecta cuando lo declarado no coincide con lo real', () => {
    expect(verificarCoherencia('PDF', 'factura.pdf', 'application/pdf')).toBeNull();
    expect(verificarCoherencia('PNG', 'factura.pdf', undefined)).toMatch(/se llama \.pdf/);
    expect(verificarCoherencia('PDF', 'factura.pdf', 'image/png')).toMatch(/declaró image\/png/);
  });
});

// ---------------------------------------------------------------------------
// Almacenamiento
// ---------------------------------------------------------------------------

describe('almacenamiento', () => {
  const hash = 'a'.repeat(64);

  it('deriva la clave de la empresa y el hash', () => {
    const clave = claveDe(EMPRESA, hash, 'pdf');
    expect(clave).toBe(`empresa/${EMPRESA}/aa/${hash}.pdf`);
    expect(claveEsDeEmpresa(EMPRESA, clave)).toBe(true);
  });

  it('rechaza una clave de otra empresa y cualquier travesía', () => {
    const clave = claveDe(EMPRESA, hash, 'pdf');
    expect(claveEsDeEmpresa(OTRA_EMPRESA, clave)).toBe(false);
    expect(claveEsDeEmpresa(EMPRESA, `empresa/${EMPRESA}/../../etc/passwd`)).toBe(false);
  });

  it('no deja leer el objeto de otra empresa aunque se conozca la clave', async () => {
    const store = new InMemoryDocumentStore();
    const clave = await store.put(EMPRESA, hash, 'pdf', Buffer.from('secreto'));
    await expect(store.get(OTRA_EMPRESA, clave)).rejects.toThrow(/no pertenece/);
  });

  it('deduplica dentro de la empresa pero NO entre empresas', async () => {
    const store = new InMemoryDocumentStore();
    const bytes = Buffer.from('mismo contenido');
    const hashReal = 'b'.repeat(64);

    await store.put(EMPRESA, hashReal, 'pdf', bytes);
    await store.put(EMPRESA, hashReal, 'pdf', bytes);
    expect(store.tamaño).toBe(1);

    // El mismo archivo en otra empresa es otro objeto: compartirlo revelaría que
    // alguien más lo tiene.
    await store.put(OTRA_EMPRESA, hashReal, 'pdf', bytes);
    expect(store.tamaño).toBe(2);
  });
});

// ---------------------------------------------------------------------------
// Pipeline
// ---------------------------------------------------------------------------

describe('pipeline de ingesta', () => {
  it('archiva el documento aunque no haya ningún motor de OCR', async () => {
    const store = new InMemoryDocumentStore();
    const bytes = pdfDePrueba('sin-ocr');
    const resultado = await ingerir(entrada(bytes, 'factura.pdf'), {
      store,
      ocr: new NullOcrEngine(),
    });

    expect(resultado.ok).toBe(true);
    if (!resultado.ok) return;

    // El archivo está guardado y recuperable...
    expect(await store.has(EMPRESA, resultado.documento.storageKey)).toBe(true);
    // ...y la falta de OCR se informa, no se disfraza de "no se encontró nada".
    expect(resultado.extraccion.disponible).toBe(false);
    expect(resultado.extraccion.motivoNoDisponible).toBe('SIN_MOTOR_OCR');
    expect(resultado.extraccion.campos).toHaveLength(0);
  });

  it('un encabezado de tabla no produce un importe con cero dígitos', async () => {
    // El patrón de importe aceptaba un match sin ningún dígito, así que sobre
    //
    //     Producto / Servicio  Cant.  Precio Unit.  Subtotal
    //
    // la etiqueta `subtotal` matcheaba y el valor capturado era el punto de
    // "Cant.". `importes.neto` salía con rawValue "." — basura a la vista de
    // quien revisa, y en otra línea podría haber sido un número parcial.
    //
    // La respuesta correcta para una Factura C, que no discrimina neto, es que
    // el campo no se encontró.
    const resultado = await ingerir(entrada(pdfDePrueba('ok'), 'tabla.pdf'), {
      store: new InMemoryDocumentStore(),
      ocr: ocrCon(
        [
          'FACTURA',
          'C',
          'Producto / Servicio  Cant.  Precio Unit.  Subtotal',
          'Cartuchos de tinta  3  $ 1.215,51  $ 3.646,53',
          'Importe Total:  $ 3.646,53',
        ],
        'ok',
      ),
    });

    expect(resultado.ok).toBe(true);
    if (!resultado.ok) return;

    const neto = campo(resultado.extraccion.campos, 'importes.neto');
    expect(neto.rawValue).toBeNull();
    expect(neto.nota).toMatch(/No se encontró la etiqueta/);

    // Y el total, que sí está etiquetado, se lee igual.
    expect(campo(resultado.extraccion.campos, 'importes.total').parsedValue).toEqual({
      kind: 'MONEY',
      amount: '364653',
      currency: 'ARS',
    });
  });

  it('lee el punto de venta y el número tal como los imprime ARCA', async () => {
    // Este test existe por un defecto que encontró un lote de cincuenta
    // comprobantes con el layout real: los cincuenta dieron
    // `comprobante.identificacion` sin leer.
    //
    // Lo llamativo era dónde estaba la falla. `parsePuntoVentaYNumero` sabía leer
    // esta forma desde el primer día; el que no la reconocía era el **lector**,
    // cuyo patrón exigía un guión y por lo tanto nunca le entregaba la línea al
    // parser. Un parser correcto detrás de un lector que no lo llama se ve, desde
    // afuera, igual que un parser roto.
    const resultado = await ingerir(entrada(pdfDePrueba('ok'), 'factura-arca.pdf'), {
      store: new InMemoryDocumentStore(),
      ocr: ocrCon(FACTURA_LINEAS_ARCA, 'ok'),
    });

    expect(resultado.ok).toBe(true);
    if (!resultado.ok) return;

    expect(campo(resultado.extraccion.campos, 'comprobante.identificacion').parsedValue).toEqual({
      kind: 'TEXT',
      value: '00010-00000001',
    });
  });

  it('extrae los campos de una factura legible', async () => {
    const resultado = await ingerir(entrada(pdfDePrueba('ok'), 'factura.pdf'), {
      store: new InMemoryDocumentStore(),
      ocr: ocrCon(FACTURA_LINEAS, 'ok'),
    });

    expect(resultado.ok).toBe(true);
    if (!resultado.ok) return;
    const campos = resultado.extraccion.campos;

    expect(campo(campos, 'emisor.cuit').parsedValue).toEqual({
      kind: 'CUIT',
      value: '30712345671',
    });
    expect(campo(campos, 'comprobante.fecha').parsedValue).toEqual({
      kind: 'DATE',
      value: '2026-03-05',
    });
    expect(campo(campos, 'comprobante.identificacion').parsedValue).toEqual({
      kind: 'TEXT',
      value: '00012-00000045',
    });
    expect(campo(campos, 'comprobante.codigoAutorizacion').parsedValue).toEqual({
      kind: 'TEXT',
      value: '75123456789012',
    });
    expect(campo(campos, 'importes.total').parsedValue).toEqual({
      kind: 'MONEY',
      amount: '123400',
      currency: 'ARS',
    });

    // Los cuatro campos del §10 viajan completos.
    const total = campo(campos, 'importes.total');
    expect(total.rawValue).toBe('1.234,00');
    expect(total.method).toBe('REGEX');
    expect(total.confidence).toBeGreaterThan(0);
    expect(total.page).toBe(1);

    // La aritmética del comprobante cierra: sin hallazgos bloqueantes.
    expect(bloqueaAprobacion(resultado.hallazgos)).toBe(false);
  });

  it('conserva la lectura cuando no puede interpretarla', async () => {
    const lineas = [
      ...FACTURA_LINEAS.slice(0, 3),
      `CUIT: ${CUIT_INVALIDO}`,
      ...FACTURA_LINEAS.slice(4, 10),
      // El OCR se comió los centavos: queda un número genuinamente ambiguo.
      'Importe Total: $ 1.234',
      // Y un dígito del CAE.
      'CAE N°: 7512345678901',
    ];
    const resultado = await ingerir(entrada(pdfDePrueba('dudoso'), 'factura.pdf'), {
      store: new InMemoryDocumentStore(),
      ocr: ocrCon(lineas, 'dudoso'),
    });

    expect(resultado.ok).toBe(true);
    if (!resultado.ok) return;
    const campos = resultado.extraccion.campos;

    const cuit = campo(campos, 'emisor.cuit');
    expect(cuit.rawValue).toBe(CUIT_INVALIDO);
    expect(cuit.parsedValue).toBeNull();
    expect(cuit.nota).toMatch(/dígito de control/);

    const total = campo(campos, 'importes.total');
    expect(total.rawValue).toBe('1.234');
    expect(total.parsedValue).toBeNull();
    expect(total.nota).toMatch(/no elige por el contador/);

    const cae = campo(campos, 'comprobante.codigoAutorizacion');
    expect(cae.rawValue).toBe('7512345678901');
    expect(cae.parsedValue).toBeNull();
    expect(cae.nota).toMatch(/13 dígitos/);

    // Y todo esto bloquea: un comprobante así no se imputa solo.
    expect(bloqueaAprobacion(resultado.hallazgos)).toBe(true);
  });

  it('distingue un campo ausente de un campo no buscado', async () => {
    const resultado = await ingerir(entrada(pdfDePrueba('parcial'), 'factura.pdf'), {
      store: new InMemoryDocumentStore(),
      ocr: ocrCon(['FACTURA', 'Importe Total: $ 100,00'], 'parcial'),
    });

    expect(resultado.ok).toBe(true);
    if (!resultado.ok) return;

    const fecha = campo(resultado.extraccion.campos, 'comprobante.fecha');
    expect(fecha.rawValue).toBeNull();
    expect(fecha.confidence).toBe(0);
    expect(fecha.nota).toMatch(/No se encontró/);
  });

  it('rechaza un archivo cuyo contenido no es el que declara', async () => {
    const png = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00]);
    const resultado = await ingerir(entrada(png, 'factura.pdf'), {
      store: new InMemoryDocumentStore(),
    });
    expect(resultado.ok).toBe(false);
    if (!resultado.ok) expect(resultado.motivo).toBe('TIPO_DECLARADO_NO_COINCIDE');
  });

  it('rechaza vacíos y excesos, pero informa el hash igual', async () => {
    const store = new InMemoryDocumentStore();
    const vacio = await ingerir(entrada(Buffer.alloc(0), 'a.pdf'), { store });
    expect(vacio.ok).toBe(false);
    if (!vacio.ok) {
      expect(vacio.motivo).toBe('ARCHIVO_VACIO');
      expect(vacio.sha256).toHaveLength(64);
    }

    const grande = await ingerir(entrada(pdfDePrueba('x'.repeat(100)), 'a.pdf'), {
      store,
      maxBytes: 10,
    });
    expect(grande.ok).toBe(false);
    if (!grande.ok) expect(grande.motivo).toBe('DEMASIADO_GRANDE');
  });

  it('informa el motivo cuando el motor de OCR se cae', async () => {
    const motorRoto = {
      nombre: 'roto',
      version: '1',
      soporta: () => true,
      reconocer: () => Promise.reject(new Error('sin cuota')),
    };
    const resultado = await ingerir(entrada(pdfDePrueba('roto'), 'a.pdf'), {
      store: new InMemoryDocumentStore(),
      ocr: motorRoto,
    });
    expect(resultado.ok).toBe(true);
    if (!resultado.ok) return;
    expect(resultado.extraccion.disponible).toBe(false);
    expect(resultado.extraccion.motivoNoDisponible).toBe('MOTOR_FALLO');
  });

  it('archiva las planillas sin aplicarles las reglas de comprobante', async () => {
    const csv = Buffer.from('fecha;concepto;importe\n05/03/2026;Pago;1.234,00\n');
    const resultado = await ingerir(entrada(csv, 'extracto.csv'), {
      store: new InMemoryDocumentStore(),
    });
    expect(resultado.ok).toBe(true);
    if (!resultado.ok) return;
    expect(resultado.documento.tipo).toBe('CSV');
    expect(resultado.extraccion.motivoNoDisponible).toBe('TIPO_NO_SOPORTADO');
  });
});

// ---------------------------------------------------------------------------
// XML
// ---------------------------------------------------------------------------

describe('lectura de XML con la nomenclatura de los web services', () => {
  const XML = `<?xml version="1.0" encoding="UTF-8"?>
<Comprobante>
  <Cuit>30712345671</Cuit>
  <CbteTipo>1</CbteTipo>
  <PtoVta>12</PtoVta>
  <CbteNro>45</CbteNro>
  <CbteFch>20260305</CbteFch>
  <ImpNeto>1019.83</ImpNeto>
  <ImpIVA>214.17</ImpIVA>
  <ImpTotal>1234.00</ImpTotal>
  <CAE>75123456789012</CAE>
</Comprobante>`;

  it('interpreta los campos con confianza de dato estructurado', async () => {
    const resultado = await ingerir(entrada(Buffer.from(XML), 'comprobante.xml'), {
      store: new InMemoryDocumentStore(),
    });
    expect(resultado.ok).toBe(true);
    if (!resultado.ok) return;

    const campos = resultado.extraccion.campos;
    expect(campo(campos, 'importes.total').parsedValue).toEqual({
      kind: 'MONEY',
      amount: '123400',
      currency: 'ARS',
    });
    // Un XML sí puede llegar a 1: es un campo, no una lectura de imagen.
    expect(campo(campos, 'importes.total').confidence).toBe(1);
    expect(campo(campos, 'comprobante.fecha').parsedValue).toEqual({
      kind: 'DATE',
      value: '2026-03-05',
    });
  });

  it('arma la clave lógica del comprobante cuando tiene los cuatro componentes', async () => {
    const primero = await ingerir(entrada(Buffer.from(XML), 'a.xml'), {
      store: new InMemoryDocumentStore(),
      documentIdNuevo: 'doc-1',
    });
    expect(primero.ok).toBe(true);
    if (!primero.ok) return;
    expect(primero.duplicados).toHaveLength(0);

    // Mismo comprobante, archivo distinto: se detecta y bloquea.
    const otroArchivo = `${XML}\n<!-- rescaneo -->`;
    const segundo = await ingerir(entrada(Buffer.from(otroArchivo), 'b.xml'), {
      store: new InMemoryDocumentStore(),
      documentIdNuevo: 'doc-2',
      huellas: {
        huellasDe: async () => [
          {
            documentId: 'doc-1',
            sha256: 'z'.repeat(64),
            claveLogica: {
              cuitEmisor: '30712345671',
              tipoComprobante: 1,
              puntoVenta: 12,
              numero: 45,
            },
          },
        ],
      },
    });
    expect(segundo.ok).toBe(true);
    if (!segundo.ok) return;
    expect(segundo.duplicados[0]?.nivel).toBe('COMPROBANTE_REPETIDO');
    expect(bloqueaImputacion(segundo.duplicados)).toBe(true);
  });

  it('avisa qué elementos faltan en lugar de devolver un documento sin campos', () => {
    const leido = leerXml(Buffer.from('<?xml version="1.0"?><Otro><Cosa>1</Cosa></Otro>'));
    const total = leido.campos.find((c) => c.fieldPath === 'importes.total');
    expect(total?.rawValue).toBeNull();
    expect(total?.nota).toMatch(/ImpTotal/);
  });
});

// ---------------------------------------------------------------------------
// Tabulares
// ---------------------------------------------------------------------------

describe('lectura de CSV', () => {
  it('detecta el punto y coma, que es lo que usan los sistemas argentinos', () => {
    const tabla = leerCsv(Buffer.from('fecha;concepto;importe\n05/03/2026;Pago a cuenta;1.234,56\n'));
    expect(tabla.separador).toBe(';');
    expect(tabla.encabezados).toEqual(['fecha', 'concepto', 'importe']);
    // Con la coma como separador, el importe se habría partido en dos columnas.
    expect(tabla.filas[0]).toEqual(['05/03/2026', 'Pago a cuenta', '1.234,56']);
  });

  it('respeta las comillas y el BOM que escribe Excel', () => {
    const csv = Buffer.concat([
      Buffer.from([0xef, 0xbb, 0xbf]),
      Buffer.from('a,b\n"uno, con coma","dice ""hola"""\n'),
    ]);
    const tabla = leerCsv(csv);
    expect(tabla.encabezados).toEqual(['a', 'b']);
    expect(tabla.filas[0]).toEqual(['uno, con coma', 'dice "hola"']);
  });
});

describe('lectura de XLSX', () => {
  it('lee celdas de texto y deja los números como texto', () => {
    const xlsx = construirXlsx(
      ['fecha', 'concepto', 'importe'],
      [['05/03/2026', 'Pago', '1234.56']],
    );
    const tabla = leerXlsx(xlsx);
    expect(tabla.encabezados).toEqual(['fecha', 'concepto', 'importe']);
    // El importe llega como texto: nunca pasó por un flotante.
    expect(tabla.filas[0]?.[2]).toBe('1234.56');
  });

  it('no abre un ZIP que se expande por encima del límite', () => {
    const xlsx = construirXlsx(['a'], [['1']], { descomprimidoFalso: 0xffff_ffff });
    expect(() => leerXlsx(xlsx)).toThrow(/límite permitido/);
  });
});

// ---------------------------------------------------------------------------
// Coherencia y duplicados
// ---------------------------------------------------------------------------

describe('controles de coherencia', () => {
  const monetario = (fieldPath: string, amount: string, confidence = 0.9): CampoExtraido => ({
    fieldPath,
    rawValue: amount,
    parsedValue: { kind: 'MONEY', amount, currency: 'ARS' },
    confidence,
    method: 'REGEX',
  });

  it('detecta un total que no cierra aunque la confianza sea alta', () => {
    const campos = [
      monetario('importes.neto', '101983', 0.98),
      monetario('importes.iva', '21417', 0.98),
      monetario('importes.total', '133400', 0.98),
    ];
    const hallazgos = controlarCoherencia(campos);
    const error = hallazgos.find((hallazgo) => hallazgo.codigo === 'TOTAL_NO_CIERRA');
    expect(error).toBeDefined();
    expect(error?.bloquea).toBe(true);
    expect(bloqueaAprobacion(hallazgos)).toBe(true);
  });

  it('no reporta diferencia cuando la aritmética cierra', () => {
    const campos = [
      monetario('importes.neto', '101983'),
      monetario('importes.iva', '21417'),
      monetario('importes.total', '123400'),
    ];
    expect(controlarCoherencia(campos).some((h) => h.codigo === 'TOTAL_NO_CIERRA')).toBe(false);
  });

  it('marca la confianza baja en los campos que definen la imputación', () => {
    const hallazgos = controlarCoherencia([monetario('importes.total', '123400', 0.4)]);
    expect(hallazgos.some((hallazgo) => hallazgo.codigo === 'CONFIANZA_BAJA')).toBe(true);
  });

  it('reconstruye el importe sin pasar por punto flotante', () => {
    const campos = [monetario('importes.total', '9007199254740993')];
    // Un entero por encima de 2^53: si hubiera pasado por `number`, cambiaría.
    expect(importeDe(campos, 'importes.total')?.amount).toBe(9007199254740993n);
  });
});

describe('duplicados', () => {
  const base: HuellaDocumento = {
    documentId: 'nuevo',
    sha256: 'a'.repeat(64),
    total: '123400',
    moneda: 'ARS',
    fecha: '2026-03-05',
    cuitContraparte: '30712345671',
  };

  it('el mismo archivo no es un hecho contable nuevo, y no bloquea', () => {
    const coincidencias = detectarDuplicados(base, [{ ...base, documentId: 'viejo' }]);
    expect(coincidencias[0]?.nivel).toBe('ARCHIVO_IDENTICO');
    expect(bloqueaImputacion(coincidencias)).toBe(false);
  });

  it('el mismo comprobante en otro archivo sí bloquea', () => {
    const clave = {
      cuitEmisor: '30712345671',
      tipoComprobante: 1,
      puntoVenta: 12,
      numero: 45,
    };
    const coincidencias = detectarDuplicados({ ...base, claveLogica: clave }, [
      { ...base, documentId: 'viejo', sha256: 'b'.repeat(64), claveLogica: clave },
    ]);
    expect(coincidencias[0]?.nivel).toBe('COMPROBANTE_REPETIDO');
    expect(bloqueaImputacion(coincidencias)).toBe(true);
  });

  it('la sospecha por importe y fecha cercana advierte pero no bloquea', () => {
    const coincidencias = detectarDuplicados(base, [
      { ...base, documentId: 'viejo', sha256: 'b'.repeat(64), fecha: '2026-03-08' },
    ]);
    expect(coincidencias[0]?.nivel).toBe('POSIBLE_DUPLICADO');
    expect(bloqueaImputacion(coincidencias)).toBe(false);
  });

  it('no confunde comprobantes distintos del mismo proveedor', () => {
    const coincidencias = detectarDuplicados(base, [
      { ...base, documentId: 'viejo', sha256: 'b'.repeat(64), total: '999999' },
    ]);
    expect(coincidencias).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// Métricas
// ---------------------------------------------------------------------------

describe('métricas de extracción', () => {
  it('separa aciertos, errores silenciosos y abstenciones', () => {
    const reporte = calcularMetricas([
      {
        caso: { id: '1', esperado: { 'importes.total': '100 ARS' } },
        campos: [
          {
            fieldPath: 'importes.total',
            rawValue: '1,00',
            parsedValue: { kind: 'MONEY', amount: '100', currency: 'ARS' },
            confidence: 0.9,
            method: 'REGEX',
          },
        ],
      },
      {
        caso: { id: '2', esperado: { 'importes.total': '200 ARS' } },
        campos: [
          {
            fieldPath: 'importes.total',
            rawValue: '3,00',
            parsedValue: { kind: 'MONEY', amount: '300', currency: 'ARS' },
            confidence: 0.95,
            method: 'REGEX',
          },
        ],
      },
      {
        caso: { id: '3', esperado: { 'importes.total': '300 ARS' } },
        campos: [
          {
            fieldPath: 'importes.total',
            rawValue: '1.234',
            parsedValue: null,
            confidence: 0.3,
            method: 'REGEX',
          },
        ],
      },
    ]);

    const metrica = reporte.porCampo[0]!;
    expect(metrica).toMatchObject({
      intentos: 3,
      extraidos: 2,
      correctos: 1,
      incorrectos: 1,
      abstenciones: 1,
    });
    expect(metrica.tasaErrorSilencioso).toBeCloseTo(1 / 3, 4);
    // La confianza media del error es alta: la señal de que el puntaje no está
    // midiendo lo que dice medir.
    expect(metrica.confianzaMediaErrores).toBe(0.95);
  });

  it('cuenta como falso positivo extraer un campo que no estaba', () => {
    const reporte = calcularMetricas([
      {
        caso: { id: '1', esperado: { 'importes.iva': null } },
        campos: [
          {
            fieldPath: 'importes.iva',
            rawValue: '21',
            parsedValue: { kind: 'MONEY', amount: '2100', currency: 'ARS' },
            confidence: 0.8,
            method: 'REGEX',
          },
        ],
      },
    ]);
    expect(reporte.porCampo[0]?.falsosPositivos).toBe(1);
    expect(reporte.porCampo[0]?.intentos).toBe(0);
  });

  it('publica el reporte en Markdown', () => {
    const reporte = calcularMetricas([
      { caso: { id: '1', esperado: { 'importes.total': '100 ARS' } }, campos: [] },
    ]);
    const markdown = reporteMarkdown(reporte);
    expect(markdown).toMatch(/Error silencioso/);
    expect(markdown).toMatch(/`importes.total`/);
  });
});

// ---------------------------------------------------------------------------
// Catálogo
// ---------------------------------------------------------------------------

describe('catálogo de tipos de comprobante', () => {
  it('devuelve lo que está en la fuente archivada', () => {
    expect(tipoComprobanteSemilla(1)?.descripcion).toBe('Factura A');
    expect(tipoComprobanteSemilla(213)?.clase).toBe('NOTA_CREDITO');
  });

  it('NO inventa una descripción para un código que la fuente no describe', () => {
    // El manual menciona el 39 entre los comprobantes asociables, pero nunca dice
    // qué es. Inventarlo sería exactamente lo que el §30 prohíbe.
    expect(tipoComprobanteSemilla(39)).toBeNull();
    expect(tipoComprobanteSemilla(991)).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// Simulador de OCR
// ---------------------------------------------------------------------------

describe('mock de OCR', () => {
  it('sabe fallar, no solo devolver texto limpio', async () => {
    const motor = new MockOcrEngine();
    const sinEscenario = await motor.reconocer({ bytes: Buffer.from('x'), tipo: 'PDF' });
    expect(sinEscenario.disponible).toBe(false);
    expect(sinEscenario.motivo).toBe('DOCUMENTO_ILEGIBLE');

    const tipoAjeno = await motor.reconocer({ bytes: Buffer.from('x'), tipo: 'XML' });
    expect(tipoAjeno.motivo).toBe('TIPO_NO_SOPORTADO');
  });

  it('reproduce las confusiones típicas de un escaneo', () => {
    // 0/O, 1/l, 5/S, 8/B son los errores reales sobre comprobantes impresos.
    const degradado = degradar('75123456789012', 1);
    expect(degradado).not.toBe('75123456789012');
    expect(degradado).toMatch(/[OlSB]/);
  });
});

// ---------------------------------------------------------------------------
// Utilidades de prueba
// ---------------------------------------------------------------------------

/**
 * Construye un XLSX real —ZIP con deflate— para probar el lector de punta a
 * punta. Un fixture binario pegado en el repositorio no se podría auditar.
 */
function construirXlsx(
  encabezados: readonly string[],
  filas: readonly (readonly string[])[],
  opciones: { descomprimidoFalso?: number } = {},
): Buffer {
  const cadenas = [...encabezados, ...filas.flat()];
  const indice = new Map(cadenas.map((valor, i) => [valor, i]));

  const sharedStrings = `<?xml version="1.0"?><sst count="${cadenas.length}">${cadenas
    .map((valor) => `<si><t>${valor.replace(/&/g, '&amp;').replace(/</g, '&lt;')}</t></si>`)
    .join('')}</sst>`;

  const todas = [encabezados, ...filas];
  const hoja = `<?xml version="1.0"?><worksheet><sheetData>${todas
    .map(
      (fila, f) =>
        `<row r="${f + 1}">${fila
          .map(
            (valor, c) =>
              `<c r="${String.fromCharCode(65 + c)}${f + 1}" t="s"><v>${indice.get(valor)}</v></c>`,
          )
          .join('')}</row>`,
    )
    .join('')}</sheetData></worksheet>`;

  return escribirZip(
    [
      ['[Content_Types].xml', Buffer.from('<?xml version="1.0"?><Types/>')],
      ['xl/workbook.xml', Buffer.from('<?xml version="1.0"?><workbook/>')],
      ['xl/sharedStrings.xml', Buffer.from(sharedStrings)],
      ['xl/worksheets/sheet1.xml', Buffer.from(hoja)],
    ],
    opciones.descomprimidoFalso,
  );
}

function escribirZip(
  entradas: readonly (readonly [string, Buffer])[],
  descomprimidoFalso?: number,
): Buffer {
  const locales: Buffer[] = [];
  const centrales: Buffer[] = [];
  let offset = 0;

  for (const [nombre, contenido] of entradas) {
    const nombreBytes = Buffer.from(nombre, 'utf8');
    const comprimido = deflateRawSync(contenido);
    const declarado = descomprimidoFalso ?? contenido.length;

    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4); // versión necesaria
    local.writeUInt16LE(8, 8); // método: deflate
    local.writeUInt32LE(0, 14); // CRC: este lector no lo verifica
    local.writeUInt32LE(comprimido.length, 18);
    local.writeUInt32LE(declarado, 22);
    local.writeUInt16LE(nombreBytes.length, 26);
    locales.push(local, nombreBytes, comprimido);

    const central = Buffer.alloc(46);
    central.writeUInt32LE(0x02014b50, 0);
    central.writeUInt16LE(20, 6);
    central.writeUInt16LE(8, 10);
    central.writeUInt32LE(comprimido.length, 20);
    central.writeUInt32LE(declarado, 24);
    central.writeUInt16LE(nombreBytes.length, 28);
    central.writeUInt32LE(offset, 42);
    centrales.push(central, nombreBytes);

    offset += 30 + nombreBytes.length + comprimido.length;
  }

  const cuerpoCentral = Buffer.concat(centrales);
  const fin = Buffer.alloc(22);
  fin.writeUInt32LE(0x06054b50, 0);
  fin.writeUInt16LE(entradas.length, 8);
  fin.writeUInt16LE(entradas.length, 10);
  fin.writeUInt32LE(cuerpoCentral.length, 12);
  fin.writeUInt32LE(offset, 16);

  return Buffer.concat([...locales, cuerpoCentral, fin]);
}
