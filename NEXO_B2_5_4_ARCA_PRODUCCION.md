# NEXO — B2.5.4 ARCA PRODUCCIÓN

**Fecha de la medición:** 2026-09-10
**Método:** inspección y ejecución del repositorio real. Ninguna afirmación de
este documento sale de una suposición sobre qué debería existir.

---

## 1. Veredicto

# 🟡 PREPARADO — CON UNA DECISIÓN DE PRODUCTO ANTES QUE EL CERTIFICADO

Y conviene decir de entrada lo que la auditoría encontró, porque cambia la
pregunta:

> **NEXO no puede emitir facturas, y no es que falte cablearlo: está prohibido
> por una regla del grafo de módulos.**

`packages/arca-emision` —el paquete que pide CAE— **no puede ser importado por
`apps/`**. Lo impide `.dependency-cruiser.cjs`, con severidad `error`, y el lint
de arquitectura corre en cada `verify`. La emisión está declarada fuera del MVP y
ese paquete existe para generar datos de prueba en homologación, desde un script.

Entonces el bloqueo de ARCA producción **no es el certificado**. Es una decisión
de producto que todavía no se tomó: si NEXO emite comprobantes fiscales o no. El
certificado viene después.

Lo que **sí** hace NEXO contra ARCA hoy —constatar comprobantes— está
implementado, aislado por empresa, auditado, y con la autenticación WSAA
**verificada contra el servicio real**.

---

## 2. Qué estaba implementado

| Pieza | Estado medido |
|---|---|
| **WSAA** (TRA, firma CMS, `loginCms`, parseo, expiración) | ✅ Implementado y **verificado contra el organismo** el 2026-08-27: certificado autorizado a `wsfe` en WSASS, tickets reales |
| **Caché de tickets en disco** (`TicketCacheFs`) | ✅ Implementada, y es obligatoria: el WSAA emite **un ticket por (CUIT, servicio)** y niega el siguiente mientras el primero viva |
| **WSCDC** (`ComprobanteConstatar`) | ✅ Implementado, conectado a la API, por empresa, auditado en `arca_query_log` |
| **Separación de ambientes** | ✅ `mock` / `homologacion` / `produccion`, con extremos distintos y sin solapamiento |
| **Certificados X.509 por empresa** | ✅ `company_arca_credentials`, AES-256-GCM, RLS, una sola activa por empresa+ambiente |
| **Candado de emisión** | ✅ `verificarDestinoDeEmision` comprueba que el destino **sea** homologación (igualdad), no que «no sea» producción |
| **WSFE / CAE / QR** | 🟡 Implementados en `arca-emision`, **inalcanzables desde la aplicación por diseño** |
| **Padrón A13 / A100** | ⬜ No implementados. Sus manuales sí están archivados con hash |

---

## 3. Qué corregí

Tres afirmaciones falsas en la documentación. Ninguna rompía código; las tres
habrían hecho tomar una decisión equivocada.

| Dónde | Decía | Es |
|---|---|---|
| `docs/api/arca-onboarding.md` | «Autenticación WSAA de punta a punta ⚠️ **no verificada**» | **Verificada** contra el servicio real el 2026-08-27 |
| `docs/api/arca-onboarding.md` | «Padrón A13 y wsapoc: sus manuales todavía no están archivados con hash» | Los manuales **están** archivados y `norms:verify` los da íntegros. Lo que falta es el código |
| `packages/arca/src/environment.ts` | «los manuales de wsfev1 y padrón todavía no se archivaron» | Están archivados. Lo que **no** está confirmado es el **extremo de producción** de wsfev1 |

La tercera es la que importa para esta fase: el WSDL archivado
(`ARCA_wsfev1_homologacion.wsdl`) confirma **exactamente** el extremo de
homologación, `https://wswhomo.afip.gov.ar/wsfev1/service.asmx`. Del de
producción no hay fuente archivada. Apuntar a un extremo equivocado en
producción no falla de forma obvia: falla como «ARCA no contesta».

---

## 4. Qué agregué

### 4.1 · El certificado dejó de vencer en silencio (migración 0116)

`company_arca_credentials_public` calculaba `vencido` y `dias_restantes` desde la
0015. **No lo miraba nadie.** Un certificado dura dos años; el día que caduca,
`credencialVigente()` deja de devolver fila y la constatación pasa a
`NO_VERIFICABLE / SIN_CREDENCIAL`. Es la respuesta correcta y es invisible: sin
error, sin log, sin pantalla roja.

Ahora es una fuente más de `work_queue` —la número 24—:

| Cuándo | Rama | Bloquea |
|---|---|---|
| Más de 30 días | *(no aparece)* | — |
| 30 días o menos | `ARCA_CERTIFICADO_POR_VENCER` | No |
| Vencido | `ARCA_CERTIFICADO_VENCIDO` | **Sí** |

