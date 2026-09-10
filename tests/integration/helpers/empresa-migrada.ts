/**
 * La empresa de prueba que se migra entera.
 *
 * Diez archivos dentro de un ZIP, que es la forma en que llega una exportación
 * real: no un CSV por vez, sino todo junto. Están escritos con los defectos que
 * traen los archivos de verdad —separadores distintos, importes con miles,
 * fechas dd/mm/aaaa, encabezados con puntos— porque un dataset limpio prueba el
 * camino que nunca falla.
 *
 * Las entidades se referencian entre sí a propósito: las ventas citan clientes
 * y productos que están en otros archivos, los pagos citan comprobantes de
 * compra, los asientos citan cuentas del plan. Es lo único que ejercita el
 * orden de importación y la resolución de referencias, que es donde una
 * migración de verdad se rompe.
 *
 * Las cifras están elegidas para que **cierren**: la reconciliación tiene que
 * poder dar cero, y un dataset donde no cierra por construcción no permitiría
 * distinguir un error del importador de un error del dataset.
 */

/** Las fechas caen todas dentro del período que arma `seed`. */
export const FECHA = '15/01/2025';
export const FECHA_ISO = '2025-01-15';

/** Los movimientos posteriores al corte van cinco días después. */
export const FECHA_POSTERIOR = '20/01/2025';

export const DEPOSITOS = [
  'Codigo;Nombre;Direccion',
  'CENTRAL;Depósito central;Av. Siempreviva 742',
  'SUCURSAL;Depósito sucursal;',
].join('\n');

/**
 * El plan de cuentas, con jerarquía.
 *
 * Deliberadamente desordenado: `1.1.01` aparece antes que `1.1`. El importador
 * tiene que ordenarlo por profundidad, o `assert_leaf_is_postable` lo rechaza.
 */
// Las ramas son 2 y 5 y no 1 y 4 a propósito: la empresa de prueba ya tiene
// `1.1.01` y `4.1.01` cargadas a mano, y usarlas haría que el importador las
// reconociera como existentes —que es lo correcto— sin llegar a ejercitar el
// armado de la jerarquía, que es lo que esta prueba mira.
export const CUENTAS = [
  'Codigo;Nombre;Tipo;Cuenta padre',
  '2.1.01;Proveedores;PASIVO;2.1',
  '2;Pasivo;PASIVO;',
  '2.1;Deudas comerciales;PASIVO;2',
  '5;Costos;COSTO;',
  '5.1;Costo de ventas;COSTO;5',
  '5.1.01;Mercadería vendida;COSTO;5.1',
].join('\n');

export const CLIENTES = [
  'RAZON SOCIAL,C.U.I.T.,E-MAIL,Condicion IVA,Tipo',
  'Acme SA,30-71000001-4,acme@empresa.test,Responsable Inscripto,Cliente',
  'Beta SRL,20-11111111-2,beta@empresa.test,Monotributo,Cliente',
  'Proveedora del Sur SA,27-11111111-7,sur@empresa.test,Responsable Inscripto,Proveedor',
].join('\n');

export const PRODUCTOS = [
  'SKU;Nombre;Descripcion;Unidad;Precio',
  'ART-001;Tornillo hexagonal;Caja de 100;UNIDAD;1.250,00',
  'ART-002;Arandela plana;Bolsa de 500;UNIDAD;480,50',
].join('\n');

/** La existencia que el sistema anterior declaraba a la fecha de corte. */
export const EXISTENCIAS = [
  'SKU;Deposito;Cantidad;Costo unitario;Fecha de corte',
  `ART-001;CENTRAL;100;800,00;${FECHA}`,
  `ART-002;CENTRAL;250;300,00;${FECHA}`,
  `ART-001;SUCURSAL;20;800,00;${FECHA}`,
].join('\n');

