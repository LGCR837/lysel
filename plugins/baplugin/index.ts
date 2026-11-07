// BA 工具箱：好感计算 / 抽卡模拟 / 官方漫画
import type { MessageEvent, PluginContext } from '../../core/types.ts';
import { readBody, wakeWordsOf } from '../_shared/trigger.ts';
import { parseFavorLevels, calculateNumer, matchStudent, renderFavorImg } from './favor.ts';
import { setWarnHook, setDebugHook } from './data.ts';
import {
  ensureGachaData,
  gacha10,
  gacha200,
  renderGacha10Img,
  renderGacha200Img,
  renderPicksImg,
  validateUpStudent,
  type ServerId,
} from './gacha.ts';
import { randomMangaBuffer } from './manga.ts';

const HELP_TEXT = `BA 工具箱
  好感     BA 好感 1-100 爱丽丝
  抽卡     BA 抽卡 日服 [up角色]
           BA 抽卡 日服一井 [up角色]
           BA 抽卡 国际服 / 国际服一井
           BA 抽卡 国服 / 国服一井
  漫画     BA 漫画
  帮助     BA 帮助`;

function serverFromName(name: string): ServerId {
  if (name === '日服') return 0;
  if (name === '国际服') return 1;
  return 2;
}

export function onLoad(ctx: PluginContext) {
  const wakeWords = wakeWordsOf(ctx.config);
  const requireWake = ctx.config.requireWakeInGroup === true;
  setWarnHook((msg) => ctx.log.warn(msg));
  setDebugHook((msg) => ctx.log.debug(msg));

  void ensureGachaData().catch((e: any) => ctx.log.error(`初始化抽卡数据失败 ${e?.message ?? e}`));

  const sendImage = async (evt: MessageEvent, buf: Buffer, name = 'ba.png'): Promise<void> => {
    try {
      const url = await ctx.upload(buf, 'image/png', name);
      await ctx.send(evt, [{ type: 'image', url }]);
    } catch (e: any) {
      ctx.log.error(`图片发送失败 ${e?.message ?? e}`);
      await ctx.reply(evt, '图片发不出去喵~');
    }
  };

  const handleFavor = async (evt: MessageEvent, body: string): Promise<void> => {
    const rest = body.replace(/^好感\s*/, '').trim();
    if (!rest) {
      await ctx.reply(evt, '好感计算\n用法：BA 好感 1-100 爱丽丝');
      return;
    }
    const parts = rest.split(/\s+/);
    const lv = parseFavorLevels(parts[0]);
    if (!lv.ok) {
      await ctx.reply(evt, lv.msg);
      return;
    }
    const num = calculateNumer(lv.start, lv.end);
    const namePart = parts.slice(1).join(' ');
    let stu: { Id_db: number; MapName: string } | null = null;
    if (namePart) {
      stu = await matchStudent(namePart);
      if (!stu) await ctx.reply(evt, '未匹配到该学生喵，为你计算通用好感需求~');
    }
    const buf = await renderFavorImg(num, stu ?? undefined);
    await sendImage(evt, buf, 'ba-favor.png');
  };

  const handleGacha = async (evt: MessageEvent, body: string): Promise<void> => {
    const rest = body.replace(/^抽卡\s*/, '').trim();
    if (!rest) {
      await sendImage(evt, await renderPicksImg(), 'ba-picks.png');
      return;
    }
    let serid: ServerId;
    let isWell = false;
    let upName = '';
    const wellMatch = rest.match(/^(日服|国际服|国服)\s*一井\s*(.*)$/);
    if (wellMatch) {
      serid = serverFromName(wellMatch[1]);
      isWell = true;
      upName = wellMatch[2].trim();
    } else {
      const tenMatch = rest.match(/^(日服|国际服|国服)\s*(.*)$/);
      if (!tenMatch) {
        await ctx.reply(evt, '服务器名不对喵，可选：日服 / 国际服 / 国服');
        return;
      }
      serid = serverFromName(tenMatch[1]);
      upName = tenMatch[2].trim();
    }

    let upId: number | undefined;
    if (upName) {
      const check = await validateUpStudent(upName, serid);
      if (!check.ok) {
        await ctx.reply(evt, check.msg);
        return;
      }
      upId = check.id;
    }

    ctx.log.debug(`抽卡 serid=${serid} 一井=${isWell} up=${upName || '无'}`);
    const result = isWell ? gacha200(serid, upId) : gacha10(serid, upId);
    ctx.log.debug(`抽卡结果 ${JSON.stringify(result[1])}`);
    const muzhu = result[1].reduce((sum: number, s) => {
      if (s === 1) return sum + 1;
      if (s === 2) return sum + 10;
      if (s === 3 || s === 4 || s === 'pick') return sum + 50;
      return sum;
    }, 0);
    const started = Date.now();
    const buf = isWell ? await renderGacha200Img(result, serid) : await renderGacha10Img(result, serid, muzhu);
    ctx.log.debug(`抽卡图渲染完成 ${buf.length}B ${Date.now() - started}ms`);
    await sendImage(evt, buf, 'ba-gacha.png');
  };

  ctx.onMessage(async (evt) => {
    const body = readBody(ctx, evt, { wakeWords, requireWakeInGroup: requireWake });
    if (body === null) return;
    const m = body.match(/^ba[\s:：,，]+(.+)$/i) ?? body.match(/^ba$/i);
    if (!m) {
      ctx.log.debug(`未命中 正文="${body.slice(0, 60)}"`);
      return;
    }

    try {
      const cmd = (m[1] ?? '').trim();
      ctx.log.debug(`命中 BA 子命令="${cmd || '(空)'}"`);
      if (!cmd || /^(帮助|help|菜单|menu)$/i.test(cmd)) {
        await ctx.reply(evt, HELP_TEXT);
        return;
      }
      if (/^漫画$/i.test(cmd)) {
        try {
          await sendImage(evt, await randomMangaBuffer(), 'ba-manga.png');
        } catch (e: any) {
          ctx.log.error(`漫画失败 ${e?.message ?? e}`);
          await ctx.reply(evt, '呜呜呜，漫画出错了');
        }
        return;
      }
      if (/^好感/.test(cmd)) {
        await handleFavor(evt, cmd);
        return;
      }
      if (/^抽卡/.test(cmd)) {
        await handleGacha(evt, cmd);
        return;
      }
      await ctx.reply(evt, HELP_TEXT);
    } catch (e: any) {
      ctx.log.error(`BA 命令异常 ${e?.message ?? e}`);
      await ctx.reply(evt, '呜呜呜，出错了喵~');
    }
  });

  ctx.log.info(`已就绪 唤醒词 ${wakeWords.join('/') || '无'}`);
}
