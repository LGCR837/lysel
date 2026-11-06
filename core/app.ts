import { createLogger, setLogLevel, totalErrors } from './log.ts';
import {
  ensureAccountRuntime,
  ensureLayout,
  listAccountIds,
  listPlugins,
  loadAccount,
  loadGlobal,
  readAccountState,
  updateAccount,
  writeAccountState,
} from './config/loader.ts';
import { PluginHost } from './plugin/host.ts';
import { createAdapter, knownPlatforms } from './adapters/registry.ts';
import { startWebUi } from './webui/server.ts';
import type { AccountConfig, Adapter, GlobalConfig, PluginManifest } from './types.ts';

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
    this.host = new PluginHost(this.global, this.manifests);

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
      ensureAccountRuntime(id);
      const adapter = createAdapter(
        account,
        () => readAccountState(id),
        (patch) => writeAccountState(id, { ...readAccountState(id), ...patch }),
      );
      if (!adapter) {
        this.log.error(`${id} 平台不支持: ${account.platform}`);
        continue;
      }
      this.accounts.set(id, account);
      this.adapters.set(id, adapter);
      await this.host.attach(account, adapter);
      adapter.onMessage(() => {
        this.messages++;
      });
      try {
        void adapter.start().catch((e: any) => this.log.error(`${id} 启动失败`, e?.message ?? e));
      } catch (e: any) {
        this.log.error(`${id} 启动失败`, e?.message ?? e);
      }
    }

    if (this.global.webui.enabled) {
      startWebUi(this.global.webui.host, this.global.webui.port, {
        status: () => this.snapshot(),
        toggle: (accountId, name, enabled) => this.togglePlugin(accountId, name, enabled),
      });
    }
  }

  snapshot() {
    const mem = process.memoryUsage();
    return {
      at: Date.now(),
      uptime: Date.now() - this.startedAt,
      node: process.version,
      os: `${process.platform} ${process.arch}`,
      memory: {
        rss: Math.round(mem.rss / 1048576),
        heapUsed: Math.round(mem.heapUsed / 1048576),
      },
      config: this.global,
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
}
