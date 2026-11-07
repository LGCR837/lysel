import { createCanvas, GlobalFonts, loadImage } from '@napi-rs/canvas';
import { forceSimulation, forceLink, forceManyBody, forceCenter, forceCollide } from 'd3-force';
import * as fs from 'node:fs';
import { fileURLToPath } from 'node:url';

/** 关系记录（抽取/强娶/求婚） */
export interface GraphRecord {
  user_id: string;
  wife_id: string;
  forced: boolean;
  /** 'draw'=抽取, 'force'=强娶, 'married'=结婚, 'propose'=求婚失败 */
  edgeType?: 'draw' | 'force' | 'married' | 'propose';
}

/** 节点成员信息 */
export interface GraphMember {
  name: string;
  avatar?: string;
}

const NODE_R = 55;
const SHARED_ASSETS = fileURLToPath(new URL('../_shared/assets/', import.meta.url));

let FONT_FAMILY = 'Microsoft YaHei';
try {
  const FONT_FILE = `${SHARED_ASSETS}zyyt.ttf`;
  if (fs.existsSync(FONT_FILE)) {
    GlobalFonts.registerFromPath(FONT_FILE, 'ZYYT');
    FONT_FAMILY = 'ZYYT, "Microsoft YaHei"';
  }
} catch {
  // 忽略，用默认字体
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

const AVATAR_SIZE = NODE_R * 2;
const AVATAR_CONCURRENCY = 4;
let avatarTimeoutMs = 8000;
let mediaOrigin = 'https://oc.mcl0.dpdns.org';

export function setAvatarTimeout(ms: number): void {
  avatarTimeoutMs = Math.max(1000, ms || 8000);
}

/** 相对头像路径拼主站，绝对地址原样使用 */
export function setMediaOrigin(origin: string): void {
  const v = String(origin || '').replace(/\/+$/, '');
  if (v) mediaOrigin = v;
}

const OSS_BASE = 'https://ocf.oss-cn-shanghai.aliyuncs.com';

function avatarCandidates(url: string): string[] {
  if (!url) return [];
  if (/^https?:\/\//i.test(url)) return [url];
  const p = url.startsWith('/') ? url : `/${url}`;
  return [`${OSS_BASE}${p.replace(/^\/v1\/uploads/, '')}`, `${mediaOrigin}${p}`];
}

/** 头像缓存只在内存里，进程重启自然重建 */
const avatarCache = new Map<string, any>();
const avatarInFlight = new Map<string, Promise<any>>();

function ensureAvatar(url: string): Promise<any> {
  if (!url) return Promise.resolve(null);
  const cached = avatarCache.get(url);
  if (cached !== undefined) return Promise.resolve(cached);
  const running = avatarInFlight.get(url);
  if (running) return running;
  const task = downloadAndCache(url);
  avatarInFlight.set(url, task);
  task.finally(() => avatarInFlight.delete(url));
  return task;
}

async function downloadAndCache(url: string): Promise<any | null> {
  for (const candidate of avatarCandidates(url)) {
    try {
      const res = await fetch(candidate, { signal: AbortSignal.timeout(avatarTimeoutMs) });
      if (!res.ok) continue;
      const buf = Buffer.from(await res.arrayBuffer());
      if (buf.length < 100) continue;
      const img = await loadImage(buf);
      const avatar = finalizeAvatar(img);
      avatarCache.set(url, avatar);
      return avatar;
    } catch {
      // 换下一个候选
    }
  }
  avatarCache.set(url, null);
  return null;
}

/** 后台预热头像缓存（调用方控制节奏）；已缓存则直接返回 */
export function prewarmAvatar(url: string): Promise<void> {
  return ensureAvatar(url).then(() => undefined);
}

/** 按最大不透明连通块 cover 放大铺满正方形（保留宽高比，裁掉透明边缘） */
function trimAvatar(img: any): any {
  const w = img.width, h = img.height;
  const c = createCanvas(w, h);
  const cctx = c.getContext('2d');
  cctx.drawImage(img, 0, 0);
  const d = cctx.getImageData(0, 0, w, h).data;
  const mask = new Uint8Array(w * h);
  for (let i = 3; i < d.length; i += 4) if (d[i] > 100) mask[(i - 3) / 4] = 1;
  // 洪泛找最大连通块
  const visited = new Uint8Array(w * h);
  let best: any = null;
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const idx = y * w + x;
      if (!mask[idx] || visited[idx]) continue;
      const stack = [idx];
      visited[idx] = 1;
      let minX = w, minY = h, maxX = -1, maxY = -1, size = 0;
      while (stack.length) {
        const p = stack.pop()!;
        const px = p % w, py = (p / w) | 0;
        if (px < minX) minX = px;
        if (px > maxX) maxX = px;
        if (py < minY) minY = py;
        if (py > maxY) maxY = py;
        size++;
        for (const [dx, dy] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) {
          const nx = px + dx, ny = py + dy;
          if (nx < 0 || ny < 0 || nx >= w || ny >= h) continue;
          const ni = ny * w + nx;
          if (mask[ni] && !visited[ni]) {
            visited[ni] = 1;
            stack.push(ni);
          }
        }
      }
      if (!best || size > best.size) best = { minX, minY, maxX, maxY, size };
    }
  }
  if (!best) return img;
  const pad = 2;
  const minX0 = Math.max(0, best.minX - pad), maxX0 = Math.min(w - 1, best.maxX + pad);
  const minY0 = Math.max(0, best.minY - pad), maxY0 = Math.min(h - 1, best.maxY + pad);
  const bw = maxX0 - minX0 + 1, bh = maxY0 - minY0 + 1;
  const side = Math.max(bw, bh);
  const scale = Math.max(side / bw, side / bh);
  const dw = Math.round(bw * scale), dh = Math.round(bh * scale);
  const out = createCanvas(side, side);
  const octx = out.getContext('2d');
  octx.drawImage(c, minX0, minY0, bw, bh, (side - dw) / 2, (side - dh) / 2, dw, dh);
  return out;
}

