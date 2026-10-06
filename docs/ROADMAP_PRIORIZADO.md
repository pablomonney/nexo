# Roadmap repriorizado — 2026-10-02 (actualizado 2026-10-05: se agregó el defecto de fechas en UTC)

Este documento toma todo lo que quedó abierto después del cierre de interfaz
del 2026-10-01 (`CIERRE_INTEGRAL_NEXO.md`, `BACKLOG_INTERFAZ_PENDIENTE.md`,
`FINAL_NEXO_STATUS.md`, y el mapa maestro regenerado el mismo día) y lo
ordena contra nueve criterios explícitos, en vez de por intuición o por en
qué orden se encontró cada cosa. No repite la evidencia de esos documentos —
la referencia.

## Los nueve criterios

1. **Seguridad / integridad de datos** — ¿deja una fuga, una pérdida posible
   o un dato contable incorrecto si no se toca?
2. **Riesgo para un cliente real** — si hoy hubiera un cliente operando, ¿lo
   afecta directamente?
3. **Operabilidad del primer cliente** — ¿bloquea poder dar de alta y operar
   al primer cliente piloto?
4. **Capacidad de facturar y dar soporte** — ¿bloquea cobrar o atender a un
   cliente que ya está adentro?
5. **Autonomía operativa** — ¿exige que alguien del equipo intervenga a mano
   cada vez, en vez de que el sistema lo resuelva solo?
6. **Experiencia de uso (UX)** — ¿es una fricción de uso diario sin afectar
   la integridad de los datos?
7. **Escalabilidad** — ¿importa solo cuando crece el volumen (de clientes,
   de datos, de tráfico)?
8. **Diferenciación** — ¿es parte de lo que distingue a NEXO de un ERP
   genérico, o es infraestructura que un cliente nunca ve?
9. **Material de curso / futuro** — ¿es necesario para el curso o para una
   funcionalidad planeada, pero no para operar hoy?

Cada ítem recibe **Alto/Medio/Bajo/—** en el criterio donde aplica realmente
(no se fuerzan los nueve en cada fila) y una prioridad final de **AHORA /
DESPUÉS / MÁS ADELANTE**, igual que en el mapa maestro, pero acá justificada
ítem por ítem.

## Matriz

