import { useTogetherStore } from "@/stores/together";
import { useTogetherMultiStore } from "@/stores/togetherMulti";
import { useStatusStore } from "@/stores/status";
import * as queue from "@/stores/queue";
import { restoreTogetherMulti } from "@/services/listenTogetherMulti";
import { isMultiRoomType, isTogetherShareable } from "@shared/utils/togetherRoom";
import * as player from "@/core/player";
import { songsByIds } from "@/apis/song/netease";
import { toast } from "@/composables/useToast";
import { readTogetherCounters, setTogetherCounting } from "@/services/togetherCounter";
import { buildInvitation, parseInvitation } from "@shared/utils/togetherInvitation";
import type {
  TogetherCommand,
  TogetherFriend,
  TogetherInviteCard,
  TogetherLocalState,
  TogetherSyncEvent,
} from "@shared/types/listenTogether";
import type { Track } from "@shared/types/player";

const REPORT_INTERVAL_MS = 1000;

const QUEUE_FETCH_LIMIT = 500;

/** 整表解析失败时，只解析目标曲目附近的这么多首。
 *  房间歌单可能上千首，整表解析既慢又容易整批失败，而起播只需要当前那一首 */
const ADOPT_WINDOW = 200;

let busyCount = 0;

const beginBusy = (): void => {
  busyCount += 1;
  useTogetherStore().busy = true;
};

const endBusy = (): void => {
  busyCount = Math.max(0, busyCount - 1);
  if (busyCount === 0) useTogetherStore().busy = false;
};

const TOGETHER_CONTEXT = {
  originId: "listen-together",
  originType: "page" as const,
  originName: "一起听",
};

let reportTimer: ReturnType<typeof setInterval> | null = null;
let unsubscribe: (() => void) | null = null;
let pendingLoad = false;

const collectState = (): TogetherLocalState => {
  const status = useStatusStore();
  const track = status.currentTrack;
  // 当前曲也必须可共享：正在放云盘歌时上报它的 id，对方会卡在放不出来的歌上
  const shareableTrack = track && isTogetherShareable(track) ? track : null;
  const counters = readTogetherCounters();
  // 本地洗牌是播放行为（网易云那边叫"随机"，列表本身不变），
  // 共享歌单必须始终用原始顺序，否则本地一开随机就把打乱结果写进了房间
  const trackList = queue.originalQueue.value
    ? queue.originalQueue.value.map((entry) => entry.track)
    : queue.queue.value;
  const songIds = shareableTrack
    ? trackList.filter(isTogetherShareable).map((item) => item.id)
    : [];
  notifyUnshareable(trackList);
  return {
    songId: shareableTrack ? shareableTrack.id : "",
    queueSongIds: songIds,
    currentIndex: shareableTrack ? songIds.indexOf(shareableTrack.id) : -1,
    positionMs: Math.max(0, Math.round(status.position)),
    playing: status.isPlaying,
    transitioning: status.trackLoading || pendingLoad,
    seekRevision: counters.seekRevision,
    endRevision: counters.endRevision,
    playMode: localPlayMode(status),
  };
};

const localPlayMode = (status: ReturnType<typeof useStatusStore>): string => {
  if (status.repeatMode === "one") return "SINGLE_LOOP";
  if (status.shuffleMode === "on") return "RANDOM";
  return "ORDER_LOOP";
};

/** 上次已提示过的不可共享曲目签名，避免每轮上报都弹提示 */
let unshareableSignature = "";

/** 队列里混着本地/云盘音乐时提示一次：这些歌不会同步给对方 */
const notifyUnshareable = (trackList: readonly Track[]): void => {
  const skipped = trackList.filter((item) => !isTogetherShareable(item));
  const signature = skipped.map((item) => item.id).join(",");
  if (signature === unshareableSignature) return;
  unshareableSignature = signature;
  if (skipped.length === 0) return;
  toast.info(`一起听已跳过 ${skipped.length} 首本地/云盘音乐（对方无法播放）`);
};

const pushState = (): void => {
  if (!useTogetherStore().inRoom) return;
  window.api.together.sync(collectState());
};

/** 以目标曲目为中心取一段窗口，务必包含目标本身 */
const windowAround = (ids: readonly string[], targetId: string, size: number): string[] => {
  if (ids.length <= size) return [...ids];
  const at = ids.indexOf(targetId);
  if (at < 0) return ids.slice(0, size);
  const half = Math.floor(size / 2);
  const start = Math.max(0, Math.min(at - half, ids.length - size));
  return ids.slice(start, start + size);
};

