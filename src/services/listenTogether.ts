import { watch } from "vue";
import { useTogetherStore } from "@/stores/together";
import { skipUnshareableCurrent } from "@/services/togetherPlayback";
import { useTogetherMultiStore } from "@/stores/togetherMulti";
import { useStatusStore } from "@/stores/status";
import { useUserStore } from "@/stores/user";
import * as queue from "@/stores/queue";
import { restoreTogetherMulti } from "@/services/listenTogetherMulti";
import { isMultiRoomType, isTogetherShareable } from "@shared/utils/togetherRoom";
import * as player from "@/core/player";
import { getCurrentTime } from "@/services/playback";
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
  // 官方播放列表上限 999 首：超出的部分服务端拒收整条上报
  const songIds = shareableTrack
    ? trackList
        .filter(isTogetherShareable)
        .slice(0, 999)
        .map((item) => item.id)
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
  void skipUnshareableCurrent();
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

/** 只向前对齐的阈值：落后这么多才追，超前一律不动 */
const FORWARD_SEEK_THRESHOLD_MS = 5000;
/** 与房间进度相差超过这个毫秒数才纠正：太小会不停 seek，反而听感抖动 */
const PROGRESS_TOLERANCE_MS = 3000;

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
  // 进度只向前对齐：对方/房间的进度若比本地靠后，说明那是一条旧指令，
  // 硬拉回去会把正在播放的歌曲倒带（听感上像"突然回到开头"）。
  // 落后超过阈值才追，且仅在播放中追
  const localMs = getCurrentTime();
  const targetMs = command.progressMs;
  const shouldSeek =
    Math.abs(localMs - targetMs) > PROGRESS_TOLERANCE_MS &&
    (seekOnly || targetMs - localMs > FORWARD_SEEK_THRESHOLD_MS);
  if (shouldSeek) await player.seek(targetMs);
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
    // 服务端在第二个人加入时会把双人房自动转成多人房。
    // 房型一变就得换成多人那套协议（心跳是拉取、歌曲来自响应），
    // 否则双人轮询会继续按旧协议跑，队列会被反复覆盖
    if (isMultiRoomType(next.room.roomType)) void switchToMultiProtocol();
    return;
  }
  if (next.playMode) applyPlayMode(next.playMode);
  await applyRemote(next.songIds, next.command, next.initial, next.autoPlay);
  // 拖动到 0 会以 PROGRESS 形式到达；只有 GOTO 且目标曲与本地不同才是真切歌，
  // 否则同一首重发会误报"对方切换了歌曲"
  if (
    next.command &&
    !next.initial &&
    !(
      next.command.type === "GOTO" &&
      next.command.targetSongId === useStatusStore().currentTrack?.id
    )
  ) {
    toast.info(commandToast(next.command));
  }
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
  // 只能本地脱离：leave() 会发 end/v2 把整个房间作废，
  // 用户刚被升级进来的新房会当场失效（实测之后多人心跳立刻 400）
  await window.api.together.detach();
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
  // 断网期间心跳会一直失败，但本地会话还在；网络恢复后必须自己重连一次，
  // 否则要等下一次心跳撞上服务端，期间队列与播放态都是旧的
  if (!onlineBound) {
    onlineBound = true;
    window.addEventListener("online", () => void reconnectTogether());
    // 本地操作即时上报：只靠 1 秒轮询的话，暂停/切歌要等下一轮才到对端，
    // 官方端是事件驱动的瞬时同步；watch 播放态与当前曲即可补齐
    watch(
      () => [useStatusStore().isPlaying, useStatusStore().currentTrack?.id],
      () => pushState(),
    );
  }
};

let onlineBound = false;

/**
 * 网络恢复后重新接上房间。
 *
 * 先清掉本地残留会话再重新 restore，否则主进程的 `if (session) return room`
 * 会让这次重连什么都不做。房间如果已经没了，服务端会说不在房里，
 * 此时保持安静地退出即可，不必弹错误——那是断网的正常后果
 */
const reconnectTogether = async (): Promise<void> => {
  const store = useTogetherStore();
  if (!store.session) return;
  const userId = String(store.session.userId ?? "");
  if (!userId) return;
  try {
    // detach 只清本地会话、不通知服务端：房间还是同一个，不该被我们结束
    await window.api.together.detach();
    await window.api.together.restore(userId, true);
  } catch {
    void 0;
  }
};

export const createRoom = async (userId: string): Promise<boolean> => {
  beginBusy();
  try {
    await window.api.together.create(userId);
    // 建房后自动起播：官方行为是创建即播放，否则对端进来听到的是静音
    const status = useStatusStore();
    if (status.currentTrack && !status.isPlaying) await player.play();
    return true;
  } catch (error) {
    toast.error(error instanceof Error ? error.message : String(error));
    return false;
  } finally {
    endBusy();
  }
};

/**
 * 展开并解析邀请链接。
 *
 * 网易的分享短链（如 163cn.tv）要跟随跳转才知道最终落在双人还是多人页面，
 * 所以"判断房型"和"取房间号"都必须用展开后的地址
 */
export interface ResolvedInvitation {
  roomId: string;
  inviterId: string;
  /** 展开后的地址：判断是双人还是多人房必须用它，短链的原始形态看不出来 */
  link: string;
}

export const resolveInvitation = async (input: string): Promise<ResolvedInvitation | null> => {
  let parsed = parseInvitation(input);
  let link = input;
  if (!parsed.invitation && parsed.link) {
    link = await window.api.together.resolveLink(parsed.link);
    parsed = parseInvitation(link);
  }
  if (!parsed.invitation) return null;
  return { ...parsed.invitation, link };
};

