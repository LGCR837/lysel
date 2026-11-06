import type { Logger, MessageEvent } from './types.ts';
import type { Router } from './router.ts';

const HANDLER_TIMEOUT = 15000;

function withTimeout(p: unknown, plugin: string, log: Logger): void {
  if (!(p instanceof Promise)) return;
  let timer: NodeJS.Timeout;
  const timeout = new Promise<void>((_, reject) => {
    timer = setTimeout(() => reject(new Error('handler 超时')), HANDLER_TIMEOUT);
  });
  Promise.race([p, timeout])
    .catch((e: any) => log.error(`[${plugin}]`, e?.message ?? e))
    .finally(() => clearTimeout(timer));
}

export class Dispatcher {
  constructor(
    private readonly router: Router,
    private readonly log: Logger,
    private readonly getPrefix: () => string,
  ) {}

  dispatch(evt: MessageEvent): void {
    for (const entry of this.router.messageHandlers()) {
      try {
        withTimeout(entry.handler(evt), entry.plugin, this.log);
      } catch (e: any) {
        this.log.error(`[${entry.plugin}]`, e?.message ?? e);
      }
    }

    const matched = this.router.match(evt.text, this.getPrefix());
    if (!matched) return;
    for (const entry of this.router.commandHandlers(matched.name)) {
      try {
        withTimeout(entry.handler(matched.args, evt), entry.plugin, this.log);
      } catch (e: any) {
        this.log.error(`[${entry.plugin}]`, e?.message ?? e);
      }
    }
  }
}
