import crypto from 'node:crypto';
import zlib from 'node:zlib';
import type { MessageEvent, PluginContext } from '../../core/types.ts';

const NONCE = '0CoJUm6Qyw8W8jud';
const VI = '0102030405060708';
const PUBKEY = 65537n;
const MODULUS = BigInt(
  '15779475026713150221247681780034549812187278333338974742401153102536627753526253991370' +
    '18062907664791894775335978549896068031942539786603299419807860724328064278336854726187' +
    '92592200595694346872951301770580765135349259590167490536138082469680638514416594216629' +
    '258349130257685001248172188325316586707301643237607',
);

const BASE = 'https://music.163.com';
const CRMUSIC_API = 'https://ii.reverie.dpdns.org/crmusic/api.php';

interface Song {
  id: string;
  name: string;
  artists: string[];
  album: string;
  picUrl: string;
  duration: number;
}

const caches = new Map<string, Song[]>();

function aesEncrypt(data: string, key: string): string {
  const cipher = crypto.createCipheriv('aes-128-cbc', Buffer.from(key, 'utf8'), Buffer.from(VI, 'utf8'));
  return Buffer.concat([cipher.update(data, 'utf8'), cipher.final()]).toString('base64');
}

function weapiEncrypt(params: unknown): { params: string; encSecKey: string } {
  const skey = crypto.randomBytes(8).toString('hex');
  const encrypted = aesEncrypt(aesEncrypt(JSON.stringify(params), NONCE), skey);
  const reversed = Buffer.from([...skey].reverse().join(''), 'utf8').toString('hex');
  const encSecKey = (BigInt(`0x${reversed}`) ** PUBKEY % MODULUS).toString(16).padStart(256, '0');
  return { params: encrypted, encSecKey };
}

function long2ip(value: number): string {
  return [(value >>> 24) & 0xff, (value >>> 16) & 0xff, (value >>> 8) & 0xff, value & 0xff].join('.');
}

function decompress(buffer: Buffer, encoding: string | null): Promise<string> {
  const isGzip = buffer.length >= 2 && buffer[0] === 0x1f && buffer[1] === 0x8b;
  if (encoding === 'gzip' || isGzip) {
    return new Promise((resolve, reject) => {
      zlib.gunzip(buffer, (err, out) => (err ? reject(err) : resolve(out.toString('utf-8'))));
    });
  }
  if (encoding === 'deflate') {
    return new Promise((resolve, reject) => {
      zlib.inflate(buffer, (err, out) => (err ? reject(err) : resolve(out.toString('utf-8'))));
    });
  }
  if (encoding === 'br') {
    return new Promise((resolve, reject) => {
      zlib.brotliDecompress(buffer, (err, out) => (err ? reject(err) : resolve(out.toString('utf-8'))));
    });
  }
  return new Promise((resolve) => {
    zlib.inflateRaw(buffer, (err, out) => resolve(err ? buffer.toString('utf-8') : out.toString('utf-8')));
  });
}

function neteaseHeaders(): Record<string, string> {
  return {
    Referer: 'https://music.163.com/',
    'X-Real-IP': long2ip(Math.floor(1884815360 + Math.random() * (1884890111 - 1884815360))),
    Accept: '*/*',
    'Accept-Encoding': 'identity',
    'Accept-Language': 'zh-CN,zh;q=0.8,gl;q=0.6,zh-TW;q=0.4',
    'Content-Type': 'application/x-www-form-urlencoded',
    Cookie:
      'appver=8.2.30; os=iPhone OS; osver=15.0; EVNSM=1.0.0; buildver=2206; channel=distribution; machineid=iPhone13.3',
  };
}

async function weapi(url: string, params: unknown): Promise<any> {
  const payload = weapiEncrypt(params);
  const form = new URLSearchParams({ params: payload.params, encSecKey: payload.encSecKey });
  const res = await fetch(url, { method: 'POST', headers: neteaseHeaders(), body: form.toString() });
  const buffer = Buffer.from(await res.arrayBuffer());
  const data = JSON.parse(await decompress(buffer, res.headers.get('content-encoding')));
  if (data?.code && data.code !== 200) throw new Error(`网易云错误 code=${data.code}`);
  return data;
}

