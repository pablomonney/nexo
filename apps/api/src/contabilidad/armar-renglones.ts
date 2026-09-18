/**
 * De un comprobante y el mapeo declarado, a los renglones de un asiento.
 *
 * Es la función que faltaba. `decision-de-comprobante.ts` siempre supo producir
 * una propuesta con renglones —recibe el armador como parámetro— y la API le
 * pasaba `() => []`, así que la propuesta salía vacía y encima se descartaba.
 * No era un olvido: sin saber a qué cuenta va cada cosa, armar el asiento
 * exigía que el sistema eligiera la cuenta, y eso es inventar la contabilidad
 * de alguien.
 *
 * ## No inventa una sola cuenta
 *
 * Todo sale de lo que la empresa declaró: el mapeo por rol
 * (`company_account_map`) y, cuando el renglón del comprobante dice qué producto
 * es, la cuenta que ese producto declara (`products.sales_account_id` /
 * `purchase_account_id`). Si falta un rol que hace falta, no arma nada y **dice
 * cuál falta**. Nunca elige «la cuenta más parecida».
 *
 * ## La cuenta del producto, cuando la línea es de ese producto
 *
 * El comprobante tiene un total de neto gravado y, si alguien cargó el detalle,
 * también renglones. Un renglón con producto es el único caso en que el sistema
 * sabe, sin suponer nada, de qué objeto concreto está hablando: es **ese**
 * producto, declarado por quien cargó la factura. Si ese producto tiene una
 * cuenta configurada, esa cuenta es la de ese renglón.
 *
 * Lo que queda sin resolver —renglones sin producto, productos sin cuenta, y el
 * comprobante entero cuando no tiene detalle— va a la cuenta del rol genérico,
 * que es exactamente lo que pasaba antes de que esto existiera.
 *
 * **Esto no es una precedencia general.** No dice que el producto le gane a
 * nada: dice que cuando el contexto es inequívocamente un producto, la
 * configuración de ese producto es la que corresponde a su renglón. El rol
 * genérico no compite por ese renglón, porque nunca fue una declaración sobre
 * ese producto; es lo que la empresa dijo para todo lo demás.
 *
 * ## Qué cuenta de producto NO se usa
 *
 * Una que no exista, sea de otra empresa, esté archivada o no sea imputable. El
 * armador no lo comprueba —no habla con la base— sino que **recibe el código ya
 * comprobado, o `null`**. Quien lee se encarga de que un `null` sea
 * indistinguible de «no hay cuenta», y entonces la línea cae en la genérica. Una
 * configuración inválida no puede producir un renglón válido por accidente
 * porque nunca llega hasta acá.
 *
 * ## La clase decide para qué lado va
 *
 * Una nota de crédito de ventas no es una venta con otro nombre: deshace una.
 * La dirección económica sale de `signoDe`, el **mismo** mecanismo que usa el
 * subdiario de IVA, alimentado por la clase que `arca_comprobante_types`
 * resuelve por fecha. Acá no hay ninguna lista de códigos, y no hay un caso
 * especial para notas de crédito: hay un signo, que las notas de débito y las
 * facturas comparten porque económicamente hacen lo mismo.
 *
 * Si la clase no se puede resolver, no se propone nada. Suponer que suma tiene
 * una chance en dos de invertir la operación, y el asiento invertido cuadra.
 *
 * ## Y no arma lo que no sabe armar
 *
 * Se arma el caso que el mapeo cubre: neto gravado más IVA contra la cuenta
 * corriente del tercero. Si el comprobante trae conceptos que ese mapeo no
 * contempla —no gravado, exento, percepciones— **no se propone nada**, con el
 * motivo escrito. Meterlos en la cuenta de ventas porque «total tiene que
 * cerrar» produciría un asiento cuadrado y equivocado, que es la peor
 * combinación posible: pasa todos los controles y dice una mentira.
 *
 * ## Cuadra por construcción, y aun así se comprueba
 *
 * El último control suma los dos lados. Si no dan iguales no se propone: un
 * asiento descuadrado lo rechazaría el candado de la base, pero llegar hasta
 * ahí ya habría hecho perder el tiempo a una persona.
 */

import type { Money, RolContable } from '@aai/shared';
import { money, moneyFromDecimalString, toDecimalString } from '@aai/shared';
import { signoDe, type ClaseComprobante } from '@aai/tax-engine';

// Los roles viven en `@aai/shared`: estaban escritos cuatro veces -acá, en
// `mapeo-contable.ts`, en el CHECK de la 0079 y en el catálogo de cuentas- y
// cuatro copias de una decisión se desincronizan sin que nada avise.
export type { RolContable } from '@aai/shared';

