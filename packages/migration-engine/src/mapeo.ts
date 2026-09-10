/**
 * Qué columna del origen es qué campo de NEXO.
 *
 * ## La sugerencia no decide
 *
 * El mapeo automático acierta con «Razón Social» y falla con «Nombre», que
 * puede ser el del cliente o el del vendedor. Por eso lo que sale de acá es una
 * **sugerencia con confianza**, y la persona confirma. Un mapeo equivocado
 * aplicado en silencio mete el teléfono en el campo del CUIT y nadie se entera
 * hasta que se emite un comprobante.
 *
 * ## Determinista, sin modelo
 *
 * Compara nombres normalizados contra sinónimos escritos. No usa IA: el §38
 * lo dice y además no hace falta —el problema es de vocabulario, no de
 * lenguaje— y un mapeo que depende de un proveedor externo no se puede correr
 * sin conexión ni reproducir dos veces igual.
 */

import type { Entidad } from './canonico.js';
import { FORMAS } from './canonico.js';

/** Cómo se escribe cada campo canónico en los sistemas de por acá. */
const SINONIMOS: Readonly<Record<string, readonly string[]>> = {
  razonSocial: [
    'razon social', 'razonsocial', 'nombre', 'nombre o razon social', 'cliente',
    'proveedor', 'denominacion', 'apellido y nombre', 'titular', 'name',
  ],
  cuit: ['cuit', 'cuil', 'cuit/cuil', 'nro documento', 'documento', 'tax id', 'identificacion'],
  tipo: ['tipo', 'tipo de tercero', 'clase', 'categoria'],
  condicionIva: [
    'condicion iva', 'cond iva', 'condicion frente al iva', 'iva', 'situacion iva',
    'condicion fiscal',
  ],
  email: ['email', 'e-mail', 'correo', 'correo electronico', 'mail'],
  telefono: ['telefono', 'tel', 'celular', 'movil', 'phone'],
  direccion: ['direccion', 'domicilio', 'calle', 'address'],
  localidad: ['localidad', 'ciudad', 'city'],
  provincia: ['provincia', 'estado', 'state'],
  codigoPostal: ['codigo postal', 'cp', 'cod postal', 'zip'],
  codigoExterno: ['codigo', 'cod', 'id', 'codigo interno', 'nro', 'numero de cliente', 'legajo'],

  sku: ['sku', 'codigo articulo', 'cod articulo', 'cod. articulo', 'codigo producto', 'articulo'],
  nombre: ['nombre', 'descripcion', 'detalle', 'producto', 'articulo', 'denominacion'],
  descripcion: ['descripcion', 'detalle', 'descripcion larga', 'observaciones'],
  unidad: ['unidad', 'unidad de medida', 'um', 'medida'],
  precio: ['precio', 'precio unitario', 'precio de venta', 'importe unitario', 'pvp'],
  moneda: ['moneda', 'divisa', 'currency'],
  alicuotaIva: ['alicuota', 'alicuota iva', 'iva %', 'porcentaje iva', 'tasa iva'],

  codigo: ['codigo', 'cuenta', 'codigo de cuenta', 'nro cuenta', 'cod cuenta'],
  imputable: ['imputable', 'es imputable', 'permite imputar', 'movimiento'],
  codigoPadre: ['cuenta padre', 'codigo padre', 'depende de', 'padre'],

  fecha: ['fecha', 'fecha comprobante', 'fecha emision', 'fecha de emision', 'date', 'f. emision'],
  debe: ['debe', 'debito', 'debitos', 'importe debe'],
  haber: ['haber', 'credito', 'creditos', 'importe haber'],
  asiento: ['asiento', 'nro asiento', 'numero de asiento', 'comprobante'],
  cuenta: ['cuenta', 'codigo de cuenta', 'cod cuenta', 'imputacion'],

  cantidad: ['cantidad', 'cant', 'stock', 'existencia', 'unidades', 'qty'],
  deposito: ['deposito', 'almacen', 'sucursal', 'ubicacion'],
  costoUnitario: ['costo', 'costo unitario', 'precio de costo', 'valor unitario'],
  fechaCorte: ['fecha de corte', 'fecha corte', 'al', 'fecha stock'],

  numero: ['numero', 'nro', 'nro comprobante', 'numero de comprobante', 'comprobante'],
  tipoComprobante: ['tipo comprobante', 'tipo', 'tipo de comprobante', 'letra'],
  puntoVenta: ['punto de venta', 'punto venta', 'pto vta', 'pv', 'sucursal'],
  total: ['total', 'importe total', 'importe', 'total comprobante'],
  neto: ['neto', 'neto gravado', 'subtotal', 'importe neto'],
  iva: ['iva', 'importe iva', 'iva 21', 'impuesto'],
  cae: ['cae', 'cai', 'caea', 'codigo autorizacion'],
  cuitCliente: ['cuit cliente', 'cuit del cliente', 'cuit'],
  cuitProveedor: ['cuit proveedor', 'cuit del proveedor', 'cuit'],
  razonSocialCliente: ['cliente', 'razon social cliente', 'nombre cliente'],
  razonSocialProveedor: ['proveedor', 'razon social proveedor', 'nombre proveedor'],

  importe: ['importe', 'monto', 'total', 'valor'],
  medio: ['medio', 'medio de pago', 'forma de pago', 'metodo'],
  referencia: ['referencia', 'ref', 'nro operacion', 'comprobante'],
  cuitTercero: ['cuit', 'cuit tercero'],
};

