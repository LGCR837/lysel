// Oyasumi 作息插件主入口（移植自 astrbot_plugin_oyasumi，保留最基本功能）
// 命令：!作息 [状态|统计|看板|会话|修正] （支持别名 !sleep / !oyasumi）
import type { MessageEvent as ParsedMessage, PluginContext } from '../../core/types.ts';
import {
  OyStore,
  toIso,
  parseDtLike,
  parseUtc8Iso,
  formatDurationHuman,
  sessionDuration,
} from './store.ts';

// ===== 触发器（早晚安正则）=====

const EVENT_NIGHT = 'good_night';
const EVENT_MORNING = 'good_morning';

interface TriggerResult {
  event_type: string;
  matched_pattern: string;
}

class TriggerMatcher {
  private nightPatterns: RegExp[] = [];
  private morningPatterns: RegExp[] = [];

  reload(patterns: { night: string[]; morning: string[] }, ignoreCase: boolean): void {
    const flags = ignoreCase ? 'i' : '';
    this.nightPatterns = patterns.night.filter(Boolean).map((p) => this.safeCompile(p, flags)).filter(Boolean) as RegExp[];
    this.morningPatterns = patterns.morning.filter(Boolean).map((p) => this.safeCompile(p, flags)).filter(Boolean) as RegExp[];
  }

  private safeCompile(pattern: string, flags: string): RegExp | null {
    // 基础防灾难性回溯
    if (!pattern || pattern.length > 128) return null;
    try {
      return new RegExp(pattern, flags);
    } catch {
      return null;
    }
  }

  match(text: string): TriggerResult | null {
    if (!text) return null;
    for (const p of this.nightPatterns) {
      if (p.test(text)) return { event_type: EVENT_NIGHT, matched_pattern: p.source };
    }
    for (const p of this.morningPatterns) {
      if (p.test(text)) return { event_type: EVENT_MORNING, matched_pattern: p.source };
    }
    return null;
  }
}

// ===== 会话服务 =====

interface ProcessResult {
  event_type: string;
  action: string;
  session_id: number | null;
  sleep_time: string | null;
  wake_time: string | null;
  duration_minutes: number | null;
  orphaned: boolean;
  auto_filled: boolean;
  open_session_count: number;
  abandoned_count: number;
}

class SessionService {
  constructor(
    private store: OyStore,
    private settings: {
      duplicateNightPolicy: 'ignore' | 'update_open' | 'create_new';
      orphanMorningPolicy: 'warn_only' | 'create_closed_session';
      autoFillDefaultHours: number;
      maxOpenSessionHours: number;
    }
  ) {}

  async processEvent(
    userId: string,
    eventType: string,
    eventTime: Date,
    rawMessage: string,
    matchedPattern: string
  ): Promise<ProcessResult> {
    if (eventType === EVENT_NIGHT) return this.processGoodNight(userId, eventTime, rawMessage, matchedPattern);
    return this.processGoodMorning(userId, eventTime, rawMessage, matchedPattern);
  }

