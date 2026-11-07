// 今日老婆：按群隔离的抽取 / 求婚 / 强娶 / 关系图
import type { MessageEvent, PluginContext, Member } from '../../core/types.ts';
import { readBody, atTargetId, todayStr, clockStr, wakeWordsOf } from '../_shared/trigger.ts';
import { WpStore, type ProposeRecord } from './store.ts';
import { renderGraph, prewarmAvatar, setAvatarTimeout, setMediaOrigin, type GraphRecord } from './graph.ts';

interface Pending {
  proposerId: string;
  proposerName: string;
  targetId: string;
  targetName: string;
  groupId: string;
  expireAt: number;
}

let store: WpStore | null = null;
let pending: Map<string, Pending> | null = null;

export function onLoad(ctx: PluginContext) {
  const cfg: any = ctx.config ?? {};
  const excluded = new Set((Array.isArray(cfg.excludedUsers) ? cfg.excludedUsers : []).map(String));
  const mediaOrigin = String(cfg.mediaOrigin || 'https://oc.mcl0.dpdns.org');
  const autoGraph = cfg.autoGraph !== false;
  const autoGraphTime = String(cfg.autoGraphTime || '23:58');
  const minDailyDraws = Math.max(0, parseInt(cfg.minDailyDraws, 10) || 5);
  const wakeWords = wakeWordsOf(cfg);

  setMediaOrigin(mediaOrigin);
  setAvatarTimeout(parseInt(cfg.avatarTimeout, 10) || 8000);

  store = new WpStore(ctx.storage.file('wifepicker.json'), (lvl, msg) => (ctx.log as any)[lvl]?.(msg));
  pending = new Map();
  const data = store;
  const proposals = pending;

  const isSelf = (uid: string): boolean => !!uid && uid === ctx.account.selfId;

  const avatarUrl = (m: Member | undefined): string => {
    const raw = String(m?.avatar ?? '');
    if (!raw) return '';
    if (/^https?:\/\//i.test(raw)) return raw;
    return mediaOrigin.replace(/\/+$/, '') + (raw.startsWith('/') ? raw : `/${raw}`);
  };

  // 头像预热串行，避免瞬间打爆媒体源
  const warmQueue = new Set<string>();
  let warming = false;
  const queueWarm = (url: string): void => {
    if (!url) return;
    warmQueue.add(url);
    if (warming) return;
    warming = true;
    void (async () => {
      while (warmQueue.size) {
        const next = warmQueue.values().next().value as string;
        warmQueue.delete(next);
        await prewarmAvatar(next).catch(() => {});
        await new Promise((r) => setTimeout(r, 80));
      }
      warming = false;
    })();
  };

  const sendAvatar = async (evt: MessageEvent, raw: string): Promise<void> => {
    if (!raw) return;
    try {
      await ctx.send(evt, [{ type: 'image', url: avatarUrl({ id: '', name: '', avatar: raw }) }]);
    } catch (e: any) {
      ctx.log.warn(`头像发送失败 ${e?.message ?? e}`);
    }
  };

  const handleDraw = async (evt: MessageEvent): Promise<void> => {
    if (evt.scene !== 'group') {
      await ctx.reply(evt, '此功能仅在群聊中可用哦~');
      return;
    }
    const members = await ctx.getGroupMembers(evt.peerId);
    const candidates = members.filter((m) => m.id && !isSelf(m.id) && !excluded.has(m.id));
    if (!candidates.length) {
      await ctx.reply(evt, '群里没有可以抽的成员喵~');
      return;
    }
    // 近 7 天说过话的优先，没人活跃就回退全群
    let pool = candidates;
    const active = data.activeSince(evt.peerId, Date.now() - 7 * 86400000);
    if (active.size) {
      const filtered = candidates.filter((m) => active.has(m.id));
      if (filtered.length) pool = filtered;
    }
    const withAvatar = pool.filter((m) => !!m.avatar);
    const finalPool = withAvatar.length ? withAvatar : pool;
    const target = finalPool[Math.floor(Math.random() * finalPool.length)];
    const name = target.name || target.id;

    data.addRecord(evt.peerId, {
      user_id: evt.sender.id,
      wife_id: target.id,
      wife_name: name,
      date: todayStr(),
      forced: false,
    });
    data.save();
    ctx.log.info(`[draw] ${evt.peerId} ${evt.sender.id} 抽到 ${target.id} (${name})`);

    queueWarm(avatarUrl(target));
    await ctx.reply(evt, `你的今日老婆是：\n\n【${name}】\n请好好对待她哦❤️~`);
    await sendAvatar(evt, String(target.avatar ?? ''));
  };

  const handleMyWife = async (evt: MessageEvent): Promise<void> => {
    if (evt.scene !== 'group') {
      await ctx.reply(evt, '此功能仅在群聊中可用哦~');
      return;
    }
    const list = data.getTodayRecords(evt.peerId, evt.sender.id);
    if (!list.length) {
      await ctx.reply(evt, '你今天还没有老婆哦，快发「今日老婆」抽一个吧喵~');
      return;
    }
    const lines = list.map((r, i) => `${i + 1}. 【${r.wife_name}】${r.forced ? '（强娶）' : '（抽取）'}`);
    await ctx.reply(evt, `你今天的老婆（${list.length} 个）：\n${lines.join('\n')}`);
  };

  const findMember = async (evt: MessageEvent, targetId: string): Promise<Member | undefined> => {
    if (!targetId) return undefined;
    const members = await ctx.getGroupMembers(evt.peerId);
    return members.find((m) => m.id === targetId) ?? members.find((m) => m.id.toUpperCase() === targetId.toUpperCase());
  };

  const handlePropose = async (evt: MessageEvent, targetId: string): Promise<void> => {
    if (evt.scene !== 'group') {
      await ctx.reply(evt, '求婚只能在群聊中进行哦~');
      return;
    }
    if (!targetId) {
      await ctx.reply(evt, '用法: 求婚 @某人');
      return;
    }
    if (targetId === evt.sender.id) {
      await ctx.reply(evt, '不能向自己求婚哦！');
      return;
    }
    const pk = `${evt.peerId}:${targetId}`;
    if (proposals.has(pk)) {
      await ctx.reply(evt, '对方已经有一个待处理的求婚了，请稍后再试。');
      return;
    }
    for (const v of proposals.values()) {
      if (v.proposerId === evt.sender.id && v.groupId === evt.peerId) {
        await ctx.reply(evt, '你已经有一个待处理的求婚了，请等待对方回复。');
        return;
      }
    }
    const target = await findMember(evt, targetId);
    if (!target) {
      await ctx.reply(evt, '没有在群里找到这个用户喵~');
      return;
    }
    const targetName = target.name || target.id;
    const proposerName = evt.sender.name || evt.sender.id;

    proposals.set(pk, {
      proposerId: evt.sender.id,
      proposerName,
      targetId: target.id,
      targetName,
      groupId: evt.peerId,
      expireAt: Date.now() + 30000,
    });
    await ctx.reply(
      evt,
      `🌹 ${proposerName} 向【${targetName}】发起了求婚！\n请在 30 秒内回复"同意"来接受，或回复"拒绝"来拒绝。`,
    );

    setTimeout(() => {
      const req = proposals.get(pk);
      if (!req) return;
      proposals.delete(pk);
      data.addPropose(req.groupId, {
        proposer_id: req.proposerId,
        target_id: req.targetId,
        proposer_name: req.proposerName,
        target_name: req.targetName,
        date: todayStr(),
        accepted: false,
      });
      data.save();
      void ctx
        .send({ scene: 'group', id: req.groupId }, `...很遗憾，${req.targetName} 没有回应 ${req.proposerName} 的求婚...`)
        .catch(() => {});
    }, 32000).unref?.();
  };

  const handleProposeReply = async (evt: MessageEvent, body: string): Promise<boolean> => {
    if (evt.scene !== 'group') return false;
    const pk = `${evt.peerId}:${evt.sender.id}`;
    const req = proposals.get(pk);
    if (!req) return false;
    if (Date.now() > req.expireAt) {
      proposals.delete(pk);
      return false;
    }
    const rec: ProposeRecord = {
      proposer_id: req.proposerId,
      target_id: req.targetId,
      proposer_name: req.proposerName,
      target_name: req.targetName,
      date: todayStr(),
      accepted: body === '同意',
    };

    if (body === '同意') {
      proposals.delete(pk);
      data.addRecord(req.groupId, {
        user_id: req.proposerId,
        wife_id: req.targetId,
        wife_name: req.targetName,
        date: todayStr(),
        forced: false,
      });
      data.addRecord(req.groupId, {
        user_id: req.targetId,
        wife_id: req.proposerId,
        wife_name: req.proposerName,
        date: todayStr(),
        forced: false,
      });
      data.addPropose(req.groupId, rec);
      data.save();
      await ctx.reply(evt, `🎉 恭喜！${req.targetName} 接受了 ${req.proposerName} 的求婚！\n你们已正式结为夫妻！`);
      return true;
    }

    proposals.delete(pk);
    data.addPropose(req.groupId, rec);
    data.save();
    await ctx.reply(evt, `很遗憾，${req.targetName} 拒绝了 ${req.proposerName} 的求婚。`);
    return true;
  };

  const handleForceMarry = async (evt: MessageEvent, targetId: string): Promise<void> => {
    if (evt.scene !== 'group') {
      await ctx.reply(evt, '此功能仅在群聊中可用哦~');
      return;
    }
    if (!targetId) {
      await ctx.reply(evt, '用法: 强娶 @某人');
      return;
    }
    const target = await findMember(evt, targetId);
    if (!target) {
      await ctx.reply(evt, '没有在群里找到这个用户喵~');
      return;
    }
    const name = target.name || target.id;
    data.addRecord(evt.peerId, {
      user_id: evt.sender.id,
      wife_id: target.id,
      wife_name: name,
      date: todayStr(),
      forced: true,
    });
    data.addRbq(evt.peerId, target.id);
    data.setForceMarryDate(evt.peerId, evt.sender.id, todayStr());
    data.save();
    ctx.log.info(`[force] ${evt.peerId} ${evt.sender.id} 强娶 ${target.id} (${name})`);

    queueWarm(avatarUrl(target));
    await ctx.reply(evt, `你今天强娶了【${name}】哦❤️~\n请对她好一点哦~。`);
    await sendAvatar(evt, String(target.avatar ?? ''));
  };

  const memberMapOf = async (groupId: string): Promise<Map<string, { name: string; avatar?: string }>> => {
    const map = new Map<string, { name: string; avatar?: string }>();
    try {
      for (const m of await ctx.getGroupMembers(groupId)) {
        if (!m.id || map.has(m.id)) continue;
        map.set(m.id, { name: m.name || m.id, avatar: avatarUrl(m) || undefined });
      }
    } catch (e: any) {
      ctx.log.warn(`拉取群成员失败 ${e?.message ?? e}`);
    }
    return map;
  };

  const renderGroupGraph = async (groupId: string): Promise<Buffer> => {
    const records = data.getTodayRecords(groupId);
    const proposes = data.getTodayProposes(groupId);
    if (!records.length && !proposes.length) throw new Error('今日无老婆记录');
    const members = await memberMapOf(groupId);
    const graphRecords: GraphRecord[] = records.map((r) => ({
      user_id: r.user_id,
      wife_id: r.wife_id,
      forced: r.forced,
      edgeType: r.forced ? 'force' : 'draw',
    }));
    for (const p of proposes) {
      graphRecords.push({
        user_id: p.proposer_id,
        wife_id: p.target_id,
        forced: false,
        edgeType: p.accepted ? 'married' : 'propose',
      });
    }
    for (const r of graphRecords) {
      queueWarm(members.get(r.user_id)?.avatar ?? '');
      queueWarm(members.get(r.wife_id)?.avatar ?? '');
    }
    return renderGraph(graphRecords, members);
  };

  const sendGraph = async (groupId: string): Promise<void> => {
    const png = await renderGroupGraph(groupId);
    const url = await ctx.upload(png, 'image/png', 'wifepicker.png');
    await ctx.send({ scene: 'group', id: groupId }, [{ type: 'image', url }]);
  };

  const handleGraph = async (evt: MessageEvent): Promise<void> => {
    if (evt.scene !== 'group') {
      await ctx.reply(evt, '此功能仅在群聊中可用哦~');
      return;
    }
    if (!data.getTodayRecords(evt.peerId).length) {
      await ctx.reply(evt, '今天还没有老婆记录，快让大家抽老婆吧喵~');
      return;
    }
    await ctx.reply(evt, '关系图正在生成，稍微等一下喵~');
    try {
      await sendGraph(evt.peerId);
    } catch (e: any) {
      ctx.log.error(`关系图生成失败 ${e?.message ?? e}`);
      await ctx.reply(evt, '关系图生成失败喵~');
    }
  };

  const handleRbqRank = async (evt: MessageEvent): Promise<void> => {
    if (evt.scene !== 'group') {
      await ctx.reply(evt, '此功能仅在群聊中可用哦~');
      return;
    }
    const ranking = data.getRbqRanking(evt.peerId).slice(0, 10);
    if (!ranking.length) {
      await ctx.reply(evt, '本群还没有人被强娶过，大家都很有礼貌呢。');
      return;
    }
    const members = await ctx.getGroupMembers(evt.peerId).catch(() => [] as Member[]);
    const nameOf = (uid: string): string => members.find((m) => m.id === uid)?.name || `用户(${uid.slice(-4)})`;
    const lines = ranking.map((r, i) => `${i + 1}. ${nameOf(r.uid)} - ${r.count}次`);
    await ctx.reply(evt, `RBQ 排行榜：\n${lines.join('\n')}`);
  };

  /** 定时推送：逐群检查当天抽取次数，不足阈值跳过 */
  const runAutoGraph = async (date: string): Promise<void> => {
    if (!autoGraph) return;
    let sent = 0;
    for (const groupId of data.groupIds()) {
      if (data.graphReported(groupId) === date) continue;
      const draws = data.getTodayRecords(groupId).length;
      if (!draws) continue;
      if (draws < minDailyDraws) {
        ctx.log.info(`[autoGraph] ${groupId} 今天 ${draws} 次不足 ${minDailyDraws}，跳过`);
        continue;
      }
      try {
        await sendGraph(groupId);
        data.markGraphReported(groupId, date);
        sent++;
        ctx.log.info(`[autoGraph] 已发送 ${groupId} 关系图 (${draws} 条记录)`);
      } catch (e: any) {
        ctx.log.error(`[autoGraph] ${groupId} 推送失败 ${e?.message ?? e}`);
      }
    }
    data.save();
    if (sent) ctx.log.info(`[autoGraph] 本次共发送 ${sent} 个群`);
  };

  // 记录活跃（用于抽取优先池）
  ctx.onMessage((evt) => {
    if (evt.scene !== 'group' || evt.sender.id === evt.selfId) return;
    data.recordActive(evt.peerId, evt.sender.id, Date.now());
  });

  ctx.onMessage(async (evt) => {
    const body = readBody(ctx, evt, { wakeWords });
    if (body === null) return;

    if (await handleProposeReply(evt, body)) return;

    if (/^(今日老婆|抽老婆)$/.test(body)) {
      await handleDraw(evt);
      return;
    }
    if (/^(我的老婆|抽取历史)$/.test(body)) {
      await handleMyWife(evt);
      return;
    }
    const propose = body.match(/^求婚[\s：:]*(.*)$/);
    if (propose) {
      await handlePropose(evt, atTargetId(evt) || propose[1].trim());
      return;
    }
    const force = body.match(/^强娶[\s：:]*(.*)$/);
    if (force) {
      await handleForceMarry(evt, atTargetId(evt) || force[1].trim());
      return;
    }
    if (/^(rbq排行|rbq榜)$/i.test(body)) {
      await handleRbqRank(evt);
      return;
    }
    if (/^(关系图|羁绊图谱)$/.test(body)) {
      await handleGraph(evt);
      return;
    }
  });

  // 定时检查：命中 autoGraphTime 且当天没跑过就推
  let lastRunDate = '';
  ctx.schedule('graph', 60000, () => {
    const today = todayStr();
    if (clockStr() !== autoGraphTime || lastRunDate === today) return;
    lastRunDate = today;
    void runAutoGraph(today).catch((e: any) => ctx.log.error(`定时关系图异常 ${e?.message ?? e}`));
  });

  ctx.log.info(`已就绪 按群隔离 阈值 ${minDailyDraws} 次 每日 ${autoGraphTime}`);
}

export function onUnload() {
  if (store) store.save();
  store = null;
  pending = null;
}