export interface CuentaDelRol {
  readonly rol: RolContable;
  readonly codigo: string;
  readonly exigeTercero: boolean;
}

/**
 * Un renglón del comprobante, con su cuenta ya resuelta.
 *
 * `cuentaEspecifica` es el **código** de la cuenta que el producto de esta línea
 * declara para esta dirección, y llega ya comprobada: existe, es de esta
 * empresa, está activa y es imputable. `null` cubre los cuatro casos en que no
 * hay cuenta que usar —la línea no tiene producto, el producto no declaró
 * ninguna, o la que declaró no sirve— y los cuatro terminan igual: en el rol
 * genérico. Que sean indistinguibles es deliberado; distinguirlos acá obligaría
 * al armador a decidir qué hacer con una configuración rota, y eso no es suyo.
 */
export interface LineaParaArmar {
  readonly lineNo: number;
  readonly neto: Money;
  readonly cuentaEspecifica: string | null;
}

export interface ComprobanteParaArmar {
  readonly direccion: 'VENTAS' | 'COMPRAS';
  /**
   * La clase, resuelta desde `arca_comprobante_types` **por fecha**.
   *
   * De acá sale la dirección económica del asiento, y sale por el mismo camino
   * que la del subdiario: `signoDe`. No hay una lista de códigos en este
   * archivo, igual que no la hay allá — los tipos de comprobante son una tabla
   * que ARCA versiona en el tiempo, y escribir «la nota de crédito es la 3»
   * sería cablear una vigencia.
   *
   * `null` significa que el código no está en el catálogo a esa fecha, y
   * entonces no se propone nada: sin saber la clase no se sabe para qué lado va
   * el asiento, y elegir uno tendría una chance en dos de invertir la
   * operación.
   */
  readonly clase: ClaseComprobante | null;
  readonly neto: Money;
  readonly iva: Money;
  readonly total: Money;
  readonly noGravado: Money;
  readonly exento: Money;
  readonly percepciones: Money;
  readonly terceroId: string | null;
  readonly descripcion: string;
  /**
   * El detalle, si alguien lo cargó. Sin él se arma como siempre: todo el neto a
   * la cuenta del rol. Un comprobante sin renglones es válido y frecuente —el
   * de un proveedor, el que llega por OCR sin detalle legible— y la 0049 lo dice
   * expresamente.
   */
  readonly lineas?: readonly LineaParaArmar[];
}

export interface RenglonPropuesto {
  readonly accountCode: string;
  readonly debit: string;
  readonly credit: string;
  readonly descripcion: string;
  readonly partyId?: string;
}

export interface Construccion {
  readonly renglones: readonly RenglonPropuesto[];
  /** Por qué no hay renglones. `null` cuando sí los hay. */
  readonly motivo: string | null;
  /** Los roles que hicieron falta y no estaban declarados. */
  readonly rolesFaltantes: readonly RolContable[];
}

const CERO = '0';

function vacia(motivo: string, rolesFaltantes: readonly RolContable[] = []): Construccion {
  return { renglones: [], motivo, rolesFaltantes };
}

/**
 * Arma los renglones, o explica por qué no.
 *
 * Nunca lanza: la llama `decidir()` en medio de una transacción, y una excepción
 * ahí convertiría «falta declarar una cuenta» en un error 500.
 */
