import { createLogger, setLogLevel, totalErrors } from './log.ts';
import {
  ensureAccountRuntime,
  ensureLayout,
  listAccountConfigs,
  listAccountIds,
  listPlugins,
  loadAccount,
  loadGlobal,
  pluginExampleConfig,
  readAccountState,
  readPluginUserConfig,
  saveAccountConfig,
  savePluginUserConfig,
  updateAccount,
  updateGlobal,
  writeAccountState,
} from './config/loader.ts';
import { PluginHost } from './plugin/host.ts';
import { createAdapter, knownPlatforms } from './adapters/registry.ts';
import { startWebUi } from './webui/server.ts';
import { VERSION } from './version.ts';
import { isBuiltinCommand } from './builtin.ts';
import type { AccountConfig, Adapter, GlobalConfig, MessageEvent, PluginManifest } from './types.ts';

export class App {
  private log = createLogger('app');
  private startedAt = Date.now();
  global!: GlobalConfig;
  manifests: PluginManifest[] = [];
  host!: PluginHost;
  adapters = new Map<string, Adapter>();
  accounts = new Map<string, AccountConfig>();
  private messages = 0;

  async start(): Promise<void> {
    const { created } = ensureLayout();
    this.global = loadGlobal();
    setLogLevel(this.global.logLevel);
    if (created) this.log.info('已生成 data/bot.json');

    this.manifests = listPlugins();
    this.host = new PluginHost(
      () => this.global,
      this.manifests,
      (evt) => !isBuiltinCommand(evt.text),
    );

    const ids = listAccountIds();
    if (ids.length === 0) {
      this.log.warn('未找到账户，仅启动 WebUI');
      this.log.info(`可用平台: ${knownPlatforms().join(', ')}`);
    }

    for (const id of ids) {
      const account = loadAccount(id);
      if (!account) continue;
      if (!account.enabled) {
        this.log.info(`${id} 已禁用，跳过`);
        continue;
      }
      await this.attachAccount(account);
    }

    if (this.global.webui.enabled) {
      startWebUi(this.global.webui.host, this.global.webui.port, {
        status: () => this.snapshot(),
        config: () => this.configForWeb(),
        toggle: (a, n, e) => this.togglePlugin(a, n, e),
        saveGlobal: (patch) => this.updateGlobalFromWeb(patch),
        saveAccount: (cfg) => this.saveAccountFromWeb(cfg),
        accountState: (id, running) => this.setAccountRunning(id, running),
        pluginConfig: (a, n) => this.getPluginConfig(a, n),
        savePluginConfig: (a, n, c) => this.setPluginConfig(a, n, c),
        checkKey: (key) => this.checkKey(key),
        consoleKey: () => this.global.consolePassword ?? '',
      });
    }
  }

  snapshot() {
    const mem = process.memoryUsage();
    return {
      at: Date.now(),
      version: VERSION,
      uptime: Date.now() - this.startedAt,
      node: process.version,
      os: `${process.platform} ${process.arch}`,
      memory: {
        rss: Math.round(mem.rss / 1048576),
        heapUsed: Math.round(mem.heapUsed / 1048576),
      },
      config: this.publicGlobal(),
      stats: { messages: this.messages, errors: totalErrors() },
      accounts: [...this.accounts.values()].map((a) => {
        const adapter = this.adapters.get(a.id);
        const runtime = this.host.get(a.id);
        return {
          id: a.id,
          platform: a.platform,
          label: a.label ?? a.id,
          online: Boolean(adapter?.status().online),
          selfId: adapter?.selfId ?? '',
          pluginCount: runtime?.list().length ?? 0,
          commandCount: runtime?.router.commandNames().length ?? 0,
        };
      }),
      plugins: this.manifests.map((m) => ({
        name: m.name,
        version: m.version,
        description: m.description ?? '',
        enabled: [...this.accounts.values()].map((a) => ({
          accountId: a.id,
          enabled: Boolean(this.host.get(a.id)?.isEnabled(m.name)),
        })),
      })),
    };
  }

  configForWeb() {
    return { global: this.publicGlobal(), accounts: listAccountConfigs() };
  }

  checkKey(key: string | undefined): boolean {
    const password = this.global.consolePassword;
    return !password || key === password;
  }

  updateGlobalFromWeb(patch: Record<string, unknown>): boolean {
    this.global = updateGlobal(patch);
    setLogLevel(this.global.logLevel);
    this.log.info('全局配置已更新');
    return true;
  }

