// TalkCount 数据存储：按 UTC+8 日期分桶，群隔离，定时自动落盘
import * as fs from 'fs';
import * as path from 'path';

export interface TalkEntry {
  c: number;
  n: string;
}

export interface TalkData {
  days: Record<string, Record<string, Record<string, TalkEntry>>>;
  lastReportedDate: string;
  /** 日期 → 已推送过的群，避免重复推送 */
  reported: Record<string, string[]>;
}

export interface RankItem {
  uid: string;
  name: string;
  count: number;
}

/** 当前 UTC+8 日期字符串（YYYY-MM-DD） */
export function todayStrUTC8(d: Date = new Date()): string {
  const utc = d.getTime() + 8 * 3600 * 1000;
  const dt = new Date(utc);
  const p = (n: number) => (n < 10 ? '0' + n : '' + n);
  return `${dt.getUTCFullYear()}-${p(dt.getUTCMonth() + 1)}-${p(dt.getUTCDate())}`;
}

export class TalkStore {
  private file: string;
  private data: TalkData;
  private log: (level: string, ...args: any[]) => void;
  private saveTimer: ReturnType<typeof setInterval> | null = null;
  private saveIntervalMs: number;

  constructor(file: string, saveIntervalMs: number, log: (level: string, ...args: any[]) => void) {
    this.file = file;
    this.saveIntervalMs = saveIntervalMs;
    this.log = log;
    this.data = this.load();
    this.startAutoSave();
  }

  get lastReportedDate(): string {
    return this.data.lastReportedDate;
  }

  private load(): TalkData {
    if (fs.existsSync(this.file)) {
      try {
        const parsed = JSON.parse(fs.readFileSync(this.file, 'utf8'));
        return {
          days: parsed.days || {},
          lastReportedDate: parsed.lastReportedDate || '',
          reported: parsed.reported || {},
        };
      } catch (e: any) {
        this.log('warn', `读取计数数据失败: ${e.message}`);
      }
    }
    return { days: {}, lastReportedDate: '', reported: {} };
  }

  /** 每 saveIntervalMs 自动落盘一次 */
  private startAutoSave(): void {
    if (this.saveTimer) return;
    this.saveTimer = setInterval(() => this.save(), this.saveIntervalMs);
    if ((this.saveTimer as any).unref) (this.saveTimer as any).unref();
  }

  /** 累计一次发言（群隔离） */
  record(groupId: string, uid: string, name: string, date: string): void {
    const day = this.data.days[date] || (this.data.days[date] = {});
    const grp = day[groupId] || (day[groupId] = {});
    const e = grp[uid] || (grp[uid] = { c: 0, n: name || uid });
    e.c += 1;
    if (name) e.n = name;
  }

  /** 某群某天的排行（次数降序，次数相同时按昵称稳定排序） */
  ranking(date: string, groupId: string): RankItem[] {
    const day = this.data.days[date];
    if (!day) return [];
    const grp = day[groupId];
    if (!grp) return [];
    return Object.entries(grp)
      .map(([uid, e]) => ({ uid, name: e.n || uid, count: e.c }))
      .sort((a, b) => b.count - a.count || a.name.localeCompare(b.name, 'zh'));
  }

  /** 某天有发言记录的群列表 */
  groupsWithData(date: string): string[] {
    const day = this.data.days[date];
    return day ? Object.keys(day) : [];
  }

  /** 某群某天总发言次数 */
  total(date: string, groupId: string): number {
    return this.ranking(date, groupId).reduce((s, x) => s + x.count, 0);
  }

  /** N 天前的 UTC+8 日期字符串 */
  private cutoffDate(days: number): string {
    const d = new Date(Date.now() + 8 * 3600000 - days * 86400000);
    const p = (n: number) => (n < 10 ? '0' + n : '' + n);
    return `${d.getUTCFullYear()}-${p(d.getUTCMonth() + 1)}-${p(d.getUTCDate())}`;
  }

  /** 标记某天已上报，并清理 7 天前的旧数据 */
  markReported(date: string): void {
    this.data.lastReportedDate = date;
    const cutoff = this.cutoffDate(7);
    for (const key of Object.keys(this.data.days)) {
      if (key < cutoff) delete this.data.days[key];
    }
    for (const key of Object.keys(this.data.reported)) {
      if (key < cutoff) delete this.data.reported[key];
    }
  }

  /** 某天某群是否已推送过定时排行榜 */
  reportedGroups(date: string): string[] {
    return this.data.reported[date] ?? [];
  }

  /** 记录某天某群已推送 */
  markGroupReported(date: string, groupId: string): void {
    const list = this.data.reported[date] ?? (this.data.reported[date] = []);
    if (!list.includes(groupId)) list.push(groupId);
  }

  /** 静态方法：读取指定群最近 N 天的活跃用户 ID（供 WifePicker 调用，不实例化） */
  static getActiveUidsSince(filePath: string, since: string, groupId: string): Set<string> {
    const uids = new Set<string>();
    try {
      if (!fs.existsSync(filePath)) return uids;
      const data = JSON.parse(fs.readFileSync(filePath, 'utf8'));
      const days = data?.days || {};
      for (const [date, groups] of Object.entries(days)) {
        if (date < since) continue;
        const grp = (groups as any)[groupId];
        if (grp) for (const uid of Object.keys(grp)) uids.add(uid);
      }
    } catch {}
    return uids;
  }

  /** 需要补报的日期：早于今天、未标记上报且当天有数据（取最早一天） */
  pendingReportDate(today: string): string | null {
    const dates = Object.keys(this.data.days)
      .filter((d) => d < today && d !== this.data.lastReportedDate)
      .sort();
    return dates.length ? dates[0] : null;
  }

  save(): void {
    try {
      fs.mkdirSync(path.dirname(this.file), { recursive: true });
      fs.writeFileSync(this.file, JSON.stringify(this.data), 'utf8');
      this.log('debug', `已写入计数数据 (${this.file})`);
    } catch (e: any) {
      this.log('warn', `写入计数数据失败: ${e.message}`);
    }
  }

  dispose(): void {
    if (this.saveTimer) {
      clearInterval(this.saveTimer);
      this.saveTimer = null;
    }
    this.save();
  }
}
