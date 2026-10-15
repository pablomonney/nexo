# Registro de consultas respondidas a clientes

**Estado: PLANTILLA OPERATIVA.** Fecha: 2026-10-15.

Sin un registro, la tercera vez que preguntan lo mismo nadie sabe que ya pasó dos veces, y una recuperación de cuenta no deja rastro de **quién verificó qué**. Es una tabla simple: una fila por consulta, agregada **al momento**, no al final del día.

**Qué NO se escribe acá:** contraseñas, códigos de recuperación, secretos de segundo factor, ni el contenido de los datos contables del cliente. Quién lo pidió y qué se hizo, sí.

| Fecha y hora (ART) | Cliente / empresa | Quién escribe y por qué canal | Qué pide | Qué se verificó (si es de cuenta) | Qué se respondió o se hizo | Quién atendió | Estado |
|---|---|---|---|---|---|---|---|
| 2026-MM-DD HH:MM | [empresa] | [persona · correo/teléfono] | [consulta, en una frase] | [ver `PROCEDIMIENTO_RECUPERACION_DE_CUENTA.md` §3] | [respuesta; si se corrió una herramienta, el comando **sin** secretos] | [nombre] | abierta / cerrada |

## Qué hace útil al registro

- **Las consultas repetidas son defectos del producto o de la documentación**: la tercera vez, se arregla la causa (un texto en pantalla, una guía, un error mal redactado), no se contesta de nuevo.
- **Las recuperaciones de cuenta** se registran con la verificación escrita; debe coincidir con la que quedó en la bitácora de la empresa (`RESETEAR_SEGUNDO_FACTOR` / `CAMBIAR_CORREO_DE_CUENTA`).
- **Los incidentes** (`PROCEDIMIENTO_INCIDENTE_DE_SEGURIDAD.md`) llevan una fila que apunta al documento de reconstrucción.

## Dónde vive

Mientras no exista un sistema de tickets (no existe; ver `NEXO_LEGAL_Y_SOPORTE.md` §2), un archivo **fuera del repositorio** o una planilla privada: este archivo es la **plantilla**, no el registro real, porque contiene datos de clientes y el repositorio es público.