/** Sin tildes, sin puntuación y en minúsculas: así se comparan los nombres. */
export function normalizarNombre(columna: string): string {
  return (
    columna
      .normalize('NFD')
      .replace(/\p{Diacritic}/gu, '')
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, ' ')
      .trim()
      // Las siglas escritas con puntos vuelven a ser una palabra.
      //
      // `C.U.I.T.` quedaba en «c u i t» y no coincidía con ningún sinónimo, así
      // que la columna del CUIT no se mapeaba sola. No es un caso de
      // laboratorio: es como la escriben varios sistemas de acá, y el efecto
      // era que quien migraba tenía que asignarla a mano sin entender por qué
      // justo esa.
      //
      // El patrón exige que **todos** los tramos sean de una letra, incluido el
      // último: «e mail» no se junta porque «mail» no lo es, y «razon social»
      // tampoco.
      .replace(/\b(?:[a-z] )+[a-z]\b/g, (sigla) => sigla.replace(/ /g, ''))
  );
}

export interface Sugerencia {
  readonly columna: string;
  readonly campo: string;
  /** 1 cuando el nombre coincide exacto; 0.6 cuando uno contiene al otro. */
  readonly confianza: number;
}

/**
 * Propone un mapeo para una entidad.
 *
 * Solo mira los campos que esa entidad admite: ofrecer `cuitProveedor` cuando
 * se están cargando productos no ayuda, confunde.
 *
 * Una columna se sugiere una sola vez, para el campo de mayor confianza. Dos
 * columnas apuntando al mismo campo es un error que se ve enseguida; una
 * columna apuntando a dos campos no se ve nunca.
 */