  private processGoodNight(userId: string, eventTime: Date, rawMessage: string, matchedPattern: string): ProcessResult {
    const abandonedCount = this.store.abandonTimeoutOpenSessions(
      userId,
      new Date(eventTime.getTime() - this.settings.maxOpenSessionHours * 3600000)
    );
    const openSession = this.store.getLatestOpenSession(userId);

    let sessionId: number | null = null;
    let action = 'night_open_created';
    let eventStatus = 'processed';
    let sleepTime: string | null = null;

    if (!openSession) {
      const s = this.store.createOpenSession(userId, eventTime);
      sessionId = s.id;
      sleepTime = s.sleep_time;
    } else {
      sessionId = openSession.id;
      const policy = this.settings.duplicateNightPolicy;
      if (policy === 'ignore') {
        action = 'night_duplicate_ignored';
        eventStatus = 'ignored';
        sleepTime = openSession.sleep_time;
      } else if (policy === 'update_open') {
        this.store.updateOpenSessionSleepTime(sessionId, eventTime);
        action = 'night_duplicate_updated_open';
        sleepTime = toIso(eventTime);
      } else {
        const s = this.store.createOpenSession(userId, eventTime);
        sessionId = s.id;
        action = 'night_duplicate_created_new';
        sleepTime = s.sleep_time;
      }
    }

    this.store.insertEvent({
      user_id: userId,
      event_type: EVENT_NIGHT,
      event_time: toIso(eventTime),
      session_id: sessionId,
      status: eventStatus,
      raw_message: rawMessage.slice(0, 200),
    });

    return {
      event_type: EVENT_NIGHT,
      action,
      session_id: sessionId,
      sleep_time: sleepTime,
      wake_time: null,
      duration_minutes: null,
      orphaned: false,
      auto_filled: false,
      open_session_count: this.store.getOpenSessionCount(userId),
      abandoned_count: abandonedCount,
    };
  }

  private processGoodMorning(userId: string, eventTime: Date, rawMessage: string, matchedPattern: string): ProcessResult {
    const abandonedCount = this.store.abandonTimeoutOpenSessions(
      userId,
      new Date(eventTime.getTime() - this.settings.maxOpenSessionHours * 3600000)
    );
    const openSession = this.store.getLatestOpenSession(userId);

    let sessionId: number | null = null;
    let action = 'morning_orphan_warning';
    let eventStatus = 'orphan';
    let sleepTime: string | null = null;
    let wakeTime: string | null = null;
    let durationMinutes: number | null = null;
    let orphaned = false;
    let autoFilled = false;

    if (openSession) {
      sessionId = openSession.id;
      const sleepDt = openSession.sleep_time ? parseUtc8Iso(openSession.sleep_time) : eventTime;
      const safeWakeDt = eventTime.getTime() >= sleepDt.getTime() ? eventTime : sleepDt;
      this.store.closeSession(sessionId, safeWakeDt);
      action = 'morning_closed_session';
      eventStatus = 'processed';
      sleepTime = toIso(sleepDt);
      wakeTime = toIso(safeWakeDt);
      durationMinutes = Math.max(0, Math.floor((safeWakeDt.getTime() - sleepDt.getTime()) / 60000));
    } else {
      orphaned = true;
      if (this.settings.orphanMorningPolicy === 'create_closed_session') {
        const sleepDt = new Date(eventTime.getTime() - this.settings.autoFillDefaultHours * 3600000);
        const s = this.store.createClosedSession(userId, sleepDt, eventTime, 'auto_fill', true);
        sessionId = s.id;
        action = 'morning_auto_filled_session';
        eventStatus = 'auto_filled';
        sleepTime = s.sleep_time;
        wakeTime = s.wake_time;
        durationMinutes = Math.max(0, Math.floor((eventTime.getTime() - sleepDt.getTime()) / 60000));
        autoFilled = true;
      }
    }

    this.store.insertEvent({
      user_id: userId,
      event_type: EVENT_MORNING,
      event_time: toIso(eventTime),
      session_id: sessionId,
      status: eventStatus,
      raw_message: rawMessage.slice(0, 200),
    });

    return {
      event_type: EVENT_MORNING,
      action,
      session_id: sessionId,
      sleep_time: sleepTime,
      wake_time: wakeTime,
      duration_minutes: durationMinutes,
      orphaned,
      auto_filled: autoFilled,
      open_session_count: this.store.getOpenSessionCount(userId),
      abandoned_count: abandonedCount,
    };
  }

