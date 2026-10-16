# Política de cobranza propuesta: cuánto margen se le da a un cliente que no pagó

**Estado: PROPUESTA. No está declarada en ninguna base.** Es una decisión comercial del titular (la base y el script la tratan así: sin política declarada, un pago fallido se registra y no pasa nada más). Fecha: 2026-10-16.

## 1 · Qué se decide

Desde el día en que un cobro falla (día 0), el calendario dice cuándo se **reintenta** (re-consulta del cobro), cuándo se **avisa**, cuándo la suscripción pasa a **mora** (el servicio sigue; los módulos que no sostienen una obligación con plazo quedan en pausa, `0125`) y cuándo se **suspende** (se corta el acceso; se conserva todo: datos, contabilidad e historial). Mora y suspensión se levantan pagando. La base no deja declarar un calendario incoherente (suspender antes del último reintento, avisar después de suspender, mora después de suspensión): son `CHECK` de la 0096 y la 0126.

## 2 · Con qué se comparó (y lo poco que se pudo verificar)

| Fuente | Qué dice | Qué tan firme |
|---|---|---|
| **Colppy** (ayuda: «¿Cómo se efectúa el pago?») | El abono vence el día 10; un **débito rechazado tiene 3 días hábiles** para pagarse | Una sola cifra, tomada de un fragmento de resultado de búsqueda; **no pude abrir la página** (404) ni leer qué pasa después del plazo |
| **Xubio, Tango, Contabilium** | **No encontré datos públicos** | Hay que mirar sus términos o preguntarles; no inventé ninguna cifra |
| **Mercado Pago, suscripciones** ([documentación](https://www.mercadopago.com.ar/developers/es/docs/subscriptions/integration-configuration/subscription-no-associated-plan/authorized-payments)) | Reintenta solo, **4 veces dentro de una ventana de 10 días**; tras **3 cuotas con pago rechazado** da de baja la suscripción y avisa por correo | Documentación oficial; no verifiqué si cambió recientemente |
| **Guías de dunning para SaaS** | «Período de gracia corto», reintentos «espaciados en días o semanas», aviso rápido | Opinión de proveedores, **sin cifras comparables** |

Conclusión honesta: la comparación sólida es **una** (Colppy, ≈ 5 días corridos) más el límite técnico de Mercado Pago (10 días). No hay un «estándar del mercado» medible. Lo que sigue es criterio, no estadística.

## 3 · La propuesta

Días desde el fallo del cobro:

| Paso | Días | Por qué |
|---|---|---|
| **Avisos** | 0, 3, 7, 10, 14, 18 | Un aviso inmediato («tu pago no pasó, actualizá el medio de pago») y avisos que escalan; el último, 3 días antes de suspender |
| **Reintentos** | 3, 7, 11 | Mercado Pago ya reintenta solo durante 10 días; el primero nuestro cae a los 3 y el último **después** de que su ventana termina |
| **Mora** | 10 | Coincide con el fin de los reintentos de Mercado Pago: si a esa altura sigue sin cobrarse, deja de ser un rechazo transitorio. En mora **el servicio sigue**; sólo se pausan los módulos que mejoran el negocio, no los que sostienen una obligación (facturar, asentar, cerrar período, presentar) |
| **Suspensión** | 21 | Tres semanas: **unas 4 veces el margen de Colppy**. Es «un tiempito más que los demás» sin llegar a regalar un mes |

Comando (cuando se decida, con el motivo; **no se ejecutó**):

```bash
node scripts/declarar-politica-de-cobranza.mjs 3,7,11 0,3,7,10,14,18 10 21 AAAA-MM-DD "Política inicial: avisos escalonados, mora al agotarse los reintentos de Mercado Pago, suspensión a los 21 días"
```

**Validada contra la base:** se insertó en una transacción con rollback sobre la base de pruebas (la base la **acepta**; un calendario que suspende antes del último reintento, la **rechaza**). No quedó nada guardado.

## 4 · Cuánto cuesta el margen (el cálculo)

Exposición máxima por cliente que no paga y se suspende al día 21 = precio mensual × 21 / 30. Es plata de servicio prestado sin cobrar, **antes** de suspender; no es pérdida segura (se recupera si paga):

| Plan | Precio mensual (vigente) | Exposición a 21 días | Hasta la mora (10 días) |
|---|---:|---:|---:|
| CONTABLE | ARS 59.900 | ARS 41.930 | ARS 19.967 |
| ESTUDIO | ARS 89.900 | ARS 62.930 | ARS 29.967 |
| GESTION | ARS 119.900 | ARS 83.930 | ARS 39.967 |
| EMPRESA_B1 | ARS 249.900 | ARS 174.930 | ARS 83.300 |
| COMPLETO | ARS 449.900 | ARS 314.930 | ARS 149.967 |

(Precios de `plan_prices` en la base de pruebas, que reproduce los declarados. A 14 días de margen —lo que dura la prueba gratuita— la exposición baja a 2⁄3 de esos números.)

**Cómo leerlo:** con pocos clientes, 3 semanas de margen es un costo bajo y un diferencial de trato; el riesgo crece con la **cantidad** de morosos, no con el plazo. Si se prefiere más prudencia, la variante es suspender a los 14 días (misma lógica, avisos 0,3,7,10,12): el costo se reduce a un tercio y sigue siendo ≈ 3 veces el margen de Colppy.

## 5 · Lo que hay que decidir y lo que falta

1. **Aprobar o ajustar los días** (21 vs 14 es la única decisión grande).
2. **Declararla en producción** recién después del segundo lanzamiento (el servidor tiene que tener el cobro). Se corre dentro de la imagen del servidor, como las demás tareas, con tu orden expresa.
3. **Escribirla en los términos y condiciones** (hoy el borrador no fija plazos de mora ni suspensión): «si un cobro no se acredita, avisamos a los 0, 3, 7, 10, 14 y 18 días; a los 10 días pasa a mora con funciones reducidas; a los 21 se suspende el acceso, conservando tus datos». **Texto legal: lo revisa el abogado (B8); no se publica.**
4. **Los avisos dependen del correo** (B6: dominio de envío de Resend sin verificar). Sin correo, el calendario corre pero nadie se entera.
5. Las filas de estado de cuenta (mora/suspensión) **no se ensayaron de punta a punta contra Mercado Pago real**: queda para la prueba de `pagos:ensayo` §5.
