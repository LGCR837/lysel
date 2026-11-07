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
let lastLogSig = '';
let accountEditorMode = 'new';
let accountDraft = null;
let sigAccounts = '';
let sigPlugins = '';
let sigGlobal = '';
let configTarget = null;
let revealObserver = null;
let firstPaint = true;
let hintToken = 0;
const scrollBars = [];

const PLATFORM_FIELDS = {
  oldchat: [
    { key: 'origin', label: '服务器地址', type: 'text', def: 'https://oc.mcl0.dpdns.org', wide: true },
    { key: 'identifier', label: '账号', type: 'text', def: '' },
    { key: 'password', label: '密码', type: 'password', def: '' },
    { key: 'deviceId', label: '设备 ID', type: 'text', def: '', hint: '留空自动生成' },
    { key: 'encrypt', label: '链路加密', type: 'boolean', def: true },
  ],
  onebot11: [
    { key: 'url', label: 'WS 地址', type: 'text', def: 'ws://127.0.0.1:3001', wide: true },
    { key: 'token', label: '访问令牌', type: 'password', def: '' },
  ],
};

const $ = (id) => document.getElementById(id);

function esc(v) {
  return String(v ?? '').replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]);
}

function fmtUptime(ms) {
  const s = Math.max(0, Math.floor(ms / 1000));
  const pad = (n) => String(n).padStart(2, '0');
  return `${pad(Math.floor(s / 3600))}:${pad(Math.floor((s % 3600) / 60))}:${pad(s % 60)}`;
}

async function api(method, path, body) {
  const headers = {};
  if (body !== undefined) headers['Content-Type'] = 'application/json';
  const res = await fetch(path, {
    method,
    headers,
    body: body === undefined ? undefined : JSON.stringify(body),
    cache: 'no-store',
  });
  let data = null;
  try { data = await res.json(); } catch {}
  if (res.status === 403) {
    location.href = '/';
    return { ok: false, status: 403, data };
  }
  return { ok: res.ok, status: res.status, data };
}

function hint(id, text, ok = true) {
  const el = $(id);
  if (!el) return;
  const token = ++hintToken;
  el.textContent = text;
  el.className = `hint is-shown ${ok ? 'is-ok' : 'is-error'}`;
  setTimeout(() => { if (token === hintToken) el.className = 'hint'; }, 4000);
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
  if (name === 'plugins') syncTabIndicator();
  if (name === 'settings' || name === 'accounts' || name === 'plugins') loadConfig();
  syncScrollbars();
}

function observeReveals() {
  const items = document.querySelectorAll('.view.is-active .reveal:not(.is-visible)');
  if (!items.length) return;
  if (!('IntersectionObserver' in window)) {
    items.forEach((el) => el.classList.add('is-visible'));
    return;
  }
  if (!revealObserver) {
    revealObserver = new IntersectionObserver((entries) => {
      for (const entry of entries) {
        if (entry.isIntersecting) {
          entry.target.classList.add('is-visible');
          revealObserver.unobserve(entry.target);
        }
      }
    }, { rootMargin: '0px 0px -8% 0px', threshold: 0.05 });
  }
  items.forEach((el) => revealObserver.observe(el));
}

function rowLeft(name, sub) {
  return `<div><span class="list-row__name">${esc(name)}</span><span class="list-row__sub">${esc(sub)}</span></div>`;
}

function renderAccounts(accounts) {
  const cardCls = firstPaint ? 'account-card reveal' : 'account-card is-visible';
  $('account-cards').innerHTML = accounts.length
    ? accounts.map((a, i) => `<article class="${cardCls}" data-delay="${Math.min(i + 1, 7)}">
        <div class="account-card__head"><div><div class="account-card__id">${esc(a.id)}</div><div class="account-card__label">${esc(a.label)}</div></div><span class="tag ${a.online ? 'tag--pink' : 'tag--dim'}">${a.online ? '在线' : '离线'}</span></div>
        <dl class="account-card__body">
          <div><dt>PLATFORM</dt><dd>${esc(a.platform)}</dd></div>
          <div><dt>SELF ID</dt><dd>${esc(a.selfId || '-')}</dd></div>
          <div><dt>PLUGINS</dt><dd>${a.pluginCount ?? 0}</dd></div>
          <div><dt>COMMANDS</dt><dd>${a.commandCount ?? 0}</dd></div>
        </dl>
        <div class="account-actions">
          ${a.online
            ? `<button class="button button--small button--on" data-action="account-stop" data-id="${esc(a.id)}"><span class="button__inner"><span>停止</span></span></button>`
            : `<button class="button button--small button--on" data-action="account-start" data-id="${esc(a.id)}"><span class="button__inner"><span>启动</span></span></button>`}
          <button class="button button--small button--outline" data-action="account-edit" data-id="${esc(a.id)}"><span class="button__inner"><span>编辑</span></span></button>
        </div>
      </article>`).join('')
    : '<p class="empty">暂无账户，点击「新增账户」创建</p>';
}

