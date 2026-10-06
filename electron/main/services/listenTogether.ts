/**
 * 网易云「一起听」房间状态机
 *
 * 服务端只保存「共享队列 + 最近一条播放命令」，没有推送通道，所以这里用固定节拍
 * 轮询完成同步：每帧先上报本地变化，再拉一次快照应用对端命令，按节拍发心跳并校验
 * 房间是否仍然存在。
 *
 * 播放动作由渲染端执行：只有渲染端知道加载中的切歌、队列替换的落地时刻，主进程
 * 依据它回报的本地状态决定下一步。
 */

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

/** 应用对端状态后，等渲染端确认新状态所需的帧数 */
const ADOPT_CONFIRM_TICKS = 3;

/** 拉取好友列表的条数上限 */
const FRIENDS_LIMIT = 100;

/** 收件箱一次扫描的会话条数 */
const INBOX_LIMIT = 20;

/** 进入房间的方式，决定首帧向谁对齐 */
type RoomMode = "create" | "join" | "restore";

/** 下发给渲染端的对端状态 */
export interface TogetherCommandPayload {
  /** 最近一条对端命令，仅队列变化时为 null */
  command: TogetherCommand | null;
  /** 需要整体替换的共享队列，空数组表示保持本地队列 */
  songIds: string[];
  /** 是否是进入房间后的首次对齐 */
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
/** 上报序号，随房间生命周期单调递增 */
let clientSeq = 0;
/** 共享队列版本号，每次整体替换时自增 */
let playlistVersion = 0;
let lastRemoteSignature = "";
let lastRemoteSeq = -1;
/** 剩余多少帧内把本地状态视为「照做」而非用户动作 */
let awaitAdoption = 0;
/** 进入房间后的首帧待办 */
let pendingInitial: "report" | "adopt" | null = null;
/** 当前掌握推进权的一方 */
let leaderId = "";
/** 自然播完后等待对端推进的起点，0 表示不在等待 */
let pendingAdvanceAt = 0;
let previousSongId = "";

let lastState: TogetherLocalState = {
  songId: "",
  queueSongIds: [],
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

/**
 * 订阅房间信息变化
 * @param listener - 房间变化回调
 * @returns 取消订阅函数
 */
export const onRoomChange = (listener: RoomListener): (() => void) => {
  roomListeners.add(listener);
  return () => roomListeners.delete(listener);
};

/**
 * 订阅房间结束
 * @param listener - 结束回调
 * @returns 取消订阅函数
 */
export const onSessionEnd = (listener: EndListener): (() => void) => {
  endListeners.add(listener);
  return () => endListeners.delete(listener);
};

/**
 * 订阅对端状态
 * @param listener - 对端命令回调
 * @returns 取消订阅函数
 */
export const onRemoteCommand = (listener: CommandListener): (() => void) => {
  commandListeners.add(listener);
  return () => commandListeners.delete(listener);
};

/**
 * 订阅「轮到本机推进队列」
 * @param listener - 推进回调
 * @returns 取消订阅函数
 */
export const onAdvance = (listener: AdvanceListener): (() => void) => {
  advanceListeners.add(listener);
  return () => advanceListeners.delete(listener);
};

/**
 * 订阅同步失败
 * @param listener - 错误回调
 * @returns 取消订阅函数
 */
export const onError = (listener: ErrorListener): (() => void) => {
  errorListeners.add(listener);
  return () => errorListeners.delete(listener);
};

/** 当前会话，未加入房间时为 null */
export const getSession = (): TogetherSession | null => session;

/** 是否正在房间内 */
export const isActive = (): boolean => session !== null;

const emitAdvance = (): void => {
  for (const listener of advanceListeners) listener();
};

const emitError = (error: unknown): void => {
  const message = error instanceof Error ? error.message : String(error);
  for (const listener of errorListeners) listener(message);
};

/** 房间指纹，用于抑制无变化的重复下发 */
const signatureOf = (value: TogetherRoom): string =>
  [value.roomId, value.creatorId, value.members.map((member) => member.userId).join("_")].join("|");

const publishRoom = (value: TogetherRoom): void => {
  room = value;
  const signature = signatureOf(value);
  if (signature === roomSignature) return;
  roomSignature = signature;
  for (const listener of roomListeners) listener(value);
};

/**
 * 推定掌握推进权的一方：房主优先，退化为用户 ID 最小的一方
 * @param value - 房间信息
 * @param selfUserId - 本机用户 ID
 * @returns 推进权所属用户 ID
 */
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

/**
 * 把变化列表折算成一条上报命令
 * @param changes - 本帧变化
 * @param playing - 当前播放态
 * @returns 命令类型与播放态，无需上报时返回 null
 */
const reportFor = (
  changes: readonly string[],
  playing: boolean,
): { type: "GOTO" | "PROGRESS" | "PLAY" | "PAUSE"; playing: boolean } | null => {
  if (changes.includes("track")) return { type: "GOTO", playing };
  if (changes.includes("progress")) return { type: "PROGRESS", playing };
  if (changes.includes("playState")) return { type: playing ? "PLAY" : "PAUSE", playing };
  return null;
};

/**
 * 上报一条播放命令
 * @param type - 命令类型
 * @param formerSongId - 切歌前歌曲 ID
 * @param playing - 发起者播放态
 * @param progressMs - 目标进度
 */
const reportCommand = async (
  type: "GOTO" | "PROGRESS" | "PLAY" | "PAUSE",
  formerSongId: string,
  playing: boolean,
  progressMs = lastState.positionMs,
): Promise<void> => {
  if (!session) return;
  clientSeq += 1;
  await callNetease("listen_together_play_command_report", {
    roomId: session.roomId,
    type,
    progressMs,
    playing,
    formerSongId: formerSongId || "0",
    targetSongId: lastState.songId || "0",
    clientSeq,
  });
};

/**
 * 上报共享队列
 * @param songIds - 当前队列歌曲 ID
 */
const reportQueue = async (songIds: readonly string[]): Promise<void> => {
  if (!session) return;
  playlistVersion += 1;
  await callNetease("listen_together_sync_list_report", {
    roomId: session.roomId,
    userId: Number(session.userId) || 0,
    version: playlistVersion,
    songIds: [...songIds],
  });
};

/**
 * 拉取并应用对端状态
 * @param initial - 是否进入房间后的首次对齐，此时无条件采用对端队列
 * @returns 是否应用了内容
 */
const applySnapshot = async (initial: boolean): Promise<boolean> => {
  if (!session) return false;
  const selfUserId = session.userId;
  const snapshot = snapshotFromBody(
    await callNetease("listen_together_sync_playlist_get", { roomId: session.roomId }),
  );
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
  // 进程刚启动时恢复房间不代表要开始放音：这次不采纳对端的播放态，
  // 由本机随后上报的 PAUSE 成为房间的权威状态
  const restored = mode === "restore" && initial;
  for (const listener of commandListeners) {
    listener({
      command: fresh && command ? (restored ? { ...command, playing: false } : command) : null,
      songIds: replaceQueue ? [...snapshot.songIds] : [],
      initial,
    });
  }
  return true;
};

/** 心跳与房间探活 */
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

/** 自然播完：掌握推进权时立刻续播，否则先等对端推过来 */
const handleEnded = (): void => {
  if (!leaderId || leaderId === session?.userId) {
    leaderId = session?.userId ?? "";
    emitAdvance();
    return;
  }
  pendingAdvanceAt = Date.now();
};

/** 单帧同步 */
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
    } else if (lastState.transitioning) {
      // 加载中的切歌还没落定，此时的歌曲与进度都不是用户意图，只重建基线
      baseline = baselineOf(lastState);
      previousSongId = lastState.songId;
    } else {
      const delta = detectLocalChanges(lastState, baseline ?? baselineOf(lastState));
      baseline = delta.baseline;
      if (awaitAdoption <= 0) {
        if (delta.changes.includes("queue")) await reportQueue(lastState.queueSongIds);
        if (delta.changes.includes("ended")) handleEnded();
        const action = lastState.songId ? reportFor(delta.changes, lastState.playing) : null;
        if (action) {
          // 本机主动操作即接管推进权，房间的下一首由本机决定
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

/**
 * 结束会话并清理
 * @param reason - 结束原因
 */
const endSession = (reason: "left" | "server" | "logout"): void => {
  if (timer) clearInterval(timer);
  timer = null;
  session = null;
  room = null;
  roomSignature = "";
  baseline = null;
  localQueueIds = [];
  hasLocalState = false;
  lastRemoteSignature = "";
  lastRemoteSeq = -1;
  awaitAdoption = 0;
  pendingInitial = null;
  pendingAdvanceAt = 0;
  tickCount = 0;
  previousSongId = "";
  for (const listener of endListeners) listener(reason);
};

/**
 * 进入房间后的公共初始化
 * @param nextRoom - 房间信息
 * @param userId - 本机用户 ID
 * @param nextMode - 进入方式，决定首帧向谁对齐
 * @returns 房间信息
 */
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

/**
 * 创建房间
 * @param userId - 本机用户 ID
 * @returns 服务端返回的房间
 */
export const create = async (userId: string): Promise<TogetherRoom> => {
  const created = roomFromBody(await callNetease("listen_together_room_create", {}));
  if (!created) throw new Error("创建房间未返回 roomId");
  const room = enterRoom(created, userId, "create");
  // 服务端在「已在房间」时会直接把旧房间返回来，成员可能还带着上一轮的残留；
  // 立刻用一次 status 校准，避免界面显示上一局的人
  const status = statusFromBody(await callNetease("listen_together_status", {}));
  if (status.room && status.room.roomId === room.roomId) {
    roomSignature = "";
    publishRoom(status.room);
  }
  return room;
};

/**
 * 加入房间
 * @param roomId - 房间 ID
 * @param inviterId - 邀请者用户 ID
 * @param userId - 本机用户 ID
 * @returns 服务端返回的房间
 */
export const join = async (
  roomId: string,
  inviterId: string,
  userId: string,
): Promise<TogetherRoom> => {
  // 房主自己再"加入"自己房间时服务端会拒绝，此时直接沿用已有房间
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

/**
 * 展开分享用的短链，取出跳转目标
 *
 * 官方 App 分享的 `163cn.tv/xxx` 只有跳转后才带 roomId/inviterId；渲染端拿不到
 * 跨域响应，所以跟跳转放在主进程做。
 * @param url - 用户粘贴文本里的链接
 * @returns 跳转后的最终地址
 */
export const resolveLink = async (url: string): Promise<string> => {
  if (!/^https?:\/\//i.test(url)) throw new Error("邀请链接无效");
  const response = await fetchWithProxy(url, {
    method: "GET",
    redirect: "follow",
    signal: AbortSignal.timeout(8000),
  });
  return response.url || url;
};

/**
 * 取未处理的一起听邀请
 *
 * 私信会一直留在收件箱里，房间却可能早已结束，因此逐条用 room/check 过滤——
 * 不校验就会出现「房间失效了邀请还挂着」。校验并发进行，避免串行等待。
 * @returns 仍可加入的邀请卡片列表
 */
export const pendingInvites = async (): Promise<TogetherInviteCard[]> => {
  const cards = invitesFromInbox(
    await callNetease("listen_together_inbox", { limit: INBOX_LIMIT }),
  );
  if (cards.length === 0) return [];
  const checked = await Promise.all(
    cards.map(async (card) => {
      // 已经在自己房间里的那条邀请不必再校验
      if (session?.roomId === card.roomId) return card;
      try {
        const body = await callNetease("listen_together_room_check", { roomId: card.roomId });
        return joinableFromBody(body) ? card : null;
      } catch {
        // 校验失败（网络抖动等）时宁可保留卡片，由点击时的 join 再兜一次
        return card;
      }
    }),
  );
  return checked.filter((card): card is TogetherInviteCard => card !== null);
};

/**
 * 取可邀请的好友（我关注的人）
 *
 * 官方客户端靠私信投递邀请，所以可选对象就是关注列表；已在房间内的人标记出来，
 * 避免重复邀请。
 * @param userId - 本机用户 ID
 * @returns 好友列表
 */
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

/**
 * 向指定用户发送房间邀请
 * @param acceptorId - 被邀请人用户 ID
 */
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
  const body = obj(result?.body);
  if (!obj(body?.data)?.result) {
    // result 为 false 时服务端会带原因（不在关注列表、房间已满等）
    throw new Error(str(body?.message) || "邀请发送失败");
  }
};

/** 退出房间：先清会话，结束请求在途时迟到的快照不得再改本地播放 */
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

/** 登出时清理，不发结束请求 */
export const abandon = (): void => {
  endSession("logout");
};

/**
 * 恢复服务端上尚未结束的房间
 * @param userId - 本机用户 ID
 * @returns 恢复出的房间，无房间时为 null
 */
export const restore = async (userId: string): Promise<TogetherRoom | null> => {
  if (session) return room;
  const status = statusFromBody(await callNetease("listen_together_status", {}));
  if (!status.inRoom || !status.room) return null;
  return enterRoom(status.room, userId, "restore");
};

/**
 * 接收渲染端上报的本地播放状态
 *
 * 应用对端状态后的若干帧内，本机状态是「照做」的结果而非用户动作，这段时间只重建
 * 基线不上报，否则会把对端的动作原样回传，形成来回震荡。
 * @param state - 播放状态
 */
export const updateLocal = (state: TogetherLocalState): void => {
  if (!session) return;
  const previousId = lastState.songId;
  lastState = state;
  hasLocalState = true;
  if (state.songId !== previousId) previousSongId = previousId;
  localQueueIds = [...state.queueSongIds];
  if (!baseline || awaitAdoption > 0) {
    baseline = baselineOf(state);
    previousSongId = state.songId;
  }
  if (pendingAdvanceAt && state.songId !== previousId) pendingAdvanceAt = 0;
};
