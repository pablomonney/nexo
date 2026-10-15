# Procedimiento de recuperación de cuenta

**Estado: OPERATIVO (se aplica cuando la versión con la 0134/0135 esté desplegada).** Fecha: 2026-10-15.
Reemplaza el «procedimiento manual provisorio» de `NEXO_LEGAL_Y_SOPORTE.md` §2, que dependía de que quien atendía hiciera la verificación de memoria.

## 0 · Los tres casos, y qué resuelve cada uno

| La persona perdió… | Se resuelve con | Quién lo hace | Necesita al operador |
|---|---|---|---|
| **La contraseña** (conserva el correo y el segundo factor) | «Olvidé mi contraseña» en la pantalla de ingreso | La propia persona | **No** |
| **El segundo factor** (el teléfono) y también los códigos de recuperación | `recuperar-cuenta segundo-factor` | El operador, tras verificar identidad (§3) | **Sí** |
| **El acceso a la casilla de correo** de la cuenta | `recuperar-cuenta correo` | El operador, tras verificar identidad (§3) | **Sí** |

Si perdió el segundo factor **y** tiene los códigos de recuperación, no hace falta nada de esto: entra con un código de recuperación y configura uno nuevo (la pantalla de ingreso lo admite).

## 1 · Autoservicio: «Olvidé mi contraseña» (verificado: `tests/integration/recuperar-contrasena.test.ts`)

1. En la pantalla de ingreso: **Olvidé mi contraseña** → se escribe el correo → **Mandarme el código**.
2. Llega un correo con un código. **Vence en 1 hora** y sirve **una vez**. Pedir otro invalida el anterior; no salen más de un mensaje por minuto.
3. Se pega el código y se elige la contraseña nueva (12 caracteres o más) → **Cambiar la contraseña**.
4. Se cierran **todas** las sesiones abiertas de la cuenta y se limpia el bloqueo por intentos fallidos. Llega un aviso de «se cambió la contraseña» a la misma dirección.
5. **El segundo factor no se saltea:** quien lo tenía activado lo sigue necesitando para entrar.

Lo que ve la persona es **lo mismo** exista o no la cuenta (para no revelar quién usa NEXO). Si no llega nada, revisar el correo no deseado y que la dirección sea la de la cuenta; después, §3.

## 2 · Lo que se hace ANTES de tocar nada

El operador **no** corre ninguna herramienta por una solicitud sin verificar. Pasos:

1. **Registrar la consulta** en `REGISTRO_DE_CONSULTAS.md` (fecha, quién escribe, desde qué dirección, qué pide).
2. **Mirar la cuenta** (no escribe nada):
   ```bash
   bash scripts/recuperar-cuenta.sh ver --email persona@empresa.com
   ```
   Dice el estado, si tiene segundo factor y cuántos códigos de recuperación le quedan, cuántas sesiones tiene abiertas y a qué empresas pertenece.
3. Si la cuenta **no existe o no está ACTIVA**, no se sigue: se le dice a la persona que se resuelve con el alta (o «No me llegó» si nunca confirmó el correo).

## 3 · La verificación de identidad (la hace una PERSONA, y queda escrita)

Es el paso que decide si esto es una recuperación o una toma de cuenta. **La herramienta no puede hacerlo por vos**: sólo exige que se escriba cómo se hizo.

Hace falta **al menos dos** de estas, y la primera siempre:

1. **Pedido desde la dirección registrada** (si la casilla se perdió, este punto no se puede; en ese caso, tres de los siguientes).
2. **Un dato de la empresa que sólo sabe el titular**: el CUIT con el que se dio de alta, el último comprobante que emitió, el nombre de una persona que figura con rol en la empresa.
3. **Llamada de vuelta** a un teléfono que ya figuraba (no al que dicta quien pide).
4. **Confirmación de otro administrador** de la misma empresa, por un canal independiente.
5. **Documento que acredite relación con la empresa** (poder, estatuto, constancia de CUIT) y documento de identidad de quien pide.

