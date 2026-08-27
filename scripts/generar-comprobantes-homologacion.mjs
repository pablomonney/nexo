#!/usr/bin/env node
/**
 * Genera comprobantes reales en el ambiente de HOMOLOGACIÓN de ARCA y arma un PDF
 * por cada uno.
 *
 *   npm run comprobantes:generar -- \
 *     --cert C:/Users/vos/.arca/homologacion/cert.crt \
 *     --key  C:/Users/vos/.arca/homologacion/key.pem \
 *     --cuit 30xxxxxxxx9 --pto-vta 1 --cantidad 50
 *
 * Homologación existe para esto: comprobantes con CAE emitido por el organismo,
 * numeración correlativa real, y **sin efecto fiscal**. Es la única forma
 * legítima de tener datos de prueba que se comporten como los de producción.
 *
 * ## Los cuatro candados, en orden de ejecución
 *
 * 1. **El destino tiene que probar que es homologación.** No se comprueba que no
 *    sea producción: se comprueba que sea, exactamente, el endpoint que el
 *    repositorio declara. Ver `packages/arca-emision/src/homologacion.ts`.
 * 2. **El certificado no puede estar dentro del repositorio.** Un `.key`
 *    commiteado no se des-commitea: queda en el historial.
 * 3. **Se imprime el emisor y la huella del certificado antes de emitir.** El
 *    candado prueba a dónde se emite, no con qué credencial; esa la mira una
 *    persona.
 * 4. **`FEDummy` antes del lote.** Si el servicio está caído conviene saberlo
 *    antes de la primera solicitud, no en la número treinta y siete.
 *
 * ## Uno por llamada, no cincuenta en un lote
 *
 * `FECAESolicitar` acepta hasta 250 comprobantes por pedido, y sería más rápido.
 * Se emite de a uno a propósito: en un lote, un rechazo devuelve un `Resultado`
 * parcial y hay que reconciliar cuáles entraron contra cuáles no. De a uno, cada
 * comprobante tiene su respuesta y su error, y si algo falla en el número doce
 * los once anteriores ya están y son válidos.
 *
 * Para un generador de datos de prueba, la velocidad no vale la ambigüedad.
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { dirname, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import forge from 'node-forge';
import {
  SERVICE_NAMES,
  TicketCacheFs,
  WsaaAuthenticator,
  endpointsFor,
  loginConCache,
} from '@aai/arca';
import {
  ClienteWsfev1,
  construirQr,
  explicarRechazoEmision,
  verificarDestinoDeEmision,
} from '@aai/arca-emision';

import { armarPdf, lineasDelComprobante } from './pdf-comprobante.mjs';
import { generarComprobantes } from './comprobantes-sinteticos.mjs';
import { contarDeDondeSalio, directorioDeTickets } from './cache-de-tickets.mjs';

const AQUI = dirname(fileURLToPath(import.meta.url));
const RAIZ = resolve(join(AQUI, '..'));

const args = new Map();
for (let i = 2; i < process.argv.length; i += 2) {
  const clave = process.argv[i]?.replace(/^--/, '');
  if (clave !== undefined) args.set(clave, process.argv[i + 1]);
}

const certPath = args.get('cert');
const keyPath = args.get('key');
const cuit = args.get('cuit');
const ptoVta = Number(args.get('pto-vta') ?? 1);
const cantidad = Number(args.get('cantidad') ?? 50);
const cbteTipo = Number(args.get('cbte-tipo') ?? 11); // 11 = Factura C
/**
 * La salida usa la MISMA forma que espera `extraction-metrics.mjs`:
 *
 *     <salida>/ground-truth.json
 *     <salida>/documentos/00000041.pdf
 *     <salida>/documentos/00000041.pdf.txt
 *
 * Así el lote se mide con `npm run metrics:extraction -- --corpus <salida>` sin
 * mover un archivo. Escribirlo plano y dejar que alguien lo reacomode después es
 * el paso donde se pierde la correspondencia entre el PDF y su verdad conocida.
 *
 * Por defecto NO va a `corpus/`, y es deliberado: ese directorio es el del
 * criterio de salida de la FASE 3b, que pide comprobantes **reales**
 * anonimizados. Estos tienen CAE real y contenido generado por nosotros —sirven
 * para encontrar huecos del lector, no para cerrar ese criterio— así que viven
 * aparte y se miden aparte.
 */
const salida = args.get('salida') ?? join(RAIZ, 'var', 'corpus-homologacion');
const documentos = join(salida, 'documentos');

