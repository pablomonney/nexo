/**
 * Lectura de CSV, compartida.
 *
 * Vivía dentro de `routes/banks.ts` porque el único que leía archivos era el
 * importador de extractos. Cuando la ingesta del Integration Hub necesitó lo
 * mismo, la alternativa era que una ruta importara de otra — y dos dominios
 * acoplados por una utilidad de texto es la clase de dependencia que después
 * nadie sabe por qué está.
 *
 * Es texto y nada más: **no interpreta ninguna celda**. Qué es una fecha, qué
 * es un importe y de qué lado está un movimiento lo deciden los motores, cada
 * uno con su mapeo declarado.
 */

/**
 * Separa un CSV en filas y columnas, respetando el entrecomillado.
 *
 * Se aceptan CRLF y LF porque un archivo bajado de un homebanking o del panel
 * de una pasarela de pagos viene de cualquiera de los dos, y eso no es
 * interpretar: es leer líneas.
 */
export function separarCsv(contenido: string, separador: string): string[][] {
  const filas: string[][] = [];
  let celda = '';
  let fila: string[] = [];
  let entreComillas = false;

  for (let i = 0; i < contenido.length; i += 1) {
    const caracter = contenido[i];
    if (entreComillas) {
      if (caracter === '"') {
        if (contenido[i + 1] === '"') {
          celda += '"';
          i += 1;
        } else {
          entreComillas = false;
        }
      } else {
        celda += caracter;
      }
      continue;
    }

    if (caracter === '"') entreComillas = true;
    else if (caracter === separador) {
      fila.push(celda);
      celda = '';
    } else if (caracter === '\n') {
      fila.push(celda);
      filas.push(fila);
      fila = [];
      celda = '';
    } else if (caracter !== '\r') {
      celda += caracter;
    }
  }

  if (celda !== '' || fila.length > 0) {
    fila.push(celda);
    filas.push(fila);
  }

  return filas;
}