/** 头像最终版：裁切透明边缘后缩放为节点需要的最小尺寸 */
function finalizeAvatar(img: any): any {
  const trimmed = trimAvatar(img);
  const out = createCanvas(AVATAR_SIZE, AVATAR_SIZE);
  out.getContext('2d').drawImage(trimmed, 0, 0, AVATAR_SIZE, AVATAR_SIZE);
  return out;
}

/** 大圆环初始布局（d3-force 默认把节点放在半径 10px 的圆上，容易缠绕成乱麻） */
function initPositions(nodes: any[]): void {
  const R = Math.sqrt(nodes.length) * 90;
  const TAU = Math.PI * 2;
  nodes.forEach((n, i) => {
    const a = (i / nodes.length) * TAU;
    n.x = Math.cos(a) * R;
    n.y = Math.sin(a) * R;
  });
}

/** 像素级分离：保证任意两节点中心距 >= minDist（有上限迭代） */
function enforceMinCenter(nodes: any[], minDist: number, maxIter = 300): void {
  const pos = nodes.map((n) => ({ x: n.x, y: n.y }));
  for (let iter = 0; iter < maxIter; iter++) {
    let moved = false;
    for (let i = 0; i < pos.length; i++) {
      for (let j = i + 1; j < pos.length; j++) {
        const dx = pos[j].x - pos[i].x;
        const dy = pos[j].y - pos[i].y;
        const dist = Math.hypot(dx, dy) || 1e-6;
        if (dist < minDist) {
          const push = (minDist - dist) / 2;
          const ux = dx / dist, uy = dy / dist;
          pos[i].x -= ux * push;
          pos[i].y -= uy * push;
          pos[j].x += ux * push;
          pos[j].y += uy * push;
          moved = true;
        }
      }
    }
    if (!moved) break;
  }
  nodes.forEach((n, i) => {
    n.x = pos[i].x;
    n.y = pos[i].y;
  });
}

/** 整体居中到画布中心 */
function recenter(nodes: any[], cx: number, cy: number): void {
  let minX = Infinity, maxX = -Infinity, minY = Infinity, maxY = -Infinity;
  for (const n of nodes) {
    if (n.x < minX) minX = n.x;
    if (n.x > maxX) maxX = n.x;
    if (n.y < minY) minY = n.y;
    if (n.y > maxY) maxY = n.y;
  }
  const dx = cx - (minX + maxX) / 2;
  const dy = cy - (minY + maxY) / 2;
  nodes.forEach((n) => {
    n.x += dx;
    n.y += dy;
  });
}

