// baplugin 数据层：远程拉取 + 内存缓存
import { GlobalFonts, loadImage } from '@napi-rs/canvas';
import { fileURLToPath } from 'node:url';

const COS = 'https://1145141919810-1317895529.cos.ap-chengdu.myqcloud.com';
export const JSON_BASE = `${COS}/json`;
export const IMG_BASE = `${COS}/img_file`;
export const GACHA_IMG_BASE = `${COS}/gacha-img`;
export const STU_ICON_BASE = `${COS}/stu_icon_db_png`;

const SHARED_ASSETS = fileURLToPath(new URL('../_shared/assets/', import.meta.url));

const TTL = 60 * 60 * 1000;
const cache = new Map<string, { data: any; ts: number }>();

async function fetchJSON(name: string): Promise<any> {
  const key = `json:${name}`;
  const hit = cache.get(key);
  if (hit && Date.now() - hit.ts < TTL) return hit.data;
  const res = await fetch(`${JSON_BASE}/${name}`);
  if (!res.ok) throw new Error(`拉取 ${name} 失败 ${res.status}`);
  const data = await res.json();
  cache.set(key, { data, ts: Date.now() });
  return data;
}

export function getGachaData(): Promise<any> {
  return fetchJSON('gacha_data.json');
}

export function getMangaList(): Promise<any> {
  return fetchJSON('manga_main.json');
}

/** 学生 Id / Id_db / MapName 映射 */
export function getStudentMap(): Promise<Array<{ Id: string; Id_db: number; MapName: string }>> {
  return fetchJSON('sms_studata_toaro_stu.json');
}

/** 好感礼物数据：stuid(Id_db) → favorGifts */
export function getFavorData(): Promise<any> {
  return fetchJSON('favora_data.json');
}

/** 礼物列表 */
export function getGiftList(): Promise<any> {
  return fetchJSON('liwu_list_rep.json');
}

// ---------- 字体（共用 _shared/assets/zyyt.ttf） ----------
let fontFamily = '';
export function ensureFont(): string {
  if (fontFamily) return fontFamily;
  try {
    GlobalFonts.registerFromPath(`${SHARED_ASSETS}zyyt.ttf`, 'ZYYT');
    fontFamily = 'ZYYT, "Microsoft YaHei"';
  } catch {
    fontFamily = '"Microsoft YaHei"';
  }
  return fontFamily;
}

// ---------- 图片加载 ----------
/** COS 可直连 */
export function loadRemote(url: string) {
  return loadImage(url);
}

/** 带 UA/Referer 下载（gamekee CDN 需要） */
export async function downloadImageBuffer(url: string): Promise<Buffer> {
  const res = await fetch(url, {
    headers: {
      'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
      Referer: 'https://ba.gamekee.com/',
    },
  });
  if (!res.ok) throw new Error(`下载图片失败 ${res.status}`);
  return Buffer.from(await res.arrayBuffer());
}
