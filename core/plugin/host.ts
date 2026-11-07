import { createLogger } from '../log.ts';
import { Dispatcher } from '../dispatcher.ts';
import { Router } from '../router.ts';
import { resolvePluginConfig, readPluginManifest } from '../config/loader.ts';
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

/** 日志里截断长文本，避免刷屏 */
function clip(text: string | undefined, max = 120): string {
  const s = String(text ?? '').replace(/\s+/g, ' ');
  return s.length > max ? `${s.slice(0, max)}…(${s.length})` : s;
}

/** 配置里的密钥类字段打码，超长字符串截断 */
function redact(value: unknown, depth = 0): unknown {
  if (value === null || typeof value !== 'object') {
    if (typeof value === 'string' && value.length > 160) return `${value.slice(0, 160)}…(${value.length})`;
    return value;
  }
  if (depth > 3) return '…';
  if (Array.isArray(value)) {
    const head = value.slice(0, 8).map((v) => redact(v, depth + 1));
    return value.length > 8 ? [...head, `…共 ${value.length} 项`] : head;
  }
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
    out[k] = /key|token|secret|password|passwd/i.test(k) && typeof v === 'string' ? '***' : redact(v, depth + 1);
  }
  return out;
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
    private readonly getGlobal: () => GlobalConfig,
  ) {
    this.log = createLogger(`plugin:${account.id}`);
    this.dispatcher = new Dispatcher(this.router, this.log, () => this.getGlobal().commandPrefix);
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
    const global = this.getGlobal().plugins?.[name]?.enabled;
    return global !== false;
  }

  has(name: string): boolean {
    return this.mounted.has(name);
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

  async mount(manifest: PluginManifest, preloaded?: PluginModule): Promise<void> {
    const name = manifest.name;
    if (this.mounted.has(name)) return;
    if (!this.isEnabled(name)) {
      this.log.debug(`${name} 在该账户未启用`);
      return;
    }

    const dir = ensurePluginData(this.account.id, name);
    const config = resolvePluginConfig(name, this.getGlobal(), this.account, readUserConfig(dir));
    const storage = new FileStorage(`${dir}/storage`);
    const log = createLogger(`plugin:${this.account.id}:${name}`);
    const scopedPrefixes = Array.isArray(this.account.prefixes) && this.account.prefixes.length
      ? this.account.prefixes
      : this.getGlobal().prefixes ?? [];

    let context: PluginContext;
    context = createContext({
      name,
      account: this.ref,
      config,
      prefixes: scopedPrefixes,
      storage,
      adapter: this.adapter,
      router: this.router,
      log,
      schedule: (id, ms, fn) => this.schedule(name, id, ms, fn),
    });

    const module = preloaded ?? (await importPlugin(name, manifest));
    await module.onLoad?.(context);
    this.mounted.set(name, { manifest, module, context });
    log.debug(`生效配置 ${JSON.stringify(redact(config))}`);
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

  /** 用磁盘上的最新 manifest 重载，代码与元数据同时生效 */
  async reloadWith(manifest: PluginManifest): Promise<void> {
    // 先导入新代码：失败时旧插件仍在运行，避免热重载把插件弄丢
    const module = await importPlugin(manifest.name, manifest);
    await this.unmount(manifest.name);
    await this.mount(manifest, module);
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
    private readonly getGlobal: () => GlobalConfig,
    private readonly manifests: PluginManifest[],
    private readonly shouldHandle: (evt: MessageEvent) => boolean = () => true,
  ) {}

  async attach(account: AccountConfig, adapter: Adapter): Promise<AccountRuntime> {
    const runtime = new AccountRuntime(account, adapter, this.getGlobal);
    this.runtimes.set(account.id, runtime);
    const log = createLogger(`plugin:${account.id}`);
    adapter.onMessage((evt) => {
      const accept = this.shouldHandle(evt);
      log.debug(
        `收到 ${evt.scene} ${evt.peerId} ${evt.sender.name || evt.sender.id}(${evt.sender.id}) ` +
          `类型=${evt.segments.map((s) => s.type).join(',') || 'text'} 内容=${clip(evt.text)}` +
          (accept ? '' : ' → 内置命令，不派发插件'),
      );
      if (accept) runtime.dispatch(evt);
    });
    await runtime.mountAll(this.manifests);
    return runtime;
  }

  get(accountId: string): AccountRuntime | undefined {
    return this.runtimes.get(accountId);
  }

  /**
   * 按磁盘内容重载单个插件：代码、manifest 同步刷新。
   * 目录消失则从清单移除并卸载；此前未挂载该插件的账户保持不动。
   */
  async reloadPlugin(name: string): Promise<'reloaded' | 'removed' | 'skipped'> {
    const manifest = readPluginManifest(name);
    const index = this.manifests.findIndex((m) => m.name === name);

    if (!manifest) {
      if (index >= 0) this.manifests.splice(index, 1);
      let touched = false;
      for (const runtime of this.runtimes.values()) {
        if (runtime.has(name)) {
          await runtime.unmount(name);
          touched = true;
        }
      }
      return touched ? 'removed' : 'skipped';
    }

    if (index >= 0) this.manifests[index] = manifest;
    else this.manifests.push(manifest);

    let touched = false;
    for (const runtime of this.runtimes.values()) {
      if (!runtime.has(name)) continue;
      try {
        await runtime.reloadWith(manifest);
        touched = true;
      } catch (e: any) {
        this.log.error(`${name} 热重载失败，保留旧版本`, e?.message ?? e);
      }
    }
    return touched ? 'reloaded' : 'skipped';
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
