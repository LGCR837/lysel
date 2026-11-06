import { AdapterError } from '../errors.ts';
import { CryptoSession } from '../crypto/session.ts';

export interface RequestOptions {
  method?: 'GET' | 'POST' | 'PATCH' | 'DELETE';
  query?: Record<string, string | number | undefined>;
  body?: unknown;
  auth?: boolean;
  encrypt?: boolean;
}

export class OCHttp {
  constructor(
    private readonly origin: string,
    readonly session: CryptoSession,
    private readonly getToken: () => string,
    private readonly encryptEnabled: () => boolean,
    private readonly onUnauthorized?: () => Promise<boolean>,
  ) {}

  async request<T = any>(path: string, opts: RequestOptions = {}): Promise<T> {
    return this.send<T>(path, opts, true);
  }

  async gateway<T = any>(
    method: string,
    path: string,
    body?: unknown,
    query?: Record<string, string | number | undefined>,
  ): Promise<T> {
    const payload: Record<string, unknown> = { m: method, p: path };
    if (query) payload.q = new URLSearchParams(query as Record<string, string>).toString();
    if (body !== undefined) payload.b = body;
    const res = await this.request<{ code: number; body: T }>('/v2/gateway', {
      method: 'POST',
      body: payload,
    });
    if (res && typeof res.code === 'number' && res.code >= 400) {
      const detail = (res as any).body;
      throw new AdapterError(
        detail?.message ?? `网关错误 ${res.code}`,
        detail?.error ?? 'gateway_error',
        res.code,
      );
    }
    return (res?.body ?? res) as T;
  }

  private async send<T>(path: string, opts: RequestOptions, retry: boolean): Promise<T> {
    const url = new URL(path, this.origin);
    if (opts.query) {
      for (const [k, v] of Object.entries(opts.query)) {
        if (v !== undefined) url.searchParams.set(k, String(v));
      }
    }

    const headers: Record<string, string> = { 'Content-Type': 'application/json' };
    const encrypt = opts.encrypt ?? this.encryptEnabled();
    let bodyText: string | undefined;

    if (encrypt) {
      await this.session.ensure();
      headers['X-Enc'] = '1';
      headers['X-Session'] = this.session.id;
      const token = this.getToken();
      if (opts.auth !== false && token) headers['X-Auth'] = this.session.encrypt(`Bearer ${token}`);
      if (opts.body !== undefined) bodyText = this.session.encrypt(JSON.stringify(opts.body));
    } else {
      const token = this.getToken();
      if (opts.auth !== false && token) headers.Authorization = `Bearer ${token}`;
      if (opts.body !== undefined) bodyText = JSON.stringify(opts.body);
    }

    const res = await fetch(url, {
      method: opts.method ?? 'GET',
      headers,
      body: bodyText,
    });

    let payload: any = null;
    const raw = await res.text();
    if (raw) {
      try {
        payload = JSON.parse(raw);
      } catch {
        payload = raw;
      }
    }

    if (!res.ok) {
      const code = payload?.code ?? payload?.error ?? `http_${res.status}`;
      const message = payload?.message ?? `请求失败 ${res.status}`;
      if (retry && (res.status === 401 || code === 'invalid_session')) {
        if (res.status === 401 && this.onUnauthorized) {
          const renewed = await this.onUnauthorized().catch(() => false);
          if (renewed) return this.send<T>(path, opts, false);
        }
        if (encrypt) {
          this.session.reset();
          return this.send<T>(path, opts, false);
        }
      }
      throw new AdapterError(message, String(code), res.status);
    }
    return payload as T;
  }
}