if (certPath === undefined || keyPath === undefined || cuit === undefined) {
  console.error('Faltan --cert, --key o --cuit.');
  console.error('');
  console.error('  npm run comprobantes:generar -- --cert ruta/cert.crt --key ruta/key.pem \\');
  console.error('    --cuit 30xxxxxxxx9 [--pto-vta 1] [--cantidad 50] [--cbte-tipo 11]');
  console.error('');
  console.error('El certificado va FUERA del repositorio. Sugerencia:');
  console.error('  C:\\Users\\<vos>\\.arca\\homologacion\\cert.crt');
  process.exit(2);
}

// --- Candado 2: el certificado no vive en el repositorio -------------------
for (const [nombre, ruta] of [['--cert', certPath], ['--key', keyPath]]) {
  const destino = resolve(ruta);
  if (!relative(RAIZ, destino).startsWith('..')) {
    console.error(`${nombre} apunta adentro del repositorio: ${destino}`);
    console.error('');
    console.error('Un .key commiteado no se des-commitea: queda en el historial del repositorio');
    console.error('para siempre, y hay que revocar el certificado. Movelo afuera.');
    process.exit(1);
  }
  if (!existsSync(destino)) {
    console.error(`${nombre}: no existe ${destino}`);
    process.exit(1);
  }
}

// --- Candado 1: el destino prueba ser homologación -------------------------
const endpoints = endpointsFor('homologacion');
const permiso = verificarDestinoDeEmision({
  ambiente: 'homologacion',
  endpointWsfev1: endpoints.wsfev1,
  endpointWsaa: endpoints.wsaa,
});

if (!permiso.permitido) {
  console.error(explicarRechazoEmision(permiso));
  process.exit(1);
}

// --- Candado 3: quién es este certificado ----------------------------------
const certificatePem = readFileSync(certPath, 'utf8');
const privateKeyPem = readFileSync(keyPath, 'utf8');
const x509 = forge.pki.certificateFromPem(certificatePem);
const der = forge.asn1.toDer(forge.pki.certificateToAsn1(x509)).getBytes();
const huella = createHash('sha256').update(Buffer.from(der, 'binary')).digest('hex');

console.log('Certificado');
console.log(`  sujeto:  ${x509.subject.attributes.map((a) => `${a.shortName}=${a.value}`).join(', ')}`);
console.log(`  emisor:  ${x509.issuer.attributes.map((a) => `${a.shortName}=${a.value}`).join(', ')}`);
console.log(`  vence:   ${x509.validity.notAfter.toISOString()}`);
console.log(`  sha256:  ${huella}`);
console.log('');
console.log('  El candado prueba a DÓNDE se emite, no con QUÉ credencial. Si ese emisor no es');
console.log('  la autoridad certificante de homologación, cortá acá.');
console.log('');

const cliente = new ClienteWsfev1({ permiso });

// --- Candado 4: ¿está vivo? ------------------------------------------------
// Va ANTES de autenticar. `FEDummy` no pide credenciales, y el ticket del WSAA
// es un recurso escaso: dura horas y no se puede pedir otro hasta que venza. Si
// el servicio está caído, averiguarlo después de sacar el ticket significa
// quedarse sin ticket Y sin comprobantes hasta la noche.
const estado = await cliente.dummy();
console.log(`FEDummy → app ${estado.appServer} · db ${estado.dbServer} · auth ${estado.authServer}`);
if ([estado.appServer, estado.dbServer, estado.authServer].some((v) => v !== 'OK')) {
  console.error('');
  console.error('El servicio no está sano. No se emite: un lote a medias contra un servicio');
  console.error('degradado deja huecos de numeración que después hay que explicar.');
  process.exit(1);
}

// --- La especificación del QR, si está --------------------------------------
let especificacionQr = null;
const rutaSpec = join(AQUI, 'especificacion-qr.json');
if (existsSync(rutaSpec)) {
  const crudo = JSON.parse(readFileSync(rutaSpec, 'utf8'));
  if (Array.isArray(crudo.campos) && crudo.campos.length > 0) especificacionQr = crudo;
}