  /** 修正会话（!作息 修正 <id> [sleep_time] [wake_time]） */
  updateSessionByCommand(
    actorUserId: string,
    sessionId: number,
    sleepTimeStr: string | null,
    wakeTimeStr: string | null
  ): string {
    const session = this.store.getSessionById(sessionId);
    if (!session) return `未找到会话：${sessionId}`;
    if (actorUserId !== session.user_id) return '你只能修改自己的会话记录。';

    const sleepDt = sleepTimeStr ? parseDtLike(sleepTimeStr) : null;
    const wakeDt = wakeTimeStr ? parseDtLike(wakeTimeStr) : null;
    if (sleepTimeStr && !sleepDt) return '入睡时间格式错误，请使用 YYYY-MM-DD 或 YYYY-MM-DDTHH:MM[:SS]。';
    if (wakeTimeStr && !wakeDt) return '醒来时间格式错误，请使用 YYYY-MM-DD 或 YYYY-MM-DDTHH:MM[:SS]。';

    const oldSleep = session.sleep_time ? parseUtc8Iso(session.sleep_time) : null;
    const oldWake = session.wake_time ? parseUtc8Iso(session.wake_time) : null;
    const newSleep = sleepDt || oldSleep;
    const newWake = wakeDt || oldWake;

    if (!newSleep && newWake) return '存在醒来时间但没有入睡时间，请同时提供入睡时间。';
    if (newSleep && newWake && newWake.getTime() < newSleep.getTime()) return '醒来时间不能早于入睡时间。';
    if (!newSleep && !newWake) return '没有可更新的时间字段。';

    let newStatus: 'closed' | 'open' | 'abandoned';
    if (newSleep && newWake) newStatus = 'closed';
    else if (newSleep && !newWake) newStatus = 'open';
    else newStatus = 'abandoned';

    this.store.updateSession(sessionId, {
      sleep_time: newSleep || undefined,
      wake_time: newWake || undefined,
      status: newStatus,
    });
    this.store.insertEvent({
      user_id: session.user_id,
      event_type: 'manual_edit',
      event_time: toIso(new Date()),
      session_id: sessionId,
      status: 'manual',
      raw_message: `manual_update by ${actorUserId}`,
    });

    return (
      `会话 ${sessionId} 已更新。\n` +
      `入睡：${newSleep ? toIso(newSleep) : '-'}\n` +
      `醒来：${newWake ? toIso(newWake) : '-'}\n` +
      `状态：${newStatus}`
    );
  }
}

// ===== 统计服务 =====

class StatsService {
  constructor(private store: OyStore, private includeAutoFill: boolean) {}

  buildSummary(userId: string | null, startDate: string, endDate: string): string {
    const start = parseDtLike(startDate);
    const end = parseDtLike(endDate);
    if (!start || !end) return '日期格式错误，请使用 YYYY-MM-DD。';
    if (end.getTime() < start.getTime()) return '日期区间错误：end_date 不能早于 start_date。';

    const records = this.store.queryClosedSessions(userId, start, end, this.includeAutoFill);
    const orphanCount = this.store.countOrphanMorningEvents(userId, start, end);
    const totalMinutes = records.reduce((sum, s) => sum + (sessionDuration(s) || 0), 0);
    const avgMinutes = records.length ? Math.round(totalMinutes / records.length) : 0;

    const sleepTimes = records.filter((r) => r.sleep_time).map((r) => parseUtc8Iso(r.sleep_time!).getTime());
    const wakeTimes = records.filter((r) => r.wake_time).map((r) => parseUtc8Iso(r.wake_time!).getTime());
    // 北京时间显示（YYYY-MM-DD HH:MM:SS）
    const fmtTime = (ts: number | undefined) => (ts === undefined ? '-' : toIso(new Date(ts)).replace('T', ' '));

    const lines = [
      `统计对象：${userId || '全部用户'}`,
      `统计区间：${startDate} ~ ${endDate}`,
      `闭合会话数：${records.length}`,
      `总睡眠时长：${formatDurationHuman(totalMinutes)}`,
      `平均睡眠时长：${formatDurationHuman(avgMinutes)}`,
      `最早入睡：${fmtTime(sleepTimes.length ? Math.min(...sleepTimes) : undefined)}`,
      `最晚入睡：${fmtTime(sleepTimes.length ? Math.max(...sleepTimes) : undefined)}`,
      `最早醒来：${fmtTime(wakeTimes.length ? Math.min(...wakeTimes) : undefined)}`,
      `最晚醒来：${fmtTime(wakeTimes.length ? Math.max(...wakeTimes) : undefined)}`,
      `当前进行中会话：${this.store.getOpenSessionCount(userId || undefined)}`,
      `孤立早安事件：${orphanCount}`,
    ];
    if (!records.length) {
      lines.push('区间内暂无闭合会话记录。');
      return lines.join('\n');
    }
    lines.push('最近会话：');
    for (const row of records.slice(-8).reverse()) {
      lines.push(
        `- #${row.id} | 入睡:${(row.sleep_time || '-').replace('T', ' ')} | 醒来:${(row.wake_time || '-').replace('T', ' ')} | 时长:${formatDurationHuman(sessionDuration(row))}`
      );
    }
    return lines.join('\n');
  }

