import crypto from 'node:crypto';
import type { webcrypto } from 'node:crypto';

const subtle = globalThis.crypto.subtle;

type CryptoKeyPair = webcrypto.CryptoKeyPair;
type CryptoKey = webcrypto.CryptoKey;

export interface HandshakeKeys {
  encKey: Buffer;
  macKey: Buffer;
}

export async function createClientKeyPair(): Promise<{ pair: CryptoKeyPair; publicKeyB64: string }> {
  const pair = (await subtle.generateKey({ name: 'ECDH', namedCurve: 'P-256' }, true, [
    'deriveBits',
  ])) as CryptoKeyPair;
  const spki = new Uint8Array(await subtle.exportKey('spki', pair.publicKey));
  return { pair, publicKeyB64: Buffer.from(spki).toString('base64') };
}

export async function deriveSharedSecret(pair: CryptoKeyPair, serverPubB64: string): Promise<Buffer> {
  const raw = Buffer.from(serverPubB64, 'base64');
  const serverKey = await subtle.importKey('spki', raw, { name: 'ECDH', namedCurve: 'P-256' }, false, []);
  const bits = await subtle.deriveBits({ name: 'ECDH', public: serverKey }, pair.privateKey, 256);
  return Buffer.from(bits);
}

export function deriveSessionKeys(secret: Buffer): HandshakeKeys {
  const encKey = crypto.createHash('sha256').update(Buffer.concat([secret, Buffer.from('enc')])).digest();
  const macKey = crypto.createHash('sha256').update(Buffer.concat([secret, Buffer.from('mac')])).digest();
  return { encKey, macKey };
}
