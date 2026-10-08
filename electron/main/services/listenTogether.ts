import { callNetease } from "@main/apis/netease";
import { neteaseLog } from "@main/utils/logger";
import { fetchWithProxy } from "@main/utils/proxy";
import {
  ADVANCE_HANDOVER_MS,
  HEARTBEAT_TICKS,
  SNAPSHOT_POLL_TICKS,
  STATUS_TICKS,
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
  roomCheckFromBody,
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

// 采纳回声的最长存活 tick 数。必须覆盖渲染端加载房间曲目的耗时：
// 加载完成前它不会跟随本地状态，回声若先过期，随后的跟随会被当成用户切歌上报
const ADOPT_CONFIRM_TICKS = 15;

const FRIENDS_LIMIT = 100;

const INBOX_LIMIT = 20;

type RoomMode = "create" | "join" | "restore";

interface TogetherCommandPayload {
  command: TogetherCommand | null;
  songIds: string[];
  playMode: string;
  initial: boolean;
  autoPlay: boolean;
}

type RoomListener = (room: TogetherRoom, generation: number) => void;
type EndListener = (reason: "left" | "server" | "logout", generation: number) => void;
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
const QUEUE_REPLACE_RETRIES = 3;
// 远端采纳后需要吞掉一次的回声：按维度 + 期望值记录，而不是冻结整个上报窗口。
// 时间窗会连用户在窗口内的真实操作一起吃掉
let adoptionEcho: { dim: string; value: string }[] = [];
let adoptionTicks = 0;
let pendingInitial: "report" | "adopt" | null = null;
let leaderId = "";
let pendingAdvanceAt = 0;
/** 已下发但渲染端尚未跟上的目标队列签名；重试若干次仍跟不上才放弃 */
let pendingQueueSignature: string | null = null;
let pendingQueueRetries = 0;
/** 连续观察到"不在房间"的次数：进房瞬间可能撞上一次过期应答，要连续确认才退房 */
let notInRoomStreak = 0;
// 上一次见到的房间成员 id：有人进来时要把当前进度重报一次，
// 否则新进来的人会按服务端存的旧进度对齐
let knownMemberIds: string[] = [];
let previousSongId = "";
let rateLimitUntil = 0;
let rateLimitFailures = 0;
// 房间操作代号：后发的 create/join/restore 使先发操作的最终提交失效
let roomOperation = 0;
// 一次性回执：向渲染端下发过模式后，消费掉紧随其后的那一次同值上报。
// 不能用持久比对（那样用户改回服务端当前模式会被误判成回声而丢失）
let pendingModeAck = "";
// 创建者刚上报的初始模式：在服务端回显它之前，快照里的其它模式值不是对端操作
let claimingMode = "";
// 认领的等待预算：服务端可能一直不回显（或已被对端覆盖），不能永久锁住模式同步
let claimBudget = 0;
const CLAIM_TICKS = 5;
// 创建者上报的初始模式：等快照确认服务端已接受前，不要被默认值覆盖

let lastState: TogetherLocalState = {
  songId: "",
  queueSongIds: [],
  currentIndex: -1,
  positionMs: 0,
  playing: false,
  transitioning: false,
  seekRevision: 0,
  endRevision: 0,
  playMode: "ORDER_LOOP",
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

const ROOM_GONE_CODES = new Set([488]);
const ROOM_GONE_HINTS = ["一起听已失效", "连线已经由", "房间已失效", "room not exist", "已结束"];

const roomGoneCode = (error: unknown): number => {
  const response = (error as { response?: { body?: { code?: unknown } } })?.response;
  const code = Number(response?.body?.code);
  return Number.isFinite(code) ? code : 0;
};

const isRoomGone = (error: unknown): boolean => {
  if (ROOM_GONE_CODES.has(roomGoneCode(error))) return true;
  const text = (error instanceof Error ? error.message : String(error)).toLowerCase();
  return ROOM_GONE_HINTS.some((hint) => text.includes(hint.toLowerCase()));
};

const isRateLimited = (error: unknown): boolean => {
  let current: unknown = error;
  for (let depth = 0; current && depth < 8; depth++) {
    const text = (current instanceof Error ? current.message : String(current)).toLowerCase();
    if (
      text.includes("429") ||
      text.includes("too many requests") ||
      text.includes("rate limit") ||
      text.includes("操作频繁") ||
      text.includes("频繁")
    ) {
      return true;
    }
    current = (current as { cause?: unknown }).cause;
  }
  return false;
};

const registerFailure = (error: unknown, expected?: number): void => {
  const message = error instanceof Error ? error.message : String(error);
  if (isRoomGone(error)) {
    endSession("server", expected);
    return;
  }
  // 旧代次的失败不该污染新房间：跳过限流计数与提示
  if (expected !== undefined && expected !== generation) return;
  emitError(message);
  if (!isRateLimited(error)) return;
  rateLimitFailures += 1;
  if (rateLimitFailures > 3) {
    rateLimitUntil = Number.MAX_SAFE_INTEGER;
    emitError("一起听同步请求过于频繁，请退出房间后重试");
    return;
  }
  const delay = Math.min(120_000, 30_000 * 2 ** (rateLimitFailures - 1));
  rateLimitUntil = Date.now() + delay;
  emitError(`一起听请求受限，将在 ${Math.round(delay / 1000)} 秒后重试`);
};

/** 拒绝加入时的文案：服务端 copywriting 优先，人数上限等策略由服务端决定 */
const joinRejectedMessage = (check: { copywriting: string; status: string }): string => {
  if (check.copywriting) return check.copywriting;
  if (check.status === "EXPIRED") return "一起听已失效，可邀请好友进入新的一起听";
  return "房间已失效或无法加入";
};

const emitAdvance = (): void => {
  for (const listener of advanceListeners) listener();
};

const emitError = (error: unknown): void => {
  const message = error instanceof Error ? error.message : String(error);
  for (const listener of errorListeners) listener(message);
};

// roomType 必须参与：双人房被服务端自动转成多人房时，成员可能不变，
// 只有房型变了。不含它就不会推送，渲染端也就无法切换协议
const signatureOf = (value: TogetherRoom): string =>
  [
    value.roomId,
    value.creatorId,
    value.roomType,
    value.members.map((member) => member.userId).join("_"),
  ].join("|");

const publishRoom = (value: TogetherRoom): void => {
  if (!session) return;
  room = value;
  const signature = signatureOf(value);
  if (signature === roomSignature) return;
  roomSignature = signature;
  for (const listener of roomListeners) listener(value, generation);
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

type ReportAction = {
  type: "GOTO" | "PROGRESS" | "PLAY" | "PAUSE" | "PLAYMODE_CHANGE";
  playing: boolean;
};

const reportFor = (changes: readonly string[], playing: boolean): ReportAction[] => {
  const actions: ReportAction[] = [];
  if (changes.includes("playMode")) actions.push({ type: "PLAYMODE_CHANGE", playing });
  if (changes.includes("track")) actions.push({ type: "GOTO", playing });
  else if (changes.includes("progress")) actions.push({ type: "PROGRESS", playing });
  if (changes.includes("playState")) {
    actions.push({ type: playing ? "PLAY" : "PAUSE", playing });
  }
  return actions;
};

const reportCommand = async (
  type: "GOTO" | "PROGRESS" | "PLAY" | "PAUSE" | "PLAYMODE_CHANGE",
  formerSongId: string,
  playing: boolean,
  state: TogetherLocalState,
): Promise<void> => {
  if (!session) return;
  const issuing = generation;
  clientSeq += 1;
  const seq = clientSeq;
  const roomId = session.roomId;
  // 载荷来自调用方捕获的快照：await 期间 lastState 可能已被替换，
  // 在这里重读会让请求内容与本次 delta 不再对应
  const targetSongId = state.songId || "0";
  if (issuing !== generation) return;
  neteaseLog.info(`[一起听] 上报 ${type} target=${targetSongId} former=${formerSongId || "-"}`);
  await callNetease("listen_together_play_command_report", {
    roomId,
    type,
    progressMs: state.positionMs,
    playing,
    formerSongId: formerSongId || "0",
    targetSongId,
    clientSeq: seq,
    playMode: type === "PLAYMODE_CHANGE" ? state.playMode : "",
  });
};

const reportQueue = async (songIds: readonly string[]): Promise<void> => {
  if (!session) return;
  const issuing = generation;
  playlistVersion += 1;
  const roomId = session.roomId;
  const userId = Number(session.userId) || 0;
  const version = playlistVersion;
  if (issuing !== generation) return;
  clientSeq += 1;
  neteaseLog.info(`[一起听] 上报队列 ${songIds.length}首`);
  const response = await callNetease("listen_together_sync_list_report", {
    roomId,
    userId,
    version,
    clientSeq,
    songIds: [...songIds],
    // 播放模式必须随列表一起上报：实测服务端只在 displayList 为对象形态时
    // 才接受 playMode，数组形态会静默丢弃它（对端就同步不了当前歌曲）
    playMode: lastState.playMode,
  });
  // 服务端用 result 表示是否真的收下了。单人房没有共享歌单，这里恒为 false，
  // 所以只在"房里已有别人"时才当成异常——否则每次建房都会报一条假失败
  const body = obj((response as { body?: unknown })?.body);
  const data = obj(body?.data);
  if (data?.result === false && (room?.members.length ?? 0) > 1) {
    neteaseLog.warn(`[一起听] 队列上报被拒：${str(body?.message) || "无说明"}`);
  }
};

const applySnapshot = async (initial: boolean): Promise<boolean> => {
  if (!session) return false;
  const selfUserId = session.userId;
  const issuing = generation;
  // 请求发出瞬间的本地队列：返回时若已变化，说明用户期间改了队列，
  // 这份快照的队列与锚点都已过期，不能推给渲染端覆盖用户操作
  const queueAtRequest = songIdsSignature(lastState.queueSongIds);
  const snapshot = snapshotFromBody(
    await callNetease("listen_together_sync_playlist_get", { roomId: session.roomId }),
  );
  if (!session || generation !== issuing) return false;
  const command = snapshot.command;
  const fresh =
    command !== null &&
    (initial || isFreshCommand(command, lastRemoteSignature, lastRemoteSeq, selfUserId));
  // 新鲜度只看队列是否变过：本地变空同样意味着这份快照已经过期。
  // "空队列不作为主动清空上传"是发送侧的协议语义，不该混进这里的接收判断
  const queueIsStale = queueAtRequest !== songIdsSignature(lastState.queueSongIds);
  const replaceQueue = !queueIsStale && needsQueueReplace(snapshot, localQueueIds);
  // 播放模式是独立维度：它变化时既没有新命令也不涉及队列替换，
  // 不能因为 !fresh && !replaceQueue 就提前返回
  // 对端抢先改了模式：这条命令本身就是初始声明的终止条件。
  // 少了它，claiming 会永远等不到自己声明的回显，把此后所有模式变化都吞掉。
  // 必须先解除再计算 modeChanged，否则本轮已经算出 false，解除也没用
  const remoteModeCommand =
    fresh && command?.type === "PLAYMODE_CHANGE" && command.userId !== selfUserId;
  if (remoteModeCommand) {
    claimingMode = "";
    claimBudget = 0;
  }
  // 认领只在等待自己声明的那个值：服务端回显它，或预算耗尽，都必须解除，
  // 否则此后所有仅通过快照体现的远端模式变化都会被永久吞掉
  if (claimingMode !== "") {
    if (snapshot.playMode === claimingMode) {
      claimingMode = "";
      claimBudget = 0;
    } else if (claimBudget > 0) {
      claimBudget -= 1;
    } else {
      claimingMode = "";
    }
  }
  // 本地模式还没确认上报成功（基线仍是哨兵）时，不要把服务端值推回渲染端：
  // 否则用户选的模式会先被服务端默认值覆盖，重试就没有意义了
  const modePending = baseline?.playMode === "";
  const modeChanged =
    claimingMode === "" &&
    !modePending &&
    snapshot.playMode !== "" &&
    snapshot.playMode !== lastRemotePlayMode;
  if (!fresh && !replaceQueue && !modeChanged) return false;

  if (fresh && command) {
    lastRemoteSignature = commandSignature(command);
    lastRemoteSeq = Math.max(lastRemoteSeq, command.serverSeq);
    if (command.userId) leaderId = command.userId;
  }
  if (replaceQueue) {
    // 不能立刻推进 localQueueIds：needsQueueReplace 正是拿它比签名，提前推进会让
    // 判据恒为假——渲染端这次没跟上就再也不会重试，本地队列从此与服务端分叉。
    // 改成登记目标、由 updateLocal 在渲染端真的上报该队列时提交
    const target = songIdsSignature(snapshot.songIds);
    if (pendingQueueSignature !== target) {
      pendingQueueSignature = target;
      pendingQueueRetries = 0;
    } else if (pendingQueueRetries >= QUEUE_REPLACE_RETRIES) {
      // 重试够了还跟不上（比如目标曲目根本取不到），认下目标队列，
      // 免得每轮都重发一遍上千首的曲目请求
      localQueueIds = [...snapshot.songIds];
      pendingQueueSignature = null;
    } else {
      pendingQueueRetries += 1;
    }
  }
  const restored = mode === "restore" && initial;
  if (modeChanged) {
    lastRemotePlayMode = snapshot.playMode;
    pendingModeAck = snapshot.playMode;
  }
  // 登记接下来会出现的回声：采纳远端后，渲染端会把这几个维度改成本地状态，
  // 随后的上报是回声而非用户操作。只登记真正会变的维度，其余照常上报，
  // 这样远程采纳期间用户自己的操作不会被连带吞掉
  // 回声清单只在真正应用了一条新的远端命令时重建。每轮都清空会把上次登记的
  // 回声丢掉：后续轮次 fresh 为假，track 回声不会重新登记，跟随就会被当成切歌上报
  if (fresh && command) {
    adoptionEcho = [];
    adoptionTicks = ADOPT_CONFIRM_TICKS;
    if (
      replaceQueue &&
      songIdsSignature(lastState.queueSongIds) !== songIdsSignature(snapshot.songIds)
    ) {
      adoptionEcho.push({ dim: "queue", value: songIdsSignature(snapshot.songIds) });
    }
    if (modeChanged && lastState.playMode !== snapshot.playMode) {
      adoptionEcho.push({ dim: "playMode", value: snapshot.playMode });
    }
    if (command.targetSongId && lastState.songId !== command.targetSongId) {
      adoptionEcho.push({ dim: "track", value: command.targetSongId });
    }
    if (
      (command.type === "PLAY" || command.type === "PAUSE") &&
      lastState.playing !== command.playing
    ) {
      adoptionEcho.push({ dim: "playState", value: String(command.playing) });
    }
  } else if (
    replaceQueue &&
    baseline?.queueSignature !== "" &&
    !adoptionEcho.some((entry) => entry.dim === "queue")
  ) {
    // 纯队列对齐（没有新命令）：补登记队列回声，但不清空已有回声。
    // 基线还是哨兵时不能登记——那说明队列尚未上报成功，需要的是重试而不是吞掉
    adoptionEcho.push({ dim: "queue", value: songIdsSignature(snapshot.songIds) });
    adoptionTicks = Math.max(adoptionTicks, ADOPT_CONFIRM_TICKS);
  }
  for (const listener of commandListeners) {
    listener({
      command: fresh && command ? (restored ? { ...command, playing: false } : command) : null,
      songIds: replaceQueue ? [...snapshot.songIds] : [],
      playMode: modeChanged ? snapshot.playMode : "",
      initial,
      // 入场采纳才自动播放；恢复会话保持原语义（不抢播放）
      autoPlay: initial && !restored,
    });
  }
  // 只有采纳了对端命令才需要压制本地回传；单纯队列对齐不该冻结本地上报，
  // 否则队列稍有出入就会让 awaitAdoption 每轮重置，本地切歌永远上报不出去
  return fresh;
};

const beat = async (doHeartbeat: boolean): Promise<boolean> => {
  if (!session) return true;
  const roomId = session.roomId;
  const issuingBeat = generation;
  let healthy = true;
  try {
    // 没有歌就不发心跳：参考实现同样跳过，避免空放时白刷请求
    if (doHeartbeat && lastState.songId) {
      const response = await callNetease("listen_together_heartbeat", {
        roomId,
        songId: lastState.songId,
        playing: lastState.playing,
        progressMs: lastState.positionMs,
        // 官方心跳带队列版本，用于服务端判断本地队列是否过期
        playlistVersion,
      });
      // 官方只看心跳里明确的失效标记（HeartBeatResult.type == ERROR_ROOM_INVALID）才退房；
      // 正常响应里没有 type，data.result 也是 true。这里同样只在明确失败时判定，
      // 不把"响应缺字段"当成房间没了
      const beatBody = (response as { body?: { data?: Record<string, unknown> } })?.body;
      const beatData = beatBody?.data;
      const invalid = beatData?.type === "ERROR_ROOM_INVALID" || beatData?.result === false;
      if (invalid) {
        neteaseLog.info("[一起听] 心跳返回房间无效，结束会话");
        endSession("server", issuingBeat);
        return true;
      }
    }
  } catch (error) {
    if (isRoomGone(error)) {
      endSession("server", issuingBeat);
      return true;
    }
    // 心跳失败要计入退避，但不能因此跳过状态探测——房间是否还在只有 status 能回答。
    // 健康状态必须回传，否则 tick 收尾会把刚设好的退避当成"本轮成功"清掉
    healthy = false;
    registerFailure(error, issuingBeat);
  }
  try {
    const status = statusFromBody(await callNetease("listen_together_status", {}));
    if (!session || session.roomId !== roomId || generation !== issuingBeat) return healthy;
    if (status.unknown) {
      // 响应不完整（缺 data）不能当成退房信号：一次限流或网络抖动就会把人踢出去。
      // 只记不健康、下轮继续探测，真正的房间结束会由服务端在后续轮次明确回答
      healthy = false;
      return healthy;
    }
    if (!status.inRoom) {
      // 进房/切换瞬间可能撞上一次尚未反映新房间的应答，连续两次才认。
      // 官方同样只在明确拿到失效标记时才退房，单次否定不足以判定
      notInRoomStreak += 1;
      if (notInRoomStreak >= 2) {
        endSession("server", issuingBeat);
        return true;
      }
      healthy = false;
      return healthy;
    }
    notInRoomStreak = 0;
    if (status.room) {
      const ids = status.room.members.map((member) => member.userId).filter(Boolean);
      const arrived = ids.some((id) => !knownMemberIds.includes(id));
      // 首次观察不报：那可能正是自己刚进来，此时还没采纳房间状态，
      // 报上去会把房间已有的歌曲/进度覆盖掉
      if (knownMemberIds.length > 0 && arrived && pendingInitial === null && lastState.songId) {
        // 新听友进来时服务端那边还没有本房的共享歌单（单人房不存），
        // 只发 GOTO 的话对方能看到当前曲却拿不到队列，所以整表补一次
        if (lastState.queueSongIds.length > 0) {
          const queue = [...lastState.queueSongIds];
          if (await guarded(() => reportQueue(queue), issuingBeat)) {
            localQueueIds = queue;
          }
        }
        // 必须发 GOTO 而不是 PROGRESS：对端（尤其官方客户端）入场时
        // 需要一条真正的歌曲指令才会切歌，PROGRESS 只调整进度
        await guarded(() => reportCommand("GOTO", "", lastState.playing, lastState), issuingBeat);
      }
      knownMemberIds = ids;
      publishRoom(status.room);
    }
  } catch (error) {
    if (isRoomGone(error)) {
      endSession("server", issuingBeat);
      return true;
    }
    healthy = false;
    registerFailure(error, issuingBeat);
  }
  return healthy;
};

/** delta 的变化名 → 基线维度名：两者命名不同，不能直接互用 */
const dimensionOf = (change: string): "queue" | "songId" | "playing" | "seek" | "end" | "mode" => {
  if (change === "track") return "songId";
  if (change === "progress") return "seek";
  if (change === "playState") return "playing";
  if (change === "ended") return "end";
  if (change === "playMode") return "mode";
  return "queue";
};

/** 采纳远端后该维度的期望值，用于识别并吞掉一次回声 */
const echoValue = (dimension: string, next: LocalBaseline): string => {
  if (dimension === "queue") return next.queueSignature;
  if (dimension === "songId" || dimension === "track") return next.songId;
  if (dimension === "playing" || dimension === "playState") return String(next.playing);
  if (dimension === "seek" || dimension === "progress") return String(next.seekRevision);
  if (dimension === "end" || dimension === "ended") return String(next.endRevision);
  return next.playMode;
};

const handleEnded = (): void => {
  if (!leaderId || leaderId === session?.userId) {
    leaderId = session?.userId ?? "";
    emitAdvance();
    return;
  }
  pendingAdvanceAt = Date.now();
};

const guarded = async (work: () => Promise<void>, expected?: number): Promise<boolean> => {
  try {
    await work();
    // 成功返回也要校验代次：请求在飞行途中换房时，这次结果属于旧会话，
    // 让调用方按失败处理，避免旧 tick 继续写新房间的状态
    if (expected !== undefined && expected !== generation) return false;
    return true;
  } catch (error) {
    neteaseLog.warn("一起听同步失败:", error);
    registerFailure(error, expected);
    return false;
  }
};

const tick = async (): Promise<void> => {
  if (!session || ticking || !hasLocalState) return;
  if (Date.now() < rateLimitUntil) return;
  ticking = true;
  const selfUserId = session.userId;
  const issuing = generation;
  // 本轮唯一的本地状态快照：所有上报与提交都基于它，
  // 避免 await 之后重读 lastState 拿到与本次 delta 不匹配的值
  const state = lastState;
  let healthy = true;
  try {
    if (pendingInitial === "report") {
      pendingInitial = null;
      // 首帧同样按维度提交：任一维度上报失败就保持旧基线，
      // 否则 pendingInitial 已清空、差异也被抹平，该状态再也补报不出去
      const initial = baselineOf(state);
      // 待上报的维度先标记为"未确认"（空值），上报成功后才收敛到真实值。
      // 必须无条件覆盖：渲染端的首帧上报可能已经先把 baseline 整块设成当前状态
      baseline = {
        ...(baseline ?? initial),
        ...(state.queueSongIds.length ? { queueSignature: "" } : {}),
        ...(state.songId ? { songId: "" } : {}),
        ...(state.playMode ? { playMode: "" } : {}),
      };
      const claim = (dimension: "queue" | "songId" | "mode"): void => {
        const current = baseline ?? initial;
        // await 期间本地又变了就不提交：留给下一轮检出，避免把新操作标成已同步
        if (dimension === "queue") {
          if (songIdsSignature(lastState.queueSongIds) !== initial.queueSignature) return;
        } else if (dimension === "songId") {
          if (
            lastState.songId !== initial.songId ||
            lastState.seekRevision !== initial.seekRevision
          ) {
            return;
          }
        } else if (lastState.playMode !== initial.playMode) {
          return;
        }
        baseline = {
          ...current,
          ...(dimension === "queue" ? { queueSignature: initial.queueSignature } : {}),
          ...(dimension === "songId"
            ? {
                songId: initial.songId,
                playing: initial.playing,
                seekRevision: initial.seekRevision,
              }
            : {}),
          ...(dimension === "mode" ? { playMode: initial.playMode } : {}),
        };
      };
      if (state.queueSongIds.length) {
        const initialQueue = [...state.queueSongIds];
        if (await guarded(() => reportQueue(initialQueue), issuing)) {
          localQueueIds = initialQueue;
          claim("queue");
        } else {
          healthy = false;
        }
      } else {
        claim("queue");
      }
      if (state.songId) {
        const gotoSent = await guarded(
          () => reportCommand("GOTO", "", state.playing, state),
          issuing,
        );
        healthy = gotoSent && healthy;
        if (gotoSent) claim("songId");
      } else {
        claim("songId");
      }
      // 创建者即房间初始状态的权威：本地播放器模式也要一起上报，
      // 否则服务端默认值会在随后的快照里把创建者的模式覆盖掉。
      // 只有上报成功才登记为"已认领"：失败还登记的话，服务端之后真实返回的
      // 模式会被 claiming 当作"未回显"吞掉，而该值此后再无补报机会
      const modeReported = await guarded(
        () => reportCommand("PLAYMODE_CHANGE", "", state.playing, state),
        issuing,
      );
      healthy = modeReported && healthy;
      if (modeReported) {
        lastRemotePlayMode = state.playMode;
        claimingMode = state.playMode;
        claimBudget = CLAIM_TICKS;
        claim("mode");
      }
      // 上报期间可能已经换了房：后续阶段属于旧会话，不再继续
      if (issuing !== generation) {
        tickCount += 1;
        return;
      }
    } else if (pendingInitial === "adopt") {
      pendingInitial = null;
      // applied 与 guarded 的返回值是两件事：guarded 只表示这次没失败/没过期，
      // 是否真的采纳了快照要看 applySnapshot 自己的结果
      let applied = false;
      const ok = await guarded(async () => {
        applied = await applySnapshot(true);
        if (applied && mode === "restore") {
          await reportCommand("PAUSE", state.songId, false, state);
        }
      }, issuing);
      if (ok && applied) adoptionTicks = ADOPT_CONFIRM_TICKS;
      if (!ok) healthy = false;
      tickCount += 1;
      return;
    } else if (state.transitioning) {
      // 加载期间引擎会报出非播放态，直接比较会朝对端发一次假的 PAUSE，
      // 所以这几个维度一律沿用旧基线而不是吸收当前值：
      // 瞬时状态不会被误报，而"加载期间用户真的按了暂停/换了模式"仍能在加载结束后检出
      const fresh = baselineOf(state);
      baseline = {
        ...fresh,
        songId: baseline?.songId ?? state.songId,
        queueSignature: baseline?.queueSignature ?? fresh.queueSignature,
        playing: baseline?.playing ?? fresh.playing,
        playMode: baseline?.playMode ?? fresh.playMode,
      };
    } else {
      const delta = detectLocalChanges(state, baseline ?? baselineOf(state));
      const next = delta.baseline;
      // 刚下发过的模式又原样回来：这是渲染端 applyPlayMode 的回执，不是用户操作。
      // 只在待确认时吞一次，之后同样的值仍可正常上报
      const modeIsEcho =
        pendingModeAck !== "" &&
        delta.changes.includes("playMode") &&
        next.playMode === pendingModeAck;
      if (modeIsEcho) {
        delta.changes = delta.changes.filter((c) => c !== "playMode");
        pendingModeAck = "";
      } else if (delta.changes.includes("playMode")) {
        pendingModeAck = "";
      }
      const prev = baseline ?? baselineOf(state);
      // 基线按维度提交：某项上报成功后只推进该维度，失败的下轮还能被检出。
      // 一次性提交整个 delta 会让失败的变化永久丢失。
      // 上报是异步的：期间本地可能又变了。只有当该维度仍是当前值时才提交基线，
      // 否则留下的是过期基线，会把用户的后续操作当成"已上报过"而漏掉
      const fresh = (dimension: string): boolean => {
        if (dimension === "queue") {
          return songIdsSignature(lastState.queueSongIds) === next.queueSignature;
        }
        if (dimension === "songId") return lastState.songId === next.songId;
        if (dimension === "playing") return lastState.playing === next.playing;
        if (dimension === "seek") return lastState.seekRevision === next.seekRevision;
        if (dimension === "end") return lastState.endRevision === next.endRevision;
        return lastState.playMode === next.playMode;
      };
      const commit = (
        dimension: "queue" | "songId" | "playing" | "seek" | "end" | "mode",
      ): void => {
        if (!fresh(dimension)) return;
        baseline = {
          ...(baseline ?? prev),
          ...(dimension === "queue" ? { queueSignature: next.queueSignature } : {}),
          ...(dimension === "songId" ? { songId: next.songId } : {}),
          ...(dimension === "playing" ? { playing: next.playing } : {}),
          ...(dimension === "seek" ? { seekRevision: next.seekRevision } : {}),
          ...(dimension === "end" ? { endRevision: next.endRevision } : {}),
          ...(dimension === "mode" ? { playMode: next.playMode } : {}),
        };
      };
      // 这一轮期间若换了房，delta 与 commit 都属于旧会话：只跳过写入，
      // 让 finally 正常收尾，不额外 return
      const stale = issuing !== generation;
      // 只吞掉"与远端刚设的值一致"的那一次变化，其余照常上报
      const echoCommitted: string[] = [];
      if (adoptionTicks > 0) {
        adoptionTicks -= 1;
        const remaining: string[] = [];
        for (const change of delta.changes) {
          const index = adoptionEcho.findIndex(
            (entry) =>
              entry.dim === change &&
              (entry.value === "*" || entry.value === echoValue(change, next)),
          );
          if (index >= 0) {
            adoptionEcho.splice(index, 1);
            echoCommitted.push(change);
            continue;
          }
          remaining.push(change);
        }
        delta.changes = remaining as typeof delta.changes;
      } else {
        adoptionEcho = [];
      }
      if (!stale) {
        if (delta.changes.includes("queue")) {
          // 发送值与写回值必须是同一个数组：请求期间本地可能已改成别的队列，
          // 写回当前值会让缓存与服务端实际持有的队列不一致
          const sentQueue = [...state.queueSongIds];
          if (await guarded(() => reportQueue(sentQueue), issuing)) {
            localQueueIds = sentQueue;
            commit("queue");
          } else {
            healthy = false;
          }
        } else {
          commit("queue");
        }
        if (delta.changes.includes("ended")) {
          handleEnded();
          commit("end");
        }
        const actions = state.songId ? reportFor(delta.changes, state.playing) : [];
        for (const action of actions) {
          if (action.type === "GOTO") leaderId = selfUserId;
          const sent = await guarded(
            () =>
              reportCommand(
                action.type,
                delta.changes.includes("track") ? previousSongId : "",
                action.playing,
                state,
              ),
            issuing,
          );
          if (!sent) {
            healthy = false;
            continue;
          }
          if (action.type === "GOTO") commit("songId");
          if (action.type === "PROGRESS") commit("seek");
          if (action.type === "PLAY" || action.type === "PAUSE") commit("playing");
          // 自己上报的模式就是服务端之后会返回的模式，先记下来，
          // 否则下一帧会被当成"对端改了模式"再弹回本地
          if (action.type === "PLAYMODE_CHANGE") {
            // 同一个变量承载"已知模式"：既用于判定远端是否真的改了模式，
            // 也用于识别本地跟随产生的回声。值必须与下一轮服务端返回的一致
            commit("mode");
          }
        }
        if (actions.length === 0) {
          if (!delta.changes.includes("ended")) commit("end");
          if (!delta.changes.includes("playMode")) commit("mode");
        }
      }
      for (const change of echoCommitted) commit(dimensionOf(change));
    }
    // 执行链隔离：换房后不再对新房间发起无意义的快照请求
    if (issuing !== generation) {
      tickCount += 1;
      return;
    }
    // 拉取按更低频率进行：每秒一次是每秒一个请求，风控风险明显
    if (tickCount % SNAPSHOT_POLL_TICKS === 0) {
      healthy =
        (await guarded(async () => {
          await applySnapshot(false);
        }, issuing)) && healthy;
    }
    tickCount += 1;
    if (issuing !== generation) return;
    if (tickCount % STATUS_TICKS === 0) {
      healthy = (await beat(tickCount % HEARTBEAT_TICKS === 0)) && healthy;
    }
    if (pendingAdvanceAt && Date.now() - pendingAdvanceAt >= ADVANCE_HANDOVER_MS) {
      pendingAdvanceAt = 0;
      leaderId = selfUserId;
      emitAdvance();
    }
    if (healthy && issuing === generation) {
      rateLimitFailures = 0;
      rateLimitUntil = 0;
    }
  } catch (error) {
    neteaseLog.warn("一起听同步失败:", error);
    registerFailure(error);
  } finally {
    ticking = false;
  }
};

const endSession = (reason: "left" | "server" | "logout", expected?: number): void => {
  // 旧请求的失败回调可能晚于切房到达，只有代次匹配才允许结束当前会话
  if (expected !== undefined && expected !== generation) return;
  // 只在用户主动终止（退房/登出）时废弃在途的房间事务，避免旧会话复活。
  // 服务端侧的房间失效（server）不能这么做：那是对"旧房间没了"的反应，
  // 而用户此刻可能正好在接收新房间的邀请，取消它会让"点接收进不去"
  if (reason !== "server") roomOperation += 1;
  const ended = generation;
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
  pendingModeAck = "";
  claimingMode = "";
  claimBudget = 0;
  adoptionEcho = [];
  adoptionTicks = 0;
  pendingInitial = null;
  pendingAdvanceAt = 0;
  pendingQueueSignature = null;
  pendingQueueRetries = 0;
  notInRoomStreak = 0;
  knownMemberIds = [];
  tickCount = 0;
  previousSongId = "";
  rateLimitUntil = 0;
  rateLimitFailures = 0;
  for (const listener of endListeners) listener(reason, ended);
};

const enterRoom = (nextRoom: TogetherRoom, userId: string, nextMode: RoomMode): TogetherRoom => {
  if (timer) clearInterval(timer);
  generation += 1;
  session = { roomId: nextRoom.roomId, userId, generation };
  mode = nextMode;
  roomSignature = "";
  publishRoom(nextRoom);
  clientSeq = 0;
  lastRemoteSignature = "";
  lastRemoteSeq = -1;
  // 跨房间不能残留：新房间若恰好是同名模式，残留值会让首次快照判为"未变化"而不下发；
  // 未消费的回执同样会吞掉新房间的第一次同值上报
  lastRemotePlayMode = "";
  pendingModeAck = "";
  claimingMode = "";
  claimBudget = 0;
  adoptionEcho = [];
  adoptionTicks = 0;
  pendingAdvanceAt = 0;
  pendingQueueSignature = null;
  pendingQueueRetries = 0;
  notInRoomStreak = 0;
  knownMemberIds = [];
  tickCount = 0;
  baseline = null;
  hasLocalState = false;
  previousSongId = "";
  rateLimitUntil = 0;
  rateLimitFailures = 0;
  // 队列版本号必须每房从 1 开始：实测新房首条上报若是 version>1，
  // 服务端会整条丢弃（playlist 根本不会建立）
  playlistVersion = 0;
  leaderId = nextMode === "create" ? userId : pickLeader(nextRoom, userId);
  pendingInitial = nextMode === "create" ? "report" : "adopt";
  timer = setInterval(() => void tick(), SYNC_INTERVAL_MS);
  return nextRoom;
};

export const create = async (userId: string): Promise<TogetherRoom> => {
  const operation = ++roomOperation;
  const created = roomFromBody(await callNetease("listen_together_room_create", {}));
  if (operation !== roomOperation) throw new Error("房间操作已被后续操作取代");
  if (!created) throw new Error("创建房间未返回 roomId");
  const room = enterRoom(created, userId, "create");
  // 校准是尽力而为：它失败不该让调用方以为建房失败，否则会留下
  // "界面报错但主进程已进房"的幽灵会话
  await guarded(async () => {
    const status = statusFromBody(await callNetease("listen_together_status", {}));
    if (status.room && status.room.roomId === room.roomId) {
      roomSignature = "";
      publishRoom(status.room);
    }
  }, generation);
  return room;
};

export const join = async (
  roomId: string,
  inviterId: string,
  userId: string,
): Promise<TogetherRoom> => {
  const operation = ++roomOperation;
  // 每个异步阶段回来都要确认自己没被后续操作或会话终止取代，
  // 否则会在登出/切房之后继续推进并重建会话
  const ensureCurrent = (): void => {
    if (operation !== roomOperation) throw new Error("房间操作已被后续操作取代");
  };
  const current = statusFromBody(await callNetease("listen_together_status", {}));
  ensureCurrent();
  if (current.inRoom && current.room?.roomId === roomId) {
    // 这是"用户刚进来"（点接受邀请或匹配成功），不是重启后的恢复：
    // 标成 restore 会走"不抢播放"的分支，导致进来就停在暂停、进度也不同步
    return enterRoom(current.room, userId, "join");
  }
  const check = roomCheckFromBody(await callNetease("listen_together_room_check", { roomId }));
  ensureCurrent();
  if (!check.joinable) throw new Error(joinRejectedMessage(check));
  const accepted = roomFromBody(
    await callNetease("listen_together_invitation_accept", {
      roomId,
      inviterId: inviterId || "0",
    }),
  );
  ensureCurrent();
  return enterRoom(
    accepted ?? { roomId, creatorId: "", roomType: "", members: [] },
    userId,
    "join",
  );
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

/** 上一次拿到的邀请版本号：传给服务端即可增量拉取，没有新邀请时它只递增版本 */
let invitationVersion = 0;

export interface TogetherInvitationInfo {
  /** 是否有待处理的邀请 */
  display: boolean;
  roomId: string;
  inviterId: string;
  nickname: string;
  avatarUrl: string;
  /** 房型自动升级标记：官方靠它判断"双人房已被服务端转成多人" */
  hadAutoChangeMulti: boolean;
}

/**
 * 拉取邀请。
 *
 * 官方靠云信 IM 推送获知邀请，我们没接 IM，改用这个 HTTP 端点轮询：
 * 实测它是增量设计（传入已知版本，服务端每次 +1 返回），
 * 有新邀请时带 display:true 与 roomId
 */
export const fetchInvitation = async (): Promise<TogetherInvitationInfo | null> => {
  const response = await callNetease("listen_together_invitation_info", {
    invitationVersion,
  });
  const body = obj((response as { body?: unknown })?.body);
  const data = obj(body?.data);
  if (!data) return null;
  invitationVersion = Number(data.invitationVersion) || invitationVersion;
  if (data.display !== true) return null;
  return {
    display: true,
    roomId: str(data.roomId),
    inviterId: str(data.inviterId),
    nickname: str(data.nickname),
    avatarUrl: str(data.avatarUrl),
    hadAutoChangeMulti: data.hadAutoChangeMulti === true,
  };
};

/** 退房/换房后重置，避免把上一个房间的版本号带过去 */
export const resetInvitationVersion = (): void => {
  invitationVersion = 0;
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
        const check = roomCheckFromBody(
          await callNetease("listen_together_room_check", { roomId: card.roomId }),
        );
        // 只滤掉真正失效（EXPIRED）的房间。人数已满等其它原因要保留卡片，
        // 否则用户看不到任何反馈，也拿不到服务端给的具体原因
        return check.joinable || check.status !== "EXPIRED" ? card : null;
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

/** 拒绝邀请：服务端据此不再把该房算作待处理，本地也要把它移出列表 */
export const rejectInvitation = async (roomId: string): Promise<void> => {
  const id = str(roomId).trim();
  if (!id) return;
  await callNetease("listen_together_invitation_reject", { roomId: id });
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

/**
 * 本地脱离房间，不通知服务端。
 *
 * 房型被服务端升级成多人后，多人侧会接管同一个房间；此时双人侧必须让位。
 * 不能走 leave()：它发的 end/v2 会把整个房间作废（实测之后多人心跳立刻 400），
 * 用户刚被升级进的新房当场失效
 */
export const detach = (): void => {
  endSession("left");
};

/**
 * 恢复一起听会话
 * @param userId - 当前账号
 * @param entering - true 表示"用户刚匹配进房"而不是"重启后恢复"。
 *   前者要跟随房间的播放态与进度，后者保持本地原状态、不抢播放，
 *   两者共用这一条查询路径但语义相反
 */
export const restore = async (userId: string, entering = false): Promise<TogetherRoom | null> => {
  if (session) return room;
  const operation = ++roomOperation;
  const status = statusFromBody(await callNetease("listen_together_status", {}));
  if (operation !== roomOperation) return null;
  if (!status.inRoom || !status.room) return null;
  const restored = enterRoom(status.room, userId, entering ? "join" : "restore");
  // status/get 只给房间与成员，当前歌曲/模式/队列要等快照。
  // 不立即拉一次的话，恢复后要等一个快照周期（最长 4 秒）才开始跟随
  void guarded(async () => {
    await applySnapshot(true);
  }, generation);
  return restored;
};

export const updateLocal = (state: TogetherLocalState): void => {
  if (!session) return;
  const previousId = lastState.songId;
  const previousQueue = songIdsSignature(lastState.queueSongIds);
  lastState = state;
  hasLocalState = true;
  if (state.songId !== previousId || songIdsSignature(state.queueSongIds) !== previousQueue) {
    neteaseLog.info(
      `[一起听] 本地状态 song=${state.songId || "-"} 队列=${state.queueSongIds.length}首 模式=${state.playMode}`,
    );
  }
  if (state.songId !== previousId) previousSongId = previousId;
  if (!baseline) {
    baseline = baselineOf(state);
    previousSongId = state.songId;
  }
  if (pendingAdvanceAt && state.songId !== previousId) pendingAdvanceAt = 0;
  // 渲染端真的把队列换成了我们下发的目标，这时才认账
  if (pendingQueueSignature && songIdsSignature(state.queueSongIds) === pendingQueueSignature) {
    localQueueIds = [...state.queueSongIds];
    pendingQueueSignature = null;
    pendingQueueRetries = 0;
  }
};