if (especificacionQr !== null) {
  console.log('');
  console.log(`QR: versión ${especificacionQr.version}, ${especificacionQr.campos.length} campos.`);
  console.log(`  URL: ${especificacionQr.url}`);
  console.log('  Transcripto de ARCA_QR_especificaciones.pdf. Hay un test que reproduce el JSON');
  console.log('  de ejemplo del propio documento byte por byte: si un nombre está mal copiado,');
  console.log('  el test se cae antes de que salga un solo comprobante.');
} else {
  const prueba = construirQr(
    { cuitEmisor: cuit, ptoVta, cbteTipo, cbteNro: 1, cbteFch: '20260101', docTipo: 99,
      docNro: '0', impTotal: 1, moneda: 'PES', cotizacion: 1, cae: '0', caeFchVto: '20260101',
      concepto: '', tipoCodAut: 'E' },
    null,
  );
  console.log('');
  console.log('QR: NO se va a incrustar.');
  console.log(`  ${prueba.motivo}`);
  console.log(`  ${prueba.queHacer}`);
  console.log('');
  console.log('  Los PDF salen sin QR y con esa leyenda impresa. Un PDF sin QR es un PDF');
  console.log('  incompleto y se nota; uno con un QR inventado parece completo.');
}

// --- Autenticación ----------------------------------------------------------
// Recién acá, con el servicio ya confirmado sano y la especificación del QR
// resuelta. El WSAA emite UN ticket por CUIT y servicio y niega el segundo
// mientras el primero viva: sin caché, correr `arca:check` y después este script
// en la misma jornada es imposible — que es exactamente lo que pasó la primera
// vez que se corrieron en fila.
const autenticador = new WsaaAuthenticator({ endpoint: endpoints.wsaa });
const cacheTickets = new TicketCacheFs({
  directorio: directorioDeTickets(args),
  ambiente: 'homologacion',
  raizRepositorio: RAIZ,
});

let obtenido;
try {
  obtenido = await loginConCache(
    autenticador,
    cacheTickets,
    {
      companyId: 'generador-homologacion',
      cuit,
      certificatePem,
      privateKeyPem,
      notAfter: x509.validity.notAfter,
    },
    SERVICE_NAMES.wsfev1,
  );
} catch (error) {
  // Un stack trace de node-forge no le dice a nadie qué hacer. El WSAA ya
  // explicó el problema; el trabajo acá es no taparlo con ruido.
  console.error('');
  console.error(`No se pudo autenticar: ${error.message}`);
  if (error?.code === 'ns1:coe.alreadyAuthenticated') {
    console.error('');
    console.error(`  La caché de este comando es ${cacheTickets.directorio}`);
    console.error('  Si está vacía, el ticket vivo lo pidió algo que no lo guardó. No hay forma');
    console.error('  de recuperarlo: hay que esperar a que venza. Los TA de ARCA duran horas.');
    console.error('  No sirve reintentar: cada pedido de más acerca un bloqueo del organismo.');
  }
  process.exit(1);
}
const ticket = obtenido.ticket;
const auth = { Token: ticket.token, Sign: ticket.sign, Cuit: cuit };

console.log('');
console.log(contarDeDondeSalio(obtenido));

// --- Numeración -------------------------------------------------------------
const ultimo = await cliente.ultimoAutorizado(auth, ptoVta, cbteTipo);
console.log('');
console.log(`Último autorizado en ${ptoVta}/${cbteTipo}: ${ultimo}. Se sigue desde ${ultimo + 1}.`);

// --- El lote ----------------------------------------------------------------
mkdirSync(documentos, { recursive: true });

// El piso de fecha. `FECompUltimoAutorizado` da el número y nada más, pero la
// fecha tampoco puede retroceder dentro de un punto de venta: si el último
// autorizado es del 25/08, un comprobante nuevo del 23/08 se rechaza con 10016.
// En un punto de venta virgen no hay piso, y eso no es un error.
const fechaPiso = ultimo === 0 ? undefined : await cliente.fechaDeComprobante(auth, ptoVta, cbteTipo, ultimo);
if (fechaPiso !== undefined && fechaPiso !== null) {
  console.log(`Fecha del último autorizado: ${fechaPiso}. Ninguno nuevo puede ser anterior.`);
}

const planeados = generarComprobantes({
  cantidad,
  cbteTipo,
  desdeNumero: ultimo + 1,
  ...(fechaPiso === null || fechaPiso === undefined ? {} : { fechaMinima: fechaPiso }),
});
const autorizados = [];
const verdad = [];
const rechazados = [];