export function sugerirMapeo(
  entidad: Entidad,
  columnas: readonly string[],
): readonly Sugerencia[] {
  const forma = FORMAS[entidad];
  const admitidos = [...forma.obligatorios, ...forma.opcionales];

  const candidatas: Sugerencia[] = [];
  for (const columna of columnas) {
    const nombre = normalizarNombre(columna);
    if (nombre === '') continue;

    for (const campo of admitidos) {
      const sinonimos = SINONIMOS[campo] ?? [];

      // El nombre exacto del campo gana sobre el sinónimo de otro campo.
      //
      // Los dos valían 1 y el desempate quedaba en el orden de la lista: en una
      // exportación de ventas, la columna «IVA» se mapeaba a `condicionIva`
      // —que tiene «iva» entre sus sinónimos— en vez de al campo `iva`, y el
      // comprobante entraba sin impuesto. Lo encontró abrir la pantalla y mirar
      // la propuesta.
      if (normalizarNombre(campo) === nombre) {
        candidatas.push({ columna, campo, confianza: 1 });
        continue;
      }
      if (sinonimos.includes(nombre)) {
        candidatas.push({ columna, campo, confianza: 0.9 });
        continue;
      }
      // Coincidencia parcial: «cuit del cliente» contra «cuit cliente». Vale
      // menos a propósito, y con menos de uno la UI la muestra para confirmar.
      if (sinonimos.some((s) => nombre.includes(s) || s.includes(nombre))) {
        candidatas.push({ columna, campo, confianza: 0.6 });
      }
    }
  }

  const mejorPorColumna = new Map<string, Sugerencia>();
  for (const c of candidatas) {
    const previa = mejorPorColumna.get(c.columna);
    if (previa === undefined || c.confianza > previa.confianza) mejorPorColumna.set(c.columna, c);
  }

  // Y un campo tampoco se puede llenar desde dos columnas: gana la de más
  // confianza y la otra queda sin mapear, para que la persona decida.
  const mejorPorCampo = new Map<string, Sugerencia>();
  for (const s of mejorPorColumna.values()) {
    const previa = mejorPorCampo.get(s.campo);
    if (previa === undefined || s.confianza > previa.confianza) mejorPorCampo.set(s.campo, s);
  }

  // ── El repaso ─────────────────────────────────────────────────────────
  //
  // Un obligatorio sin mapear vuelve inútil a toda la tabla: la entidad no se
  // reconoce y no entra nada. Si alguna columna que quedó asignada a un campo
  // **opcional** también servía para ese obligatorio, se la lleva ahí.
  //
  // Es el caso de una exportación de productos con las columnas «SKU»,
  // «Descripción» y «Precio»: «Descripción» coincide exacto con el campo
  // `descripcion`, que es opcional, y por sinónimo con `nombre`, que es
  // obligatorio. Sin este repaso el producto se queda sin nombre y la tabla
  // deja de reconocerse como productos — que es lo que un humano leyendo esas
  // tres columnas no dudaría ni un segundo.
  for (const obligatorio of forma.obligatorios) {
    if (mejorPorCampo.has(obligatorio)) continue;
    const opcionales = new Set(forma.opcionales);

    const rescate = candidatas
      .filter((c) => c.campo === obligatorio)
      .map((c) => ({ c, asignada: mejorPorCampo.get(mejorPorColumna.get(c.columna)!.campo) }))
      .find(({ c, asignada }) => asignada?.columna === c.columna && opcionales.has(asignada.campo));

    if (rescate !== undefined) {
      mejorPorCampo.delete(rescate.asignada!.campo);
      mejorPorCampo.set(obligatorio, { ...rescate.c, campo: obligatorio });
    }
  }

  return [...mejorPorCampo.values()].sort((a, b) => a.campo.localeCompare(b.campo));
}

/** La sugerencia como el mapa columna→campo que consume el normalizador. */
export function comoMapa(sugerencias: readonly Sugerencia[]): Record<string, string> {
  return Object.fromEntries(sugerencias.map((s) => [s.columna, s.campo]));
}

/**
 * Qué entidad parece traer una tabla.
 *
 * Se decide por los campos **obligatorios** que se pudieron mapear, no por el
 * total: una tabla de ventas mapea `fecha` y `total` como cualquier otra, y lo
 * que la distingue es que además tenga `numero`.
 */
export function adivinarEntidad(columnas: readonly string[]): Entidad | null {
  let mejor: { entidad: Entidad; exactos: number; obligatorios: number; puntos: number } | null =
    null;

  for (const forma of Object.values(FORMAS)) {
    const sugerencias = sugerirMapeo(forma.entidad, columnas);
    const campos = new Set(sugerencias.map((s) => s.campo));
    const cubiertos = forma.obligatorios.filter((o) => campos.has(o)).length;
    if (cubiertos < forma.obligatorios.length) continue;

    // Tres criterios, en orden, y el primero es el que importa.
    //
    //   1. Cuántos obligatorios se reconocieron **por su nombre exacto**. Un
    //      archivo de depósitos con las columnas «Codigo» y «Nombre» las tiene
    //      las dos: es un depósito. Como tercero también «cubre» su único
    //      obligatorio —«Nombre» es sinónimo de razón social— y ganaba por
    //      tener más campos opcionales reconocidos, que es exactamente el
    //      criterio equivocado.
    //   2. Cuántos obligatorios pide la entidad: entre dos que encajan igual de
    //      bien, la que exige más es la más específica.
    //   3. Cuántos campos reconoce en total.
    const exactos = forma.obligatorios.filter((o) =>
      sugerencias.some((s) => s.campo === o && s.confianza === 1),
    ).length;
    const candidata = {
      entidad: forma.entidad,
      exactos,
      obligatorios: forma.obligatorios.length,
      puntos: campos.size,
    };

    if (mejor === null || ganaLa(candidata, mejor)) mejor = candidata;
  }

  return mejor?.entidad ?? null;
}

interface Candidata {
  readonly exactos: number;
  readonly obligatorios: number;
  readonly puntos: number;
}

const ganaLa = (a: Candidata, b: Candidata): boolean =>
  a.exactos !== b.exactos
    ? a.exactos > b.exactos
    : a.obligatorios !== b.obligatorios
      ? a.obligatorios > b.obligatorios
      : a.puntos > b.puntos;