function syncTabIndicator() {
  const wrap = $('plugin-tabs');
  const bar = wrap.querySelector('.tabs__indicator');
  const active = wrap.querySelector('.tab.is-active');
  if (!bar) return;
  if (!active) {
    bar.style.width = '0px';
    return;
  }
  bar.style.left = `${active.offsetLeft}px`;
  bar.style.width = `${active.offsetWidth}px`;
}

function renderTabs(plugins, accounts) {
  const tabs = [{ id: ALL, label: '全部' }].concat(accounts.map((a) => ({ id: a.id, label: a.id })));
  if (!tabs.some((t) => t.id === selectedAccount)) selectedAccount = ALL;
  $('plugin-tabs').innerHTML = '<span class="tabs__indicator"></span>' + tabs.map((t) => {
    const count = t.id === ALL ? plugins.length : plugins.filter((p) => (p.enabled ?? []).some((e) => e.accountId === t.id)).length;
    return `<button class="tab ${selectedAccount === t.id ? 'is-active' : ''}" data-action="tab" data-id="${esc(t.id)}">${esc(t.label)}<span class="tab__count">${count}</span></button>`;
  }).join('');
  syncTabIndicator();
}

function renderPluginCards(plugins, accounts) {
  const cardCls = firstPaint ? 'account-card reveal' : 'account-card is-visible';
  const scoped = selectedAccount === ALL ? accounts.map((a) => a.id) : [selectedAccount];
  $('plugin-cards').innerHTML = plugins.length
    ? plugins.map((p, i) => {
        const rows = scoped.length
          ? scoped.map((accId) => {
              const on = Boolean((p.enabled ?? []).find((e) => e.accountId === accId)?.enabled);
              const actions = selectedAccount === ALL
                ? `<span class="tag ${on ? 'tag--pink' : 'tag--dim'}">${on ? '启用' : '停用'}</span>`
                : `<div class="plugin-switch-row__actions">
                    ${on
                      ? `<button class="button button--small button--on" data-action="plugin-stop" data-account="${esc(accId)}" data-plugin="${esc(p.name)}"><span class="button__inner"><span>停止</span></span></button>`
                      : `<button class="button button--small button--on" data-action="plugin-start" data-account="${esc(accId)}" data-plugin="${esc(p.name)}"><span class="button__inner"><span>启动</span></span></button>`}
                    <button class="button button--small button--outline" data-action="plugin-config" data-account="${esc(accId)}" data-plugin="${esc(p.name)}"><span class="button__inner"><span>配置</span></span></button>
                  </div>`;
              return `<div class="plugin-switch-row">
                <span class="plugin-switch-row__name">${esc(accId)}</span>
                ${actions}
              </div>`;
            }).join('')
          : '<p class="empty">暂无账户</p>';
        return `<article class="${cardCls}" data-delay="${Math.min(i + 1, 7)}">
          <div class="account-card__head"><div><div class="account-card__id">${esc(p.name)}</div><div class="account-card__label">v${esc(p.version)} · ${esc(p.description || '无说明')}</div></div><span class="plugin-card__state">${(p.enabled ?? []).filter((e) => e.enabled).length} 个账户启用</span></div>
          <div class="plugin-switches">${rows}</div>
        </article>`;
      }).join('')
    : '<p class="empty">暂无插件</p>';
}

function renderPlugins(plugins, accounts) {
  renderTabs(plugins, accounts);
  renderPluginCards(plugins, accounts);
}

