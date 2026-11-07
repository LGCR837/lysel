// Oyasumi 作息插件（移植自 astrbot_plugin_oyasumi，保留最基本功能）
// 功能：早晚安正则触发记录睡眠会话 + 统计查询 + 会话列表/修正
// 存储：插件目录 data/oyasumi.json（纯 JSON，无外部依赖）
import fs from 'fs';
import path from 'path';

// ===== 类型定义 =====

type SessionStatus = 'open' | 'closed' | 'abandoned';

interface SleepSession {
  id: number;
  user_id: string;
  sleep_time: string | null; // ISO 格式
  wake_time: string | null;
  status: SessionStatus;
  source: string; // regex | auto_fill | manual_edit
  is_auto_filled: boolean;
  created_at: string;
}

interface OyEvent {
  id: number;
  user_id: string;
  event_type: string; // good_night | good_morning | manual_edit
  event_time: string;
  session_id: number | null;
  status: string;
  raw_message: string;
}

interface OyData {
  next_session_id: number;
  next_event_id: number;
  sessions: SleepSession[];
  events: OyEvent[];
}

const STATUS_OPEN = 'open';
const STATUS_CLOSED = 'closed';
const STATUS_ABANDONED = 'abandoned';
const EVENT_NIGHT = 'good_night';
const EVENT_MORNING = 'good_morning';

/** UTC+8 偏移（毫秒）——所有展示/解析时间强制使用北京时间，避免受系统时区影响 */
const UTC8_MS = 8 * 3600 * 1000;

/** 秒级/毫秒级时间戳 → 北京时间 ISO（去掉毫秒，YYYY-MM-DDTHH:MM:SS） */
export function toIso(d: Date): string {
  const utc8 = new Date(d.getTime() + UTC8_MS);
  const pad = (n: number) => String(n).padStart(2, '0');
  return (
    `${utc8.getUTCFullYear()}-${pad(utc8.getUTCMonth() + 1)}-${pad(utc8.getUTCDate())}T` +
    `${pad(utc8.getUTCHours())}:${pad(utc8.getUTCMinutes())}:${pad(utc8.getUTCSeconds())}`
  );
}

/** 解析无时区 ISO（YYYY-MM-DDTHH:MM:SS，北京时间）为 Date */
export function parseUtc8Iso(iso: string): Date {
  const m = iso.match(/^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})$/);
  if (!m) return new Date(iso);
  return new Date(Date.UTC(+m[1], +m[2] - 1, +m[3], +m[4], +m[5], +m[6]) - UTC8_MS);
}

/** 解析用户输入的时间文本：YYYY-MM-DD / YYYY-MM-DDTHH:MM / YYYY-MM-DDTHH:MM:SS（按北京时间） */
export function parseDtLike(value: string): Date | null {
  if (!value) return null;
  const s = value.trim();
  const m1 = s.match(/^(\d{4})-(\d{2})-(\d{2})$/);
  if (m1) return new Date(Date.UTC(+m1[1], +m1[2] - 1, +m1[3]) - UTC8_MS);
  const m2 = s.match(/^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})$/);
  if (m2) return new Date(Date.UTC(+m2[1], +m2[2] - 1, +m2[3], +m2[4], +m2[5]) - UTC8_MS);
  const m3 = s.match(/^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})$/);
  if (m3) return new Date(Date.UTC(+m3[1], +m3[2] - 1, +m3[3], +m3[4], +m3[5], +m3[6]) - UTC8_MS);
  return null;
}

/** 时长（分钟）人性化显示：3小时25分钟 */
export function formatDurationHuman(minutes: number | null | undefined): string {
  if (minutes === null || minutes === undefined) return '-';
  if (minutes < 0) return '0分钟';
  const h = Math.floor(minutes / 60);
  const m = minutes % 60;
  if (h === 0) return `${m}分钟`;
  return `${h}小时${m}分钟`;
}

/** 会话时长（分钟） */
export function sessionDuration(s: SleepSession): number | null {
  if (!s.sleep_time || !s.wake_time) return null;
  const sleep = parseUtc8Iso(s.sleep_time).getTime();
  const wake = parseUtc8Iso(s.wake_time).getTime();
  if (Number.isNaN(sleep) || Number.isNaN(wake)) return null;
  return Math.max(0, Math.floor((wake - sleep) / 60000));
}

// ===== 存储层（JSON 文件）=====

export class OyStore {
  private file: string;
  private data: OyData;

  constructor(file: string) {
    this.file = file;
    this.data = this.load();
  }

  private load(): OyData {
    try {
      if (fs.existsSync(this.file)) {
        const parsed = JSON.parse(fs.readFileSync(this.file, 'utf8'));
        if (parsed && Array.isArray(parsed.sessions)) {
          return {
            next_session_id: parsed.next_session_id || 1,
            next_event_id: parsed.next_event_id || 1,
            sessions: parsed.sessions,
            events: parsed.events || [],
          };
        }
      }
    } catch (e: any) {
      console.warn(`[oyasumi] 读取数据文件失败，使用空数据: ${e.message}`);
    }
    return { next_session_id: 1, next_event_id: 1, sessions: [], events: [] };
  }

