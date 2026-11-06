import type { MessageEvent, MessageHandler } from './types.ts';

export interface CommandEntry {
  plugin: string;
  handler: (args: string[], evt: MessageEvent) => unknown;
}

export interface MessageEntry {
  plugin: string;
  handler: MessageHandler;
}

export class Router {
  private commands = new Map<string, CommandEntry[]>();
  private messages: MessageEntry[] = [];

  addCommand(plugin: string, name: string, handler: CommandEntry['handler']): void {
    const key = name.toLowerCase();
    const list = this.commands.get(key) ?? [];
    list.push({ plugin, handler });
    this.commands.set(key, list);
  }

  addMessage(plugin: string, handler: MessageHandler): void {
    this.messages.push({ plugin, handler });
  }

  clearPlugin(plugin: string): void {
    for (const [key, list] of this.commands) {
      const kept = list.filter((c) => c.plugin !== plugin);
      if (kept.length) this.commands.set(key, kept);
      else this.commands.delete(key);
    }
    this.messages = this.messages.filter((m) => m.plugin !== plugin);
  }

  commandNames(): string[] {
    return [...this.commands.keys()];
  }

  match(text: string, prefix: string): { name: string; args: string[] } | null {
    if (!prefix || !text.startsWith(prefix)) return null;
    const body = text.slice(prefix.length).trim();
    if (!body) return null;
    const parts = body.split(/\s+/);
    const name = parts[0].toLowerCase();
    if (!this.commands.has(name)) return null;
    return { name, args: parts.slice(1) };
  }

  commandHandlers(name: string): CommandEntry[] {
    return this.commands.get(name.toLowerCase()) ?? [];
  }

  messageHandlers(): MessageEntry[] {
    return [...this.messages];
  }

  get size(): number {
    return this.messages.length + this.commands.size;
  }
}