### 4.2 · S-41 — cuatro riesgos que no se ven leyendo

`tests/security/arca-produccion.test.ts`, 11 casos: que la emisión no llegue a la
aplicación, que importar un histórico no sea emitir, que los ambientes no se
mezclen, y que el candado de emisión pruebe el destino.

### 4.3 · Cinco casos sobre el vencimiento

En `tests/security/credenciales-arca.test.ts`, contra base real.

---

## 5. Qué tests ejecuté

```
Test Files  167 passed (167)
Tests       2531 passed (2531)     ← eran 2515; +16
npm run verify → EXIT=0
```

Base de pruebas **reconstruida desde cero**. Los controles nuevos se observaron
fallando antes de darlos por buenos:

- Un archivo de `apps/` importando `@aai/arca-emision` → detectado por nombre y ruta.
- La ventana de aviso de 30 días desactivada → `a treinta días o menos avisa` en rojo.

---

## 6. Qué quedó demostrado

1. **La aplicación no puede emitir.** Prohibido por el grafo de módulos, y ahora
   también comprobado por nombre (`FECAESolicitar`) y por import.
2. **Importar un histórico no emite.** Ni el motor de migración ni
   `apps/api/src/migracion` alcanzan la emisión. El comprobante migrado queda
   `NO_CONSULTADO` y el CAE del archivo se guarda **como dato del origen**.
3. **Los ambientes no comparten un solo extremo.** Cinco servicios, cero
   coincidencias entre homologación y producción.
4. **Un `ARCA_ENVIRONMENT` inválido no cae a ninguno: tira.**
5. **La suite nunca habla con el organismo:** `setup-env.ts` fuerza `mock`.
6. **El candado de emisión rechaza los cuatro destinos torcidos**, incluido
   «ambiente de homologación con el WSAA de producción».
7. **El certificado no se filtra:** ni en la lista, ni en la bitácora, ni en el
   cuerpo de ninguna respuesta.
8. **Una empresa no ve la credencial de otra**, ni su pendiente de vencimiento.
9. **El vencimiento se ve con treinta días de anticipación.**

---

## 7. Qué NO quedó demostrado

- **Nada contra ARCA producción.** No se ejecutó ni una llamada. No hay
  certificado de producción y no se intentó obtener uno.
- **`ComprobanteConstatar` contra el servicio real.** Falta autorizar `wscdc` en
  WSASS: es un trámite aparte del de `wsfe`, que sí está hecho.
- **El extremo de producción de wsfev1**, contra documentación archivada.
- **Emisión de punta a punta**, en ningún ambiente desde la aplicación: no
  existe ese camino.

---

## 8. Dependencias externas

| | Estado |
|---|---|
| Certificado de homologación | ✅ Existe, fuera del repositorio |
| Autorización de `wsfe` en WSASS | ✅ Hecha (2026-08-27) |
| Autorización de `wscdc` en WSASS | 🟠 Pendiente — trámite del contribuyente |
| Certificado de **producción** | 🟠 No tramitado |
| Gestor de secretos por empresa | 🟠 Pendiente de B2.5.3 (depende del hosting) |

---

## 9–14. Certificado, WSAA, WSFE, CAE, QR, PDF

**Certificado.** Ciclo completo: se genera afuera, se carga por
`POST /companies/current/arca/credentials`, se valida que sea un X.509, se
envuelve con AES-256-GCM, se guarda con RLS, se revoca con motivo y queda en la
bitácora sin material. `envolver()` **y** `desenvolver()` se niegan los dos en
producción con la llave del entorno — comprobé que no hubiera asimetría.

**WSAA.** Verificado contra el organismo. Maneja desfase de reloj (60 s hacia
atrás en `generationTime`), expiración y caché en disco.

**WSFE / CAE / QR / PDF.** Implementados en `arca-emision` y **fuera del alcance
de la aplicación**. El PDF (`scripts/pdf-comprobante.mjs`) sale **sin QR y con la
leyenda impresa en su lugar** cuando el QR no se pudo armar: un comprobante
incompleto se nota, uno con un QR inventado se imprime igual.

---

## 15–20. Multiempresa, seguridad, idempotencia, reintentos, auditoría, históricos

**Multiempresa.** `company_id` recorre todo el camino: credencial → certificado →
autenticación → consulta → `arca_query_log`. Una sola credencial activa por
empresa **y ambiente**.

**Idempotencia y reintentos.** No aplica todavía a la emisión, porque no hay
emisión. Para la constatación —que es de lectura— reintentar es inocuo. **El día
que se decida emitir, esto es lo primero que hay que diseñar**: un timeout
después de mandar un comprobante no autoriza a reenviarlo, y hoy no existe
ninguna clave de idempotencia para eso.

