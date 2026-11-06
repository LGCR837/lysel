const views = {
  dashboard: ['DASHBOARD', '概览'],
  accounts: ['ADAPTERS', '账户'],
  plugins: ['PLUGINS', '插件'],
  logs: ['OUTPUT', '日志'],
  settings: ['CONFIG', '设置'],
};

const ALL = '__all__';
let current = 'dashboard';
let selectedAccount = ALL;
let statusData = null;
let configData = null;
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

function consoleKey() {
  return sessionStorage.getItem('lysel-key') || '';
}

async function api(method, path, body) {
  const headers = {};
  const key = consoleKey();
  if (key) headers['X-Console-Key'] = key;
  if (body !== undefined) headers['Content-Type'] = 'application/json';
  const res = await fetch(path, {
    method,
    headers,
    body: body === undefined ? undefined : JSON.stringify(body),
    cache: 'no-store',
  });
  let data = null;
  try { data = await res.json(); } catch {}
  return { ok: res.ok, status: res.status, data };
}

function hint(id, text, ok = true) {
  const el = $(id);
  if (!el) return;
  el.textContent = text;
  el.className = `hint is-shown ${ok ? 'is-ok' : 'is-error'}`;
  setTimeout(() => { el.className = 'hint'; }, 4000);
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
  if (name === 'settings' || name === 'accounts' || name === 'plugins') loadConfig();
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

function renderAccounts(accounts) {
  $('account-cards').innerHTML = accounts.length
    ? accounts.map((a, i) => `<article class="account-card reveal" data-delay="${Math.min(i + 1, 7)}">
        <div class="account-card__head"><div><div class="account-card__id">${esc(a.id)}</div><div class="account-card__label">${esc(a.label)}</div></div><span class="tag ${a.online ? 'tag--pink' : 'tag--dim'}">${a.online ? '在线' : '离线'}</span></div>
        <dl class="account-card__body">
          <div><dt>PLATFORM</dt><dd>${esc(a.platform)}</dd></div>
          <div><dt>SELF ID</dt><dd>${esc(a.selfId || '-')}</dd></div>
          <div><dt>PLUGINS</dt><dd>${a.pluginCount ?? 0}</dd></div>
          <div><dt>COMMANDS</dt><dd>${a.commandCount ?? 0}</dd></div>
        </dl>
        <div class="account-actions">
          <button class="button button--small ${a.online ? 'button--on' : ''}" data-action="account-start" data-id="${esc(a.id)}"><span class="button__inner"><span>启动</span></span></button>
          <button class="button button--small ${!a.online ? 'button--on' : ''}" data-action="account-stop" data-id="${esc(a.id)}"><span class="button__inner"><span>停止</span></span></button>
          <button class="button button--small button--outline" data-action="account-edit" data-id="${esc(a.id)}"><span class="button__inner"><span>编辑</span></span></button>
        </div>
      </article>`).join('')
    : '<p class="empty">暂无账户，点击「新增账户」创建</p>';
}

function renderPlugins(plugins, accounts) {
  const tabs = [{ id: ALL, label: '全部' }].concat(accounts.map((a) => ({ id: a.id, label: a.id })));
  if (!tabs.some((t) => t.id === selectedAccount)) selectedAccount = ALL;
  $('plugin-tabs').innerHTML = tabs.map((t) => {
    const count = t.id === ALL ? plugins.length : plugins.filter((p) => (p.enabled ?? []).some((e) => e.accountId === t.id)).length;
    return `<button class="tab ${selectedAccount === t.id ? 'is-active' : ''}" data-action="tab" data-id="${esc(t.id)}">${esc(t.label)}<span class="tab__count">${count}</span></button>`;
  }).join('');

  const scoped = selectedAccount === ALL ? accounts.map((a) => a.id) : [selectedAccount];
  $('plugin-cards').innerHTML = plugins.length
    ? plugins.map((p, i) => {
        const rows = scoped.length
          ? scoped.map((accId) => {
              const on = Boolean((p.enabled ?? []).find((e) => e.accountId === accId)?.enabled);
              return `<div class="plugin-switch-row">
                <span class="plugin-switch-row__name">${esc(accId)}</span>
                <div class="plugin-switch-row__actions">
                  <button class="button button--small ${on ? 'button--on' : ''}" data-action="plugin-start" data-account="${esc(accId)}" data-plugin="${esc(p.name)}"><span class="button__inner"><span>启动</span></span></button>
                  <button class="button button--small ${!on ? 'button--on' : ''}" data-action="plugin-stop" data-account="${esc(accId)}" data-plugin="${esc(p.name)}"><span class="button__inner"><span>停止</span></span></button>
                </div>
              </div>`;
            }).join('')
          : '<p class="empty">暂无账户</p>';
        const cfgAccount = scoped[0] ?? '';
        return `<article class="account-card reveal" data-delay="${Math.min(i + 1, 7)}">
          <div class="account-card__head"><div><div class="account-card__id">${esc(p.name)}</div><div class="account-card__label">v${esc(p.version)} · ${esc(p.description || '无说明')}</div></div><span class="plugin-card__state">${(p.enabled ?? []).filter((e) => e.enabled).length} 个账户启用</span></div>
          <div class="plugin-switches">${rows}</div>
          <div class="plugin-actions">
            <button class="button button--small button--outline" data-action="plugin-config" data-account="${esc(cfgAccount)}" data-plugin="${esc(p.name)}" ${cfgAccount ? '' : 'disabled'}><span class="button__inner"><span>配置</span></span></button>
          </div>
          <div class="plugin-config" hidden>
            <textarea class="json-editor" spellcheck="false"></textarea>
            <div class="form-actions">
              <button class="button button--small" data-action="plugin-save" data-account="${esc(cfgAccount)}" data-plugin="${esc(p.name)}"><span class="button__inner"><span>保存</span></span></button>
              <span class="hint"></span>
            </div>
          </div>
        </article>`;
      }).join('')
    : '<p class="empty">暂无插件</p>';
}

function renderSettings(cfg) {
  $('cfg-logLevel').value = cfg.logLevel ?? 'info';
  $('cfg-commandPrefix').value = cfg.commandPrefix ?? '!';
  $('cfg-webuiEnabled').value = String(cfg.webui?.enabled !== false);
  $('cfg-host').value = cfg.webui?.host ?? '127.0.0.1';
  $('cfg-port').value = cfg.webui?.port ?? 7520;
  $('cfg-key').value = consoleKey();
  $('settings-note').textContent = `Lysel ${statusData?.version ?? ''} · 控制台密钥仅在配置文件中设置，网页不提供修改。端口与监听地址改动需重启生效。`;
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
    : '<p class="empty">暂无账户，在账户页添加配置</p>';

  $('dash-plugins').innerHTML = plugins.length
    ? plugins.map((p) => `<div class="list-row">${rowLeft(p.name, p.description || '无说明')}<span class="tag">v${esc(p.version)}</span><span class="tag ${(p.enabled ?? []).some((e) => e.enabled) ? 'tag--pink' : 'tag--dim'}">${(p.enabled ?? []).filter((e) => e.enabled).length} 账户</span></div>`).join('')
    : '<p class="empty">暂无插件，在 plugins/ 下添加插件目录</p>';

  const mem = data.memory ?? {};
  $('dash-env').innerHTML = [
    ['VERSION', data.version ?? '-'],
    ['NODE', data.node ?? '-'],
    ['RSS', `${mem.rss ?? 0} MB`],
    ['LOG LEVEL', data.config?.logLevel ?? '-'],
  ].map(([k, v]) => `<div><dt>${k}</dt><dd>${esc(v)}</dd></div>`).join('');

  renderAccounts(accounts);
  renderPlugins(plugins, accounts);
  renderSettings(data.config ?? {});
  observeReveals();
}

async function loadStatus(btn) {
  if (btn) btn.classList.add('is-busy');
  try {
    const res = await api('GET', '/api/status');
    if (res.ok) renderStatus(res.data);
  } catch {
    $('side-dot').classList.add('is-offline');
    $('side-status-text').textContent = '连接失败';
  } finally {
    if (btn) setTimeout(() => btn.classList.remove('is-busy'), 600);
  }
}

async function loadConfig() {
  const res = await api('GET', '/api/config');
  configData = res.ok ? res.data : null;
  if (!res.ok) hint('global-hint', res.status === 403 ? '密钥不正确' : '读取配置失败', false);
}

async function loadLogs() {
  try {
    const res = await api('GET', '/api/logs');
    if (!res.ok) return;
    const lines = res.data?.lines ?? [];
    $('log-count').textContent = `${lines.length} LINES`;
    if (lines.length === lastLogCount) return;
    lastLogCount = lines.length;
    const terminal = $('terminal');
    const atBottom = terminal.scrollTop + terminal.clientHeight >= terminal.scrollHeight - 40;
    terminal.innerHTML = lines.map((l) => `<div class="log-line log-line--${esc(l.level)}"><span class="log-line__time">${esc(l.time)}</span><span class="log-line__level">${esc(l.level.toUpperCase())}</span><span class="log-line__text">${esc(l.scope ? `[${l.scope}] ` : '')}${esc(l.text)}</span></div>`).join('');
    if (atBottom) terminal.scrollTop = terminal.scrollHeight;
  } catch {}
}

async function saveGlobalFromForm() {
  const cfg = statusData?.config ?? {};
  const patch = {
    logLevel: $('cfg-logLevel').value,
    commandPrefix: $('cfg-commandPrefix').value,
    webui: {
      enabled: $('cfg-webuiEnabled').value === 'true',
      host: $('cfg-host').value.trim(),
      port: Number($('cfg-port').value) || 7520,
    },
    plugins: cfg.plugins ?? {},
  };
  const res = await api('PUT', '/api/config/global', patch);
  hint('global-hint', res.ok ? '已保存，端口改动需重启生效' : (res.status === 403 ? '密钥不正确' : '保存失败'), res.ok);
  if (res.ok) await loadStatus();
}

function openAccountEditor(mode, id) {
  const panel = $('account-editor');
  panel.hidden = false;
  panel.dataset.mode = mode;
  panel.dataset.id = id ?? '';
  $('account-editor-title').textContent = mode === 'new' ? '新增账户' : `编辑账户 ${id}`;
  const raw = mode === 'new'
    ? { id: 'new-account', platform: 'onebot11', label: '新账户', enabled: true, adapter: { url: 'ws://127.0.0.1:3001', token: '' }, plugins: {} }
    : (configData?.accounts ?? []).find((a) => a.id === id) ?? { id, platform: 'oldchat', enabled: true, adapter: {}, plugins: {} };
  $('account-json').value = JSON.stringify(raw, null, 2);
}

document.addEventListener('click', async (ev) => {
  const nav = ev.target.closest('.sidebar__nav a');
  if (nav) {
    ev.preventDefault();
    setView(nav.dataset.view);
    location.hash = nav.dataset.view;
    return;
  }
  const idActions = {
    'refresh-button': 'refresh',
    'new-account': 'new-account',
    'save-account': 'save-account',
    'cancel-account': 'cancel-account',
    'save-global': 'save-global',
    'edit-global-json': 'edit-global-json',
    'cancel-global-json': 'cancel-global-json',
    'save-global-json': 'save-global-json',
  };
  const btn = ev.target.closest('[data-action], button[id]');
  if (!btn) return;
  const action = btn.dataset.action || idActions[btn.id];
  if (!action) return;

  if (action === 'tab') {
    selectedAccount = btn.dataset.id;
    renderPlugins(statusData?.plugins ?? [], statusData?.accounts ?? []);
    return;
  }
  if (action === 'refresh') {
    await loadStatus($('refresh-button'));
    return;
  }
  if (action === 'account-start' || action === 'account-stop') {
    const res = await api('POST', '/api/accounts/state', { accountId: btn.dataset.id, running: action === 'account-start' });
    if (!res.ok) hint('account-hint', '操作失败', false);
    await loadStatus();
    return;
  }
  if (action === 'account-edit' || action === 'new-account') {
    await loadConfig();
    openAccountEditor(action === 'new-account' ? 'new' : 'edit', btn.dataset.id);
    return;
  }
  if (action === 'cancel-account') {
    $('account-editor').hidden = true;
    return;
  }
  if (action === 'save-account') {
    try {
      const raw = JSON.parse($('account-json').value);
      const res = await api('PUT', '/api/config/account', raw);
      hint('account-hint', res.ok ? '已保存，新账户需重启生效' : '保存失败', res.ok);
      if (res.ok) { await loadConfig(); await loadStatus(); }
    } catch {
      hint('account-hint', 'JSON 格式错误', false);
    }
    return;
  }
  if (action === 'plugin-start' || action === 'plugin-stop') {
    const res = await api('POST', '/api/plugins/toggle', {
      accountId: btn.dataset.account,
      name: btn.dataset.plugin,
      enabled: action === 'plugin-start',
    });
    if (res.ok) await loadStatus();
    return;
  }
  if (action === 'plugin-config') {
    const box = btn.closest('.account-card').querySelector('.plugin-config');
    box.hidden = !box.hidden;
    if (!box.hidden) {
      const res = await api('GET', `/api/plugins/config?accountId=${encodeURIComponent(btn.dataset.account)}&name=${encodeURIComponent(btn.dataset.plugin)}`);
      box.querySelector('textarea').value = JSON.stringify(res.data?.config ?? {}, null, 2);
    }
    return;
  }
  if (action === 'plugin-save') {
    const card = btn.closest('.account-card');
    const target = card.querySelector('.plugin-config .hint');
    try {
      const config = JSON.parse(card.querySelector('.plugin-config textarea').value);
      const res = await api('PUT', '/api/plugins/config', { accountId: btn.dataset.account, name: btn.dataset.plugin, config });
      target.textContent = res.ok ? '已保存并重载' : '保存失败';
      target.className = `hint is-shown ${res.ok ? 'is-ok' : 'is-error'}`;
      setTimeout(() => { target.className = 'hint'; }, 4000);
    } catch {
      target.textContent = 'JSON 格式错误';
      target.className = 'hint is-shown is-error';
    }
    return;
  }
  if (action === 'save-global') {
    await saveGlobalFromForm();
    return;
  }
  if (action === 'edit-global-json') {
    await loadConfig();
    $('global-json').value = JSON.stringify(configData?.global ?? {}, null, 2);
    $('global-editor').hidden = false;
    return;
  }
  if (action === 'cancel-global-json') {
    $('global-editor').hidden = true;
    return;
  }
  if (action === 'save-global-json') {
    try {
      const patch = JSON.parse($('global-json').value);
      const res = await api('PUT', '/api/config/global', patch);
      hint('global-json-hint', res.ok ? '已保存' : '保存失败', res.ok);
      if (res.ok) await loadStatus();
    } catch {
      hint('global-json-hint', 'JSON 格式错误', false);
    }
  }
});

$('cfg-key').addEventListener('change', async (ev) => {
  sessionStorage.setItem('lysel-key', ev.target.value.trim());
  await loadConfig();
});

window.addEventListener('hashchange', () => setView(location.hash.replace('#', '')));

setView(location.hash.replace('#', '') || 'dashboard');
loadStatus();
setInterval(() => loadStatus(), 5000);
setInterval(() => { if (current === 'logs' || document.visibilityState === 'hidden') return; loadLogs(); }, 2500);
setInterval(() => { if (statusData) $('uptime-value').textContent = fmtUptime(statusData.uptime + (Date.now() - statusData.at)); }, 1000);
