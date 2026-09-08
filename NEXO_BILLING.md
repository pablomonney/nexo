# NEXO_BILLING — cómo cobra NEXO

Estado: **🟡 PREPARADO.** El ciclo emite, prorratea, registra cobros, gestiona
la cobranza y suspende. Lo que **no** puede hacer es cobrarle a una tarjeta: no
hay pasarela contratada. Un cobro por transferencia entra igual, a mano.

---

## 1. La decisión que ordena todo lo demás

**Acá no hay ni un precio, y no es un olvido.**

`plan_prices` y `collection_policies` nacen vacías. Cuánto sale cada plan y qué
pasa cuando un pago falla son decisiones comerciales que no están tomadas, y un
número de ejemplo en una migración se ve exactamente igual que uno decidido:
aparecería en el catálogo, en un documento de cobro y en un tablero de
facturación, y nadie sabría de dónde salió.

De ahí salen las tres negativas del sistema:

| Falta | Qué hace NEXO | Qué **no** hace |
|---|---|---|
| Precio del plan | Informa el plan sin precio | Cobrar cero |
| Tope del plan | Informa `SIN_TOPE_DECLARADO` | Tratarlo como ilimitado |
| Política de cobranza | Registra el pago fallido | Reintentar ni suspender |

Un arreglo vacío es «nadie lo declaró». Cero es un número. La diferencia es la
misma que entre `null` y `0` en el resto del sistema, y por el mismo motivo.

## 2. La cadena

```
PLAN → PRECIO DECLARADO → SUSCRIPCIÓN con importe acordado
     → PERÍODO → DOCUMENTO DE COBRO → INTENTO DE PAGO
     → (falla) → COBRANZA → SUSPENSIÓN
     → (paga)  → REACTIVACIÓN
```

Cada flecha es una fila, y ninguna se deduce: el período existe porque el ciclo
lo abrió, el documento porque lo emitió, el intento porque alguien lo hizo.

**El importe acordado se congela al alta.** Puede diferir del precio de lista —un
contrato enterprise es exactamente eso—, y por eso declarar una lista nueva no
altera lo pactado con quien ya está suscripto.

## 3. Un documento de cobro no es una factura

Se llama `billing_documents` y no `invoices` a propósito.

Emitir factura electrónica exige CAE, y la emisión está fuera del MVP y aislada
por el lint de arquitectura. Mientras `es_comprobante_fiscal` sea falso, este
documento **no entra en ningún Libro IVA** y no lo suma ninguna declaración.

Dos señales lo dicen sin leer documentación:

- un `CHECK` impide poner `es_comprobante_fiscal = true` sin CAE y sin
  vencimiento de CAE — no es una regla que alguien pueda olvidarse de aplicar;
- **la numeración admite huecos.** Un comprobante fiscal no puede tenerlos. Que
  esta pueda es la prueba de que todavía no lo es.

Los impuestos van en una columna aparte y **anulable**. `NULL` no es cero: es que
no se discriminaron. Discriminarlos exige decidir la condición de IVA de NEXO,
que es un dato de la empresa NEXO y no está cargado.

## 4. Quién escribe y quién lee

| | Emite | Cobra | Lee |
|---|---|---|---|
| Empresa cliente | no | no | lo suyo |
| Ciclo del operador | sí | sí | todo |

**No hay endpoint que escriba en facturación**, y no es que falte: el
administrador de una empresa cliente no tiene por qué poder emitirse un cargo,
marcarlo pagado ni levantarse una suspensión.

Tres cosas lo sostienen, y ninguna es un comentario:

1. `aai_app` tiene **solo `SELECT`** sobre las siete tablas. Revocado, no
   simplemente no concedido — ver §7.
2. RLS `FORCE` con política solo de lectura: una empresa ve lo suyo y nada más.
3. `tests/integration/facturacion.test.ts` intenta el `INSERT` y el `UPDATE`
   prohibidos y exige `42501`. Escribir la defensa sin intentar romperla es
   cómo se llega a tres comentarios que niegan un agujero abierto.

## 5. El ciclo

```bash
npm run facturacion:ciclo -- --ensayo    # sin escribir nada
npm run facturacion:ciclo                # de verdad
npm run facturacion:ciclo 2026-11-01     # con una fecha dada
```

**Correrlo dos veces el mismo día es inocuo.** Un período ya facturado se informa
como omitido en vez de duplicarse, y el `UNIQUE (subscription_id, desde)` lo
impediría igual. Es la condición para poder agendarlo sin miedo y para poder
reintentarlo cuando la corrida anterior murió a la mitad.

**El ciclo atrasado no saltea.** Si no corrió el lunes, el martes emite el del
lunes y el del martes. Emitir solo el de hoy dejaría un mes de servicio sin
cobrar y nadie lo notaría hasta la conciliación.

**Una suscripción suspendida se sigue facturando.** La deuda corre; lo que se
corta es el acceso. Si se dejara de facturar, levantar la suspensión dejaría un
hueco de servicio que ningún documento explica.

Lo que el ciclo no puede hacer lo informa en vez de callarlo:

```
REINTENTO  OMITIDO  No hay pasarela de pago conectada.
AVISO      OMITIDO  No hay proveedor de correo configurado.
```

## 6. Fechas y centavos

