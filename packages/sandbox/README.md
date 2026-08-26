# @aai/sandbox

Simulación sobre esquema aislado (§34). Funciones puras: el paquete decide si un
destino probó ser un sandbox y corre el escenario. **No abre conexiones** — eso lo
hace `scripts/sandbox.mjs`, y el lint de arquitectura lo impide.

```bash
npm run sandbox:create   # crea la base aislada, le aplica LAS MISMAS migraciones y la marca
npm run sandbox:run      # corre el escenario, previa prueba de aislamiento
npm run sandbox:status   # dice si el destino probaría ser un sandbox
```

## El candado pregunta al revés

La forma intuitiva de proteger esto es preguntar *"¿el destino es producción?"*:
comparar contra la URL de producción, revisar una lista de bases prohibidas,
mirar si el nombre dice `prod`.

Todas esas comprobaciones **fallan abiertas**. La base nueva que nadie agregó a la
lista pasa. La de otro cliente pasa. La que alguien renombró pasa. Y el modo de
falla no es un error visible: es una simulación escribiendo asientos en la
contabilidad real de alguien, con la etiqueta de "prueba" puesta en la interfaz y
en ningún otro lado.

Acá la pregunta es la contraria: **¿hay prueba de que esto es un sandbox?** La
prueba es una tabla —`sandbox_marker`— que solo existe si alguien corrió, a
propósito, `infrastructure/db/sandbox/0001_marca_de_sandbox.sql` sobre esa base.

Ese archivo **no está en `infrastructure/db/migrations/`**, y esa ubicación es el
diseño entero: si estuviera, producción recibiría la marca en el próximo deploy y
quedaría, para siempre, indistinguible de un sandbox. El control se habría
autodestruido sin que nadie escribiera una línea de más.

Entonces la ausencia de prueba —tabla que no está, marcador vacío, conexión que ni
siquiera se pudo abrir— es un **rechazo**, no una duda. Producción es rechazada no
porque esté en una lista, sino porque no puede demostrar lo que se le pide.

| Motivo | Cuándo |
|---|---|
| `SIN_MARCA_DE_SANDBOX` | No hay tabla, está vacía, o no se pudo leer. Los tres significan lo mismo |
| `MARCA_ADULTERADA` | La tabla está pero dice otra cosa: alguien la creó a mano |
| `MISMA_URL_QUE_PRODUCCION` | Literalmente la misma cadena de conexión |
| `MISMA_BASE_QUE_PRODUCCION` | Misma base, distinta URL — `localhost` y `127.0.0.1` son la misma máquina |
| `NOMBRE_SIN_PREFIJO` | La base no se llama `sandbox_*` |

Se juntan **todos** los motivos, no se corta en el primero. Tres fallas a la vez
dicen algo distinto que una: dicen que alguien pegó una URL de otro lado, no que
se equivocó en un carácter. Y un mensaje que dijera solo el primero llevaría a
corregirlo, reintentar, y encontrarse con el siguiente — a la tercera vuelta la
conclusión razonable es que el control está roto.

### El tipo hace cumplir el orden

`simular()` recibe un `Aislamiento` con `aislado: true`. Ese tipo no se puede
construir desde afuera de `aislamiento.ts`: sale de `verificarAislamiento` o no
sale. No hay forma de correr una simulación sin haber pasado por el candado, y no
depende de que alguien se acuerde de llamarlo primero.

### La marca no se saca

`sandbox_marker` tiene un trigger que rechaza `UPDATE` y `DELETE`. Una base que
dejó de ser sandbox no existe: o lo es, o hay que borrarla. Sacarle la marca para
"ascender" una base a producción dejaría una base con datos de prueba haciéndose
pasar por otra cosa.

`sandbox:create` tiene su propia guarda, porque es el único comando que
legítimamente toca una base sin marca: se niega si la base **ya existe, ya tiene
tablas y no está marcada**. Esa combinación es exactamente el aspecto que tiene
una base de producción, y marcarla ahí sería fabricar la prueba que el control
existe para exigir.

## Los mismos motores, no una copia

`simular` importa `@aai/accounting-engine` y `@aai/tax-engine` tal cual los usa la
aplicación, y `sandbox:create` invoca el runner de migraciones de producción. No
hay un segundo juego de migraciones ni una versión simplificada del esquema.

Un sandbox con esquema propio deriva. Al principio por poco —una constraint que
molestaba en una demo, un trigger que hacía lento el seed— y después lo suficiente
como para que *"anduvo en el sandbox"* deje de significar algo.

El pipeline es el del §34:

```
Comprobante ficticio → IVA → Asiento → Diario → Mayor → Balance
```

Cada paso devuelve `sinObservaciones` y su lista. **Un paso con observaciones no
es una falla del simulador**: es el control mostrando lo que ve, y es la razón de
ser del escenario.

## El sello viaja en el dato

`SELLO_DE_SIMULACION` está en el resultado y en el resumen, no solamente en la
pantalla que lo muestra. Un resultado copiado a un mail, pegado en un ticket o
exportado a un CSV sigue diciendo qué es. La advertencia que vive únicamente en el
encabezado de la interfaz desaparece en el primer copiar-y-pegar.

## El escenario de fábrica muestra una negativa a propósito

`scripts/sandbox-escenario.mjs` trae un mes de *EJEMPLO SIMULADO S.A.*: una compra
con IVA discriminado y una venta. La compra pasa todos los controles de forma y
aun así el crédito fiscal sale `NO_DETERMINABLE`, con la lista de lo que falta.

Es deliberado. Un sandbox que mostrara *"crédito computable: $ 21.000"* sería más
lindo de demostrar y estaría enseñando a confiar en una afirmación que el sistema
no hace.
