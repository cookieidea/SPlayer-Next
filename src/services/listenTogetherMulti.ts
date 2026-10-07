import { useTogetherMultiStore } from "@/stores/togetherMulti";
import { restoreRoom } from "@/services/listenTogether";
import { useStatusStore } from "@/stores/status";
import { getCurrentTime } from "@/services/playback";
import { useMediaStore } from "@/stores/media";
import * as queue from "@/stores/queue";
import * as player from "@/core/player";
import { songsByIds } from "@/apis/song/netease";
import { toast } from "@/composables/useToast";
import { buildMultiInvitation, parseInvitation } from "@shared/utils/togetherInvitation";
import { isTogetherShareable } from "@shared/utils/togetherRoom";
import type { TogetherMultiRoom } from "@shared/types/listenTogether";
import type { Track } from "@shared/types/player";

const MULTI_CONTEXT = { originId: "listen-together-multi", originType: "page" as const };

let unsubscribe: (() => void) | null = null;

// 跟随房间换曲后不能再把这次变化回报给房间，否则两端互相切歌。
// 按「房间设的那首」逐值抑制，而不是开时间窗：时间窗会把用户随后的真实切歌一起吞掉
let roomQueueKey = "";

const resolveTracks = async (ids: string[]): Promise<Track[]> => {
  const known = new Map<string, Track>();
  for (const item of queue.queue.value) {
    if (item.source === "netease" && !known.has(item.id)) known.set(item.id, item);
  }
  const missing = ids.filter((id) => !known.has(id));
  if (missing.length > 0) {
    for (const track of await songsByIds(missing)) known.set(track.id, track);
  }
  return ids.map((id) => known.get(id)).filter((track): track is Track => track !== undefined);
};

/**
 * 房间队列取「当前曲 + 待播」这个窗口。
 * 曾经试过 room/songs/list，但它属于 VIP 礼物那套，songIds 实测恒为 null，
 * 而全量历史还会让"播完可重新加入"的判定卡死，因此不再使用。
 * 按签名去重，避免 8 秒心跳反复拉曲目详情
 */
const syncRoomQueue = async (room: TogetherMultiRoom): Promise<void> => {
  const ids = [
    ...(room.playSong ? [room.playSong.songId] : []),
    ...room.nextSongs.map((song) => song.songId),
  ].filter(Boolean);
  const signature = ids.join(",");
  if (signature === roomQueueKey) return;
  roomQueueKey = signature;
  const store = useTogetherMultiStore();
  store.queueTracks = await resolveTracks(ids);
};

/**
 * 跟随房间当前曲目。多人群房的队列只是「当前曲 + 接下来几首」的短窗口，
 * 拿它替换本地歌单会把用户的列表顶掉，所以只处理房间那一首：
 * 本地已有就地播放（不动列表顺序），没有才插进去
 */
/** 与房间进度相差超过这个毫秒数才纠正：太小会不停 seek，反而听感抖动 */
const PROGRESS_TOLERANCE_MS = 3000;

/** 房间当前曲应处的进度：起播时刻 + 已播时长 */
const roomPositionMs = (room: TogetherMultiRoom): number => {
  if (!room.playStartTime) return -1;
  return Math.max(0, Date.now() - room.playStartTime);
};

const followRoom = async (room: TogetherMultiRoom): Promise<void> => {
  const roomSongId = room.playSong?.songId ?? "";
  if (!roomSongId) return;
  if (String(useMediaStore().track?.id ?? "") !== roomSongId) {
    const [track] = await resolveTracks([roomSongId]);
    if (!track) return;
    let at = queue.findTrackIndex(roomSongId);
    if (at < 0) at = player.insertToQueue(track, undefined, MULTI_CONTEXT);
    if (at < 0) return;
    // playAtIndex 在同下标时只做恢复播放、不会重新加载，这种情况下强制走一次加载
    if (useStatusStore().playIndex === at) {
      await player.playFrom(queue.queue.value, at, MULTI_CONTEXT, true);
    } else {
      await player.playAtIndex(at);
    }
  }
  // 同一首歌也要对齐进度：房间的进度是权威的（多人一起听里暂停/播放是同步的）
  const target = roomPositionMs(room);
  if (target < 0) return;
  const current = getCurrentTime();
  if (Math.abs(current - target) > PROGRESS_TOLERANCE_MS) {
    await player.seek(target);
  }
};