**El 31 de enero más un mes es el 28 de febrero**, no el 3 de marzo. La
aritmética nativa de fechas hace lo segundo, y en una suscripción mensual eso
significa que quien contrata un 31 se saltea febrero y aparece facturado dos
veces en marzo. El recorte es asimétrico y no se recupera: de ahí en adelante se
cobra los 28.

**El prorrateo no crea ni pierde centavos.** Se reparte el importe del período
completo por días con el método del mayor residuo, y no se calcula cada parte por
separado: en un mes de 31 días partido al medio, dos cuentas redondeadas
independientemente dan un centavo de más o de menos que después nadie encuentra.

Consecuencia comprobada: el alta a mitad de mes y el cambio de plan a mitad de
mes dan **exactamente** la misma cifra. Si difirieran, dos clientes pagarían
distinto por el mismo servicio.

## 7. Un GRANT no quita nada

La 0009 hace `ALTER DEFAULT PRIVILEGES … GRANT SELECT, INSERT, UPDATE`, así que
**toda tabla nueva nace escribible por la aplicación**. Escribir `GRANT SELECT`
sobre una tabla que no debe escribirse no quita nada: agrega lo que ya estaba.

Pasó tres veces —0086, 0096 y la propia corrección 0097, que se olvidó de dos
objetos—, y por eso la defensa ya no es una lista de `REVOKE` sino un barrido:
`tests/security/solo-lectura-de-verdad.test.ts` compara lo declarado contra
`information_schema` y falla si difieren, en los dos sentidos. También afirma
que sí se pueden **leer**: un `REVOKE` de más deja la consola mostrando
pantallas en blanco sin un solo error en el log.

## 8. Pagos

**Ninguna columna guarda datos de tarjeta**, y no hay dónde ponerlos. Se guarda
el identificador opaco que devuelve el proveedor y los cuatro dígitos que ese
mismo proveedor informa, para que el cliente reconozca con qué pagó. Un test lo
comprueba contra el esquema, no contra una lista escrita a mano.

`idempotency_key` es `NOT NULL UNIQUE`: no hay forma de crear un intento sin
declararla, y dos veces la misma clave son el mismo cobro. La consulta de
idempotencia va **antes** que la del estado del documento, y el orden importa:
registrar un cobro lo deja pagado, así que preguntar primero por el estado hacía
que el reintento contestara «documento no cobrable» — y quien reintenta lee eso
como «algo salió mal» y lo intenta de otra forma, que es exactamente cómo se
cobra dos veces.

Los eventos de la pasarela tienen cuatro finales y **los cuatro se guardan**:

| | |
|---|---|
| `APLICADO` | la transición era válida |
| `REPETIDO` | el mismo evento otra vez; las pasarelas reenvían |
| `ATRASADO` | describe un estado ya superado — el `AUTORIZADO` que llega después del `PAGADO` |
| `CONFLICTO` | ni repetido ni atrasado ni válido |
| `DESCONOCIDO` | sobre un cobro que este sistema no inició |

Descartar un evento sin dejar rastro borra la explicación de por qué el cobro
quedó como quedó, y esa explicación es lo único que hay el día que un cliente
diga que pagó.

## 9. Suspender no es cancelar

Suspender corta el acceso y **conserva todo**: los datos, la contabilidad, el
historial y la suscripción. Se levanta pagando, y solo si no queda otra deuda
emitida — levantar con deuda abierta dejaría entrar a quien pagó una de tres
facturas.

Cancelar es la baja, y es una decisión de la empresa cliente, no una consecuencia
automática de no haber pagado. **Ninguna función del ciclo produce una
cancelación.** De `CANCELADA` no se vuelve: reactivar dejaría un período sin
cobertura que ningún documento explica, y la forma de volver es una suscripción
nueva.

Anular tampoco es declarar incobrable. Anular dice «esto no debió emitirse»;
incobrable dice «se emitió bien y no se va a cobrar», que es un hecho económico
distinto. Confundirlos borra la deuda en vez de reconocer la pérdida.

## 10. Lo que falta para cobrar de verdad

| | Qué destraba | Sin eso |
|---|---|---|
| **Precios** | Una decisión comercial | No se emite nada |
| **Política de cobranza** | Una decisión comercial | Un pago fallido no dispara nada |
| **Pasarela de pago** | Contratar una | Solo entra lo que se registra a mano |
| **Proveedor de correo** | Contratar uno | El aviso previo a la suspensión no sale |
| **Condición de IVA de NEXO** | Un dato de la empresa | Los impuestos no se discriminan |
| **Emisión fiscal** | Certificado de producción | El documento no es comprobante |

Los dos primeros no cuestan dinero: cuestan decidir, y son los que más traban.
Sin precio no hay documento, sin documento no hay cobranza, y sin cobranza la
cadena comercial no se puede probar de punta a punta.

### Conectar una pasarela

No toca el dominio. `procesarEventoDePago` ya es el punto por donde va a entrar
el webhook —hoy lo usa el registro manual, que es el mismo acto con otro
origen—, así que conectar una pasarela es:

1. escribir el adaptador que traduzca sus eventos a `estadoInformado`;
2. exponer el webhook, verificando su firma;
3. reemplazar `intentarCobro`, que hoy devuelve `SIN_PASARELA`.

Ninguna fila se migra. Que el registro manual y el webhook pasen por la misma
función es lo que hace que un cobro por transferencia y uno por tarjeta dejen el
mismo rastro — y lo que evita dos caminos hacia el mismo estado que algún día
difieran.
