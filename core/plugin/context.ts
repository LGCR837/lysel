import type {
  AccountRef,
  Adapter,
  Logger,
  MessageEvent,
  MessageHandler,
  Peer,
  PluginContext,
  PluginStorage,
  Segment,
  SegmentInput,
} from '../types.ts';
import type { Router } from '../router.ts';

export interface ContextDeps {
  name: string;
  account: AccountRef;
  config: Record<string, any>;
  prefixes: string[];
  storage: PluginStorage;
  adapter: Adapter;
  router: Router;
  schedule: (id: string, ms: number, fn: () => void) => void;
  log: Logger;
}

export function normalizeSegments(input: SegmentInput): Segment[] {
  if (typeof input === 'string') return [{ type: 'text', text: input }];
  return Array.isArray(input) ? input : [input];
}

export function peerOf(evt: MessageEvent): Peer {
  return { scene: evt.scene, id: evt.peerId };
}

export function createContext(deps: ContextDeps): PluginContext {
  const { name, account, config, prefixes, storage, adapter, router, schedule, log } = deps;

  const ctx: PluginContext = {
    name,
    account,
    config: Object.freeze(config),
    prefixes: Object.freeze([...prefixes]),
    storage,
    log,
    send(target, seg) {
      const peer = 'scene' in target ? peerOf(target as MessageEvent) : (target as Peer);
      return adapter.send(peer, normalizeSegments(seg));
    },
    reply(evt, seg) {
      return adapter.send(peerOf(evt), normalizeSegments(seg));
    },
    async typing(target, isTyping = true) {
      const peer = 'scene' in target ? peerOf(target as MessageEvent) : (target as Peer);
      await adapter.typing(peer, isTyping);
    },
    upload(data, mime, name) {
      return adapter.upload(data, mime, name);
    },
    async recall(evt) {
      await adapter.recall(peerOf(evt), evt.id);
    },
    getUser(userId) {
      return adapter.getUser(userId);
    },
    getGroupMembers(groupId) {
      return adapter.getGroupMembers(groupId);
    },
    onMessage(h: MessageHandler) {
      router.addMessage(name, h);
    },
    command(cmd, h) {
      router.addCommand(name, cmd, h);
    },
    native<T = unknown>(): T {
      return adapter.native() as T;
    },
    schedule,
  };

  return Object.freeze(ctx);
}
