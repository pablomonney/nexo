# Borradores legales y procedimientos de soporte de NEXO

**Estado: BORRADORES. NO ESTÁN PUBLICADOS. NINGUNO HA SIDO REVISADO POR UN ABOGADO.**
Fecha de esta versión: 2026-10-15.

Este directorio es el insumo que `NEXO_LEGAL_Y_SOPORTE.md` pedía y que no existía. Se escribió leyendo el comportamiento real del sistema (cada afirmación dice dónde se verifica), para que quien revise no tenga que deducirlo del código.

| Documento | Qué es | Lo escribe / lo decide |
|---|---|---|
| [`BORRADOR_TERMINOS_Y_CONDICIONES.md`](BORRADOR_TERMINOS_Y_CONDICIONES.md) | Condiciones del servicio | Borrador: Claude. **Revisión legal: pendiente (B8)** |
| [`BORRADOR_POLITICA_DE_PRIVACIDAD.md`](BORRADOR_POLITICA_DE_PRIVACIDAD.md) | Qué datos se tratan, para qué, con quién, cuánto | Borrador: Claude. **Revisión legal: pendiente (B8)** |
| [`BORRADOR_ACUERDO_DE_ENCARGADO_DEL_TRATAMIENTO.md`](BORRADOR_ACUERDO_DE_ENCARGADO_DEL_TRATAMIENTO.md) | NEXO como encargado del tratamiento de los datos que un estudio carga de **sus** clientes | Borrador: Claude. **Revisión legal: pendiente (B8)** |
| [`PROCEDIMIENTO_RECUPERACION_DE_CUENTA.md`](PROCEDIMIENTO_RECUPERACION_DE_CUENTA.md) | Qué hace una persona cuando perdió la contraseña, el segundo factor o el correo, y qué hace quien atiende | Operativo; **vigente** (la herramienta existe y está probada) una vez desplegada |
| [`PROCEDIMIENTO_INCIDENTE_DE_SEGURIDAD.md`](PROCEDIMIENTO_INCIDENTE_DE_SEGURIDAD.md) | Qué se mira, en qué orden y qué se le dice al cliente | Operativo; la parte de notificación legal **requiere abogado** |
| [`REGISTRO_DE_CONSULTAS.md`](REGISTRO_DE_CONSULTAS.md) | Plantilla del registro de lo que se responde a clientes | Operativo |

## Cómo leer los borradores

- Lo que está entre `[CORCHETES EN MAYÚSCULAS]` es **un dato o una decisión que no se conoce** y que no se inventó: razón social, domicilio, plazos, precios, jurisdicción, contacto. Cada uno está listado al final del documento en «Lo que falta decidir».
- Lo que el sistema **no hace** está dicho como tal. Por ejemplo, **no existe hoy una exportación completa de la empresa** (sólo informes en CSV), y los borradores no la prometen.
- Cada afirmación sobre el producto lleva, entre paréntesis, dónde se verifica (archivo o prueba), para que si el sistema cambia se vea qué parte del texto quedó vieja.

## Lo que este directorio NO es

No es asesoramiento legal ni reemplaza la revisión de un abogado. Publicar estos textos tal cual en la landing o en la consola sería afirmar compromisos que nadie con matrícula revisó. **No se publicó nada.**
