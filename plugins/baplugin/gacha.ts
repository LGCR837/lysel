// baplugin 抽卡模拟：移植 gacha_main.ts 的 gacha_10 / gacha_200 算法 + 图片渲染
import { createCanvas, loadImage } from '@napi-rs/canvas';
import { IMG_BASE, GACHA_IMG_BASE, ensureFont, loadRemote, getGachaData, getStudentMap } from './data.ts';

/** 服务器：0=日服 1=国际服 2=国服 */
export type ServerId = 0 | 1 | 2;

export const SERVER_NAMES: Record<ServerId, string> = {
  0: '日服',
  1: '国际服',
  2: '国服',
};

interface GachaStudent {
  id: number;
  IsReleased: boolean[];
  StarGrade: number;
  IsLimited: number;
}

let _gacha: any = null;
let _pick: any = null;
let _studentMap: any[] = [];

/** 拉取并缓存抽卡数据 */
export async function ensureGachaData(): Promise<void> {
  const [gacha, students] = await Promise.all([getGachaData(), getStudentMap()]);
  _gacha = gacha;
  _pick = gacha[0];
  _studentMap = students;
}

function released(serid: ServerId, star: number): number[] {
  const list = _gacha[1] as GachaStudent[];
  return list
    .filter((i) => i.StarGrade === star && i.IsLimited === 0 && i.IsReleased[serid])
    .map((i) => i.id);
}

function idToName(id: number): string {
  const row = _studentMap.find((i) => i.Id_db === id);
  return row ? row.MapName : `#${id}`;
}

function idToDbid(stuId: string): number | undefined {
  const row = _studentMap.find((i) => i.Id === String(stuId));
  return row ? row.Id_db : undefined;
}

function isStar3(id: number): boolean {
  const row = (_gacha[1] as GachaStudent[]).find((i) => i.id === id);
  return !!row && row.StarGrade === 3;
}

function isReleasedOn(id: number, serid: ServerId): boolean {
  const row = (_gacha[1] as GachaStudent[]).find((i) => i.id === id);
  return !!row && row.IsReleased[serid];
}

function calMuzhu(gacha: [number[], any[]]): number {
  let muzhu = 0;
  for (const star of gacha[1]) {
    if (star === 1) muzhu += 1;
    else if (star === 2) muzhu += 10;
    else if (star === 3 || star === 'pick' || star === 4) muzhu += 50;
  }
  return muzhu;
}

const rand = (n: number) => Math.floor(Math.random() * n);
const pick = <T,>(arr: T[]): T => arr[rand(arr.length)];

/** 十连（0=日 1=国际 2=国），stuId 为可选 up 学生 Id_db */
export function gacha10(serid: ServerId, stuId?: number): [number[], (number | string)[]] {
  const released_1 = released(serid, 1);
  const released_2 = released(serid, 2);
  const released_3 = released(serid, 3);

  const sername = serid === 0 ? 'jp' : serid === 1 ? 'in' : 'cn';
  const isFes = !!_pick[`fes_${sername}`];
  const pickp = stuId ? 0.007 : 0;

  let arry: number[];
  if (isFes) arry = [0.755, 0.185, 0.06];
  else arry = [0.785, 0.185, 0.03];

  const stu_10: number[] = [];
  const stu_sta: (number | string)[] = [];
  let safeguards = 0;

  for (let i = 0; i < 10; i++) {
    if (i === 9 && safeguards === 0) {
      stu_10.push(pick(released_2));
      stu_sta.push(2);
      break;
    }
    const roll = Math.random();
    let star: string;
    if (roll < arry[0]) star = '1';
    else if (roll < arry[0] + arry[1]) star = '2';
    else if (roll < arry[0] + arry[1] + (arry[2] - pickp)) star = '3';
    else star = 'pick';

    switch (star) {
      case '1':
        stu_10.push(pick(released_1));
        stu_sta.push(1);
        break;
      case '2':
        stu_10.push(pick(released_2));
        stu_sta.push(2);
        safeguards++;
        break;
      case '3':
        stu_10.push(pick(released_3));
        stu_sta.push(3);
        safeguards++;
        break;
      case 'pick':
        stu_10.push(stuId!);
        stu_sta.push('pick');
        safeguards++;
        break;
    }
  }
  return [stu_10, stu_sta];
}

/** 一井（20 次十连 = 200 抽） */
export function gacha200(serid: ServerId, stuId?: number): [number[], (number | string)[]] {
  const ids: number[] = [];
  const stars: (number | string)[] = [];
  for (let i = 0; i < 20; i++) {
    const g = gacha10(serid, stuId);
    ids.push(...g[0]);
    stars.push(...g[1].map((x) => (x === 'pick' ? 4 : x)));
  }
  return [ids, stars];
}