function renderSettings(cfg) {
  const sig = JSON.stringify([cfg.logLevel, cfg.commandPrefix, cfg.webui]);
  if (sig === sigGlobal) return;
  sigGlobal = sig;
  const set = (id, value) => {
    const el = $(id);
    if (!el || el === document.activeElement) return;
    if (el.value === String(value)) return;
    el.value = value;
  };
  set('cfg-logLevel', cfg.logLevel ?? 'info');
  set('cfg-commandPrefix', cfg.commandPrefix ?? '!');
  set('cfg-webuiEnabled', String(cfg.webui?.enabled !== false));
  set('cfg-host', cfg.webui?.host ?? '127.0.0.1');
  set('cfg-port', cfg.webui?.port ?? 7520);
  $('settings-note').textContent = `Lysel ${statusData?.version ?? ''} · 控制台密钥在 data/bot.json 中设置，不在此页修改。端口与监听地址改动需重启生效。`;
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

  const mem = data.memory ?? {};
  $('dash-env').innerHTML = [
    ['VERSION', data.version ?? '-'],
    ['NODE', data.node ?? '-'],
    ['RSS', `${mem.rss ?? 0} MB`],
    ['LOG LEVEL', data.config?.logLevel ?? '-'],
  ].map(([k, v]) => `<div><dt>${k}</dt><dd>${esc(v)}</dd></div>`).join('');

  const accSig = JSON.stringify(accounts);
  if (accSig !== sigAccounts) {
    sigAccounts = accSig;
    $('dash-accounts').innerHTML = accounts.length
      ? accounts.map((a) => `<div class="list-row">${rowLeft(a.id, `${a.platform} / ${a.label}`)}<span class="tag ${a.online ? 'tag--pink' : 'tag--dim'}">${a.online ? '在线' : '离线'}</span><span class="tag">${a.pluginCount ?? 0} 插件</span></div>`).join('')
      : '<p class="empty">暂无账户，在账户页添加配置</p>';
    renderAccounts(accounts);
    observeReveals();
  }

  const pluginSig = JSON.stringify([plugins, accounts.map((a) => a.id)]);
  if (pluginSig !== sigPlugins) {
    sigPlugins = pluginSig;
    $('dash-plugins').innerHTML = plugins.length
      ? plugins.map((p) => `<div class="list-row">${rowLeft(p.name, p.description || '无说明')}<span class="tag">v${esc(p.version)}</span><span class="tag ${(p.enabled ?? []).some((e) => e.enabled) ? 'tag--pink' : 'tag--dim'}">${(p.enabled ?? []).filter((e) => e.enabled).length} 账户</span></div>`).join('')
      : '<p class="empty">暂无插件，在 plugins/ 下添加插件目录</p>';
    renderPlugins(plugins, accounts);
    observeReveals();
  }

  renderSettings(data.config ?? {});
  syncScrollbars();
  firstPaint = false;
}

async function loadStatus(btn, force) {
  if (btn) btn.classList.add('is-busy');
  try {
    const res = await api('GET', '/api/status');
    if (res.ok) {
      if (force) {
        sigAccounts = '';
        sigPlugins = '';
      }
      renderStatus(res.data);
    }
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
    const last = lines[lines.length - 1];
    const sig = `${lines.length}|${last?.time ?? ''}|${last?.text ?? ''}`;
    if (sig === lastLogSig) return;
    lastLogSig = sig;
    const terminal = $('terminal');
    const atBottom = terminal.scrollTop + terminal.clientHeight >= terminal.scrollHeight - 40;
    terminal.innerHTML = lines.map((l) => `<div class="log-line log-line--${esc(l.level)}"><span class="log-line__time">${esc(l.time)}</span><span class="log-line__level">${esc(l.level.toUpperCase())}</span><span class="log-line__text">${esc(l.scope ? `[${l.scope}] ` : '')}${esc(l.text)}</span></div>`).join('');
    if (atBottom) terminal.scrollTop = terminal.scrollHeight;
    syncScrollbars();
  } catch {}
}

async function saveGlobalFromForm() {
  const patch = {
    logLevel: $('cfg-logLevel').value,
    commandPrefix: $('cfg-commandPrefix').value,
    webui: {
      enabled: $('cfg-webuiEnabled').value === 'true',
      host: $('cfg-host').value.trim(),
      port: Number($('cfg-port').value) || 7520,
    },
  };
  const res = await api('PUT', '/api/config/global', patch);
  hint('global-hint', res.ok ? '已保存，端口改动需重启生效' : (res.status === 403 ? '密钥不正确' : '保存失败'), res.ok);
  if (res.ok) await loadStatus();
}

function inferType(v) {
  if (typeof v === 'boolean') return 'boolean';
  if (typeof v === 'number') return 'number';
  if (typeof v === 'string') return 'text';
  return 'json';
}

