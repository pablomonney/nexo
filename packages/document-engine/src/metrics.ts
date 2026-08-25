/**
 * Métricas de extracción por campo.
 *
 * La métrica que importa en este dominio no es la precisión global. Es la
 * **tasa de error silencioso**: la proporción de campos que el sistema
 * interpretó con seguridad y le erró.
 *
 * La asimetría es toda la razón de este archivo. Una abstención le cuesta al
 * contador un minuto de mirar el papel. Un error silencioso le cuesta un
 * asiento mal imputado que nadie revisó, y eventualmente una declaración jurada
 * mal presentada. Un sistema con 95% de cobertura y 3% de error silencioso es
 * peor que uno con 70% de cobertura y 0.1%, aunque el primero tenga mejor
 * número en la portada.
 *
 * Por eso el reporte separa siempre tres cosas que un "accuracy" mezcla:
 * lo que acertó, lo que erró, y lo que no quiso arriesgar.
 */

import type { CampoExtraido, ValorInterpretado } from './types.js';

export interface CasoCorpus {
  readonly id: string;
  /**
   * Valor esperado por campo, en forma canónica. `null` significa que el campo
   * **no está** en el documento: extraerlo es un falso positivo, no un acierto.
   */
  readonly esperado: Readonly<Record<string, string | null>>;
}

export interface MetricaCampo {
  readonly fieldPath: string;
  /** Casos en los que el campo existía y debía extraerse. */
  readonly intentos: number;
  readonly extraidos: number;
  readonly correctos: number;
  readonly incorrectos: number;
  readonly abstenciones: number;
  /** Casos donde el campo no estaba y el sistema igual devolvió un valor. */
  readonly falsosPositivos: number;
  readonly cobertura: number;
  readonly precision: number;
  readonly tasaErrorSilencioso: number;
  readonly confianzaMediaAciertos: number;
  readonly confianzaMediaErrores: number;
}

export interface ReporteMetricas {
  readonly casos: number;
  readonly porCampo: readonly MetricaCampo[];
  readonly generadoEn: string;
}

/** Forma canónica de un valor interpretado, para comparar contra el esperado. */
export function canonico(valor: ValorInterpretado | null): string | null {
  if (valor === null) return null;
  switch (valor.kind) {
    case 'MONEY':
      return `${valor.amount} ${valor.currency}`;
    case 'DATE':
    case 'CUIT':
    case 'INTEGER':
    case 'TEXT':
      return valor.value;
  }
}

interface Acumulador {
  intentos: number;
  extraidos: number;
  correctos: number;
  incorrectos: number;
  abstenciones: number;
  falsosPositivos: number;
  confianzaAciertos: number[];
  confianzaErrores: number[];
}

export function calcularMetricas(
  resultados: readonly { readonly caso: CasoCorpus; readonly campos: readonly CampoExtraido[] }[],
): ReporteMetricas {
  const acumuladores = new Map<string, Acumulador>();

  const obtener = (fieldPath: string): Acumulador => {
    let acumulador = acumuladores.get(fieldPath);
    if (acumulador === undefined) {
      acumulador = {
        intentos: 0,
        extraidos: 0,
        correctos: 0,
        incorrectos: 0,
        abstenciones: 0,
        falsosPositivos: 0,
        confianzaAciertos: [],
        confianzaErrores: [],
      };
      acumuladores.set(fieldPath, acumulador);
    }
    return acumulador;
  };

  for (const { caso, campos } of resultados) {
    for (const [fieldPath, esperado] of Object.entries(caso.esperado)) {
      const acumulador = obtener(fieldPath);
      const campo = campos.find((candidato) => candidato.fieldPath === fieldPath);
      const obtenido = canonico(campo?.parsedValue ?? null);

      if (esperado === null) {
        if (obtenido !== null) acumulador.falsosPositivos += 1;
        continue;
      }

      acumulador.intentos += 1;
      if (obtenido === null) {
        acumulador.abstenciones += 1;
        continue;
      }

      acumulador.extraidos += 1;
      if (obtenido === esperado) {
        acumulador.correctos += 1;
        acumulador.confianzaAciertos.push(campo?.confidence ?? 0);
      } else {
        acumulador.incorrectos += 1;
        acumulador.confianzaErrores.push(campo?.confidence ?? 0);
      }
    }
  }

  const porCampo = [...acumuladores.entries()]
    .map(([fieldPath, a]) => ({
      fieldPath,
      intentos: a.intentos,
      extraidos: a.extraidos,
      correctos: a.correctos,
      incorrectos: a.incorrectos,
      abstenciones: a.abstenciones,
      falsosPositivos: a.falsosPositivos,
      cobertura: proporcion(a.extraidos, a.intentos),
      precision: proporcion(a.correctos, a.extraidos),
      tasaErrorSilencioso: proporcion(a.incorrectos, a.intentos),
      confianzaMediaAciertos: promedio(a.confianzaAciertos),
      confianzaMediaErrores: promedio(a.confianzaErrores),
    }))
    .sort((a, b) => b.tasaErrorSilencioso - a.tasaErrorSilencioso || a.fieldPath.localeCompare(b.fieldPath));

  return { casos: resultados.length, porCampo, generadoEn: new Date().toISOString() };
}

function proporcion(numerador: number, denominador: number): number {
  if (denominador === 0) return 0;
  return Math.round((numerador / denominador) * 10_000) / 10_000;
}

function promedio(valores: readonly number[]): number {
  if (valores.length === 0) return 0;
  const suma = valores.reduce((acumulado, valor) => acumulado + valor, 0);
  return Math.round((suma / valores.length) * 10_000) / 10_000;
}

/** Reporte en Markdown, para publicar el criterio de salida de la fase. */
export function reporteMarkdown(reporte: ReporteMetricas): string {
  const filas = reporte.porCampo.map((metrica) =>
    [
      `\`${metrica.fieldPath}\``,
      metrica.intentos,
      metrica.extraidos,
      metrica.correctos,
      `**${metrica.incorrectos}**`,
      metrica.abstenciones,
      porcentaje(metrica.cobertura),
      porcentaje(metrica.precision),
      `**${porcentaje(metrica.tasaErrorSilencioso)}**`,
      // no-float-check: allow — confianza media, no dinero.
      metrica.confianzaMediaErrores.toFixed(2),
    ].join(' | '),
  );

  return [
    `# Métricas de extracción por campo`,
    ``,
    `Corpus: **${reporte.casos} documentos**. Generado: ${reporte.generadoEn}`,
    ``,
    `La columna que hay que mirar es **error silencioso**: campos interpretados con`,
    `seguridad y equivocados. Una abstención cuesta un minuto; un error silencioso`,
    `cuesta un asiento mal imputado que nadie revisó.`,
    ``,
    `La última columna es la confianza media *de los errores*. Si es alta, el`,
    `puntaje de confianza no está midiendo lo que dice medir.`,
    ``,
    `| Campo | Intentos | Extraídos | Correctos | Incorrectos | Abstenciones | Cobertura | Precisión | Error silencioso | Confianza media del error |`,
    `|---|---:|---:|---:|---:|---:|---:|---:|---:|---:|`,
    ...filas.map((fila) => `| ${fila} |`),
    ``,
  ].join('\n');
}

function porcentaje(valor: number): string {
  // Acá el punto flotante es la representación correcta, no un atajo: una tasa
  // de acierto no es un importe. no-float-check: allow
  return `${(valor * 100).toFixed(1)}%`;
}