/** 校验 up 学生：返回错误提示或学生名 */
export async function validateUpStudent(name: string, serid: ServerId): Promise<{ ok: true; id: number; name: string } | { ok: false; msg: string }> {
  const map = await getStudentMap();
  const exact = map.find((s) => s.MapName === name);
  if (!exact) return { ok: false, msg: '呜呜呜，未匹配到学生' };
  const id = idToDbid(exact.Id);
  if (id === undefined) return { ok: false, msg: '呜呜呜，未匹配到学生' };
  if (!isStar3(id)) return { ok: false, msg: '暂不支持 up 非三星角色' };
  if (!isReleasedOn(id, serid)) return { ok: false, msg: '呜呜，该学生未在该服实装' };
  return { ok: true, id, name: exact.MapName };
}

/** 当前卡池 up 学生文本 */
export function currentPicks(): string {
  const now = new Date();
  const lines: string[] = [];
  const servers: Array<{ serid: ServerId; nowPick: string; time: string; fes: string }> = [
    { serid: 2, nowPick: 'now_pick_cn', time: 'pick_cn_time', fes: 'fes_cn' },
    { serid: 1, nowPick: 'now_pick_in', time: 'pick_in_time', fes: 'fes_in' },
    { serid: 0, nowPick: 'now_pick_jp', time: 'pick_jp_time', fes: 'fes_jp' },
  ];
  for (const s of servers) {
    const t = _pick?.[s.time];
    const inTime = Array.isArray(t) && t.length >= 2 && now >= new Date(t[0]) && now <= new Date(t[1]);
    const names: string[] = inTime ? (_pick[s.nowPick] || []).map((n: number) => idToName(n)) : [];
    const fes = _pick?.[s.fes] ? '(FES)' : '';
    lines.push(`${SERVER_NAMES[s.serid]}：${names.length ? names.map((n) => n + fes).join(' / ') : '常驻'}`);
  }
  return lines.join('\n');
}

// ---------- 图片渲染 ----------

/** 渲染十连结果图（移植 creat_img） */
export async function renderGacha10Img(
  stu_gacha: [number[], (number | string)[]],
  serid: ServerId,
  muzhu: number
): Promise<Buffer> {
  const font = ensureFont();
  const W = 2048;
  const H = 1200;
  const canvas = createCanvas(W, H);
  const c = canvas.getContext('2d');

  const [ids, stars] = stu_gacha;

  const [bg, pickImg, printImg, backImgs] = await Promise.all([
    loadRemote(`${IMG_BASE}/background.png`),
    loadRemote(`${IMG_BASE}/pickup.png`),
    loadRemote(`${IMG_BASE}/print_${serid}.png`),
    Promise.all([
      loadRemote(`${IMG_BASE}/1sta.png`),
      loadRemote(`${IMG_BASE}/1sta.png`),
      loadRemote(`${IMG_BASE}/2sta.png`),
      loadRemote(`${IMG_BASE}/3sta.png`),
    ]),
  ]);

  c.drawImage(bg, 0, 0);

  let x = 100;
  let y = 100;
  const move = 106;
  const z = 42;

  for (let i = 0; i < 10; i++) {
    const star = stars[i];
    const isPick = star === 'pick';
    const backIdx = isPick ? 3 : Number(star);
    c.save();
    c.drawImage(backImgs[backIdx], x, y + 5, 400, 520);

    // 多边形裁剪显示头像
    c.beginPath();
    c.moveTo(x + move, y + move + 8);
    c.lineTo(x + move + 243, y + move + 8);
    c.lineTo(x + move + 243 - z, y + move + 240);
    c.lineTo(x + move - z, y + move + 242);
    c.lineTo(x + move, y + move + 10);
    c.closePath();
    c.clip();
    const stuImg = await loadRemote(`${GACHA_IMG_BASE}/${ids[i]}.png`);
    c.drawImage(stuImg, x + move - 40, y + move, 280, 260);
    c.restore();

    if (isPick) {
      c.drawImage(pickImg, x + 50, y + 90);
    }
    x += 340;
    if (i === 4) {
      y += 400;
      x = 100;
    }
  }

  c.font = `bold 50px ${font}`;
  c.fillStyle = '#FFFFFF';
  c.drawImage(printImg, 1450, 980);
  c.fillText(`${muzhu}`, 1650, 1090);

  return canvas.toBuffer('image/png');
}

interface StudentAcc {
  stuid: number;
  rep: number;
  star: number;
}

