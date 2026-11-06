import fs from 'node:fs';
import path from 'node:path';
import type { PluginStorage } from '../types.ts';

export class FileStorage implements PluginStorage {
  private readonly kvPath: string;
  private cache: Record<string, unknown>;

  constructor(private readonly dir: string) {
    fs.mkdirSync(path.join(dir, 'files'), { recursive: true });
    this.kvPath = path.join(dir, 'kv.json');
    this.cache = this.load();
  }

  get<T = unknown>(key: string, fallback?: T): T {
    return (key in this.cache ? this.cache[key] : fallback) as T;
  }

  set(key: string, value: unknown): void {
    this.cache[key] = value;
    this.flush();
  }

  delete(key: string): void {
    delete this.cache[key];
    this.flush();
  }

  all(): Record<string, unknown> {
    return { ...this.cache };
  }

  file(name: string): string {
    const target = path.resolve(this.dir, 'files', name);
    if (!target.startsWith(path.resolve(this.dir))) throw new Error('非法路径');
    fs.mkdirSync(path.dirname(target), { recursive: true });
    return target;
  }

  readText(name: string): string | null {
    const target = this.file(name);
    return fs.existsSync(target) ? fs.readFileSync(target, 'utf8') : null;
  }

  writeText(name: string, data: string): void {
    fs.writeFileSync(this.file(name), data, 'utf8');
  }

  private load(): Record<string, unknown> {
    try {
      if (!fs.existsSync(this.kvPath)) return {};
      const raw = JSON.parse(fs.readFileSync(this.kvPath, 'utf8'));
      return raw && typeof raw === 'object' ? raw : {};
    } catch {
      return {};
    }
  }

  private flush(): void {
    fs.writeFileSync(this.kvPath, JSON.stringify(this.cache, null, 2), 'utf8');
  }
}
