import type { PluginContext } from '../../core/types.ts';

export function onLoad(ctx: PluginContext) {
  ctx.command('ping', (_args, evt) => ctx.reply(evt, 'pong'));

  ctx.command('echo', (args, evt) => {
    const prefix = String(ctx.config.replyPrefix ?? '');
    return ctx.reply(evt, `${prefix}${args.join(' ')}`.trim());
  });

  ctx.log.info('已就绪');
}
