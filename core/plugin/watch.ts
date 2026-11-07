import fs from 'node:fs';
import path from 'node:path';
import { PLUGINS_DIR, ROOT } from '../config/paths.ts';
import type { PluginHost } from './host.ts';
import type { Logger } from '../types.ts';

/** 变更后合并的等待时间，避开编辑器多次写入 */
const DEBOUNCE_MS = 250;
/** 核心目录变更提示的最小间隔 */
const CORE_NOTICE_MS = 4000;

const WATCHED_EXT = /\.(ts|js|mjs|cjs|json)$/;
const IGNORED = /(^|[\\/])\.|~$|\.tmp$|\.swp$/;

export class PluginWatcher {
  private pluginWatcher: fs.FSWatcher | null = null;
  private coreWatcher: fs.FSWatcher | null = null;
  private timers = new Map<string, NodeJS.Timeout>();
  private busy = new Set<string>();
  private queued = new Set<string>();
  private coreNoticeAt = 0;

  constructor(
    private readonly host: PluginHost,
    private readonly log: Logger,
  ) {}

  start(): void {
    if (this.pluginWatcher) return;
    this.watchPlugins();
    this.watchCore();
  }

  stop(): void {
    this.pluginWatcher?.close();
    this.coreWatcher?.close();
    for (const timer of this.timers.values()) clearTimeout(timer);
    this.timers.clear();
    this.pluginWatcher = null;
    this.coreWatcher = null;
  }

  private watchPlugins(): void {
    if (!fs.existsSync(PLUGINS_DIR)) return;
    try {
      this.pluginWatcher = fs.watch(PLUGINS_DIR, { recursive: true }, (_event, file) => {
        if (!file) return;
        const rel = String(file);
        if (IGNORED.test(rel) || !WATCHED_EXT.test(rel)) return;
        const name = rel.split(/[\\/]/)[0];
        if (!name) return;
        this.schedule(name);
      });
      this.pluginWatcher.on('error', (e: any) => this.log.warn(`插件监听异常 ${e?.message ?? e}`));
      this.log.info('插件热重载已启用');
    } catch (e: any) {
      this.log.warn(`插件监听启动失败 ${e?.message ?? e}`);
    }
  }

  private watchCore(): void {
    try {
      this.coreWatcher = fs.watch(path.join(ROOT, 'core'), { recursive: true }, (_event, file) => {
        if (!file) return;
        const rel = String(file);
        if (IGNORED.test(rel) || !/\.(ts|js|mjs|cjs)$/.test(rel)) return;
        const now = Date.now();
        if (now - this.coreNoticeAt < CORE_NOTICE_MS) return;
        this.coreNoticeAt = now;
        this.log.warn(`核心代码已变更 core/${rel.split(/[\\/]/).join('/')}，需重启进程生效`);
      });
      this.coreWatcher.on('error', () => {});
    } catch {}
  }

  private schedule(name: string): void {
    const old = this.timers.get(name);
    if (old) clearTimeout(old);
    this.timers.set(
      name,
      setTimeout(() => {
        this.timers.delete(name);
        void this.reload(name);
      }, DEBOUNCE_MS),
    );
  }

  /** 同一插件串行重载，重载期间的新变更排队再跑一次 */
  private async reload(name: string): Promise<void> {
    if (this.busy.has(name)) {
      this.queued.add(name);
      return;
    }
    this.busy.add(name);
    try {
      const result = await this.host.reloadPlugin(name);
      if (result === 'reloaded') this.log.info(`${name} 已热重载`);
      else if (result === 'removed') this.log.info(`${name} 已移除，插件已卸载`);
      else this.log.debug(`${name} 变更但未在运行，跳过重载`);
    } catch (e: any) {
      this.log.error(`${name} 热重载失败 ${e?.message ?? e}`);
    } finally {
      this.busy.delete(name);
      if (this.queued.delete(name)) this.schedule(name);
    }
  }
}