  buildDashboard(userId: string, days: number): string {
    const dayCount = Math.max(1, Math.min(days, 60));
    // 以北京时间为准：今天 0 点（UTC+8）作为 end，往前推 dayCount 天
    const todayIso = toIso(new Date()).slice(0, 10);
    const end = parseDtLike(todayIso)!; // 今天 0 点（北京时间）
    const start = new Date(end.getTime() - (dayCount - 1) * 86400000);
    const records = this.store.queryClosedSessions(userId, start, end, this.includeAutoFill);
    const totalMinutes = records.reduce((sum, s) => sum + (sessionDuration(s) || 0), 0);
    const avgMinutes = records.length ? Math.round(totalMinutes / records.length) : 0;

    // 按日期聚合（sleep_time 已是北京时间，直接取日期部分）
    const byDate = new Map<string, { total: number; count: number }>();
    for (const r of records) {
      if (!r.sleep_time) continue;
      const d = r.sleep_time.slice(0, 10);
      const cur = byDate.get(d) || { total: 0, count: 0 };
      cur.total += sessionDuration(r) || 0;
      cur.count++;
      byDate.set(d, cur);
    }
    const daysList = Array.from({ length: dayCount }, (_, i) => toIso(new Date(start.getTime() + i * 86400000)).slice(0, 10));

    const lines = [
      `用户：${userId}`,
      `区间：${toIso(start).slice(0, 10)} ~ ${toIso(end).slice(0, 10)}`,
      `总时长：${formatDurationHuman(totalMinutes)}`,
      `平均时长：${formatDurationHuman(avgMinutes)}`,
      `进行中会话：${this.store.getOpenSessionCount(userId)}`,
      '每日趋势：',
    ];
    if (!records.length) {
      lines.push('- 暂无数据');
      return lines.join('\n');
    }
    for (const day of daysList) {
      const cur = byDate.get(day);
      lines.push(`- ${day} | 总时长 ${formatDurationHuman(cur?.total || 0)} | 会话 ${cur?.count || 0}`);
    }
    return lines.join('\n');
  }
}

// ===== 插件主入口 =====

let store: OyStore | null = null;
let trigger: TriggerMatcher | null = null;
let sessionService: SessionService | null = null;
let statsService: StatsService | null = null;

