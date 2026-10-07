import { useTogetherMultiStore } from "@/stores/togetherMulti";
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

/** 房间队列是「当前曲 + 接下来几首」的短窗口，按签名去重，避免 8 秒心跳重复拉曲目详情 */
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

/** 开始陌生人匹配。匹配成功后服务端会推信息，由 ackMatch 进房 */
const MATCH_POLL_MS = 3000;

let matchTimer: ReturnType<typeof setInterval> | null = null;

const stopMatchPoll = (): void => {
  if (matchTimer) clearInterval(matchTimer);
  matchTimer = null;
};

/**
 * 官方靠推送把匹配结果送到客户端，我们没有推送通道；
 * 实测 startMatch 可重复调用，匹配到房间时返回 existedRoomId，所以用轮询代替
 */
const pollMatch = async (userId: string): Promise<void> => {
  try {
    const result = await window.api.togetherMulti.startMatch();
    if (!result.roomId) return;
    stopMatchPoll();
    toast.success("已找到听友");
    await ackStrangerMatch(result.roomId, userId);
  } catch {
    stopMatchPoll();
  }
};

export const startStrangerMatch = (userId: string): Promise<unknown> =>
  withBusy(async () => {
    const result = await window.api.togetherMulti.startMatch();
    toast.info("正在为你寻找听友…");
    if (result.roomId) {
      await ackStrangerMatch(result.roomId, userId);
      return result;
    }
    stopMatchPoll();
    matchTimer = setInterval(() => void pollMatch(userId), MATCH_POLL_MS);
    return result;
  });

export const cancelStrangerMatch = (): Promise<void> =>
  withBusy(async () => {
    stopMatchPoll();
    await window.api.togetherMulti.cancelMatch();
  }).then(() => undefined);

export const ackStrangerMatch = (roomId: string, userId: string): Promise<unknown> =>
  withBusy(async () => {
    const room = await window.api.togetherMulti.ackMatch(roomId, userId);
    roomQueueKey = "";
    await followRoom(room);
    await syncRoomQueue(room);
    return room;
  });

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
    await window.api.togetherMulti.addSong(track.id, 0);
    toast.success("已加入一起听队列");
  }).then(() => undefined);

/** 投票切歌：人数够时服务端直接切走，不够时记一票 */
export const voteSkipMultiSong = (): Promise<void> =>
  withBusy(async () => {
    const room = useTogetherMultiStore().room;
    const song = room?.playSong;
    if (!song) return;
    await window.api.togetherMulti.voteSkip(song.songId, song.songBizId);
  }).then(() => undefined);

export const removeMultiSong = (songId: string): Promise<void> =>
  withBusy(async () => {
    await window.api.togetherMulti.removeSong(songId, 0);
    toast.success("已从房间队列移除");
  }).then(() => undefined);

export const topMultiSong = (track: Track): Promise<void> =>
  withBusy(async () => {
    await window.api.togetherMulti.topSong(track.id, 0);
    toast.success("已置顶");
  }).then(() => undefined);

export const shareMultiInvitation = (roomId: string, inviterUid: string): string =>
  buildMultiInvitation(roomId, inviterUid);
