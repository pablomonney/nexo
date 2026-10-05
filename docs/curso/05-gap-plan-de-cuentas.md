# Fase 5 — Investigación del gap del plan de cuentas

**No se modificó código.** Esto es lectura y análisis, línea por línea, sobre
`apps/web/consola.html` tal como está en el commit `39eec2c`.

## 1. Qué ocurre entrando por el menú normal

`nav button[data-vista="config"]` dispara (línea ~4197):

```js
if (v === 'config') cargarConfig();
```

`cargarConfig()` (línea 12796) llama a `cargarMapeoContable()`, `listarCentrosDeCosto()`,
`GET /companies/current`, `GET /companies/current/users`, etc. — **nunca llama a
`refrescarCuentas()` ni a `dibujarCuentas()`**. La tabla del plan de cuentas
(`#t-cta`, dentro de `v-config`) queda con el `<tbody>` que tenía de la carga
anterior de la página: **vacío**, la primera vez que alguien entra a
Configuración en la sesión.

## 2. Qué ocurre entrando desde Pendientes

El `case 'companies'` de `abrirPendiente()` (agregado el 2026-09-22, rama
`SIN_PLAN_DE_CUENTAS`) hace:

```js
ir('config', migas);
await cargarConfig();
await refrescarCuentas();   // ← el llamado que falta en el caso general
```

`refrescarCuentas()` (línea 12632) pide `GET /accounts` de nuevo y llama a
`dibujarCuentas()`, que sí puebla `#t-cta`. Por eso, **solo** llegando desde
ese pendiente puntual, la tabla aparece poblada de entrada.

## 3. Qué función se ejecuta en cada caso

| Entrada | Funciones que corren | `dibujarCuentas()` se llama |
|---|---|---|
| Menú → Configuración | `cargarConfig()` | No |
| Pendientes → `SIN_PLAN_DE_CUENTAS` | `cargarConfig()` + `refrescarCuentas()` | Sí |
| Buscar una cuenta (`#b-cta-buscar`) | `dibujarCuentas()` | Sí |
| Dar de alta o editar una cuenta | `refrescarCuentas()` | Sí |

## 4. Qué endpoint se llama

`GET /accounts` (`apps/api/src/routes/accounts.ts:28`), exige
`requirePermission(tenant, 'account:read')`. Devuelve `{ accounts: [...] }`
con todas las cuentas de la empresa (código, nombre, tipo, `isPostable`,
`status`, etc.).

## 5. Qué datos devuelve, y quién ya los tenía

**El dato ya está en memoria antes de que la persona entre a Configuración.**
`usarEmpresa(id)` (línea 4533, corre al elegir empresa o al iniciar sesión) ya
hace su propio `GET /accounts` y guarda el resultado en `estado.cuentas`
(línea 4558) — lo usa para poblar los `<select>` de cuenta en Propuestas de
IA, Afectaciones y renglones de asiento manual (`iap-cuenta`, `afec-cuentas`,
`ne-debe`, `ne-haber`), y también el selector de cuenta contable del alta de
cuenta bancaria (línea 8342). **Esos selectores están bien** — se llenan
directo desde `estado.cuentas` con un `for`, sin pasar por `dibujarCuentas()`.

Lo único que falta es que algo llame a `dibujarCuentas()` — que ya sabe leer
`estado.cuentas` — al entrar a Configuración por primera vez. **No hace falta
un segundo pedido a la red**: el dato ya está, el problema es puramente de
render.

## 6. Diferencia entre ambos flujos, en una frase

El pendiente de puesta en marcha llama explícitamente a `refrescarCuentas()`
como parte de su propio `case`; la navegación normal a Configuración nunca
llamó a `dibujarCuentas()` en ningún punto de su cadena, y nadie lo notó
porque **el primer clic en "Buscar" lo arregla solo** — la tabla vacía dura
exactamente hasta la primera interacción con el buscador.

## 7. ¿Es realmente un bug?

Sí, acotado: **un defecto de renderizado silencioso**, no de datos. La
persona ve la sección "Plan de cuentas" vacía la primera vez que abre
Configuración en la sesión, sin ningún aviso de "cargando" ni de "sin
resultados" — simplemente no hay filas. Encaja en la definición de 🟡 (funciona,
tiene fricción) más que en 🔴 (no funciona), porque:

- el dato subyacente es correcto y está disponible;
- un clic en "Buscar" (incluso sin escribir nada) lo resuelve;
- no bloquea ninguna escritura — dar de alta o editar una cuenta funciona
  igual y, al terminar, sí refresca la tabla porque esos handlers sí llaman
  a `refrescarCuentas()`.

## 8. ¿Afecta al onboarding?

**No.** El bloque "Puesta en marcha" del Panel se carga en `cargarInicio()`
con `GET /onboarding` (`apps/api/src/routes/arranque.ts:306`, respaldado por
la vista `company_readiness`, migración 0075) — un pedido completamente
distinto, fuera de `estado.cuentas`. Es independiente de este render. Una
empresa nueva sigue viendo correctamente "0 cosas impiden registrar" una vez
cargado el plan, sin relación con este defecto.

## 9. ¿Afecta a otras funcionalidades?

No detecté otras. Los cuatro `<select>` que dependen de `estado.cuentas`
(línea 4563 y 8342) se llenan en el momento de elegir empresa, antes de que
exista la posibilidad de que este defecto los afecte. El único síntoma vive
en la tabla visible de "Plan de cuentas" dentro de Configuración.

## 10. Solución técnica que probablemente correspondería

**No se implementa en esta sesión** (regla explícita: no tocar código). La
forma más chica y más consistente con el resto del archivo sería agregar
`dibujarCuentas()` al final de `cargarConfig()` (usa `estado.cuentas`, que ya
está poblado por `usarEmpresa()` — no necesita ni siquiera el `await` a
`GET /accounts` de nuevo, salvo que se prefiera refrescar por si cambió algo
desde el login). Es un cambio de una línea, sin tocar reglas de negocio,
exactamente el tipo de corrección que ya se aprobó como "bajo riesgo" en
sesiones anteriores — queda anotado en Decisiones Pendientes de Pablo
(`10-master-plan.md` §19) para autorización explícita, no ejecutado acá.

## Clasificación final

**Bug real de UX, de bajo impacto, con causa raíz identificada con
precisión de línea.** No es documentación, no es comportamiento
intencional, no es falso positivo. No falta evidencia adicional para
confirmarlo — está confirmado por lectura directa del código en los dos
caminos.