  async saveAccountFromWeb(raw: AccountConfig): Promise<boolean> {
    if (!raw || !raw.id || !raw.platform) return false;
    const wasOnline = Boolean(this.adapters.get(raw.id)?.status().online);
    const plugins = this.accounts.get(raw.id)?.plugins ?? loadAccount(raw.id)?.plugins ?? {};
    saveAccountConfig({ ...raw, plugins });
    await this.detachAccount(raw.id);
    const fresh = loadAccount(raw.id);
    if (fresh && fresh.enabled) await this.attachAccount(fresh, wasOnline);
    this.log.info(`账户配置已保存 ${raw.id}`);
    return true;
  }

  async setAccountRunning(id: string, running: boolean): Promise<boolean> {
    const adapter = this.adapters.get(id);
    if (!adapter) return false;
    if (running) void adapter.start().catch((e: any) => this.log.error(`${id} 启动失败`, e?.message ?? e));
    else await adapter.stop();
    this.log.info(`${id} 已${running ? '启动' : '停止'}`);
    return true;
  }

  getPluginConfig(accountId: string, name: string) {
    return {
      config: readPluginUserConfig(accountId, name),
      example: pluginExampleConfig(name),
    };
  }

  async setPluginConfig(accountId: string, name: string, config: Record<string, unknown>): Promise<boolean> {
    savePluginUserConfig(accountId, name, config);
    const runtime = this.host.get(accountId);
    if (runtime) await runtime.reload(name);
    this.log.info(`${accountId} / ${name} 配置已更新`);
    return true;
  }

  async togglePlugin(accountId: string, name: string, enabled: boolean): Promise<boolean> {
    const account = this.accounts.get(accountId);
    const runtime = this.host.get(accountId);
    const manifest = this.manifests.find((m) => m.name === name);
    if (!account || !runtime || !manifest) return false;

    const plugins = { ...(account.plugins ?? {}) };
    plugins[name] = { ...(plugins[name] ?? {}), enabled };
    account.plugins = plugins;
    updateAccount(accountId, { plugins });

    if (enabled) await runtime.mount(manifest);
    else await runtime.unmount(name);
    this.log.info(`${accountId} / ${name} 已${enabled ? '启用' : '停用'}`);
    return true;
  }

  async stop(): Promise<void> {
    for (const adapter of this.adapters.values()) {
      try {
        await adapter.stop();
      } catch {}
    }
    await this.host.stopAll();
    this.log.info('已停止');
  }

  private async attachAccount(account: AccountConfig, autoStart = true): Promise<void> {
    const id = account.id;
    ensureAccountRuntime(id);
    const adapter = createAdapter(
      account,
      () => readAccountState(id),
      (patch) => writeAccountState(id, { ...readAccountState(id), ...patch }),
    );
    if (!adapter) {
      this.log.error(`${id} 平台不支持: ${account.platform}`);
      return;
    }
    this.accounts.set(id, account);
    this.adapters.set(id, adapter);
    await this.host.attach(account, adapter);
    adapter.onMessage((evt) => {
      this.messages++;
      this.builtinCommand(adapter, evt);
    });
    if (autoStart) void adapter.start().catch((e: any) => this.log.error(`${id} 启动失败`, e?.message ?? e));
  }

  private async detachAccount(id: string): Promise<void> {
    const adapter = this.adapters.get(id);
    if (adapter) {
      try {
        await adapter.stop();
      } catch {}
      this.adapters.delete(id);
    }
    await this.host.detach(id);
    this.accounts.delete(id);
  }

  private publicGlobal(): Omit<GlobalConfig, 'consolePassword'> {
    const { consolePassword, ...rest } = this.global;
    return rest;
  }

  private builtinCommand(adapter: Adapter, evt: MessageEvent): void {
    if (!isBuiltinCommand(evt.text)) return;
    const reply = `Lysel ${VERSION}\nRunning ${this.formatUptime()}\n${this.manifests.length} Plugins`;
    void adapter.send({ scene: evt.scene, id: evt.peerId }, [{ type: 'text', text: reply }]).catch((e: any) =>
      this.log.error('内置命令回复失败', e?.message ?? e),
    );
  }

  private formatUptime(): string {
    const s = Math.floor((Date.now() - this.startedAt) / 1000);
    const pad = (n: number) => String(n).padStart(2, '0');
    const days = Math.floor(s / 86400);
    const clock = `${pad(Math.floor((s % 86400) / 3600))}:${pad(Math.floor((s % 3600) / 60))}:${pad(s % 60)}`;
    return days ? `${days}:${clock}` : clock;
  }
}
