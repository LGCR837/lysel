import type { MessageEvent, Sender } from '../../types.ts';
import { toSegments } from './codec.ts';

const roleMap: Record<string, Sender['role']> = {
  owner: 'owner',
  admin: 'admin',
  member: 'member',
};

function senderOf(raw: any): Sender {
  return {
    id: String(raw?.user_id ?? ''),
    name: String(raw?.card || raw?.nickname || raw?.user_id || ''),
    role: roleMap[String(raw?.role ?? '')] ?? undefined,
  };
}

export function toMessageEvent(accountId: string, selfId: string, payload: any): MessageEvent | null {
  if (payload?.post_type !== 'message') return null;
  const group = payload.message_type === 'group';
  const segments = toSegments(payload.message);
  return {
    id: String(payload.message_id ?? ''),
    accountId,
    platform: 'onebot11',
    selfId: String(payload.self_id ?? selfId),
    scene: group ? 'group' : 'private',
    peerId: group ? String(payload.group_id) : String(payload.user_id),
    sender: senderOf(payload.sender),
    segments,
    text: segments
      .filter((s) => s.type === 'text')
      .map((s) => (s as { text: string }).text)
      .join(''),
    createdAt: Number(payload.time ?? 0) * 1000 || Date.now(),
    raw: payload,
  };
}
