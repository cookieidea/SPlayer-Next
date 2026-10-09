/**
 * 一起听房间内的不可共享曲目处理。
 *
 * 双人与多人房共用：正播本地/云盘歌时自动切到下一首可共享的，
 * 因为同步锚是歌曲 id，本地播对方拿不到的歌没有意义
 */
import { useStatusStore } from "@/stores/status";
import { useTogetherStore } from "@/stores/together";
import { useTogetherMultiStore } from "@/stores/togetherMulti";
import * as queue from "@/stores/queue";
import * as player from "@/core/player";
import { toast } from "@/composables/useToast";
import { isTogetherShareable } from "@shared/utils/togetherRoom";

let skipping = false;

export const skipUnshareableCurrent = async (): Promise<void> => {
  if (skipping) return;
  // 双人与多人房都走这里：任一侧有会话即视为在房间内
  if (!useTogetherStore().inRoom && !useTogetherMultiStore().inRoom) return;
  const status = useStatusStore();
  const list = queue.originalQueue.value
    ? queue.originalQueue.value.map((entry) => entry.track)
    : queue.queue.value;
  // currentTrack 由 playIndex 推导：刚 setQueue 还没起播时它可能是 undefined，
  // 但 playIndex 已指向的曲目才是"用户选中的那首"，一并纳入判定
  const current = status.currentTrack ?? list[status.playIndex] ?? null;
  if (!current || isTogetherShareable(current)) return;
  skipping = true;
  try {
    toast.warning("本地音乐和云盘歌曲无法一起听，已跳过");
    const at = list.findIndex(
      (item, index) => index > status.playIndex && isTogetherShareable(item),
    );
    if (at >= 0) {
      await player.playFrom(list, at, status.currentPlaybackContext, true);
      return;
    }
    // 后面没有了就从头找（循环语义），整队都不可共享才暂停
    const first = list.findIndex((item) => isTogetherShareable(item));
    if (first >= 0 && first !== status.playIndex) {
      await player.playFrom(list, first, status.currentPlaybackContext, true);
      return;
    }
    await player.pause();
  } finally {
    skipping = false;
  }
};
