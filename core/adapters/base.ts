import { EventBus } from '../bus.ts';
import { CapabilityError } from '../errors.ts';
import type {
  Adapter,
  AdapterStatus,
  Capabilities,
  Member,
  MessageEvent,
  MessageHandler,
  Peer,
  Segment,
  SendResult,
  UserInfo,
} from '../types.ts';

export abstract class BaseAdapter implements Adapter {
  readonly platform: string;
  readonly accountId: string;
  selfId = '';
  protected bus = new EventBus();
  protected _status: AdapterStatus;

  constructor(accountId: string, platform: string) {
    this.accountId = accountId;
    this.platform = platform;
    this._status = { accountId, platform, online: false, selfId: '', since: 0 };
  }

  abstract capabilities(): Capabilities;
  abstract start(): Promise<void>;
  abstract stop(): Promise<void>;
  abstract send(peer: Peer, seg: Segment[]): Promise<SendResult>;

  async recall(_peer: Peer, _messageId: string): Promise<void> {
    throw new CapabilityError('recall');
  }

  async getUser(_userId: string): Promise<UserInfo | null> {
    return null;
  }

  async getGroupMembers(_groupId: string): Promise<Member[]> {
    return [];
  }

  native(): unknown {
    return null;
  }

  status(): AdapterStatus {
    return { ...this._status, selfId: this.selfId };
  }

  onMessage(h: MessageHandler): void {
    this.bus.on('message', h);
  }

  onStatus(h: (s: AdapterStatus) => void): void {
    this.bus.on('status', h);
  }

  protected emitMessage(evt: MessageEvent): void {
    this.bus.emit('message', evt);
  }

  protected emitStatus(online: boolean, lastError?: string): void {
    this._status = {
      ...this._status,
      online,
      selfId: this.selfId,
      since: online ? this._status.since || Date.now() : 0,
      lastError,
    };
    this.bus.emit('status', this._status);
  }
}
