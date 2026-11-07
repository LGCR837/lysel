// 群发言次数统计与每日排行榜
// 定时推送只在当天该群发言数达到 minDailyMessages 时才发，手动查询不受限制
import type { MessageEvent, PluginContext } from '../../core/types.ts';
import { readBody, wakeWordsOf } from '../_shared/trigger.ts';
import { TalkStore, todayStrUTC8, type RankItem } from './store.ts';
import { renderLeaderboard } from './render.ts';

let store: TalkStore | null = null;

export function onLoad(ctx: PluginContext) {
  const cfg: any = ctx.config ?? {};
  const topN = parseInt(cfg.topN, 10) || 15;
  const saveIntervalMs = parseInt(cfg.saveIntervalMs, 10) || 60000;
  const checkIntervalMs = Math.max(20000, parseInt(cfg.checkIntervalMs, 10) || 60000);
  const autoReport = cfg.autoReport !== false;
  const minDaily = Math.max(0, parseInt(cfg.minDailyMessages, 10) || 15);
  const autoReportTime = String(cfg.autoReportTime || '23:59');
  const wakeWords = wakeWordsOf(cfg);
  const aliases: string[] = (Array.isArray(cfg.commandAliases) ? cfg.commandAliases : ['发言排行榜', '信息排行榜', '消息排行榜']).map(String);

  store = new TalkStore(ctx.storage.file('talkcount.json'), saveIntervalMs, (lvl: string, ...args: any[]) =>
    (ctx.log as any)[lvl]?.(...args),
  );
  const data = store;

  const resolveNames = async (groupId: string, items: RankItem[]): Promise<RankItem[]> => {
    try {
      const members = await ctx.getGroupMembers(groupId);
      const map = new Map<string, string>();
      for (const m of members) if (m.id && !map.has(m.id)) map.set(m.id, m.name || m.id);
      return items.map((it) => ({ ...it, name: map.get(it.uid) || it.name || it.uid }));
    } catch {
      return items;
    }
  };

  const renderAndSend = async (groupId: string, date: string, title: string): Promise<void> => {
    let items = data.ranking(date, groupId).slice(0, topN);
    if (!items.length) throw new Error('该日暂无发言记录');
    items = await resolveNames(groupId, items);
    let stage = '渲染';
    try {
      const png = renderLeaderboard({ title, dateText: date, total: data.total(date, groupId), items, topN });
      stage = '上传';
      const url = await ctx.upload(png, 'image/png', 'talkcount.png');
      stage = '发送';
      await ctx.send({ scene: 'group', id: groupId }, [{ type: 'image', url }]);
    } catch (e: any) {
      throw new Error(`${stage}失败 ${e?.message ?? e}`);
    }
  };

  const handleCommand = async (evt: MessageEvent): Promise<void> => {
    if (evt.scene !== 'group') {
      await ctx.reply(evt, '此功能仅在群聊中可用哦~');
      return;
    }
    const today = todayStrUTC8();
    if (!data.ranking(today, evt.peerId).length) {
      await ctx.reply(evt, '今天还没有人发言喵~');
      return;
    }
    try {
      await renderAndSend(evt.peerId, today, '今日发言排行榜');
      ctx.log.info(`[rank] 已发送 ${evt.peerId} 今日排行榜`);
    } catch (e: any) {
      ctx.log.error(`排行榜生成失败 ${e?.message ?? e}`);
      await ctx.reply(evt, '排行榜生成失败喵~');
    }
  };

  /** 定时推送：逐群检查当天发言量，不足阈值只记日志不发 */
  const runDailyReport = async (date: string): Promise<void> => {
    if (!autoReport) return;
    const done = new Set(data.reportedGroups(date));
    for (const gid of data.groupsWithData(date)) {
      if (done.has(gid)) continue;
      const total = data.total(date, gid);
      if (total < minDaily) {
        ctx.log.info(`[daily] ${gid} 当天 ${total} 条不足 ${minDaily}，跳过定时榜`);
        continue;
      }
      try {
        await renderAndSend(gid, date, '今日发言排行榜');
        data.markGroupReported(date, gid);
        ctx.log.info(`[daily] 已发送 ${gid} ${date} 排行榜 (${total} 条)`);
      } catch (e: any) {
        ctx.log.error(`[daily] ${gid} 排行榜推送失败 ${e?.message ?? e}`);
      }
    }
    data.markReported(date);
    data.save();
  };

  // 计数：所有群消息都进统计，不拦截
  ctx.onMessage((evt) => {
    if (evt.scene !== 'group') return;
    const name = evt.sender.name && evt.sender.name !== evt.sender.id ? evt.sender.name : '';
    data.record(evt.peerId, evt.sender.id, name, todayStrUTC8());
  });

  ctx.onMessage((evt) => {
    const body = readBody(ctx, evt, { wakeWords });
    if (body === null) return;
    if (!aliases.some((a) => a.toLowerCase() === body.toLowerCase())) return;
    void handleCommand(evt).catch((e: any) => ctx.log.error(`排行榜命令异常 ${e?.message ?? e}`));
  });

  // 定时检查：命中 autoReportTime 且当天没推送过就推
  let lastCheckDate = '';
  ctx.schedule('daily', checkIntervalMs, () => {
    const now = new Date(Date.now() + 8 * 3600000);
    const hh = String(now.getUTCHours()).padStart(2, '0');
    const mm = String(now.getUTCMinutes()).padStart(2, '0');
    const today = todayStrUTC8();
    if (`${hh}:${mm}` !== autoReportTime || lastCheckDate === today) return;
    lastCheckDate = today;
    void runDailyReport(today).catch((e: any) => ctx.log.error(`每日排行榜推送异常 ${e?.message ?? e}`));
  });

  // 启动补报：已过推送时间且今天还没推过
  setTimeout(() => {
    const today = todayStrUTC8();
    if (data.lastReportedDate === today) return;
    const now = new Date(Date.now() + 8 * 3600000);
    const line = `${String(now.getUTCHours()).padStart(2, '0')}:${String(now.getUTCMinutes()).padStart(2, '0')}`;
    if (line < autoReportTime) return;
    lastCheckDate = today;
    void runDailyReport(today).catch((e: any) => ctx.log.error(`每日排行榜补报异常 ${e?.message ?? e}`));
  }, 5000).unref?.();

  ctx.log.info(`已就绪 topN=${topN} 每日 ${autoReportTime} 阈值 ${minDaily} 条`);
}

export function onUnload() {
  if (store) {
    store.dispose();
    store = null;
  }
}
