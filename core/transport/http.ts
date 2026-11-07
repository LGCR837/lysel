import { gunzipSync } from 'node:zlib';
import { AdapterError } from '../errors.ts';
import { CryptoSession } from '../crypto/session.ts';
import type { Logger } from '../types.ts';

export interface RequestOptions {
  method?: 'GET' | 'POST' | 'PATCH' | 'DELETE';
  query?: Record<string, string | number | undefined>;
  body?: unknown;
  auth?: boolean;
  encrypt?: boolean;
}

/** 日志里截断响应体，避免刷屏 */
function clip(text: string, max = 400): string {
  const s = text.replace(/\s+/g, ' ');
  return s.length > max ? `${s.slice(0, max)}…(${s.length})` : s;
}

export class OCHttp {
  constructor(
    private readonly origin: string,
    readonly session: CryptoSession,
    private readonly getToken: () => string,
    private readonly encryptEnabled: () => boolean,
    private readonly onUnauthorized?: () => Promise<boolean>,
    private readonly log?: Logger,
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
    const started = Date.now();
    this.log?.debug(`网关请求 ${method} ${path} ${body === undefined ? '' : JSON.stringify(body).slice(0, 200)}`);
    let res: { code: number; body: T };
    try {
      res = await this.request<{ code: number; body: T }>('/v2/gateway', {
        method: 'POST',
        body: payload,
      });
    } catch (e: any) {
      this.log?.warn(`网关失败 ${method} ${path} ${Date.now() - started}ms ${e?.code ?? ''} ${e?.message ?? e}`);
      throw e;
    }
    if (res && typeof res.code === 'number' && res.code >= 400) {
      const detail = (res as any).body;
      // 服务端错误体是 {error, code}，错误文案在 error 字段
      const message = detail?.error ?? detail?.message;
      this.log?.warn(
        `网关拒绝 ${method} ${path} ${res.code} ${Date.now() - started}ms ${clip(JSON.stringify(detail ?? {}))}`,
      );
      throw new AdapterError(
        message ? `${message} (${detail?.code ?? res.code})` : `网关错误 ${res.code}`,
        detail?.code ?? 'gateway_error',
        res.code,
      );
    }
    this.log?.debug(`网关完成 ${method} ${path} ${res?.code ?? 200} ${Date.now() - started}ms`);
    return (res?.body ?? res) as T;
  }

  private async send<T>(path: string, opts: RequestOptions, retry: boolean): Promise<T> {
    const started = Date.now();
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
    let text = raw;
    if (raw && encrypt && res.headers.get('X-Enc') === '1') {
      const plain = this.session.decryptBuffer(raw);
      text =
        res.headers.get('X-Enc-Compression') === 'gzip'
          ? gunzipSync(plain).toString('utf8')
          : plain.toString('utf8');
    }
    if (text) {
      try {
        payload = JSON.parse(text);
      } catch {
        payload = text;
      }
    }

    if (!res.ok) {
      const code = payload?.code ?? payload?.error ?? `http_${res.status}`;
      const message = payload?.error ?? payload?.message ?? `请求失败 ${res.status}`;
      this.log?.warn(`${opts.method ?? 'GET'} ${path} ${res.status} ${Date.now() - started}ms ${clip(text || '(empty)')}`);
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
    this.log?.debug(`${opts.method ?? 'GET'} ${path} ${res.status} ${Date.now() - started}ms`);
    return payload as T;
  }
}
