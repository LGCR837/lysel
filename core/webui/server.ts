import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { createLogger, getLogs } from '../log.ts';

const log = createLogger('webui');
const WEBUI_DIR = path.dirname(fileURLToPath(import.meta.url));
const BODY_LIMIT = 262144;
const COOKIE_NAME = 'lysel_auth';

export interface WebUiDeps {
  status: () => unknown;
  config: () => unknown;
  toggle: (accountId: string, name: string, enabled: boolean) => Promise<boolean>;
  saveGlobal: (patch: Record<string, unknown>) => boolean;
  saveAccount: (config: any) => Promise<boolean>;
  accountState: (id: string, running: boolean) => Promise<boolean>;
  pluginConfig: (accountId: string, name: string) => unknown;
  savePluginConfig: (accountId: string, name: string, config: Record<string, unknown>) => Promise<boolean>;
  checkKey: (key: string | undefined) => boolean;
  consoleKey: () => string;
}

const pages: Record<string, { file: string; type: string }> = {
  '/webui.css': { file: 'webui.css', type: 'text/css; charset=utf-8' },
  '/webui.js': { file: 'webui.js', type: 'text/javascript; charset=utf-8' },
  '/scrollbar.js': { file: 'scrollbar.js', type: 'text/javascript; charset=utf-8' },
};

function send(res: http.ServerResponse, code: number, body: string | Buffer, type: string): void {
  res.writeHead(code, { 'Content-Type': type, 'Cache-Control': 'no-store' });
  res.end(body);
}

function sendJson(res: http.ServerResponse, data: unknown, code = 200): void {
  send(res, code, JSON.stringify(data), 'application/json; charset=utf-8');
}

function readBody(req: http.IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    let raw = '';
    let done = false;
    req.on('data', (chunk) => {
      if (done) return;
      raw += chunk;
      if (raw.length > BODY_LIMIT) {
        done = true;
        reject(new Error('请求体过大'));
      }
    });
    req.on('end', () => {
      if (!done) resolve(raw);
    });
    req.on('error', (e) => {
      if (!done) reject(e);
    });
  });
}

async function jsonBody(req: http.IncomingMessage): Promise<Record<string, any>> {
  const raw = (await readBody(req)).trim();
  if (!raw) return {};
  const parsed = JSON.parse(raw);
  if (!parsed || typeof parsed !== 'object') throw new Error('请求体格式错误');
  return parsed;
}

function readCookie(req: http.IncomingMessage, name: string): string {
  const raw = req.headers.cookie ?? '';
  for (const part of raw.split(';')) {
    const [key, ...rest] = part.trim().split('=');
    if (key === name) return rest.join('=');
  }
  return '';
}

function keyHash(key: string): string {
  return crypto.createHash('sha256').update(key).digest('hex');
}

function serveAsset(res: http.ServerResponse, name: string): void {
  const file = path.join(WEBUI_DIR, 'assets', path.basename(name));
  if (!fs.existsSync(file)) {
    send(res, 404, 'not found', 'text/plain; charset=utf-8');
    return;
  }
  const type = file.endsWith('.webp')
    ? 'image/webp'
    : file.endsWith('.png')
      ? 'image/png'
      : file.endsWith('.jpg') || file.endsWith('.jpeg')
        ? 'image/jpeg'
        : 'application/octet-stream';
  send(res, 200, fs.readFileSync(file), type);
}