/** 绕 center 旋转一点角度 */
function rotateAround(node: any, center: any, dAng: number): void {
  const dx = node.x - center.x, dy = node.y - center.y;
  const r = Math.hypot(dx, dy) || 1;
  const na = Math.atan2(dy, dx) + dAng;
  node.x = center.x + Math.cos(na) * r;
  node.y = center.y + Math.sin(na) * r;
}

/**
 * 簇内展开（spoke 展开）：把同一节点上夹角过小的连线沿圆周推开，
 * 避免多条线在节点附近几乎重合、交错。
 * @param minGapDeg  连线在共享节点处的最小夹角（度）
 */
function spreadSpokes(nodes: any[], edges: any[], minGapDeg = 26, maxIter = 12): void {
  const minGap = (minGapDeg * Math.PI) / 180;
  for (let it = 0; it < maxIter; it++) {
    let moved = 0;
    for (const n of nodes) {
      const items: Array<{ o: any; ang: number }> = [];
      for (const e of edges) {
        if (e.source === n) items.push({ o: e.target, ang: Math.atan2(e.target.y - n.y, e.target.x - n.x) });
        else if (e.target === n) items.push({ o: e.source, ang: Math.atan2(e.source.y - n.y, e.source.x - n.x) });
      }
      if (items.length < 2) continue;
      items.sort((a, b) => a.ang - b.ang);
      for (let i = 0; i < items.length; i++) {
        const a = items[i], b = items[(i + 1) % items.length];
        if (a.o === b.o) continue; // 双向/多重边：另一端是同一节点，交给弧线处理
        let gap = b.ang - a.ang;
        if (i === items.length - 1) gap += Math.PI * 2;
        if (gap < minGap) {
          const half = Math.min((minGap - gap) / 2, 0.09); // 每轮单侧最多转 ~5°
          rotateAround(b.o, n, half);
          rotateAround(a.o, n, -half);
          moved++;
        }
      }
    }
    if (!moved) break;
    enforceMinCenter(nodes, 260, 3);
  }
}

/**
 * 每条边的弯曲方向：
 * - 同一无向节点对间有多条边（双向/重复）→ 用异号弧线错开；
 * - 其余边 → 朝远离图质心的方向弯曲（形成向外展开的花瓣，
 *   在共享节点附近各边弯曲方向保持一致，避免交错重叠）。
 */
function edgeBendSigns(edges: any[], nodes: any[]): number[] {
  const groups = new Map<string, number[]>();
  edges.forEach((e, i) => {
    const key = [String(e.source.id || e.source), String(e.target.id || e.target)].sort().join('\u0000');
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key)!.push(i);
  });
  let cx = 0, cy = 0;
  for (const n of nodes) { cx += n.x; cy += n.y; }
  cx /= nodes.length;
  cy /= nodes.length;
  const signs: number[] = edges.map(() => 0);
  for (const [, idxs] of groups) {
    if (idxs.length >= 2) {
      idxs.forEach((i, k) => (signs[i] = k % 2 === 0 ? 1 : -1));
    } else {
      const i = idxs[0];
      const s = edges[i].source, t = edges[i].target;
      const mx = (s.x + t.x) / 2, my = (s.y + t.y) / 2;
      const dx = t.x - s.x, dy = t.y - s.y;
      signs[i] = -dy * (mx - cx) + dx * (my - cy) >= 0 ? 1 : -1;
    }
  }
  return signs;
}

/**
 * 渲染关系图 → PNG Buffer
 * @param records  今日关系记录（无群隔离）
 * @param members  uid → { name, avatar }（用于节点显示）
 * @returns PNG Buffer
 */
