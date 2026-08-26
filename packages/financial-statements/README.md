# @aai/financial-statements

ESP y ER con plantilla versionada. Función pura sobre datos: sin red, sin disco,
sin base.

Documentación completa en [STATEMENTS.md](../../STATEMENTS.md).

## La estructura es dato, no código

El criterio de la fase es *"dos empresas con marcos distintos generan estructuras
distintas sin cambiar código"*. La plantilla es un árbol declarativo en
`statement_templates`, versionado y con la norma de la que sale. Agregar un marco
es insertar una fila.

Y por eso mismo se valida antes de usarla: viene de la base, y una estructura que
llega de afuera y gobierna un cálculo contable se valida, no se ejecuta a ver qué
pasa.

## Ninguna cifra existe sin origen

No hay ningún tipo donde alguien pueda escribir un importe. Todo renglón se
deriva de saldos de cuentas y sale con la lista de las que lo formaron. Es el §38
en el nivel de tipos.

## Los dos controles que sostienen la fase

**`CUENTA_SIN_RUBRO`** — una cuenta que ningún selector captura desaparece del
estado, y a veces el estado igual cierra porque dos huérfanas se compensan.

**`CUENTA_EN_DOS_RUBROS`** — un selector demasiado ancho suma una cuenta dos
veces.

Los dos bloquean la emisión, y corren sobre las dos columnas.

## Un estado que no cierra no se emite

Es la diferencia con el Libro Diario. El Diario registra lo que pasó y un hueco
hay que poder verlo; un estado contable **afirma**, y una afirmación que no cierra
es falsa.
