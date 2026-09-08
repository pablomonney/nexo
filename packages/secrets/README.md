# @aai/secrets — el puerto de secretos

Estado: **🟡 PREPARADO — no 🟢 CONECTADO.** No hay ningún gestor de secretos
externo. Lo que hay es todo lo que va del lado de acá de la interfaz.

Este paquete **no resuelve secretos**. Define qué es un secreto para NEXO, cómo
se lo nombra y qué se puede hacer con él; quién lo va a buscar de verdad es un
adaptador que vive en `apps/`. Por eso no tiene dependencias, no hace I/O y no
nombra a ningún proveedor de nube — y el lint de arquitectura lo impone, con dos
reglas (`secretos-sin-vendor`, `dominio-sin-sdk-de-nube`) que fallan el build si
alguien importa un SDK acá o en cualquier otro paquete del dominio.

## La idea entera, en una línea

**NEXO guarda dónde está el secreto, no el secreto.**

```
secret_refs   empresa · alcance · nombre · versión · referencia · estado
              ────────────────────────────────────────────────────────────
              NO hay columna donde poner el valor
```

No es una regla que alguien pueda olvidarse de aplicar: no existe el lugar. Un
test lo comprueba contra `information_schema` en vez de contra una lista escrita
a mano, para que una columna nueva llamada de cualquier manera también lo
active.

## Las cuatro piezas

| | |
|---|---|
| `SecretRef` | La identidad: empresa (o `null`, si es del despliegue), alcance, nombre, versión opcional. Es lo que se puede escribir en un log — no es sensible |
| `SecretMaterial` | El valor, y solo aparece como resultado de un `get`. No se guarda, no se cachea, no se serializa |
| `SecretMetadata` | Todo lo demás: versión, backend, estado, quién y cuándo. **No lleva el valor**, y por eso es lo que viaja a la API y a la pantalla |
| `ErrorDeSecreto` | Seis códigos. El constructor **no acepta el valor**: no se puede filtrar un secreto en un mensaje de error porque no hay por dónde pasárselo |

`SecretProvider` tiene dos métodos —`get` y `existe`— y `get` no devuelve
`null`: falla con un código. La diferencia entre «no está configurado» y «está
configurado y el gestor no contesta» decide si alguien tiene que ir a cargar
algo o a mirar la infraestructura, y un `null` las borra a las dos.

`SecretAdmin` es aparte a propósito: leer un secreto para usar una integración y
administrar cuál es no son el mismo permiso. `secret:manage` es de
ADMINISTRADOR; quien emite un comprobante usa el certificado de ARCA sin poder
tocarlo.

## Los proveedores que hay acá

Ninguno resuelve un secreto por empresa. Es la limitación real, y está puesta
adelante en cada uno:

- **`EnvSecretProvider`** — los del despliegue, desde variables de entorno. Se
  **niega** a resolver uno por empresa: obligaría a reiniciar el proceso para
  dar de alta un cliente y dejaría las credenciales de todas en el mismo lugar.
- **`NullSecretProvider`** — no hay gestor. Es un modo de operación, no un
  placeholder: el ERP funciona entero y lo que no está disponible son las
  integraciones que necesitan credencial.
- **`InMemorySecretProvider`** — para tests. **Tira si el entorno es
  producción**, porque un doble de test que arranca en producción es un almacén
  de secretos en memoria que nadie sabe que existe.

En los tests, los valores son explícitamente sintéticos (`TEST_SECRET_ONLY…`).
Un valor de prueba con forma de credencial real termina, tarde o temprano, en un
escaneo de secretos o en la cabeza de alguien que cree que es real.

## Redacción

`redactarUrl`, `redactarTexto` y `taparValor` existen porque la redacción por
camino no alcanza. Un logger puede tapar `authorization` y `cookie` —y los
tapa—, pero una excepción de red trae la URL completa adentro del mensaje, y hay
proveedores que aceptan la clave en la query. `redactarTexto` busca URLs dentro
de la prosa; `taparValor` tapa la credencial concreta si aparece con cualquier
otra forma.

La lista de parámetros sensibles no es cerrada. No todos los proveedores usan
los mismos nombres, así que cubre `api_key`, `apikey`, `key`, `token`,
`access_token`, `secret`, `password` y `authorization`, y se le agrega el que
aparezca.

## Conectar un gestor

Son cuatro pasos y ninguno toca este paquete: escribir un adaptador en
`apps/api/src/secrets/` que implemente `SecretProvider`, devolverlo desde
`crearProveedorDeSecretos` para el nombre `kms`, cargar el material en el gestor
y declarar la referencia con el prefijo `kms:`.

**Las filas existentes no se migran**: lo que cambia es el prefijo de la
referencia, no la tabla. Ese es el punto de haberla guardado así.

Ver `docs/DESPLIEGUE.md` §4.1 y `SECURITY.md` §5.