/**
 * Movimientos posteriores a la apertura.
 *
 * Van **después** de la fecha de corte a propósito: la existencia final de
 * ART-001 en CENTRAL deja de ser la de apertura, y la reconciliación —que
 * compara a la fecha de corte— tiene que seguir dando cero igual. Es la
 * diferencia entre reconciliar bien y comparar contra el número de hoy.
 */
export const MOVIMIENTOS = [
  'SKU;Deposito;Fecha;Tipo;Cantidad;Motivo;Codigo',
  `ART-001;CENTRAL;${FECHA_POSTERIOR};Salida;30;Venta al mostrador;MOV-1`,
  `ART-002;CENTRAL;${FECHA_POSTERIOR};Entrada;50;Compra al proveedor;MOV-2`,
].join('\n');

/**
 * Ventas con renglones: dos comprobantes, uno de ellos con dos renglones.
 *
 * Los totales cierran con las partes —`total = neto + iva`— y los renglones
 * cierran con la cabecera, que es lo que exige `assert_renglones_cierran`.
 */
export const VENTAS = [
  'Tipo;Punto de venta;Numero;Fecha;CUIT;Razon social;Neto;IVA;Total;SKU;Descripcion;Cantidad;Precio unitario;Neto renglon;IVA renglon',
  `FACTURA_A;1;101;${FECHA};30-71000001-4;Acme SA;10.000,00;2.100,00;12.100,00;ART-001;Tornillo hexagonal;8;1.250,00;10.000,00;2.100,00`,
  `FACTURA_A;1;102;${FECHA};20-11111111-2;Beta SRL;3.000,00;630,00;3.630,00;ART-002;Arandela plana;4;500,00;2.000,00;420,00`,
  `FACTURA_A;1;102;${FECHA};20-11111111-2;Beta SRL;3.000,00;630,00;3.630,00;ART-001;Tornillo hexagonal;1;1.000,00;1.000,00;210,00`,
].join('\n');

export const COMPRAS = [
  'Tipo;Punto de venta;Numero;Fecha;CUIT;Razon social;Neto;IVA;Total',
  `FACTURA_A;5;900;${FECHA};27-11111111-7;Proveedora del Sur SA;15.000,00;3.150,00;18.150,00`,
].join('\n');

/** Un pago que cita el comprobante de compra de arriba. */
export const PAGOS = [
  'Fecha;Importe;CUIT proveedor;Medio;Comprobante;Referencia',
  `${FECHA};18.150,00;27-11111111-7;Transferencia;900;OP-1`,
].join('\n');

/**
 * Asientos: dos, y el segundo con tres renglones.
 *
 * Las cuentas son las del plan de arriba, así que el importador tiene que haber
 * migrado las cuentas antes. Las filas del asiento 2 están **salteadas** en el
 * archivo, con el asiento 1 en el medio: agrupar por número de asiento tiene
 * que juntarlas igual.
 */
export const ASIENTOS = [
  'Asiento;Fecha;Cuenta;Debe;Haber;Descripcion',
  `2;${FECHA};1.1.01;5.000,00;0;Cobranza`,
  `1;${FECHA};1.1.01;12.100,00;0;Venta a Acme`,
  `2;${FECHA};2.1.01;0;3.000,00;Cobranza`,
  `1;${FECHA};2.1.01;0;12.100,00;Venta a Acme`,
  `2;${FECHA};2.1.01;0;2.000,00;Cobranza`,
].join('\n');

/** El ZIP tal como lo subiría alguien: un archivo por entidad. */
export const ARCHIVOS: Readonly<Record<string, string>> = {
  'depositos.csv': DEPOSITOS,
  'cuentas.csv': CUENTAS,
  'clientes.csv': CLIENTES,
  'productos.csv': PRODUCTOS,
  'existencias.csv': EXISTENCIAS,
  'movimientos.csv': MOVIMIENTOS,
  'ventas.csv': VENTAS,
  'compras.csv': COMPRAS,
  'pagos.csv': PAGOS,
  'asientos.csv': ASIENTOS,
};