const handleEvent = (): void => {
  const store = useTogetherMultiStore();
  if (!unsubscribe) {
    unsubscribe = window.api.togetherMulti.onEvent((event) => {
      store.apply(event);
      if (event.type === "room") {
        void followRoom(event.room);
        void syncRoomQueue(event.room);
      }
      if (event.type === "session-end" && event.reason !== "left") {
        // 自己退出不用提示；房间被服务端结束（过期/被移出）必须说一声，
        // 否则界面会"莫名其妙"退回普通状态
        toast.warning("一起听房间已结束");
      }
      if (event.type === "error") toast.error(event.message);
    });
  }
};

export const initTogetherMulti = (): void => {
  handleEvent();
};

const withBusy = async <T>(run: () => Promise<T>): Promise<T | null> => {
  const store = useTogetherMultiStore();
  store.busy = true;
  try {
    return await run();
  } catch (error) {
    toast.error(error instanceof Error ? error.message : String(error));
    return null;
  } finally {
    store.busy = false;
  }
};

export const joinTogetherMulti = (input: string, userId: string): Promise<unknown> =>
  withBusy(async () => {
    const parsed = parseInvitation(input);
    if (!parsed.invitation) throw new Error(parsed.error || "邀请链接无效");
    const room = await window.api.togetherMulti.join(
      parsed.invitation.roomId,
      parsed.invitation.inviterId,
      userId,
    );
    roomQueueKey = "";
    await followRoom(room);
    await syncRoomQueue(room);
    return room;
  });

/** 开始陌生人匹配。匹配成功后轮询 status/get 进房 */
const MATCH_POLL_MS = 3000;

let matchTimer: ReturnType<typeof setInterval> | null = null;

const stopMatchPoll = (): void => {
  if (matchTimer) clearInterval(matchTimer);
  matchTimer = null;
};

/**
 * 匹配成功后服务端会把账号直接放进房间，本地要自己发现并跟上。
 * 匹配房（roomType=MATCH_SONG）走的是双人协议——实测它的 heartbeat/sync 都按双人那套，
 * 所以这里用双人的 restore，而不是多人那套
 */
const MATCH_POLL_MAX = 60;

let matchPollCount = 0;

const pollMatch = async (userId: string): Promise<void> => {
  try {
    // 匹配窗口最长 60 秒，超时后停止轮询，避免一直占用
    if (++matchPollCount > MATCH_POLL_MAX) {
      stopMatchPoll();
      toast.warning("没有找到合适的听友，请稍后重试");
      return;
    }
    const session = await window.api.together.getSession();
    if (!session) return;
    // 匹配到就必须通知服务端结束匹配，否则账号会一直挂在匹配队列里
    stopMatchPoll();
    toast.success("已找到听友");
    try {
      await window.api.togetherMulti.cancelMatch();
    } catch {
      void 0;
    }
    await restoreRoom(userId);
  } catch {
    stopMatchPoll();
  }
};

export const startStrangerMatch = (userId: string): Promise<unknown> =>
  withBusy(async () => {
    const result = await window.api.togetherMulti.startMatch();
    toast.info("正在为你寻找听友…");
    stopMatchPoll();
    matchPollCount = 0;
    matchTimer = setInterval(() => void pollMatch(userId), MATCH_POLL_MS);
    return result;
  });

/**
 * 多人匹配。30 秒窗口，匹配成功后服务端把账号放进房间；
 * 本地轮询 status/get（双人接口能看出是否已进房）来发现结果
 */
