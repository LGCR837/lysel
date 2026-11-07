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
  if (evt.sender.id === evt.selfId) {
    ctx.log.debug('触发判定 跳过 自己发的消息');
    return null;
  }
  let body = String(evt.text ?? '').trim();
  if (!body) {
    ctx.log.debug(`触发判定 跳过 无正文 类型=${evt.segments.map((s) => s.type).join(',') || 'empty'}`);
    return null;
  }

  const wakeWords = (cfg.wakeWords ?? DEFAULT_WAKE_WORDS).map((w) => String(w ?? '').trim()).filter(Boolean);

  const prefix = ctx.prefixes.find((p) => p && body.startsWith(p));
  if (prefix) body = body.slice(prefix.length).trim();

  const wake = wakeWords.find((w) => body.toLowerCase().startsWith(w.toLowerCase()));
  if (wake) body = body.slice(wake.length).replace(/^[\s,，:：]+/, '').trim();

  if (cfg.requireWakeInGroup && evt.scene === 'group') {
    const atSelf = evt.segments.some((s) => s.type === 'at' && isAtSelf(evt, s));
    if (!prefix && !wake && !atSelf) {
      ctx.log.debug(`触发判定 跳过 群内未唤醒 原文="${String(evt.text ?? '').slice(0, 60)}"`);
      return null;
    }
  }

  ctx.log.debug(
    `触发判定 通过 prefix=${prefix || '-'} wake=${wake || '-'} 正文="${body.slice(0, 80)}"`,
  );
  return body;
}

interface AtSegment {
  type: 'at';
  id: string;
  uid?: string;
  name?: string;
}

/** at 段的全部身份：ncuid、平台 uid */
export function atIdentities(seg: AtSegment): string[] {
  return [seg.id, seg.uid].map((v) => String(v ?? '').trim()).filter(Boolean);
}

/** 自己的全部身份（ncuid + uid），统一大写比较 */
export function selfIdentitySet(evt: MessageEvent): Set<string> {
  const all = [evt.selfId, ...(evt.selfIds ?? [])];
  return new Set(all.map((v) => String(v ?? '').trim().toUpperCase()).filter(Boolean));
}

/** 该 at 段是否指向自己 */
export function isAtSelf(evt: MessageEvent, seg: AtSegment): boolean {
  const self = selfIdentitySet(evt);
  return atIdentities(seg).some((v) => self.has(v.toUpperCase()));
}

export interface AtTarget {
  id: string;
  uid: string;
  name: string;
}

/** 第一个 @ 到的他人，携带全部身份供成员表比对 */
export function atTarget(evt: MessageEvent): AtTarget | null {
  for (const seg of evt.segments) {
    if (seg.type !== 'at') continue;
    if (!seg.id && !seg.uid) continue;
    if (isAtSelf(evt, seg)) continue;
    return { id: seg.id || String(seg.uid), uid: seg.uid ?? '', name: seg.name ?? '' };
  }
  return null;
}

/** 取消息里 @ 到的第一个他人 ID */
export function atTargetId(evt: MessageEvent): string {
  return atTarget(evt)?.id ?? '';
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
