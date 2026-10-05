# Fase 10 — Dataset demo del curso

**No se cargó ni se modificó nada en producción.** Esto es la especificación
del dataset a preparar antes de grabar — se materializa en local con
`npm run factura:demo` (que ya rechaza correr contra cualquier base que no
termine en un nombre de desarrollo) o con un seed equivalente.

Los CUIT de abajo están calculados con la función real de dígito
verificador del proyecto (`withCheckDigit`, `packages/shared`) sobre una
base numérica inventada — son válidos en formato y **no corresponden a
ningún contribuyente real**.

## Estudio y empresa

| Campo | Valor |
|---|---|
| Nombre del estudio | Estudio Demo NEXO |
| Empresa | **Ferretería El Tornillo Feliz S.R.L.** |
| CUIT | `30-71234560-4` |
| Tipo de entidad | SRL |
| Jurisdicción | AR-C (CABA) |
| Organismo | (ninguno) |
| Cierre de ejercicio | 12-31 |
| Domicilio | Av. Rivadavia 1234, CABA (ficticio) |
| Rubro | Ferretería y materiales de construcción — elegido porque da terceros,
productos con y sin stock, y operaciones de compra/venta parejas |

## Usuarios ficticios

*(Corregido el 2026-09-30, en la auditoría de cierre del curso: esta tabla
seguía citando `mariana.sosa@demo-nexo.test`, la cuenta con la que se
escribió originalmente este documento. La cuenta que de verdad se usó en
toda la producción real —login, MFA, todos los videos grabados— es
`mariana.sosa.produccion@demo-nexo.test`, según documentan los scripts
`scripts/reset-mfa-usuario.mjs` y `scripts/reset-password-usuario.mjs`, que
distinguen explícitamente las dos cuentas como "huérfana" (la de acá abajo,
sin empresa ni MFA) y "la real". No se fusionan ni se borra la huérfana —
ya existe en la base, dar de baja usuarios no es una operación que exista
en NEXO— pero la tabla queda corregida para reflejar cuál es la cuenta de
producción vigente.)*

| Nombre | Correo | Rol |
|---|---|---|
| Mariana Sosa | `mariana.sosa.produccion@demo-nexo.test` | ADMINISTRADOR, CONTADOR (ver nota del video 07 en `14-guiones-definitivos.md` sobre por qué tiene los dos) |
| Julián Ferreyra | `julian.ferreyra@demo-nexo.test` | CONTADOR |
| Load: contraseña de fixture, nunca la real de nadie | `una-contrasena-de-prueba-larga` (patrón de los tests) | — |

`.test` como dominio a propósito — es un TLD reservado para pruebas
(RFC 2606), nunca resuelve, y dice a simple vista que no es una cuenta real.

## Terceros

| Código interno | Razón social | CUIT | Rol | Condición IVA |
|---|---|---|---|---|
| CLI-001 | Maderera San Martín S.A. | `30-71234561-2` | Cliente | Responsable Inscripto |
| CLI-002 | Kiosco Doña Rosa (Rosa Gómez) | — (consumidor final) | Cliente | Consumidor Final |
| PROV-001 | Distribuidora Ferrolux S.A. | `30-71234562-0` | Proveedor | Responsable Inscripto |

## Productos

| Código | Nombre | Unidad | Lleva stock | Precio de lista |
|---|---|---|---|---|
| PROD-001 | Tornillo autorroscante 6x1" (caja x100) | Caja | Sí | $1.850 |
| PROD-002 | Pintura látex interior 20L | Balde | Sí | $28.400 |
| PROD-003 | Servicio de corte de madera a medida | Hora | No | $4.200 |

## Plan de cuentas

El plan modelo de NEXO (185 cuentas, «Usar este plan modelo») — no se
inventa uno nuevo. Las cuentas que el curso va a citar por código:

| Rol contable | Cuenta |
|---|---|
| CLIENTES | `1.1.03.01` |
| PROVEEDORES | `2.1.01.01` |
| IVA_DÉBITO | `2.1.04.01` |
| IVA_CRÉDITO | `1.1.04.01` |
| VENTAS | `4.1.01` |
| COMPRAS | `5.1.03` |
| MERCADERÍA | `1.1.05.01` |
| COSTO_DE_VENTAS | `5.1.01` |

## Cuenta bancaria (fixture para V13)

*(Agregado el 2026-09-23, para cerrar la inconsistencia que el guion de
V13 dejaba abierta: pedía "el número de fixture del dataset" sin que
existiera ninguno.)*

| Campo | Valor |
|---|---|
| Identificación del fixture | `BANCO-DEMO-01` — usar este nombre al preparar el entorno de grabación, para no confundirlo con una cuenta real |
| Banco | Banco Ficticio del Sur *(nombre inventado — no corresponde a ninguna entidad bancaria real, argentina o extranjera)* |
| Titular | Ferretería El Tornillo Feliz S.R.L. |
| CUIT del titular | `30-71234560-4` (mismo CUIT de la empresa demo, sección "Estudio y empresa") |
| CBU | `0999999900000012345678` *(22 dígitos con formato de CBU argentino, generado a mano — no calculado con el dígito verificador real de ningún banco. No usar como referencia de formato válido, solo como dato de pantalla)* |
| Alias | `FERRETERIA.DEMO.NEXO` |
| Moneda | ARS |

Este es el **único** fixture bancario del dataset — si en el futuro un
guion necesita una segunda cuenta (por ejemplo, para mostrar una
transferencia entre cuentas propias), hay que agregarla acá antes de
grabar, no improvisarla en cámara.

## Operación de referencia (la que ya corrió en producción)

Para los videos que reutilizan la evidencia real (V09, V10, V15, V16, V31),
**no hace falta inventar una operación nueva** — se usa la ya verificada:

- Documento: `factura-prueba-nexo-0001-00000102.xml`
- Comprobante: VENTA 1-1-102, 2026-09-19, $123.420
- Asiento: `01a0c725-bc0d-7eea-944c-8cd1cf0fe3be`

Para el resto de los videos (compras, caja, existencias, etc.), generar
operaciones nuevas sobre la empresa demo de arriba, con montos redondos y
fáciles de seguir en cámara (ver tabla siguiente).

## Operaciones adicionales sugeridas

| Video | Operación | Monto sugerido |
|---|---|---|
| V11 (Ventas) | Presupuesto → pedido → factura a Maderera San Martín, 2 cajas de tornillos | $3.700 + IVA |
| V12 (Compras) | Solicitud → recepción → pago a Distribuidora Ferrolux, 50 baldes de pintura | $1.420.000 + IVA |
| V13 (Dinero) | Apertura de caja $50.000, cobro en efectivo del kiosco Doña Rosa | $1.850 |
| V14 (Existencias) | Recuento físico con una diferencia chica y explicable (ej. 2 cajas de menos) | — |
| V19 (Bienes de uso) | Alta de una camioneta de reparto usada en el rubro | $8.500.000, 5 años |

## Qué NO usar nunca en una grabación

- El CUIT `20452148324` (certificado de homologación real del proyecto,
  vive fuera del repo en `C:\ARCA\`) ni ningún dato de esa carpeta.
- La base `aai` de producción o cualquier captura de su contenido.
- Cualquier variable de `.env`, real o de desarrollo.
- El corpus de `scripts/generar-comprobantes-homologacion.mjs` sin antes
  confirmar que sus CAE y CUIT son de ambiente de homologación, no de una
  operación real archivada.
- Nombres, correos o CUIT de clientes reales del estudio, aunque sean de
  prueba en producción (ej. `contador-diario-*@estudio.test` de los tests
  de integración: esos corren en `aai_test`, no en el dataset del curso).