/** 按房间号加入双人房。链接已经解析过时用它，避免再走一次网络展开 */
export const joinRoomById = async (
  roomId: string,
  inviterId: string,
  userId: string,
): Promise<boolean> => {
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

export const joinRoom = async (input: string, userId: string): Promise<boolean> => {
  let resolved: ResolvedInvitation | null = null;
  try {
    resolved = await resolveInvitation(input);
  } catch {
    toast.error("邀请链接无法打开，请检查网络后重试");
    return false;
  }
  if (!resolved) {
    toast.error("邀请链接里没有房间信息");
    return false;
  }
  return joinRoomById(resolved.roomId, resolved.inviterId, userId);
};

/**
 * 取待处理邀请。
 *
 * 优先用官方的 invitation-info/get：它是服务端的权威回答（还会带房型自动升级标记），
 * 私信扫描作为兜底——它能补出邀请人的昵称与头像，而那个端点只有 id
 */
/**
 * 后台监视邀请：周期拉收件箱，出现新邀请就弹 toast。
 *
 * 收件箱本来只在打开一起听面板时拉一次，用户不主动开面板就永远不知道
 * 被邀请了。这里常驻轮询；登录/登出切换账号时由调用方重启
 */
const INVITE_POLL_MS = 30_000;
let inviteTimer: ReturnType<typeof setInterval> | null = null;
let knownInviteRooms = new Set<string>();
let inviteWatchStarted = false;

export const watchInvites = (): void => {
  if (inviteWatchStarted) return;
  inviteWatchStarted = true;
  // 启动时先把现有邀请记为"已知"，避免每次登录都对旧邀请弹一遍提示
  void loadInvites().then((cards) => {
    knownInviteRooms = new Set(cards.map((card) => card.roomId));
  });
  inviteTimer = setInterval(() => void pollInvites(), INVITE_POLL_MS);
};

export const stopWatchInvites = (): void => {
  if (inviteTimer) clearInterval(inviteTimer);
  inviteTimer = null;
  inviteWatchStarted = false;
  knownInviteRooms = new Set();
};

const pollInvites = async (): Promise<void> => {
  const cards = await loadInvites().catch(() => [] as TogetherInviteCard[]);
  const fresh = cards.filter((card) => !knownInviteRooms.has(card.roomId));
  if (!fresh.length) return;
  for (const card of fresh) {
    // 服务端对同一房间的邀请可能重复下发，弹过就不再弹
    knownInviteRooms.add(card.roomId);
    const who = card.inviterName || "好友";
    toast.info(`${who} 邀请你一起听${card.multi ? "（多人房）" : ""}`);
  }
};

export const loadInvites = async (): Promise<TogetherInviteCard[]> => {
  const selfId = String(useUserStore().profile?.userId ?? "");
  // 收件箱是"会话列表"，把用户自己发出去的邀请也算在里面。
  // 不过滤掉的话，邀请完好友会在自己的待处理列表里看到自己那条
  const all = await window.api.together.pendingInvites().catch(() => []);
  const fromInbox = selfId ? all.filter((card) => card.fromUserId !== selfId) : all;
  // 官方端点是权威回答，但它只有邀请人 id；私信扫描能补出昵称与头像。
  // 两者合并而不是二选一：任一来源都可能先一步看到邀请
  const official = await window.api.together.fetchInvitation().catch(() => null);
  if (!official?.display || !official.roomId) return fromInbox;
  if (fromInbox.some((card) => card.roomId === official.roomId)) return fromInbox;
  return [
    {
      // 来自官方端点，必然不是自己发的
      fromUserId: "",
      roomId: official.roomId,
      inviterId: official.inviterId,
      inviterName: official.nickname,
      inviterAvatarUrl: official.avatarUrl,
      title: "",
      receivedAt: Date.now(),
      // 官方标记"房型已被服务端自动升级"，接收时要按多人协议加入
      multi: official.hadAutoChangeMulti,
    },
    ...fromInbox,
  ];
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

/**
 * 拉取并进入服务端仍在的房间。
 *
 * entering=true 表示"用户刚匹配/刚加入进来"，此时要跟随房间的播放态与进度；
 * false 是"重启后恢复"，保持本地原状态、不抢播放。两者语义相反，
 * 匹配进来必须传 true，否则进来后停在暂停、进度也不同步
 */
export const restoreRoom = async (userId: string, entering = false): Promise<void> => {
  const store = useTogetherStore();
  if (store.inRoom) return;
  try {
    await window.api.together.restore(userId, entering);
  } catch {}
};

/**
 * 多设备接管。
 *
 * 同一账号在另一台设备进房时，服务端会在 restore/reconnect/info 里给出房间与设备名；
 * 此时提示用户接管（确认后告知服务端），把房间接回当前设备。
 * 没有重连需求时服务端返回空对象，这里静默返回
 */
export const checkDeviceReconnect = async (): Promise<void> => {
  try {
    const info = await window.api.together.fetchReconnectInfo();
    if (!info?.roomId || !info.canReconnect) return;
    if (!info.needConfirm) {
      // 服务端说不用确认就直接接管：用户开着多设备自动接管
      await window.api.together.notifyDeviceReconnect(info.roomId);
      return;
    }
    const who = info.deviceName || "另一台设备";
    const ok = window.confirm(`你的账号在${who}上正在一起听，是否接管到本设备？`);
    if (ok) await window.api.together.notifyDeviceReconnect(info.roomId);
  } catch {
    void 0;
  }
};

export const invitationOf = (): string => {
  const store = useTogetherStore();
  if (!store.session) return "";
  return buildInvitation(store.session.roomId, store.session.userId);
};
