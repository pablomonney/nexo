# apps/api

BFF sobre Fastify: autenticación, tenancy, autorización y orquestación.

## Cómo se protege cada petición

```
onRequest
  └─ attachContext        carga la sesión desde cookie o Bearer, si la hay
handler
  ├─ requireAuth          exige sesión válida y MFA satisfecho
  ├─ requireCompany       resuelve X-Company-Id y verifica rol vigente
  ├─ requirePermission    deny by default sobre 26 permisos granulares
  └─ withCompany(...)     acceso a datos con RLS y app.company_id fijados
```

`@aai/db` no exporta el pool ni un cliente crudo: la única forma de consultar es dentro de
`withCompany` o `withoutCompany`, que ya hicieron `SET LOCAL ROLE aai_app` y fijaron el contexto.
Un olvido no produce una fuga — produce cero filas.

## Endpoints

### Sesión

| Método | Ruta | Notas |
|--------|------|-------|
| POST | `/auth/login` | Argon2id. Email inexistente y contraseña incorrecta responden idéntico |
| POST | `/auth/logout` | Revoca la sesión |
| GET | `/auth/me` | Usuario y empresas a las que tiene acceso |
| POST | `/auth/mfa/setup` | Devuelve secreto, URI para el QR y 10 códigos de recuperación. Única vez que salen en claro |
| POST | `/auth/mfa/confirm` | Habilita el segundo factor |
| POST | `/auth/mfa/verify` | Satisface el segundo factor en la sesión. Acepta TOTP o código de recuperación |
| POST | `/auth/register-first-admin` | Solo con la base vacía |

### Estudio

| Método | Ruta | Autorización |
|--------|------|--------------|
| POST | `/organizations` | Sesión válida; el creador queda OWNER |
| GET | `/organizations` | Solo los estudios propios |
| POST | `/organizations/:id/companies` | OWNER o ADMIN del estudio |
| POST | `/organizations/:id/users` | OWNER o ADMIN del estudio |
| POST | `/companies/:id/roles` | OWNER/ADMIN del estudio, o ADMINISTRADOR de esa empresa |

### Empresa activa — requieren `X-Company-Id`

| Método | Ruta | Permiso |
|--------|------|---------|
| GET | `/companies/current` | `company:read` |
| POST | `/companies/current/reporting-framework` | `company:write` |
| GET | `/companies/current/users` | `user:read` |
| GET | `/accounts` | `account:read` |
| POST | `/accounts` | `account:write` |
| PATCH | `/accounts/:id` | `account:write` — exige motivo, queda en la bitácora |
| GET | `/cost-centers` | `cost_center:read` |
| POST | `/cost-centers` | `cost_center:write` |
| GET | `/fiscal-years` | `period:read` |
| POST | `/fiscal-years` | `period:write` — genera los períodos mensuales |
| GET | `/periods` | `period:read` |
| POST | `/periods/:id/close` | `period:close` — bloquea si quedan asientos sin aprobar |
| POST | `/periods/:id/reopen` | `period:reopen` — exige motivo y segundo firmante distinto |
| GET | `/normative/gaps` | `rule:read` — los huecos normativos declarados |

### Salud

`GET /health` y `GET /health/db`.

## Decisiones que no son obvias

**El id de empresa viaja en la cabecera, nunca en el cuerpo.** Si viniera en el payload, cada
handler tendría que acordarse de validarlo. Así hay un solo lugar donde se resuelve.

**Empresa ajena y empresa inexistente responden igual.** Distinguirlas convertiría el endpoint en
un oráculo para enumerar la cartera de clientes del estudio.

**El Administrador no puede aprobar asientos.** No es un olvido en la matriz de permisos:
administrar el sistema y aprobar contabilidad son responsabilidades distintas, y la segunda es del
profesional matriculado (§42).

**MFA es condición de acceso, no preferencia.** Un usuario con rol Administrador, Contador o
Auditor que no lo configuró recibe `MFA_SETUP_REQUIRED` al intentar entrar a una empresa, aunque su
contraseña sea correcta.

**Los errores internos nunca se filtran al cliente.** Un mensaje de PostgreSQL puede revelar
nombres de tablas, constraints y hasta datos de la fila que falló.

## Ejecutar

```bash
npm run db:setup
node apps/api/dist/index.js
```