/** 渲染一井结果图（移植 draw_200_img） */
export async function renderGacha200Img(
  stu_gacha: [number[], (number | string)[]],
  serid: ServerId
): Promise<Buffer> {
  const font = ensureFont();
  const [ids, levels] = stu_gacha;

  // 汇总重复学生
  const acc: Record<number, StudentAcc> = {};
  for (let i = 0; i < ids.length; i++) {
    const id = ids[i];
    if (!acc[id]) acc[id] = { stuid: id, rep: 0, star: 0 };
    acc[id].rep += 1;
    acc[id].star = levels[i] as number;
  }
  const final_stu_json = Object.values(acc);

  // 计算三星数量决定画布行数
  let l3 = 0;
  for (const s of final_stu_json) if (s.star === 3 || s.star === 4) l3++;
  const l1 = final_stu_json.filter((s) => s.star === 1).length;
  const l2 = final_stu_json.filter((s) => s.star === 2).length;
  const needRows = l1 <= 11 ? 1 : 2;

  const m = 0.45;
  const W = 2048;
  const H = 1200;
  const canvas = createCanvas(W, H);
  const c = canvas.getContext('2d');

  const [bg, pickImg, backImgs] = await Promise.all([
    loadRemote(`${IMG_BASE}/background.png`),
    loadRemote(`${IMG_BASE}/pickup.png`),
    Promise.all([
      loadRemote(`${IMG_BASE}/1sta.png`),
      loadRemote(`${IMG_BASE}/1sta.png`),
      loadRemote(`${IMG_BASE}/2sta_1.png`),
      loadRemote(`${IMG_BASE}/3sta_1.png`),
    ]),
  ]);

  c.drawImage(bg, 0, 0);

  const drawChar = async (id: number, star: number, x: number, y: number) => {
    const move = 109;
    const z = 42;
    const stuImg = await loadRemote(`${GACHA_IMG_BASE}/${id}.png`);
    c.save();
    c.drawImage(backImgs[star], x * m, y * m + 5, 400 * m, 520 * m);
    c.beginPath();
    c.moveTo((x + move) * m, (y + move + 15) * m);
    c.lineTo((x + move + 236) * m, (y + move + 15) * m);
    c.lineTo((x + move + 236 - z) * m, (y + move + 250) * m);
    c.lineTo((x + move - z) * m, (y + move + 250) * m);
    c.lineTo((x + move) * m, (y + move + 15) * m);
    c.closePath();
    c.clip();
    c.drawImage(stuImg, (x + move - 40) * m, (y + move) * m, 280 * m, 260 * m);
    c.restore();
  };

  c.font = `bold 40px ${font}`;
  c.fillStyle = '#000000';
  let x_move = 130, y_move = 183;
  let y3 = 0, y2 = 670, y1 = 1240;
  let x3p = 50, x2p = 50, x1p = 50;

  if (l3 > 11) {
    y2 = 800;
    y1 = 1620;
  }
  if (l2 > 11) {
    y1 = 1620;
  }

  for (const s of final_stu_json) {
    switch (s.star) {
      case 4: {
        await drawChar(s.stuid, s.star, x3p, y3);
        c.drawImage(pickImg, x3p * m + 20, y3 * m + 41, 80, 28);
        c.fillText(`x${s.rep}`, x3p * m + x_move, y3 * m + y_move);
        x3p += 400;
        if (x3p > 4200) {
          y3 += 400;
          x3p = 50;
        }
        break;
      }
      case 3: {
        await drawChar(s.stuid, s.star, x3p, y3);
        c.fillText(`x${s.rep}`, x3p * m + x_move, y3 * m + y_move);
        x3p += 400;
        if (x3p > 4200) {
          y3 += 400;
          x3p = 50;
        }
        break;
      }
      case 2: {
        await drawChar(s.stuid, s.star, x2p, y2);
        c.fillText(`x${s.rep}`, x2p * m + x_move, y2 * m + y_move);
        x2p += 400;
        if (x2p > 4200) {
          y2 += 400;
          x2p = 50;
        }
        break;
      }
      case 1: {
        await drawChar(s.stuid, s.star, x1p, y1);
        c.fillText(`x${s.rep}`, x1p * m + x_move, y1 * m + y_move);
        x1p += 400;
        if (x1p > 4200) {
          y1 += 400;
          x1p = 50;
        }
        break;
      }
    }
  }

  return canvas.toBuffer('image/png');
}

/** 渲染当前卡池帮助图 */
export async function renderPicksImg(): Promise<Buffer> {
  const font = ensureFont();
  const text = `当前卡池：\n${currentPicks()}`;
  const W = 900;
  const H = 360;
  const canvas = createCanvas(W, H);
  const c = canvas.getContext('2d');
  c.fillStyle = '#FFFFFF';
  c.fillRect(0, 0, W, H);
  c.fillStyle = '#111111';
  c.font = `bold 44px ${font}`;
  const lines = text.split('\n');
  lines.forEach((ln, i) => c.fillText(ln, 50, 90 + i * 60));
  return canvas.toBuffer('image/png');
}
