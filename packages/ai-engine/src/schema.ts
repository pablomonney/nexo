/**
 * Schema de salida del agente, y su validación.
 *
 * Dos cosas que hace este archivo y que son controles anti-alucinación reales,
 * no instrucciones en un prompt (§30, AI_ARCHITECTURE.md §4):
 *
 * **La salida es cerrada.** La cuenta no es un texto libre: es un `enum` con los
 * códigos del plan de cuentas de *esa* empresa. Un modelo no puede proponer una
 * cuenta que no existe porque el schema no se lo permite — y si igual la
 * devuelve, la validación la rechaza.
 *
 * **El schema no tiene dónde poner un importe.** No hay campo. La aritmética la
 * hacen el `tax-engine` y el `accounting-engine`; el modelo propone tratamiento.
 * Esto no se controla con una regla: no existe el lugar donde escribirlo.
 *
 * El mismo objeto que se le manda al proveedor es el que valida la respuesta. Un
 * schema para pedir y otro para validar se desincronizan a la primera semana.
 */

export interface OpcionCuenta {
  /** Código del plan: `5.1.03`. Es lo que ve el modelo. */
  readonly codigo: string;
  readonly nombre: string;
}

export interface OpcionesSchema {
  readonly cuentas: readonly OpcionCuenta[];
  /** Identificadores de norm_version que el agente tiene permitido citar. */
  readonly citasPermitidas: readonly string[];
  readonly tratamientos: readonly string[];
}

/**
 * Construye el JSON Schema de una clasificación.
 *
 * Es dinámico por necesidad: el plan de cuentas es por empresa, así que el
 * conjunto cerrado también. Un schema estático obligaría a aceptar texto libre
 * en el campo más importante.
 */
export function construirSchemaClasificacion(opciones: OpcionesSchema): Record<string, unknown> {
  return {
    type: 'object',
    additionalProperties: false,
    required: ['cuentaCodigo', 'tratamiento', 'confianza', 'razon', 'citas'],
    properties: {
      cuentaCodigo: {
        type: 'string',
        // El conjunto cerrado. Sin esto, "Gastos varios" y "5.1.03" son
        // igualmente válidos para el modelo, y solo uno existe.
        enum: opciones.cuentas.map((cuenta) => cuenta.codigo),
        description: 'Código de cuenta del plan de esta empresa. Elegir de la lista.',
      },
      tratamiento: {
        type: 'string',
        enum: opciones.tratamientos,
      },
      confianza: {
        type: 'number',
        minimum: 0,
        maximum: 1,
        description: 'Qué tan seguro está el modelo. Abstenerse no tiene costo.',
      },
      razon: {
        type: 'string',
        minLength: 10,
        maxLength: 1200,
        description: 'Por qué esa cuenta, en castellano, para que lo lea un contador.',
      },
      citas: {
        type: 'array',
        maxItems: 8,
        items: {
          type: 'object',
          additionalProperties: false,
          required: ['normVersionId'],
          properties: {
            normVersionId: {
              type: 'string',
              // Solo se puede citar lo que vino en el contexto. Una norma real
              // que el modelo "recuerda" pero que nadie le pasó no está
              // fundada en nada verificable.
              enum: opciones.citasPermitidas,
            },
            articulo: { type: 'string', maxLength: 60 },
          },
        },
      },
      /** El modelo puede decir que no sabe. Es una salida legítima, no un error. */
      abstencion: { type: 'boolean' },
    },
  };
}

// ---------------------------------------------------------------------------
// Validador
// ---------------------------------------------------------------------------

export interface ErrorSchema {
  readonly path: string;
  readonly mensaje: string;
}

/**
 * Valida contra el subconjunto de JSON Schema que este módulo emite.
 *
 * No es un validador general y no pretende serlo: cubre exactamente lo que
 * `construirSchemaClasificacion` produce. Una salida que no valida **se
 * descarta**; no se interpreta con buena voluntad ni se completa lo que falta.
 */
export function validarContraSchema(
  valor: unknown,
  schema: Record<string, unknown>,
  path = '$',
): readonly ErrorSchema[] {
  const errores: ErrorSchema[] = [];
  const tipo = schema['type'];

  if (tipo === 'object') {
    if (valor === null || typeof valor !== 'object' || Array.isArray(valor)) {
      return [{ path, mensaje: 'Se esperaba un objeto' }];
    }
    const objeto = valor as Record<string, unknown>;
    const propiedades = (schema['properties'] ?? {}) as Record<string, Record<string, unknown>>;

    for (const requerida of (schema['required'] ?? []) as string[]) {
      if (objeto[requerida] === undefined) {
        errores.push({ path: `${path}.${requerida}`, mensaje: 'Falta el campo obligatorio' });
      }
    }

    if (schema['additionalProperties'] === false) {
      for (const clave of Object.keys(objeto)) {
        if (propiedades[clave] === undefined) {
          errores.push({ path: `${path}.${clave}`, mensaje: 'Campo no previsto en el schema' });
        }
      }
    }

    for (const [clave, subSchema] of Object.entries(propiedades)) {
      if (objeto[clave] === undefined) continue;
      errores.push(...validarContraSchema(objeto[clave], subSchema, `${path}.${clave}`));
    }
    return errores;
  }

  if (tipo === 'array') {
    if (!Array.isArray(valor)) return [{ path, mensaje: 'Se esperaba un arreglo' }];
    const maxItems = schema['maxItems'];
    if (typeof maxItems === 'number' && valor.length > maxItems) {
      errores.push({ path, mensaje: `Como máximo ${maxItems} elementos` });
    }
    const items = schema['items'] as Record<string, unknown> | undefined;
    if (items !== undefined) {
      valor.forEach((elemento, indice) => {
        errores.push(...validarContraSchema(elemento, items, `${path}[${indice}]`));
      });
    }
    return errores;
  }

  if (tipo === 'string') {
    if (typeof valor !== 'string') return [{ path, mensaje: 'Se esperaba un texto' }];
    const enumerado = schema['enum'] as string[] | undefined;
    if (enumerado !== undefined && !enumerado.includes(valor)) {
      // El mensaje no lista las opciones: en un plan de cuentas de 400 cuentas
      // el log se vuelve ilegible, y el valor recibido es lo que importa.
      errores.push({ path, mensaje: `"${recortar(valor)}" no está entre los valores admitidos` });
    }
    const minLength = schema['minLength'];
    if (typeof minLength === 'number' && valor.length < minLength) {
      errores.push({ path, mensaje: `Necesita al menos ${minLength} caracteres` });
    }
    const maxLength = schema['maxLength'];
    if (typeof maxLength === 'number' && valor.length > maxLength) {
      errores.push({ path, mensaje: `Excede los ${maxLength} caracteres` });
    }
    return errores;
  }

  if (tipo === 'number') {
    if (typeof valor !== 'number' || !Number.isFinite(valor)) {
      return [{ path, mensaje: 'Se esperaba un número' }];
    }
    const minimum = schema['minimum'];
    if (typeof minimum === 'number' && valor < minimum) {
      errores.push({ path, mensaje: `Debe ser >= ${minimum}` });
    }
    const maximum = schema['maximum'];
    if (typeof maximum === 'number' && valor > maximum) {
      errores.push({ path, mensaje: `Debe ser <= ${maximum}` });
    }
    return errores;
  }

  if (tipo === 'boolean' && typeof valor !== 'boolean') {
    return [{ path, mensaje: 'Se esperaba un booleano' }];
  }

  return errores;
}

function recortar(valor: string): string {
  return valor.length <= 60 ? valor : `${valor.slice(0, 57)}...`;
}
