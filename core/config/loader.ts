import fs from 'node:fs';
import path from 'node:path';
import type { AccountConfig, GlobalConfig, PluginManifest } from '../types.ts';
import { PLUGINS_DIR, DATA_DIR, ACCOUNTS_DIR, GLOBAL_CONFIG_PATH, accountConfigPath, accountDir } from './paths.ts';

export const DEFAULT_GLOBAL: GlobalConfig = {
  logLevel: 'info',
  commandPrefix: '!',
  webui: { enabled: true, host: '127.0.0.1', port: 7301 },
  plugins: {},
};

export function isObject(v: unknown): v is Record<string, any> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

export function deepMerge<T>(...layers: unknown[]): T {
  let out: any = {};
  for (const layer of layers) {
    if (!isObject(layer)) continue;
    for (const [k, v] of Object.entries(layer)) {
      if (isObject(v) && isObject(out[k])) out[k] = deepMerge(out[k], v);
      else if (v !== undefined) out[k] = v;
    }
  }
  return out as T;
}

function readJson<T>(file: string): T | null {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8')) as T;
  } catch {
    return null;
  }
}

export function writeJson(file: string, data: unknown): void {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, JSON.stringify(data, null, 2), 'utf8');
}

export function ensureLayout(): { created: boolean } {
  fs.mkdirSync(ACCOUNTS_DIR, { recursive: true });
  if (fs.existsSync(GLOBAL_CONFIG_PATH)) return { created: false };
  writeJson(GLOBAL_CONFIG_PATH, DEFAULT_GLOBAL);
  return { created: true };
}

export function loadGlobal(): GlobalConfig {
  const raw = readJson<Partial<GlobalConfig>>(GLOBAL_CONFIG_PATH) ?? {};
  return deepMerge<GlobalConfig>(DEFAULT_GLOBAL, raw);
}

export function listAccountIds(): string[] {
  if (!fs.existsSync(ACCOUNTS_DIR)) return [];
  return fs
    .readdirSync(ACCOUNTS_DIR, { withFileTypes: true })
    .filter((d) => d.isDirectory())
    .map((d) => d.name)
    .filter((name) => fs.existsSync(accountConfigPath(name)));
}

export function loadAccount(id: string): AccountConfig | null {
  const raw = readJson<Partial<AccountConfig>>(accountConfigPath(id));
  if (!raw) return null;
  return {
    id: raw.id ?? id,
    platform: raw.platform ?? 'oldchat',
    label: raw.label ?? id,
    enabled: raw.enabled !== false,
    adapter: raw.adapter ?? {},
    plugins: raw.plugins ?? {},
  };
}

export function ensureAccountRuntime(id: string): void {
  const dir = accountDir(id);
  fs.mkdirSync(path.join(dir, 'plugins'), { recursive: true });
  const statePath = path.join(dir, 'state.json');
  if (!fs.existsSync(statePath)) writeJson(statePath, {});
}

export function readAccountState(id: string): Record<string, unknown> {
  return readJson<Record<string, unknown>>(path.join(accountDir(id), 'state.json')) ?? {};
}

export function writeAccountState(id: string, state: Record<string, unknown>): void {
  writeJson(path.join(accountDir(id), 'state.json'), state);
}

export function listPlugins(): PluginManifest[] {
  if (!fs.existsSync(PLUGINS_DIR)) return [];
  const out: PluginManifest[] = [];
  for (const entry of fs.readdirSync(PLUGINS_DIR, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue;
    const manifestPath = path.join(PLUGINS_DIR, entry.name, 'manifest.json');
    const manifest = readJson<PluginManifest>(manifestPath);
    if (!manifest) continue;
    out.push({ ...manifest, name: manifest.name ?? entry.name });
  }
  return out;
}

export function pluginExampleConfig(name: string): Record<string, unknown> {
  const file = path.join(PLUGINS_DIR, name, 'config.example.json');
  return readJson<Record<string, unknown>>(file) ?? {};
}

export function resolvePluginConfig(
  name: string,
  global: GlobalConfig,
  account: AccountConfig | null,
  userConfig: Record<string, unknown>,
): Record<string, any> {
  return deepMerge(
    pluginExampleConfig(name),
    global.plugins?.[name] ?? {},
    account?.plugins?.[name]?.config ?? {},
    userConfig,
  );
}

export function updateAccount(id: string, patch: Partial<AccountConfig>): void {
  const current = loadAccount(id);
  if (!current) throw new Error(`账户不存在: ${id}`);
  writeJson(accountConfigPath(id), deepMerge(current, patch));
}

export function updateGlobal(patch: Record<string, unknown>): GlobalConfig {
  const next = deepMerge<GlobalConfig>(loadGlobal(), patch);
  writeJson(GLOBAL_CONFIG_PATH, next);
  return next;
}

export function dataDirExists(): boolean {
  return fs.existsSync(DATA_DIR);
}
