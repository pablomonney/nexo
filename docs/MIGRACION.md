# Cómo funciona el motor de migración

Documentación técnica del módulo. Para el estado de cada capacidad —qué está
implementado, qué preparado y qué bloqueado— está
[`NEXO_MIGRATION_ENGINE_V3.md`](../NEXO_MIGRATION_ENGINE_V3.md); acá se explica
**cómo funciona** y **cómo se le agrega un origen nuevo**.

---

## 1 · La frase que ordena todo el módulo

> Un formato soportado no es un sistema soportado.

NEXO lee el CSV que exporte cualquier programa. Eso no quiere decir que conozca
por dentro a ese programa: sus nombres de columna, sus códigos, su forma de
numerar. Cada adaptador declara su estado y la pantalla muestra el estado, no
una promesa.

La segunda, del mismo orden:

> Transportar una entidad no es saber escribirla.

El motor transporta las once entidades canónicas: las extrae, las mapea, las
normaliza, las valida y las muestra en la vista previa. Escribirlas en NEXO sabe
**diez**. La que falta llega a la vista previa y ahí se detiene, con su motivo.

---

## 2 · El recorrido

    archivo
      ↓  adaptador          extrae tablas crudas, sin interpretar nada
    tablas crudas
      ↓  mapeo              columna del origen → campo canónico
    filas mapeadas
      ↓  normalizador       texto → CUIT, fecha, importe en centavos
    modelo canónico
      ↓  validador          qué entra, qué entra con reparos, qué no entra
    vista previa            ← acá todavía no se escribió nada en la empresa
      ↓  importador         por tandas, con puntos de control
    NEXO
      ↓  reconciliador      filas, existencias y partida doble
    reporte
      ↓  reversión          deshace lo que la migración creó

**Nada se escribe en la empresa hasta `POST /migraciones/:id/importar`.** Cargar,
mapear y validar no tocan ninguna tabla de negocio.

---

## 3 · Los dos lados del módulo

| | Dónde | Qué hace | Depende de |
|---|---|---|---|
| El motor | `packages/migration-engine` | Extrae, mapea, normaliza, valida, reconcilia | Nada: es **puro**. No abre conexiones, no escribe en la base, no lee el disco |
| La persistencia | `apps/api/src/migracion` | Guarda lo crudo, importa por tandas, revierte | La base |

Esa separación es la que permite probar el motor entero sin base de datos, y es
la que hace que agregar un origen sea agregar un adaptador y nada más.

---

## 4 · El modelo canónico

Once entidades en `packages/migration-engine/src/canonico.ts`. Cada una declara
sus campos **obligatorios**, sus **opcionales** y sus **combinaciones de
identidad** en orden de confianza.

Todo valor llega en dos partes:

```ts
interface Campo<T> {
  crudo: string;      // lo que decía el origen, sin tocar
  valor: T | null;    // la interpretación, o null
  motivo?: string;    // por qué no se pudo interpretar
}
```

`null` significa **«no se puede afirmar»**, nunca cero ni cadena vacía. El crudo
se conserva siempre: es lo que permite contestar «¿de dónde salió este dato?» y
lo que hace revisable una normalización.

---

## 5 · El mapeo

`sugerirMapeo(entidad, columnas)` propone; nadie decide por el usuario. Tres
reglas, en orden:

1. El **nombre exacto** del campo canónico gana sobre el sinónimo de otro campo.
   Sin esto, la columna «IVA» de una venta se mapeaba a `condicionIva` —que
   tiene «iva» entre sus sinónimos— y el comprobante entraba sin impuesto.
2. Una columna se sugiere **una sola vez**, para el campo de mayor confianza.
3. **El repaso**: si un obligatorio quedó sin mapear y alguna columna asignada a
   un opcional también servía, se la lleva ahí. Es lo que hace que «SKU /
   Descripción / Precio» se reconozca como productos.

`adivinarEntidad` elige la entidad por cuántos obligatorios reconoce **por su
nombre exacto**, después por cuántos obligatorios exige —la más específica gana—
y recién después por el total de campos.

---

## 6 · La validación

Tres niveles y una consecuencia distinta para cada uno:

