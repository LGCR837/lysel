const views = {
  dashboard: ['DASHBOARD', '概览'],
  accounts: ['ADAPTERS', '账户'],
  plugins: ['PLUGINS', '插件'],
  logs: ['OUTPUT', '日志'],
  settings: ['CONFIG', '设置'],
};

let current = 'dashboard';
let statusData = null;
let lastLogCount = 0;

const $ = (id) => document.getElementById(id);

function esc(v) {
  return String(v ?? '').replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]);
}

function fmtUptime(ms) {
  const s = Math.max(0, Math.floor(ms / 1000));
  const pad = (n) => String(n).padStart(2, '0');
  return `${pad(Math.floor(s / 3600))}:${pad(Math.floor((s % 3600) / 60))}:${pad(s % 60)}`;
}

function setView(name) {
  if (!views[name]) name = 'dashboard';
  current = name;
  document.querySelectorAll('.sidebar__nav a').forEach((a) => a.classList.toggle('is-active', a.dataset.view === name));
  document.querySelectorAll('.view').forEach((v) => v.classList.toggle('is-active', v.dataset.panel === name));
  $('view-en').textContent = views[name][0];
  $('view-title').textContent = views[name][1];
  document.title = `Lysel / ${views[name][0]}`;
  observeReveals();
  if (name === 'logs') loadLogs();
}

function observeReveals() {
  const items = document.querySelectorAll('.view.is-active .reveal:not(.is-visible)');
  if (!('IntersectionObserver' in window)) {
    items.forEach((el) => el.classList.add('is-visible'));
    return;
  }
  const observer = new IntersectionObserver((entries) => {
    for (const entry of entries) {
      if (entry.isIntersecting) {
        entry.target.classList.add('is-visible');
        observer.unobserve(entry.target);
      }
    }
  }, { rootMargin: '0px 0px -8% 0px', threshold: 0.05 });
  items.forEach((el) => observer.observe(el));
}

function rowLeft(name, sub) {
  return `<div><span class="list-row__name">${esc(name)}</span><span class="list-row__sub">${esc(sub)}</span></div>`;
}

function renderStatus(data) {
  statusData = data;
  const accounts = data.accounts ?? [];
  const plugins = data.plugins ?? [];
  const online = accounts.filter((a) => a.online).length;

  $('uptime-value').textContent = fmtUptime(data.uptime);
  $('m-uptime').textContent = fmtUptime(data.uptime);
  $('m-accounts').textContent = accounts.length;
  $('m-online').textContent = online;
  $('m-plugins').textContent = plugins.length;
  $('m-uptime-detail').textContent = `已处理 ${data.stats?.messages ?? 0} 条消息`;
  $('m-accounts-detail').textContent = `${accounts.filter((a) => !a.online).length} 个离线`;
  $('m-online-detail').textContent = online ? '连接正常' : '暂无在线账户';
  $('m-plugins-detail').textContent = `${plugins.reduce((n, p) => n + (p.enabled ?? []).filter((e) => e.enabled).length, 0)} 次挂载`;

  $('side-dot').classList.toggle('is-offline', online === 0);
  $('side-status-text').textContent = online ? `${online} 个账户在线` : '暂无在线账户';

  $('dash-accounts').innerHTML = accounts.length
    ? accounts.map((a) => `<div class="list-row">${rowLeft(a.id, `${a.platform} / ${a.label}`)}<span class="tag ${a.online ? 'tag--pink' : 'tag--dim'}">${a.online ? '在线' : '离线'}</span><span class="tag">${a.pluginCount ?? 0} 插件</span></div>`).join('')
    : '<p class="empty">暂无账户，在 data/accounts/ 下添加配置</p>';

  $('dash-plugins').innerHTML = plugins.length
    ? plugins.map((p) => `<div class="list-row">${rowLeft(p.name, p.description || '无说明')}<span class="tag">v${esc(p.version)}</span><span class="tag ${(p.enabled ?? []).some((e) => e.enabled) ? 'tag--pink' : 'tag--dim'}">${(p.enabled ?? []).filter((e) => e.enabled).length} 账户</span></div>`).join('')
    : '<p class="empty">暂无插件，在 plugins/ 下添加插件目录</p>';

  const mem = data.memory ?? {};
  $('dash-env').innerHTML = [
    ['NODE', data.node ?? '-'],
    ['PLATFORM', data.os ?? '-'],
    ['RSS', `${mem.rss ?? 0} MB`],
    ['LOG LEVEL', data.config?.logLevel ?? '-'],
  ].map(([k, v]) => `<div><dt>${k}</dt><dd>${esc(v)}</dd></div>`).join('');

  $('account-cards').innerHTML = accounts.length
    ? accounts.map((a, i) => `<article class="account-card reveal" data-delay="${Math.min(i + 1, 7)}">
        <div class="account-card__head"><div><div class="account-card__id">${esc(a.id)}</div><div class="account-card__label">${esc(a.label)}</div></div><span class="tag ${a.online ? 'tag--pink' : 'tag--dim'}">${a.online ? '在线' : '离线'}</span></div>
        <dl class="account-card__body">
          <div><dt>PLATFORM</dt><dd>${esc(a.platform)}</dd></div>
          <div><dt>SELF ID</dt><dd>${esc(a.selfId || '-')}</dd></div>
          <div><dt>PLUGINS</dt><dd>${a.pluginCount ?? 0}</dd></div>
          <div><dt>COMMANDS</dt><dd>${a.commandCount ?? 0}</dd></div>
        </dl>
      </article>`).join('')
    : '<p class="empty">暂无账户，在 data/accounts/&lt;id&gt;/account.json 添加配置</p>';

  $('plugin-count').textContent = `${plugins.length} PLUGINS`;
  $('plugin-rows').innerHTML = plugins.length
    ? plugins.map((p) => `<tr>
        <td class="data-table__name">${esc(p.name)}</td>
        <td>v${esc(p.version)}</td>
        <td class="data-table__desc">${esc(p.description || '无说明')}</td>
        <td><div class="switches">${
          (p.enabled ?? []).length
            ? p.enabled.map((e) => `<button class="switch ${e.enabled ? 'is-on' : ''}" data-account="${esc(e.accountId)}" data-plugin="${esc(p.name)}" data-enabled="${e.enabled}">${esc(e.accountId)} · ${e.enabled ? '启用' : '停用'}</button>`).join('')
            : '<span class="tag tag--dim">无账户</span>'
        }</div></td>
      </tr>`).join('')
    : '<tr><td colspan="4" class="empty">暂无插件</td></tr>';

  const cfg = data.config ?? {};
  $('settings-facts').innerHTML = [
    ['LOG LEVEL', cfg.logLevel ?? '-'],
    ['COMMAND PREFIX', cfg.commandPrefix ?? '-'],
    ['WEBUI', cfg.webui?.enabled ? '启用' : '停用'],
    ['LISTEN', `${cfg.webui?.host ?? '-'}:${cfg.webui?.port ?? '-'}`],
  ].map(([k, v]) => `<div><dt>${k}</dt><dd>${esc(v)}</dd></div>`).join('');
  $('settings-note').textContent = '配置位于 data/bot.json，账户配置位于 data/accounts/<id>/account.json，插件配置派生自 config.example.json。';

  observeReveals();
}

