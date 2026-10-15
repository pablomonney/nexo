# Cobro manual por transferencia bancaria — el flujo inicial

**Estado: PREPARADO Y PROBADO LOCALMENTE. No está en producción** (el script entra con el próximo despliegue de la imagen) **y no se habilitó Mercado Pago ni ningún cobro automático.** Fecha: 2026-10-15.

Es el camino que el propio sistema ya declara para arrancar: con `PAYMENTS_PROVIDER=none` el ciclo emite el cargo y lleva la cobranza igual, y «los cobros por transferencia se registran a mano».
Lo que faltaba era **cómo**: `registrarCobro` existía en el motor de facturación pero sólo lo llamaban las pruebas; no había ninguna forma de que una persona lo hiciera.

## 1 · El flujo, de punta a punta

```text
 ciclo diario ──▶ emite el CARGO (documento N.°) ──▶ aviso de cobranza al cliente
                                                           │
 el cliente transfiere ◀── necesita saber A DÓNDE (§5, decisión pendiente)
        │
        ▼
 entra al banco de NEXO ──▶ 1. pendientes  ─ qué se debe y a quién
                           2. conciliar    ─ qué movimiento del extracto corresponde a qué cargo   (sólo PROPONE)
                           3. registrar    ─ confirma importe, fecha y n.° de operación            (escribe sólo con --confirmar)
                           4. comprobante  ─ constancia del pago recibido                          (NO fiscal)
```

Todo está en `scripts/cobro-manual.mjs` (y `scripts/cobro-manual.sh` para correrlo en el servidor). **Es un script del operador y no una pantalla, a propósito**, igual que `facturacion-ciclo.mjs`:
marcar un cargo como pagado levanta una suspensión y una mora, y el administrador de una empresa cliente no puede poder hacerlo sobre su propio cargo (`aai_app` tiene sólo `SELECT` sobre las tablas de facturación).

### Los cuatro pasos

```bash
# 1 · qué se debe
bash scripts/cobro-manual.sh pendientes

# 2 · qué movimiento del banco es de quién (CSV: fecha;descripcion;importe;referencia)
bash scripts/cobro-manual.sh conciliar --extracto /ruta/movimientos.csv

# 3 · registrar (primero el simulacro; el mismo comando con --confirmar escribe)
bash scripts/cobro-manual.sh registrar --documento 12 --importe 3000.00 --fecha 2026-11-03 --referencia 0123456789
bash scripts/cobro-manual.sh registrar --documento 12 --importe 3000.00 --fecha 2026-11-03 --referencia 0123456789 --confirmar

# 4 · constancia para el cliente
bash scripts/cobro-manual.sh comprobante --documento 12 > comprobante-12.txt
```

En una máquina de desarrollo se usa `node scripts/cobro-manual.mjs …` con `DATABASE_URL` (y `--salida archivo` en `comprobante`).

## 2 · Registro: qué se controla

| Control | Por qué |
|---|---|
| **Simulacro por defecto**: sin `--confirmar` no se escribe | Marcar pagado es de efecto fuerte (levanta suspensión y mora) |
| **El importe lo confirma quien registra y tiene que ser exactamente el del documento** | No existe en el sistema un estado «cobrado en parte»; un pago parcial o de más requiere una decisión de producto, no un parche. Se rechaza con el motivo |
| **La referencia bancaria es obligatoria** (n.° de operación, ≥ 6 caracteres) | Es lo que permite conciliar, y la base la hace **única por proveedor** (`payment_intents_referencia_por_proveedor`): una transferencia paga un solo documento |
| Misma referencia + mismo documento = **el mismo cobro** | Reintentar por un corte o un error de tipeo no cobra dos veces (la clave de idempotencia es `transferencia:<documento>:<referencia>`) |
| Misma referencia en **otro** documento, u otra referencia sobre un documento ya pagado | Se rechaza con un mensaje que dice qué pasó |
| Fecha: no futura (la «hoy» la da la base, no UTC) ni anterior a la emisión | Evita cobros con fecha imposible |
| El cobro pasa por `registrarCobro` → `procesarEventoDePago` | **Un solo camino hacia PAGADO**: el mismo que va a usar el webhook de una pasarela. Deja bitácora (`REGISTRAR_COBRO`) y levanta la suspensión o mora si no queda otra deuda |

## 3 · Conciliación: qué hace y qué no

