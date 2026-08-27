# WSCDC — qué falta exactamente para constatar comprobantes

> **Estado: `REQUIRES_EXTERNAL_INPUT`.**
> El código está escrito y probado. Lo que falta es un trámite, y no se puede hacer desde acá.

## Qué está listo

| Pieza | Estado | Cómo se verificó |
|---|---|---|
| Endpoints de homologación y producción | ✅ | Del manual archivado `ARCA_manual_desarrollador_wscdcv1_v4.pdf` |
| Sobre SOAP y parseo de la respuesta | ✅ | `ComprobanteDummy` devolvió `app=OK db=OK auth=OK` contra el servicio real |
| Parseo de `ComprobanteConstatar` | ✅ | Test contra el XML de ejemplo del propio manual (§2.2) |
| Firma CMS del TRA | ✅ | Aceptada por el WSAA real — ver `packages/arca/src/soap/wsaa.ts` |
| Obtención del ticket de acceso | ✅ | Verificado, **pero para el servicio `wsfe`** |
| Degradación sin credencial | ✅ | Devuelve `NO_VERIFICABLE` con motivo, nunca un `OK` por omisión |

## Qué falta

**Una sola cosa: autorizar el certificado al servicio `wscdc` en WSASS.**

El permiso del WSAA es **por servicio**. El certificado `CN=SistemaContable` está autorizado a
`wsfe` —emisión— y eso no dice nada sobre `wscdc` —constatación—. Son dos altas distintas sobre el
mismo certificado.

Mientras no esté, el WSAA responde:

```
[ns1:coe.notAuthorized] Computador no autorizado a acceder al servicio
```

Ese error **no indica un problema del código ni del certificado**: la firma se valida y se acepta
antes de llegar a la comprobación de permiso. Está demostrado con un control de dos vías —el mismo
CMS íntegro y con la firma corrompida devuelven códigos distintos—, documentado en `wsaa.ts`.

## Cómo se completa

1. Entrar a **WSASS** (el autogestión de homologación) con Clave Fiscal.
2. Autorizar el servicio de **constatación de comprobantes (`wscdc`)** al certificado
   `CN=SistemaContable`, para el CUIT representado.
3. Comprobarlo:

```bash
npm run arca:check -- --env homologacion --cert C:/ARCA/certificado.crt --key C:/ARCA/privada.key --cuit 20452148324 --servicio wsfe,wscdc
```

Tiene que decir `✔ Ticket para "wscdc"`. El script informa **un servicio por línea** justamente para
que "anda `wsfe`" no se lea como "anda todo".

> Las etiquetas exactas del menú de WSASS no están archivadas en `docs/normative-sources/`, así que
> los pasos de arriba describen el trámite, no citan un documento. Guiarse por el sentido: asociar
> servicio a certificado.

## La regla que no se rompe

**No se marca como terminado hasta que una constatación real devuelva un resultado real.**

No se simula la autorización, no se cablea una respuesta de ejemplo, y `MockArcaClient` no se usa
para dar por probado este camino: existe para que el resto del sistema pueda desarrollarse sin el
trámite, y sus respuestas están marcadas como del mock en la bitácora de consultas.

Un `wscdc` "verificado" contra un simulador nuestro no verifica nada sobre ARCA — verifica que
sabemos escribir simuladores.
