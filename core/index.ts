import { App } from './app.ts';
import { createLogger } from './log.ts';

const log = createLogger('main');

const app = new App();

process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);
process.on('uncaughtException', (e) => log.error('未捕获异常', e?.message ?? e));
process.on('unhandledRejection', (e: any) => log.error('未处理拒绝', e?.message ?? e));

let stopping = false;
async function shutdown(): Promise<void> {
  if (stopping) return;
  stopping = true;
  await app.stop();
  process.exit(0);
}

await app.start();
