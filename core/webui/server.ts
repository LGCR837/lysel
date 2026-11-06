import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createLogger, getLogs } from '../log.ts';

const log = createLogger('webui');
const WEBUI_DIR = path.dirname(fileURLToPath(import.meta.url));

export interface WebUiDeps {
  status: () => unknown;
  toggle: (accountId: string, name: string, enabled: boolean) => Promise<boolean>;
}

const pages: Record<string, { file: string; type: string }> = {
  '/': { file: 'index.html', type: 'text/html; charset=utf-8' },
  '/index.html': { file: 'index.html', type: 'text/html; charset=utf-8' },
  '/webui.css': { file: 'webui.css', type: 'text/css; charset=utf-8' },
  '/webui.js': { file: 'webui.js', type: 'text/javascript; charset=utf-8' },
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
    req.on('data', (chunk) => {
      raw += chunk;
      if (raw.length > 8192) reject(new Error('body too large'));
    });
    req.on('end', () => resolve(raw));
    req.on('error', reject);
  });
}

function serveAsset(res: http.ServerResponse, name: string): void {
  const file = path.join(WEBUI_DIR, 'assets', path.basename(name));
  if (!fs.existsSync(file)) {
    send(res, 404, 'not found', 'text/plain; charset=utf-8');
    return;
  }
  const type = file.endsWith('.webp') ? 'image/webp' : 'application/octet-stream';
  send(res, 200, fs.readFileSync(file), type);
}

export function startWebUi(host: string, port: number, deps: WebUiDeps): http.Server {
  const server = http.createServer(async (req, res) => {
    const pathname = new URL(req.url ?? '/', `http://${req.headers.host ?? 'localhost'}`).pathname;

    if (pathname === '/api/status') {
      sendJson(res, deps.status());
      return;
    }
    if (pathname === '/api/logs') {
      sendJson(res, { lines: getLogs() });
      return;
    }
    if (pathname === '/api/plugins/toggle' && req.method === 'POST') {
      try {
        const body = JSON.parse((await readBody(req)) || '{}');
        const ok = await deps.toggle(String(body.accountId ?? ''), String(body.name ?? ''), Boolean(body.enabled));
        sendJson(res, { ok }, ok ? 200 : 400);
      } catch (e: any) {
        sendJson(res, { ok: false, message: e?.message ?? 'error' }, 400);
      }
      return;
    }

    const page = pages[pathname];
    if (page) {
      send(res, 200, fs.readFileSync(path.join(WEBUI_DIR, page.file)), page.type);
      return;
    }
    if (pathname.startsWith('/assets/')) {
      serveAsset(res, pathname.slice('/assets/'.length));
      return;
    }
    send(res, 404, 'not found', 'text/plain; charset=utf-8');
  });

  server.listen(port, host, () => log.info(`WebUI http://${host}:${port}`));
  server.on('error', (e: any) => log.error('WebUI 启动失败', e?.message ?? e));
  return server;
}