export const startMultiMatch = (songId: string): Promise<unknown> =>
  withBusy(async () => {
    const result = await window.api.togetherMulti.startMultiMatch(songId);
    toast.info("正在为你寻找听友…");
    stopMatchPoll();
    matchPollCount = 0;
    matchTimer = setInterval(() => void pollMultiMatch(), MATCH_POLL_MS);
    return result;
  });

export const cancelMultiMatch = (): Promise<void> =>
  withBusy(async () => {
    stopMatchPoll();
    await window.api.togetherMulti.cancelMultiMatch();
  }).then(() => undefined);

const pollMultiMatch = async (): Promise<void> => {
  try {
    if (++matchPollCount > MATCH_POLL_MAX) {
      stopMatchPoll();
      toast.warning("没有找到合适的听友，请稍后重试");
      return;
    }
    const session = await window.api.together.getSession();
    if (!session) return;
    stopMatchPoll();
    toast.success("已找到听友");
    try {
      await window.api.togetherMulti.cancelMultiMatch();
    } catch {
      void 0;
    }
    await restoreTogetherMulti(String(session.userId));
  } catch {
    stopMatchPoll();
  }
};

export const cancelStrangerMatch = (): Promise<void> =>
  withBusy(async () => {
    stopMatchPoll();
    await window.api.togetherMulti.cancelMatch();
  }).then(() => undefined);

/**
 * 本曲播完时立刻拉一次心跳：房间的下一首由服务端决定，
 * 不主动拉就要等 8 秒周期，中间是一段静音
 */
export const refreshTogetherMulti = async (): Promise<void> => {
  if (!useTogetherMultiStore().inRoom) return;
  try {
    await window.api.togetherMulti.refresh();
  } catch {
    void 0;
  }
};

/** 账号对陌生人的可见性：开着才会被陌生人匹配到 */
export const getStrangerVisible = (): Promise<boolean> =>
  window.api.togetherMulti.getStrangerVisible().catch(() => false);

export const setStrangerVisible = (visible: boolean): Promise<void> =>
  withBusy(async () => {
    await window.api.togetherMulti.setStrangerVisible(visible);
    toast.success(visible ? "已允许陌生人加入" : "已关闭陌生人加入");
  }).then(() => undefined);

/** 建房后最多把当前队列的这么多首带进房间：服务端待播窗口有限，加多也留不住 */
const ROOM_SEED_LIMIT = 30;

/**
 * 创建多人房。接口只接受一个"起播歌"，队列不会被带进去
 * （实测 nextSongIds / playlistIds 都被忽略），因此建完房再把当前队列逐首加进去
 */
export const createMultiRoom = (userId: string): Promise<unknown> =>
  withBusy(async () => {
    const current = useStatusStore().currentTrack;
    if (!current) throw new Error("请先播放一首歌再创建多人房");
    // 云盘与本地音乐做不了房间的起播曲，对方放不出来
    if (!isTogetherShareable(current)) {
      throw new Error("当前是本地或云盘音乐，请先播放一首在线歌曲再创建多人房");
    }
    const songId = String(current.id);
    const room = await window.api.togetherMulti.createRoom(songId, userId);
    roomQueueKey = "";
    await followRoom(room);
    // 建房后必须起播：多人一起听里播放态由房间决定，停在暂停态等同于"房间没声音"
    if (!useStatusStore().isPlaying) await player.play();
    await seedRoomQueue(songId);
    await syncRoomQueue(room);
    return room;
  });

/** 把当前队列带进新房。起播歌已在房间里，跳过它避免重复推荐 */
const seedRoomQueue = async (startSongId: string): Promise<void> => {
  const entries = queue.originalQueue.value ?? queue.queue.value;
  const ids = entries
    .map((entry) => entry.track)
    .filter((item): item is Track => Boolean(item?.id) && isTogetherShareable(item))
    .map((item) => item.id)
    .filter((id) => id !== startSongId)
    .slice(0, ROOM_SEED_LIMIT);
  for (const id of ids) {
    try {
      await window.api.togetherMulti.addSong(id, 0);
    } catch {
      void 0;
    }
  }
};