| Nivel | Qué significa | Qué pasa |
|---|---|---|
| `ERROR` | La fila no puede existir en NEXO | No se importa. Con un solo error, la migración no pasa a LISTA |
| `ADVERTENCIA` | Entra, y algo quedó dicho | Se importa marcada |
| `INFO` | Se normalizó algo que vale la pena ver | Se importa |

La partida doble es la única validación que mira **el conjunto** y no cada fila:
un asiento descuadrado se rechaza entero y **no se cuadra solo**.

---

## 7 · La importación por tandas

Tandas de 250 registros de destino. Cada tanda es **su propia transacción** con
su punto de control en `migration_batches`.

Lo que se gana: progreso visible, reanudación y cancelación.
Lo que se pierde, dicho sin disimulo: **una importación cortada a la mitad deja
la mitad escrita**. Es manejable porque lo escrito está identificado en
`migration_links` y se puede reanudar o revertir.

### El orden no es una preferencia

```text
WAREHOUSE → ACCOUNT → PARTY → PRODUCT → STOCK_BALANCE → STOCK_MOVEMENT
  → SALES_DOCUMENT → PURCHASE_DOCUMENT → JOURNAL_ENTRY → COLLECTION → PAYMENT
```

Un movimiento de stock necesita el producto y el depósito; un asiento necesita
la cuenta; un comprobante necesita el tercero; un pago necesita el comprobante.

### Una fila no es siempre un registro

Un asiento son varios renglones y un comprobante también. Los escritores que
agrupan declaran `agrupaPor`, las filas se ordenan por esa clave y **las tandas
se cortan solo donde la clave cambia**: una tanda que partiera un asiento por la
mitad escribiría medio asiento.

### El candado

Una sola corrida por migración a la vez, con una marca en
`migrations.importando_desde` que **se renueva al cerrar cada tanda y se vence
sola a los quince minutos**. Sin él, dos corridas simultáneas planifican las dos
y la segunda muere contra el `UNIQUE` de `migration_links` con un error de base
que no describe lo que pasó.

---

## 8 · Idempotencia

`UNIQUE (company_id, identidad)` sobre `migration_links`. La garantía vive en la
base, no en un `if` que se saltea llamando a otra ruta.

Dos caminos, y hacen falta los dos:

- **Lo que vino de una migración anterior** se reconoce por su identidad.
- **Lo cargado a mano antes de migrar** se reconoce por sus datos —el CUIT, el
  SKU— con `buscarExistente`. Sin esto, migrar duplicaría los clientes que
  alguien ya había cargado.

---

## 9 · La reversión

Cada tabla se deshace como esa tabla se deshace, y **en orden inverso** al de
importación: compensar un movimiento de stock exige que el producto siga activo.

| Tabla | Cómo |
|---|---|
| `parties`, `products`, `warehouses`, `accounts` | archivar |
| `journal_entries` | anular (siguen PROPUESTOS: nunca tocaron el Mayor) |
| `payment_orders` | anular con motivo |
| `stock_movements` | **movimiento inverso** — el libro solo crece |
| `tax_transactions` | **no se deshace**: se cuentan y se dicen cuáles |

Solo lo que la migración **creó**: los vínculos con `creado = false` apuntan a
filas que ya estaban.

---

## 10 · Las tres reconciliaciones

1. **Filas** — `enOrigen = importadas + ya estaban + rechazadas + omitidas`.
2. **Existencias** — lo que el archivo declaraba contra lo que quedó **a la
   fecha de corte**, no a hoy: si además se migraron los movimientos
   posteriores, la existencia de hoy no tiene por qué coincidir.
3. **Partida doble** — cantidad de asientos, debe y haber, en centavos y con
   enteros.

Las tres tienen una prueba que las rompe a propósito y comprueba que lo dicen.

---

## 11 · Seguridad

- **RLS forzado** en las seis tablas del módulo, una política cada una.
- **Tres permisos**: `migration:read` mira, `migration:write` prepara,
  `migration:import` ejecuta y revierte.
- **Nunca SQL desde el navegador**: un barrido estático comprueba que toda
  interpolación en una sentencia salga de una constante del propio archivo.
