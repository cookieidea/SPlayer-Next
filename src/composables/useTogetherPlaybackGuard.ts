import type { Track } from "@shared/types/player";
import { useTogetherMultiStore } from "@/stores/togetherMulti";
import { addMultiSong } from "@/services/listenTogetherMulti";
import { toast } from "@/composables/useToast";

/**
 * 多人一起听里的本地播放控制守卫。
 *
 * 多人房的播放态与切换都由房间决定（进度来自 startTime、换歌靠投票），
 * 本地播放会被下一次心跳拉回，还会打乱本地队列。因此房内：
 *  - 点单首歌 → 改成「加进房间队列」（这才是有意义的动作）
 *  - 批量播放（播放全部 / 每日推荐 / 从某首播整个列表）→ 直接拒绝，
 *    否则本地队列会被整批替换，和房间的待播窗口互相打架
 *  - 暂停 → 拒绝（房间里没有暂停这个状态）
 */
export const useTogetherPlaybackGuard = () => {
  const multiStore = useTogetherMultiStore();
  const { t } = useI18n();

  /**
   * 房内的播放入口统一走这里。
   * 返回 true 表示已接管（调用方应直接 return）。
   * @param track - 单首点播；房内会改为加入房间队列
   */
  const blockLocalPlay = (track?: Track | null): boolean => {
    if (!multiStore.inRoom) return false;
    if (track) void addMultiSong(track);
    else toast.warning(t("player.together.localPlayDisabled"));
    return true;
  };

  /**
   * 批量播放入口（播放全部 / 每日推荐 / 从某首播整个列表）用这个。
   * 一律拒绝：一次替换整批会和房间的队列相互覆盖
   */
  const blockBatchPlay = (): boolean => {
    if (!multiStore.inRoom) return false;
    toast.warning(t("player.together.batchPlayDisabled"));
    return true;
  };

  /**
   * 房内改本地队列的操作（如"下一首播放"）用这个：
   * 播放的是房间队列，改本地队列不会生效，反而让人以为排上了
   */
  const blockLocalQueueEdit = (): boolean => {
    if (!multiStore.inRoom) return false;
    toast.warning(t("player.together.localQueueDisabled"));
    return true;
  };

  const blockPause = (): boolean => {
    if (!multiStore.inRoom) return false;
    toast.warning(t("player.together.pauseDisabled"));
    return true;
  };

  return {
    inMultiRoom: computed(() => multiStore.inRoom),
    blockPause,
    blockLocalPlay,
    blockBatchPlay,
    blockLocalQueueEdit,
  };
};