/** 猫娘语气池（移植自原版 _CATGIRL_EXTRAS） */
const CATGIRL_EXTRAS: Record<string, string[]> = {
  morning: [
    '今天也要元气满满，喵~',
    '先喝口水再出发会更舒服喵~',
    '你认真记录作息的样子超可爱，喵呜~',
    '记得拉开窗帘晒晒太阳，喵~',
  ],
  night: [
    '把烦恼放下，安心睡吧，喵~',
    '记得盖好小被子，晚安喵~',
    '本猫娘会帮你继续盯作息，喵~',
    '今晚做个甜甜的梦，喵呜~',
  ],
  orphan: [
    '补一条记录我就能算得更准啦，喵~',
    '要不要现在补录一下呀，喵~',
    '不急，我们慢慢把记录补完整，喵~',
  ],
  duplicate: [
    '这边已经帮你处理好重复记录啦，喵~',
    '别担心，我会继续守着你的作息本本，喵~',
    '记录还在进行中，我会好好看着它，喵~',
  ],
  default: [
    '我会一直温柔地陪你记作息，喵~',
    '有我在，作息打卡会越来越稳，喵~',
    '保持一点点进步就很棒啦，喵~',
  ],
};

/**
 * 猫娘语气增强（移植自原版 _apply_catgirl_tone）：
 * 若文本不含"喵"，根据结尾标点补" 喵~"或"，喵~"，再从对应场景语气池随机附一句。
 */
function applyCatgirlTone(text: string, style = 'default', enabled = true): string {
  let cleaned = (text || '').trim();
  if (!cleaned) cleaned = '收到啦，我会帮你记好作息';
  if (!enabled) return cleaned;
  if (!cleaned.includes('喵')) {
    if (/[。！？.!?~～]$/.test(cleaned)) {
      cleaned = `${cleaned} 喵~`;
    } else {
      cleaned = `${cleaned}，喵~`;
    }
  }
  const pool = CATGIRL_EXTRAS[style] || CATGIRL_EXTRAS.default;
  const extra = pool[Math.floor(Math.random() * pool.length)];
  if (cleaned.includes(extra)) return cleaned;
  return `${cleaned}\n${extra}`;
}

/** 渲染静态回复模板：{user_name} {sleep_time} {wake_time} {duration_human} {open_session_count} {abandoned_count} */
function renderTemplate(template: string, data: Record<string, string>): string {
  return template.replace(/\{(\w+)\}/g, (_, key: string) => data[key] ?? '-');
}

/** 严格 ID 形态（ncuid 示例：USR-ABCD1234 / nc_hex...），避免误判真实昵称 */
const ID_SHAPE_RE = /^(USR-[A-Z0-9]{4,}|nc_[a-zA-Z0-9]{8,})$/i;

/**
 * 解析用户昵称：msg.fromName 缺失/回退为 ID 时，查询用户资料取真实昵称
 * （getUserProfile 自带 4 小时缓存，不会频繁请求）
 */
async function resolveUserName(ctx: PluginContext, msg: ParsedMessage): Promise<string> {
  const raw = (msg.sender.name || '').trim();
  const from = msg.sender.id || '';
  const looksLikeId = !raw || raw === from || ID_SHAPE_RE.test(raw);
  if (looksLikeId && from) {
    try {
      const user = await ctx.getUser(from);
      const real = (user?.name || '').trim();
      if (real) return real;
    } catch (e: any) {
      // 查询失败时回退
    }
  }
  return raw || from;
}

