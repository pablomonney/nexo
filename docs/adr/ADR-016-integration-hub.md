# ADR-016 — Un conector no escribe en el motor contable

**Estado:** ACEPTADO e implementado (migración `0056_integration_hub.sql`).

---

## 1. Contexto

La visión de NEXO incluye conectar Tiendanube, Mercado Pago, Mercado Libre,
Meta Ads, Google Ads y bancos. La condición para hacerlo bien ya estaba
cumplida: las entidades que un conector necesita escribir —venta, cliente,
producto, cobro— **existen** (ADR-013 a ADR-015). Si no existieran, cada
conector inventaría las suyas y esas serían las que después habría que migrar.

## 2. El problema

¿Qué pasa cuando la API de una tienda informa un pedido? ¿Se convierte en una
venta de NEXO?

## 3. Decisión

> **Un conector nunca escribe en el motor contable.** Deposita en una zona de
> aterrizaje, y convertir eso en una entidad de NEXO es un acto explícito, con
> permiso y con firma.

```
TIENDA / BANCO / PLATAFORMA
         ↓  (el conector solo deposita)
   external_records          ← evidencia de lo que dijo el proveedor
         ↓  (una persona resuelve)
parties · products · tax_transactions · commercial_documents
         ↓
   el circuito de siempre
```

Es **la misma forma que ADR-001 le impuso a la IA**, y por el mismo motivo: un
sistema externo que escribe directo en el Diario es un sistema externo
decidiendo la contabilidad de la empresa. Que el que escribe sea un modelo de
lenguaje o la API de una tienda no cambia el problema.

La consecuencia se ve en un test: se depositan dos registros y se comprueba que
la cantidad de `parties` y de `tax_transactions` **no cambió**.

## 4. Cuatro consecuencias que son parte de la decisión

**El payload es evidencia.** Lo que mandó el proveedor se guarda tal cual y es
inmutable, igual que un comprobante. Si vino mal se descarta con motivo y se
pide de nuevo — corregirlo por debajo lo dejaría de ser prueba de lo que la
plataforma efectivamente informó.

**La resolución usa columnas tipadas, no una referencia polimórfica.** Una
columna `entidad_id` suelta no la puede validar ninguna clave foránea, y sería
otro uuid apuntando a nada: exactamente el defecto que la auditoría encontró en
`journal_entry_lines.party_id` (ADR-013). Hay cuatro columnas, cada una con su
FK compuesta con la empresa, y un CHECK que exige **exactamente una** cuando el
registro está RESUELTO.

**Idempotencia por `(empresa, integración, tipo, external_id)`.** El mismo
pedido llega por la sincronización inicial, por un webhook y por un reintento.
Las tres veces es una fila, y la respuesta dice cuántos eran repetidos. Sin
esto, una venta entraría triplicada y el error aparecería en el balance.

**Los secretos usan el sobre que ya existe.** Los tokens van con el mismo
esquema que las credenciales de ARCA —DEK envuelta con la KEK,
`key_encryption_ref` diciendo quién la envolvió— que además **se niega a
desenvolver en producción lo que se envolvió con una llave de entorno**. No se
inventó un segundo esquema de cifrado (§70). Y nunca se guarda la contraseña de
un servicio externo: o hay token, o no hay nada.

## 5. Disponible ≠ planificado, y es un candado

El catálogo distingue `DISPONIBLE` de `PLANIFICADO`, y **la base rechaza
conectar lo segundo**. No es un cartel en una pantalla: es un trigger.

Listar Tiendanube como si funcionara sería exactamente la clase de promesa que
este sistema no hace. Hoy hay un proveedor disponible, `IMPORTACION_MANUAL`, y
no es un placeholder: es el camino real por el que una empresa sube hoy la
exportación de su tienda o el resumen de su banco.

Esa decisión resuelve el problema que este proyecto encuentra una y otra vez —
**estructura correcta que nadie recorre**. El hub no queda esperando a que
alguien consiga credenciales de OAuth: funciona hoy, está probado de punta a
punta, y cada conector por API que venga aterriza en vías ya recorridas.

## 6. Trade-offs

- **Se aceptó** que resolver sea manual. Un emparejamiento automático por
  nombre o por CUIT sería cómodo y sería el sistema afirmando una identidad que
  nadie verificó. Se puede *proponer* más adelante —la forma que ADR-001
  admite— pero no aplicar.
- **Se aceptó** guardar el payload completo de cada registro. Ocupa espacio y
  es lo que permite explicar de dónde salió cada cosa tres años después.
- **Se pagó** que el hub genere trabajo visible: cada registro sin resolver
  aparece en la bandeja. Es deliberado — el trabajo existía igual, y antes
  estaba escondido.

## 7. Qué queda abierto

- **Los conectores por API.** La arquitectura está y probada; falta el adaptador
  de cada plataforma y sus credenciales. Cada uno es un módulo que llama a
  `POST /integrations/:id/records` y nada más.
- **Webhooks entrantes.** Hoy la ingesta es autenticada como un usuario. Un
  webhook necesita autenticación por firma del proveedor, que es otro diseño.
- **Emparejamiento sugerido.** Proponer contra qué entidad resolver, sin
  aplicarlo.
- **Conversiones offline hacia las plataformas** (§51). Es el camino inverso y
  todavía no existe.
