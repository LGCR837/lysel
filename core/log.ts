import type { Logger } from './types.ts';

type Level = 'debug' | 'info' | 'warn' | 'error';

const weight: Record<Level, number> = { debug: 10, info: 20, warn: 30, error: 40 };

let threshold = weight.info;

export function setLogLevel(level: Level): void {
  threshold = weight[level] ?? weight.info;
}

function emit(level: Level, scope: string, args: unknown[]): void {
  if (weight[level] < threshold) return;
  const ts = new Date().toISOString().slice(11, 19);
  const line = args
    .map((a) => (typeof a === 'string' ? a : a instanceof Error ? a.message : JSON.stringify(a)))
    .join(' ');
  const text = `${ts} ${level.toUpperCase().padEnd(5)} [${scope}] ${line}`;
  if (level === 'error') console.error(text);
  else if (level === 'warn') console.warn(text);
  else console.log(text);
}

export function createLogger(scope: string): Logger {
  return {
    debug: (...a) => emit('debug', scope, a),
    info: (...a) => emit('info', scope, a),
    warn: (...a) => emit('warn', scope, a),
    error: (...a) => emit('error', scope, a),
  };
}