/** 构建早晚安事件回复（静态模板 + 猫娘语气） */
function buildEventReply(userName: string, result: ProcessResult, cfg: any): string {
  // 时间显示格式：YYYY-MM-DD HH:MM:SS（空格分隔，与用户习惯一致）
  const fmtTime = (v: string | null | undefined) => (v ? v.replace('T', ' ') : '-');
  const data: Record<string, string> = {
    user_name: userName,
    sleep_time: fmtTime(result.sleep_time),
    wake_time: fmtTime(result.wake_time),
    duration_human: formatDurationHuman(result.duration_minutes),
    open_session_count: String(result.open_session_count),
    abandoned_count: String(result.abandoned_count),
  };
  const toneEnabled = cfg.appendCatgirlExtra !== false;
  if (result.event_type === EVENT_NIGHT) {
    if (result.action === 'night_duplicate_ignored') {
      return applyCatgirlTone(
        renderTemplate(cfg.duplicateNightReply || '你当前已经有进行中的睡眠记录了，这次按策略处理好啦，喵~', data),
        'duplicate',
        toneEnabled
      );
    }
    return applyCatgirlTone(
      renderTemplate(cfg.nightStaticReply || '晚安啦，{user_name}。已经帮你记下入睡时间 {sleep_time}，做个好梦喵~', data),
      'night',
      toneEnabled
    );
  }
  if (result.orphaned && !result.auto_filled) {
    return applyCatgirlTone(
      renderTemplate(cfg.orphanMorningReply || '收到早安啦，但还没找到可闭合的晚安记录。可以用“/作息 修正”补录一下，喵~', data),
      'orphan',
      toneEnabled
    );
  }
  return applyCatgirlTone(
    renderTemplate(cfg.morningStaticReply || '早安呀，{user_name}。你这次睡了 {duration_human}，今天也要元气满满哦，喵~', data),
    'morning',
    toneEnabled
  );
}

