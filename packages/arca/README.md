# @aai/arca

Integración con ARCA, desacoplada del resto del sistema.

## La idea

Todo el acoplamiento con el certificado X.509 vive detrás de dos interfaces:
`CredentialStore` y `CapabilityStore`. Mientras el trámite no esté hecho, el
sistema usa `MockArcaClient` y **se desarrolla completo**: ingesta,
clasificación, asientos, libros. Las validaciones fiscales devuelven
`NO_VERIFICABLE / SIN_CREDENCIAL`, que es exactamente lo que corresponde
informar.

```
ArcaClient (interfaz de dominio)
├── MockArcaClient   determinístico, sin red, con escenarios de falla
└── SoapArcaClient   homologación | producción
    └── WsaaAuthenticator  ← lo único que necesita el certificado
```

## Tres decisiones que conviene conocer

**El mock se usa si y solo si el ambiente es `mock`.** No existe un "si falta la
credencial, mockeá". Esa comodidad haría que una configuración incompleta en
producción produjera validaciones fiscales inventadas informadas como reales.

**Nunca se devuelve un "OK" por omisión.** Un servicio caído, un timeout o un
CUIT sin habilitación producen `NO_VERIFICABLE` con su motivo — nunca un
aprobado. Colapsar "no pude preguntar" con "está bien" convierte una caída del
organismo en comprobantes aprobados en silencio.

**El mock sabe fallar.** Tiene escenarios de servicio caído y timeout. Un mock
que solo devuelve respuestas felices produce un sistema que nunca fue probado
contra un organismo caído, que es el estado en el que ARCA está una parte no
despreciable del tiempo.

## Uso

```ts
import { createArcaClient, aSelloFiscal, parseEnvironment } from '@aai/arca';

const client = createArcaClient({ environment: parseEnvironment(process.env.ARCA_ENVIRONMENT) });
const resultado = await client.constatarComprobante(companyId, comprobante);
const sello = aSelloFiscal(resultado);   // kind: 'FISCAL'
```

`aSelloFiscal` produce **solo** el sello fiscal. Que ARCA confirme un CAE prueba
que el comprobante fue autorizado; no prueba que la operación económica haya
existido. Son dimensiones distintas (§11 del pliego) y la UI las muestra por
separado.

## Datos de prueba

`COMPROBANTES_PRUEBA` cubre: autorizado, autorizado con observación (CAEA no
rendido), rechazado por fecha fuera de rango, inexistente, y emisor apócrifo. Los
códigos y mensajes salen de los ejemplos del manual oficial archivado, no
inventados: un mock con respuestas plausibles pero irreales entrena al sistema
para manejar un servicio que no existe.

## Verificación

```bash
npm run arca:check -- --env homologacion
```

Sin credenciales comprueba endpoints y estado del servicio. Con `--cert --key
--cuit` verifica además la autenticación. El trámite está en
[`docs/api/arca-onboarding.md`](../../docs/api/arca-onboarding.md).
