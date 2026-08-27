/**
 * Arma los comprobantes que se le van a pedir a ARCA.
 *
 * ARCA autoriza lo que se le manda: el CAE es real, pero los importes, las
 * fechas y los conceptos los inventamos nosotros. Esto es lo inventado, separado
 * en su propio archivo para que no se confunda con lo que devuelve el organismo.
 *
 * ## Qué se varía, y por qué esas cosas
 *
 * No se busca realismo estadístico —no tenemos de dónde sacarlo— sino **cobertura
 * de casos que el resto del sistema tiene que saber manejar**:
 *
 * - Importes de tres órdenes de magnitud distintos, con centavos que no son
 *   redondos. El detector de importes redondos de la FASE 14 tiene que ver algo.
 * - Fechas repartidas en los últimos días hábiles. ARCA rechaza comprobantes con
 *   fecha muy anterior a hoy, así que el rango es corto por obligación, no por
 *   elección.
 * - Conceptos de productos, de servicios y mixtos, porque el `Concepto` cambia
 *   qué campos son obligatorios: con 2 o 3 hay que mandar `FchServDesde`,
 *   `FchServHasta` y `FchVtoPago`, y con 1 no.
 * - Cantidad de ítems variable, para que el PDF no salga siempre igual.
 *
 * ## Factura C: sin IVA discriminado
 *
 * `ImpNeto` lleva el total, `ImpIVA` va en cero y **el nodo `Iva` no se manda**.
 * Un array vacío no es lo mismo que no mandarlo, y es el rechazo más común.
 *
 * El generador no decide esto por su cuenta: `sinIva` sale del tipo de
 * comprobante que se le pide, y para los tipos que sí discriminan la función
 * falla en vez de suponer una alícuota. Suponer 21% acá sería el mismo error que
 * el motor de IVA se niega a cometer.
 */

/** Tipos de comprobante clase C, que no discriminan IVA. Del catálogo de ARCA. */
const CLASE_C = new Set([11, 12, 13, 15]);

const CONCEPTOS = [
  { texto: 'Servicio de consultoría de software', concepto: 2 },
  { texto: 'Desarrollo de sitio web corporativo', concepto: 2 },
  { texto: 'Mantenimiento preventivo de equipos', concepto: 2 },
  { texto: 'Licencia anual de software de gestión', concepto: 3 },
  { texto: 'Insumos de oficina y papelería', concepto: 1 },
  { texto: 'Cartuchos de tinta y toner', concepto: 1 },
  { texto: 'Hosting y servidores cloud', concepto: 2 },
  { texto: 'Capacitación de personal', concepto: 2 },
  { texto: 'Compra de insumos informáticos', concepto: 1 },
  { texto: 'Honorarios profesionales', concepto: 2 },
];

/**
 * Aleatorio determinístico.
 *
 * Con `--semilla` la misma corrida produce los mismos importes. No es para
 * reproducir los comprobantes —el CAE y el número los pone ARCA y no se repiten—
 * sino para que, si algo falla en el número doce, se pueda volver a armar el
 * número doce igual y mirarlo.
 */
function generador(semilla) {
  let estado = 0;
  for (const c of String(semilla)) estado = (estado * 31 + c.charCodeAt(0)) >>> 0;
  return () => {
    estado = (estado * 1664525 + 1013904223) >>> 0;
    return estado / 0x100000000;
  };
}

const aaaammdd = (fecha) =>
  `${fecha.getFullYear()}${String(fecha.getMonth() + 1).padStart(2, '0')}${String(fecha.getDate()).padStart(2, '0')}`;

export function generarComprobantes({ cantidad, cbteTipo, desdeNumero, semilla = 'homologacion', hoy = new Date() }) {
  if (!CLASE_C.has(cbteTipo)) {
    throw new Error(
      `Este generador solo arma comprobantes clase C (${[...CLASE_C].join(', ')}), y se pidió ${cbteTipo}. ` +
        'Para un tipo que discrimina IVA habría que elegir una alícuota, y elegirla acá sería ' +
        'suponer — que es justo lo que el motor de IVA se niega a hacer.',
    );
  }

  const azar = generador(semilla);
  const comprobantes = [];

  for (let i = 0; i < cantidad; i += 1) {
    const plantilla = CONCEPTOS[Math.floor(azar() * CONCEPTOS.length)];

    // Tres órdenes de magnitud, con centavos que no son redondos.
    const magnitud = [1_000, 10_000, 100_000][Math.floor(azar() * 3)];
    const cantidadItems = 1 + Math.floor(azar() * 4);

    const items = [];
    let total = 0;
    for (let k = 0; k < cantidadItems; k += 1) {
      const unidades = 1 + Math.floor(azar() * 5);
      // Se redondea a centavos en enteros: un importe con más de dos decimales
      // lo rechaza ARCA, y calcularlo en punto flotante y truncar después deja
      // diferencias de un centavo entre el total y la suma de los renglones.
      const unitarioCentavos = Math.round(magnitud * (0.5 + azar()) * 100);
      const subtotalCentavos = unitarioCentavos * unidades;
      items.push({
        descripcion: plantilla.texto,
        cantidad: unidades,
        unitario: unitarioCentavos / 100,
        subtotal: subtotalCentavos / 100,
      });
      total += subtotalCentavos;
    }

    // ARCA no acepta comprobantes con fecha muy anterior a hoy. Los últimos días.
    const fecha = new Date(hoy.getTime() - Math.floor(azar() * 5) * 86_400_000);
    const requiereFechasDeServicio = plantilla.concepto === 2 || plantilla.concepto === 3;

    const detalle = {
      Concepto: plantilla.concepto,
      // 99 = consumidor final sin identificar. Es lo que corresponde cuando no
      // hay receptor: inventar un CUIT de receptor sería inventar un tercero.
      DocTipo: 99,
      DocNro: '0',
      CbteDesde: desdeNumero + i,
      CbteHasta: desdeNumero + i,
      CbteFch: aaaammdd(fecha),
      ImpTotal: total / 100,
      ImpTotConc: 0,
      // Clase C: el total va en el neto y no se discrimina IVA.
      ImpNeto: total / 100,
      ImpOpEx: 0,
      ImpTrib: 0,
      ImpIVA: 0,
      MonId: 'PES',
      MonCotiz: 1,
      ...(requiereFechasDeServicio
        ? {
            FchServDesde: aaaammdd(fecha),
            FchServHasta: aaaammdd(fecha),
            FchVtoPago: aaaammdd(new Date(fecha.getTime() + 30 * 86_400_000)),
          }
        : {}),
    };

    comprobantes.push({
      detalle,
      descripcion: plantilla.texto,
      items,
      emisor: {
        razonSocial: 'EMISOR DE HOMOLOGACIÓN',
        domicilio: 'Sin domicilio declarado — ambiente de prueba',
        condicionIva: 'Responsable Monotributo',
      },
    });
  }

  return comprobantes;
}
