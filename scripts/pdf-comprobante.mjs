/**
 * Arma el PDF de un comprobante autorizado.
 *
 * El layout imita el de un comprobante de ARCA porque **eso es lo que se quiere
 * medir**: los cincuenta comprobantes anteriores encontraron un defecto del
 * lector justamente por tener el formato real —punto de venta y número como dos
 * campos etiquetados en la misma línea, no `0010-00000001`—. Un PDF con un
 * layout propio no habría encontrado nada.
 *
 * ## El QR, o su ausencia declarada
 *
 * Si `qr.ok` es `false` el PDF sale **sin QR y con la leyenda impresa en el lugar
 * donde iría**. No es una omisión silenciosa: quien mire el PDF ve que falta y
 * por qué.
 *
 * Un PDF sin QR es un comprobante incompleto y se nota a simple vista. Uno con un
 * QR armado con nombres de campo inventados parece completo, se imprime igual, y
 * el error solo aparece cuando alguien lo escanea.
 *
 * ## Sin valor fiscal, y dicho en el papel
 *
 * Estos comprobantes tienen CAE real de homologación y ningún efecto fiscal. La
 * leyenda va impresa en el PDF, no solo en la consola: un archivo que se copia a
 * otra carpeta pierde el contexto de la corrida que lo generó.
 */

import PDFDocument from 'pdfkit';
import QRCode from 'qrcode';
import { createWriteStream } from 'node:fs';

const SELLO = 'COMPROBANTE DE HOMOLOGACIÓN — SIN VALOR FISCAL';

