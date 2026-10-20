# Despliegue del 2026-10-19: segundo lanzamiento

**Estado: DESPLEGADO EN PRODUCCIÓN.** Versión `a825c29`, 141 migraciones, salud en verde. Hecho el 2026-10-19 ~22:02 ART, con la orden expresa del titular.

## Qué entró

| Qué | Detalle |
|---|---|
| Rediseño de la consola y de la landing | Menú por grupos, guías «Cómo se usa esta pantalla», tablero, búsqueda (Ctrl+K) |
| Landing de contratar | «Elegir este plan» (`/consola?plan=…`) y la sección «Cómo pagás y cómo entrás» (hoy: prueba de 14 días, transferencia) |
| **«Mis clientes»** (migración 0140) | Sólo la empresa propietaria; cuenta empresas, usuarios, suscripciones y cuáles pagan |
| **Asistente de IA** (migración 0136) | Chat con Claude Haiku 5.5, foto y PDF, herramientas con los permisos de quien escribe, control de cifras |
| **Cupo de tokens por día** (migración 0141) | Tope por empresa; el turno que cruza se completa y el siguiente se corta |
| Idempotencia, zona horaria y demás | Lo del primer despliegue y las migraciones 0133–0139 (emisión de facturas: la puerta **sigue cerrada**) |
| Corrección de textos | La landing, la consola y el manual ya no dicen que NEXO lee PDFs: hoy sólo se leen solos los XML de ARCA (`docs/LECTURA_DE_DOCUMENTOS.md`) |

## Resultado de cada paso (script de la noche)

| Paso | Resultado |
|---|---|
| Franja y V7 | **V7 OK**: UTC un día adelante, fecha de la aplicación = fecha ART |
| Servidor previo | `bfbc3bb`, 132 migraciones, respaldo automático del día verificado |
| Traer el commit | Fast-forward a `a825c29` (el clon se había realineado antes: ver abajo) |
| `desplegar.sh --commit` | Código 0. Imagen anterior conservada como `nexo:previo-20261020010236`. Respaldo previo `predeploy-a825c29` verificado y restaurado |
| Verificación posterior | `/health` 200; `/health/db` → `{"status":"ok","migrations":141,"version":"a825c29"}`; cadenas de auditoría íntegras en las tres empresas; libro mayor coincide |
| Designar a la propietaria | **OK**: Pablo Monney (CUIT 20452148324) en `platform_owner` |
| Política de cobranza | **Declarada**: reintentos 3, 7, 11 · avisos 0, 3, 7, 10, 12 · mora 10 · suspensión 14 días |
| Lo que se ve de afuera | La landing trae la sección de pago y la consola trae «Mis clientes» |

## Después del despliegue (a pedido del titular: «que esté todo funcionando»)

- **Asistente de IA encendido** para la empresa propietaria y la de pruebas, con un cupo de **200.000 tokens por día** cada una (tope prudente elegido para empezar: como máximo ~US$0,10 por día). Se cambia con `POST /intelligence/quota`. Clave y proveedor ya estaban en el `.env` del servidor (`ASSISTANT_PROVIDER=anthropic`, clave con alcance de espacio de trabajo). Verificado: el contenedor ve el proveedor y la clave; la prueba real contra Claude pasó antes (`npm run asistente:probar`).
- Con la 0140 desplegada, la propietaria queda designada y ve «Mis clientes».

## Para volver atrás

```bash
bash scripts/desplegar.sh --revertir      # vuelve a nexo:previo-20261020010236; NO toca la base
```

La base queda en 141 migraciones. Una imagen anterior **no** conoce las tablas 0136/0140/0141: ver `docs/DESPLIEGUE.md` antes de revertir con datos nuevos.

## Qué pasó en el camino (para no repetirlo)

- El 2026-10-16 el despliegue se detuvo, sin tocar producción, en el paso de traer el commit: el clon del servidor tenía `bfbc3bb` en su `main`, que es el mismo cambio que `2c75f50` de `origin/main` pero con otra historia, así que `git merge --ff-only` no podía avanzar. Se realineó el clon con `git reset --hard` (rama de respaldo `respaldo-bfbc3bb`) con el visto bueno del titular.
- El `TZ=America/Argentina/Buenos_Aires date` de Git Bash en Windows devuelve **UTC**: el chequeo de franja del script ahora calcula la hora ART como UTC−3.
- Una clave de API de Anthropic creada con alcance «Organización» responde 400 («not scoped to a workspace»): se crea con alcance de **espacio de trabajo**.

## Pendiente

- **Prueba por pantalla** del asistente con una empresa de prueba (necesita sesión con segundo factor: la hace el titular), y comparar el costo calculado con el de la consola de Anthropic.
- **Textos legales** (términos y privacidad): siguen siendo borradores; ya mencionan al proveedor de IA opcional. Revisar antes de ofrecer el asistente a un cliente.
- **Lectura con IA de PDFs y fotos**: a construir, después de medir con la muestra de comprobantes (`docs/LECTURA_DE_DOCUMENTOS.md`).
- **Mercado Pago**: probar el webhook en el servidor real (necesita credenciales de prueba).
- **Emisión de facturas**: sigue cerrada hasta la aprobación del contador (E5) y la orden del titular (E8). Condición frente al IVA a confirmar con el contador.
- Una empresa nueva (CUIT 20438412795) aparece en producción desde el primer despliegue: «Mis clientes» ya la cuenta.
