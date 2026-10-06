import { useTogetherStore } from "@/stores/together";
import { useStatusStore } from "@/stores/status";
import * as queue from "@/stores/queue";
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

const respondCommand = async (command: TogetherCommand, index: number): Promise<void> => {
  const status = useStatusStore();
  const seekOnly = command.type === "PROGRESS";
  if (status.currentTrack?.id !== command.targetSongId) {
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

const applyRemote = async (
  songIds: readonly string[],
  command: TogetherCommand | null,
  initial: boolean,
): Promise<void> => {
  if (songIds.length > 0) {
    const tracks = await tracksForIds(songIds);
    if (tracks.length === 0) return;
    if (!command) {
      const currentId = useStatusStore().currentTrack?.id ?? "";
      let keep = tracks.findIndex((track) => track.id === currentId);
      if (keep < 0) keep = 0;
      queue.setQueue(tracks, TOGETHER_CONTEXT);
      useStatusStore().playIndex = keep;
      return;
    }
    const index = tracks.findIndex((track) => track.id === command.targetSongId);
    if (index < 0) return;
    const seekOnly = command.type === "PROGRESS";
    const autoPlay = !seekOnly && (!initial || command.playing);
    pendingLoad = true;
    try {
      await player.playFrom(tracks, index, TOGETHER_CONTEXT, autoPlay);
    } finally {
      pendingLoad = false;
    }
    if (!autoPlay) return;
    if (!command.playing) await player.pause();
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

const commandToast = (command: TogetherCommand): string => {
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
    toast.warning("一起听已结束");
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

export const isTogetherActive = (): boolean => useTogetherStore().inRoom;

export const initTogether = (): void => {
  if (unsubscribe) return;
  unsubscribe = window.api.together.onEvent((next) => {
    useTogetherStore().apply(next);
    void handleEvent(next);
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