**Auditoría.** Cada consulta deja fila en `arca_query_log` con empresa, ambiente,
servicio, operación, clave, resultado, motivo, duración y credencial usada. El
`CHECK tt_constatacion_arca_con_consulta` exige esa fila como prueba: sin
consulta registrada, no se puede escribir el resultado.

**Históricos.** Demostrado en §6.2.

---

## 21. Servicios: qué hace falta de verdad

| Servicio | Código | Tests | Homologación | ¿Producción? | Estado |
|---|---|---|---|---|---|
| WSAA | Sí | Sí | ✅ verificado | Sí, para todo | 🟢 |
| WSCDC | Sí | Sí | ⚠️ falta autorizar | Solo si se vende constatación | 🟡 |
| WSFE | Sí, aislado | Sí | No ejecutado | **Solo si se decide emitir** | 🟡 |
| Padrón A13/A100 | No | — | — | No | ⬜ P2 |
| WSASS | No, es un portal | — | — | Trámite manual | ⬜ |

**P0 (para vender lo que hoy existe):** WSAA + WSCDC.
**P1 (si se decide emitir):** WSFE, con idempotencia diseñada antes.
**P2:** padrón.

---

## 22. Riesgos

1. **Decidir emitir sin diseñar la idempotencia.** Es el riesgo grave: un
   reintento tras un timeout duplica una factura fiscal, y eso no se deshace.
2. **El extremo de producción de wsfev1 sin confirmar.**
3. **La ventana de renovación.** Una sola credencial activa por empresa+ambiente
   significa que renovar exige revocar primero: hay un hueco sin credencial.
4. **`ARCA_LOCAL_KEK` no sirve en producción** — y está bien que no sirva. Para
   ARCA producción multiempresa hace falta el gestor de B2.5.3.

---

## 23. Checklist para producción

**Antes que nada — la decisión:** ¿NEXO emite comprobantes fiscales? Si la
respuesta es no, esta fase está terminada y ARCA producción solo necesita el
certificado y la autorización de `wscdc`.

Si la respuesta es sí:

1. Diseñar la idempotencia de emisión **antes** de escribir una línea.
2. Quitar la regla `la-emision-no-llega-a-la-aplicacion` a sabiendas.
3. Confirmar el extremo de producción de wsfev1 contra el WSDL oficial y
   archivarlo con hash.
4. Tramitar el certificado de producción (`docs/api/arca-onboarding.md` §2).
5. Autorizar los servicios en WSASS.
6. Conectar el gestor de secretos por empresa (B2.5.3).
7. Cargar la credencial y comprobar `dias_restantes`.
8. **Smoke test**: un comprobante de menor importe, a un receptor propio,
   verificando CAE, vencimiento, QR y que la fila quede en `arca_query_log`.

---

## 24. Próximo paso exacto

**Contestar si NEXO emite o no.** Todo lo demás de esta fase depende de eso, y no
es una pregunta técnica.

---

## 25. Matriz final

| Área | Estado | Evidencia | Falta | Tipo |
|---|---|---|---|---|
| Ambiente | 🟢 | S-41: 5 servicios sin extremos compartidos; inválido tira | — | TEST |
| WSAA | 🟢 | Ticket real de homologación, 2026-08-27 | Nada para constatar | CODE |
| Certificado | 🟢 | Ciclo completo, AES-GCM, RLS, revocación auditada | El de producción | EXTERNAL |
| WSFE | 🟡 | `wsfev1.ts` con `FECAESolicitar` | Decisión de emitir | DECISION |
| CAE | 🟡 | En `arca-emision`, inalcanzable | Idem | DECISION |
| QR | 🟡 | `qr.ts`, spec archivada con hash | Idem | DECISION |
| PDF | 🟢 | Sin QR imprime la ausencia declarada | — | CODE |
| Puntos de venta | 🟡 | Por sucursal | Confirmar contra ARCA al emitir | EXTERNAL |
| Multiempresa | 🟢 | Aislamiento y pendiente por empresa | — | TEST |
| Secretos | 🟡 | Sobre local, se niega en producción | Gestor por empresa | EXTERNAL |
| Seguridad | 🟢 | Sin material en listas, logs ni bitácora | — | TEST |
| Idempotencia | 🔴 | No existe para emisión | Diseñarla **antes** de emitir | BLOCKER |
| Retry | 🟢 | Timeouts explícitos; no se reintenta lo que puede duplicar | — | CODE |
| Auditoría | 🟢 | `arca_query_log` + CHECK que la exige | — | CODE |
| Históricos | 🟢 | S-41: migración no alcanza la emisión | — | TEST |
| Producción real | 🔴 | **Cero llamadas ejecutadas** | Todo lo de §23 | EXTERNAL |
