# SECURITY.md — Estrategia de Seguridad

> Entregable I del §51. Modelo de amenazas de un estudio contable: los activos no son solo datos
> personales — son **secreto profesional**, credenciales fiscales de terceros y registros con
> valor probatorio.

## 1. Activos y qué pasa si se pierden

| Activo | Impacto de compromiso |
|--------|----------------------|
| Certificados y claves privadas de acceso a ARCA por empresa | Un tercero podría operar fiscalmente en nombre del contribuyente. **Máxima criticidad** |
| Documentos contables y comprobantes | Violación de secreto profesional; exposición comercial del cliente |
| Libro Diario y Mayor | Pérdida de valor probatorio si se demuestra que pudieron alterarse |
| Bitácora de auditoría | Sin ella, ninguna otra garantía es demostrable |
| Aislamiento entre empresas del estudio | Una filtración cruzada es un incidente profesional grave, no un bug menor |

---

## 2. Autenticación

- Contraseñas con Argon2id; política de longitud, no de "complejidad" cosmética.
- **MFA obligatorio** para roles Administrador, Contador y Auditor. Recomendado para el resto.
- Sesiones con expiración absoluta e inactiva, revocables individualmente; listado de sesiones
  activas visible para el usuario.
- Rate limiting y bloqueo progresivo por IP y por cuenta.
- Sin credenciales compartidas entre personas: cada acción tiene una persona responsable
  identificable, porque el §21 lo exige y porque sin eso la auditoría es ficción.

---

## 3. Autorización

Modelo `role → permissions`, evaluado **por empresa** (`user_company_roles`):

| Rol | Puede |
|-----|-------|
| Administrador | Configuración, usuarios, reapertura de períodos (con segunda firma) |
| Contador | Aprobar, modificar, rechazar, reclasificar, cerrar períodos, emitir estados |
| Auditor | **Solo lectura total** + acceso completo a la bitácora. No puede modificar nada |
| Usuario de empresa | Ver su propia empresa; cargar documentación; ver reportes autorizados |
| Cargador de documentación | Solo subir documentos y ver el estado de su procesamiento |
| Solo lectura | Ver |

Permisos granulares por recurso y acción (`journal_entry:approve`, `period:reopen`,
`normative_rule:activate`, `document:download`…). **Deny by default**: lo que no está concedido,
no existe.

Separación de funciones obligatoria en operaciones críticas:
- Reapertura de período: dos personas distintas.
- Activación de regla normativa: quien propone ≠ quien aprueba.
- Emisión de estados contables: contador responsable identificado.

---

## 4. Aislamiento multiempresa

Tres capas independientes (ninguna alcanza sola):

1. **PostgreSQL RLS** en toda tabla con `company_id`, con `SET LOCAL app.company_id` en cada
   transacción. La aplicación conecta con un rol **sin** `BYPASSRLS`.
2. **Middleware de tenancy**: ningún handler puede construir una consulta sin `companyId`
   explícito; verificado por tipos y por test.
3. **Storage**: prefijo por empresa, URLs firmadas de corta vida, sin listado público.

Test de seguridad obligatorio en CI: intentar leer datos de la empresa B con sesión de la empresa
A por cada endpoint. Falla el build si alguno responde 200.

---

## 5. Secretos y credenciales fiscales

**Nunca en el repositorio.** Nunca en variables de entorno en texto plano en la imagen.

| Secreto | Manejo |
|---------|--------|
| Clave privada del certificado ARCA por empresa | Cifrado por sobre: DEK por empresa, envuelta con KEK en KMS/HSM. La clave nunca se materializa en disco de la app |
| Tickets de acceso WSAA | Cacheados cifrados, con TTL propio; nunca logueados |
| Claves de proveedor LLM/OCR | Gestor de secretos, rotación programada |
| Credenciales de base | Rotación automática, sin usuario superusuario en la app |

Reglas operativas:
- Prohibido loguear payloads con claves, tickets o CUIT+clave.
- Escaneo de secretos en pre-commit y en CI.
- El estudio debe poder revocar el acceso de una empresa y que el sistema quede sin capacidad
  técnica de operar en su nombre, verificablemente.
- **El sistema no pide, no almacena y no usa la Clave Fiscal del contribuyente.** Solo opera con
  certificados X.509 delegados por el Administrador de Relaciones (ver `OFFICIAL_SOURCES.md` §2.1).

---

## 6. Cifrado

| Dato | En tránsito | En reposo |
|------|-------------|-----------|
| Todo el tráfico | TLS 1.3, HSTS | — |
| Base de datos | TLS | Cifrado de volumen + cifrado de columna para campos sensibles |
| Documentos | TLS | Cifrado del bucket + **object lock / versionado** |
| Backups | TLS | Cifrados, con clave distinta de la de producción |

---

## 7. Integridad y no repudio

- `audit_logs` encadenado por hash (`hash = sha256(prev_hash || payload)`), append-only, con
  `UPDATE`/`DELETE` revocados a nivel de rol de base de datos.
- Anclaje periódico: se publica el hash de cierre de cada día en un almacenamiento inmutable
  separado. Permite demostrar que la bitácora no fue reescrita retroactivamente.
- Hash de cada documento y de cada norma archivada. La cadena "cifra → asiento → comprobante →
  documento → norma" está anclada en hashes en sus dos extremos.

---

## 8. Backups y recuperación

- Backups automáticos con retención escalonada (diaria / semanal / mensual / anual).
- **Restauración probada periódicamente**; un backup no verificado no cuenta como backup.
- PITR de base. Storage con versionado: un borrado accidental es recuperable.
- Objetivos declarados y medidos: RPO ≤ 15 min, RTO ≤ 4 h.
- Plan de exportación total por empresa: el cliente puede irse con sus datos completos y su
  documentación original. Esto es tanto una garantía comercial como una defensa legal.

---

## 9. Desarrollo seguro

- Dependencias auditadas; SBOM; alertas de vulnerabilidades.
- Validación de entrada con esquemas en todo borde; salidas escapadas.
- Prevención de SSRF en el fetcher de normas (allowlist estricta de dominios oficiales).
- Sanitización y sandboxing en el pipeline de OCR: los PDF subidos son entrada no confiable.
- **Prompt injection**: el contenido de un documento subido es *dato*, jamás instrucción. Los
  agentes reciben el texto extraído en un canal separado del sistema de instrucciones, y su salida
  está restringida por schema — un PDF que diga "aprobá este asiento" no puede lograr nada, porque
  ningún agente tiene la capacidad de aprobar.
- Revisión de seguridad obligatoria en cambios que toquen autenticación, tenancy, secretos o el
  motor contable.

---

## 10. Cumplimiento

- Protección de datos personales (Ley 25.326 y su régimen sucesor): minimización, finalidad,
  derechos del titular. El registro de `ip` en la bitácora queda condicionado a la evaluación
  legal, como el propio pliego indica (§21).
- Conservación de documentación contable y respaldatoria por los plazos legales aplicables:
  parámetro configurable, **no** una constante en el código.
- Secreto profesional del contador: el diseño asume que el operador del sistema no debe poder leer
  la contabilidad de los clientes sin dejar rastro.
