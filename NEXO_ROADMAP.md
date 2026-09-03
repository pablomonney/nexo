# NEXO_ROADMAP

**Recalculado:** 2026-09-02, después de medir. El censo está en
`NEXO_EVOLUTION_BASELINE.md`; esto es lo que sigue y por qué en ese orden.

Regla de este archivo: **cada línea dice qué la destraba**. Una prioridad sin eso
es una lista de deseos.

---

## Terminado en esta vuelta

| | Qué cerró |
|---|---|
| 0082 | Orden de pago — «pagada» exige el asiento imputado a cada comprobante |
| 0083 | La nota de crédito dice qué factura corrige |
| 0084 | El margen entra en las señales: hecho sin umbral, juicio con umbral |
| 0085 | Solicitud de compra — el último módulo LIBRE |
| 0086 | El promedio se calcula al escribir: 25 s → 44 ms con 50.000 movimientos |
| 0087 | Escenarios guardados: se guarda la pregunta, no la respuesta |
| — | NEXO Intelligence: doce preguntas con evidencia, narración verificada |
| — | Variación del margen abierta en precio, costo y volumen |
| — | Radar de riesgos: seis frentes, con lo que no se puede medir |

## P0 — Integridad

**Nada abierto.** RLS completo con `FORCE` en 107 tablas, Mayor sin
discrepancias, bitácora íntegra, `verify` en verde. El rendimiento crítico se
midió y se corrigió.

## P1 — Lo que se puede construir hoy

### 1. Medir el resto de las vistas con volumen

`npm run bench:vistas` carga volumen de **stock**. La bandeja da 229 ms con eso,
pero sus ramas de comprobantes, cheques y proyectos no tienen volumen detrás.

**Qué lo destraba:** nada. Es extender el generador del benchmark.

### 2. El adaptador de un proveedor de modelo

Todo el camino de la narración está cerrado y probado con el simulado. Falta un
archivo que implemente `LLMProvider`.

**Qué lo destraba:** una credencial de un tercero. Hasta que exista, declarar la
integración sería declarar algo que no se puede ejercitar.

### 3. Más preguntas en el catálogo

Doce hoy. Cada una nueva es una entrada con su consulta y su metodología.

**Qué lo destraba:** nada, salvo saber cuáles hacen falta — y eso se sabe usando
el sistema, no adivinando.

## P2 — Producción

| | Qué falta | Qué lo destraba |
|---|---|---|
| KMS | El cliente que pide SECURITY.md §5 | Elegir proveedor de KMS: **decisión** |
| ARCA producción | Certificado y credenciales reales | Trámite del cliente |
| Alta autoservicio | Verificación por correo | Proveedor de correo |
| Cobro de la suscripción | Pasarela | Credenciales y decisión de precios |
| Web comercial | — | Que haya un flujo honesto de «probar NEXO» |

Ninguno de los cinco se resuelve escribiendo código.

## P3 — Decision Engine

El ciclo está cortado después de «qué pasaría si». Ver
`NEXO_DECISION_ENGINE.md` §3: recomendar exige un objetivo declarado por la
empresa; medir el resultado de una decisión exige poder declarar que un
escenario se aplicó.

**Qué lo destraba:** una decisión de producto sobre cómo se declara un objetivo,
y otra sobre qué significa «aplicar» un escenario. Ninguna es técnica.

## P4 — ERP: lo que falta y por qué

| | Estado | Qué lo destraba |
|---|---|---|
| Retenciones y percepciones | BLOQUEADO | Archivar los regímenes y sus normas |
| Libro IVA Digital (exportar) | BLOQUEADO | Los diseños de registro no están en la RG |
| FIFO y costo de reposición | PLANIFICADO | Decisión contable (ADR-020) |
| Remitos y facturación parcial | REQUIERE_DECISION | Si NEXO admite facturar en partes y con qué reglas |
| Devoluciones | REQUIERE_DECISION | Depende de la anterior |
| Descuentos por regla | REQUIERE_DECISION | Una lista tiene precios, no reglas |
| Producción | REQUIERE_DECISION | Absorción de costos indirectos |
| RRHH | REQUIERE_DECISION | ADR-012 §8 |
| Momento de asentar el CMV | REQUIERE_DECISION | El asiento ya se **propone** (0079); automatizar cuándo es política contable |

## Deuda registrada

| | Gravedad |
|---|---|
| KMS ausente: sin él no hay producción con ARCA real | IMPORTANTE |
| 17 estados muertos en los CHECK, clasificados y no removidos | MENOR |
| `alerts` y `audit_findings` sin escritores | MENOR |
| Dos series `S-*` que se pisan (documentado en TESTING_STRATEGY §2.7) | MENOR |
| Base de desarrollo sin datos de negocio: el conteo del restore va SIN EJERCITAR | MENOR |

## Cómo se decide qué sigue

1. Si hay algo **medido** que está mal, eso primero. La 0086 salió así.
2. Si hay una pieza construida **sin consumidor**, cerrarla vale más que
   empezar otra. La capa de inteligencia salió así.
3. Si algo está bloqueado por un tercero, se documenta y se sigue con otra cosa.
   Nunca se detiene todo por un bloqueo.
4. Si una decisión es contable, fiscal o de producto, **no se inventa**: se
   anota como `REQUIERE_DECISION` y el trabajo independiente continúa.
