import { callNetease } from "@main/apis/netease";
import { neteaseLog } from "@main/utils/logger";
import { fetchWithProxy } from "@main/utils/proxy";
import {
  ADVANCE_HANDOVER_MS,
  HEARTBEAT_TICKS,
  SYNC_INTERVAL_MS,
  baselineOf,
  commandSignature,
  detectLocalChanges,
  isFreshCommand,
  needsQueueReplace,
  songIdsSignature,
  type LocalBaseline,
} from "@main/utils/togetherProtocol";
import {
  invitesFromInbox,
  joinableFromBody,
  obj,
  roomFromBody,
  snapshotFromBody,
  statusFromBody,
  str,
} from "@main/utils/togetherParse";
import type {
  TogetherCommand,
  TogetherFriend,
  TogetherInviteCard,
  TogetherLocalState,
  TogetherRoom,
  TogetherSession,
} from "@shared/types/listenTogether";

const ADOPT_CONFIRM_TICKS = 3;

const FRIENDS_LIMIT = 100;

const INBOX_LIMIT = 20;

type RoomMode = "create" | "join" | "restore";

interface TogetherCommandPayload {
  command: TogetherCommand | null;
  songIds: string[];
  playMode: string;
  initial: boolean;
}

type RoomListener = (room: TogetherRoom) => void;
type EndListener = (reason: "left" | "server" | "logout") => void;
type CommandListener = (payload: TogetherCommandPayload) => void;
type AdvanceListener = () => void;
type ErrorListener = (message: string) => void;

let session: TogetherSession | null = null;
let room: TogetherRoom | null = null;
let roomSignature = "";
let mode: RoomMode = "join";
let generation = 0;
let timer: ReturnType<typeof setInterval> | null = null;
let ticking = false;
let tickCount = 0;

let baseline: LocalBaseline | null = null;
let localQueueIds: string[] = [];
let clientSeq = 0;
let playlistVersion = 0;
let lastRemoteSignature = "";
let lastRemoteSeq = -1;
let lastRemotePlayMode = "";
let awaitAdoption = 0;
let pendingInitial: "report" | "adopt" | null = null;
let leaderId = "";
let pendingAdvanceAt = 0;
let previousSongId = "";

let lastState: TogetherLocalState = {
  songId: "",
  queueSongIds: [],
  currentIndex: -1,
  positionMs: 0,
  playing: false,
  transitioning: false,
  seekRevision: 0,
  endRevision: 0,
};
let hasLocalState = false;

const roomListeners = new Set<RoomListener>();
const endListeners = new Set<EndListener>();
const commandListeners = new Set<CommandListener>();
const advanceListeners = new Set<AdvanceListener>();
const errorListeners = new Set<ErrorListener>();

export const onRoomChange = (listener: RoomListener): (() => void) => {
  roomListeners.add(listener);
  return () => roomListeners.delete(listener);
};

export const onSessionEnd = (listener: EndListener): (() => void) => {
  endListeners.add(listener);
  return () => endListeners.delete(listener);
};

export const onRemoteCommand = (listener: CommandListener): (() => void) => {
  commandListeners.add(listener);
  return () => commandListeners.delete(listener);
};

export const onAdvance = (listener: AdvanceListener): (() => void) => {
  advanceListeners.add(listener);
  return () => advanceListeners.delete(listener);
};

export const onError = (listener: ErrorListener): (() => void) => {
  errorListeners.add(listener);
  return () => errorListeners.delete(listener);
};

export const getSession = (): TogetherSession | null => session;

const emitAdvance = (): void => {
  for (const listener of advanceListeners) listener();
};

const emitError = (error: unknown): void => {
  const message = error instanceof Error ? error.message : String(error);
  for (const listener of errorListeners) listener(message);
};

const signatureOf = (value: TogetherRoom): string =>
  [value.roomId, value.creatorId, value.members.map((member) => member.userId).join("_")].join("|");

const publishRoom = (value: TogetherRoom): void => {
  if (!session) return;
  room = value;
  const signature = signatureOf(value);
  if (signature === roomSignature) return;
  roomSignature = signature;
  for (const listener of roomListeners) listener(value);
};

