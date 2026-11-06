import crypto from 'node:crypto';
import { BaseAdapter } from '../base.ts';
import { createLogger } from '../../log.ts';
import { AdapterError } from '../../errors.ts';
import { CryptoSession } from '../../crypto/session.ts';
import { OCHttp } from '../../transport/http.ts';
import { EventSocket } from '../../transport/ws.ts';
import type {
  AccountConfig,
  Capabilities,
  Member,
  Peer,
  Segment,
  SendResult,
  UserInfo,
} from '../../types.ts';
import { loginWithPassword, refreshSession, type LoginResult } from './auth.ts';
import { encodeSegments } from './codec.ts';
import { toMessageEvent } from './events.ts';

export class OldChatAdapter extends BaseAdapter {
  private log;
  private session: CryptoSession;
  private http: OCHttp;
  private socket: EventSocket | null = null;
  private token = '';
  private refreshToken = '';
  private deviceId = '';
  private readonly origin: string;

  constructor(
    private readonly account: AccountConfig,
    private readonly getState: () => Record<string, any>,
    private readonly setState: (patch: Record<string, any>) => void,
  ) {
    super(account.id, 'oldchat');
    this.log = createLogger(`oldchat:${account.id}`);
    this.origin = String(account.adapter?.origin ?? 'https://oc.mcl0.dpdns.org').replace(/\/+$/, '');
    this.session = new CryptoSession(this.origin);
    this.http = new OCHttp(
      this.origin,
      this.session,
      () => this.token,
      () => this.account.adapter?.encrypt !== false,
      () => this.renew(),
    );
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
      readReport: true,
      groupAdmin: true,
      maxTextLen: 4000,
    };
  }

  async start(): Promise<void> {
    const state = this.getState();
    this.deviceId = String(state.deviceId ?? '') || crypto.randomUUID();
    this.token = String(state.accessToken ?? '');
    this.refreshToken = String(state.refreshToken ?? '');
    this.selfId = String(state.selfId ?? '');
    await this.session.ensure();
    if (!this.token) await this.signIn();

    this.socket = new EventSocket({
      origin: this.origin,
      token: () => this.token,
      deviceId: this.deviceId,
      session: this.session,
      onEvent: (type, data, pts) => this.handleEvent(type, data, pts),
      onOpen: () => this.emitStatus(true),
      onClose: () => this.emitStatus(false),
    });
    this.socket.start();
    this.log.info(`适配器已启动 ${this.selfId || this.deviceId}`);
  }

  async stop(): Promise<void> {
    this.socket?.stop();
    this.socket = null;
    this.emitStatus(false);
  }

  async send(peer: Peer, seg: Segment[]): Promise<SendResult> {
    const enc = encodeSegments(seg);
    const payload = {
      body: enc.body,
      msg_type: enc.msgType,
      media_url: enc.mediaUrl,
      thumb_url: enc.thumbUrl,
      duration_ms: 0,
    };
    const res =
      peer.scene === 'group'
        ? await this.http.gateway<any>('POST', '/v2/groups/message/send', { group_id: peer.id, ...payload })
        : await this.http.gateway<any>(
            'POST',
            '/v2/direct/send',
            peer.id.startsWith('nc_') ? { to_ncuid: peer.id, ...payload } : { to_uid: peer.id, ...payload },
          );
    return { messageId: String(res?.id ?? '') };
  }

  async recall(peer: Peer, messageId: string): Promise<void> {
    if (peer.scene === 'group') {
      await this.http.request('/v1/groups/recall', {
        method: 'POST',
        body: { group_id: peer.id, message_id: messageId },
      });
    } else {
      await this.http.request('/v1/direct/recall', { method: 'POST', body: { message_id: messageId } });
    }
  }

  async getUser(userId: string): Promise<UserInfo | null> {
    const res = await this.http.request<any>('/v2/users/profile', { query: { uid: userId } });
    if (!res) return null;
    return {
      id: String(res.ncuid ?? res.uid ?? userId),
      name: String(res.display_name ?? res.username ?? userId),
      avatar: res.avatar_url,
    };
  }

  async getGroupMembers(groupId: string): Promise<Member[]> {
    const res = await this.http.request<any>('/v2/groups/members', { query: { group_id: groupId } });
    const list = Array.isArray(res) ? res : (res?.members ?? res?.items ?? []);
    return list.map((m: any) => ({
      id: String(m.ncuid ?? m.uid ?? ''),
      name: String(m.display_name ?? m.username ?? ''),
      avatar: m.avatar_url,
      role: m.role,
    }));
  }

  native(): unknown {
    return {
      session: this.session,
      request: (path: string, opts?: Record<string, unknown>) => this.http.request(path, opts as any),
      gateway: (method: string, path: string, body?: unknown, query?: Record<string, string>) =>
        this.http.gateway(method, path, body, query),
    };
  }

  private async signIn(): Promise<void> {
    const identifier = String(this.account.adapter?.identifier ?? '');
    const password = String(this.account.adapter?.password ?? '');
    if (!identifier || !password) throw new AdapterError('账户缺少凭据', 'missing_credentials');
    const res = await loginWithPassword(this.http, identifier, password, this.deviceId);
    this.applyLogin(res);
    this.selfId = String(res.user?.ncuid ?? res.user?.uid ?? this.selfId);
    this.setState({ selfId: this.selfId });
    this.log.info(`登录成功 ${this.selfId}`);
  }

  private async renew(): Promise<boolean> {
    if (!this.refreshToken) return false;
    try {
      const res = await refreshSession(this.http, this.refreshToken);
      this.applyLogin(res);
      return true;
    } catch {
      return false;
    }
  }

  private applyLogin(res: LoginResult): void {
    this.token = res.access_token;
    this.refreshToken = res.refresh_token || this.refreshToken;
    this.setState({
      accessToken: this.token,
      refreshToken: this.refreshToken,
      deviceId: this.deviceId,
      selfId: this.selfId,
    });
  }

  private handleEvent(type: string, data: any, pts?: number): void {
    if (typeof pts === 'number') this.setState({ pts });
    if (type === 'direct_message' || type === 'group_message') {
      const evt = toMessageEvent(this.accountId, this.selfId, type, data);
      if (evt) this.emitMessage(evt);
    }
  }
}