/** 插件加载 */
export function onLoad(ctx: PluginContext) {
  const cfg: any = ctx.config || {};
  const maxTriggerChars = Math.max(1, Number(cfg.maxTriggerChars) || 7);
  store = new OyStore(ctx.storage.file('oyasumi.json'));

  trigger = new TriggerMatcher();
  trigger.reload(
    {
      night: Array.isArray(cfg.goodNightPatterns) ? cfg.goodNightPatterns : ['^(晚安|睡觉了|我要睡了).*$'],
      morning: Array.isArray(cfg.goodMorningPatterns) ? cfg.goodMorningPatterns : ['^(早安|早上好|我醒了).*$'],
    },
    cfg.ignoreCase !== false
  );

  sessionService = new SessionService(store, {
    duplicateNightPolicy: cfg.duplicateNightPolicy || 'ignore',
    orphanMorningPolicy: cfg.orphanMorningPolicy || 'warn_only',
    autoFillDefaultHours: parseInt(cfg.autoFillDefaultHours, 10) || 8,
    maxOpenSessionHours: parseInt(cfg.maxOpenSessionHours, 10) || 24,
  });

  statsService = new StatsService(store, cfg.includeAutoFillInStats !== false);

  // ===== 早晚安触发（onMessage 前缀匹配，非命令消息） =====
  ctx.onMessage(async (msg: ParsedMessage) => {
    if (msg.sender.id === msg.selfId || !store || !trigger || !sessionService) return;
    const raw = String(msg.text ?? '').trim();
    if (!raw) return;
    const prefix = ctx.prefixes.find((p) => p && raw.startsWith(p));
    const text = (prefix ? raw.slice(prefix.length) : raw).trim();
    if (!text || text.length > maxTriggerChars) {
      if (text) ctx.log.debug(`触发跳过 长度=${text.length} 上限=${maxTriggerChars} 文本="${text.slice(0, 30)}"`);
      return;
    }

    const matchResult = trigger.match(text);
    if (!matchResult) {
      ctx.log.debug(`未匹配作息关键词 "${text}"`);
      return;
    }
    ctx.log.debug(`命中 ${matchResult.event_type} 关键词=${matchResult.matched_pattern}`);

    const userId = msg.sender.id;
    const userName = await resolveUserName(ctx, msg);
    const now = new Date();

    const result = await sessionService.processEvent(
      userId,
      matchResult.event_type,
      now,
      text,
      matchResult.matched_pattern
    );
    store.save();
    ctx.log.info( `[${matchResult.event_type}] ${userName}: ${result.action} (session=${result.session_id})`);

    const reply = buildEventReply(userName, result, cfg);
    if (reply) {
      try {
        await ctx.reply(msg, reply);
      } catch (e: any) {
        ctx.log.error( `回复发送失败: ${e.message}`);
      }
    }
  });

  // ===== 命令：!作息 / !sleep / !oyasumi =====
  const handleCommand = async (args: string[], msg: ParsedMessage) => {
    if (!store || !statsService || !sessionService) return;
    const sub = (args[0] || '').toLowerCase();
    const userId = msg.sender.id;
    const isAdmin = false; // NokoriBot 暂无管理员概念，保留扩展位

    const helpText =
      'Oyasumi 作息插件命令：\n' +
      '!作息 状态\n' +
      '!作息 看板 [days]\n' +
      '!作息 统计 [start_date] [end_date] [target_user_id]\n' +
      '!作息 会话 [limit] [target_user_id]\n' +
      '!作息 修正 <session_id> [sleep_time] [wake_time]\n' +
      '时间格式：YYYY-MM-DD 或 YYYY-MM-DDTHH:MM[:SS]';

    switch (sub) {
      case '状态':
      case 'status': {
        const openCount = store.getOpenSessionCount(userId);
        ctx.reply(
          msg,
          `插件启用：true\n回复模式：static\n当前用户进行中会话：${openCount}\n数据文件：${store ? 'data/oyasumi.json' : '-'}`
        );
        break;
      }
      case '看板':
      case 'dashboard': {
        const days = parseInt(args[1], 10) || 7;
        ctx.reply(msg, statsService.buildDashboard(userId, days));
        break;
      }
      case '统计':
      case 'stats': {
        const startDate = args[1] || defaultStartDate();
        const endDate = args[2] || defaultEndDate();
        const target = args[3] || userId;
        if (target !== userId && !isAdmin) {
          ctx.reply(msg, '当前配置仅管理员可查询他人数据。');
          break;
        }
        ctx.reply(msg, statsService.buildSummary(target, startDate, endDate));
        break;
      }
      case '会话':
      case 'sessions': {
        const limit = parseInt(args[1], 10) || 10;
        const target = args[2] || userId;
        if (target !== userId && !isAdmin) {
          ctx.reply(msg, '当前配置仅管理员可查询他人数据。');
          break;
        }
        const sessions = store.listSessions(target, Math.max(1, Math.min(limit, 30)));
        if (!sessions.length) {
          ctx.reply(msg, '暂无会话记录。');
          break;
        }
        const lines = sessions.map((s) => {
          const dur = sessionDuration(s);
          return (
            `#${s.id} [${s.status}] 入睡:${s.sleep_time || '-'} 醒来:${s.wake_time || '-'} ` +
            `时长:${formatDurationHuman(dur)}${s.is_auto_filled ? ' (自动补全)' : ''}`
          );
        });
        ctx.reply(msg, `最近 ${sessions.length} 条会话：\n` + lines.join('\n'));
        break;
      }
      case '修正':
      case 'fix':
      case 'update': {
        const sessionId = parseInt(args[1], 10);
        if (Number.isNaN(sessionId)) {
          ctx.reply(msg, '用法: !作息 修正 <session_id> [sleep_time] [wake_time]');
          break;
        }
        const reply = sessionService.updateSessionByCommand(userId, sessionId, args[2] || null, args[3] || null);
        store.save();
        ctx.reply(msg, reply);
        break;
      }
      default:
        ctx.reply(msg, helpText);
    }
  };

  ctx.command('作息', handleCommand);
  ctx.command('sleep', handleCommand);
  ctx.command('oyasumi', handleCommand);

  ctx.log.info( 'Oyasumi plugin loaded (作息记录)');
}

/** 插件卸载 */
export function onUnload() {
  if (store) store.save();
  store = null;
  trigger = null;
  sessionService = null;
  statsService = null;
}

function defaultStartDate(): string {
  const d = new Date();
  d.setDate(d.getDate() - 6);
  return toIso(d).slice(0, 10);
}

function defaultEndDate(): string {
  return toIso(new Date()).slice(0, 10);
}