const tracksForIds = async (songIds: readonly string[]): Promise<Track[]> => {
  const known = new Map<string, Track>();
  for (const item of queue.queue.value) {
    if (item.source === "netease" && !known.has(item.id)) known.set(item.id, item);
  }
  const missing = songIds.filter((id) => !known.has(id));
  for (let start = 0; start < missing.length; start += QUEUE_FETCH_LIMIT) {
    const batch = await songsByIds(missing.slice(start, start + QUEUE_FETCH_LIMIT));
    for (const track of batch) known.set(track.id, track);
  }
  return songIds.map((id) => known.get(id)).filter((track): track is Track => track !== undefined);
};

const respondCommand = async (
  command: TogetherCommand,
  index: number,
  list: readonly Track[],
): Promise<void> => {
  const status = useStatusStore();
  if (command.type === "PLAYMODE_CHANGE") return;
  const seekOnly = command.type === "PROGRESS";
  // PROGRESS 的 playing 是中性值（解析层刻意置 false），不能拿它决定要不要播放：
  // 对方拖进度时若目标曲与本地不同，被迫换曲后会一直停在暂停，等于把接收方静音
  const autoPlay = seekOnly ? status.isPlaying : command.playing;
  if (status.currentTrack?.id !== command.targetSongId) {
    // 必须交原始顺序：传洗牌后的顺序回 playFrom，setQueue 会把它当成新的原始顺序，
    // 之后"关闭随机"就再也还原不回来了
    await player.playFrom(list, index, status.currentPlaybackContext, autoPlay);
    reapplyLocalShuffle();
  }
  await player.seek(command.progressMs);
  if (seekOnly) return;
  if (command.playing) await player.play();
  else await player.pause();
};

/**
 * 采纳共享队列后重建本地洗牌的备份。
 * setQueue 会清掉 originalQueue 但保留 shuffleMode，不重新洗牌的话
 * 之后"关闭随机"再也无法还原顺序
 */
const reapplyLocalShuffle = (): void => {
  const status = useStatusStore();
  if (status.shuffleMode !== "on") return;
  queue.shuffleQueue(status.playIndex);
  status.playIndex = 0;
};

const applyRemote = async (
  songIds: readonly string[],
  command: TogetherCommand | null,
  initial: boolean,
  playOnEntry = false,
): Promise<void> => {
  if (songIds.length > 0) {
    const targetId = command?.targetSongId ?? "";
    let tracks = await tracksForIds(songIds);
    // 房间歌单可能上千首：整表解析失败或目标缺失时，退化为目标附近的窗口。
    // 否则这里会静默返回——用户看到的就是"进房什么都没发生"
    let fallbackWindow = false;
    if (targetId && !tracks.some((track) => track.id === targetId)) {
      tracks = await tracksForIds(windowAround(songIds, targetId, ADOPT_WINDOW));
      fallbackWindow = true;
    }
    if (tracks.length === 0) return;
    if (!command) {
      const currentId = useStatusStore().currentTrack?.id ?? "";
      let keep = tracks.findIndex((track) => track.id === currentId);
      // 本地曲目已不在共享队列里时落到队首。
      // 此时只改下标不加载是有意的：对方只是换了歌单、并没有发切歌命令，
      // 不该抢走本地正在放的那首；界面会短暂显示成队首，等对方下发命令即恢复
      if (keep < 0) keep = 0;
      // 入场采纳必须走 playFrom：只改 playIndex 不会触碰播放器，
      // 用户听到的仍是本地那首，直到对端下发新的播放命令才同步
      if (playOnEntry) {
        pendingLoad = true;
        try {
          await player.playFrom(tracks, keep, TOGETHER_CONTEXT, true);
        } finally {
          pendingLoad = false;
        }
        reapplyLocalShuffle();
        return;
      }
      queue.setQueue(tracks, TOGETHER_CONTEXT);
      useStatusStore().playIndex = keep;
      reapplyLocalShuffle();
      return;
    }
    // 播放模式命令只改模式，不触碰播放器
    if (command.type === "PLAYMODE_CHANGE") return;
    let index = tracks.findIndex((track) => track.id === command.targetSongId);
    if (index < 0) return;
    if (fallbackWindow) {
      // 窗口只是定位目标用的兜底，写回本地会被下一轮整表上报当成房间歌单、
      // 把上千首截断成 200 首。改成在本地队列里就地定位，没有就插这一首
      const target = tracks[index];
      const found = queue.findTrackIndex(target.id);
      const at = found >= 0 ? found : player.insertToQueue(target, undefined, TOGETHER_CONTEXT);
      if (at < 0) return;
      tracks = queue.queue.value;
      index = at;
    }
    // 纯时间轴命令：只对齐曲目与进度，不改播放态
    if (command.type === "PROGRESS") {
      // 换曲前先记下本地是否在播：PROGRESS 的 playing 恒为 false，
      // 用它当 autoPlay 会让正在播放的一方被静音
      const wasPlaying = useStatusStore().isPlaying;
      pendingLoad = true;
      try {
        if (useStatusStore().currentTrack?.id !== command.targetSongId) {
          await player.playFrom(tracks, index, TOGETHER_CONTEXT, playOnEntry || wasPlaying);
          reapplyLocalShuffle();
        }
        await player.seek(command.progressMs);
        if (playOnEntry) await player.play();
      } finally {
        pendingLoad = false;
      }
      return;
    }
    // 入场采纳：加载 → 定位到房间进度 → 按房间播放态起播。
    // 直接 playFrom(autoPlay) 会把 GOTO 携带的 progressMs 丢掉，导致从头播
    if (initial) {
      pendingLoad = true;
      try {
        await player.playFrom(tracks, index, TOGETHER_CONTEXT, false);
        if (command.progressMs > 0) await player.seek(command.progressMs);
        if (command.playing) await player.play();
      } finally {
        pendingLoad = false;
      }
      reapplyLocalShuffle();
      return;
    }
    pendingLoad = true;
    try {
      await player.playFrom(tracks, index, TOGETHER_CONTEXT, true);
    } finally {
      pendingLoad = false;
    }
    reapplyLocalShuffle();
    if (!command.playing) await player.pause();
    return;
  }
  if (!command || command.type === "PLAYMODE_CHANGE") return;
  if (!command.targetSongId) return;
  const list = queue.originalQueue.value
    ? queue.originalQueue.value.map((entry) => entry.track)
    : queue.queue.value;
  const index = list.findIndex((item) => item.id === command.targetSongId);
  if (index < 0) return;
  pendingLoad = true;
  try {
    await respondCommand(command, index, list);
  } finally {
    pendingLoad = false;
  }
};