  save(): void {
    try {
      fs.mkdirSync(path.dirname(this.file), { recursive: true });
      fs.writeFileSync(this.file, JSON.stringify(this.data, null, 2), 'utf8');
    } catch (e: any) {
      console.warn(`[oyasumi] 保存数据文件失败: ${e.message}`);
    }
  }

  // ===== 会话查询 =====

  getLatestOpenSession(userId: string): SleepSession | null {
    for (let i = this.data.sessions.length - 1; i >= 0; i--) {
      const s = this.data.sessions[i];
      if (s.user_id === userId && s.status === STATUS_OPEN) return s;
    }
    return null;
  }

  getSessionById(id: number): SleepSession | null {
    return this.data.sessions.find((s) => s.id === id) || null;
  }

  getOpenSessionCount(userId?: string): number {
    return this.data.sessions.filter(
      (s) => s.status === STATUS_OPEN && (!userId || s.user_id === userId)
    ).length;
  }

  listSessions(userId: string, limit = 10): SleepSession[] {
    return this.data.sessions
      .filter((s) => s.user_id === userId)
      .sort((a, b) => (a.sleep_time || '').localeCompare(b.sleep_time || ''))
      .slice(-limit)
      .reverse();
  }

  listUserIds(): string[] {
    return Array.from(new Set(this.data.sessions.map((s) => s.user_id)));
  }

  /** 超时未闭合的 open 会话 → abandoned */
  abandonTimeoutOpenSessions(userId: string, before: Date): number {
    let count = 0;
    for (const s of this.data.sessions) {
      if (s.user_id === userId && s.status === STATUS_OPEN && s.sleep_time) {
        if (parseUtc8Iso(s.sleep_time).getTime() < before.getTime()) {
          s.status = STATUS_ABANDONED;
          count++;
        }
      }
    }
    return count;
  }

  // ===== 会话写入 =====

  createOpenSession(userId: string, sleepTime: Date, source = 'regex'): SleepSession {
    const s: SleepSession = {
      id: this.data.next_session_id++,
      user_id: userId,
      sleep_time: toIso(sleepTime),
      wake_time: null,
      status: STATUS_OPEN,
      source,
      is_auto_filled: false,
      created_at: toIso(new Date()),
    };
    this.data.sessions.push(s);
    return s;
  }

  updateOpenSessionSleepTime(id: number, sleepTime: Date): void {
    const s = this.getSessionById(id);
    if (s) s.sleep_time = toIso(sleepTime);
  }

  closeSession(id: number, wakeTime: Date): void {
    const s = this.getSessionById(id);
    if (s) {
      s.wake_time = toIso(wakeTime);
      s.status = STATUS_CLOSED;
    }
  }

  createClosedSession(
    userId: string,
    sleepTime: Date,
    wakeTime: Date,
    source = 'auto_fill',
    isAutoFilled = false
  ): SleepSession {
    const s: SleepSession = {
      id: this.data.next_session_id++,
      user_id: userId,
      sleep_time: toIso(sleepTime),
      wake_time: toIso(wakeTime),
      status: STATUS_CLOSED,
      source,
      is_auto_filled: isAutoFilled,
      created_at: toIso(new Date()),
    };
    this.data.sessions.push(s);
    return s;
  }

  updateSession(id: number, patch: { sleep_time?: Date; wake_time?: Date; status: SessionStatus }): void {
    const s = this.getSessionById(id);
    if (!s) return;
    if (patch.sleep_time) s.sleep_time = toIso(patch.sleep_time);
    if (patch.wake_time) s.wake_time = toIso(patch.wake_time);
    s.status = patch.status;
    s.source = 'manual_edit';
  }

  insertEvent(ev: Omit<OyEvent, 'id'>): void {
    this.data.events.push({ id: this.data.next_event_id++, ...ev });
    // 控制事件表体积
    if (this.data.events.length > 2000) {
      this.data.events = this.data.events.slice(-2000);
    }
  }

  // ===== 统计查询 =====

  /** 统计区间内的闭合会话（含可选自动补全过滤） */
  queryClosedSessions(userId: string | null, start: Date, end: Date, includeAutoFill: boolean): SleepSession[] {
    const startMs = start.getTime();
    const endMs = end.getTime() + 86400000 - 1; // 包含 end 当天
    return this.data.sessions.filter((s) => {
      if (s.status !== STATUS_CLOSED || !s.sleep_time) return false;
      if (userId && s.user_id !== userId) return false;
      if (!includeAutoFill && s.is_auto_filled) return false;
      const t = parseUtc8Iso(s.sleep_time).getTime();
      return t >= startMs && t <= endMs;
    });
  }

  countOrphanMorningEvents(userId: string | null, start: Date, end: Date): number {
    const startMs = start.getTime();
    const endMs = end.getTime() + 86400000 - 1;
    return this.data.events.filter((e) => {
      if (e.event_type !== EVENT_MORNING || e.status !== 'orphan') return false;
      if (userId && e.user_id !== userId) return false;
      const t = parseUtc8Iso(e.event_time).getTime();
      return t >= startMs && t <= endMs;
    }).length;
  }
}
