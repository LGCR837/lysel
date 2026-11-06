import crypto from 'node:crypto';

export interface Envelope {
  iv: string;
  data: string;
  mac: string;
}

export function encryptEnvelope(plain: Buffer, encKey: Buffer, macKey: Buffer): string {
  const iv = crypto.randomBytes(16);
  const cipher = crypto.createCipheriv('aes-256-cbc', encKey, iv);
  const ciphertext = Buffer.concat([cipher.update(plain), cipher.final()]);
  const mac = crypto.createHmac('sha256', macKey).update(Buffer.concat([iv, ciphertext])).digest();
  const env: Envelope = {
    iv: iv.toString('base64'),
    data: ciphertext.toString('base64'),
    mac: mac.toString('base64'),
  };
  return JSON.stringify(env);
}

export function decryptEnvelope(payload: string, encKey: Buffer, macKey: Buffer): Buffer {
  const env = JSON.parse(payload) as Envelope;
  const iv = Buffer.from(env.iv, 'base64');
  const ciphertext = Buffer.from(env.data, 'base64');
  const mac = Buffer.from(env.mac, 'base64');
  const expect = crypto.createHmac('sha256', macKey).update(Buffer.concat([iv, ciphertext])).digest();
  if (mac.length !== expect.length || !crypto.timingSafeEqual(mac, expect)) {
    throw new Error('bad_mac');
  }
  const decipher = crypto.createDecipheriv('aes-256-cbc', encKey, iv);
  return Buffer.concat([decipher.update(ciphertext), decipher.final()]);
}
