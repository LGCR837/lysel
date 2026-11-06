import { createLogger } from '../log.ts';
import { Dispatcher } from '../dispatcher.ts';
import { Router } from '../router.ts';
import { resolvePluginConfig } from '../config/loader.ts';
import type {
  AccountConfig,
  AccountRef,
  Adapter,
  GlobalConfig,
  MessageEvent,
  PluginContext,
  PluginManifest,
  PluginModule,
} from '../types.ts';
import { createContext } from './context.ts';
import { ensurePluginData, importPlugin, readUserConfig } from './loader.ts';
import { FileStorage } from './storage.ts';

interface Mounted {
  manifest: PluginManifest;
  module: PluginModule;
  context: PluginContext;
}

export class AccountRuntime {
  readonly router = new Router();
  readonly dispatcher: Dispatcher;
  private log;
  private mounted = new Map<string, Mounted>();
  private timers = new Map<string, NodeJS.Timeout>();

  constructor(
    readonly account: AccountConfig,
    readonly adapter: Adapter,
    private readonly global: GlobalConfig,
  ) {
    this.log = createLogger(`plugin:${account.id}`);
    this.dispatcher = new Dispatcher(this.router, this.log, () => this.global.commandPrefix);
  }

  get ref(): AccountRef {
    const adapter = this.adapter;
    const account = this.account;
    return {
      id: account.id,
      platform: adapter.platform,
      label: account.label ?? account.id,
      get selfId() {
        return adapter.selfId;
      },
      get capabilities() {
        return adapter.capabilities();
      },
    } as AccountRef;
  }

  isEnabled(name: string): boolean {
    const scoped = this.account.plugins?.[name]?.enabled;
    if (typeof scoped === 'boolean') return scoped;
    const global = this.global.plugins?.[name]?.enabled;
    return global !== false;
  }

  async mountAll(manifests: PluginManifest[]): Promise<void> {
    for (const manifest of manifests) {
      try {
        await this.mount(manifest);
      } catch (e: any) {
        this.log.error(`${manifest.name} 加载失败`, e?.message ?? e);
      }
    }
  }

  async mount(manifest: PluginManifest): Promise<void> {
    const name = manifest.name;
    if (this.mounted.has(name)) return;
    if (!this.isEnabled(name)) {
      this.log.debug(`${name} 在该账户未启用`);
      return;
    }

    const dir = ensurePluginData(this.account.id, name);
    const config = resolvePluginConfig(name, this.global, this.account, readUserConfig(dir));
    const storage = new FileStorage(`${dir}/storage`);
    const log = createLogger(`plugin:${this.account.id}:${name}`);

    let context: PluginContext;
    context = createContext({
      name,
      account: this.ref,
      config,
      storage,
      adapter: this.adapter,
      router: this.router,
      log,
      schedule: (id, ms, fn) => this.schedule(name, id, ms, fn),
    });

    const module = await importPlugin(name, manifest);
    await module.onLoad?.(context);
    this.mounted.set(name, { manifest, module, context });
    log.info(`已加载 v${manifest.version}`);
  }

  async unmount(name: string): Promise<void> {
    const item = this.mounted.get(name);
    if (!item) return;
    try {
      await item.module.onUnload?.();
    } catch (e: any) {
      this.log.error(`${name} onUnload 异常`, e?.message ?? e);
    }
    this.router.clearPlugin(name);
    for (const [key, timer] of this.timers) {
      if (key.startsWith(`${name}:`)) {
        clearInterval(timer);
        this.timers.delete(key);
      }
    }
    this.mounted.delete(name);
    this.log.info(`${name} 已卸载`);
  }

  async reload(name: string): Promise<void> {
    const manifest = this.mounted.get(name)?.manifest;
    if (!manifest) return;
    await this.unmount(name);
    await this.mount(manifest);
  }

  dispatch(evt: MessageEvent): void {
    this.dispatcher.dispatch(evt);
  }

  list(): { name: string; version: string; enabled: boolean }[] {
    return [...this.mounted.values()].map((m) => ({
      name: m.manifest.name,
      version: m.manifest.version,
      enabled: true,
    }));
  }

  async stop(): Promise<void> {
    for (const name of [...this.mounted.keys()]) await this.unmount(name);
    for (const timer of this.timers.values()) clearInterval(timer);
    this.timers.clear();
  }

  private schedule(plugin: string, id: string, ms: number, fn: () => void): void {
    const key = `${plugin}:${id}`;
    const old = this.timers.get(key);
    if (old) clearInterval(old);
    const timer = setInterval(() => {
      try {
        fn();
      } catch (e: any) {
        this.log.error(`${plugin} 定时任务异常`, e?.message ?? e);
      }
    }, ms);
    this.timers.set(key, timer);
  }
}

export class PluginHost {
  private runtimes = new Map<string, AccountRuntime>();
  private log = createLogger('plugin');

  constructor(
    private readonly global: GlobalConfig,
    private readonly manifests: PluginManifest[],
  ) {}

  async attach(account: AccountConfig, adapter: Adapter): Promise<AccountRuntime> {
    const runtime = new AccountRuntime(account, adapter, this.global);
    this.runtimes.set(account.id, runtime);
    adapter.onMessage((evt) => runtime.dispatch(evt));
    await runtime.mountAll(this.manifests);
    return runtime;
  }

  get(accountId: string): AccountRuntime | undefined {
    return this.runtimes.get(accountId);
  }

  all(): AccountRuntime[] {
    return [...this.runtimes.values()];
  }

  async detach(accountId: string): Promise<void> {
    const runtime = this.runtimes.get(accountId);
    if (!runtime) return;
    await runtime.stop();
    this.runtimes.delete(accountId);
    this.log.info(`账户 ${accountId} 已卸载插件`);
  }

  async stopAll(): Promise<void> {
    for (const id of [...this.runtimes.keys()]) await this.detach(id);
  }
}
