# Puestos propios y permisos por persona

Los 26 puestos predeterminados (`docs/PUESTOS.md`) cubren los trabajos más comunes. Cuando una empresa se organiza de otra manera, **el dueño del estudio** puede:

1. **Armar puestos propios**: un nombre, una explicación y las funciones que incluye (elegidas por módulo). Se pueden basar en un puesto predeterminado.
2. **Dárselos a las personas** del estudio, o sacárselos.
3. **Ajustar a una persona puntual**: agregarle o quitarle funciones por encima de su puesto.

Todo en **Configuración → Puestos propios y permisos por persona** (sólo la ve el dueño; migración 0145).

## Quién puede

Sólo el **dueño** del estudio (`organization_members.level = 'OWNER'`). Ni el Administrador de la empresa puede: decidir qué puede hacer cada persona es el acto más sensible del sistema. La comprobación vive **en la base** (`exigir_dueno_del_estudio`, dentro de funciones `SECURITY DEFINER`), no en la pantalla: la API además pide `user:manage`, pero la que decide es la base.

## Lo que nunca se da

- **Funciones reservadas** (`permisos_reservados`): firmar y cerrar la contabilidad (aprobar o revertir asientos, períodos, ejercicio, estados, libros emitidos, notas, plan de cuentas), administrar el sistema (usuarios, secretos, certificados de ARCA, datos de la empresa, plan, migraciones, conectar integraciones) y reglas normativas siguen siendo de los roles Contador y Administrador. Un puesto propio o un ajuste no las puede dar.
- **Armar y aprobar a la vez** en órdenes de pago, pedidos de compra o decisiones: un puesto —o una persona con sus ajustes— no puede tener las dos.

## Cómo se calcula lo que puede una persona

`user_permissions` = (permisos de sus roles ∪ de sus puestos propios ∪ lo que se le agregó) − lo que se le quitó. Es la única consulta con la que la API autoriza.

- Quien sólo tiene un puesto propio (sin ningún rol) **entra** a la empresa. Todo puesto propio incluye ver los datos de la empresa.
- **Segundo factor:** si lo que la persona puede hacer incluye funciones que mueven dinero, aprueban o tocan la contabilidad (`permisoSensible`), exige segundo factor igual que los puestos predeterminados equivalentes. La pantalla lo avisa antes de guardar.

## Constancia

Cada acto (crear, modificar, archivar, dar, quitar, ajustar) exige un **motivo escrito** (10 caracteres o más) y deja su fila en la bitácora encadenada, en la misma transacción que el cambio: `CREAR_PUESTO_PROPIO`, `MODIFICAR_PUESTO_PROPIO`, `ARCHIVAR_PUESTO_PROPIO`, `ASIGNAR_PUESTO_PROPIO`, `QUITAR_PUESTO_PROPIO`, `AJUSTAR_PERMISOS_DE_PERSONA`.

## API

| Ruta | Para qué |
|---|---|
| `GET /permisos` | Las funciones por módulo, con su etiqueta; marca las reservadas y las que exigen segundo factor |
| `GET /puestos-propios` | Los puestos propios de la empresa, con funciones y personas |
| `POST /puestos-propios`, `PUT /puestos-propios/:id` | Crear y modificar |
| `POST /puestos-propios/:id/archivar` | Archivar (deja de dar funciones; no se borra) |
| `POST /puestos-propios/:id/personas`, `…/personas/quitar` | Dar y quitar |
| `GET /personas/:userId/permisos` | Lo que puede una persona: base, ajustes y resultado |
| `POST /personas/:userId/ajustes` | Fijar lo que se le agrega y lo que se le quita |

Pruebas: `tests/integration/puestos-propios.test.ts` (incluye comprobar que sin la verificación del dueño fallan), `tests/security/consola-puestos-propios.test.ts`.