const pickLeader = (value: TogetherRoom, selfUserId: string): string => {
  if (value.creatorId) return value.creatorId;
  const candidates = [selfUserId, ...value.members.map((member) => member.userId)].filter(Boolean);
  const sorted = [...candidates].sort((left, right) => {
    const a = Number(left);
    const b = Number(right);
    if (Number.isFinite(a) && Number.isFinite(b) && a !== b) return a - b;
    return left < right ? -1 : left > right ? 1 : 0;
  });
  return sorted[0] ?? selfUserId;
};

const reportFor = (
  changes: readonly string[],
  playing: boolean,
): { type: "GOTO" | "PROGRESS" | "PLAY" | "PAUSE"; playing: boolean } | null => {
  if (changes.includes("track")) return { type: "GOTO", playing };
  if (changes.includes("progress")) return { type: "PROGRESS", playing };
  if (changes.includes("playState")) return { type: playing ? "PLAY" : "PAUSE", playing };
  return null;
};

const reportCommand = async (
  type: "GOTO" | "PROGRESS" | "PLAY" | "PAUSE",
  formerSongId: string,
  playing: boolean,
  progressMs = lastState.positionMs,
): Promise<void> => {
  if (!session) return;
  const issuing = generation;
  clientSeq += 1;
  const seq = clientSeq;
  const roomId = session.roomId;
  const targetSongId = lastState.songId || "0";
  if (issuing !== generation) return;
  await callNetease("listen_together_play_command_report", {
    roomId,
    type,
    progressMs,
    playing,
    formerSongId: formerSongId || "0",
    targetSongId,
    clientSeq: seq,
  });
};

const reportQueue = async (
  songIds: readonly string[],
  anchorSongId = lastState.songId,
  anchorPosition = lastState.currentIndex,
): Promise<void> => {
  if (!session) return;
  const issuing = generation;
  playlistVersion += 1;
  const roomId = session.roomId;
  const userId = Number(session.userId) || 0;
  const version = playlistVersion;
  if (issuing !== generation) return;
  await callNetease("listen_together_sync_list_report", {
    roomId,
    userId,
    version,
    songIds: [...songIds],
    anchorSongId: anchorSongId || "",
    anchorPosition: Number.isFinite(anchorPosition) ? anchorPosition : -1,
  });
};

const applySnapshot = async (initial: boolean): Promise<boolean> => {
  if (!session) return false;
  const selfUserId = session.userId;
  const issuing = generation;
  const snapshot = snapshotFromBody(
    await callNetease("listen_together_sync_playlist_get", { roomId: session.roomId }),
  );
  if (!session || generation !== issuing) return false;
  const command = snapshot.command;
  const fresh =
    command !== null &&
    (initial || isFreshCommand(command, lastRemoteSignature, lastRemoteSeq, selfUserId));
  const replaceQueue = needsQueueReplace(snapshot, localQueueIds);
  if (!fresh && !replaceQueue) return false;

  if (fresh && command) {
    lastRemoteSignature = commandSignature(command);
    lastRemoteSeq = Math.max(lastRemoteSeq, command.serverSeq);
    if (command.userId) leaderId = command.userId;
  }
  if (replaceQueue) {
    playlistVersion += 1;
    localQueueIds = [...snapshot.songIds];
    if (baseline) baseline.queueSignature = songIdsSignature(snapshot.songIds);
  }
  const restored = mode === "restore" && initial;
  const modeChanged = snapshot.playMode !== "" && snapshot.playMode !== lastRemotePlayMode;
  if (modeChanged) lastRemotePlayMode = snapshot.playMode;
  for (const listener of commandListeners) {
    listener({
      command: fresh && command ? (restored ? { ...command, playing: false } : command) : null,
      songIds: replaceQueue ? [...snapshot.songIds] : [],
      playMode: modeChanged ? snapshot.playMode : "",
      initial,
    });
  }
  return true;
};

const beat = async (): Promise<void> => {
  if (!session) return;
  const roomId = session.roomId;
  await callNetease("listen_together_heartbeat", {
    roomId,
    songId: lastState.songId || "0",
    playing: lastState.playing,
    progressMs: lastState.positionMs,
  });
  const status = statusFromBody(await callNetease("listen_together_status", {}));
  if (!session || session.roomId !== roomId) return;
  if (!status.inRoom) {
    endSession("server");
    return;
  }
  if (status.room) publishRoom(status.room);
};

