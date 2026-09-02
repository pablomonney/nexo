# apps/web

**Un archivo.** `consola.html`: sin build, sin framework, sin dependencias.

Este README anunciaba «Next.js + TypeScript + Tailwind» y una carpeta todavía sin
escribir. Nada de eso es cierto ni lo fue nunca, y mandaba a buscar una
aplicación que no existe.

## Por qué un solo archivo

No es una decisión definitiva sobre la interfaz del producto: es la consola con
la que se opera y se demuestra el circuito **mientras esa interfaz no exista**.
Un archivo estático sin cadena de dependencias tiene tres propiedades que
importan más que la comodidad de desarrollo, y las tres están verificadas:

1. **No contiene datos.** Se sirve sin autenticación, y hay un test que
   comprueba que el HTML no lleve credenciales, ni identificadores de empresa,
   ni una consulta a la base.
2. **No habla con PostgreSQL.** Todo lo pide a la API, autenticado, y el
   servidor decide qué puede ver. Una consola que consultara la base por su
   cuenta saltearía el RLS.
3. **No carga nada de afuera.** Su CSP es `default-src 'none'` con
   `connect-src 'self'`: ni una fuente, ni un script, ni una imagen remota.

## Las tres reglas que la página no puede romper

Están escritas arriba del archivo y son las que dirimen cada decisión de diseño:

1. **No calcula nada contable ni fiscal.** Ni un saldo, ni una alícuota, ni una
   afectación. Todo número que se ve lo devolvió la API.
2. **No ofrece una acción que el backend vaya a rechazar** por una condición que
   la página ya conoce: sin el permiso el botón no existe, con el período
   cerrado tampoco, y un proveedor `PLANIFICADO` no entra en el selector. Un
   botón que termina en 403 le enseña a la persona que el sistema falla al azar.
3. **Nunca presenta una sugerencia de máquina con el mismo tratamiento que una
   declaración profesional**, ni una declaración como una respuesta de ARCA.
   Distinto color, distinta etiqueta, distinto verbo.

## Qué la defiende

| Dónde | Qué comprueba |
|---|---|
| `tests/security/consola-contrato.ts` (S-12) | Que cada llamada resuelva contra una ruta registrada, que **cada dominio de la API tenga puerta** —la dirección inversa, que encontró veintisiete endpoints inalcanzables—, que ningún `E(id)` quede sin elemento, y que ninguna escritura se ofrezca sin pedir su permiso. |
| `tests/security/mvp-fronteras.ts` | Que no lleve datos, que no hable con la base y que su CSP no admita recursos externos. |
| `tests/integration/navegacion-e2e.ts` | Que las pantallas funcionen contra datos reales. |

El barrido de los `E(id)` existe por algo concreto: los manejadores se asignan a
nivel de módulo, así que un identificador mal escrito no rompe una pantalla —
lanza durante la carga y deja la consola **entera** muerta. Sin build ni
typechecker que lo ataje, una errata de una letra en cuatro mil líneas no se ve
leyendo.

## Cómo se abre

```
npm start
```

y la raíz redirige a `/consola`. La sirve la API (`GET /consola`), que lee el
archivo del disco en cada pedido: no hay paso de compilación que se pueda
olvidar.