/**
 * Qué entidad es cada archivo.
 *
 * Se declara acá y no se deja adivinar: la prueba tiene que comprobar el
 * importador, no el acierto del adivinador de entidades, que ya tiene sus
 * propias pruebas. Cuando el adivinador acierta igual, mejor — pero el
 * resultado del E2E no puede depender de eso.
 */
export const ENTIDAD_DE: Readonly<Record<string, string>> = {
  'depositos.csv': 'WAREHOUSE',
  'cuentas.csv': 'ACCOUNT',
  'clientes.csv': 'PARTY',
  'productos.csv': 'PRODUCT',
  'existencias.csv': 'STOCK_BALANCE',
  'movimientos.csv': 'STOCK_MOVEMENT',
  'ventas.csv': 'SALES_DOCUMENT',
  'compras.csv': 'PURCHASE_DOCUMENT',
  'pagos.csv': 'PAYMENT',
  'asientos.csv': 'JOURNAL_ENTRY',
};

/** El mapeo de cada archivo, columna del origen → campo canónico. */
export const MAPEO_DE: Readonly<Record<string, Readonly<Record<string, string>>>> = {
  'depositos.csv': { Codigo: 'codigo', Nombre: 'nombre', Direccion: 'direccion' },
  'cuentas.csv': { Codigo: 'codigo', Nombre: 'nombre', Tipo: 'tipo', 'Cuenta padre': 'codigoPadre' },
  'clientes.csv': {
    'RAZON SOCIAL': 'razonSocial',
    'C.U.I.T.': 'cuit',
    'E-MAIL': 'email',
    'Condicion IVA': 'condicionIva',
    Tipo: 'tipo',
  },
  'productos.csv': {
    SKU: 'sku',
    Nombre: 'nombre',
    Descripcion: 'descripcion',
    Unidad: 'unidad',
    Precio: 'precio',
  },
  'existencias.csv': {
    SKU: 'sku',
    Deposito: 'deposito',
    Cantidad: 'cantidad',
    'Costo unitario': 'costoUnitario',
    'Fecha de corte': 'fechaCorte',
  },
  'movimientos.csv': {
    SKU: 'sku',
    Deposito: 'deposito',
    Fecha: 'fecha',
    Tipo: 'tipo',
    Cantidad: 'cantidad',
    Motivo: 'motivo',
    Codigo: 'codigoExterno',
  },
  'ventas.csv': {
    Tipo: 'tipoComprobante',
    'Punto de venta': 'puntoVenta',
    Numero: 'numero',
    Fecha: 'fecha',
    CUIT: 'cuitCliente',
    'Razon social': 'razonSocialCliente',
    Neto: 'neto',
    IVA: 'iva',
    Total: 'total',
    SKU: 'sku',
    Descripcion: 'descripcion',
    Cantidad: 'cantidad',
    'Precio unitario': 'precioUnitario',
    'Neto renglon': 'netoRenglon',
    'IVA renglon': 'ivaRenglon',
  },
  'compras.csv': {
    Tipo: 'tipoComprobante',
    'Punto de venta': 'puntoVenta',
    Numero: 'numero',
    Fecha: 'fecha',
    CUIT: 'cuitProveedor',
    'Razon social': 'razonSocialProveedor',
    Neto: 'neto',
    IVA: 'iva',
    Total: 'total',
  },
  'pagos.csv': {
    Fecha: 'fecha',
    Importe: 'importe',
    'CUIT proveedor': 'cuitProveedor',
    Medio: 'medio',
    Comprobante: 'comprobante',
    Referencia: 'referencia',
  },
  'asientos.csv': {
    Asiento: 'asiento',
    Fecha: 'fecha',
    Cuenta: 'cuenta',
    Debe: 'debe',
    Haber: 'haber',
    Descripcion: 'descripcion',
  },
};