- **El módulo no abre archivos**: no hay `node:fs` en `apps/api/src/migracion/`.
- **El ZIP** rechaza nombres con travesía de directorios y tiene topes de
  entradas y de tamaño descomprimido.
- **Los tipos de comprobante** salen del catálogo `arca_comprobante_types`, no
  de texto libre.

---

## 12 · Los límites, medidos

| | |
|---|---|
| Ritmo de importación | ~370 filas/s |
| 50.000 filas | 2 min 15 s, 200 tandas |
| Memoria con 50.000 filas | ~380 MB — el archivo se lee entero |
| Tope de subida | 25 MB |
| Tope de filas del adaptador | 200.000, con aviso al recortar |

---

## 13 · Cómo agregar un adaptador

Un adaptador nuevo **no toca el núcleo**. Diez pasos:

### 1. Crear la clase

En `packages/migration-engine/src/adapters/`, implementando `AdaptadorDeOrigen`:

```ts
export class AdaptadorDeLoQueSea implements AdaptadorDeOrigen {
  readonly descripcion = DESCRIPCION;
  async extraer(entrada: EntradaDeExtraccion): Promise<ResultadoDeExtraccion> { … }
}
```

### 2. Declarar sus capacidades **reales**

```ts
const DESCRIPCION: DescripcionDeAdaptador = {
  codigo: 'LO_QUE_SEA',
  nombre: 'Lo que sea',
  medio: 'ARCHIVO' | 'API' | 'BASE_DE_DATOS',
  estado: 'IMPLEMENTADO' | 'PREPARADO' | 'PLANIFICADO' | 'BLOQUEADO',
  capacidades: { entidades: […], formatos: […], porTandas, reanudable, conIdExterno },
  queFalta: 'Qué le falta, con nombre propio',   // obligatorio si no es IMPLEMENTADO
};
```

El registro **rechaza** un adaptador que no sea `IMPLEMENTADO` y no diga qué le
falta. No es una convención: es un `throw`.

### 3. Registrarlo

En `registroPorDefecto()`, `index.ts`. Con eso aparece en
`GET /migraciones/fuentes`, en la matriz de compatibilidad y en la pantalla.

### 4. Extraer, sin interpretar

`extraer` devuelve **tablas crudas**: nombre, columnas y filas de texto. No
convierte tipos, no valida y no sabe nada de NEXO.

### 5. Sugerir entidad y mapeo (opcional)

`entidadSugerida(tabla)` y `mapeoSugerido(tabla)`. Si el origen tiene nombres de
columna propios, acá es donde se traducen. Son **sugerencias**: la pantalla las
muestra elegidas y quien migra las puede cambiar.

### 6. No escribir un escritor

Los escritores son del modelo canónico, no del origen. Si el adaptador traduce
bien al canónico, los diez escritores ya existentes funcionan.

### 7. Un conjunto de datos

En `packages/migration-engine/src/datasets.test.ts`, generado por código y no
guardado como archivo: así el archivo y la afirmación sobre el archivo no se
pueden separar.

### 8. Pruebas del adaptador

Que lea lo que dice leer, y que **lo que no puede leer lo diga**. El segundo es
el que importa: es donde vive el defecto que después aparece en producción.

### 9. Un E2E

Con la empresa completa, como
`tests/integration/migracion-empresa-completa.test.ts`.

### 10. La matriz

Sale sola de las capacidades declaradas: `REGISTRO.matriz()`. Si el paso 2 dice
la verdad, la matriz dice la verdad.

---

## 14 · Cómo NO agregar un adaptador

- **Declarándolo `IMPLEMENTADO` sin una fuente real delante.** Un adaptador de
  Tango escrito sin una exportación de Tango inventa la estructura de un sistema
  ajeno.
- **Tocando el núcleo.** Si hace falta cambiar el importador para que un
  adaptador funcione, o el adaptador está mal, o falta un campo en el modelo
  canónico — y esa es una decisión aparte.
- **Sin `queFalta`.** El registro no lo deja, y el motivo es que «próximamente»
  deja a alguien esperando una versión que nadie sabe si viene.
