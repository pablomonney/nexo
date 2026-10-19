/**
 * Qué entra y qué NO entra en la exportación completa de una empresa — y por qué.
 *
 * ## El principio
 *
 * Se exporta **todo lo que es de la empresa**: cada tabla con `company_id`, descubierta del esquema y no de una lista
 * escrita a mano. Una lista a mano se desactualiza con la primera migración, y una exportación que «se olvida» de una
 * tabla nueva es peor que no tenerla: la empresa se lleva un archivo que cree completo.
 *
 * Lo que sí es una lista escrita a mano es lo que **no** sale, porque ahí la decisión es de seguridad y tiene que ser
 * explícita y revisable:
 *
 *   · Material de credenciales: claves privadas cifradas, tokens de integraciones, referencias a secretos. La empresa se
 *     lleva sus datos, no la forma de operar en su nombre ante ARCA o un proveedor; eso se vuelve a declarar.
 *   · Lo que no es de la empresa: contraseñas, segundos factores, sesiones y códigos de recuperación de los usuarios
 *     (identidad del estudio, no de la empresa). De los usuarios sale quiénes son y qué rol tienen, nada más.
 *
 * ## El guardián
 *
 * `COLUMNAS_SEGURAS` y `COLUMNAS_EXCLUIDAS` existen para una prueba (`tests/security/exportacion-columnas.test.ts`): toda
 * columna cuyo nombre *parezca* sensible (`PATRON_SENSIBLE`) tiene que estar en una de las dos listas. Una columna nueva
 * llamada `api_token` rompe la suite hasta que alguien decida si se exporta o no. Sin esto, la omisión sería silenciosa.
 */

/** Tablas con `company_id` que no se exportan, con el motivo (sale en el manifiesto). */
export const TABLAS_EXCLUIDAS: Readonly<Record<string, string>> = {
  secret_refs:
    'Referencias a secretos del servidor (dónde está una credencial). No son datos de la empresa y no se entregan.',
};

/** Columnas que se sacan de una tabla que sí se exporta, con el motivo. */
export const COLUMNAS_EXCLUIDAS: Readonly<Record<string, Readonly<Record<string, string>>>> = {
  company_arca_credentials: {
    private_key_encrypted: 'Clave privada del certificado de ARCA (cifrada). Se vuelve a declarar, no se entrega.',
    key_encryption_ref: 'Referencia a la clave de cifrado de la credencial.',
  },
  company_integrations: {
    access_token_encrypted: 'Token de acceso de la integración (cifrado). Se vuelve a conectar, no se entrega.',
    refresh_token_encrypted: 'Token de renovación de la integración (cifrado).',
    key_encryption_ref: 'Referencia a la clave de cifrado de la integración.',
  },
};

/** Un nombre de columna que *parece* sensible. Falsos positivos a propósito: la prueba pide decidir. */
export const PATRON_SENSIBLE = /(password|passwd|secret|token|private|hash|key|credential|totp|mfa|otp|recovery|signature)/iu;

/**
 * Columnas que coinciden con el patrón y se exportan, cada una con **por qué es seguro**.
 * Clave: `tabla.columna`, o `*.columna` para cualquier tabla.
 */
export const COLUMNAS_SEGURAS: Readonly<Record<string, string>> = {
  '*.prompt_hash': 'Huella (sha256) del texto de un prompt archivado: no es un secreto.',
  '*.idempotency_key': 'Clave de idempotencia de una operación: la genera el cliente para no repetirla; no autentica nada.',
  '*.request_hash': 'Huella de un pedido, para detectar repeticiones.',
  '*.request_key': 'Identificador de un pedido registrado.',
  '*.storage_key': 'Ruta interna del archivo adjunto; el archivo en sí sale en `archivos/`.',
  '*.credential_id': 'Identificador (uuid) de una credencial; no es la credencial.',
  '*.rule_key': 'Clave de negocio de una regla contable.',
  '*.blocks_rule_key': 'Clave de negocio de una regla contable.',
  '*.token_vencido': 'Indicador (sí/no) de que un token venció; no es el token.',
  '*.token_expires_at': 'Fecha de vencimiento de un token; no es el token.',
  '*.tokens_entrada': 'Cantidad de tokens de entrada de un modelo de lenguaje (consumo), no una credencial.',
  '*.tokens_salida': 'Cantidad de tokens de salida de un modelo de lenguaje (consumo), no una credencial.',
  '*.tokens_por_dia': 'Tope diario de tokens de un modelo de lenguaje que la empresa declaró (cupo de uso), no una credencial.',
  'audit_logs.hash': 'Eslabón de la cadena de auditoría: es lo que permite verificar la bitácora afuera.',
  'audit_logs.prev_hash': 'Eslabón anterior de la cadena de auditoría.',
  'migration_batches.hash': 'Huella de un lote migrado.',
  'migration_rows.hash': 'Huella de una fila migrada.',
  'migrations.archivo_hash': 'Huella del archivo que se migró.',
  'system_settings.key': 'Nombre de un parámetro de configuración.',
};

/** Tablas del esquema que NUNCA se leen como catálogo: son identidad o secretos, aunque una FK las apunte. */
export const NO_ES_CATALOGO: ReadonlySet<string> = new Set([
  'users',
  'sessions',
  'mfa_recovery_codes',
  'email_verifications',
  'email_outbox',
  'companies',
  'organizations',
  'organization_members',
  'schema_migrations',
]);

/** Un catálogo más grande que esto no se copia entero (se informa en el manifiesto). */
export const MAX_FILAS_DE_CATALOGO = 100_000;

export function columnaEsSegura(tabla: string, columna: string): boolean {
  return `${tabla}.${columna}` in COLUMNAS_SEGURAS || `*.${columna}` in COLUMNAS_SEGURAS;
}