for (const plan of planeados) {
  const respuesta = await cliente.solicitarCae(auth, { CantReg: 1, PtoVta: ptoVta, CbteTipo: cbteTipo }, [
    plan.detalle,
  ]);

  const detalle = respuesta.comprobantes[0];
  if (respuesta.Resultado !== 'A' || detalle?.CAE == null) {
    rechazados.push({
      numero: plan.detalle.CbteDesde,
      errores: respuesta.errores.map((e) => `[${e.Code}] ${e.Msg}`),
      observaciones: (detalle?.Observaciones ?? []).map((o) => `[${o.Code}] ${o.Msg}`),
    });
    // Se corta al primer rechazo: seguir dejaría un hueco de numeración, y un
    // hueco en la numeración de comprobantes es una infracción formal aunque el
    // ambiente sea de prueba.
    break;
  }

  const comprobante = {
    cuitEmisor: cuit,
    ptoVta,
    cbteTipo,
    cbteNro: detalle.CbteDesde,
    cbteFch: detalle.CbteFch,
    docTipo: plan.detalle.DocTipo,
    docNro: plan.detalle.DocNro,
    impTotal: plan.detalle.ImpTotal,
    moneda: plan.detalle.MonId,
    cotizacion: plan.detalle.MonCotiz,
    cae: detalle.CAE,
    caeFchVto: detalle.CAEFchVto ?? '',
    concepto: plan.descripcion,
    // El WSFEv1 autoriza con CAE; CAEA es otro circuito y otro campo.
    tipoCodAut: 'E',
  };

  const qr = construirQr(comprobante, especificacionQr);
  const nombre = `${String(comprobante.cbteNro).padStart(8, '0')}.pdf`;
  const archivo = join(documentos, nombre);
  await armarPdf(archivo, { comprobante, emisor: plan.emisor, items: plan.items, qr });

  // La transcripción, al lado del PDF y con el nombre que espera
  // `extraction-metrics.mjs`. Sale de las MISMAS líneas que se dibujaron: si se
  // armara aparte, un error de extracción se confundiría con una diferencia
  // entre los dos archivos.
  writeFileSync(
    `${archivo}.txt`,
    `${lineasDelComprobante({ comprobante, emisor: plan.emisor, items: plan.items }).join('\n')}\n`,
    'utf8',
  );

  // La verdad conocida: lo que le mandamos a ARCA y lo que ARCA devolvió. No
  // sale de leer el PDF, así que medir el lector contra esto no es circular.
  verdad.push({
    archivo: nombre,
    esperado: {
      'emisor.cuit': comprobante.cuitEmisor,
      'comprobante.fecha': `${comprobante.cbteFch.slice(0, 4)}-${comprobante.cbteFch.slice(4, 6)}-${comprobante.cbteFch.slice(6, 8)}`,
      'comprobante.identificacion': `${String(ptoVta).padStart(5, '0')}-${String(comprobante.cbteNro).padStart(8, '0')}`,
      'comprobante.codigoAutorizacion': comprobante.cae,
      'importes.total': `${Math.round(comprobante.impTotal * 100)} ARS`,
      // Clase C: no discrimina IVA, así que el campo NO está en el documento.
      // `null` significa "si el sistema devuelve algo, es un falso positivo".
      'importes.iva': null,
    },
  });

  autorizados.push(comprobante);
  process.stdout.write(`\r  autorizados: ${autorizados.length}/${cantidad}`);
}

process.stdout.write('\n');

// --- Resultado --------------------------------------------------------------
console.log('');
console.log(`Autorizados: ${autorizados.length} · PDF en ${documentos}`);

if (rechazados.length > 0) {
  console.log('');
  console.log('Se cortó en el primer rechazo, para no dejar un hueco de numeración:');
  for (const r of rechazados) {
    console.log(`  comprobante ${r.numero}`);
    for (const e of r.errores) console.log(`    error: ${e}`);
    for (const o of r.observaciones) console.log(`    obs:   ${o}`);
  }
  process.exitCode = 1;
}

if (autorizados.length > 0) {
  // ground-truth.json con el nombre y la forma que espera extraction-metrics.mjs.
  writeFileSync(join(salida, 'ground-truth.json'), `${JSON.stringify(verdad, null, 2)}\n`, 'utf8');

  const indice = join(salida, 'comprobantes.json');
  writeFileSync(indice, `${JSON.stringify(autorizados, null, 2)}\n`, 'utf8');
  console.log(`Índice: ${indice}`);
  console.log('');
  console.log('Estos comprobantes tienen CAE real de homologación y NINGÚN efecto fiscal.');
  console.log('No son un corpus de la FASE 3b: siguen siendo datos generados, y lo que ese');
  console.log('criterio pide son comprobantes reales anonimizados. Sirven para lo que');
  console.log('sirvieron los cincuenta anteriores: encontrar huecos del lector.');
}