const handleEnded = (): void => {
  if (!leaderId || leaderId === session?.userId) {
    leaderId = session?.userId ?? "";
    emitAdvance();
    return;
  }
  pendingAdvanceAt = Date.now();
};

const tick = async (): Promise<void> => {
  if (!session || ticking || !hasLocalState) return;
  ticking = true;
  const selfUserId = session.userId;
  try {
    if (pendingInitial === "report") {
      pendingInitial = null;
      baseline = baselineOf(lastState);
      if (lastState.queueSongIds.length) {
        localQueueIds = [...lastState.queueSongIds];
        await reportQueue(lastState.queueSongIds);
      }
      if (lastState.songId) await reportCommand("GOTO", "", lastState.playing);
    } else if (pendingInitial === "adopt") {
      pendingInitial = null;
      if (await applySnapshot(true)) {
        awaitAdoption = ADOPT_CONFIRM_TICKS;
        if (mode === "restore") {
          await reportCommand("PAUSE", lastState.songId, false);
        }
      }
      tickCount += 1;
      return;
    } else if (lastState.transitioning) {
      baseline = baselineOf(lastState);
      previousSongId = lastState.songId;
    } else {
      const delta = detectLocalChanges(lastState, baseline ?? baselineOf(lastState));
      baseline = delta.baseline;
      if (awaitAdoption <= 0) {
        if (delta.changes.includes("queue")) {
          await reportQueue(lastState.queueSongIds);
          localQueueIds = [...lastState.queueSongIds];
        }
        if (delta.changes.includes("ended")) handleEnded();
        const action = lastState.songId ? reportFor(delta.changes, lastState.playing) : null;
        if (action) {
          if (action.type === "GOTO") leaderId = selfUserId;
          await reportCommand(
            action.type,
            delta.changes.includes("track") ? previousSongId : "",
            action.playing,
          );
        }
      }
    }
    if (awaitAdoption > 0) awaitAdoption -= 1;
    if (await applySnapshot(false)) awaitAdoption = ADOPT_CONFIRM_TICKS;
    tickCount += 1;
    if (tickCount % HEARTBEAT_TICKS === 0) await beat();
    if (pendingAdvanceAt && Date.now() - pendingAdvanceAt >= ADVANCE_HANDOVER_MS) {
      pendingAdvanceAt = 0;
      leaderId = selfUserId;
      emitAdvance();
    }
  } catch (error) {
    neteaseLog.warn("一起听同步失败:", error);
    emitError(error);
  } finally {
    ticking = false;
  }
};

const endSession = (reason: "left" | "server" | "logout"): void => {
  if (timer) clearInterval(timer);
  timer = null;
  generation += 1;
  session = null;
  room = null;
  roomSignature = "";
  baseline = null;
  localQueueIds = [];
  hasLocalState = false;
  lastRemoteSignature = "";
  lastRemoteSeq = -1;
  lastRemotePlayMode = "";
  awaitAdoption = 0;
  pendingInitial = null;
  pendingAdvanceAt = 0;
  tickCount = 0;
  previousSongId = "";
  for (const listener of endListeners) listener(reason);
};

const enterRoom = (nextRoom: TogetherRoom, userId: string, nextMode: RoomMode): TogetherRoom => {
  if (timer) clearInterval(timer);
  generation += 1;
  session = { roomId: nextRoom.roomId, generation, userId };
  mode = nextMode;
  roomSignature = "";
  publishRoom(nextRoom);
  clientSeq = 0;
  playlistVersion = 0;
  lastRemoteSignature = "";
  lastRemoteSeq = -1;
  awaitAdoption = 0;
  pendingAdvanceAt = 0;
  tickCount = 0;
  baseline = null;
  hasLocalState = false;
  previousSongId = "";
  leaderId = nextMode === "create" ? userId : pickLeader(nextRoom, userId);
  pendingInitial = nextMode === "create" ? "report" : "adopt";
  timer = setInterval(() => void tick(), SYNC_INTERVAL_MS);
  return nextRoom;
};

