import type { Logger, MessageEvent } from './types.ts';
import type { Router } from './router.ts';

const HANDLER_TIMEOUT = 15000;

/** 包装一次 handler 调用：计时、超时、异常全部落到插件自己的日志里 */
function trace(p: unknown, plugin: string, log: Logger, label: string): void {
  if (!(p instanceof Promise)) {
    log.debug(`${label} 同步返回`);
    return;
  }
  const started = Date.now();
  let timer: NodeJS.Timeout;
  const timeout = new Promise<void>((_, reject) => {
    timer = setTimeout(() => reject(new Error(`handler 超时 ${HANDLER_TIMEOUT}ms`)), HANDLER_TIMEOUT);
  });
  Promise.race([p, timeout])
    .then(() => log.debug(`${label} 完成 ${Date.now() - started}ms`))
    .catch((e: any) => log.error(`${label} 失败 ${e?.message ?? e}`))
    .finally(() => clearTimeout(timer));
}

export class Dispatcher {
  constructor(
    private readonly router: Router,
    private readonly log: Logger,
    private readonly getPrefix: () => string,
  ) {}

  dispatch(evt: MessageEvent): void {
    const handlers = this.router.messageHandlers();
    this.log.debug(
      `派发 scene=${evt.scene} peer=${evt.peerId} 文本长度=${String(evt.text ?? '').length} 监听者=${handlers.length}`,
    );
    for (const entry of handlers) {
      try {
        trace(entry.handler(evt), entry.plugin, this.log, '消息处理');
      } catch (e: any) {
        this.log.error(`[${entry.plugin}] 消息处理抛错 ${e?.message ?? e}`);
      }
    }

    const matched = this.router.match(evt.text, this.getPrefix());
    if (!matched) return;
    for (const entry of this.router.commandHandlers(matched.name)) {
      try {
        trace(entry.handler(matched.args, evt), entry.plugin, this.log, `命令 ${matched.name}`);
      } catch (e: any) {
        this.log.error(`[${entry.plugin}] 命令 ${matched.name} 抛错 ${e?.message ?? e}`);
      }
    }
  }
}
