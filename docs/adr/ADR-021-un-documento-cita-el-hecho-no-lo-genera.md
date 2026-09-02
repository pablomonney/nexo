# ADR-021 — Un documento cita el hecho; no lo genera

**Fecha:** 2026-09-02
**Estado:** aceptada
**Migraciones:** 0064, 0082, 0083, 0085 (el patrón ya estaba; acá se nombra)

## El problema

Un ERP tiene dos clases de cosas adentro y es fácil confundirlas.

Están los **hechos**: un asiento en el Mayor, un movimiento de stock, una
imputación que baja el saldo de un tercero. Tienen consecuencias contables,
cuadran contra algo, y alguien se hace cargo de ellos.

Y están los **documentos de trabajo**: una orden de pago, una solicitud de
compra, un cheque en cartera, una nota de crédito aplicada. Organizan el
trabajo, se aprueban, se anulan — y por sí solos no mueven un peso.

La tentación, cada vez que se agrega un documento, es que además haga el hecho:
que aprobar la orden de pago escriba el asiento, que convertir la solicitud
genere la orden de compra, que recibir un cheque asiente en «Valores a
depositar». Es más cómodo y es un error, por dos motivos distintos:

1. **Habría dos orígenes para el mismo saldo.** El día que alguien asiente el
   pago por el camino normal y además exista el asiento automático de la orden,
   el proveedor aparece pagado dos veces. No hay forma de que el sistema sepa
   cuál sobra.

2. **El documento tendría que inventar lo que no sabe.** Convertir una
   solicitud en orden de compra exige un proveedor y unos precios que la
   solicitud no tiene. Escribir el asiento del pago exige decidir de qué cuenta
   sale la plata. Ninguna de las dos cosas está declarada, y ponerlas por
   defecto es inventarlas (§30).

## La decisión

**Un documento cita el hecho, y la base verifica la cita.**

Las dos mitades importan.

**Citar** significa que el documento guarda la referencia al hecho —el asiento,
la orden, la factura— y no lo produce. El hecho se registra por el camino de
siempre, con su firma y su justificación.

**Verificar** significa que la referencia no alcanza con existir: la base
comprueba que lo citado sea lo que el documento dice que es. Sin eso, el estado
del documento sería una palabra escrita al lado de algo que puede no haber
ocurrido — que es exactamente el defecto que este repositorio encontró cuatro
veces por otros caminos.

## Cómo se ve en cada caso

| Documento | Qué cita | Qué verifica la base |
|---|---|---|
| Cheque (0064) | El asiento que lo registró | Que sea de la misma empresa; la bandeja avisa mientras no cite ninguno |
| Orden de pago (0082) | El asiento del pago | Que ese asiento tenga **imputación activa sobre cada comprobante** de la orden (`E_OP_PAGO_NO_IMPUTADO`) |
| Nota de crédito (0083) | La factura que corrige | Que sea una factura, del mismo tercero, la misma punta, y por lo que a la nota le queda |
| Solicitud de compra (0085) | La orden de compra que salió de ella | Que el documento citado sea de **compras** y sea un **pedido** (`E_SOL_ORDEN_INVALIDA`) |

En los cuatro, el estado final del documento —«pagada», «convertida»— es
inalcanzable sin la cita verificada.

## Consecuencias

**Se puede trabajar sin el documento.** Quien pague sin armar la orden de pago
paga igual; quien compre sin solicitud compra igual. El documento no es un peaje
sobre el hecho contable. Esto sale del mismo principio que la 0073 dejó escrito
para las suscripciones: *nunca bloquear un hecho contable por una cuestión que
no lo es*.

**La bandeja carga con lo que falta.** Como ningún documento bloquea, lo que
queda sin cerrar tiene que verse en algún lado: cada uno aporta su rama, y
ninguna es bloqueante. Un aviso que no impide nada solo sirve si aparece.

**El doble conteo se evita por construcción, no por regla de dedo.** Una orden
de pago aprobada no entra en la proyección de fondos porque los comprobantes que
nombra ya están ahí por su pendiente. Un cheque sin asiento no suma al
disponible porque el crédito que lo originó sigue pendiente. En los dos casos la
razón es derivable, no una excepción escrita a mano.

**Cuesta un paso más.** Aprobar la orden y después registrar el pago son dos
actos, no uno. Es el precio de que «pagada» signifique algo, y es el mismo
precio que ADR-015 §7 aceptó para la imputación: el sistema no adivina qué
cancela qué.

## Lo que este ADR no dice

No dice que ningún documento pueda proyectar hechos. La recepción de mercadería
**sí** escribe el movimiento de stock (0052), y está bien: la recepción *es* el
hecho de que la mercadería entró, no un papel que lo anticipa. La distinción no
es «documento contra tabla», es **si el documento constituye el hecho o lo
organiza**.