export const create = async (userId: string): Promise<TogetherRoom> => {
  const created = roomFromBody(await callNetease("listen_together_room_create", {}));
  if (!created) throw new Error("创建房间未返回 roomId");
  const room = enterRoom(created, userId, "create");
  const status = statusFromBody(await callNetease("listen_together_status", {}));
  if (status.room && status.room.roomId === room.roomId) {
    roomSignature = "";
    publishRoom(status.room);
  }
  return room;
};

export const join = async (
  roomId: string,
  inviterId: string,
  userId: string,
): Promise<TogetherRoom> => {
  const current = statusFromBody(await callNetease("listen_together_status", {}));
  if (current.inRoom && current.room?.roomId === roomId) {
    return enterRoom(current.room, userId, "restore");
  }
  if (!joinableFromBody(await callNetease("listen_together_room_check", { roomId }))) {
    throw new Error("房间已失效或无法加入");
  }
  const accepted = roomFromBody(
    await callNetease("listen_together_invitation_accept", {
      roomId,
      inviterId: inviterId || "0",
    }),
  );
  return enterRoom(accepted ?? { roomId, creatorId: "", members: [] }, userId, "join");
};

export const resolveLink = async (url: string): Promise<string> => {
  if (!/^https?:\/\//i.test(url)) throw new Error("邀请链接无效");
  const response = await fetchWithProxy(url, {
    method: "GET",
    redirect: "follow",
    signal: AbortSignal.timeout(8000),
  });
  return response.url || url;
};

export const pendingInvites = async (): Promise<TogetherInviteCard[]> => {
  const cards = invitesFromInbox(
    await callNetease("listen_together_inbox", { limit: INBOX_LIMIT }),
  );
  if (cards.length === 0) return [];
  const checked = await Promise.all(
    cards.map(async (card) => {
      if (session?.roomId === card.roomId) return card;
      try {
        const body = await callNetease("listen_together_room_check", { roomId: card.roomId });
        return joinableFromBody(body) ? card : null;
      } catch {
        return card;
      }
    }),
  );
  return checked.filter((card): card is TogetherInviteCard => card !== null);
};

export const friends = async (userId: string): Promise<TogetherFriend[]> => {
  const result = obj(await callNetease("user_follows", { uid: userId, limit: FRIENDS_LIMIT }));
  const list = obj(result?.body)?.follow;
  const joined = new Set((room?.members ?? []).map((member) => member.userId));
  return (Array.isArray(list) ? list : []).map((item: Record<string, unknown>) => ({
    userId: str(item.userId),
    nickname: str(item.nickname),
    avatarUrl: str(item.avatarUrl),
    joined: joined.has(str(item.userId)),
  }));
};

export const invite = async (acceptorId: string): Promise<void> => {
  if (!session) throw new Error("请先进入一起听房间");
  const id = str(acceptorId).trim();
  if (!/^\d{1,24}$/.test(id)) throw new Error("被邀请人 ID 无效");
  const result = obj(
    await callNetease("listen_together_invite_send", {
      roomId: session.roomId,
      acceptorId: id,
    }),
  );
  const data = obj(obj(result?.body)?.data);
  if (!data?.result) {
    throw new Error(str(data?.message) || "邀请发送失败");
  }
};

export const leave = async (): Promise<void> => {
  const current = session;
  endSession("left");
  if (!current) return;
  try {
    await callNetease("listen_together_end", { roomId: current.roomId });
  } catch (error) {
    neteaseLog.warn("结束一起听房间失败:", error);
  }
};

export const abandon = (): void => {
  endSession("logout");
};

export const restore = async (userId: string): Promise<TogetherRoom | null> => {
  if (session) return room;
  const status = statusFromBody(await callNetease("listen_together_status", {}));
  if (!status.inRoom || !status.room) return null;
  return enterRoom(status.room, userId, "restore");
};

export const updateLocal = (state: TogetherLocalState): void => {
  if (!session) return;
  const previousId = lastState.songId;
  lastState = state;
  hasLocalState = true;
  if (state.songId !== previousId) previousSongId = previousId;
  if (!baseline || awaitAdoption > 0) {
    baseline = baselineOf(state);
    previousSongId = state.songId;
  }
  if (pendingAdvanceAt && state.songId !== previousId) pendingAdvanceAt = 0;
};
