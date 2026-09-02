/**
 * Métricas técnicas: cuántos pedidos, con qué respuesta y cuánto tardaron.
 *
 * ## Qué mide y qué no
 *
 * Mide **el servidor**, no el negocio: pedidos por ruta y por código de estado,
 * y el tiempo que tardaron. No cuenta empresas, ni comprobantes, ni importes.
 * Una métrica de negocio en el recolector técnico termina en un tablero que
 * nadie declaró y que dice cifras que el balance no respalda.
 *
 * ## Por ruta, nunca por identificador
 *
 * La etiqueta es la **plantilla** de la ruta —`/parties/:partyId`— y no la url
 * concreta. Con la url concreta, el recolector guardaría los identificadores de
 * cada empresa en un sistema que casi nunca tiene el mismo control de acceso
 * que la base.
 *
 * ## Y no hay histograma
 *
 * Suma y cuenta, que dan el promedio. Un histograma exige elegir los cortes
 * —¿50 ms? ¿200?— y esos cortes son una afirmación sobre qué es lento en un
 * sistema que todavía no corrió en producción. Cuando haya datos para elegirlos,
 * se eligen con ellos.
 */

export interface Contador {
  readonly metodo: string;
  readonly ruta: string;
  readonly estado: number;
  pedidos: number;
  /** Milisegundos acumulados. Enteros: no hay dinero acá, pero tampoco falta. */
  milisegundos: number;
}

const contadores = new Map<string, Contador>();

/** Cuántos pedidos terminaron en error, sin importar la ruta. */
let errores = 0;

export function registrarPedido(
  metodo: string,
  ruta: string,
  estado: number,
  milisegundos: number,
): void {
  const clave = `${metodo} ${ruta} ${estado}`;
  const previo = contadores.get(clave);

  if (previo === undefined) {
    contadores.set(clave, { metodo, ruta, estado, pedidos: 1, milisegundos });
  } else {
    previo.pedidos += 1;
    previo.milisegundos += milisegundos;
  }

  if (estado >= 500) errores += 1;
}

/** Solo para los tests: deja los contadores como al arrancar. */
export function reiniciarMetricas(): void {
  contadores.clear();
  errores = 0;
}

function escapar(valor: string): string {
  return valor.replace(/\\/g, '\\\\').replace(/"/g, '\\"').replace(/\n/g, '\\n');
}

/**
 * El texto que entiende un recolector estándar.
 *
 * Formato de exposición de Prometheus, escrito a mano: agregar una dependencia
 * para producir catorce líneas de texto plano traería su cadena de
 * actualizaciones y su superficie de ataque, y el formato es estable desde hace
 * una década.
 */
export function exponerMetricas(): string {
  const lineas: string[] = [
    '# HELP nexo_http_requests_total Pedidos HTTP atendidos, por ruta y estado.',
    '# TYPE nexo_http_requests_total counter',
  ];

  for (const c of contadores.values()) {
    const etiquetas =
      `metodo="${escapar(c.metodo)}",ruta="${escapar(c.ruta)}",estado="${c.estado}"`;
    lineas.push(`nexo_http_requests_total{${etiquetas}} ${c.pedidos}`);
  }

  lineas.push(
    '# HELP nexo_http_request_duration_ms_total Milisegundos acumulados, por ruta y estado.',
    '# TYPE nexo_http_request_duration_ms_total counter',
  );
  for (const c of contadores.values()) {
    const etiquetas =
      `metodo="${escapar(c.metodo)}",ruta="${escapar(c.ruta)}",estado="${c.estado}"`;
    lineas.push(`nexo_http_request_duration_ms_total{${etiquetas}} ${c.milisegundos}`);
  }

  lineas.push(
    '# HELP nexo_http_errors_total Pedidos que terminaron en 5xx.',
    '# TYPE nexo_http_errors_total counter',
    `nexo_http_errors_total ${errores}`,
    '# HELP nexo_process_uptime_seconds Segundos desde que arrancó el proceso.',
    '# TYPE nexo_process_uptime_seconds gauge',
    `nexo_process_uptime_seconds ${Math.floor(process.uptime())}`,
  );

  return `${lineas.join('\n')}\n`;
}
