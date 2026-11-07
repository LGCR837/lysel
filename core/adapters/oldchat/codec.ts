import type { Segment } from '../../types.ts';

export interface OCPayload {
  v?: number;
  text?: string;
  media_kind?: string;
  voice_text?: string;
  quote?: { id: string; [k: string]: unknown };
  mentions?: { uid?: string; ncuid?: string; name?: string }[];
  forward_v2?: { title?: string; items?: unknown[] };
}

function tryParse(body: string): OCPayload | null {
  const trimmed = body.trim();
  if (!trimmed.startsWith('{')) return null;
  try {
    const parsed = JSON.parse(trimmed);
    if (parsed && typeof parsed === 'object' && ('text' in parsed || 'quote' in parsed || 'mentions' in parsed)) {
      return parsed as OCPayload;
    }
  } catch {}
  return null;
}

export function decodeBody(body: string, msgType: string, mediaUrl?: string): Segment[] {
  const segs: Segment[] = [];
  if (msgType === 'image' || msgType === 'voice' || msgType === 'video') {
    if (mediaUrl) segs.push({ type: msgType === 'image' ? 'image' : msgType, url: mediaUrl } as Segment);
    return segs;
  }

  const payload = tryParse(body);
  if (!payload) {
    if (body) segs.push({ type: 'text', text: body });
    return segs;
  }

  if (payload.quote?.id) segs.push({ type: 'reply', id: String(payload.quote.id) });
  if (payload.text) segs.push({ type: 'text', text: payload.text });
  for (const m of payload.mentions ?? []) {
    segs.push({ type: 'at', id: String(m.ncuid || m.uid || ''), name: m.name });
  }
  if (payload.forward_v2) {
    const count = Array.isArray(payload.forward_v2.items) ? payload.forward_v2.items.length : 0;
    segs.push({ type: 'text', text: `[合并转发 ${payload.forward_v2.title ?? ''} 共 ${count} 条]` });
  }
  return segs;
}

export interface EncodedMessage {
  body: string;
  msgType: string;
  mediaUrl: string;
  thumbUrl: string;
  durationMs: number;
}

export function encodeSegments(segments: Segment[]): EncodedMessage {
  let text = '';
  let mediaType = 'text';
  let mediaUrl = '';
  let thumbUrl = '';
  let durationMs = 0;
  let quote: { id: string } | undefined;
  const mentions: { uid?: string; ncuid?: string; name?: string }[] = [];

  for (const seg of segments) {
    switch (seg.type) {
      case 'text':
        text += seg.text;
        break;
      case 'at':
        mentions.push(
          seg.id.startsWith('nc_') ? { ncuid: seg.id, name: seg.name ?? '' } : { uid: seg.id, name: seg.name ?? '' },
        );
        break;
      case 'reply':
        quote = { id: seg.id };
        break;
      case 'image':
      case 'voice':
      case 'video':
        mediaType = seg.type;
        mediaUrl = seg.url ?? (seg as { file?: string }).file ?? '';
        if (seg.type === 'voice') durationMs = Number(seg.duration) || 0;
        break;
      case 'file':
        mediaType = 'resource';
        mediaUrl = seg.url ?? '';
        break;
    }
  }

  if (mediaType !== 'text') {
    return { body: text, msgType: mediaType, mediaUrl, thumbUrl, durationMs };
  }
  if (!quote && mentions.length === 0) {
    return { body: text, msgType: 'text', mediaUrl: '', thumbUrl: '', durationMs: 0 };
  }

  const payload: OCPayload = { v: 2, text };
  if (quote) payload.quote = quote;
  if (mentions.length) payload.mentions = mentions;
  return { body: JSON.stringify(payload), msgType: 'text', mediaUrl: '', thumbUrl: '', durationMs: 0 };
}
