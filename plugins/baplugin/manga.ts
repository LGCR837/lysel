// baplugin 官方漫画：随机抽取一张漫画图片
import { getMangaList, downloadImageBuffer } from './data.ts';

/** 随机返回一张官方漫画的 PNG Buffer */
export async function randomMangaBuffer(): Promise<Buffer> {
  const list = await getMangaList();
  if (!Array.isArray(list) || list.length === 0) throw new Error('漫画数据为空');
  const item = list[Math.floor(Math.random() * list.length)];
  const url = item && item.wikiurl;
  if (!url) throw new Error('漫画数据缺少图片地址');
  return downloadImageBuffer(url);
}
