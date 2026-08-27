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

export function generarComprobantes({ cantidad, cbteTipo, desdeNumero, fechaMinima, semilla = 'homologacion', hoy = new Date() }) {
  if (!CLASE_C.has(cbteTipo)) {
    throw new Error(
      `Este generador solo arma comprobantes clase C (${[...CLASE_C].join(', ')}), y se pidió ${cbteTipo}. ` +
        'Para un tipo que discrimina IVA habría que elegir una alícuota, y elegirla acá sería ' +
        'suponer — que es justo lo que el motor de IVA se niega a hacer.',
    );
  }

  const azar = generador(semilla);

  /**
   * Las fechas se sortean **todas juntas y se ordenan** antes de repartirlas.
   *
   * Dentro de un punto de venta y un tipo, ARCA exige que la fecha no retroceda
   * al avanzar la numeración. Sortear una fecha por comprobante dentro del bucle
   * produce series como 25/08 → 23/08, y el organismo las rechaza con el código
   * **10016** — "El numero o fecha del comprobante no se corresponde con el
   * proximo a autorizar"—, que nombra las dos cosas y no dice cuál de las dos es.
   *
   * Pasó en la primera corrida real: el comprobante 1 entró con fecha 25/08 y el
   * 2 rebotó. Ordenarlas conserva la variedad de fechas, que es lo que le
   * interesa al lector de documentos, y respeta la correlatividad, que es lo que
   * le interesa a ARCA.
   */
  // `fechaMinima` (AAAAMMDD) es la fecha del último comprobante ya autorizado en
  // este punto de venta. Ninguna fecha nueva puede ser anterior. Sin ese piso,
  // un segundo lote sobre un punto de venta ya usado vuelve a chocar con 10016.
  // El piso se arma en hora **local**, no con `Date.UTC`, porque `aaaammdd` usa
  // getters locales. Mezclarlos hace que en UTC−3 un piso de "20260827" se
  // imprima como 26/08 — un día menos, y de vuelta el rechazo que se quería
  // evitar. Es el mismo error de zona horaria que `CalendarDate` existe para
  // impedir en el resto del sistema.
  const piso =
    fechaMinima === undefined
      ? 0
      : new Date(
          Number(fechaMinima.slice(0, 4)),
          Number(fechaMinima.slice(4, 6)) - 1,
          Number(fechaMinima.slice(6, 8)),
        ).getTime();

  const fechas = Array.from({ length: cantidad }, () => {
    const sorteada = hoy.getTime() - Math.floor(azar() * 5) * 86_400_000;
    return new Date(Math.max(sorteada, piso));
  }).sort((a, b) => a.getTime() - b.getTime());

  const comprobantes = [];

  const hoyTexto = aaaammdd(hoy);

  for (let i = 0; i < cantidad; i += 1) {
    /**
     * La fecha elige el concepto, y no al revés.
     *
     * Observado contra homologación el 2026-08-27, con pruebas controladas sobre
     * el mismo número y el mismo día: un comprobante de **productos**
     * (`Concepto` 1) con fecha anterior a hoy se rechaza con el código 10016; el
     * mismo comprobante con fecha de hoy entra, y uno de **servicios**
     * (`Concepto` 2) con fecha retroactiva también entra.
     *
     * No se cita una norma ni un manual: el manual del wsfev1 está archivado
     * como imagen y no se pudo leer. Esto es comportamiento observado, con la
     * fecha en que se observó, y así queda dicho.
     *
     * Como el generador quiere variedad de fechas —el lector de documentos tiene
     * que ver más de una—, se resuelve al revés de lo intuitivo: primero la
     * fecha, y después un concepto compatible con esa fecha.
     */
    const fechaTexto = aaaammdd(fechas[i]);
    const admitidos =
      fechaTexto === hoyTexto ? CONCEPTOS : CONCEPTOS.filter((c) => c.concepto !== 1);
    const plantilla = admitidos[Math.floor(azar() * admitidos.length)];

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

    // Ya sorteada y ordenada arriba: ARCA no acepta fecha muy anterior a hoy, ni
    // que retroceda respecto del comprobante previo.
    const fecha = fechas[i];
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
      // RG 5616/2024: declarar la condición del receptor frente al IVA es
      // obligatorio. Sin esto ARCA rechaza con el código 10246, que fue lo que
      // pasó en la primera corrida real contra homologación.
      //
      // El 5 no se eligió: se deduce del `DocTipo`. Con 99 —consumidor final sin
      // identificar— la única condición coherente es "Consumidor Final". Poner
      // cualquier otra sería declarar algo sobre un receptor que no existe.
      //
      // El valor sale de `FEParamGetCondicionIvaReceptor`, consultado el
      // 2026-08-27: id 5, "Consumidor Final", clases `C/49`. Está cableado acá
      // —y solo acá, en el generador de datos de prueba— porque estos
      // comprobantes son inventados. Un emisor de verdad tiene que preguntarle
      // la tabla al organismo, no confiar en este número.
      CondicionIVAReceptorId: 5,
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
