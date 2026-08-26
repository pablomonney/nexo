/**
 * El escenario que trae `npm run sandbox:run` de fábrica.
 *
 * Un mes de una empresa que no existe: una compra con IVA discriminado y una
 * venta. Alcanza para que los cuatro motores corran de punta a punta y para que
 * un contador vea, antes de confiarle nada, **qué dice el sistema cuando no puede
 * afirmar algo**.
 *
 * Eso último es el punto del escenario. La compra pasa todos los controles de
 * forma y aun así el crédito fiscal sale `NO_DETERMINABLE`, con la lista de lo
 * que falta. Un sandbox que mostrara "crédito computable: $ 21.000" sería más
 * lindo de demostrar y estaría enseñando a confiar en una afirmación que el
 * sistema no hace.
 *
 * ## Todo acá es ficticio, y se nota
 *
 * Las razones sociales dicen SIMULACIÓN. Los CUIT son de la serie de prueba. No
 * es decoración: un escenario que se ve como datos reales termina, tarde o
 * temprano, copiado a un informe.
 */

import { money, parseCalendarDate } from '@aai/shared';

const ARS = (centavos) => money(centavos, 'ARS');
const F = (iso) => parseCalendarDate(iso);

const COMPANY = '00000000-0000-4000-8000-000000000001';
const EJERCICIO = '00000000-0000-4000-8000-000000000002';
const PERIODO = '00000000-0000-4000-8000-000000000003';

const CUENTAS = [
  { id: 'cta-mercaderias', code: '1.1.05.01', name: 'Mercaderías', nature: 'DEUDORA' },
  { id: 'cta-iva-cf', code: '1.1.04.01', name: 'IVA Crédito Fiscal', nature: 'DEUDORA' },
  { id: 'cta-proveedores', code: '2.1.01.01', name: 'Proveedores', nature: 'ACREEDORA' },
  { id: 'cta-deudores', code: '1.1.03.01', name: 'Deudores por ventas', nature: 'DEUDORA' },
  { id: 'cta-iva-df', code: '2.1.04.01', name: 'IVA Débito Fiscal', nature: 'ACREEDORA' },
  { id: 'cta-ventas', code: '4.1.01.01', name: 'Ventas', nature: 'ACREEDORA' },
];

/**
 * Las alícuotas del escenario.
 *
 * Se declaran acá y no se leen de `tax_rates` a propósito: el escenario tiene que
 * ser reproducible aunque el sandbox esté recién creado y sin sembrar. Los
 * valores son los mismos que siembra `npm run tax:seed` desde el art. 28 — si un
 * día divergen, el escenario deja de predecir producción, que es el único pecado
 * grave de un sandbox.
 */
const ALICUOTAS = [
  {
    id: 'sim-general',
    numerador: 21n,
    denominador: 100n,
    etiqueta: '21% (simulación)',
    vigenteDesde: F('2003-01-18'),
    vigenteHasta: null,
    normVersionId: 'sim-norma',
  },
  {
    id: 'sim-reducida',
    numerador: 21n,
    denominador: 200n,
    etiqueta: '10,5% (simulación)',
    vigenteDesde: F('2003-01-18'),
    vigenteHasta: null,
    normVersionId: 'sim-norma',
  },
  {
    id: 'sim-incrementada',
    numerador: 27n,
    denominador: 100n,
    etiqueta: '27% (simulación)',
    vigenteDesde: F('2003-01-18'),
    vigenteHasta: null,
    normVersionId: 'sim-norma',
  },
];

function linea(n, cuenta, debe, haber, descripcion) {
  const referencia = CUENTAS.find((c) => c.id === cuenta);
  return {
    id: `sim-linea-${cuenta}-${n}`,
    lineNo: n,
    accountId: referencia.id,
    accountCode: referencia.code,
    accountName: referencia.name,
    debit: ARS(debe),
    credit: ARS(haber),
    monedaOriginal: null,
    importeOriginal: null,
    fxRate: null,
    fxSource: null,
    fxDate: null,
    costCenterCode: null,
    partyId: null,
    description: descripcion,
    taxTransactionId: null,
  };
}

function asiento(numero, journalCode, fecha, descripcion, documentId, lineas) {
  return {
    id: `sim-asiento-${numero}`,
    journalCode,
    entryNumber: numero,
    entryDate: F(fecha),
    description: descripcion,
    kind: 'NORMAL',
    // APROBADO porque el Diario solo admite registraciones: un BORRADOR quedaría
    // afuera y el escenario mostraría un libro vacío sin explicar por qué.
    status: 'APROBADO',
    fiscalYearId: EJERCICIO,
    periodId: PERIODO,
    reversesEntryId: null,
    sourceType: 'INVOICE',
    sourceId: null,
    // El art. 321 exige respaldo documental: el Diario rechaza un asiento sin
    // comprobante ni justificación. El escenario lo cumple para que las
    // observaciones que aparezcan sean las que uno introdujo a propósito.
    documentId,
    manualJustification: null,
    aiPredictionId: null,
    createdBy: 'sandbox',
    approvedBy: 'sandbox',
    lines: lineas,
  };
}

export function escenarioDeDemostracion() {
  return {
    nombre: 'Un mes de EJEMPLO SIMULADO S.A.',
    companyId: COMPANY,
    fiscalYearId: EJERCICIO,
    moneda: 'ARS',
    desde: F('2026-03-01'),
    hasta: F('2026-03-31'),
    cuentas: CUENTAS,
    alicuotas: ALICUOTAS,
    comprobantes: [
      {
        id: 'sim-cbte-compra',
        direccion: 'COMPRAS',
        tipoComprobante: 1,
        clase: 'FACTURA',
        puntoVenta: 4,
        numero: 118,
        fecha: F('2026-03-12'),
        cuitContraparte: '30500010912',
        razonSocialContraparte: 'PROVEEDOR DE SIMULACIÓN S.R.L.',
        condicionContraparte: 'RESPONSABLE_INSCRIPTO',
        renglones: [{
          neto: ARS(100_000_00n),
          iva: ARS(21_000_00n),
          noGravado: ARS(0n),
          exento: ARS(0n),
          alicuotaId: null,
        }],
        percepciones: ARS(0n),
        total: ARS(121_000_00n),
        // OK y no NO_CONSULTADO: el escenario quiere llegar a la cuestión de
        // fondo, no quedarse en un control de forma.
        constatacion: 'OK',
        emisorApocrifo: false,
        entryId: 'sim-asiento-1',
        documentId: null,
      },
    ],
    asientos: [
      asiento(1, 'COMPRAS', '2026-03-12', 'Compra de mercaderías — SIMULACIÓN', 'sim-doc-compra', [
        linea(1, 'cta-mercaderias', 100_000_00n, 0n, 'Neto gravado'),
        linea(2, 'cta-iva-cf', 21_000_00n, 0n, 'IVA 21%'),
        linea(3, 'cta-proveedores', 0n, 121_000_00n, 'PROVEEDOR DE SIMULACIÓN S.R.L.'),
      ]),
      asiento(2, 'VENTAS', '2026-03-20', 'Venta de mercaderías — SIMULACIÓN', 'sim-doc-venta', [
        linea(1, 'cta-deudores', 181_500_00n, 0n, 'CLIENTE DE SIMULACIÓN S.A.'),
        linea(2, 'cta-ventas', 0n, 150_000_00n, 'Neto gravado'),
        linea(3, 'cta-iva-df', 0n, 31_500_00n, 'IVA 21%'),
      ]),
    ],
  };
}
