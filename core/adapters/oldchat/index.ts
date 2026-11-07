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
  /** 登录返回的 uid，与 selfId（ncuid）并存用于 @ 自己判定 */
  private selfUid = '';
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
      this.log,
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
    if (this.deviceId !== state.deviceId) this.setState({ deviceId: this.deviceId });
    this.token = String(state.accessToken ?? '');
    this.refreshToken = String(state.refreshToken ?? '');
    this.selfId = String(state.selfId ?? '');
    this.selfUid = String(state.selfUid ?? '');
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
      onError: (info) => this.recover(info),
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
    if (enc.msgType === 'voice' && enc.durationMs > 60000) {
      throw new AdapterError('语音超过 60 秒上限', 'duration_too_long');
    }
    const payload = {
      body: enc.body,
      msg_type: enc.msgType,
      media_url: enc.mediaUrl,
      thumb_url: enc.thumbUrl,
      // 服务端要求语音必须带 duration_ms，缺省按上限申报
      duration_ms: enc.msgType === 'voice' ? enc.durationMs || 60000 : enc.durationMs,
    };
    this.log.debug(
      `发送 ${peer.scene} ${peer.id} type=${enc.msgType} body=${enc.body.slice(0, 120)}` +
        (enc.mediaUrl ? ` media=${enc.mediaUrl}` : '') +
        (enc.durationMs ? ` duration=${enc.durationMs}` : ''),
    );
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

  /** 输入中状态，服务端 8 秒过期，插件需自行续租 */
  async typing(peer: Peer, isTyping: boolean): Promise<void> {
    // 服务端只认大写 UID / GRP-xxx，nc_ 开头的本地 id 无法上报
    const id = String(peer.id ?? '').toUpperCase();
    if (!/^[A-Z0-9-]{4,32}$/.test(id)) {
      this.log.debug(`输入状态跳过 无效 id=${peer.id}`);
      return;
    }
    const path = peer.scene === 'group' ? '/v2/groups/typing' : '/v2/chats/typing';
    await this.http
      .gateway('POST', path, { chat_id: id, is_typing: isTyping, is_group: peer.scene === 'group' })
      .catch((e: any) => this.log.debug(`输入状态发送失败 ${e?.message ?? e}`));
  }

  /** 上传媒体，返回服务端相对地址（/v1/uploads/...） */
  async upload(data: Uint8Array, mime: string, name = 'image.png'): Promise<string> {
    const started = Date.now();
    this.log.debug(`上传开始 ${name} ${mime} ${data.length}B`);
    const form = new FormData();
    form.append('file', new Blob([data], { type: mime }), name);
    const res = await fetch(new URL('/v1/media', this.origin), {
      method: 'POST',
      headers: { Authorization: `Bearer ${this.token}` },
      body: form,
    });
    const text = await res.text();
    let json: any = null;
    try {
      json = text ? JSON.parse(text) : null;
    } catch {
      json = null;
    }
    if (!res.ok) {
      this.log.warn(`上传失败 ${res.status} ${Date.now() - started}ms ${text.slice(0, 300)}`);
      throw new AdapterError(json?.error ?? json?.message ?? `上传失败 ${res.status}`, String(json?.code ?? res.status), res.status);
    }
    const url = json?.url ?? json?.media_url ?? json?.data?.url;
    if (!url) throw new AdapterError(`上传未返回地址 ${text.slice(0, 200)}`, 'upload_no_url');
    this.log.debug(`上传完成 ${url} ${Date.now() - started}ms`);
    return String(url);
  }

  async getUser(userId: string): Promise<UserInfo | null> {    const res = await this.http.request<any>('/v2/users/profile', { query: { uid: userId } });
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
      uid: String(m.uid ?? ''),
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
    this.selfUid = String(res.user?.uid ?? this.selfUid);
    this.setState({ selfId: this.selfId, selfUid: this.selfUid });
    this.log.info(`登录成功 ${this.selfId}${this.selfUid ? `/${this.selfUid}` : ''}`);
  }

  private recovering: Promise<void> | null = null;
  private lastRecover = 0;

  private recover(info: string): void {
    const now = Date.now();
    if (this.recovering || now - this.lastRecover < 60000) return;
    this.lastRecover = now;
    this.recovering = (async () => {
      this.log.warn(`恢复凭据 ${info}`);
      if (await this.renew()) {
        this.log.info('凭据已续期');
        return;
      }
      await this.signIn();
      this.log.info('已重新登录');
    })()
      .catch((e: any) => this.log.error(`恢复凭据失败 ${e?.message ?? e}`))
      .finally(() => {
        this.recovering = null;
      });
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
      selfUid: this.selfUid,
    });
  }

  private handleEvent(type: string, data: any, pts?: number): void {
    if (typeof pts === 'number') this.setState({ pts });
    if (type === 'direct_message' || type === 'group_message') {
      const evt = toMessageEvent(this.accountId, this.selfId, type, data, this.selfUid);
      if (evt) this.emitMessage(evt);
    }
  }
}
