# ADR-013 — El tercero deja de ser un uuid sin dueño

**Estado:** ACEPTADO e implementado (migración `0047_maestro_de_terceros.sql`).

---

## 1. Contexto

`journal_entry_lines.party_id` existe desde la migración 0005. El trigger
`assert_line_account_valid` lo **exige** cuando la cuenta tiene
`requires_third_party`. Y no referenciaba ninguna tabla: era un `uuid` que
`POST /journal-entries` aceptaba del cuerpo del pedido sin comprobar nada.

Es el mismo patrón de defecto que este proyecto viene encontrando desde la
FASE 1: **estructura correcta, regla escrita, y nadie recorriendo el camino
entre las dos.** La estructura pedía un tercero; la regla decía que era
obligatorio; no existía el tercero.

Las consecuencias medibles:

- el Mayor por tercero —que `GET /books/mayor` ya emitía— agrupaba por un
  identificador que podía no significar nada;
- el mismo uuid en dos empresas era el mismo tercero, y dos uuid del mismo
  proveedor eran dos terceros. Ninguna de las dos cosas es cierta;
- no había cuenta corriente posible, y sin ella no hay compras, ventas, CRM
  ni tesorería con cliente.

En paralelo, `tax_transactions` guarda `cuit_contraparte` y `razon_social`
**en cada comprobante**. Mil facturas del mismo proveedor eran mil cadenas
sueltas.

## 2. Problema

¿Dónde vive la identidad de una contraparte, y qué relación tiene con lo que
declara un comprobante?

## 3. Alternativas consideradas

| | Qué era | Por qué no |
|---|---|---|
| **A. Tablas `clientes` y `proveedores`** | Dos maestros, uno por rol | El mismo CUIT compra y vende todo el tiempo. Serían dos verdades sobre la misma persona, y la primera pregunta sin respuesta buena sería cuál manda |
| **B. Derivar el tercero de los comprobantes** | Sin tabla: agrupar por `cuit_contraparte` | No permite dar de alta un proveedor **antes** del primer comprobante, que es exactamente cuando se lo da de alta. Y deja fuera a quien no emite comprobantes |
| **C. Reemplazar `cuit_contraparte` por `party_id`** | Normalizar el comprobante | Un comprobante es **evidencia**: dice lo que dice. Si el tercero cambia de razón social, el comprobante viejo pasaría a decir otra cosa. Destruye la prueba |
| **D. Maestro por empresa + vínculo opcional** | La elegida | — |

## 4. Decisión

> Un maestro de terceros **por empresa**, con roles en tabla hija. El
> comprobante conserva intacto lo que declaró, y el vínculo al maestro es una
> **resolución posterior**, opcional y verificable — no una corrección.

```
COMPROBANTE (lo que dice el papel)      MAESTRO (a quién resolvimos)
cuit_contraparte = '30712345678'  ───►  parties.numero_documento
razon_social     = 'ACME SRL'           parties.razon_social
```

Cuatro consecuencias que son parte de la decisión, no detalles:

1. **La cuenta corriente se deriva, no se guarda.** `party_balances` suma el
   Mayor. No hay columna `saldo`: no puede desincronizarse algo que no existe,
   y no hay que decidir cuál de dos cifras es la verdadera.
2. **Las claves foráneas llevan la empresa adentro.** `(company_id, party_id)`
   contra `parties (company_id, id)`. Una FK simple a `parties (id)` dejaría
   que una empresa impute un movimiento al tercero de otra: el uuid existe y la
   restricción lo aceptaría. **RLS no lo impide** — las restricciones foráneas
   se verifican con privilegios del sistema y ven la fila igual.
3. **Vincular a un tercero con otro CUIT se rechaza** (`tt_party_coherente`).
   Es un error invisible: el subdiario sigue saliendo bien y la cuenta
   corriente del proveedor equivocado empieza a crecer sin motivo.
4. **El documento no se edita.** Cambiarlo convertiría la ficha en otra persona
   conservando sus movimientos. Si el número está mal, se archiva y se da de
   alta la correcta.

## 5. Trade-offs

- **Se aceptó** que el mismo CUIT tenga una ficha por empresa. Unificarlo entre
  empresas de un mismo estudio sería la fuga que toda la arquitectura existe
  para impedir.
- **Se aceptó** que `tax_transactions.party_id` sea NULL en la mayoría de los
  comprobantes hasta que alguien los resuelva. Un NULL visible es mejor que una
  resolución automática por coincidencia de CUIT que nadie firmó.
- **Se pagó** una consulta agregada en cada lectura de cuenta corriente en vez
  de un saldo materializado. Si algún día mide mal, la respuesta es un índice o
  una vista materializada con refresco explícito — no una columna que la
  aplicación mantenga a mano.

## 6. Consecuencias

Queda habilitado el trabajo que dependía de esto: ventas, compras, cuenta
corriente por antigüedad de saldos, CRM y los conectores de e-commerce, que
necesitan resolver un cliente externo contra un tercero de NEXO.

Queda **sin resolver a propósito**: la conciliación masiva de comprobantes
históricos contra el maestro. Es una operación que asigna miles de filas por
coincidencia de CUIT, y ninguna persona la firmaría fila por fila. Requiere una
decisión de producto sobre qué grado de automatismo se admite ahí.