const applyPlayMode = (mode: string): void => {
  if (mode === "RANDOM") {
    player.setRepeatMode("list", true);
    player.setShuffleMode("on", true);
    return;
  }
  if (mode === "SINGLE_LOOP") {
    player.setShuffleMode("off", true);
    player.setRepeatMode("one", true);
    return;
  }
  if (mode === "ORDER_LOOP") {
    player.setShuffleMode("off", true);
    player.setRepeatMode("list", true);
  }
};

const commandToast = (command: TogetherCommand): string => {
  if (command.type === "PLAYMODE_CHANGE") return "对方更改了播放模式";
  if (command.type === "PROGRESS") return "对方调整了播放进度";
  if (command.type === "PLAY") return "对方开始播放";
  if (command.type === "PAUSE") return "对方暂停了播放";
  return "对方切换了歌曲";
};

const handleEvent = async (next: TogetherSyncEvent): Promise<void> => {
  if (next.type === "session") {
    setTogetherCounting(true);
    startReporting();
    pushState();
    return;
  }
  if (next.type === "session-end") {
    setTogetherCounting(false);
    stopReporting();
    // 必须复位：否则第二次遇到"双人房被升级为多人"就不切协议，
    // 双人轮询会继续跑在多人房上，把房间队列反复覆盖
    switchedToMulti = false;
    // 同理复位跳过提示：同一份队列再进一次房间时应当重新提醒
    unshareableSignature = "";
    if (next.reason !== "left") toast.warning("一起听已结束");
    return;
  }
  if (next.type === "error") {
    toast.warning(`一起听同步失败：${next.message}`);
    return;
  }
  if (next.type === "advance") {
    await player.nextTrack();
    return;
  }
  if (next.type === "room") {
    const names = next.room.members.map((member) => member.nickname || member.userId).join("、");
    if (names) toast.info(`一起听：${names}`);
    // 服务端在第二个人加入时会把双人房自动转成多人房。
    // 房型一变就得换成多人那套协议（心跳是拉取、歌曲来自响应），
    // 否则双人轮询会继续按旧协议跑，队列会被反复覆盖
    if (isMultiRoomType(next.room.roomType)) void switchToMultiProtocol();
    return;
  }
  if (next.playMode) applyPlayMode(next.playMode);
  await applyRemote(next.songIds, next.command, next.initial, next.autoPlay);
  if (next.command && !next.initial) toast.info(commandToast(next.command));
};

let switchedToMulti = false;

const switchToMultiProtocol = async (): Promise<void> => {
  if (switchedToMulti) return;
  switchedToMulti = true;
  toast.success("房间已升级为多人一起听");
  // 不能先 leave：那会发 multi/match/exit 把刚升级的房间退掉。
  // 直接让多人侧接管同一个房间，再把双人侧停掉
  const userId = String(useTogetherStore().session?.userId ?? "");
  await restoreTogetherMulti(userId);
  await window.api.together.leave();
};

