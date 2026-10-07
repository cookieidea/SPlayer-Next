import { useTogetherMultiStore } from "@/stores/togetherMulti";
import { restoreRoom } from "@/services/listenTogether";
import { useStatusStore } from "@/stores/status";
import { useMediaStore } from "@/stores/media";
import * as queue from "@/stores/queue";
import * as player from "@/core/player";
import { songsByIds } from "@/apis/song/netease";
import { toast } from "@/composables/useToast";
import { buildMultiInvitation, parseInvitation } from "@shared/utils/togetherInvitation";
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
 * 房间队列。优先用 room/songs/list 的完整歌单（实测返回全部歌曲 + 各自是谁加的），
 * 失败时退回心跳里的 playSong+nextSongs 短窗口。按签名去重，避免心跳反复拉曲目详情
 */
const syncRoomQueue = async (room: TogetherMultiRoom): Promise<void> => {
  let ids = [
    ...(room.playSong ? [room.playSong.songId] : []),
    ...room.nextSongs.map((song) => song.songId),
  ].filter(Boolean);
  try {
    const full = await window.api.togetherMulti.roomSongs();
    if (full.songIds.length > 0) ids = full.songIds;
  } catch {
    void 0;
  }
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
const followRoom = async (room: TogetherMultiRoom): Promise<void> => {
  const roomSongId = room.playSong?.songId ?? "";
  if (!roomSongId) return;
  if (String(useMediaStore().track?.id ?? "") === roomSongId) return;
  const [track] = await resolveTracks([roomSongId]);
  if (!track) return;

  let at = queue.findTrackIndex(roomSongId);
  if (at < 0) at = player.insertToQueue(track, undefined, MULTI_CONTEXT);
  if (at < 0) return;
  // playAtIndex 在同下标时只做恢复播放、不会重新加载，这种情况下强制走一次加载
  if (useStatusStore().playIndex === at) {
    await player.playFrom(queue.queue.value, at, MULTI_CONTEXT, true);
    return;
  }
  await player.playAtIndex(at);
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
    const message = await window.api.togetherMulti.addSong(track.id, 0);
    toast.success(message || "已加入一起听队列");
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
    const message = await window.api.togetherMulti.voteSkip(song.songId, song.songBizId);
    if (message) toast.info(message);
  }).then(() => undefined);

export const removeMultiSong = (songId: string): Promise<void> =>
  withBusy(async () => {
    // 删除要带房间里的 songBizId：实测它是服务端定位歌曲的凭据，
    // 曲目菜单只拿得到 songId，所以在这里从房间歌曲里查
    const room = useTogetherMultiStore().room;
    const songs = [...(room?.playSong ? [room.playSong] : []), ...(room?.nextSongs ?? [])];
    const song = songs.find((item) => item.songId === songId);
    const message = await window.api.togetherMulti.removeSong(songId, song?.songBizId ?? 0);
    toast.success(message || "已从房间队列移除");
  }).then(() => undefined);

export const topMultiSong = (track: Track): Promise<void> =>
  withBusy(async () => {
    const message = await window.api.togetherMulti.topSong(track.id, 0);
    toast.success(message || "已置顶");
  }).then(() => undefined);

export const shareMultiInvitation = (roomId: string, inviterUid: string): string =>
  buildMultiInvitation(roomId, inviterUid);
