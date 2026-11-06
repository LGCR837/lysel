import { CryptoSession } from '../crypto/session.ts';
import { createLogger } from '../log.ts';

const log = createLogger('ws');

export interface WsOptions {
  origin: string;
  token: () => string;
  deviceId: string;
  session?: CryptoSession;
  onEvent: (type: string, data: any, pts?: number) => void;
  onOpen?: () => void;
  onClose?: (code: number) => void;
}

export class EventSocket {
  private socket: WebSocket | null = null;
  private reconnectDelay = 1000;
  private timer: NodeJS.Timeout | null = null;
  private stopped = false;

  constructor(private readonly opts: WsOptions) {}

  start(): void {
    this.stopped = false;
    void this.connect();
  }

  stop(): void {
    this.stopped = true;
    if (this.timer) clearTimeout(this.timer);
    this.socket?.close();
    this.socket = null;
  }

  private scheduleReconnect(): void {
    if (this.stopped) return;
    log.warn(`连接断开，${this.reconnectDelay}ms 后重连`);
    this.timer = setTimeout(() => void this.connect(), this.reconnectDelay);
    this.reconnectDelay = Math.min(this.reconnectDelay * 2, 30000);
  }

  private url(): string {
    const base = this.opts.origin.replace(/^http/, 'ws');
    const url = new URL('/v1/ws', base);
    url.searchParams.set('token', this.opts.token());
    url.searchParams.set('device_id', this.opts.deviceId);
    const sid = this.opts.session?.id;
    if (sid && this.opts.session?.ready) url.searchParams.set('sid', sid);
    return url.toString();
  }

  private async connect(): Promise<void> {
    if (this.stopped) return;
    try {
      await this.opts.session?.ensure();
    } catch (e: any) {
      log.warn('握手失败，稍后重试', e?.message ?? e);
      this.scheduleReconnect();
      return;
    }
    const socket = new WebSocket(this.url());
    this.socket = socket;

    socket.addEventListener('open', () => {
      this.reconnectDelay = 1000;
      log.info('已连接');
      this.opts.onOpen?.();
    });

    socket.addEventListener('message', (ev) => {
      try {
        const raw = typeof ev.data === 'string' ? ev.data : '';
        if (!raw) return;
        const text = this.opts.session?.ready ? this.opts.session.decrypt(raw) : raw;
        const frame = JSON.parse(text);
        if (frame?.type) this.opts.onEvent(frame.type, frame.data, frame.pts);
      } catch (e: any) {
        log.warn('帧解析失败', e?.message ?? e);
      }
    });

    socket.addEventListener('close', (ev) => {
      this.opts.onClose?.(ev.code);
      if (this.stopped) return;
      this.opts.session?.reset();
      this.scheduleReconnect();
    });

    socket.addEventListener('error', () => {
      try {
        socket.close();
      } catch {}
    });
  }
}
