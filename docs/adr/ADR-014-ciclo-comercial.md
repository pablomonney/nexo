# ADR-014 — La factura no se guarda dos veces

**Estado:** ACEPTADO e implementado (migraciones `0050_ciclo_comercial.sql` y
`0051_bandeja_extensible_y_comercial.sql`).

---

## 1. Contexto

NEXO registra comprobantes: `tax_transactions` es la factura, con sus renglones
desde la 0049. Lo que no existía es lo que pasa **antes** de que haya factura —
el presupuesto que se le manda al cliente y el pedido que confirma— y sin eso
no hay módulo de ventas ni de compras.

## 2. Problema

¿Dónde vive una factura que emite la propia empresa, y qué relación tiene con
el documento comercial que la originó?

## 3. Alternativas consideradas

| | Qué era | Por qué no |
|---|---|---|
| **A. Tabla `facturas` con sus renglones** | El módulo de ventas completo, paralelo al fiscal | Dos filas describiendo la misma factura. Algún día no coinciden y hay que decidir cuál manda — la pregunta sin respuesta buena |
| **B. Presupuestos dentro de `tax_transactions`** | Un `status` más | Un presupuesto no es una operación fiscal. Entraría al subdiario de IVA, al Mayor por tercero y a los invariantes del Diario. Un presupuesto rechazado ensuciaría la contabilidad |
| **C. Documentos comerciales que se convierten** | La elegida | — |

## 4. Decisión

> Presupuestos y pedidos viven en `commercial_documents`, **sin efecto fiscal**.
> Al facturarse, el documento **se convierte** en una `tax_transaction` con sus
> renglones, y guarda a cuál dio lugar. Un vínculo, una dirección, una sola
> fila por factura.

```
PRESUPUESTO ──► PEDIDO ──► tax_transaction ──► decisión ──► asiento
   (comercial, sin efecto)      (fiscal, ya existía)
```

Cuatro consecuencias que son parte de la decisión:

1. **Los importes de la factura no se reciben del cliente.** Salen de los
   renglones que el cliente aceptó, que son inmutables desde la emisión.
   Aceptarlos del cuerpo del pedido permitiría facturar por un importe distinto
   del acordado y nadie lo notaría.
2. **VENCIDO no es un estado.** Se deriva de `valid_until`. Un estado
   almacenado sería uno que alguien tiene que acordarse de escribir, y que
   estaría mal siempre: un presupuesto no vence porque se abra una pantalla.
3. **Presupuestar y facturar son permisos distintos.** `commercial:write`
   alcanza para ofertar, emitir y aceptar; facturar exige `journal_entry:create`.
   Es el corte entre cerrar una venta y registrarla.
4. **Facturar no pide CAE.** Registrar la operación fiscal y emitirla ante ARCA
   son dos pasos. Unirlos haría que un problema de conectividad bloqueara el
   registro de una venta que ya ocurrió. La respuesta de la API lo dice.

## 5. La bandeja pasa a ser extensible (0051)

`work_queue` tenía veintiún ramas y quinientas líneas en una sola vista.
Agregarle una exigía `DROP VIEW` y reescribirla entera: quinientas líneas
copiadas por migración, y basta que una copia salga distinta para que la
bandeja muestre algo que nadie escribió.

No era un problema con un solo dominio. Lo es cuando cada módulo trae las
suyas. Ahora:

```
work_queue = work_queue_nucleo ∪ work_queue_comercial ∪ …
```

`work_queue_nucleo` **es** la vista de la 0046, renombrada con
`ALTER VIEW … RENAME`: no se copió una línea de su cuerpo. Las tres vistas
llevan `security_invoker` — una sola sin él en cualquier eslabón saltearía el
RLS y repartiría el trabajo pendiente de todas las empresas.

## 6. Trade-offs

- **Se aceptó** que un documento comercial no se edite después de emitido. Es
  más rígido que lo que hacen otros ERP, y es deliberado: lo que se le mandó al
  cliente se mandó. Para corregir se emite una revisión (`supersedes_id`).
- **Se aceptó** no guardar totales. Se recalculan en cada lectura. Si algún día
  mide mal, la respuesta es un índice o una vista materializada con refresco
  explícito, no una columna que la aplicación mantenga a mano.
- **Se pagó** una tabla de renglones con la misma forma que
  `tax_transaction_lines`. Comparten la forma porque describen lo mismo; no
  comparten la fila porque tienen ciclos de vida distintos — uno se edita
  mientras el documento está en borrador, el otro es evidencia de algo que ya
  pasó.

## 7. Qué queda abierto

- **Remitos y entregas parciales.** Un pedido que se factura en dos veces no
  está modelado: hoy un documento produce una operación fiscal o ninguna. Es
  una decisión de producto, no una limitación técnica.
- **Listas de precios.** `products.list_price` es un precio único. Precios por
  cliente, por cantidad o por lista son trabajo del módulo comercial y todavía
  no se hicieron.