/** 多人房站内邀请好友 */
export const inviteMultiFriends = (uids: readonly string[]): Promise<boolean> =>
  withBusy(async () => {
    if (uids.length === 0) return false;
    try {
      await window.api.togetherMulti.inviteFriends([...uids]);
      toast.success(`已邀请 ${uids.length} 位好友`);
      return true;
    } catch (error) {
      toast.error(error instanceof Error ? error.message : String(error));
      return false;
    }
  }).then((value) => value === true);

export const leaveTogetherMulti = (): Promise<void> =>
  withBusy(async () => {
    roomQueueKey = "";
    await window.api.togetherMulti.leave();
  }).then(() => undefined);

export const restoreTogetherMulti = (userId: string): Promise<unknown> =>
  withBusy(async () => {
    const room = await window.api.togetherMulti.restore(userId);
    if (room) {
      roomQueueKey = "";
      await followRoom(room);
      await syncRoomQueue(room);
    }
    return room;
  });

export const addMultiSong = (track: Track): Promise<void> =>
  withBusy(async () => {
    // 单一入口处拦掉对方放不了的曲子：本地文件与云盘歌曲都不该进房间
    if (!isTogetherShareable(track)) {
      toast.warning("本地音乐和云盘歌曲对方拿不到，无法加入房间");
      return;
    }
    const { message, rejected } = await window.api.togetherMulti.addSong(track.id, 0);
    if (rejected) toast.warning(message || "这首歌暂时加不进房间");
    else toast.success(message || "已加入一起听队列");
  }).then(() => undefined);

/** 投票切歌：人数够时服务端直接切走，不够时记一票 */
export const voteSkipMultiSong = (): Promise<void> =>
  withBusy(async () => {
    const room = useTogetherMultiStore().room;
    const song = room?.playSong;
    if (!song) {
      toast.warning("房间里还没有歌曲");
      return;
    }
    // 投票可能是「直接切走」也可能是「记了一票」，必须把服务端文案透出来，
    // 否则用户点了 ⏭ 毫无反馈，不知道这一票有没有生效
    const { message, rejected } = await window.api.togetherMulti.voteSkip(
      song.songId,
      song.songBizId,
    );
    // 被拒时用警告色：用户需要知道"这一票没生效"以及为什么
    if (rejected) toast.warning(message || "投票切歌失败");
    else if (message) toast.info(message);
  }).then(() => undefined);

export const removeMultiSong = (songId: string): Promise<void> =>
  withBusy(async () => {
    // 删除要带房间里的 songBizId：实测它是服务端定位歌曲的凭据，
    // 曲目菜单只拿得到 songId，所以在这里从房间歌曲里查
    const room = useTogetherMultiStore().room;
    const songs = [...(room?.playSong ? [room.playSong] : []), ...(room?.nextSongs ?? [])];
    const song = songs.find((item) => item.songId === songId);
    const { message, rejected } = await window.api.togetherMulti.removeSong(
      songId,
      song?.songBizId ?? 0,
    );
    if (rejected) toast.warning(message || "这首歌删不掉");
    else toast.success(message || "已从房间队列移除");
  }).then(() => undefined);

export const topMultiSong = (track: Track): Promise<void> =>
  withBusy(async () => {
    const { message, rejected } = await window.api.togetherMulti.topSong(track.id, 0);
    if (rejected) toast.warning(message || "置顶失败");
    else toast.success(message || "已置顶");
  }).then(() => undefined);

export const shareMultiInvitation = (roomId: string, inviterUid: string): string =>
  buildMultiInvitation(roomId, inviterUid);
