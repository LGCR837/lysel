import type { AccountConfig, Adapter } from '../types.ts';
import { OldChatAdapter } from './oldchat/index.ts';
import { OneBot11Adapter } from './onebot11/index.ts';

export type AdapterFactory = (
  account: AccountConfig,
  getState: () => Record<string, any>,
  setState: (patch: Record<string, any>) => void,
) => Adapter;

const factories = new Map<string, AdapterFactory>();

export function registerAdapter(platform: string, factory: AdapterFactory): void {
  factories.set(platform, factory);
}

export function createAdapter(
  account: AccountConfig,
  getState: () => Record<string, any>,
  setState: (patch: Record<string, any>) => void,
): Adapter | null {
  const factory = factories.get(account.platform);
  if (!factory) return null;
  return factory(account, getState, setState);
}

export function knownPlatforms(): string[] {
  return [...factories.keys()];
}

registerAdapter('oldchat', (account, getState, setState) => new OldChatAdapter(account, getState, setState));
registerAdapter('onebot11', (account, getState, setState) => new OneBot11Adapter(account, getState, setState));