**No alcanza** con: un mensaje desde una dirección nueva que dice «soy el dueño», urgencia («lo necesito para presentar hoy»), o conocer el nombre de la empresa. La urgencia es la forma más común de ingeniería social; el costo de esperar un día es bajo y el de dar una cuenta contable a un tercero no lo tiene.

Si hay dudas: **no se hace**, se le explica qué falta y se registra.

## 4 · La herramienta (verificado: `tests/integration/recuperar-cuenta.test.ts`, 8 mutaciones detectadas)

Se corre **en el servidor**, con el mismo aislamiento que las tareas diarias. Siempre primero el **simulacro** (es el comportamiento por defecto):

```bash
# Perdió el segundo factor y los códigos de recuperación
bash scripts/recuperar-cuenta.sh segundo-factor --email persona@empresa.com \
  --motivo "Perdió el teléfono con el segundo factor y no conserva los códigos" \
  --verificacion "Llamada de vuelta al teléfono registrado y confirmación del CUIT y del último comprobante"

# …mismo comando con --confirmar para hacerlo de verdad

# Perdió el acceso a la casilla de correo
bash scripts/recuperar-cuenta.sh correo --email viejo@empresa.com --nuevo nuevo@empresa.com \
  --motivo "Cerró la casilla anterior" --verificacion "…" [--confirmar]
```

Qué hace y qué no:

| | `segundo-factor` | `correo` |
|---|---|---|
| Cambia | apaga el segundo factor y borra sus códigos de recuperación | el correo con el que entra |
| Cierra las sesiones de la cuenta | sí | sí |
| Invalida códigos de «olvidé mi contraseña» pendientes | — | sí (iban a la casilla vieja) |
| Toca la contraseña | **no** | **no** |
| Toca el segundo factor | (es lo que cambia) | **no** |
| Deja constancia | en la bitácora de **cada empresa** de la cuenta, con el motivo y la verificación | ídem |
| Sobre qué cuentas actúa | sólo ACTIVAS, por correo **exacto** (nunca patrón) | ídem; no pisa un correo ya usado |

`--motivo` (10+ caracteres) y `--verificacion` (20+) son **obligatorios**: sin ellos no se toca nada, ni con `--confirmar`.

## 5 · Después de hacerlo

1. **Avisar a la persona** por el canal verificado, con lo que tiene que hacer: en el caso del segundo factor, **ingresar y configurarlo de nuevo** (los roles que lo exigen no pasan sin él) y **guardar los códigos de recuperación en un lugar seguro, fuera del teléfono**. En el del correo: entrar con el correo nuevo.
2. **Avisar a los otros administradores** de la empresa, si los hay: una cuenta con acceso cambió de segundo factor o de correo.
3. **Registrar el cierre** en `REGISTRO_DE_CONSULTAS.md`: qué se hizo, con qué verificación, quién.
4. **Revisar la bitácora** de la empresa: la fila `RESETEAR_SEGUNDO_FACTOR` / `CAMBIAR_CORREO_DE_CUENTA` tiene que estar. Si no está, algo falló: se investiga antes de dar el caso por cerrado.

## 6 · Qué NO se hace nunca

- Dar o dictar una contraseña. La persona la elige con su código; el operador **nunca** la conoce.
- Pasar el código de recuperación por un canal distinto de la casilla de la cuenta.
- Apagar el segundo factor «sólo por hoy» sin la herramienta (SQL a mano, sin constancia).
- Hacerlo sin verificar porque «es el cliente de siempre».
- Usar `reset-password-usuario.mjs` o `reset-mfa-usuario.mjs`: son de la base local de desarrollo y están atados a una cuenta de demostración.

## 7 · Lo que no está resuelto

- **Quién atiende y con qué disponibilidad** no está definido (no hay guardia): es una decisión del fundador.
- **Cómo se contacta a la persona si perdió también el teléfono de contacto**: se resuelve caso por caso con la documentación del §3.5.
- La recuperación por correo depende de que **Resend** esté operativo y de que el dominio de envío esté verificado (B6 de `BLOQUEOS_PRIMER_CLIENTE.md`: **NO VERIFICADO**). Si el correo no sale, la persona cae en el §3 aunque sólo haya olvidado la contraseña.
