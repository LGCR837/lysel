import path from 'node:path';

export const ROOT = process.cwd();
export const DATA_DIR = path.join(ROOT, 'data');
export const PLUGINS_DIR = path.join(ROOT, 'plugins');
export const GLOBAL_CONFIG_PATH = path.join(DATA_DIR, 'bot.json');
export const SHARED_DIR = path.join(DATA_DIR, 'shared');
export const ACCOUNTS_DIR = path.join(DATA_DIR, 'accounts');

export const accountDir = (id: string) => path.join(ACCOUNTS_DIR, id);
export const accountConfigPath = (id: string) => path.join(accountDir(id), 'account.json');
export const accountStatePath = (id: string) => path.join(accountDir(id), 'state.json');
export const accountPluginsDir = (id: string) => path.join(accountDir(id), 'plugins');
export const pluginDataDir = (accountId: string, name: string) =>
  path.join(accountPluginsDir(accountId), name);
