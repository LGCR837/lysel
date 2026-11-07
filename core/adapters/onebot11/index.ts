import { BaseAdapter } from '../base.ts';
import { createLogger } from '../../log.ts';
import { AdapterError } from '../../errors.ts';
import type {
  AccountConfig,
  Capabilities,
  Member,
  Peer,
  Segment,
  SendResult,
  UserInfo,
} from '../../types.ts';
import { fromSegments } from './codec.ts';
import { toMessageEvent } from './events.ts';
import { createOneBotApi, type OneBotApi } from './api.ts';

interface Pending {
  resolve: (v: any) => void;
  reject: (e: unknown) => void;
  timer: NodeJS.Timeout;
}

export class OneBot11Adapter extends BaseAdapter {
  private log;
  private socket: WebSocket | null = null;
  private api: OneBotApi;
  private seq = 0;
  private pending = new Map<string, Pending>();
  private stopped = false;
  private delay = 1000;
  private waiters: (() => void)[] = [];

  constructor(
    private readonly account: AccountConfig,
    private readonly getState: () => Record<string, any>,
    private readonly setState: (patch: Record<string, any>) => void,
  ) {
    super(account.id, 'onebot11');
    this.log = createLogger(`onebot11:${account.id}`);
    this.api = createOneBotApi((action, params) => this.call(action, params));
  }

  private get cfg() {
    return this.account.adapter ?? {};
  }

  capabilities(): Capabilities {
    return {
      image: true,
      voice: true,
      video: true,
      file: true,
      at: true,
      reply: true,
      recall: true,
      readReport: false,
      groupAdmin: true,
      maxTextLen: 4500,
    };
  }

  async start(): Promise<void> {
    this.stopped = false;
    this.connect();
    await new Promise<void>((resolve) => {
      this.waiters.push(resolve);
      setTimeout(resolve, 10000);
    });
  }

  async stop(): Promise<void> {
    this.stopped = true;
    this.socket?.close();
    this.socket = null;
    for (const p of this.pending.values()) {
      clearTimeout(p.timer);
      p.reject(new AdapterError('连接已关闭', 'closed'));
    }
    this.pending.clear();
  }

  async send(peer: Peer, seg: Segment[]): Promise<SendResult> {
    const message = fromSegments(seg);
    const res =
      peer.scene === 'group'
        ? await this.api.sendGroup(peer.id, message)
        : await this.api.sendPrivate(peer.id, message);
    return { messageId: String(res?.message_id ?? '') };
  }

  async recall(_peer: Peer, messageId: string): Promise<void> {
    await this.api.deleteMsg(messageId);
  }

  /** OneBot 没有输入中接口，图片改走 base64 直发 */
  async upload(data: Uint8Array, _mime: string, _name?: string): Promise<string> {
    return `base64://${Buffer.from(data).toString('base64')}`;
  }

  async getUser(userId: string): Promise<UserInfo | null> {
    const info = await this.api.strangerInfo(userId);
    if (!info) return null;
    return { id: String(info.user_id ?? userId), name: String(info.nickname ?? userId) };
  }

  async getGroupMembers(groupId: string): Promise<Member[]> {
    const list = (await this.api.groupMemberList(groupId)) ?? [];
    return (Array.isArray(list) ? list : []).map((m: any) => ({
      id: String(m.user_id ?? ''),
      name: String(m.card || m.nickname || m.user_id || ''),
      card: m.card,
      role: m.role,
    }));
  }

  native(): unknown {
    return { call: (action: string, params?: Record<string, unknown>) => this.call(action, params) };
  }

  call(action: string, params: Record<string, unknown> = {}): Promise<any> {
    return new Promise((resolve, reject) => {
      if (!this.socket || this.socket.readyState !== 1) {
        reject(new AdapterError('未连接', 'not_connected'));
        return;
      }
      const echo = `lysel-${++this.seq}`;
      const timer = setTimeout(() => {
        this.pending.delete(echo);
        reject(new AdapterError(`调用超时 ${action}`, 'timeout'));
      }, 15000);
      this.pending.set(echo, { resolve, reject, timer });
      this.socket.send(JSON.stringify({ action, params, echo }));
    });
  }

  private connect(): void {
    if (this.stopped) return;
    const state = this.getState();
    const base = String(this.cfg.url ?? 'ws://127.0.0.1:3001');
    const url = new URL(base);
    const token = String(this.cfg.token ?? state.token ?? '');
    if (token) url.searchParams.set('access_token', token);

    const socket = new WebSocket(url.toString());
    this.socket = socket;

    socket.addEventListener('open', async () => {
      this.delay = 1000;
      this.log.info(`已连接 ${url.origin}`);
      try {
        const info = await this.api.loginInfo();
        this.selfId = String(info?.user_id ?? this.cfg.selfId ?? '');
        this.setState({ selfId: this.selfId });
      } catch {}
      this.emitStatus(true);
      const waiters = this.waiters;
      this.waiters = [];
      for (const w of waiters) w();
    });

    socket.addEventListener('message', (ev) => {
      if (typeof ev.data !== 'string') return;
      let payload: any;
      try {
        payload = JSON.parse(ev.data);
      } catch {
        return;
      }
      const echo = payload?.echo;
      if (echo && this.pending.has(echo)) {
        const p = this.pending.get(echo)!;
        this.pending.delete(echo);
        clearTimeout(p.timer);
        if (payload.status === 'failed' || payload.retcode) p.reject(new AdapterError(String(payload.wording ?? payload.message ?? '调用失败'), 'action_failed'));
        else p.resolve(payload.data);
        return;
      }
      const evt = toMessageEvent(this.accountId, this.selfId, payload);
      if (evt) this.emitMessage(evt);
    });

    socket.addEventListener('close', (ev) => {
      this.emitStatus(false);
      if (this.stopped) return;
      this.log.warn(`连接断开 ${ev.code}，${this.delay}ms 后重连`);
      setTimeout(() => this.connect(), this.delay);
      this.delay = Math.min(this.delay * 2, 30000);
    });

    socket.addEventListener('error', () => {
      try {
        socket.close();
      } catch {}
    });
  }
}