export function startWebUi(host: string, port: number, deps: WebUiDeps): http.Server {
  const page = (name: string): string => fs.readFileSync(path.join(WEBUI_DIR, name), 'utf8');

  const authed = (req: http.IncomingMessage): boolean => {
    const expected = deps.consoleKey();
    if (!expected) return true;
    if (deps.checkKey(req.headers['x-console-key'] as string | undefined)) return true;
    return readCookie(req, COOKIE_NAME) === keyHash(expected);
  };

  const handle = async (req: http.IncomingMessage, res: http.ServerResponse): Promise<void> => {
    const pathname = new URL(req.url ?? '/', `http://${req.headers.host ?? 'localhost'}`).pathname;

    if (pathname === '/api/login' && req.method === 'POST') {
      const body = await jsonBody(req);
      if (!deps.checkKey(String(body.key ?? ''))) {
        sendJson(res, { ok: false, message: '密钥不正确' }, 403);
        return;
      }
      const token = keyHash(deps.consoleKey());
      res.setHeader('Set-Cookie', `${COOKIE_NAME}=${token}; Path=/; HttpOnly; SameSite=Strict; Max-Age=604800`);
      sendJson(res, { ok: true });
      return;
    }

    if (pathname === '/' || pathname === '/index.html' || pathname === '/login') {
      if (!authed(req)) {
        send(res, 200, page('login.html'), 'text/html; charset=utf-8');
        return;
      }
      send(res, 200, page('index.html'), 'text/html; charset=utf-8');
      return;
    }

    if (pathname.startsWith('/api/')) {
      if (!authed(req)) {
        sendJson(res, { ok: false, message: '密钥不正确' }, 403);
        return;
      }
    }

    if (pathname === '/api/status') {
      sendJson(res, deps.status());
      return;
    }
    if (pathname === '/api/logs') {
      sendJson(res, { lines: getLogs() });
      return;
    }
    if (pathname === '/api/config' && req.method === 'GET') {
      sendJson(res, deps.config());
      return;
    }
    if (pathname === '/api/config/global' && req.method === 'PUT') {
      const body = await jsonBody(req);
      sendJson(res, { ok: deps.saveGlobal(body) });
      return;
    }
    if (pathname === '/api/config/account' && req.method === 'PUT') {
      const body = await jsonBody(req);
      sendJson(res, { ok: await deps.saveAccount(body) });
      return;
    }
    if (pathname === '/api/accounts/state' && req.method === 'POST') {
      const body = await jsonBody(req);
      const ok = await deps.accountState(String(body.accountId ?? ''), Boolean(body.running));
      sendJson(res, { ok }, ok ? 200 : 400);
      return;
    }
    if (pathname === '/api/plugins/config' && req.method === 'GET') {
      const url = new URL(req.url ?? '/', `http://${req.headers.host ?? 'localhost'}`);
      sendJson(res, deps.pluginConfig(url.searchParams.get('accountId') ?? '', url.searchParams.get('name') ?? '') as object);
      return;
    }
    if (pathname === '/api/plugins/config' && req.method === 'PUT') {
      const body = await jsonBody(req);
      const ok = await deps.savePluginConfig(String(body.accountId ?? ''), String(body.name ?? ''), body.config ?? {});
      sendJson(res, { ok }, ok ? 200 : 400);
      return;
    }
    if (pathname === '/api/plugins/toggle' && req.method === 'POST') {
      const body = await jsonBody(req);
      const ok = await deps.toggle(String(body.accountId ?? ''), String(body.name ?? ''), Boolean(body.enabled));
      sendJson(res, { ok }, ok ? 200 : 400);
      return;
    }

    const hit = pages[pathname];
    if (hit) {
      send(res, 200, fs.readFileSync(path.join(WEBUI_DIR, hit.file)), hit.type);
      return;
    }
    if (pathname.startsWith('/assets/')) {
      serveAsset(res, pathname.slice('/assets/'.length));
      return;
    }
    send(res, 404, 'not found', 'text/plain; charset=utf-8');
  };

  const server = http.createServer((req, res) => {
    void handle(req, res).catch((e: any) => {
      log.warn('请求处理失败', e?.message ?? e);
      try {
        if (!res.headersSent) sendJson(res, { ok: false, message: e?.message ?? 'error' }, 400);
        else res.end();
      } catch {}
    });
  });

  server.listen(port, host, () => log.info(`WebUI http://${host}:${port}`));
  server.on('error', (e: any) => log.error('WebUI 启动失败', e?.message ?? e));
  return server;
}
