import fs from 'node:fs';
import path from 'node:path';
import { DATA_DIR } from './config/paths.ts';
import type { Logger } from './types.ts';

type Level = 'debug' | 'info' | 'warn' | 'error';

export interface LogLine {
  time: string;
  level: Level;
  scope: string;
  text: string;
}

const weight: Record<Level, number> = { debug: 10, info: 20, warn: 30, error: 40 };
const history: LogLine[] = [];

let threshold = weight.info;

export function setLogLevel(level: Level): void {
  threshold = weight[level] ?? weight.info;
}

export function getLogs(): LogLine[] {
  return [...history];
}

export function totalErrors(): number {
  return history.filter((l) => l.level === 'error').length;
}

// 日志文件按北京时间分天，放 data/logs/YYYY-MM-DD.log
const LOGS_DIR = path.join(DATA_DIR, 'logs');
let stream: fs.WriteStream | null = null;
let streamDay = '';

function dayKey(): string {
  const d = new Date(Date.now() + 8 * 3600 * 1000);
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${d.getUTCFullYear()}-${pad(d.getUTCMonth() + 1)}-${pad(d.getUTCDate())}`;
}

function writeFile(text: string): void {
  try {
    const day = dayKey();
    if (!stream || streamDay !== day) {
      stream?.end();
      fs.mkdirSync(LOGS_DIR, { recursive: true });
      stream = fs.createWriteStream(path.join(LOGS_DIR, `${day}.log`), { flags: 'a' });
      stream.on('error', () => {
        stream = null;
      });
      streamDay = day;
    }
    stream.write(`${text}\n`);
  } catch {
    // 写盘失败不影响主流程
  }
}

function emit(level: Level, scope: string, args: unknown[]): void {
  if (weight[level] < threshold) return;
  const ts = new Date().toISOString().slice(11, 19);
  const line = args
    .map((a) => (typeof a === 'string' ? a : a instanceof Error ? a.message : JSON.stringify(a)))
    .join(' ');
  history.push({ time: ts, level, scope, text: line });
  if (history.length > 1000) history.shift();
  const text = `${dayKey()} ${ts} ${level.toUpperCase().padEnd(5)} [${scope}] ${line}`;
  writeFile(text);
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
