/**
 * Las credenciales de ARCA, leídas de la base y descifradas por el tiempo
 * mínimo necesario para firmar.
 *
 * `packages/arca` define `CredentialStore` como puerto y trae un
 * `NullCredentialStore` que devuelve `null` siempre. Esto es la implementación
 * que faltaba: la que lee `company_arca_credentials`.
 *
 * ## Por qué está en `apps/api` y no en `packages/arca`
 *
 * Porque toca la base, y `packages/arca` no puede: el lint de arquitectura
 * (`dominio-sin-io`) se lo impide, y con razón. El paquete define el contrato y
 * habla SOAP; quién guarda el certificado y con qué llave es una decisión de la
 * aplicación, no del cliente del organismo.
 *
 * ## Lo que este archivo NO hace, a propósito
 *
 * - **No escribe.** Cargar un certificado es otro acto, con otro permiso
 *   (`arca_credential:manage`) y otra ruta.
 * - **No cachea el material descifrado.** La clave privada se descifra por
 *   llamada y se descarta. Un caché la dejaría en memoria del proceso por tiempo
 *   indefinido, que es exactamente lo que SECURITY.md §5 pide evitar.
 * - **No decide si sirve.** Devolver un certificado vencido y que el cliente
 *   falle sería peor que no devolverlo: acá se filtra por vigencia y estado, y
 *   una empresa sin credencial válida obtiene `null` — que el cliente SOAP
 *   traduce a `NO_VERIFICABLE / SIN_CREDENCIAL`, visible y honesto.
 *
 * ## El sobre
 *
 * `private_key_encrypted` guarda la clave envuelta; `key_encryption_ref` dice
 * **con qué** se envolvió. Hoy hay una sola implementación de desenvoltura —la
 * local, con la llave del entorno— y se niega a correr en producción: una KEK
 * en una variable de entorno no es un KMS, y hacer como si lo fuera sería la
 * clase de atajo que este repositorio no toma. Ver `desenvolver()`.
 */

import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto';
import type { CompanyCertificate, CredentialStore } from '@aai/arca';
import { withCompany, type Tx } from '@aai/db';
import { config } from '../config.js';

/** Lo que la base devuelve. `private_key_encrypted` nunca sale de este módulo. */
interface FilaDeCredencial {
  id: string;
  cuit: string;
  certificate_pem: string;
  private_key_encrypted: string;
  key_encryption_ref: string;
  not_after: Date;
}

/**
 * El certificado, más el id de la fila que lo aportó.
 *
 * El id no es decorativo: `arca_query_log.credential_id` lo necesita para poder
 * responder «¿qué consultas firmó este certificado?» cuando haya que acotar el
 * alcance de uno comprometido (0044).
 */
export interface CertificadoConProcedencia extends CompanyCertificate {
  readonly credentialId: string;
}

export class DbCredentialStore implements CredentialStore {
  /** El último certificado entregado, para que la ruta pueda registrar cuál usó. */
  #ultimo: CertificadoConProcedencia | null = null;

  constructor(private readonly actorId: string) {}

  async getCertificate(companyId: string): Promise<CompanyCertificate | null> {
    const certificado = await this.leer(companyId);
    this.#ultimo = certificado;
    return certificado;
  }

  /**
   * Con qué credencial se resolvió la última llamada, o `null` si no hubo.
   *
   * Es lo que permite que el log diga con qué se firmó sin que la ruta tenga que
   * volver a consultar la tabla ni —peor— pasarse el material de la clave.
   */
  get ultimaCredencialUsada(): string | null {
    return this.#ultimo?.credentialId ?? null;
  }

  private async leer(companyId: string): Promise<CertificadoConProcedencia | null> {
    return withCompany({ companyId, actorId: this.actorId }, async (tx: Tx) => {
      // Vigente **y** del ambiente en el que se está operando. Un certificado de
      // homologación no sirve para producción y al revés: mezclarlos produciría
      // validaciones fiscales de mentira informadas como reales.
      const fila = await tx.query<FilaDeCredencial>(
        `SELECT id, cuit, certificate_pem, private_key_encrypted, key_encryption_ref, not_after
           FROM company_arca_credentials
          WHERE company_id = $1
            AND environment = $2
            AND status = 'ACTIVE'
            AND now() BETWEEN not_before AND not_after
          ORDER BY not_after DESC
          LIMIT 1`,
        [companyId, config.arca.environment],
      );

      if (fila.rowCount === 0) return null;
      const c = fila.rows[0]!;

      return {
        credentialId: c.id,
        companyId,
        cuit: c.cuit,
        certificatePem: c.certificate_pem,
        privateKeyPem: desenvolver(c.private_key_encrypted, c.key_encryption_ref),
        notAfter: c.not_after,
      };
    });
  }
}

