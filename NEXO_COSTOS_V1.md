# NEXO — COSTOS PARA TERMINAR V1

**Regla de este archivo:** no hay un solo precio inventado. Donde no tengo un
número confirmado dice **PRECIO A CONFIRMAR**, y el orden de magnitud —cuando lo
doy— está marcado como tal.

**Ningún costo de acá está medido.** NEXO no lleva su propia contabilidad
todavía, así que esto es una lista de lo que hay que contratar, no un
presupuesto ejecutado. Ver `NEXO_CORPORATE.md` §6.

---

## 1. Pago único

| | Costo | Nota |
|---|---|---|
| Dominio (.com o .com.ar) | **PRECIO A CONFIRMAR** — orden de USD 10–40/año | .com.ar se tramita en NIC Argentina |
| Identidad visual, si la hace un diseñador | **PRECIO A CONFIRMAR** | $0 si la propongo yo |
| Redacción legal (términos, privacidad, tratamiento de datos) | **PRECIO A CONFIRMAR** | Un estudio de tecnología cobra distinto que uno generalista |
| Certificado de ARCA de producción | **PRECIO A CONFIRMAR** | Trámite del contribuyente, no de NEXO |

## 2. Mensual fijo

| | Costo | Bloquea V1 |
|---|---|---|
| Hosting de la aplicación | **PRECIO A CONFIRMAR** — orden de USD 10–50 | Sí |
| PostgreSQL administrado, con backups | **PRECIO A CONFIRMAR** — orden de USD 15–60 | Sí |
| Almacenamiento de documentos | **PRECIO A CONFIRMAR** — orden de USD 5–25 | Sí |
| Gestor de secretos | **PRECIO A CONFIRMAR** — orden de USD 0–40 | Sí |
| Correo transaccional | **PRECIO A CONFIRMAR** — orden de USD 0–20 en volumen bajo | Sí |
| Monitoreo y seguimiento de errores | **PRECIO A CONFIRMAR** — hay capas gratuitas | No |
| SSL | Suele venir con el hosting | Sí |

**Total fijo mensual: PRECIO A CONFIRMAR.** Con los órdenes de magnitud de
arriba caería entre USD 30 y 200, y la diferencia la decide qué proveedor
elegís, no qué necesita NEXO.

## 3. Variable por uso

| | Costo | Cuándo aparece |
|---|---|---|
| Comisión de la pasarela | **PRECIO A CONFIRMAR** — orden de 3–6 % del cobro | Con el primer cobro |
| Correo por encima del plan | **PRECIO A CONFIRMAR** | Con volumen |
| Ancho de banda y almacenamiento | **PRECIO A CONFIRMAR** | Con volumen |

**La comisión de la pasarela es el costo variable más grande del modelo**, y es
la razón por la que la elección de proveedor no es solo técnica: sobre un ARPU
de $ 62.400, cada punto de comisión son $ 624 por cliente y mes.

## 4. Variable por cliente

| | Costo |
|---|---|
| Infraestructura atribuible | **PRECIO A CONFIRMAR** — no se puede medir sin producción |
| Almacenamiento de sus documentos | **PRECIO A CONFIRMAR** — depende de cuánto suba |
| Correo | **PRECIO A CONFIRMAR** |
| Soporte | **No cuantificable todavía** — no hay estructura |

Los supuestos que usé en `NEXO_COMERCIAL.md` §5 son eso: supuestos. Se
reemplazan con datos reales cuando NEXO lleve su contabilidad.

---

## 5. IA — cuantificado aparte, porque la respuesta es cero

Ésta es la sección que te importa cuantificar, y la respuesta es corta:

> **NEXO V1 no necesita pagar IA.**

### Qué funciona hoy sin ningún proveedor de modelo

Todo lo que NEXO promete. Las veinte preguntas del catálogo de inteligencia, el
panorama, las señales, los umbrales, la variación del margen abierta en precio,
costo y volumen, la proyección de cobranzas, el radar de riesgos, los escenarios,
el registro de decisiones y su calibración: **todo es aritmética sobre hechos
registrados**, y sale del mismo motor que cada pantalla de módulo.

No es una limitación disfrazada de virtud. Es el ADR-017: la aritmética va
**afuera** del modelo, porque un LLM que calcula un saldo es un saldo que no se
puede auditar.

### Qué queda bloqueado sin proveedor

| | |
|---|---|
| Clasificación automática de documentos con propuesta y confianza | El único agente que corre lo hace hoy sin modelo externo |
| Narración de un análisis en lenguaje natural | Los números están; falta quien los redacte |
| Copiloto conversacional | Es de la visión, no de V1 |
| Seis de los ocho agentes declarados | Ninguno se anuncia al cliente |

### Qué costaría cuando lo quieras

| | |
|---|---|
| Proveedor | **DECISIÓN** — no está tomada |
| Costo por mil tokens | **PRECIO A CONFIRMAR** |
| Costo por cliente y mes | **No estimable** sin saber el volumen de documentos |

La estructura ya está lista: `ai_pricing` guarda el precio por proveedor y
modelo, `ai_predictions.cost_micros` se calcula con él, y **sin precio declarado
queda en `NULL`** — no en cero. `ai_quotas` pone un tope diario por empresa, y
sin fila declarada no hay tope, lo que se informa con esas palabras.

Así que el día que contrates un modelo, el costo se mide desde el primer día en
vez de aparecer en la tarjeta a fin de mes.

### OCR

Corre **local**, con Tesseract, en el propio host. No hay costo por página y los
documentos contables **no salen a ningún tercero**. Está así a propósito: son
secreto profesional.

---

## 6. Lo que cuesta cero y hay que hacer igual

| | |
|---|---|
| Decidir el alcance de V1 | El más importante de la lista |
| Aprobar la identidad visual | |
| Confirmar la matriz de planes y los topes | Hoy son hipótesis |
| Crear la casilla de contacto | |
| Dar de alta NEXO como empresa dentro de NEXO | Desbloquea todas las métricas propias |
| Decidir la jurisdicción del hosting | Condiciona el documento de privacidad |

---

## 7. El número que no te puedo dar

**Cuánto sale terminar V1 en total.** Porque:

- ninguno de los proveedores está elegido, y el rango entre el más barato y el
  más caro de cada categoría es de varias veces;
- el costo legal depende del estudio;
- el costo de diseño depende de si lo hago yo o contratás a alguien.

Lo que sí puedo decir con confianza: **ninguno de los bloqueos de V1 es caro.**
Lo caro de este proyecto ya está construido y pagado en tiempo. Lo que falta son
cuentas de servicio con capa gratuita o de decenas de dólares por mes, un
abogado, y trabajo mío.
