import type { Track } from "@shared/types/player";
import { useTogetherMultiStore } from "@/stores/togetherMulti";
import { addMultiSong } from "@/services/listenTogetherMulti";
import { toast } from "@/composables/useToast";

/**
 * 多人一起听里的本地播放控制守卫。
 *
 * 多人房的播放态与切换都由房间决定（进度来自 startTime、换歌靠投票），
 * 本地播放会被下一次心跳拉回，还会打乱本地队列。
 * 因此房内的"点歌"语义改成「把这首歌加进房间队列」——这才是有意义的动作；
 * 暂停则直接拒绝（房间里没有暂停这个状态）。
 */
export const useTogetherPlaybackGuard = () => {
  const multiStore = useTogetherMultiStore();
  const { t } = useI18n();

  /**
   * 房内的播放入口统一走这里。
   * 返回 true 表示已接管（调用方应直接 return）。
   * @param track - 想播放的曲目；房内会改为加入房间队列
   */
  const blockLocalPlay = (track?: Track | null): boolean => {
    if (!multiStore.inRoom) return false;
    if (track) {
      void addMultiSong(track);
    } else {
      toast.warning(t("player.together.localPlayDisabled"));
    }
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
  };
};
