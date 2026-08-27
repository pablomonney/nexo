/**
 * De una declaración de afectación al hecho que la regla necesita.
 *
 * El art. 12 de la Ley 23.349 condiciona el crédito fiscal a la vinculación con
 * operaciones gravadas. Ese hecho no se calcula: lo declara quien conoce la
 * operación, y llega acá desde `tax_affectations_declaradas` — la vista que solo
 * expone declaraciones profesionales completas.
 *
 * Este módulo traduce esa declaración al hecho `vinculadaConOperacionesGravadas`
 * y, sobre todo, **decide cuándo NO hay hecho**.
 *
 * ## La distinción que sostiene todo
 *
 * `false` significa "se determinó que no se vincula".
 * La ausencia significa "nadie lo determinó".
 *
 * Confundirlas produce el error más caro posible en este dominio: un crédito
 * declarado no computable porque nadie lo miró, con una cita del art. 12 al pie
 * que lo hace parecer fundado. Por eso la ausencia no se modela con `false` ni
 * con `null` dentro de los hechos — se modela **no poniendo la clave**, y el
 * intérprete cerrado lanza cuando la busca y no está.
 *
 * Esa decisión ya estaba tomada en `ast.ts`: *"una regla que no se aplica sin que
 * nadie se entere es peor que una que rompe"*. Acá es donde paga.
 */

export type Afectacion =
  | 'GRAVADAS'
  | 'EXENTAS'
  | 'NO_GRAVADAS'
  | 'MIXTA'
  | 'NO_DETERMINADA';

export type TipoDeEvidencia =
  | 'COMPROBANTE'
  | 'CUENTA'
  | 'CENTRO_DE_COSTO'
  | 'DOCUMENTO'
  | 'ASIENTO'
  | 'DECLARACION_PROFESIONAL'
  | 'NOTA';

export interface ItemDeEvidencia {
  readonly tipo: TipoDeEvidencia;
  /** Obligatorio salvo en `NOTA`. La base verifica que exista y sea de la empresa. */
  readonly id?: string;
  readonly texto?: string;
}

/**
 * Una declaración tal como sale de `tax_affectations_declaradas`.
 *
 * El tipo no admite `origen`: la vista ya filtró, y volver a traerlo invitaría a
 * comprobarlo de nuevo acá — un control duplicado que algún día diverge del que
 * manda. Si una fila llegó a este tipo, es porque la vista la dejó pasar.
 */
export interface DeclaracionDeAfectacion {
  readonly companyId: string;
  readonly taxTransactionId: string;
  readonly afectacion: Afectacion;
  readonly proporcionGravada: number | null;
  readonly declaradaPor: string;
  readonly declaradaAt: string;
  readonly evidencia: readonly ItemDeEvidencia[];
}

export type MotivoDeAusencia =
  /** No hay ninguna declaración para esa operación. */
  | 'SIN_DECLARACION'
  /** Hay una, y dice que no se pudo determinar. Para el motor es lo mismo. */
  | 'NO_DETERMINADA';

export type ProvisionDelHecho =
  | {
      readonly estado: 'PROVISTO';
      readonly valor: boolean;
      readonly declaracion: DeclaracionDeAfectacion;
    }
  | { readonly estado: 'AUSENTE'; readonly motivo: MotivoDeAusencia }
  | {
      readonly estado: 'REQUIERE_REVISION';
      readonly motivo: 'MIXTA_SIN_PRORRATEO';
      readonly declaracion: DeclaracionDeAfectacion;
      readonly explicacion: string;
    };

/**
 * El hecho, o la razón por la que no hay hecho.
 *
 * `MIXTA` no es ausencia ni es un booleano. Una operación afectada en parte a
 * gravadas y en parte a exentas **se vincula** —la respuesta literal al art. 12
 * sería `true`—, pero el cómputo no se resuelve ahí: lo gobierna el prorrateo del
 * art. 13, que no está relevado. Devolver `true` daría por computable la parte
 * exenta; devolver `false` negaría un crédito que existe. Las dos son falsas, así
 * que no se devuelve ninguna.
 */
export function proveerVinculacion(
  declaracion: DeclaracionDeAfectacion | null,
): ProvisionDelHecho {
  if (declaracion === null) return { estado: 'AUSENTE', motivo: 'SIN_DECLARACION' };

  switch (declaracion.afectacion) {
    case 'GRAVADAS':
      return { estado: 'PROVISTO', valor: true, declaracion };

    case 'EXENTAS':
    case 'NO_GRAVADAS':
      return { estado: 'PROVISTO', valor: false, declaracion };

    case 'MIXTA':
      return {
        estado: 'REQUIERE_REVISION',
        motivo: 'MIXTA_SIN_PRORRATEO',
        declaracion,
        explicacion:
          'La operación está afectada en parte a operaciones gravadas. El art. 12 se cumple, ' +
          'pero la medida del cómputo la fija el prorrateo del art. 13, que no está relevado. ' +
          'Resolver la regla acá daría por computable la parte no vinculada.',
      };

    case 'NO_DETERMINADA':
      return { estado: 'AUSENTE', motivo: 'NO_DETERMINADA' };
  }
}

/** Nombre del hecho, en un solo lugar. Escribirlo dos veces es escribirlo mal una. */
export const HECHO_VINCULACION = 'vinculadaConOperacionesGravadas' as const;

/**
 * Arma los hechos para el motor normativo.
 *
 * **La clave solo aparece cuando el hecho existe.** No hay una rama que ponga
 * `false` por defecto, y no la hay a propósito: si algún día alguien agrega un
 * estado nuevo a `Afectacion` y olvida contemplarlo, el hecho va a faltar y la
 * regla va a fallar ruidosamente. El costo de olvidarse es una excepción, no un
 * crédito mal negado.
 */
export function hechosDeAfectacion(
  provision: ProvisionDelHecho,
): Readonly<Record<string, boolean>> {
  return provision.estado === 'PROVISTO' ? { [HECHO_VINCULACION]: provision.valor } : {};
}
