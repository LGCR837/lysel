// 各插件共用的触发归一化：前缀可选、唤醒词可选、群里可要求先唤醒
import type { MessageEvent, PluginContext } from '../../core/types.ts';

export interface TriggerConfig {
  /** 唤醒词，命中后从正文剥离 */
  wakeWords?: string[];
  /** 群聊必须带前缀、唤醒词或 @ 自己才响应 */
  requireWakeInGroup?: boolean;
}

/** 默认唤醒词，配置可覆盖 */
export const DEFAULT_WAKE_WORDS = ['Lysel'];

/** 去掉前缀、唤醒词、@ 片段后的正文；返回 null 表示不该处理 */
export function readBody(ctx: PluginContext, evt: MessageEvent, cfg: TriggerConfig = {}): string | null {
  if (evt.sender.id === evt.selfId) return null;
  let body = String(evt.text ?? '').trim();
  if (!body) return null;

  const wakeWords = (cfg.wakeWords ?? DEFAULT_WAKE_WORDS).map((w) => String(w ?? '').trim()).filter(Boolean);

  const prefix = ctx.prefixes.find((p) => p && body.startsWith(p));
  if (prefix) body = body.slice(prefix.length).trim();

  const wake = wakeWords.find((w) => body.toLowerCase().startsWith(w.toLowerCase()));
  if (wake) body = body.slice(wake.length).replace(/^[\s,，:：]+/, '').trim();

  if (cfg.requireWakeInGroup && evt.scene === 'group') {
    const atSelf = evt.segments.some((s) => s.type === 'at' && s.id === evt.selfId);
    if (!prefix && !wake && !atSelf) return null;
  }

  return body;
}

/** 取消息里 @ 到的第一个用户 ID（跳过自己） */
export function atTargetId(evt: MessageEvent): string {
  const hit = evt.segments.find((s) => s.type === 'at' && s.id && s.id !== evt.selfId);
  return hit ? String((hit as { id: string }).id) : '';
}

/** 北京时间 YYYY-MM-DD */
export function todayStr(ts = Date.now()): string {
  const d = new Date(ts + 8 * 3600 * 1000);
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${d.getUTCFullYear()}-${pad(d.getUTCMonth() + 1)}-${pad(d.getUTCDate())}`;
}

/** 北京时间 HH:MM */
export function clockStr(ts = Date.now()): string {
  const d = new Date(ts + 8 * 3600 * 1000);
  return `${String(d.getUTCHours()).padStart(2, '0')}:${String(d.getUTCMinutes()).padStart(2, '0')}`;
}

/** 读配置里的唤醒词数组 */
export function wakeWordsOf(config: Record<string, any>): string[] {
  return Array.isArray(config.wakeWords) ? config.wakeWords.map(String) : DEFAULT_WAKE_WORDS;
}
