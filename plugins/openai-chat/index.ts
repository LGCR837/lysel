import type { MessageEvent, PluginContext } from '../../core/types.ts';

type Part = { type: 'text'; text: string } | { type: 'image_url'; image_url: { url: string } };
type Role = 'system' | 'user' | 'assistant';
type Turn = { role: 'user' | 'assistant'; content: string };

const histories = new Map<string, Turn[]>();
const hits = new Map<string, number[]>();
const chains = new Map<string, Promise<unknown>>();

function count(value: unknown, fallback: number): number {
  const n = Number(value);
  return Number.isFinite(n) ? n : fallback;
}

export function onLoad(ctx: PluginContext) {
  const apiKey = String(ctx.config.apiKey ?? '');
  const baseUrl = String(ctx.config.baseUrl ?? 'https://api.openai.com').replace(/\/+$/, '');
  const model = String(ctx.config.model ?? 'gpt-4o-mini');
  const systemPrompt = String(ctx.config.systemPrompt ?? '');
  const maxHistory = Math.max(2, count(ctx.config.maxHistory, 10));
  const timeoutMs = Math.max(5000, count(ctx.config.timeoutMs, 60000));
  const temperature = count(ctx.config.temperature, 0.8);
  const maxReplyChars = Math.max(50, count(ctx.config.maxReplyChars, 500));
  const triggerOnPrivate = ctx.config.triggerOnPrivate !== false;
  const triggerOnAt = ctx.config.triggerOnAt !== false;
  const prefixes = [...ctx.prefixes];
  const vision = ctx.config.vision !== false;
  const replyOnError = ctx.config.replyOnError === true;
  const errorReply = String(ctx.config.errorReply ?? '暂时无法回答');
  const bannedWords = Array.isArray(ctx.config.bannedWords) ? ctx.config.bannedWords.map(String) : [];
  const rateLimitPerMin = Math.max(1, count(ctx.config.rateLimitPerMin, 6));
  const rateLimitReply = String(ctx.config.rateLimitReply ?? '');
  const persist = ctx.config.persistHistory === true;
  const typingEnabled = ctx.config.typing !== false;
  const typingRefreshMs = Math.max(2000, count(ctx.config.typingRefreshMs, 5000));

  /** 立刻发出输入中状态，等待期间按 TTL 续租，返回停止函数 */
  const startTyping = (evt: MessageEvent): (() => void) => {
    if (!typingEnabled) return () => {};
    let alive = true;
    ctx.log.debug(`输入状态 开 ${evt.scene} ${evt.peerId}`);
    void ctx.typing(evt, true).catch((e: any) => ctx.log.debug(`输入状态发送失败 ${e?.message ?? e}`));
    const timer = setInterval(() => {
      if (alive) void ctx.typing(evt, true).catch(() => {});
    }, typingRefreshMs);
    timer.unref?.();
    return () => {
      if (!alive) return;
      alive = false;
      clearInterval(timer);
      ctx.log.debug(`输入状态 关 ${evt.scene} ${evt.peerId}`);
      void ctx.typing(evt, false).catch(() => {});
    };
  };

  if (!apiKey) ctx.log.warn('未配置 apiKey，插件不响应');

  const keyOf = (evt: MessageEvent) => `${evt.accountId}:${evt.scene}:${evt.peerId}`;

  const loadHistory = (key: string): Turn[] => {
    const cached = histories.get(key);
    if (cached) return cached;
    const saved = persist ? ctx.storage.get<Turn[]>(`hist:${key}`, []) : [];
    const list = Array.isArray(saved) ? saved : [];
    histories.set(key, list);
    return list;
  };

  const saveHistory = (key: string, list: Turn[]) => {
    histories.set(key, list);
    if (persist) ctx.storage.set(`hist:${key}`, list);
  };

  const reset = (evt: MessageEvent) => {
    const key = keyOf(evt);
    histories.delete(key);
    if (persist) ctx.storage.delete(`hist:${key}`);
    return ctx.reply(evt, '上下文已清空');
  };

  const pickPrompt = (evt: MessageEvent): string | null => {
    const text = String(evt.text ?? '').trim();
    const hit = prefixes.find((p) => p && text.startsWith(p));
    if (hit) {
      ctx.log.debug(`触发 前缀=${hit}`);
      return text.slice(hit.length).trim();
    }
    if (evt.scene === 'private') {
      if (!triggerOnPrivate) {
        ctx.log.debug('跳过 私聊触发已关闭');
        return null;
      }
      return text;
    }
    const atSelf = evt.segments.some((s) => s.type === 'at' && s.id === evt.selfId);
    if (atSelf) {
      ctx.log.debug('触发 群内 @ 自己');
      return text;
    }
    ctx.log.debug(
      `跳过 群内未@ ${triggerOnAt ? '' : '(提及触发已关闭)'} 文本="${text.slice(0, 40)}" 自己=${evt.selfId}`,
    );
    return null;
  };

  const collectImages = (evt: MessageEvent): string[] =>
    vision
      ? evt.segments
          .filter((s) => s.type === 'image' && (s as { url?: string }).url)
          .map((s) => String((s as { url?: string }).url))
      : [];

  const ask = async (messages: Array<{ role: Role; content: string | Part[] }>): Promise<string> => {
    const controller = new AbortController();
    const started = Date.now();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
      const res = await fetch(`${baseUrl}/v1/chat/completions`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${apiKey}` },
        body: JSON.stringify({ model, messages, temperature }),
        signal: controller.signal,
      });
      if (!res.ok) {
        const detail = await res.text().catch(() => '');
        ctx.log.warn(`模型接口 ${res.status} ${Date.now() - started}ms ${detail.slice(0, 300)}`);
        throw new Error(`接口返回 ${res.status}`);
      }
      ctx.log.debug(`模型接口 ${res.status} ${Date.now() - started}ms`);
      const data: any = await res.json();
      const raw = data?.choices?.[0]?.message?.content;
      const text = Array.isArray(raw) ? raw.map((p: any) => p?.text ?? '').join('') : String(raw ?? '');
      const reply = text.trim();
      if (!reply) throw new Error('返回空内容');
      return reply;
    } finally {
      clearTimeout(timer);
    }
  };

  const handle = async (evt: MessageEvent, prompt: string, images: string[]) => {
    const key = keyOf(evt);
    const label = evt.sender.name || evt.sender.id;
    const userText = evt.scene === 'group' ? `${label}: ${prompt}` : prompt;

    const messages: Array<{ role: Role; content: string | Part[] }> = [];
    if (systemPrompt) messages.push({ role: 'system', content: systemPrompt });
    for (const turn of loadHistory(key)) messages.push({ role: turn.role, content: turn.content });
    if (images.length) {
      messages.push({
        role: 'user',
        content: [{ type: 'text', text: userText }, ...images.map((url) => ({ type: 'image_url' as const, image_url: { url } }))],
      });
    } else {
      messages.push({ role: 'user', content: userText });
    }

    const started = Date.now();
    ctx.log.debug(`请求模型 model=${model} 消息数=${messages.length} 图片=${images.length} 输入长度=${userText.length}`);
    let reply: string;
    try {
      reply = await ask(messages);
    } catch (e: any) {
      ctx.log.error(`请求失败 ${Date.now() - started}ms ${e?.message ?? e}`);
      if (replyOnError) await ctx.reply(evt, errorReply);
      return;
    }

    const trimmed = reply.length > maxReplyChars ? reply.slice(0, maxReplyChars) : reply;
    const appended: Turn[] = [
      { role: 'user', content: userText },
      { role: 'assistant', content: trimmed },
    ];
    saveHistory(key, [...loadHistory(key), ...appended].slice(-maxHistory));
    ctx.log.debug(`回复完成 ${Date.now() - started}ms 原文=${reply.length} 截断后=${trimmed.length}`);
    await ctx.reply(evt, trimmed);
  };

  ctx.onMessage((evt) => {
    if (!apiKey) return;
    if (evt.sender.id === evt.selfId) return;

    const prompt = pickPrompt(evt);
    if (prompt === null) return;
    const images = collectImages(evt);
    if (!prompt && !images.length) return;

    const lower = prompt.toLowerCase();
    if (bannedWords.some((w) => lower.includes(w.toLowerCase()))) {
      ctx.log.debug('命中违禁词，忽略');
      return;
    }

    const now = Date.now();
    const recent = (hits.get(evt.sender.id) ?? []).filter((t) => now - t < 60000);
    if (recent.length >= rateLimitPerMin) {
      ctx.log.debug(`限流 忽略 ${evt.sender.id} 一分钟内 ${recent.length} 条 上限 ${rateLimitPerMin}`);
      if (rateLimitReply) void ctx.reply(evt, rateLimitReply);
      return;
    }
    recent.push(now);
    hits.set(evt.sender.id, recent);

    const key = keyOf(evt);
    // 收到即亮输入中状态，排队等待期间也要保持
    const stopTyping = startTyping(evt);
    const prev = chains.get(key) ?? Promise.resolve();
    const next = prev
      .then(() => handle(evt, prompt, images))
      .catch((e: any) => ctx.log.error(`对话处理失败 ${e?.message ?? e}`))
      .finally(stopTyping);
    chains.set(key, next);
    void next.finally(() => {
      if (chains.get(key) === next) chains.delete(key);
    });
  });

  ctx.command('清空上下文', (_args, evt) => reset(evt));
  ctx.command('reset', (_args, evt) => reset(evt));

  ctx.log.info(`已就绪 model=${model} 私聊=${triggerOnPrivate ? '开' : '关'} 提及=${triggerOnAt ? '开' : '关'}`);
}

export function onUnload() {
  histories.clear();
  hits.clear();
  chains.clear();
}