const pesos = (valor) =>
  `$ ${valor.toLocaleString('es-AR', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;

const fecha = (aaaammdd) =>
  aaaammdd.length === 8
    ? `${aaaammdd.slice(6, 8)}/${aaaammdd.slice(4, 6)}/${aaaammdd.slice(0, 4)}`
    : aaaammdd;

/** Letra y código, del catálogo de ARCA. Solo los que este generador emite. */
const CLASES = {
  11: { letra: 'C', nombre: 'FACTURA' },
  12: { letra: 'C', nombre: 'NOTA DE DÉBITO' },
  13: { letra: 'C', nombre: 'NOTA DE CRÉDITO' },
  15: { letra: 'C', nombre: 'RECIBO' },
};

/**
 * Las líneas del comprobante, en el orden en que se imprimen.
 *
 * Existe para que el `.txt` que acompaña al PDF sea **exactamente** lo que el
 * PDF dice. Si la transcripción se armara aparte, el corpus mediría la capa de
 * interpretación contra un texto que el documento no tiene, y un error de
 * extracción se confundiría con una diferencia entre los dos archivos.
 */
export function lineasDelComprobante({ comprobante, emisor, items }) {
  const clase = CLASES[comprobante.cbteTipo] ?? { letra: '?', nombre: 'COMPROBANTE' };
  return [
    emisor.razonSocial,
    `Razón Social:   ${emisor.razonSocial}`,
    `Domicilio Comercial:   ${emisor.domicilio}`,
    `Condición frente al IVA:   ${emisor.condicionIva}`,
    clase.letra,
    `Cod. ${String(comprobante.cbteTipo).padStart(2, '0')}`,
    clase.nombre,
    `Punto de Venta:   ${String(comprobante.ptoVta).padStart(4, '0')}      Comp. Nro:   ${String(comprobante.cbteNro).padStart(8, '0')}`,
    `Fecha de Emisión:   ${fecha(comprobante.cbteFch)}`,
    `CUIT:   ${comprobante.cuitEmisor}`,
    comprobante.docTipo === 99
      ? 'CUIT / DNI:   —      Apellido y Nombre / Razón Social:   CONSUMIDOR FINAL'
      : `CUIT / DNI:   ${comprobante.docNro}`,
    'Condición frente al IVA:   Consumidor Final',
    'Producto / Servicio  Cant.  Precio Unit.  Subtotal',
    ...items.map(
      (i) => `${i.descripcion}  ${i.cantidad}  ${pesos(i.unitario)}  ${pesos(i.subtotal)}`,
    ),
    `Importe Total:  ${pesos(comprobante.impTotal)}`,
    `CAE:   ${comprobante.cae}`,
    `Fecha de Vto. de CAE:   ${fecha(comprobante.caeFchVto)}`,
    SELLO,
  ];
}

export async function armarPdf(ruta, { comprobante, emisor, items, qr }) {
  const clase = CLASES[comprobante.cbteTipo] ?? { letra: '?', nombre: 'COMPROBANTE' };

  const doc = new PDFDocument({ size: 'A4', margin: 40 });
  const salida = createWriteStream(ruta);
  doc.pipe(salida);

  // --- Encabezado ---------------------------------------------------------
  doc.rect(40, 40, 515, 110).stroke('#666');
  doc.moveTo(297, 40).lineTo(297, 150).stroke('#666');

  doc.fontSize(16).fillColor('#000').text(emisor.razonSocial, 52, 56, { width: 235 });
  doc.fontSize(8).fillColor('#333');
  doc.text(`Razón Social:   ${emisor.razonSocial}`, 52, 84, { width: 235 });
  doc.text(`Domicilio Comercial:   ${emisor.domicilio}`, 52, 96, { width: 235 });
  doc.text(`Condición frente al IVA:   ${emisor.condicionIva}`, 52, 118, { width: 235 });

  // El recuadro de la letra, que es lo que un lector busca primero.
  doc.rect(280, 40, 34, 34).fillAndStroke('#fff', '#666');
  doc.fontSize(22).fillColor('#000').text(clase.letra, 280, 47, { width: 34, align: 'center' });
  doc.fontSize(7).text(`Cod. ${String(comprobante.cbteTipo).padStart(2, '0')}`, 280, 74, {
    width: 34,
    align: 'center',
  });

  doc.fontSize(16).text(clase.nombre, 320, 56);
  doc.fontSize(8).fillColor('#333');
  // Dos campos etiquetados en la misma línea: es como lo imprime ARCA, y es el
  // formato que encontró el defecto del lector.
  doc.text(
    `Punto de Venta:   ${String(comprobante.ptoVta).padStart(4, '0')}      Comp. Nro:   ${String(comprobante.cbteNro).padStart(8, '0')}`,
    320,
    84,
  );
  doc.text(`Fecha de Emisión:   ${fecha(comprobante.cbteFch)}`, 320, 96);
  doc.text(`CUIT:   ${comprobante.cuitEmisor}`, 320, 108);

  // --- Receptor -----------------------------------------------------------
  doc.rect(40, 160, 515, 40).stroke('#666');
  doc.fontSize(8).fillColor('#333');
  doc.text(
    comprobante.docTipo === 99
      ? 'CUIT / DNI:   —      Apellido y Nombre / Razón Social:   CONSUMIDOR FINAL'
      : `CUIT / DNI:   ${comprobante.docNro}`,
    52,
    172,
  );
  doc.text('Condición frente al IVA:   Consumidor Final', 52, 184);

  // --- Renglones ----------------------------------------------------------
  let y = 216;
  doc.fontSize(8).fillColor('#000');
  doc.text('Producto / Servicio', 52, y);
  doc.text('Cant.', 330, y);
  doc.text('Precio Unit.', 380, y, { width: 80, align: 'right' });
  doc.text('Subtotal', 470, y, { width: 75, align: 'right' });
  y += 14;
  doc.moveTo(40, y).lineTo(555, y).stroke('#ccc');
  y += 6;

  doc.fillColor('#333');
  for (const item of items) {
    doc.text(item.descripcion, 52, y, { width: 270 });
    doc.text(String(item.cantidad), 330, y);
    doc.text(pesos(item.unitario), 380, y, { width: 80, align: 'right' });
    doc.text(pesos(item.subtotal), 470, y, { width: 75, align: 'right' });
    y += 16;
  }

  y += 10;
  doc.moveTo(330, y).lineTo(555, y).stroke('#ccc');
  y += 8;
  doc.fontSize(10).fillColor('#000');
  doc.text('Importe Total:', 330, y);
  doc.text(pesos(comprobante.impTotal), 440, y, { width: 105, align: 'right' });

  // --- Pie: CAE y QR ------------------------------------------------------
  const pie = 700;
  doc.fontSize(8).fillColor('#333');
  doc.text(`CAE:   ${comprobante.cae}`, 200, pie);
  doc.text(`Fecha de Vto. de CAE:   ${fecha(comprobante.caeFchVto)}`, 200, pie + 12);

  if (qr.ok) {
    // El art. 4° de la RG 4892 lo pone en el frente del comprobante, confirmado
    // en el ABC de ARCA (consulta 26050193).
    const png = await QRCode.toBuffer(qr.url, { errorCorrectionLevel: 'M', margin: 1, width: 120 });
    doc.image(png, 52, pie - 10, { width: 110 });
  } else {
    doc.rect(52, pie - 10, 110, 110).dash(3, { space: 2 }).stroke('#999').undash();
    doc.fontSize(6).fillColor('#900');
    doc.text('SIN QR', 52, pie + 20, { width: 110, align: 'center' });
    doc.text('La especificación de campos no está transcripta.', 52, pie + 32, {
      width: 110,
      align: 'center',
    });
    doc.text('Ver scripts/especificacion-qr.json', 52, pie + 60, { width: 110, align: 'center' });
  }

  // --- El sello, en el papel y no solo en la consola -----------------------
  doc.fontSize(9).fillColor('#900');
  doc.text(SELLO, 40, 800, { width: 515, align: 'center' });

  doc.end();
  await new Promise((resolver, rechazar) => {
    salida.on('finish', resolver);
    salida.on('error', rechazar);
  });
}
