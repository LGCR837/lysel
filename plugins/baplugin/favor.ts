// baplugin 好感计算：移植 sanae-code/favorability.ts + cal_favor.ts 图片渲染
import { createCanvas, loadImage } from '@napi-rs/canvas';
import { IMG_BASE, STU_ICON_BASE, ensureFont, loadRemote, getFavorData, getGiftList, getStudentMap } from './data.ts';

// ---------- 经验表（与 favorability.ts 一致） ----------
const expRequirement: { [key: number]: number } = {
  1: 15, 2: 30, 3: 30, 4: 35, 5: 35,
  6: 35, 7: 40, 8: 40, 9: 40, 10: 60,
  11: 90, 12: 105, 13: 120, 14: 140, 15: 160,
  16: 180, 17: 205, 18: 230, 19: 255, 20: 285,
  21: 315, 22: 345, 23: 375, 24: 410, 25: 445,
  26: 480, 27: 520, 28: 560, 29: 600, 30: 645,
  31: 690, 32: 735, 33: 780, 34: 830, 35: 880,
  36: 930, 37: 985, 38: 1040, 39: 1095, 40: 1155,
  41: 1215, 42: 1275, 43: 1335, 44: 1400, 45: 1465,
  46: 1530, 47: 1600, 48: 1670, 49: 1740, 50: 1815,
  51: 1890, 52: 1965, 53: 2040, 54: 2120, 55: 2200,
  56: 2280, 57: 2365, 58: 2450, 59: 2535, 60: 2625,
  61: 2715, 62: 2805, 63: 2895, 64: 2990, 65: 3085,
  66: 3180, 67: 3280, 68: 3380, 69: 3480, 70: 3585,
  71: 3690, 72: 3795, 73: 3900, 74: 4010, 75: 4120,
  76: 4230, 77: 4345, 78: 4460, 79: 4575, 80: 4695,
  81: 4815, 82: 4935, 83: 5055, 84: 5180, 85: 5305,
  86: 5430, 87: 5560, 88: 5690, 89: 5820, 90: 5955,
  91: 6090, 92: 6225, 93: 6360, 94: 6500, 95: 6640,
  96: 6780, 97: 6925, 98: 7070, 99: 7215, 100: 7365,
};

// 各途径提供经验
const expSupply: Array<{ key: string; value: number; unit: string }> = [
  { key: '摸头', value: 15, unit: '次' },
  { key: '课程表(满级期望)', value: 31.25, unit: '次' },
  { key: '金色礼物(普通)', value: 20, unit: '个' },
  { key: '金色礼物(笑脸)', value: 40, unit: '个' },
  { key: '金色礼物(大笑脸)', value: 60, unit: '个' },
  { key: '紫色礼物(笑脸)', value: 120, unit: '个' },
  { key: '紫色礼物(大笑脸)', value: 180, unit: '个' },
  { key: '紫色礼物(爱心脸)', value: 240, unit: '个' },
];

/** 解析好感输入："1-100" / "100" → [start, end] */
export function parseFavorLevels(input: string): { ok: true; start: number; end: number } | { ok: false; msg: string } {
  const m = input.match(/(\d+)\s*[-~至]\s*(\d+)/);
  if (m) {
    const start = parseInt(m[1], 10);
    const end = parseInt(m[2], 10);
    if (start < 1 || start > 100 || end < 1 || end > 100) return { ok: false, msg: '等级范围需在 1-100 之间喵' };
    if (start >= end) return { ok: false, msg: '起始等级需小于目标等级喵' };
    return { ok: true, start, end };
  }
  const single = input.match(/^\d+$/);
  if (single) {
    const end = parseInt(single[0], 10);
    if (end < 2 || end > 100) return { ok: false, msg: '目标等级需在 2-100 之间喵' };
    return { ok: true, start: 1, end };
  }
  return { ok: false, msg: '等级格式不对喵，示例：BA 好感 1-100' };
}

/** 计算总经验与各途径所需数量 */
export function calculateNumer(start: number, end: number): number[] {
  let sum = 0;
  for (const key in expRequirement) {
    const level = parseInt(key, 10);
    if (level >= start && level < end) sum += expRequirement[level];
  }
  const num: number[] = [sum, start, end];
  for (const s of expSupply) num.push(Math.ceil(sum / s.value));
  return num;
}