| Ítem | Seguridad/integridad | Riesgo cliente real | 1er cliente | Facturar/soporte | Autonomía | UX | Escala | Diferenciación | Curso/futuro | Prioridad |
|---|---|---|---|---|---|---|---|---|---|---|
| Confirmar visualmente las 16 pantallas cerradas el 2026-10-01 | — | Medio (podrían tener un bug de layout no detectado) | Alto (son las pantallas que el primer cliente va a usar) | — | — | Alto | — | — | — | **AHORA** |
| Cuenta de Resend + dominio verificado | — | Bajo | Alto (alta autoservicio real) | Medio | Alto (hoy un humano entrega el correo a mano) | Alto | Medio (no escala sin esto) | — | — | **AHORA** |
| Decidir cobro manual vs. esperar Mercado Pago | — | — | Alto (condiciona cómo arranca el primer cliente) | Alto | — | — | — | — | — | **AHORA** |
| Mercado Pago (u otra pasarela) contratada | — | Bajo | Medio (cobro manual ya funciona) | Alto | Alto | Medio | Alto (cobro manual no escala) | — | — | **DESPUÉS** |
| Política de cobranza declarada | Medio (hoy un pago fallido no actúa solo) | Medio | — | Alto | Alto | — | Medio | — | — | **DESPUÉS** |
| Defectos de fechas #3, #4 y #5 (UTC en producción; ver `PLAN_ZONA_HORARIA.md`) | Alto (hoy dan fecha de mañana entre 21 y 24 h ART; el cambio ingenuo de zona rompería la cadena de auditoría) | Medio | Bajo | — | — | Medio | — | — | — | **DESPUÉS** (plan listo, sin implementar; no es un fallo del deploy `b412b9e`) |
| Clave de idempotencia caja/stock (reintento de red) | Alto (puede duplicar un movimiento financiero real) | Alto | Medio | — | — | — | — | — | — | **DESPUÉS** |
| Trámite ARCA: delegar wscdc + padrones | — | Bajo | Bajo (ya factura y constata lo propio) | Medio | Medio | — | — | Alto (constatar terceros es diferencial) | — | **DESPUÉS** |
| Certificado de producción ARCA | — | — | — | Alto (sin esto, no hay CAE real nunca) | — | — | — | Alto | — | **DESPUÉS** |
| Verificar Docker en un entorno real | Medio (sin verificar, el primer despliegue es un riesgo no medido) | — | — | — | — | — | Alto | — | — | **DESPUÉS** |
| Trazar un renglón de estado contable ya **emitido** (falta endpoint) | — | Bajo | — | — | — | Medio | — | Medio (trazabilidad es diferencial) | — | **MÁS ADELANTE** |
| Trazar un match bancario confirmado en **otra sesión** (falta endpoint) | — | Bajo | — | — | — | Medio | — | — | — | **MÁS ADELANTE** |
| Reordenar etapas del CRM (el backend no lo soporta) | — | — | — | — | — | Bajo | — | — | — | **MÁS ADELANTE** |
| Ítem 2 — decisión desde el comprobante sin pasar por Asientos | — | — | — | — | — | Bajo (ya hay atajo usado) | — | — | — | **MÁS ADELANTE** |
| Ítem 12 — clasificación por IA real | — | — | — | — | Alto si hubiera volumen | — | — | Alto | — | **MÁS ADELANTE** (credencial) |
| Ítem 13 — facturación parcial | — | — | — | — | — | Medio | — | — | — | **MÁS ADELANTE** (decisión de producto) |
| KMS en producción | Medio (hoy el cifrado local ya cumple; KMS es defensa en profundidad) | — | — | — | — | — | Alto | — | — | **MÁS ADELANTE** |
| Sacar el backup fuera del disco de la base | Alto (un desastre de disco se lleva las dos copias) | Bajo (no ocurrió) | — | — | — | — | Medio | — | — | **DESPUÉS** |
| Verificar Traefik/HTTPS/DNS en el servidor real | — | — | — | — | — | — | — | — | — | **DESPUÉS** (pendiente de verificación, no de código) |
| 6 videos del curso (guion/audio listos) | — | — | — | — | — | — | — | — | Alto | **AHORA** (en paralelo, mismo bloqueo: navegador) |
| Videos 07/08 (falta un dato nuevo) | — | — | — | — | — | — | — | — | Medio | **DESPUÉS** |
| Video 17 (decisión de entorno) | — | — | — | — | — | — | — | — | Medio | **DESPUÉS** |
| Recomendación automática (Decision Engine) | — | — | — | — | — | — | — | Alto | — | **MÁS ADELANTE** (requiere política de riesgo) |
| RRHH / retenciones / FIFO / producción | — | — | — | — | — | — | — | — | Bajo (sin cliente que lo pida todavía) | **MÁS ADELANTE** |

## Lectura de la matriz

**Lo único con severidad de seguridad/integridad real y sin mitigar:** la
clave de idempotencia de caja/stock (puede duplicar un movimiento financiero
real) y el backup viviendo en el mismo disco que la base (un desastre se
lleva las dos copias). Ninguno de los dos es nuevo — ambos estaban
documentados antes de este repriorizado — pero juntos son los dos ítems que
más se acercan a tocar el criterio 1, y por eso van en DESPUÉS y no en MÁS
ADELANTE, aunque no bloqueen al primer cliente.

**Lo que de verdad define AHORA:** no es código. Es reconectar el navegador
(destraba la verificación visual de las 16 pantallas y 6 videos de curso a
la vez) y tomar dos decisiones de negocio que no cuestan desarrollo —cobro
manual vs. esperar pasarela, y contratar Resend—. Ninguno de los cuatro
ítems de AHORA tiene una dependencia de código pendiente.

**Lo que parece urgente y no lo es:** los tres gaps de interfaz que quedan
(2, 12, 13) tienen prioridad real baja en esta matriz — no porque no
importen, sino porque los tres ya tienen una alternativa funcional o
dependen de algo que construir código no resuelve (una credencial, una
decisión de producto). Construirlos ahora sería trabajo que no destraba
nada, violando la propia regla del proyecto (`NEXO_ROADMAP.md`, "cómo se
decide qué sigue", punto 4: una decisión de producto no se inventa).

**Lo que compite por el mismo bloqueo:** confirmar las 16 pantallas y grabar
los 6 videos de curso dependen los dos, exclusivamente, de reconectar el
navegador — es el único punto donde dos líneas de trabajo distintas se
destraban con una sola acción del usuario.

## Qué no entró en esta matriz, y por qué

Los ítems ya **VERIFICADOS** sin nada pendiente (seguridad multiempresa,
núcleo contable, backup/restore, ARCA homologación, MFA) no se repiten acá
— repriorizar algo que ya está cerrado no aporta. El detalle completo de
cada uno vive en `NEXO - Mapa Maestro del Producto.pdf`, sección 20 y 28.
