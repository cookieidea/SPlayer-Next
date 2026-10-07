import { watch } from "vue";
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
let remoteSongId = "";

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

  remoteSongId = roomSongId;
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
      if (event.type === "room") void followRoom(event.room);
      if (event.type === "error") toast.error(event.message);
    });
  }
};

/** 跟随房间换曲不能再回报给房间；只有用户自己切到别的歌才上报 */
export const shouldReportLocalSong = (
  inRoom: boolean,
  songId: string,
  roomSongId: string,
): boolean => inRoom && Boolean(songId) && songId !== roomSongId;

/** 本地切歌后把房间切过去。不是用户点的动作，因此不占 busy、只在失败时报错 */
const switchMultiSong = async (songId: string): Promise<void> => {
  try {
    await window.api.togetherMulti.switchSong(songId, 0);
  } catch (error) {
    toast.error(error instanceof Error ? error.message : String(error));
  }
};

export const initTogetherMulti = (): void => {
  handleEvent();
  // 用户在本地主动切歌时把房间也切过去（参考实现同样上报 SONG_SWITCH）
  watch(
    () => useMediaStore().track?.id ?? "",
    (id) => {
      if (!shouldReportLocalSong(useTogetherMultiStore().inRoom, id, remoteSongId)) return;
      void switchMultiSong(id);
    },
  );
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
    await followRoom(room);
    return room;
  });

export const leaveTogetherMulti = (): Promise<void> =>
  withBusy(async () => {
    await window.api.togetherMulti.leave();
  }).then(() => undefined);

export const restoreTogetherMulti = (userId: string): Promise<unknown> =>
  withBusy(async () => {
    const room = await window.api.togetherMulti.restore(userId);
    if (room) await followRoom(room);
    return room;
  });

export const addMultiSong = (track: Track): Promise<void> =>
  withBusy(async () => {
    await window.api.togetherMulti.addSong(track.id, 0);
    toast.success("已加入一起听队列");
  }).then(() => undefined);

export const topMultiSong = (track: Track): Promise<void> =>
  withBusy(async () => {
    await window.api.togetherMulti.topSong(track.id, 0);
    toast.success("已置顶");
  }).then(() => undefined);

export const shareMultiInvitation = (roomId: string, inviterUid: string): string =>
  buildMultiInvitation(roomId, inviterUid);
