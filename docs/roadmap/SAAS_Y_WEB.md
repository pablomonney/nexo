# SaaS y web comercial — qué falta y por qué no se construyó todavía

**Fecha:** 2026-09-02
**Contexto:** ejecución posterior a la auditoría integral. Este documento cierra
los dos puntos que la ejecución **no** implementó, con el motivo de cada uno.

---

## 1 · Alta autoservicio

### Qué existe hoy

| Pieza | Estado |
|---|---|
| Primer administrador de la instalación | `POST /auth/register-first-admin`, **una sola vez**: el segundo intento se rechaza |
| Alta de un estudio | `POST /organizations`, exige estar autenticado |
| Alta de empresa dentro del estudio | `POST /organizations/:id/companies` |
| Alta de usuario dentro del estudio | `POST /organizations/:id/users` |
| Asignación de rol por empresa | `POST /companies/:id/roles` |
| Puesta en marcha de la empresa nueva | `GET /onboarding` (0075/0076) |

Es decir: **una persona que ya está adentro puede crear todo**. Lo que no existe
es que alguien de afuera se dé de alta solo.

### Por qué no se construyó

Un alta abierta sin verificar el correo es un formulario de spam con base de
datos atrás: cualquiera crea mil estudios, cada uno con su empresa, y el sistema
no tiene forma de distinguirlos de un cliente. La verificación exige **mandar un
correo**, y mandar un correo exige un proveedor con credenciales.

Está en la categoría «requiere credenciales» y no se resuelve escribiendo código.

### Lo que sí quedó preparado

El camino desde «existe un usuario» hasta «la empresa puede operar» está entero
y probado: crear el estudio, crear la empresa, asignar roles, y el asistente que
dice qué falta para trabajar. Cuando haya proveedor de correo, lo único nuevo es
el par «pedir alta / confirmar dirección» y la creación del estudio con el
usuario que confirmó.

### Lo que habrá que decidir cuando llegue ese momento

- Si el alta crea un estudio o una empresa suelta.
- Qué plan tiene una empresa recién creada. Hoy `subscription_plans` los tiene
  como catálogo **sin precios y sin topes**, y esos dos son decisiones
  comerciales (ADR de la 0073).
- Si hay período de prueba, y qué pasa al terminar. La 0073 ya fijó lo que no se
  negocia: **exceder un límite avisa y no bloquea**, porque un sistema contable
  que se niega a registrar un hecho por una cuestión comercial deja los libros
  incompletos.

---

## 2 · Web comercial

### Qué existe

**Nada.** `apps/web` contiene la consola técnica y nada más. No hay sitio
público, ni dominio, ni entorno productivo.

### Por qué no se construyó ahora

No es prudencia genérica: es que una web comercial que ofrece «probar NEXO»
necesita dos cosas que todavía no existen —un alta autoservicio y un entorno
donde probarlo—. Sin ellas, el botón principal de la página no lleva a ningún
lado, y una página cuyo llamado a la acción no funciona es peor que no tenerla.

Y hay una razón de fondo: la interfaz que hoy se le mostraría a un visitante es
una consola técnica que su propio README declara provisoria. Mostrarla como si
fuera el producto sería vender otra cosa.

### La arquitectura, cuando corresponda

**Separada de la aplicación.** Un sitio estático servido aparte, sin acceso a la
base y sin sesión. No comparte proceso con la API: una vulnerabilidad en una
página de marketing no puede quedar del mismo lado que la contabilidad de nadie.

**Qué puede decir hoy, sin inventar nada:**

- qué es NEXO y qué problema resuelve;
- las capacidades **que existen**, verificables contra `COBERTURA_ERP.md`;
- cómo trata la información: RLS forzado por empresa, bitácora encadenada,
  trazabilidad de cada cifra;
- qué **no** hace: no emite comprobantes electrónicos, no liquida sueldos, no
  presenta el Libro IVA Digital;
- un formulario de contacto o de demo.

**Qué no puede decir, y no es opinable:** precios que no existen, testimonios de
clientes que no existen, cantidad de usuarios, empresas o facturación. Está
prohibido por §15 y no cambia porque sea una página de marketing — al contrario:
es el único lugar donde una cifra inventada sale del repositorio y llega a
alguien que va a decidir con ella.

### Lo que hay que decidir antes

- Dominio y alojamiento del sitio.
- Si el formulario de contacto manda correo (proveedor) o guarda en la base.
- Qué se muestra de precios, que sigue siendo una decisión sin tomar.

---

## 3 · Resumen

| Punto | Estado | Bloqueo |
|---|---|---|
| Alta autoservicio | Preparado hasta el borde | Proveedor de correo (credenciales) |
| Plan de una empresa nueva | Arquitectura lista | Decisión comercial |
| Cobro | No existe | Proveedor de pagos (credenciales) |
| Web comercial | No existe | Depende del alta y de un entorno productivo |
| Precios en la web | No existe | Decisión comercial |

Ninguno de los cinco se desbloquea escribiendo código, y por eso ninguno se
implementó a medias.