const startReporting = (): void => {
  if (reportTimer) return;
  pushState();
  reportTimer = setInterval(pushState, REPORT_INTERVAL_MS);
};

const stopReporting = (): void => {
  if (!reportTimer) return;
  clearInterval(reportTimer);
  reportTimer = null;
};

/**
 * 是否处于一起听中（双人或多人）。
 *
 * 播放器靠它决定"本曲播完要不要自动下一首"：房间里推进权属于服务端，
 * 本地自己往下播会先切到无关的歌，等下一轮心跳再被拉回房间的歌——
 * 表现出来就是"莫名其妙切歌"。所以两种房型都必须拦住本地推进
 */
export const isTogetherActive = (): boolean =>
  useTogetherStore().inRoom || useTogetherMultiStore().inRoom;

export { countTogetherAction, setTogetherCounting } from "@/services/togetherCounter";

let eventChain: Promise<void> = Promise.resolve();

export const initTogether = (): void => {
  unsubscribe?.();
  unsubscribe = window.api.together.onEvent((next) => {
    useTogetherStore().apply(next);
    eventChain = eventChain.then(() => handleEvent(next)).catch(() => {});
  });
  void window.api.together.getSession().then((session) => {
    if (!session) return;
    setTogetherCounting(true);
    startReporting();
  });
};

export const createRoom = async (userId: string): Promise<boolean> => {
  beginBusy();
  try {
    await window.api.together.create(userId);
    return true;
  } catch (error) {
    toast.error(error instanceof Error ? error.message : String(error));
    return false;
  } finally {
    endBusy();
  }
};

export const joinRoom = async (input: string, userId: string): Promise<boolean> => {
  let parsed = parseInvitation(input);
  if (!parsed.invitation && parsed.link) {
    try {
      parsed = parseInvitation(await window.api.together.resolveLink(parsed.link));
    } catch {
      toast.error("邀请链接无法打开，请检查网络后重试");
      return false;
    }
  }
  if (!parsed.invitation) {
    toast.error(parsed.error || "邀请链接里没有房间信息");
    return false;
  }
  beginBusy();
  try {
    await window.api.together.join(parsed.invitation.roomId, parsed.invitation.inviterId, userId);
    return true;
  } catch (error) {
    toast.error(error instanceof Error ? error.message : String(error));
    return false;
  } finally {
    endBusy();
  }
};

export const loadInvites = async (): Promise<TogetherInviteCard[]> => {
  try {
    return await window.api.together.pendingInvites();
  } catch {
    return [];
  }
};

const inviteJoin = async (roomId: string, inviterId: string, userId: string): Promise<boolean> => {
  beginBusy();
  try {
    await window.api.together.join(roomId, inviterId, userId);
    return true;
  } catch (error) {
    toast.error(error instanceof Error ? error.message : String(error));
    return false;
  } finally {
    endBusy();
  }
};

export const acceptInvite = async (card: TogetherInviteCard, userId: string): Promise<boolean> =>
  inviteJoin(card.roomId, card.inviterId, userId);

/** 拒绝邀请：服务端不再把它算作待处理，本地也立刻移出列表 */
export const rejectInvite = async (roomId: string): Promise<void> => {
  try {
    await window.api.together.rejectInvitation(roomId);
  } catch (error) {
    toast.error(error instanceof Error ? error.message : String(error));
  }
};

export const loadFriends = async (userId: string): Promise<TogetherFriend[]> => {
  try {
    return await window.api.together.friends(userId);
  } catch (error) {
    toast.error(error instanceof Error ? error.message : String(error));
    return [];
  }
};

export const inviteFriend = async (friend: TogetherFriend): Promise<boolean> => {
  try {
    await window.api.together.invite(friend.userId);
    useTogetherStore().markInvited(friend.userId, useTogetherStore().session?.roomId);
    toast.success(`已邀请 ${friend.nickname || friend.userId}`);
    return true;
  } catch (error) {
    toast.error(error instanceof Error ? error.message : String(error));
    return false;
  }
};

export const leaveRoom = async (): Promise<void> => {
  beginBusy();
  try {
    await window.api.together.leave();
  } catch (error) {
    toast.error(error instanceof Error ? error.message : String(error));
  } finally {
    endBusy();
  }
};

export const restoreRoom = async (userId: string): Promise<void> => {
  const store = useTogetherStore();
  if (store.inRoom) return;
  try {
    await window.api.together.restore(userId);
  } catch {}
};

export const invitationOf = (): string => {
  const store = useTogetherStore();
  if (!store.session) return "";
  return buildInvitation(store.session.roomId, store.session.userId);
};
