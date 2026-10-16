# Exportación completa de la empresa

**Estado (2026-10-16): construida y probada localmente; NO desplegada** (entra con la migración 0137). Resuelve el bloqueo M10 de `docs/BLOQUEOS_PRIMER_CLIENTE.md`: una empresa puede llevarse **todos** sus datos, venga de cero o con información anterior (migrada).

## Qué es

`POST /companies/current/exportacion-completa` (consola: **Configuración → Exportar todos los datos de la empresa**) devuelve un ZIP con todo lo de la empresa. Lo puede pedir sólo quien tiene `company:export` (rol **ADMINISTRADOR**), con un **motivo escrito**; queda en la bitácora (`EXPORTAR_EMPRESA`) con el motivo y los totales (tablas, filas, archivos), **sin el contenido**.

## Qué trae

| Archivo | Contenido |
|---|---|
| `LEEME.txt` | Qué es cada cosa y cómo comprobarla |
| `manifiesto.json` | Por archivo: filas, bytes y **sha256**; qué quedó afuera y por qué; tablas que no se pudieron leer (debe ser vacío); versión del esquema |
| `esquema.json` | Columnas y tipos de cada tabla exportada |
| `empresa.ndjson` / `usuarios.ndjson` | La fila de la empresa; quiénes tienen acceso y con qué rol (**sin** contraseñas ni segundo factor) |
| `datos/<tabla>.ndjson` | **Cada tabla con `company_id`** (hoy 127 de 128; ver «Qué no sale»), una fila JSON por línea. Incluye las tablas de la migración (`migrations`, `migration_*`), la bitácora con su cadena de hashes, el Mayor, los maestros, etc. |
| `catalogos/<tabla>.ndjson` | Los catálogos globales a los que apuntan esos datos (impuestos, tipos de comprobante…) |
| `archivos/<ruta>` | Los documentos subidos, tal como se guardaron |

Los importes salen como los guarda PostgreSQL (`numeric` exacto, sin pasar por punto flotante). Las **vistas no se exportan**: son derivadas y se recalculan desde las tablas.

## Cómo se garantiza que no falta nada

- Las tablas **se descubren del esquema** (`company_id`, leído de `pg_catalog`), no de una lista escrita a mano: una tabla nueva entra sola.
- Una tabla de la empresa que la aplicación no pueda leer **no se omite en silencio**: figura en `manifiesto.noLegibles`, y la prueba de integración exige que esté vacío.
- Los documentos que la base nombra y el almacén no tiene figuran en `manifiesto.archivos.faltantes`.
- **Cualquiera puede comprobarlo sin NEXO:** `node scripts/verificar-exportacion.mjs <archivo.zip>` revisa que cada archivo exista, que su huella y su tamaño coincidan, que las líneas sean las declaradas, que no haya nada sin declarar, y avisa si falta algo. Probado: un archivo cortado a mitad **no se abre** (sin directorio central), y un byte cambiado se detecta.

## Qué NO sale, y por qué (`apps/api/src/exportacion/politica.ts`)

- **Material de credenciales:** claves privadas cifradas de ARCA, tokens de acceso y de renovación de integraciones, referencias a claves de cifrado y la tabla `secret_refs`. La empresa se lleva sus datos, no cómo operar en su nombre ante ARCA o un proveedor; eso se vuelve a declarar.
- **Identidad de los usuarios:** contraseñas, segundo factor, sesiones y códigos de recuperación (no son de la empresa; son del estudio).
- Todo lo que se saca figura en el manifiesto con su motivo.
- **Guardián:** `tests/security/exportacion-columnas.test.ts` (S-48) obliga a que toda columna nueva que *parezca* sensible (contraseña, token, clave, secreto…) se decida explícitamente —excluirla o declararla segura con su motivo—. Sin eso, una credencial nueva saldría por olvido.

## Cómo se arma (y límites)

- **En streaming**: se lee la base con un cursor y por lotes, dentro de la transacción de la empresa (RLS incluido), y el ZIP se escribe a medida que sale. El uso de memoria no depende del tamaño de la empresa y no se escribe nada en disco (el contenedor tiene el sistema de archivos de sólo lectura).
- Si algo falla a mitad, **la respuesta se corta** y el archivo queda sin directorio central: ningún programa lo abre como ZIP válido. La transacción confirma **después** del último byte, así que el archivo y la bitácora van juntos o no van.
- Una exportación por empresa a la vez (`409 EXPORTACION_EN_CURSO`) y un tope de **20 minutos**.
- **No es ZIP64:** una entrada o un archivo de más de **4 GiB**, o más de **65.535 entradas** (documentos incluidos), no se pueden escribir y la exportación falla diciéndolo (`LIMITE_DE_ZIP`). Una empresa de ese tamaño necesita una exportación por lotes, que no está hecha.
- La consola arma el archivo en memoria del navegador antes de guardarlo: para empresas muy grandes conviene bajarlo por la API directamente.

## Pruebas (qué las prueba)

`tests/integration/exportacion-completa.test.ts` (19): sobre una empresa **migrada de otro sistema** (el ZIP de diez entidades), con un tercero cargado a mano, un documento subido, una integración con token y una **empresa vecina con una marca inconfundible**. Comprueba: cada tabla sale y cuenta lo mismo que la base; el sha256 de cada archivo; nada de la vecina; el token y el hash de contraseña no aparecen en ningún byte; el documento sale idéntico; los importes con decimales salen exactos; 403 sin permiso; 400 sin motivo; bitácora; una a la vez. `tests/unit/zip-streaming.test.ts` (lo lee `tar`), y 9 mutantes sobre los guardas (sacar el token, olvidar tablas, exportar el hash, no incluir documentos, huella falsa, no auditar, no pedir permiso, permitir simultáneas, no exigir motivo): **9 detectados**. Un décimo —quitar el filtro `company_id` de la consulta— **sobrevive a propósito**: lo cubre el RLS (la base ya filtra), que es defensa en profundidad y no se puede probar quitándola.

## Qué no está verificado

- Con **datos reales de producción** (una empresa grande): sólo se probó con empresas de prueba. Tiempo y tamaño reales quedan por medir.
- Con **Docker real** (sistema de archivos de sólo lectura): el camino no escribe a disco, pero no se ejecutó en la imagen.
- **Importar** una exportación de vuelta (restaurar una empresa desde este archivo) **no existe**: esto es portabilidad de salida. Si se quiere poder volver a cargarla, es otro desarrollo.
- Los textos legales (derecho de portabilidad, plazo de entrega) siguen siendo borradores a revisar (B8).