async function loadStatus(btn) {
  if (btn) {
    btn.classList.add('is-busy');
  }
  try {
    const res = await fetch('/api/status', { cache: 'no-store' });
    if (res.ok) renderStatus(await res.json());
  } catch {
    $('side-dot').classList.add('is-offline');
    $('side-status-text').textContent = '连接失败';
  } finally {
    if (btn) setTimeout(() => btn.classList.remove('is-busy'), 600);
  }
}

async function loadLogs() {
  try {
    const res = await fetch('/api/logs', { cache: 'no-store' });
    if (!res.ok) return;
    const data = await res.json();
    const lines = data.lines ?? [];
    $('log-count').textContent = `${lines.length} LINES`;
    if (lines.length === lastLogCount) return;
    lastLogCount = lines.length;
    const atBottom = $('terminal').scrollTop + $('terminal').clientHeight >= $('terminal').scrollHeight - 40;
    $('terminal').innerHTML = lines.map((l) => `<div class="log-line log-line--${esc(l.level)}"><span class="log-line__time">${esc(l.time)}</span><span class="log-line__level">${esc(l.level.toUpperCase())}</span><span class="log-line__text">${esc(l.scope ? `[${l.scope}] ` : '')}${esc(l.text)}</span></div>`).join('');
    if (atBottom) $('terminal').scrollTop = $('terminal').scrollHeight;
  } catch {}
}

document.addEventListener('click', async (ev) => {
  const nav = ev.target.closest('.sidebar__nav a');
  if (nav) {
    ev.preventDefault();
    setView(nav.dataset.view);
    location.hash = nav.dataset.view;
    return;
  }
  if (ev.target.closest('#refresh-button')) {
    await loadStatus($('refresh-button'));
    return;
  }
  const sw = ev.target.closest('.switch');
  if (sw) {
    sw.classList.add('is-busy');
    try {
      const res = await fetch('/api/plugins/toggle', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ accountId: sw.dataset.account, name: sw.dataset.plugin, enabled: sw.dataset.enabled !== 'true' }),
      });
      if (!res.ok) throw new Error('toggle failed');
    } catch {
      sw.classList.remove('is-busy');
      return;
    }
    await loadStatus();
  }
});

window.addEventListener('hashchange', () => setView(location.hash.replace('#', '')));

setView(location.hash.replace('#', '') || 'dashboard');
loadStatus();
setInterval(() => loadStatus(), 5000);
setInterval(() => { if (current === 'logs' || document.visibilityState === 'hidden') return; loadLogs(); }, 2500);
setInterval(() => { if (statusData) $('uptime-value').textContent = fmtUptime(statusData.uptime + (Date.now() - statusData.at)); }, 1000);