export function armarRenglones(
  comprobante: ComprobanteParaArmar,
  mapeo: ReadonlyMap<RolContable, CuentaDelRol>,
): Construccion {
  const otros = [comprobante.noGravado, comprobante.exento, comprobante.percepciones];
  if (otros.some((m) => m.amount !== 0n)) {
    return vacia(
      'El comprobante trae conceptos que el mapeo declarado no contempla (no gravado, ' +
        'exento o percepciones). Meterlos en la cuenta de ventas para que el total cierre ' +
        'daría un asiento cuadrado y equivocado: se propone nada y lo arma una persona.',
    );
  }

  const esVenta = comprobante.direccion === 'VENTAS';
  const rolContraparte: RolContable = esVenta ? 'CLIENTES' : 'PROVEEDORES';
  const rolResultado: RolContable = esVenta ? 'VENTAS' : 'COMPRAS';
  const rolIva: RolContable = esVenta ? 'IVA_DEBITO' : 'IVA_CREDITO';

  // -------------------------------------------------------------------------
  // Para qué lado va el asiento
  // -------------------------------------------------------------------------
  // La dirección la da la dirección de la operación —venta o compra— corregida
  // por la clase del comprobante. Son dos cosas distintas y se combinan una vez:
  //
  //     venta  + factura o nota de débito  → el cliente debe
  //     venta  + nota de crédito           → el cliente ya no debe
  //     compra + factura o nota de débito  → se le debe al proveedor
  //     compra + nota de crédito           → ya no se le debe
  //
  // La nota de débito no lleva caso propio y no debería llevarlo: `signoDe` le
  // da `1n`, igual que a una factura, porque económicamente hace lo mismo. Un
  // `if` para notas de crédito habría dejado a la de débito adivinando.
  //
  // El signo se aplica **una sola vez**, acá. Los importes de `tax_transactions`
  // se guardan sin signo —la 0021 lo dice y sus CHECK lo obligan— y el subdiario
  // lo aplica por su cuenta sobre los suyos. Los dos consumidores parten del
  // mismo dato sin signo y ninguno ve lo que hizo el otro.
  const signo = signoDe(comprobante.clase);
  if (signo === null) {
    return vacia(
      'No se sabe qué clase de comprobante es: su tipo no está en el catálogo de ARCA ' +
        'vigente a esa fecha. De la clase depende para qué lado va el asiento —una nota de ' +
        'crédito lo invierte— y suponerla tiene una chance en dos de dar vuelta la ' +
        'operación. Sincronizá el catálogo desde ARCA.',
    );
  }

  /** Una nota de crédito invierte los dos lados; nada más cambia. */
  const invertido = signo === -1n;
  const contraparteAlDebe = esVenta !== invertido;

  // -------------------------------------------------------------------------
  // Cuánto neto resuelve cada cuenta
  // -------------------------------------------------------------------------
  // Se agrupa por código y en orden de aparición: dos renglones del mismo
  // producto son un solo renglón contable por esa cuenta, no dos iguales.
  const lineas = comprobante.lineas ?? [];
  const porCuenta = new Map<string, bigint>();
  let restoGenerico = comprobante.neto.amount;

  if (lineas.length > 0) {
    // La 0049 garantiza al COMMIT que los renglones cierran contra la cabecera.
    // Se vuelve a comprobar acá porque este cálculo se apoya en esa igualdad:
    // si no se cumpliera, el neto se repartiría mal y el asiento saldría
    // cuadrado —el control final mira total contra neto más IVA— y equivocado.
    const suma = lineas.reduce((acumulado, l) => acumulado + l.neto.amount, 0n);
    if (suma !== comprobante.neto.amount) {
      return vacia(
        `Los renglones del comprobante suman ${toDecimalString(money(suma, comprobante.neto.currency))} ` +
          `de neto y la cabecera dice ${toDecimalString(comprobante.neto)}. No se propone un ` +
          'asiento repartido sobre un detalle que no cierra.',
      );
    }

    restoGenerico = 0n;
    for (const linea of lineas) {
      if (linea.cuentaEspecifica === null) {
        restoGenerico += linea.neto.amount;
        continue;
      }
      porCuenta.set(
        linea.cuentaEspecifica,
        (porCuenta.get(linea.cuentaEspecifica) ?? 0n) + linea.neto.amount,
      );
    }
  }

  /**
   * Si ninguna línea resolvió por su cuenta, el rol genérico lleva todo y hace
   * falta igual que siempre —incluso con neto cero, que es el comportamiento
   * que había—. Si resolvieron todas, no hace falta: exigir una declaración que
   * el asiento no va a usar es el mismo error que exigir la cuenta de IVA para
   * un comprobante que no lo discrimina.
   */
  const necesitaGenerico = porCuenta.size === 0 || restoGenerico !== 0n;

  const necesarios: RolContable[] = [rolContraparte];
  if (necesitaGenerico) necesarios.push(rolResultado);
  if (comprobante.iva.amount !== 0n) necesarios.push(rolIva);

  const faltantes = necesarios.filter((rol) => !mapeo.has(rol));
  if (faltantes.length > 0) {
    return vacia(
      'Falta declarar a qué cuenta va: ' +
        faltantes.join(', ') +
        '. Sin eso el sistema no elige ninguna: elegirla sería inventar la contabilidad de ' +
        'esta empresa.',
      faltantes,
    );
  }

  const contraparte = mapeo.get(rolContraparte)!;

  // El resto va al rol genérico. Se agrega al mismo agrupamiento: si un producto
  // declaró justamente la cuenta del rol, es un renglón solo y no dos iguales.
  if (necesitaGenerico) {
    const generico = mapeo.get(rolResultado)!.codigo;
    porCuenta.set(generico, (porCuenta.get(generico) ?? 0n) + restoGenerico);
  }

  if (contraparte.exigeTercero && comprobante.terceroId === null) {
    return vacia(
      `La cuenta ${contraparte.codigo} exige tercero y el comprobante todavía no está ` +
        'vinculado a uno. Vinculalo y la propuesta se arma sola.',
    );
  }

  const tercero = comprobante.terceroId === null ? {} : { partyId: comprobante.terceroId };

  const importe = (bruto: bigint): string =>
    toDecimalString(money(bruto, comprobante.neto.currency));

  /**
   * Un renglón, del lado que le toca.
   *
   * `alDebe` se decide por contraste con la contraparte: el resultado y el IVA
   * van siempre del lado opuesto al de ella, en las cuatro combinaciones de
   * dirección y clase. Escribirlo así en vez de repetir el ternario en cada
   * renglón es lo que hace que agregar la clase no haya multiplicado los casos.
   */
  const renglon = (
    accountCode: string,
    monto: string,
    alDebe: boolean,
    descripcion: string,
    extra: { partyId?: string } = {},
  ): RenglonPropuesto => ({
    accountCode,
    debit: alDebe ? monto : CERO,
    credit: alDebe ? CERO : monto,
    descripcion,
    ...extra,
  });

  // El resultado: un renglón por cuenta. Cuando ninguna línea resolvió por su
  // cuenta, el agrupamiento tiene un solo elemento —la genérica con todo el
  // neto— y estos renglones son exactamente los que este armador daba antes.
  const deResultado: RenglonPropuesto[] = [...porCuenta].map(([codigo, monto]) =>
    renglon(codigo, importe(monto), !contraparteAlDebe, comprobante.descripcion),
  );

  const deContraparte = renglon(
    contraparte.codigo,
    toDecimalString(comprobante.total),
    contraparteAlDebe,
    comprobante.descripcion,
    tercero,
  );

  // Débito o crédito fiscal es la dirección de la operación, no la clase: el IVA
  // de una nota de crédito de ventas sigue siendo débito fiscal, lo que cambia
  // es de qué lado del asiento cae.
  const deIva: readonly RenglonPropuesto[] =
    comprobante.iva.amount === 0n
      ? []
      : [
          renglon(
            mapeo.get(rolIva)!.codigo,
            toDecimalString(comprobante.iva),
            !contraparteAlDebe,
            `IVA ${esVenta ? 'débito' : 'crédito'} fiscal`,
          ),
        ];

  // Los débitos primero, en los cuatro casos: cuando la contraparte está al debe
  // encabeza, y cuando no, cierra.
  const renglones: RenglonPropuesto[] = contraparteAlDebe
    ? [deContraparte, ...deResultado, ...deIva]
    : [...deResultado, ...deIva, deContraparte];

  // Cuadra por construcción —total = neto + IVA— y aun así se comprueba: llegar
  // al candado de la base con un descuadre ya habría hecho perder el tiempo a
  // una persona. La suma es en enteros: los importes nunca pasan por un float.
  const debe = comprobante.total.amount;
  const haber = comprobante.neto.amount + comprobante.iva.amount;
  if (debe !== haber) {
    return vacia(
      `El total (${toDecimalString(comprobante.total)}) no es la suma del neto y el IVA ` +
        `(${toDecimalString(comprobante.neto)} + ${toDecimalString(comprobante.iva)}). ` +
        'No se propone un asiento que no cuadra.',
    );
  }

  // Y ahora se suman **los renglones**, no los totales del comprobante.
  //
  // El control de arriba dice que el comprobante es coherente consigo mismo; no
  // dice nada sobre el reparto. Desde que el neto se puede partir entre varias
  // cuentas hay una forma nueva de equivocarse —repartir de más, repartir de
  // menos— que un asiento con el total correcto taparía por completo. Es la
  // regla de ADR-022 aplicada al reparto: si el número se calculó, se recalcula.
  const enCentavos = (decimal: string): bigint =>
    moneyFromDecimalString(decimal, comprobante.neto.currency).amount;
  const sumaDebe = renglones.reduce((a, r) => a + enCentavos(r.debit), 0n);
  const sumaHaber = renglones.reduce((a, r) => a + enCentavos(r.credit), 0n);
  if (sumaDebe !== sumaHaber) {
    return vacia(
      `Los renglones armados no cuadran: el debe suma ${importe(sumaDebe)} y el haber ` +
        `${importe(sumaHaber)}. Es un error del reparto entre cuentas, no del comprobante.`,
    );
  }

  return { renglones, motivo: null, rolesFaltantes: [] };
}