function normalize(raw: any): Song | null {
  if (!raw?.id) return null;
  const pic = String(raw.al?.picUrl ?? '');
  return {
    id: String(raw.id),
    name: String(raw.name ?? ''),
    artists: (raw.ar ?? []).map((a: any) => a.name).filter(Boolean),
    album: String(raw.al?.name ?? ''),
    picUrl: pic ? pic.replace(/^http:\/\//i, 'https://') : '',
    duration: Number(raw.dt ?? raw.duration ?? 0),
  };
}

async function search(keyword: string, limit: number): Promise<Song[]> {
  const data = await weapi(`${BASE}/weapi/cloudsearch/pc`, { s: keyword, type: 1, limit, total: 'true', offset: 0 });
  return (data?.result?.songs ?? []).map(normalize).filter((s: Song | null): s is Song => s !== null);
}

async function resolveUrl(id: string, br = 320): Promise<string> {
  const data = await weapi(`${BASE}/weapi/song/enhance/player/url`, { ids: [id], br: br * 1000 });
  const item = data?.data?.[0] ?? {};
  if (item.uf?.url) item.url = item.uf.url;
  const isVip = Number(item.fee || 0) === 1 && Number(item.payed || 0) === 0;
  if (!item.url || isVip || item.freeTrialInfo) {
    try {
      const res = await fetch(`https://music-api.gdstudio.xyz/api.php?types=url&source=netease&id=${id}&br=${br}`);
      const json: any = await res.json();
      if (json?.url) return String(json.url).replace(/^http:\/\//i, 'https://');
    } catch {}
  }
  return String(item.url ?? '').replace(/^http:\/\//i, 'https://');
}

function formatDuration(ms: number): string {
  if (!Number.isFinite(ms) || ms <= 0) return '';
  const total = Math.floor(ms / 1000);
  return `${String(Math.min(99, Math.floor(total / 60))).padStart(2, '0')}:${String(total % 60).padStart(2, '0')}`;
}

/** OldChat 音乐卡片文本，按客户端 MusicShareInfo 的标签行格式排版 */
function cardText(song: Song, withLyric: boolean): string {
  const lines = [`歌曲: ${song.name}`];
  if (song.artists.length) lines.push(`歌手: ${song.artists.join('/')}`);
  const duration = formatDuration(song.duration);
  if (duration) lines.push(`时长: ${duration}`);
  if (song.picUrl) lines.push(`封面: ${song.picUrl}`);
  lines.push(`歌曲ID: ${song.id}`);
  if (withLyric) lines.push(`歌词: ${CRMUSIC_API}?types=lyric&id=${song.id}&raw=1`);
  lines.push('点击播放');
  return lines.join('\n');
}

/** 歌词接口有内容才写进卡片，避免客户端打开空歌词 */
async function hasLyric(id: string): Promise<boolean> {
  try {
    const res = await fetch(`${CRMUSIC_API}?types=lyric&id=${id}&raw=1`);
    const text = (await res.text()).trim();
    return text.length > 0;
  } catch {
    return false;
  }
}

async function sendCard(ctx: PluginContext, evt: MessageEvent, audioUrl: string, thumb: string, text: string): Promise<void> {
  if (ctx.account.platform !== 'oldchat') return;
  if (audioUrl.length > 1024) {
    ctx.log.warn(`播放地址超过 1024 字符 跳过音乐卡片 ${audioUrl.length}`);
    return;
  }
  try {
    const native = ctx.native<{ gateway: (method: string, path: string, payload?: unknown) => Promise<unknown> }>();
    const body = JSON.stringify({ v: 2, text, media_kind: 'music', audio_url: audioUrl, url: audioUrl });
    const extra = { body, msg_type: 'resource', media_url: audioUrl, thumb_url: thumb };
    const payload = evt.scene === 'group'
      ? { group_id: evt.peerId, ...extra }
      : { ...(evt.peerId.startsWith('nc_') ? { to_ncuid: evt.peerId } : { to_uid: evt.peerId }), ...extra };
    await native.gateway('POST', evt.scene === 'group' ? '/v2/groups/message/send' : '/v2/direct/send', payload);
  } catch (e: any) {
    ctx.log.warn(`音乐卡片发送失败 ${e?.message ?? e}`);
  }
}

export function onLoad(ctx: PluginContext) {
  const pages = Math.min(50, Math.max(1, Number(ctx.config.pages) || 20));
  const maxList = Math.min(50, Math.max(1, Number(ctx.config.maxList) || 10));
  const errorText = String(ctx.config.errorText ?? '猫猫晕乎乎的，溜号了喵~');

  const keyOf = (evt: MessageEvent) => `${evt.accountId}:${evt.sender.id}`;

  const doSearch = async (evt: MessageEvent, keyword: string): Promise<void> => {
    if (!keyword) {
      await ctx.reply(evt, '想听什么喵~ 用法: 点歌 关键词');
      return;
    }
    try {
      const songs = await search(keyword, pages);
      if (!songs.length) {
        await ctx.reply(evt, `喵呜…没找到和【${keyword}】有关的歌`);
        return;
      }
      const list = songs.slice(0, maxList);
      caches.set(keyOf(evt), list);
      const lines = list.map((s, i) => `${i + 1}. ${s.name}${s.artists.length ? ` - ${s.artists.join('/')}` : ''}`);
      await ctx.reply(evt, `帮喵找到这些喵~【${keyword}】\n${lines.join('\n')}`);
    } catch (e: any) {
      ctx.log.error(`搜索失败 ${e?.message ?? e}`);
      await ctx.reply(evt, errorText);
    }
  };

  const doPlay = async (evt: MessageEvent, index: number): Promise<void> => {
    const list = caches.get(keyOf(evt));
    if (!list?.length) {
      await ctx.reply(evt, '要先「点歌 关键词」搜一下喵~');
      return;
    }
    if (!Number.isFinite(index) || index < 1 || index > list.length) {
      await ctx.reply(evt, `没有第 ${index} 首喵~ 只能选 1~${list.length}`);
      return;
    }
    const song = list[index - 1];
    try {
      const url = await resolveUrl(song.id);
      if (!url) {
        await ctx.reply(evt, '这首歌的播放地址拿不到喵…换一首试试？');
        return;
      }
      // 先语音再卡片，与原插件一致
      await ctx.send(evt, [{ type: 'voice', url, duration: 60000 }]);
      if (ctx.account.platform === 'oldchat') {
        const text = cardText(song, await hasLyric(song.id));
        await sendCard(ctx, evt, url, song.picUrl, text);
      }
    } catch (e: any) {
      ctx.log.error(`播放失败 ${e?.message ?? e}`);
      await ctx.reply(evt, errorText);
    }
  };

  ctx.onMessage((evt) => {
    if (evt.sender.id === evt.selfId) return;
    const raw = String(evt.text ?? '').trim();
    if (!raw) return;
    const hit = ctx.prefixes.find((p) => p && raw.startsWith(p));
    const body = (hit ? raw.slice(hit.length) : raw).trim();

    const searchMatch = body.match(/^点歌[\s：:]*(.*)$/);
    if (searchMatch) {
      void doSearch(evt, searchMatch[1].trim());
      return;
    }
    const playMatch = body.match(/^播放[\s：:]*(\d+)?$/);
    if (playMatch) {
      const index = playMatch[1];
      if (index === undefined) void ctx.reply(evt, '要说播放几号喵~ 例如: 播放 1');
      else void doPlay(evt, Number(index));
    }
  });

  ctx.log.info(`已就绪 前缀可选 ${ctx.prefixes.join(' ') || '未配置'}`);
}

export function onUnload() {
  caches.clear();
}
