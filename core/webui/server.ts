import http from 'node:http';
import { createLogger } from '../log.ts';

const log = createLogger('webui');

export interface WebUiSnapshot {
  uptime: number;
  accounts: { id: string; platform: string; label: string; online: boolean; selfId: string }[];
  plugins: { name: string; version: string; description: string }[];
}

function esc(v: unknown): string {
  return String(v ?? '').replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]!);
}

function render(data: WebUiSnapshot): string {
  const accountRows = data.accounts
    .map(
      (a) =>
        `<tr><td>${esc(a.id)}</td><td>${esc(a.platform)}</td><td>${esc(a.label)}</td><td>${a.online ? '在线' : '离线'}</td><td>${esc(a.selfId || '-')}</td></tr>`,
    )
    .join('');
  const pluginRows = data.plugins
    .map((p) => `<tr><td>${esc(p.name)}</td><td>${esc(p.version)}</td><td>${esc(p.description)}</td></tr>`)
    .join('');
  return `<!doctype html><html lang="zh-CN"><head><meta charset="utf-8"><title>Lysel</title></head><body>
<h1>Lysel</h1>
<p>运行时间 ${Math.floor(data.uptime / 1000)} 秒</p>
<h2>账户</h2>
<table border="1"><tr><th>ID</th><th>平台</th><th>备注</th><th>状态</th><th>自身 ID</th></tr>${accountRows || '<tr><td colspan="5">无账户</td></tr>'}</table>
<h2>插件</h2>
<table border="1"><tr><th>名称</th><th>版本</th><th>说明</th></tr>${pluginRows || '<tr><td colspan="3">无插件</td></tr>'}</table>
</body></html>`;
}

export function startWebUi(host: string, port: number, snapshot: () => WebUiSnapshot): http.Server {
  const server = http.createServer((req, res) => {
    if (req.url?.startsWith('/api/status')) {
      res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
      res.end(JSON.stringify(snapshot(), null, 2));
      return;
    }
    if (req.url === '/' || req.url?.startsWith('/index')) {
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
      res.end(render(snapshot()));
      return;
    }
    res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
    res.end('not found');
  });
  server.listen(port, host, () => log.info(`WebUI http://${host}:${port}`));
  server.on('error', (e: any) => log.error('WebUI 启动失败', e?.message ?? e));
  return server;
}
