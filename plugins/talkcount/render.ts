// TalkCount 排行榜渲染：@napi-rs/canvas 横向条形图 → PNG Buffer
// 字体复用 wifepicker 的 zyyt.ttf（相对路径引用，不重复拷贝），缺失回退系统字体
import { createCanvas, GlobalFonts } from '@napi-rs/canvas';
import * as fs from 'node:fs';
import { fileURLToPath } from 'node:url';
import type { RankItem } from './store.ts';

let FONT_FAMILY = 'Microsoft YaHei';
try {
  const FONT_FILE = fileURLToPath(new URL('../_shared/assets/zyyt.ttf', import.meta.url));
  if (fs.existsSync(FONT_FILE)) {
    GlobalFonts.registerFromPath(FONT_FILE, 'ZYYT');
    FONT_FAMILY = 'ZYYT, "Microsoft YaHei"';
  }
} catch {
  // 忽略，用默认字体
}

function roundRect(ctx: any, x: number, y: number, w: number, h: number, r: number): void {
  ctx.beginPath();
  ctx.moveTo(x + r, y);
  ctx.arcTo(x + w, y, x + w, y + h, r);
  ctx.arcTo(x + w, y + h, x, y + h, r);
  ctx.arcTo(x, y + h, x, y, r);
  ctx.arcTo(x, y, x + w, y, r);
  ctx.closePath();
}

function truncate(ctx: any, text: string, maxWidth: number): string {
  if (ctx.measureText(text).width <= maxWidth) return text;
  let t = text;
  while (t.length > 1 && ctx.measureText(t + '…').width > maxWidth) t = t.slice(0, -1);
  return t + '…';
}

export interface LeaderboardOpts {
  title: string;
  dateText: string;
  total: number;
  items: RankItem[];
  topN: number;
}

export function renderLeaderboard(opts: LeaderboardOpts): Buffer {
  const { title, dateText, total, items, topN } = opts;
  const ROW_H = 44;
  const HEADER_H = 86;
  const PAD_X = 34;
  const PAD_TOP = 16;
  const rows = Math.min(items.length, topN);
  const H = HEADER_H + PAD_TOP + rows * ROW_H + 26;
  const W = 900;

  const canvas = createCanvas(W, H);
  const ctx = canvas.getContext('2d');

  // 背景卡片
  ctx.fillStyle = '#fff5f7';
  roundRect(ctx, 0, 0, W, H, 18);
  ctx.fill();

  // 标题
  ctx.fillStyle = '#8a5a5a';
  ctx.font = `bold 34px ${FONT_FAMILY}`;
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  ctx.fillText(title, W / 2, 38);

  ctx.font = `22px ${FONT_FAMILY}`;
  ctx.fillStyle = '#b08888';
  ctx.fillText(`${dateText} · 总发言 ${total} 次`, W / 2, 68);

  const maxCount = rows > 0 ? items[0].count : 0;
  const labelW = 160;
  const barX0 = PAD_X + labelW;
  const barX1 = W - PAD_X - 76;
  const barMaxW = barX1 - barX0;

  const rankColors = ['#f5b942', '#c0c4cc', '#d99a6c', '#f5c8d0', '#f5c8d0'];
  const barColors = ['#ff9aa2', '#ffb3c6', '#ffc9d6', '#ffd9e2', '#ffe3ec'];

  for (let i = 0; i < rows; i++) {
    const it = items[i];
    const y = HEADER_H + PAD_TOP + i * ROW_H + ROW_H / 2;
    const bw = maxCount > 0 ? Math.max(6, (it.count / maxCount) * barMaxW) : 0;

    // 名次徽章
    const rx = PAD_X + 16;
    ctx.beginPath();
    ctx.arc(rx, y, 13, 0, Math.PI * 2);
    ctx.fillStyle = rankColors[i] || '#f5c8d0';
    ctx.fill();
    ctx.fillStyle = '#ffffff';
    ctx.font = `bold 15px ${FONT_FAMILY}`;
    ctx.textAlign = 'center';
    ctx.fillText(String(i + 1), rx, y + 1);

    // 昵称
    ctx.fillStyle = '#6b4b4b';
    ctx.font = `20px ${FONT_FAMILY}`;
    ctx.textAlign = 'left';
    ctx.fillText(truncate(ctx, it.name, barX0 - PAD_X - 44), PAD_X + 34, y);

    // 横向条
    roundRect(ctx, barX0, y - 12, bw, 24, 12);
    ctx.fillStyle = barColors[i % barColors.length];
    ctx.fill();

    // 条尾次数
    ctx.fillStyle = '#a07070';
    ctx.font = `bold 19px ${FONT_FAMILY}`;
    ctx.textAlign = 'left';
    ctx.fillText(`${it.count}`, barX0 + bw + 10, y);
  }

  return canvas.toBuffer('image/png');
}