export async function renderGraph(
  records: GraphRecord[],
  members: Map<string, GraphMember>
): Promise<Buffer> {
  // 1. 构建节点/边
  const userSet = new Set<string>();
  const edges: any[] = [];
  for (const r of records) {
    userSet.add(String(r.user_id));
    userSet.add(String(r.wife_id));
    const et = r.edgeType || (r.forced ? 'force' : 'draw');
    const labelMap: Record<string, string> = { draw: '抽中', force: '强娶', married: '结婚', propose: '求婚' };
    edges.push({
      source: String(r.user_id),
      target: String(r.wife_id),
      forced: !!r.forced,
      label: labelMap[et] || '抽中',
      edgeType: et,
    });
  }

  const PALETTE = ['#f9a8d4', '#a7f3d0', '#bfdbfe', '#fde68a', '#c4b5fd', '#fca5a5', '#a5f3fc', '#d9f99d', '#fda4af', '#e9d5ff', '#bae6fd', '#fcd34d'];
  const nodes: any[] = [...userSet].map((id) => {
    let h = 0;
    for (const ch of id) h = (h * 31 + ch.charCodeAt(0)) >>> 0;
    return {
      id,
      name: members.get(id)?.name || 'User' + id.slice(-4),
      r: NODE_R,
      color: PALETTE[h % PALETTE.length],
      avatar: null as any,
    };
  });

  // 2. 加载头像（缓存优先，读不到再拉取；并发下载）
  const avatarQueue = [...nodes];
  const avatarWorker = async (): Promise<void> => {
    while (avatarQueue.length) {
      const n = avatarQueue.shift()!;
      const m = members.get(n.id);
      if (m && m.avatar) {
        const avatar = await ensureAvatar(m.avatar);
        if (avatar) n.avatar = avatar;
        else await sleep(150); // 轻微限速，避免并发风暴
      }
    }
  };
  const workers = Math.min(AVATAR_CONCURRENCY, avatarQueue.length || 1);
  await Promise.all(Array.from({ length: workers }, () => avatarWorker()));

  // 3. 力导向布局
  initPositions(nodes); // 先大圆环铺开，避免默认 10px 圆环导致的缠绕
  const sim = forceSimulation(nodes)
    .force('link', forceLink(edges).id((d: any) => d.id).distance(500).strength(0.4))
    .force('charge', forceManyBody().strength(-1500))
    .force('center', forceCenter(0, 0))
    .force('collide', forceCollide(NODE_R * 1.6))
    .stop();
  for (let i = 0; i < 500; i++) sim.tick();

  // 4. 画布尺寸与坐标映射
  const HEADER_H = 90;
  const PAD = 140;

  // 先以正方形临时画布做像素映射（X/Y 独立缩放铺满正方形），
  // 后续分离/展开在像素空间进行，最终结果会接近正方形、无大片空白。
  const PROV_SIDE = 1920;
  let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
  for (const n of nodes) {
    minX = Math.min(minX, n.x);
    maxX = Math.max(maxX, n.x);
    minY = Math.min(minY, n.y);
    maxY = Math.max(maxY, n.y);
  }
  const bw = Math.max(1, maxX - minX);
  const bh = Math.max(1, maxY - minY);
  const sx = (PROV_SIDE - PAD * 2) / bw;
  const sy = (PROV_SIDE - PAD * 2) / bh;
  const cx0 = (minX + maxX) / 2, cy0 = (minY + maxY) / 2;
  const X = (x: number) => (x - cx0) * sx + PROV_SIDE / 2;
  const Y = (y: number) => (y - cy0) * sy + PROV_SIDE / 2;

  // 先映射到像素坐标，后续分离/展开均在像素空间进行
  nodes.forEach((n) => {
    n.x = X(n.x);
    n.y = Y(n.y);
  });

  // 像素级分离（保证任意两节点中心距 >= MIN_CENTER）
  const MIN_CENTER = 260;
  enforceMinCenter(nodes, MIN_CENTER);
  // 分离后整体居中
  recenter(nodes, PROV_SIDE / 2, PROV_SIDE / 2);
  // 簇内展开：同一节点上夹角过小的连线沿圆周推开，避免线条在节点附近重叠
  spreadSpokes(nodes, edges);
  // 展开后再分离、再居中
  enforceMinCenter(nodes, MIN_CENTER, 8);
  recenter(nodes, PROV_SIDE / 2, PROV_SIDE / 2);

  // 按分离/展开后的实际占用计算最终画布尺寸：完整容纳所有节点与边，不被截断，也无上下大片空白
  minX = Infinity; minY = Infinity; maxX = -Infinity; maxY = -Infinity;
  for (const n of nodes) {
    minX = Math.min(minX, n.x);
    maxX = Math.max(maxX, n.x);
    minY = Math.min(minY, n.y);
    maxY = Math.max(maxY, n.y);
  }
  const W = Math.ceil(Math.max(1, maxX - minX) + PAD * 2);
  const graphH = Math.ceil(Math.max(1, maxY - minY) + PAD * 2);
  const H = graphH + HEADER_H;
  recenter(nodes, W / 2, HEADER_H + graphH / 2);

  // 每条边的弯曲方向（曲线而非直线，方向按几何智能选取避免交错）
  const bendSigns = edgeBendSigns(edges, nodes);

  // 5. 绘制
  const canvas = createCanvas(W, H);
  const ctx = canvas.getContext('2d');

  // 背景：共用 _shared/assets/bg.jpg，失败回退浅色
  let bgImage: any = null;
  try {
    const bgPath = `${SHARED_ASSETS}bg.jpg`;
    if (fs.existsSync(bgPath)) {
      bgImage = await loadImage(fs.readFileSync(bgPath));
    }
  } catch {
    bgImage = null;
  }
  if (bgImage) {
    const bgScale = Math.max(W / bgImage.width, H / bgImage.height);
    const bgW = bgImage.width * bgScale, bgH = bgImage.height * bgScale;
    ctx.drawImage(bgImage, (W - bgW) / 2, (H - bgH) / 2, bgW, bgH);
  } else {
    ctx.fillStyle = '#f0f2f5';
    ctx.fillRect(0, 0, W, H);
  }

  // 标题：今日羁绊（黑色，与 test 一致）
  ctx.fillStyle = '#000000';
  ctx.font = `bold 42px ${FONT_FAMILY}`;
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  ctx.fillText('今日羁绊', W / 2, HEADER_H / 2);
  ctx.strokeStyle = 'rgba(0,0,0,0.08)';
  ctx.lineWidth = 2;
  ctx.beginPath();
  ctx.moveTo(0, HEADER_H);
  ctx.lineTo(W, HEADER_H);
  ctx.stroke();

  // 边（节点下层）
  edges.forEach((e, idx) => {
    const x1 = e.source.x, y1 = e.source.y;
    const x2 = e.target.x, y2 = e.target.y;
    const mx = (x1 + x2) / 2, my = (y1 + y2) / 2;
    const dx = x2 - x1, dy = y2 - y1;
    const len = Math.hypot(dx, dy) || 1;
    const bend = bendSigns[idx] * len * 0.3;
    const cx = mx + (-dy / len) * bend;
    const cy = my + (dx / len) * bend;

    // 边颜色和样式
    const colorMap: Record<string, string> = {
      draw: '#1890ff',
      force: '#ff4d4f',
      married: '#722ed1',   // 紫色：结婚
      propose: '#999999',   // 灰色：求婚失败
    };
    ctx.strokeStyle = colorMap[e.edgeType] || (e.forced ? '#ff4d4f' : '#1890ff');
    ctx.lineWidth = e.edgeType === 'married' ? 6 : 4;
    ctx.setLineDash(e.edgeType === 'propose' ? [8, 6] : []);
    ctx.beginPath();
    ctx.moveTo(x1, y1);
    ctx.quadraticCurveTo(cx, cy, x2, y2);
    ctx.stroke();
    ctx.setLineDash([]);

    // 箭头（二分求弧线与目标圆交点）
    const drawArrow = (tipX: number, tipY: number, ux: number, uy: number): void => {
      const al = 24;
      const c0 = Math.cos(0.42), s0 = Math.sin(0.42);
      ctx.fillStyle = ctx.strokeStyle;
      ctx.beginPath();
      ctx.moveTo(tipX, tipY);
      ctx.lineTo(tipX - al * (c0 * ux - s0 * uy), tipY - al * (s0 * ux + c0 * uy));
      ctx.lineTo(tipX - al * (c0 * ux + s0 * uy), tipY - al * (-s0 * ux + c0 * uy));
      ctx.closePath();
      ctx.fill();
    };

    const p0x = x1, p0y = y1, p1x = cx, p1y = cy, p2x = x2, p2y = y2;
    let lo = 0, hi = 1;
    for (let it = 0; it < 30; it++) {
      const mid = (lo + hi) / 2;
      const bx = (1 - mid) * (1 - mid) * p0x + 2 * (1 - mid) * mid * p1x + mid * mid * p2x;
      const by = (1 - mid) * (1 - mid) * p0y + 2 * (1 - mid) * mid * p1y + mid * mid * p2y;
      if (Math.hypot(bx - p2x, by - p2y) > NODE_R) lo = mid;
      else hi = mid;
    }
    const tTip = lo;
    const tipX = (1 - tTip) * (1 - tTip) * p0x + 2 * (1 - tTip) * tTip * p1x + tTip * tTip * p2x;
    const tipY = (1 - tTip) * (1 - tTip) * p0y + 2 * (1 - tTip) * tTip * p1y + tTip * tTip * p2y;
    const tdx = 2 * (1 - tTip) * (p1x - p0x) + 2 * tTip * (p2x - p1x);
    const tdy = 2 * (1 - tTip) * (p1y - p0y) + 2 * tTip * (p2y - p1y);
    const tl = Math.hypot(tdx, tdy) || 1;
    const ux = tdx / tl, uy = tdy / tl;
    drawArrow(tipX, tipY, ux, uy);

    // 结婚双向箭头：反方向也画一个
    if (e.edgeType === 'married') {
      let lo2 = 0, hi2 = 1;
      for (let it = 0; it < 30; it++) {
        const mid = (lo2 + hi2) / 2;
        const bx = (1 - mid) * (1 - mid) * p2x + 2 * (1 - mid) * mid * p1x + mid * mid * p0x;
        const by = (1 - mid) * (1 - mid) * p2y + 2 * (1 - mid) * mid * p1y + mid * mid * p0y;
        if (Math.hypot(bx - p0x, by - p0y) > NODE_R) lo2 = mid;
        else hi2 = mid;
      }
      const tTip2 = lo2;
      const tipX2 = (1 - tTip2) * (1 - tTip2) * p2x + 2 * (1 - tTip2) * tTip2 * p1x + tTip2 * tTip2 * p0x;
      const tipY2 = (1 - tTip2) * (1 - tTip2) * p2y + 2 * (1 - tTip2) * tTip2 * p1y + tTip2 * tTip2 * p0y;
      const tdx2 = 2 * (1 - tTip2) * (p1x - p2x) + 2 * tTip2 * (p0x - p1x);
      const tdy2 = 2 * (1 - tTip2) * (p1y - p2y) + 2 * tTip2 * (p0y - p1y);
      const tl2 = Math.hypot(tdx2, tdy2) || 1;
      drawArrow(tipX2, tipY2, tdx2 / tl2, tdy2 / tl2);
    }

    // 边标签（与 test 一致：深灰）
    const lx = (x1 + 2 * cx + x2) / 4, ly = (y1 + 2 * cy + y2) / 4;
    ctx.font = `bold 26px ${FONT_FAMILY}`;
    ctx.fillStyle = '#888888';
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.fillText(e.label, lx, ly + 1);
  });

  // 节点（头像层）
  for (const n of nodes) {
    const x = n.x, y = n.y;
    if (n.avatar) {
      ctx.save();
      ctx.beginPath();
      ctx.arc(x, y, n.r, 0, Math.PI * 2);
      ctx.clip();
      ctx.drawImage(n.avatar, x - n.r, y - n.r, n.r * 2, n.r * 2);
      ctx.restore();
    } else {
      // 无头像兜底：纯灰色圆
      ctx.beginPath();
      ctx.arc(x, y, n.r, 0, Math.PI * 2);
      ctx.fillStyle = '#94a3b8';
      ctx.fill();
    }
    // 描边
    ctx.beginPath();
    ctx.arc(x, y, n.r, 0, Math.PI * 2);
    ctx.lineWidth = 6;
    ctx.strokeStyle = '#4facfe';
    ctx.stroke();

    // 名字（与 test 一致：深灰）
    ctx.font = `bold 30px ${FONT_FAMILY}`;
    ctx.textAlign = 'center';
    ctx.textBaseline = 'top';
    ctx.fillStyle = '#444444';
    ctx.fillText(n.name, x, y + n.r + 14);
  }

  // 6. 输出 PNG Buffer（超大画布等比缩小到上限内，避免上传时被媒体服务 413 拒绝）
  let out = canvas;
  const MAX_SIDE = 2000;
  if (Math.max(W, H) > MAX_SIDE) {
    const s = MAX_SIDE / Math.max(W, H);
    const nw = Math.max(1, Math.round(W * s));
    const nh = Math.max(1, Math.round(H * s));
    out = createCanvas(nw, nh);
    out.getContext('2d').drawImage(canvas, 0, 0, nw, nh);
  }
  return out.toBuffer('image/png');
}