/** 根据角色名匹配学生（精确 MapName → 包含匹配） */
export async function matchStudent(name: string): Promise<{ Id_db: number; MapName: string } | null> {
  const map = await getStudentMap();
  const exact = map.find((s) => s.MapName === name);
  if (exact) return { Id_db: exact.Id_db, MapName: exact.MapName };
  const includes = map.filter((s) => s.MapName.includes(name));
  if (includes.length === 1) return { Id_db: includes[0].Id_db, MapName: includes[0].MapName };
  return null;
}

interface GiftRow {
  preId: number;
  matchCount: number;
  Rarity: string;
  Icon: string;
}

/** 渲染好感计算图：num = calculateNumer 返回值，stu 可选学生 */
export async function renderFavorImg(
  num: number[],
  stu?: { Id_db: number; MapName: string }
): Promise<Buffer> {
  const font = ensureFont();
  const [total, startLv, endLv] = num;

  // 取该学生的推荐礼物
  let giftRows: GiftRow[] = [];
  let giftNameMap = new Map<number, string>();
  if (stu) {
    try {
      const [favor, gifts] = await Promise.all([getFavorData(), getGiftList()]);
      const row = favor.find((i: any) => i.stuid === stu.Id_db);
      if (row) giftRows = row.favorGifts as GiftRow[];
      for (const g of gifts) giftNameMap.set(g.Id, g.Name);
    } catch {
      giftRows = [];
    }
  }

  const W = 1200;
  const H = stu ? 1000 + Math.ceil(giftRows.length / 4) * 180 : 860;
  const canvas = createCanvas(W, H);
  const c = canvas.getContext('2d');

  // 背景
  c.fillStyle = '#FFFFFF';
  c.fillRect(0, 0, W, H);

  // 顶部标题区
  c.fillStyle = '#F48FB1';
  c.fillRect(0, 0, W, 130);
  c.fillStyle = '#FFFFFF';
  c.font = `bold 58px ${font}`;
  c.textAlign = 'center';
  c.fillText(stu ? `${stu.MapName} 好感计算` : '好感计算', W / 2, 90);

  // 等级区间 + 总经验
  c.fillStyle = '#111111';
  c.textAlign = 'left';
  c.font = `bold 46px ${font}`;
  const lvText = `从 ${startLv} 级到 ${endLv} 级，总经验 ${total}`;
  c.fillText(lvText, 50, stu ? 200 : 200);

  // 各途径行
  const startY = stu ? 250 : 250;
  const rowH = 70;
  c.font = `bold 36px ${font}`;
  for (let i = 0; i < expSupply.length; i++) {
    const y = startY + i * rowH;
    const s = expSupply[i];
    const value = num[3 + i];
    c.fillStyle = '#333333';
    c.fillText(s.key, 60, y + 40);
    c.fillStyle = '#0080FF';
    c.textAlign = 'right';
    c.fillText(`${value} ${s.unit}`, W - 60, y + 40);
    c.textAlign = 'left';
  }

  // 学生推荐礼物区
  let y = startY + expSupply.length * rowH + 20;
  if (stu) {
    c.strokeStyle = '#CCCCCC';
    c.lineWidth = 2;
    c.beginPath();
    c.moveTo(30, y);
    c.lineTo(W - 30, y);
    c.stroke();
    y += 20;
    c.fillStyle = '#111111';
    c.font = `bold 38px ${font}`;
    c.fillText('推荐礼物：', 50, y + 30);

    if (giftRows.length === 0) {
      c.fillStyle = '#888888';
      c.font = `bold 32px ${font}`;
      c.fillText('暂无数据', 50, y + 80);
    } else {
      let x = 60;
      let ry = y + 40;
      let col = 0;
      for (const g of giftRows) {
        try {
          const icon = await loadRemote(`${IMG_BASE}/${g.Icon}.png`);
          c.drawImage(icon, x, ry, 100, 80);
          const gname = giftNameMap.get(g.preId) || '';
          c.fillStyle = '#333333';
          c.font = `bold 24px ${font}`;
          c.fillText(g.matchCount >= 2 ? '微笑' : '普通', x, ry + 100);
          c.fillText(gname, x, ry + 130);
        } catch {
          // 图标加载失败则跳过
        }
        x += 270;
        col++;
        if (col >= 4) {
          col = 0;
          x = 60;
          ry += 180;
        }
      }
    }
  }

  c.fillStyle = '#AAAAAA';
  c.font = `bold 22px ${font}`;
  c.fillText('数据来源：https://schaledb.com', 50, H - 20);

  return canvas.toBuffer('image/png');
}
