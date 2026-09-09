/**
 * `certificadoDesdePem`: que la fecha de vencimiento salga del certificado.
 *
 * Este archivo existe por un error concreto. `scripts/arca-capabilities.mjs`
 * armaba el `CompanyCertificate` a mano y le faltaba `notAfter`; la primera
 * línea de `WsaaAuthenticator.login` es `certificate.notAfter.getTime()`, así
 * que reventaba antes de abrir el socket, y el relevamiento informó los cuatro
 * servicios de ARCA como NO_DELEGADO sin haber preguntado nada.
 *
 * El script era `.mjs`, así que `tsc` nunca miró ese objeto literal. La lección
 * no es «poné el campo»: es que **un dato que ya está firmado adentro del
 * certificado no se pasa por parámetro**.
 */

import forge from 'node-forge';
import { describe, expect, it } from 'vitest';
import { certificadoDesdePem } from './credentials.js';

interface Emitido {
  readonly certificatePem: string;
  readonly privateKeyPem: string;
  readonly notAfter: Date;
}

/** Un X.509 autofirmado. No sirve para hablar con ARCA; sirve para leerlo. */
function emitir(opciones: { readonly cuit?: string; readonly dias?: number } = {}): Emitido {
  const keys = forge.pki.rsa.generateKeyPair(2048);
  const cert = forge.pki.createCertificate();
  cert.publicKey = keys.publicKey;
  cert.serialNumber = '01';
  cert.validity.notBefore = new Date();
  cert.validity.notAfter = new Date(Date.now() + (opciones.dias ?? 365) * 86_400_000);

  const attrs: forge.pki.CertificateField[] = [{ name: 'commonName', value: 'aai-test' }];
  if (opciones.cuit !== undefined) {
    // ARCA pone el CUIT acá, con la forma `CUIT 20111111112`.
    attrs.push({ name: 'serialNumber', value: `CUIT ${opciones.cuit}` });
  }
  cert.setSubject(attrs);
  cert.setIssuer(attrs);
  cert.sign(keys.privateKey, forge.md.sha256.create());

  return {
    certificatePem: forge.pki.certificateToPem(cert),
    privateKeyPem: forge.pki.privateKeyToPem(keys.privateKey),
    notAfter: cert.validity.notAfter,
  };
}

const EMPRESA = '00000000-0000-7000-8000-000000000001';
const CUIT = '30710000001';

describe('certificadoDesdePem', () => {
  it('saca notAfter del certificado, que es donde está firmado', () => {
    const emitido = emitir();

    const certificado = certificadoDesdePem({
      companyId: EMPRESA,
      cuit: CUIT,
      certificatePem: emitido.certificatePem,
      privateKeyPem: emitido.privateKeyPem,
    });

    // Al segundo: el PEM guarda la fecha sin milisegundos.
    expect(Math.floor(certificado.notAfter.getTime() / 1000)).toBe(
      Math.floor(emitido.notAfter.getTime() / 1000),
    );
  });

  it('el resultado no le hace faltar nada a login', () => {
    // La comprobación literal del error que hubo: `login` empieza llamando a
    // `notAfter.getTime()`, y con el objeto armado a mano eso era un TypeError.
    const emitido = emitir();

    const certificado = certificadoDesdePem({
      companyId: EMPRESA,
      cuit: CUIT,
      certificatePem: emitido.certificatePem,
      privateKeyPem: emitido.privateKeyPem,
    });

    expect(() => certificado.notAfter.getTime()).not.toThrow();
    expect(Number.isNaN(certificado.notAfter.getTime())).toBe(false);
  });

  it('un certificado vencido se construye igual: quien decide es login', () => {
    // Deliberado. Esta función lee, no juzga: si además rechazara los vencidos,
    // el mensaje que ve el usuario sería «no es un PEM válido» en lugar de «hay
    // que renovarlo en el Administrador de Certificados Digitales».
    const emitido = emitir({ dias: -1 });

    const certificado = certificadoDesdePem({
      companyId: EMPRESA,
      cuit: CUIT,
      certificatePem: emitido.certificatePem,
      privateKeyPem: emitido.privateKeyPem,
    });

    expect(certificado.notAfter.getTime()).toBeLessThan(Date.now());
  });

  it('rechaza el certificado de otro contribuyente', () => {
    // Firmar un TRA con el certificado de otro CUIT lo rechaza WSAA, y ese
    // rechazo se lee igual que un servicio sin delegar. Es mejor no llegar.
    const emitido = emitir({ cuit: '20111111112' });

    expect(() =>
      certificadoDesdePem({
        companyId: EMPRESA,
        cuit: CUIT,
        certificatePem: emitido.certificatePem,
        privateKeyPem: emitido.privateKeyPem,
      }),
    ).toThrow(/20111111112.*30710000001|30710000001/s);
  });

  it('un certificado sin CUIT en el sujeto no se rechaza: no se puede afirmar de quién es', () => {
    // `null` significa «no se puede afirmar», no «no coincide». Un certificado
    // emitido por otra autoridad puede no traer el atributo.
    const emitido = emitir();

    expect(() =>
      certificadoDesdePem({
        companyId: EMPRESA,
        cuit: CUIT,
        certificatePem: emitido.certificatePem,
        privateKeyPem: emitido.privateKeyPem,
      }),
    ).not.toThrow();
  });

  it('un PEM que no es un certificado falla diciendo qué pasó', () => {
    expect(() =>
      certificadoDesdePem({
        companyId: EMPRESA,
        cuit: CUIT,
        certificatePem: 'esto no es un certificado',
        privateKeyPem: 'TEST_SECRET_ONLY',
      }),
    ).toThrow(/no es un X\.509 en PEM válido/);
  });
});
