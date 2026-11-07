// WifePicker 数据层：按群隔离，一个 JSON 文件里分群存放
import * as fs from 'node:fs';
import * as path from 'node:path';

/** 老婆记录（抽取或强娶） */
export interface WifeRecord {
  user_id: string;
  wife_id: string;
  wife_name: string;
  date: string;
  forced: boolean;
}

/** 求婚记录 */
export interface ProposeRecord {
  proposer_id: string;
  target_id: string;
  proposer_name: string;
  target_name: string;
  date: string;
  accepted: boolean;
}

export interface GroupData {
  records: WifeRecord[];
  proposes: ProposeRecord[];
  rbq: Record<string, number>;
  active: Record<string, number>;
  forceCd: Record<string, string>;
  /** 关系图最近一次定时推送的日期 */
  graphReported: string;
}

interface WpData {
  version: number;
  groups: Record<string, GroupData>;
}

const KEEP_DAYS = 30;

/** 今天日期（北京时间 YYYY-MM-DD） */
export function todayStr(ts = Date.now()): string {
  const d = new Date(ts + 8 * 3600 * 1000);
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${d.getUTCFullYear()}-${pad(d.getUTCMonth() + 1)}-${pad(d.getUTCDate())}`;
}

function emptyGroup(): GroupData {
  return { records: [], proposes: [], rbq: {}, active: {}, forceCd: {}, graphReported: '' };
}

function dedupe(records: WifeRecord[]): WifeRecord[] {
  const seen = new Set<string>();
  return records.filter((r) => {
    const key = `${r.user_id}\u0000${r.wife_id}\u0000${r.date}\u0000${r.forced ? 'f' : 'd'}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

export class WpStore {
  private data: WpData;

  constructor(
    private readonly file: string,
    private readonly log: (level: string, msg: string) => void,
  ) {
    this.data = this.load();
  }

  private load(): WpData {
    try {
      if (fs.existsSync(this.file)) {
        const parsed = JSON.parse(fs.readFileSync(this.file, 'utf8'));
        if (parsed?.groups && typeof parsed.groups === 'object') {
          return { version: 2, groups: parsed.groups };
        }
        if (Array.isArray(parsed?.records)) this.log('warn', '检测到旧的全局数据，已忽略（改为按群存储）');
      }
    } catch (e: any) {
      this.log('warn', `读取数据失败 ${e.message}`);
    }
    return { version: 2, groups: {} };
  }

  save(): void {
    try {
      fs.mkdirSync(path.dirname(this.file), { recursive: true });
      fs.writeFileSync(this.file, JSON.stringify(this.data), 'utf8');
    } catch (e: any) {
      this.log('warn', `保存数据失败 ${e.message}`);
    }
  }

  group(groupId: string): GroupData {
    const key = String(groupId || '');
    const cur = this.data.groups[key];
    if (cur) return cur;
    const created = emptyGroup();
    this.data.groups[key] = created;
    return created;
  }

  groupIds(): string[] {
    return Object.keys(this.data.groups);
  }

  addRecord(groupId: string, rec: WifeRecord): void {
    const g = this.group(groupId);
    const dup = g.records.some(
      (r) => r.user_id === rec.user_id && r.wife_id === rec.wife_id && r.date === rec.date && r.forced === rec.forced,
    );
    if (!dup) g.records.push(rec);
    this.prune(g);
  }

  getTodayRecords(groupId: string, userId?: string): WifeRecord[] {
    const today = todayStr();
    return this.group(groupId).records.filter((r) => r.date === today && (!userId || r.user_id === userId));
  }

  addPropose(groupId: string, rec: ProposeRecord): void {
    const g = this.group(groupId);
    g.proposes.push(rec);
    this.prune(g);
  }

  getTodayProposes(groupId: string): ProposeRecord[] {
    const today = todayStr();
    return this.group(groupId).proposes.filter((r) => r.date === today);
  }

  addRbq(groupId: string, uid: string): void {
    const g = this.group(groupId);
    if (!uid) return;
    g.rbq[uid] = (g.rbq[uid] || 0) + 1;
  }

  getRbqRanking(groupId: string): Array<{ uid: string; count: number }> {
    return Object.entries(this.group(groupId).rbq)
      .map(([uid, count]) => ({ uid, count }))
      .sort((a, b) => b.count - a.count);
  }

  recordActive(groupId: string, uid: string, ts: number): void {
    if (!uid) return;
    this.group(groupId).active[uid] = ts;
  }

  activeSince(groupId: string, sinceTs: number): Set<string> {
    const g = this.group(groupId);
    return new Set(Object.entries(g.active).filter(([, ts]) => ts >= sinceTs).map(([uid]) => uid));
  }

  forceMarryDate(groupId: string, uid: string): string {
    return this.group(groupId).forceCd[uid] ?? '';
  }

  setForceMarryDate(groupId: string, uid: string, date: string): void {
    this.group(groupId).forceCd[uid] = date;
  }

  graphReported(groupId: string): string {
    return this.group(groupId).graphReported;
  }

  markGraphReported(groupId: string, date: string): void {
    this.group(groupId).graphReported = date;
  }

  /** 只保留最近 30 天的记录，活跃与冷却表同步瘦身 */
  private prune(g: GroupData): void {
    const cutoff = todayStr(Date.now() - KEEP_DAYS * 86400000);
    if (g.records.length > 500) g.records = g.records.filter((r) => r.date >= cutoff);
    if (g.proposes.length > 500) g.proposes = g.proposes.filter((r) => r.date >= cutoff);
    const keepTs = Date.now() - KEEP_DAYS * 86400000;
    const active = Object.entries(g.active).filter(([, ts]) => ts >= keepTs);
    if (active.length !== Object.keys(g.active).length) g.active = Object.fromEntries(active);
    const cd = Object.entries(g.forceCd).filter(([, d]) => d >= cutoff);
    if (cd.length !== Object.keys(g.forceCd).length) g.forceCd = Object.fromEntries(cd);
  }
}
