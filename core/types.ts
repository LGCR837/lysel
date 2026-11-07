export type Scene = 'private' | 'group';

export type Segment =
  | { type: 'text'; text: string }
  | { type: 'at'; id: string; name?: string }
  | { type: 'reply'; id: string }
  | { type: 'image'; url?: string; file?: string }
  | { type: 'voice'; url?: string; duration?: number }
  | { type: 'video'; url?: string }
  | { type: 'face'; id?: string }
  | { type: 'file'; url?: string; name?: string };

export type SegmentInput = string | Segment | Segment[];

export interface Sender {
  id: string;
  name: string;
  role?: 'owner' | 'admin' | 'member';
}

export interface Peer {
  scene: Scene;
  id: string;
}

export interface MessageEvent {
  id: string;
  accountId: string;
  platform: string;
  selfId: string;
  scene: Scene;
  peerId: string;
  sender: Sender;
  segments: Segment[];
  text: string;
  createdAt: number;
  raw: unknown;
}

export interface Capabilities {
  image: boolean;
  voice: boolean;
  video: boolean;
  file: boolean;
  at: boolean;
  reply: boolean;
  recall: boolean;
  readReport: boolean;
  groupAdmin: boolean;
  maxTextLen: number;
}

export interface SendResult {
  messageId: string;
}

export interface UserInfo {
  id: string;
  name: string;
  avatar?: string;
  role?: string;
}

export interface GroupInfo {
  id: string;
  name: string;
  memberCount?: number;
}

export interface Member extends UserInfo {
  card?: string;
}

export interface AdapterStatus {
  accountId: string;
  platform: string;
  online: boolean;
  selfId: string;
  since: number;
  lastError?: string;
}

export type MessageHandler = (evt: MessageEvent) => unknown;

export interface Adapter {
  readonly platform: string;
  readonly accountId: string;
  selfId: string;
  capabilities(): Capabilities;
  start(): Promise<void>;
  stop(): Promise<void>;
  send(peer: Peer, seg: Segment[]): Promise<SendResult>;
  recall(peer: Peer, messageId: string): Promise<void>;
  getUser(userId: string): Promise<UserInfo | null>;
  getGroupMembers(groupId: string): Promise<Member[]>;
  native(): unknown;
  status(): AdapterStatus;
  onMessage(h: MessageHandler): void;
  onStatus(h: (s: AdapterStatus) => void): void;
}

export interface AccountRef {
  id: string;
  platform: string;
  label: string;
  selfId: string;
  capabilities: Capabilities;
}

export interface PluginManifest {
  name: string;
  version: string;
  description?: string;
  author?: string;
  main?: string;
  sandbox?: 'guard' | 'none';
}

export interface GlobalConfig {
  logLevel: 'debug' | 'info' | 'warn' | 'error';
  commandPrefix: string;
  /** 插件可选剥离的前缀，框架不强制 */
  prefixes: string[];
  consolePassword: string;
  /** 插件代码变更自动重载 */
  hotReload: boolean;
  webui: { enabled: boolean; host: string; port: number };
  plugins: Record<string, Record<string, unknown>>;
}

export interface AccountConfig {
  id: string;
  platform: 'oldchat' | 'onebot11' | string;
  label?: string;
  enabled: boolean;
  prefixes?: string[];
  adapter: Record<string, any>;
  plugins?: Record<string, { enabled?: boolean; config?: Record<string, unknown> }>;
}

export interface PluginContext {
  readonly name: string;
  readonly account: AccountRef;
  readonly config: Readonly<Record<string, any>>;
  /** 前缀可有可无，插件自行决定剥离 */
  readonly prefixes: readonly string[];
  readonly storage: PluginStorage;
  send(peer: Peer | MessageEvent, seg: SegmentInput): Promise<SendResult>;
  reply(evt: MessageEvent, seg: SegmentInput): Promise<SendResult>;
  recall(evt: MessageEvent): Promise<void>;
  getUser(userId: string): Promise<UserInfo | null>;
  onMessage(h: MessageHandler): void;
  command(name: string, h: (args: string[], evt: MessageEvent) => unknown): void;
  native<T = unknown>(): T;
  schedule(id: string, ms: number, fn: () => void): void;
  log: Logger;
}

export interface PluginStorage {
  get<T = unknown>(key: string, fallback?: T): T;
  set(key: string, value: unknown): void;
  delete(key: string): void;
  all(): Record<string, unknown>;
  file(name: string): string;
  readText(name: string): string | null;
  writeText(name: string, data: string): void;
}

export interface Logger {
  debug(...a: unknown[]): void;
  info(...a: unknown[]): void;
  warn(...a: unknown[]): void;
  error(...a: unknown[]): void;
}

export interface PluginModule {
  onLoad?: (ctx: PluginContext) => unknown;
  onUnload?: () => unknown;
}