function fieldHtml(f, scope = 'base') {
  const attr = scope === 'plugin'
    ? `data-pkey="${esc(f.key)}" data-ptype="${esc(f.type)}"`
    : `data-key="${esc(f.key)}" data-type="${esc(f.type)}"${scope === 'adapter' ? ' data-adapter="1"' : ''}`;
  let control;
  if (f.type === 'boolean') {
    const on = f.value === true || f.value === 'true';
    control = `<select ${attr}><option value="true"${on ? ' selected' : ''}>启用</option><option value="false"${!on ? ' selected' : ''}>停用</option></select>`;
  } else if (f.type === 'select') {
    control = `<select ${attr}>${f.options.map((o) => `<option value="${esc(o[0])}"${String(f.value) === String(o[0]) ? ' selected' : ''}>${esc(o[1])}</option>`).join('')}</select>`;
  } else if (f.type === 'json') {
    control = `<textarea class="json-editor" ${attr}>${esc(f.value ?? '')}</textarea>`;
  } else {
    const type = f.type === 'number' ? 'number' : f.type === 'password' ? 'password' : 'text';
    control = `<input ${attr} type="${type}" value="${esc(f.value ?? '')}"${f.readonly ? ' readonly' : ''}>`;
  }
  return `<label class="field${f.wide ? ' field--wide' : ''}"><span>${esc(f.label)}</span>${control}${f.hint ? `<span class="field__hint">${esc(f.hint)}</span>` : ''}</label>`;
}

function renderAccountFields(raw) {
  const platform = PLATFORM_FIELDS[raw.platform] ? raw.platform : 'onebot11';
  const base = [
    { key: 'id', label: '账户 ID', type: 'text', value: raw.id ?? '', readonly: accountEditorMode === 'edit' },
    { key: 'platform', label: '平台', type: 'select', value: platform, options: [['oldchat', 'OldChat'], ['onebot11', 'OneBot v11']] },
    { key: 'label', label: '备注', type: 'text', value: raw.label ?? '' },
    { key: 'enabled', label: '启用', type: 'boolean', value: raw.enabled !== false },
  ];
  const adapter = PLATFORM_FIELDS[platform].map((f) => ({ ...f, value: raw.adapter?.[f.key] ?? f.def }));
  $('account-fields').innerHTML = [
    ...base.map((f) => fieldHtml(f, 'base')),
    ...adapter.map((f) => fieldHtml(f, 'adapter')),
  ].join('');
}

function collectAccountFields() {
  const out = { id: '', platform: 'onebot11', label: '', enabled: true, adapter: {}, plugins: accountDraft?.plugins ?? {} };
  for (const el of $('account-fields').querySelectorAll('[data-key]')) {
    const key = el.dataset.key;
    let value = el.value;
    if (el.dataset.type === 'boolean') value = value === 'true';
    else if (el.dataset.type === 'number') value = Number(value);
    if (el.dataset.adapter === '1') out.adapter[key] = value;
    else out[key] = value;
  }
  return out;
}

function renderPluginForm(form, example, config) {
  const template = Object.keys(example).length ? example : config;
  const keys = Object.keys(template);
  if (!keys.length) {
    form.innerHTML = '<p class="config-empty">该插件未提供配置项</p>';
    return;
  }
  form.innerHTML = keys.map((k) => {
    const def = k in example ? example[k] : config[k];
    const type = inferType(def);
    const value = k in config ? config[k] : def;
    return fieldHtml({
      key: k,
      label: k,
      type,
      value: type === 'json' ? JSON.stringify(value ?? def, null, 2) : value,
      wide: type === 'json',
    }, 'plugin');
  }).join('');
}

async function openConfigModal(account, plugin) {
  configTarget = { account, plugin };
  $('plugin-config-title').textContent = plugin;
  $('plugin-config-sub').textContent = account;
  $('plugin-config-hint').className = 'hint';
  $('plugin-config-modal').hidden = false;
  const res = await api('GET', `/api/plugins/config?accountId=${encodeURIComponent(account)}&name=${encodeURIComponent(plugin)}`);
  if (!configTarget) return;
  renderPluginForm($('plugin-config-form'), res.data?.example ?? {}, res.data?.config ?? {});
  setTimeout(syncScrollbars, 0);
}

function closeConfigModal() {
  $('plugin-config-modal').hidden = true;
  configTarget = null;
}