/**
 * Desenvuelve la clave privada.
 *
 * El prefijo de `key_encryption_ref` dice quién la envolvió, y es lo que permite
 * rotar el esquema sin adivinar cómo se cifró cada fila —mismo criterio que el
 * `v1.` de `encryptSecret`—.
 *
 *   `local:<id>`  la llave del entorno. Desarrollo y homologación.
 *   `kms:<arn>`   un KMS de verdad. **Todavía no existe.**
 *
 * Se niega en producción con la referencia local. No es cautela decorativa: una
 * KEK en una variable de entorno vive en el mismo lugar que el ciphertext, así
 * que envolver con ella protege contra un volcado de la base y contra nada más.
 * Decir que eso es un sobre KMS sería exactamente la clase de afirmación que
 * este sistema no hace.
 */
export function desenvolver(envuelta: string, referencia: string): string {
  if (referencia.startsWith('kms:')) {
    throw new Error(
      `La credencial está envuelta con ${referencia} y no hay cliente de KMS configurado. ` +
        'Configurarlo es lo que falta para operar en producción; ver docs/api/arca-onboarding.md.',
    );
  }

  if (!referencia.startsWith('local:')) {
    throw new Error(`Referencia de envoltura desconocida: ${referencia}`);
  }

  if (config.isProduction) {
    throw new Error(
      'Una credencial envuelta localmente no se desenvuelve en producción. La llave del ' +
        'entorno vive en el mismo lugar que el dato cifrado: no es un sobre, es una formalidad.',
    );
  }

  const [version, ivPart, tagPart, ctPart] = envuelta.split('.');
  if (version !== 'v1' || ivPart === undefined || tagPart === undefined || ctPart === undefined) {
    throw new Error('Formato de clave envuelta desconocido');
  }

  const decipher = createDecipheriv(
    'aes-256-gcm',
    config.arca.localKeyEncryptionKey,
    Buffer.from(ivPart, 'base64url'),
  );
  decipher.setAuthTag(Buffer.from(tagPart, 'base64url'));
  return Buffer.concat([
    decipher.update(Buffer.from(ctPart, 'base64url')),
    decipher.final(),
  ]).toString('utf8');
}

/**
 * Las capacidades habilitadas por empresa y ambiente.
 *
 * Es el otro puerto que `packages/arca` define y que nadie implementaba contra
 * la base. Importa para el §33: `wscdc` puede estar sin autorizar en WSASS, y
 * entonces la respuesta correcta es `SERVICIO_NO_HABILITADO` —no un error de
 * red, no un rechazo del comprobante—.
 *
 * Sin fila, **no habilitado**. Falla cerrado: preferimos informar que no se pudo
 * preguntar antes que preguntar y que el organismo rechace por falta de permiso,
 * que se parece demasiado a un comprobante inválido.
 */
export class DbCapabilityStore {
  constructor(private readonly actorId: string) {}

  async isEnabled(companyId: string, service: string): Promise<boolean> {
    return withCompany({ companyId, actorId: this.actorId }, async (tx: Tx) => {
      const fila = await tx.query<{ enabled: boolean }>(
        `SELECT enabled FROM company_arca_capabilities
          WHERE company_id = $1 AND environment = $2 AND service = $3`,
        [companyId, config.arca.environment, service],
      );
      return fila.rows[0]?.enabled ?? false;
    });
  }
}

/**
 * Envuelve la clave privada para guardarla.
 *
 * Devuelve el par `(envuelta, referencia)`: la referencia dice con qué se
 * envolvió, y es lo que después decide cómo abrirla. Formato `v1.<iv>.<tag>.<ct>`
 * con AES-256-GCM y nonce por registro, igual que `encryptSecret`.
 *
 * Se niega en producción por lo mismo que `desenvolver()`: guardar con una llave
 * de entorno y llamarlo sobre KMS sería afirmar una protección que no existe.
 */
export function envolver(clavePem: string): { envuelta: string; referencia: string } {
  if (config.isProduction) {
    throw new Error(
      'No hay cliente de KMS configurado y en producción no se envuelve con la llave del ' +
        'entorno. Ver docs/api/arca-onboarding.md.',
    );
  }

  const iv = randomBytes(12);
  const cipher = createCipheriv('aes-256-gcm', config.arca.localKeyEncryptionKey, iv);
  const ct = Buffer.concat([cipher.update(clavePem, 'utf8'), cipher.final()]);
  const tag = cipher.getAuthTag();

  return {
    envuelta: `v1.${iv.toString('base64url')}.${tag.toString('base64url')}.${ct.toString('base64url')}`,
    referencia: 'local:dev',
  };
}