`conciliar` lee un extracto en CSV (acepta `;` o `,`, fechas `AAAA-MM-DD` o `DD/MM/AAAA`, importes `3.000,50` o `3000.50`) y, para cada **crédito**, informa:

| Resultado | Significa |
|---|---|
| **UNICA** | Un solo cargo abierto por ese importe (o, entre varios iguales, uno cuyo CUIT o nombre aparece en el texto del movimiento). Imprime el comando `registrar` listo |
| **AMBIGUA** | Varios cargos por el mismo importe y nada que los distinga. **No elige**: hay que preguntarle al cliente |
| **SIN DOCUMENTO** | Ningún cargo abierto por ese importe: pago parcial, de más, o de un cliente sin cargo. No se registra nada |
| **YA REGISTRADO** | Esa referencia ya tiene su cobro (procesar dos veces el mismo extracto es inocuo) |

**Sólo propone y nunca escribe.** Los importes se manejan en **centavos enteros**, nunca en `number`: un redondeo no puede asignar el pago al documento de otro cliente.

## 4 · El comprobante

Texto plano, determinístico (mismos datos → mismo texto), con la huella SHA-256 de su propio contenido. Dice **«NO ES UN COMPROBANTE FISCAL»** y muestra `es_comprobante_fiscal`: **NEXO no emite facturas** (la emisión está cerrada a propósito). Acredita que se recibió un pago; no reemplaza a la factura.

## 5 · Lo que falta y es decisión tuya

1. **Los datos bancarios de NEXO: el lugar ya existe, falta que me los pases.** (2026-10-15) Se declaran en el **entorno de la instalación** (`.env` del servidor, **no en el repositorio**, que es público): `NEXO_COBRO_TITULAR` y `NEXO_COBRO_CBU` (obligatorios), y opcionales `NEXO_COBRO_ALIAS`, `NEXO_COBRO_BANCO` y `NEXO_COBRO_CUIT` (ver `.env.example`). Con ellos salen **en los avisos de cobranza** (mora, acceso en pausa y suspensión; no en el rechazo de tarjeta, que no aplica al cobro manual) **y en la pantalla de Suscripción**. El CBU se valida (22 dígitos con sus dos dígitos verificadores, algoritmo del BCRA): un error de tipeo **no se muestra** —se ve como «no hay datos» y el banner del arranque dice qué está mal—, porque una cuenta equivocada en un aviso es plata de un cliente a un tercero. Sin nada declarado, los avisos no dicen nada de transferencias. **Pendiente de vos:** la cuenta (titular y CBU) y cargarla en el `.env` del servidor. Probado localmente (`tests/unit/datos-de-cobro.test.ts`, `tests/integration/datos-de-cobro-en-suscripcion.test.ts`); **no desplegado**.
2. **La factura.** Si NEXO tiene que facturarle al cliente, hoy se hace fuera del sistema (por ARCA, por quien corresponda); el comprobante de arriba no la reemplaza. Conviene registrar el n.° de factura emitida en algún lugar (hoy no hay campo operativo para eso).
3. **Pagos parciales o de más**: hoy se rechazan. Si el primer cliente va a pagar en cuotas fuera del plan, hay que decidir el tratamiento.
4. **Quién ejecuta el flujo y con qué frecuencia** (a mano, al ver el extracto del banco). Sin pasarela no hay forma de enterarse de un pago sin mirar el banco.
5. **Qué dice el contrato** sobre plazos de pago y consecuencias de la mora (el ciclo ya suspende por mora: la regla está en la política de cobranza declarada).

## 6 · Probado (local) y no probado

**Local:** 30 pruebas unitarias (centavos, extracto, conciliación, comprobante, envoltorio) y 10 de integración que **ejecutan el script real** contra la base: simulacro, registro exacto, repetición, otra referencia, referencia en otro documento, importes distintos, fecha futura / anterior, comprobante de un documento sin pagar, conciliación sin escribir. 9 mutaciones del script, todas detectadas.

**No probado:** ejecutarlo en el servidor (requiere la imagen con este script desplegada), un extracto real de un banco real (los formatos de CSV varían: el lector pide las columnas `fecha` e `importe`), y un cliente real pagando.

## 7 · Lo que NO se hizo

No se habilitó Mercado Pago, ni cobros automáticos, ni débito. `PAYMENTS_PROVIDER` queda como está. Nada de esto se ejecutó en producción.
