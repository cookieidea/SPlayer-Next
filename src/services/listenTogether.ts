/**
 * 网易云「一起听」渲染端服务
 *
 * 主进程负责房间协议，这里负责需要播放器内部的另一半：把本地播放状态做成带动作
 * 计数器的观测值上报、打开会话时对齐共享队列、以及对端命令的播放响应。
 *
 * 上报的是「用户动作」而不是播放位置：位置每秒都在漂移，只有真正拖动进度、切歌、
 * 播放暂停、整曲播完才应该被当成一次需要同步的动作。
 */

import { useTogetherStore } from "@/stores/together";
import { useStatusStore } from "@/stores/status";
import * as queue from "@/stores/queue";
import * as player from "@/core/player";
import { songsByIds } from "@/apis/song/netease";
import { toast } from "@/composables/useToast";
import { readTogetherCounters } from "@/services/togetherCounter";
import { buildInvitation, parseInvitation } from "@shared/utils/togetherInvitation";
import type {
  TogetherCommand,
  TogetherFriend,
  TogetherInviteCard,
  TogetherLocalState,
  TogetherSyncEvent,
} from "@shared/types/listenTogether";
import type { Track } from "@shared/types/player";

/** 上报节拍（毫秒），与主进程轮询节奏一致 */
const REPORT_INTERVAL_MS = 1000;

/** 共享队列单次补齐的歌曲数上限 */
const QUEUE_FETCH_LIMIT = 500;

const TOGETHER_CONTEXT = {
  originId: "listen-together",
  originType: "page" as const,
  originName: "一起听",
};

let reportTimer: ReturnType<typeof setInterval> | null = null;
let unsubscribe: (() => void) | null = null;
/** 本地刚提交、等待引擎确认的加载 */
let pendingLoad = false;

/** 收集当前播放状态 */
const collectState = (): TogetherLocalState => {
  const status = useStatusStore();
  const track = status.currentTrack;
  const isNetease = track?.source === "netease" && !track.serverId;
  const counters = readTogetherCounters();
  return {
    songId: isNetease ? track.id : "",
    queueSongIds: isNetease
      ? queue.queue.value
          .filter((item) => item.source === "netease" && !item.serverId)
          .map((item) => item.id)
      : [],
    positionMs: Math.max(0, Math.round(status.position)),
    playing: status.isPlaying,
    transitioning: status.trackLoading || pendingLoad,
    seekRevision: counters.seekRevision,
    endRevision: counters.endRevision,
  };
};

const pushState = (): void => {
  if (!useTogetherStore().inRoom) return;
  window.api.together.sync(collectState());
};

/** 复用本地已有 Track，缺失的按 ID 批量补齐 */
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

/** 命令响应：队列里已有目标歌曲，只做播放动作 */
const respondCommand = async (command: TogetherCommand, index: number): Promise<void> => {
  const status = useStatusStore();
  // PROGRESS 只描述时间轴：对端拖动进度不该改变本机的播放态，
  // 也不该把暂停中的本机拉起来
  const seekOnly = command.type === "PROGRESS";
  if (status.playIndex !== index) {
    await player.playFrom(
      queue.queue.value,
      index,
      status.currentPlaybackContext,
      !seekOnly && command.playing,
    );
  }
  await player.seek(command.progressMs);
  if (seekOnly) return;
  if (command.playing) await player.play();
  else await player.pause();
};

/**
 * 应用对端状态
 * @param songIds - 需要整体替换的共享队列，空数组表示队列不变
 * @param command - 对端命令，仅队列变化时为 null
 * @param initial - 是否是进入房间后的首次对齐
 */
const applyRemote = async (
  songIds: readonly string[],
  command: TogetherCommand | null,
  initial: boolean,
): Promise<void> => {
  const targetId = command?.targetSongId || songIds[0] || "";
  if (songIds.length > 0) {
    const tracks = await tracksForIds(songIds);
    if (tracks.length === 0) return;
    const targetIndex = tracks.findIndex((track) => track.id === targetId);
    // 目标歌曲没取回详情（版权下架等）时宁可不动作，也不要顶替成队列第一首
    if (command && targetIndex < 0) return;
    const index = targetIndex < 0 ? 0 : targetIndex;
    // 进入房间时只对齐队列与曲目，播放态交给用户：恢复房间不等于要开始放音；
    // 明确带播放态的对端命令（切歌、播放、暂停）照做，纯进度命令则不动播放态
    const seekOnly = command?.type === "PROGRESS";
    const autoPlay = !seekOnly && (!initial || Boolean(command?.playing));
    pendingLoad = true;
    try {
      await player.playFrom(tracks, index, TOGETHER_CONTEXT, autoPlay);
    } finally {
      pendingLoad = false;
    }
    if (!autoPlay) return;
    if (command && !command.playing) await player.pause();
    return;
  }
  if (!command?.targetSongId) return;
  const index = queue.findTrackIndex(command.targetSongId);
  if (index < 0) return;
  pendingLoad = true;
  try {
    await respondCommand(command, index);
  } finally {
    pendingLoad = false;
  }
};

/** 对端命令提示文案 */
const commandToast = (command: TogetherCommand): string => {
  if (command.type === "PROGRESS") return "对方调整了播放进度";
  if (command.type === "PLAY") return "对方开始播放";
  if (command.type === "PAUSE") return "对方暂停了播放";
  return "对方切换了歌曲";
};

/**
 * 消费一次主进程下发的同步事件
 * @param next - 同步事件
 */
