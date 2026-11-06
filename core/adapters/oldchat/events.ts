import type { MessageEvent, Scene } from '../../types.ts';
import { decodeBody } from './codec.ts';

export function toMessageEvent(
  accountId: string,
  selfId: string,
  type: string,
  data: any,
): MessageEvent | null {
  if (type !== 'group_message' && type !== 'direct_message') return null;
  const scene: Scene = type === 'group_message' ? 'group' : 'private';
  const fromId = String(data.from_ncuid || data.from_uid || '');

  let peerId: string;
  if (scene === 'group') peerId = String(data.group_id ?? '');
  else if (fromId && fromId !== selfId) peerId = fromId;
  else peerId = String(data.to_ncuid || data.to_uid || data.thread_id || '');

  const segments = decodeBody(String(data.body ?? ''), String(data.msg_type ?? 'text'), data.media_url);

  return {
    id: String(data.id ?? ''),
    accountId,
    platform: 'oldchat',
    selfId,
    scene,
    peerId,
    sender: {
      id: fromId,
      name: String(data.from_name || fromId),
    },
    segments,
    text: segments
      .filter((s) => s.type === 'text')
      .map((s) => (s as { text: string }).text)
      .join(''),
    createdAt: Number(data.created_at ?? 0) * 1000 || Date.now(),
    raw: data,
  };
}