function collectPluginForm(box) {
  const out = {};
  for (const el of box.querySelectorAll('[data-pkey]')) {
    const key = el.dataset.pkey;
    const type = el.dataset.ptype;
    if (type === 'number') out[key] = Number(el.value);
    else if (type === 'boolean') out[key] = el.value === 'true';
    else if (type === 'json') out[key] = JSON.parse(el.value);
    else out[key] = el.value;
  }
  return out;
}

function openAccountEditor(mode, id) {
  accountEditorMode = mode;
  const panel = $('account-editor');
  const raw = mode === 'new'
    ? { id: '', platform: 'onebot11', label: '新账户', enabled: true, adapter: {}, plugins: {} }
    : (configData?.accounts ?? []).find((a) => a.id === id) ?? { id, platform: 'onebot11', enabled: true, adapter: {}, plugins: {} };
  accountDraft = JSON.parse(JSON.stringify(raw));
  panel.hidden = false;
  $('account-editor-title').textContent = mode === 'new' ? '新增账户' : `编辑账户 ${id}`;
  renderAccountFields(accountDraft);
}

$('account-fields').addEventListener('change', (ev) => {
  if (ev.target.dataset.key === 'platform') renderAccountFields(collectAccountFields());
});

document.addEventListener('click', async (ev) => {
  if (ev.target.id === 'plugin-config-modal') {
    closeConfigModal();
    return;
  }
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
    'plugin-config-save': 'plugin-config-save',
    'plugin-config-cancel': 'plugin-config-cancel',
  };
  const btn = ev.target.closest('[data-action], button[id]');
  if (!btn) return;
  const action = btn.dataset.action || idActions[btn.id];
  if (!action) return;

  if (action === 'tab') {
    selectedAccount = btn.dataset.id;
    document.querySelectorAll('#plugin-tabs .tab').forEach((el) => el.classList.toggle('is-active', el.dataset.id === selectedAccount));
    syncTabIndicator();
    renderPluginCards(statusData?.plugins ?? [], statusData?.accounts ?? []);
    return;
  }
  if (action === 'refresh') {
    await loadStatus($('refresh-button'), true);
    if (current === 'logs') await loadLogs();
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
    const raw = collectAccountFields();
    if (!/^[\w.-]+$/.test(raw.id)) {
      hint('account-hint', '账户 ID 不合法', false);
      return;
    }
    const res = await api('PUT', '/api/config/account', raw);
    hint('account-hint', res.ok ? '已保存，新账户需重启生效' : '保存失败', res.ok);
    if (res.ok) {
      $('account-editor').hidden = true;
      await loadConfig();
      await loadStatus();
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
    await openConfigModal(btn.dataset.account, btn.dataset.plugin);
    return;
  }
  if (action === 'plugin-config-save') {
    if (!configTarget) return;
    try {
      const config = collectPluginForm($('plugin-config-form'));
      const res = await api('PUT', '/api/plugins/config', { accountId: configTarget.account, name: configTarget.plugin, config });
      hint('plugin-config-hint', res.ok ? '已保存并重载' : '保存失败', res.ok);
      if (res.ok) setTimeout(closeConfigModal, 500);
    } catch {
      hint('plugin-config-hint', '内容格式错误', false);
    }
    return;
  }
  if (action === 'plugin-config-cancel') {
    closeConfigModal();
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

window.addEventListener('hashchange', () => setView(location.hash.replace('#', '')));
window.addEventListener('resize', syncTabIndicator);

document.addEventListener('keydown', (ev) => {
  if (ev.key === 'Escape' && !$('plugin-config-modal').hidden) closeConfigModal();
});

function mountScrollbars() {
  const Lib = window['dumogu-scrollbar']?.DumoguScrollbar;
  if (!Lib) return;
  for (const el of [document.documentElement, $('terminal'), document.querySelector('.modal__panel')]) {
    if (!el) continue;
    try {
      const bar = new Lib({ keepShow: true });
      bar.bind(el);
      scrollBars.push(bar);
    } catch (e) {
      console.warn('滚动条挂载失败', e);
    }
  }
}

function syncScrollbars() {
  for (const bar of scrollBars) {
    try {
      bar.update();
    } catch {}
  }
}

mountScrollbars();
setView(location.hash.replace('#', '') || 'dashboard');
loadStatus();
setInterval(() => {
  if (statusData) $('uptime-value').textContent = fmtUptime(statusData.uptime + (Date.now() - statusData.at));
}, 1000);