const handleEvent = async (next: TogetherSyncEvent): Promise<void> => {
  if (next.type === "session") {
    startReporting();
    pushState();
    return;
  }
  if (next.type === "session-end") {
    stopReporting();
    toast.warning("一起听已结束");
    return;
  }
  if (next.type === "error") {
    toast.warning(`一起听同步失败：${next.message}`);
    return;
  }
  // 自然播完后由推进权决定谁续播：轮到本机时直接进入下一首
  if (next.type === "advance") {
    await player.nextTrack();
    return;
  }
  if (next.type === "room") {
    const names = next.room.members.map((member) => member.nickname || member.userId).join("、");
    if (names) toast.info(`一起听：${names}`);
    return;
  }
  await applyRemote(next.songIds, next.command, next.initial);
  if (next.command && !next.initial) toast.info(commandToast(next.command));
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
 * 当前是否在房间内
 * @returns 在房间内时返回 true
 */
export const isTogetherActive = (): boolean => useTogetherStore().inRoom;

/** 订阅主进程事件，应用启动时调用一次 */
export const initTogether = (): void => {
  if (unsubscribe) return;
  unsubscribe = window.api.together.onEvent((next) => {
    useTogetherStore().apply(next);
    void handleEvent(next);
  });
  void window.api.together.getSession().then((session) => {
    // 主窗口刷新时房间仍在服务端，只有本地定时器需要重新起搏
    if (session) startReporting();
  });
};

/**
 * 创建房间
 * @param userId - 本机用户 ID
 * @returns 是否成功
 */
export const createRoom = async (userId: string): Promise<boolean> => {
  const store = useTogetherStore();
  store.busy = true;
  try {
    await window.api.together.create(userId);
    return true;
  } catch (error) {
    toast.error(error instanceof Error ? error.message : String(error));
    return false;
  } finally {
    store.busy = false;
  }
};

/**
 * 用邀请链接或房间 ID 加入房间
 * @param input - 用户粘贴的邀请内容
 * @param userId - 本机用户 ID
 * @returns 是否成功
 */
export const joinRoom = async (input: string, userId: string): Promise<boolean> => {
  const store = useTogetherStore();
  let parsed = parseInvitation(input);
  // 只有短链时跟一次跳转——官方 App 分享的文本里就是这种链接
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
  store.busy = true;
  try {
    await window.api.together.join(parsed.invitation.roomId, parsed.invitation.inviterId, userId);
    return true;
  } catch (error) {
    toast.error(error instanceof Error ? error.message : String(error));
    return false;
  } finally {
    store.busy = false;
  }
};

/**
 * 取未处理的一起听邀请
 *
 * 对方在网易云里点「邀请」后，房间 ID 只存在于他发来的私信卡片里；没有这一步，
 * 被邀请方就完全看不到任何可操作的东西。
 * @returns 邀请卡片列表，失败时为空数组
 */
export const loadInvites = async (): Promise<TogetherInviteCard[]> => {
  try {
    return await window.api.together.pendingInvites();
  } catch {
    // 收件箱读取失败不该打断面板，静默返回空列表
    return [];
  }
};

/** 复用加入流程：房间 ID 与邀请人已知，直接走 join */
const inviteJoin = async (roomId: string, inviterId: string, userId: string): Promise<boolean> => {
  const store = useTogetherStore();
  store.busy = true;
  try {
    await window.api.together.join(roomId, inviterId, userId);
    return true;
  } catch (error) {
    toast.error(error instanceof Error ? error.message : String(error));
    return false;
  } finally {
    store.busy = false;
  }
};

/**
 * 接受一条邀请
 * @param card - 邀请卡片
 * @param userId - 本机用户 ID
 * @returns 是否成功
 */
export const acceptInvite = async (card: TogetherInviteCard, userId: string): Promise<boolean> =>
  inviteJoin(card.roomId, card.inviterId, userId);

/**
 * 取可邀请的好友
 * @param userId - 本机用户 ID
 * @returns 好友列表，失败时为空数组
 */
export const loadFriends = async (userId: string): Promise<TogetherFriend[]> => {
  try {
    return await window.api.together.friends(userId);
  } catch (error) {
    toast.error(error instanceof Error ? error.message : String(error));
    return [];
  }
};

/**
 * 邀请指定好友进当前房间
 * @param friend - 好友条目
 * @returns 是否成功
 */
export const inviteFriend = async (friend: TogetherFriend): Promise<boolean> => {
  try {
    await window.api.together.invite(friend.userId);
    toast.success(`已邀请 ${friend.nickname || friend.userId}`);
    return true;
  } catch (error) {
    toast.error(error instanceof Error ? error.message : String(error));
    return false;
  }
};

/** 退出房间 */
export const leaveRoom = async (): Promise<void> => {
  const store = useTogetherStore();
  store.busy = true;
  try {
    await window.api.together.leave();
  } catch (error) {
    toast.error(error instanceof Error ? error.message : String(error));
  } finally {
    store.busy = false;
  }
};

/**
 * 恢复服务端上尚未结束的房间，登录后调用
 * @param userId - 本机用户 ID
 */
export const restoreRoom = async (userId: string): Promise<void> => {
  const store = useTogetherStore();
  if (store.inRoom) return;
  try {
    await window.api.together.restore(userId);
  } catch {
    // 没有可续的房间，或服务端不可达：静默处理，不打扰用户
  }
};

/** 当前房间的邀请链接 */
export const invitationOf = (): string => {
  const store = useTogetherStore();
  if (!store.session) return "";
  return buildInvitation(store.session.roomId, store.session.userId);
};
