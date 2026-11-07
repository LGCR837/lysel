// 自动抢红包：默认关闭，配置里把 enabled 改成 true 才生效
import type { PluginContext } from '../../core/types.ts';

export function onLoad(ctx: PluginContext) {
  if (ctx.config.enabled !== true) {
    ctx.log.info('未启用（config.enabled 不为 true）');
    return;
  }

  const native = ctx.native<{ gateway: (method: string, path: string, body?: unknown) => Promise<any> }>();

  ctx.onMessage(async (evt) => {
    if (evt.sender.id === evt.selfId) return;
    const raw = evt.raw as any;
    const msgType = String(raw?.msg_type ?? '');
    if (msgType !== 'red_packet') return;

    let packetId = '';
    try {
      const body = JSON.parse(String(raw?.body ?? '{}'));
      packetId = String(body.packet_id ?? body.packetId ?? '');
    } catch {
      packetId = '';
    }
    if (!packetId) {
      ctx.log.warn(`收到红包但没解析到 packet_id`);
      return;
    }

    try {
      const res = await native.gateway('POST', '/v2/redpackets/claim', { packet_id: packetId });
      const amount = res?.amount ?? res?.data?.amount ?? '?';
      ctx.log.info(`抢到红包 ${packetId.slice(0, 12)} 金额 ${amount}`);
    } catch (e: any) {
      ctx.log.warn(`抢红包失败 ${e?.message ?? e}`);
    }
  });

  ctx.log.info('已开启自动抢红包');
}
