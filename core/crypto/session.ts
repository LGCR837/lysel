import { AdapterError } from '../errors.ts';
import { createClientKeyPair, deriveSessionKeys, deriveSharedSecret } from './handshake.ts';
import { decryptEnvelope, encryptEnvelope } from './envelope.ts';

interface HandshakeResponse {
  session_id: string;
  server_pub: string;
}

export class CryptoSession {
  private sid = '';
  private encKey: Buffer | null = null;
  private macKey: Buffer | null = null;
  private pending: Promise<void> | null = null;

  constructor(private readonly origin: string) {}

  get id(): string {
    return this.sid;
  }

  get ready(): boolean {
    return this.sid !== '' && this.encKey !== null;
  }

  async ensure(): Promise<void> {
    if (this.ready) return;
    if (!this.pending) this.pending = this.establish();
    try {
      await this.pending;
    } finally {
      this.pending = null;
    }
  }

  reset(): void {
    this.sid = '';
    this.encKey = null;
    this.macKey = null;
  }

  encrypt(text: string): string {
    if (!this.encKey || !this.macKey) throw new AdapterError('会话未建立', 'no_session');
    return encryptEnvelope(Buffer.from(text, 'utf8'), this.encKey, this.macKey);
  }

  decrypt(payload: string): string {
    if (!this.encKey || !this.macKey) throw new AdapterError('会话未建立', 'no_session');
    return decryptEnvelope(payload, this.encKey, this.macKey).toString('utf8');
  }

  private async establish(): Promise<void> {
    const { pair, publicKeyB64 } = await createClientKeyPair();
    const res = await fetch(`${this.origin}/v1/auth/handshake`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ client_pub: publicKeyB64 }),
    });
    if (!res.ok) throw new AdapterError(`握手失败 ${res.status}`, 'handshake_failed', res.status);
    const data = (await res.json()) as HandshakeResponse;
    const secret = await deriveSharedSecret(pair, data.server_pub);
    const keys = deriveSessionKeys(secret);
    this.encKey = keys.encKey;
    this.macKey = keys.macKey;
    this.sid = data.session_id;
  }
}
