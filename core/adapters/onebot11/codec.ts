import type { Segment } from '../../types.ts';

export function toSegments(message: unknown): Segment[] {
  const list = Array.isArray(message) ? message : [];
  const out: Segment[] = [];
  for (const item of list) {
    if (!item || typeof item !== 'object') continue;
    const seg = item as Record<string, any>;
    switch (seg.type) {
      case 'text':
        out.push({ type: 'text', text: String(seg.data?.text ?? '') });
        break;
      case 'at':
        out.push({ type: 'at', id: String(seg.data?.qq ?? ''), name: seg.data?.name });
        break;
      case 'reply':
        out.push({ type: 'reply', id: String(seg.data?.id ?? '') });
        break;
      case 'image':
        out.push({ type: 'image', url: seg.data?.url ?? seg.data?.file });
        break;
      case 'record':
        out.push({ type: 'voice', url: seg.data?.url ?? seg.data?.file });
        break;
      case 'video':
        out.push({ type: 'video', url: seg.data?.url ?? seg.data?.file });
        break;
      case 'face':
        out.push({ type: 'face', id: String(seg.data?.id ?? '') });
        break;
      case 'file':
        out.push({ type: 'file', url: seg.data?.url, name: seg.data?.name });
        break;
    }
  }
  return out;
}

export function fromSegments(segments: Segment[]): unknown[] {
  const out: unknown[] = [];
  for (const seg of segments) {
    switch (seg.type) {
      case 'text':
        out.push({ type: 'text', data: { text: seg.text } });
        break;
      case 'at':
        out.push({ type: 'at', data: { qq: seg.id, ...(seg.name ? { name: seg.name } : {}) } });
        break;
      case 'reply':
        out.push({ type: 'reply', data: { id: seg.id } });
        break;
      case 'image':
        out.push({ type: 'image', data: { file: seg.url ?? seg.file ?? '' } });
        break;
      case 'voice':
        out.push({ type: 'record', data: { file: seg.url ?? '' } });
        break;
      case 'video':
        out.push({ type: 'video', data: { file: seg.url ?? '' } });
        break;
      case 'face':
        out.push({ type: 'face', data: { id: seg.id ?? '0' } });
        break;
      case 'file':
        out.push({ type: 'file', data: { file: seg.url ?? '', name: seg.name } });
        break;
    }
  }
  return out;
}
