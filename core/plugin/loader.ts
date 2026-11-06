import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { PLUGINS_DIR, pluginDataDir } from '../config/paths.ts';
import type { PluginManifest, PluginModule } from '../types.ts';

export function pluginDir(name: string): string {
  return path.join(PLUGINS_DIR, name);
}

export function ensurePluginData(accountId: string, name: string): string {
  const dir = pluginDataDir(accountId, name);
  fs.mkdirSync(path.join(dir, 'storage', 'files'), { recursive: true });
  const target = path.join(dir, 'config.json');
  const example = path.join(pluginDir(name), 'config.example.json');
  if (!fs.existsSync(target) && fs.existsSync(example)) fs.copyFileSync(example, target);
  return dir;
}

export function readUserConfig(dir: string): Record<string, unknown> {
  try {
    const file = path.join(dir, 'config.json');
    return fs.existsSync(file) ? JSON.parse(fs.readFileSync(file, 'utf8')) : {};
  } catch {
    return {};
  }
}

export async function importPlugin(name: string, manifest: PluginManifest): Promise<PluginModule> {
  const main = manifest.main ?? 'index.ts';
  const entry = path.join(pluginDir(name), main);
  if (!fs.existsSync(entry)) throw new Error(`入口不存在: ${main}`);
  const url = `${pathToFileURL(entry).href}?t=${Date.now()}`;
  return (await import(url)) as PluginModule;
}
