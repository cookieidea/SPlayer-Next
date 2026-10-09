import { callNetease } from "@main/apis/netease";
import {
  connectNimRoom,
  connectPersonalChannel,
  disconnectNimRoom,
  disconnectPersonalChannel,
  fetchRoomMembers,
  setNimListener,
  setRoomOwnerView,
} from "@main/services/nim/realtime";
import { setMultiRoomActive } from "@main/services/togetherPresence";
import { neteaseLog } from "@main/utils/logger";
import {
  list,
  multiPlaybackFromSongInfo,
  multiRoomFromBody,
  multiRoomStatusOf,
  obj,
  str,
  toRoomSong,
} from "@main/utils/togetherParse";
import type {
  TogetherMultiEndReason,
  TogetherMultiRoom,
  TogetherMultiSession,
  TogetherRoomOperateResult,
} from "@shared/types/listenTogether";

/**
 * 多人房心跳间隔。
 *
 * 它只负责保活与失效检测——房间状态现在由服务端推的 type=30000 实时下发，
 * 跟随不再依赖心跳。服务端自己给的 heartBeatDuration 是 30 秒，
 * 这里取 15 秒：既把请求量降到原来的一半以下，又保证断线时能较快发现
 */
/**
 * 多人房心跳间隔。
 *
 * 它只负责保活与失效检测——房间状态现在由服务端推的 type=30000 实时下发，
 * 跟随不再依赖心跳。服务端自己给的 heartBeatDuration 是 30 秒，
 * 这里取 15 秒：既把请求量降到原来的一半以下，又保证断线时能较快发现
 */
export const MULTI_HEARTBEAT_MS = 15_000;

const ROOM_GONE_CODE = 488;

/** 实时通道断开后的重连间隔 */
const REALTIME_RETRY_MS = 5000;

/**
 * 取易盾风控令牌。
 *
 * 动态导入：checktoken 链路会拉进 proxy / store / paths，而后者依赖
 * Electron 的 app。顶层导入会让不跑 Electron 的测试直接加载失败
 */
const fetchCheckToken = async (): Promise<string> => {
  const { getAntiCheatTokenV3 } = await import("@main/apis/netease/core/checktoken");
  return getAntiCheatTokenV3();
};

// operate 枚举实测自真实多人房（服务端 failedMsg 逐条印证）：
//   0 加歌  "已将你带来的歌曲推荐给大家"
//   1 加歌被拒（该歌刚播过）
//   2 顶歌  "你顶了一下歌曲 X"
//   3 点赞  "你觉得这首歌很好听！"
//   4 切歌  "切换的是已播完的歌曲"
//   5 红心  "你红心了歌曲 X"
//   6 收藏  "你收藏了歌曲 X"
//   7 删歌  "只能删除待播状态的歌曲哦～"
//   8 未知（result=true 且无副作用）
/** 官方 operate 失败码 → 用户可读提示（LTMultiSongOperateResultCode） */
const OPERATE_FAILED_HINT: Readonly<Record<number, string>> = {
  10004: "切歌太频繁了，稍等一下再试",
  10005: "上一次切歌还在生效中，请稍候",
  10006: "这首歌已经播过了，换一首吧",
  10009: "这首歌已经播完，无法置顶",
  10000: "你没有权限操作房间的歌曲",
  100010: "需要先关注房主才能操作",
};

const OPERATE_ADD = 0;

const OPERATE_TOP = 2;

const OPERATE_DELETE = 7;

// 实测：对当前曲投「不想听」，人够就切走。返回 "有足够多的人不想听，切歌成功！"
const OPERATE_VOTE_SKIP = 4;

type RoomListener = (room: TogetherMultiRoom, generation: number) => void;

type EndListener = (reason: TogetherMultiEndReason, generation: number) => void;

type ErrorListener = (message: string) => void;

let session: TogetherMultiSession | null = null;
let room: TogetherMultiRoom | null = null;
let generation = 0;
let timer: ReturnType<typeof setInterval> | null = null;
let realtimeRetry: ReturnType<typeof setTimeout> | null = null;
let ticking = false;
/** 心跳在途期间收到的刷新请求，在当前这轮结束后补做一次 */
let refreshPending = false;

let roomListener: RoomListener | null = null;
let endListener: EndListener | null = null;
let errorListener: ErrorListener | null = null;

export const onMultiRoom = (listener: RoomListener): (() => void) => {
  roomListener = listener;
  return () => {
    if (roomListener === listener) roomListener = null;
  };
};

export const onMultiEnd = (listener: EndListener): (() => void) => {
  endListener = listener;
  return () => {
    if (endListener === listener) endListener = null;
  };
};

export const onMultiError = (listener: ErrorListener): (() => void) => {
  errorListener = listener;
  return () => {
    if (errorListener === listener) errorListener = null;
  };
};

export const getMultiSession = (): TogetherMultiSession | null => session;

/**
 * 用聊天室在线成员刷新房间名单。
 *
 * 心跳的成员聚合 8 秒一轮，聊天室名单是实时的；成员进出与进房时拉一次，
 * 只补齐昵称/头像，不动成员集合——集合以房间协议为准
 */
const refreshMembersFromIm = async (issuing: number): Promise<void> => {
  if (!session || generation !== issuing) return;
  const members = await fetchRoomMembers();
  if (!session || generation !== issuing || members.length === 0) return;
  const current = room;
  if (!current) return;
  // 聊天室名单是权威的（含昵称头像），直接采用：
  // 只补昵称的写法在房间协议成员为空时补不出任何东西
  publish({ ...current, members }, issuing);
};

const publish = (next: TogetherMultiRoom, issuing: number): void => {
  if (generation !== issuing) return;
  room = next;
  setMultiRoomActive(true);
  roomListener?.(next, issuing);
};

const stop = (reason: TogetherMultiEndReason): void => {
  if (!session) return;
  const ended = session;
  generation += 1;
  session = null;
  room = null;
  setMultiRoomActive(false);
  if (timer) clearInterval(timer);
  timer = null;
  if (realtimeRetry) clearTimeout(realtimeRetry);
  realtimeRetry = null;
  disconnectNimRoom();
  endListener?.(reason, ended.generation);
};

const roomFromResponse = (value: unknown): TogetherMultiRoom | null => multiRoomFromBody(value);

const codeOf = (value: unknown): number => {
  const body = obj(obj(value)?.body) ?? {};
  return Number(body.code) || 0;
};

const ROOM_GONE_HINTS = ["一起听已失效", "房间已失效", "房间不存在", "room not exist"];

/**
 * 房间是否已被服务端结束。
 *
 * 抛出的 NeteaseRequestError 把响应体放在 error.response.body，
 * 读 error.body 会恒得 0，于是死房间永远退不出去、每轮心跳都报一次错
 */
const isRoomGone = (error: unknown): boolean => {
  const response = (error as { response?: { body?: { code?: unknown } } })?.response;
  const code = Number(response?.body?.code);
  if (Number.isFinite(code) && code === ROOM_GONE_CODE) return true;
  const text = str(obj(error)?.message);
  return ROOM_GONE_HINTS.some((hint) => text.includes(hint));
};

const failWith = (value: unknown, fallback: string): string => {
  const body = obj(obj(value)?.body) ?? {};
  const data = obj(body.data) ?? {};
  return str(data.failedMessage) || str(body.message) || fallback;
};

export /** 认领一次会话操作：推进代次，任何更早的在途请求都会被判为过期 */
const claimGeneration = (): number => {
  generation += 1;
  return generation;
};

/**
 * 请求在途时若代次被别的操作推进，说明这次结果已经过期，必须丢弃。
 * 缺了这道校验会把过期响应写进 session，出现"主进程在旧房间里轮询、
 * 渲染端却不在房间"的分叉
 */
const assertCurrent = (issuing: number): void => {
  if (generation !== issuing) throw new Error("房间操作已被后续操作取代");
};

/** 新房间确认后再拆旧会话：请求失败时不该把用户从原房间里踢出去却仍占着它 */
const enterMultiRoom = (next: TogetherMultiRoom, userId: string): TogetherMultiRoom => {
  if (session) stop("left");
  const issuing = claimGeneration();
  session = { roomId: next.roomId, userId, generation: issuing };
  publish(next, issuing);
  startMultiTick();
  void connectRealtime(next, issuing);
  // 房间协议的成员字段常常是空的（心跳响应只有 roomInfoDTO，不带成员聚合），
  // 进房立刻拉一次聊天室名单，否则界面上的成员列表一直是空的
  void refreshMembersFromIm(issuing);
  return next;
};

/**
 * 接实时通道，失败就重连。
 *
 * 长连接是同步的唯一来源，一旦断开对端操作就完全收不到，所以要一直重试到
 * 接上为止；重试只在会话仍然有效时进行，退出房间时随会话一起取消
 */
const connectRealtime = async (room: TogetherMultiRoom, issuing: number): Promise<void> => {
  try {
    await openRealtime(room, issuing);
  } catch (error) {
    if (!session || generation !== issuing) return;
    neteaseLog.warn(`[一起听] 实时通道连接失败，稍后重连：${str(obj(error)?.message)}`);
    if (realtimeRetry) clearTimeout(realtimeRetry);
    realtimeRetry = setTimeout(() => {
      realtimeRetry = null;
      if (session && generation === issuing) void connectRealtime(room, issuing);
    }, REALTIME_RETRY_MS);
  }
};

/**
 * 接上房间的实时通道。
 *
 * 对端操作会由云信推送过来，收到后立刻刷一次心跳拿权威状态，
 * 不必等下一个心跳周期，切歌/暂停的延迟因此从数秒降到几乎无感
 */
const openRealtime = async (room: TogetherMultiRoom, issuing: number): Promise<void> => {
  const credentials = await fetchImCredentials();
  if (!credentials) throw new Error("未取到云信凭据");
  if (generation !== issuing || !session) return;
  // 房主身份决定取 operateMsg 的哪一份文案（官方 owner/follower 二选一）
  setRoomOwnerView(room.creatorId !== "" && room.creatorId === session.userId);
  await connectNimRoom({
    chatRoomId: room.chatRoomId,
    accId: credentials.accId,
    token: credentials.token,
  });
  if (generation !== issuing) return;
  setNimListener((event) => {
    // 配对通知发生在"还没有房间"的阶段（session 尚未建立），
    // 必须放在 session 校验之前处理，否则这条最关键的推送会被直接丢掉
    if (event.kind === "matchLock") {
      void handleMatchLock(event);
      return;
    }
    if (!session || generation !== issuing) return;
    // 成员变动即便是自己的也刷新名单：进来的是别人，只是在事件里标了"谁触发的"
    if (event.kind === "member") void refreshMembersFromIm(issuing);

    // 服务端推的房间状态是权威全量：直接就地发布。
    // 这条路径取代了"等 8 秒心跳"或"再拉一次心跳"，房间一变界面立刻跟上，
    // 也是"播完自动接下一首"的可靠来源
    if (event.kind === "state") {
      applyHeartBeatDuration(event.heartBeatDuration);
      const current = room;
      if (!current || event.roomId !== current.roomId) return;
      neteaseLog.info(
        `[一起听] 服务端推房间状态 曲=${event.songInfo.playSong ? "有" : "无"} 版本=${String(event.songInfo.version ?? "-")}`,
      );
      publish({ ...current, ...multiPlaybackFromSongInfo(event.songInfo) }, issuing);
      return;
    }

    // 房间挂起（30009）：服务端给的一条文案（网络异常、房间维护等），
    // 官方同样只把它显示成提示，不做状态变更
    if (event.kind === "roomSuspend") {
      if (event.text) errorListener?.(event.text);
      return;
    }

    // 房间操作（30008）：加歌/顶歌/切歌/删歌的正式信号，立刻拉一次权威状态。
    // 心跳要等 15 秒，只靠它的话队列变更会明显滞后
    if (event.kind === "roomOperate") {
      neteaseLog.info(
        `[一起听] 房间操作 type=${event.operateType} song=${event.songId} 版本=${event.version}`,
      );
      void refreshMultiRoom();
      return;
    }

    // 播放命令（40001）：多人房同样会收到，走与双人一致的解析结果
    if (event.kind === "playback") {
      neteaseLog.info(
        `[一起听] 收到播放命令 ${event.commandType} from=${event.senderId} target=${event.targetSongId || "-"}`,
      );
      void refreshMultiRoom();
      return;
    }

    // 服务端推的成员名单是权威快照（带昵称头像），直接采用：
    // 只映射已有成员的话，房间初始成员为空时永远是空列表，
    // 表现就是"进房了也不显示成员"
    if (event.kind === "members") {
      const current = room;
      if (!current || event.roomId !== current.roomId || event.members.length === 0) return;
      publish({ ...current, members: event.members }, issuing);
      return;
    }

    // 服务端生成的状态推送没有 senderId，不能当作回声过滤掉
    const sender =
      event.kind === "member" ? event.userId : "senderId" in event ? event.senderId : "";
    if (sender && sender === session.userId) return;
    void refreshMultiRoom();
  });
  neteaseLog.info("[一起听] 实时通道已连接");
  void refreshMembersFromIm(issuing);
};

/** 取云信凭据：失败返回 null，调用方按"没有实时通道"处理 */
const fetchImCredentials = async (): Promise<{ accId: string; token: string } | null> => {
  const response = await callNetease("middle_im_token_get", { bizName: "music_listenTogether" });
  const data = obj(obj((response as { body?: unknown })?.body)?.data);
  const accId = str(data?.accId);
  const token = str(data?.token);
  return accId && token ? { accId, token } : null;
};

/**
 * 心跳间隔（毫秒）。
 *
 * 服务端会通过 30000 下发 heartBeatDuration（秒），官方据此调整节奏；
 * 一直用固定值的话，服务端调长时我们会过度请求，调短时又跟不上
 */
let heartbeatMs = MULTI_HEARTBEAT_MS;

const startMultiTick = (): void => {
  if (timer) clearInterval(timer);
  timer = setInterval(() => void tick(), heartbeatMs);
};

/** 服务端下发的心跳间隔（秒）：与当前不同就重排定时器 */
const applyHeartBeatDuration = (seconds: number): void => {
  if (!Number.isFinite(seconds) || seconds <= 0) return;
  const next = Math.max(1000, Math.min(seconds * 1000, 60_000));
  if (next === heartbeatMs) return;
  heartbeatMs = next;
  neteaseLog.info(`[一起听] 心跳间隔调整为 ${seconds} 秒`);
  if (session) startMultiTick();
};

const tick = async (): Promise<void> => {
  if (!session || ticking) return;
  ticking = true;
  const issuing = generation;
  try {
    const response = await callNetease("listen_together_multi_heartbeat", {
      roomId: session.roomId,
    });
    if (!session || generation !== issuing) return;
    // 房间状态：Close(2)/End(3) 是服务端主动关房。只等 488 的话，
    // 房间结束后本地还会继续跑心跳与跟随
    const roomStatus = multiRoomStatusOf(response);
    if (roomStatus === 2 || roomStatus === 3) {
      neteaseLog.info(`[一起听] 房间已关闭（status=${roomStatus}）`);
      stop("server");
      return;
    }
    const next = roomFromResponse(response);
    if (next) publish(next, issuing);
  } catch (error) {
    if (generation !== issuing) return;
    if (isRoomGone(error)) {
      stop("server");
      return;
    }
    errorListener?.(str(obj(error)?.message) || "一起听心跳失败");
  } finally {
    ticking = false;
    if (refreshPending) {
      refreshPending = false;
      void tick();
    }
  }
};

export interface StrangerMatchResult {
  maxWaitMs: number;
  /** 已匹配到房间时直接给出：实测重复调用会返回 existedRoomId，无需推送通道 */
  roomId: string;
  roomType: string;
  /** 还在队列里等（重复查询时的正常状态，不是失败） */
  waiting: boolean;
}

/**
 * 创建多人房。实测只要 { type: 1, songId }，且 songId 必须是真实可播的歌曲；
 * 传 songId=0 会返回 failedType=MULTI_SONG_NOT_SATISFIED
 */
/**
 * 本曲播完时立刻拉一次心跳。
 * 房间的推进权在服务端，而心跳周期是 8 秒——不主动拉的话歌放完会先静音一段
 */
export const refreshMultiRoom = async (): Promise<void> => {
  if (!session) return;
  neteaseLog.info("[一起听] 主动拉取房间状态");
  // 心跳在途时直接 tick 会被 ticking 守卫吞掉，静默失去"播完立刻续上"的意义，
  // 改为留个待办，由当前这轮在 finally 里补一次
  if (ticking) {
    refreshPending = true;
    return;
  }
  await tick();
};

export const createMultiRoom = async (
  songId: string,
  userId: string,
): Promise<TogetherMultiRoom> => {
  const issuing = claimGeneration();
  const response = await callNetease("listen_together_multi_room_create", {
    type: 1,
    songId,
  });
  assertCurrent(issuing);
  const next = roomFromResponse(response);
  if (!next) throw new Error(failWith(response, "创建多人房失败"));
  return enterMultiRoom(next, userId);
};

/**
 * 开始（或查询）陌生人匹配。实测该接口可重复调用：
 * 未匹配到时返回 success=true；已匹配到房间时返回 failedType=ALREADY_IN_ROOM
 * 并带上 existedRoomId，因此轮询它即可代替官方推送
 */
/**
 * 查询配对结果（轮询用）。
 *
 * 与 startStrangerMatch 是同一个端点：官方就用它轮询——匹配成功时返回
 * failedType=MULTI_MATCH_ALREADY_IN_ROOM 并带 existedRoomId。
 * 单独一个入口是为了不把"发起匹配"的日志刷进每一轮轮询
 */
export const pollMatch = async (): Promise<boolean> => {
  const response = await callNetease("listen_together_song_match_start", {
    matchType: "match_start",
  });
  const body = obj(obj(response)?.body) ?? {};
  const data = obj(body.data) ?? {};
  const roomId = str(data.existedRoomId);
  if (roomId) {
    neteaseLog.info(`[一起听] 轮询到配对结果 room=${roomId.slice(0, 18)}`);
    return true;
  }
  // 已在队列里是正常状态；其余失败交给上层按"还在匹配"处理，
  // 单轮抖动不该终结整个匹配流程
  return false;
};

export const startStrangerMatch = async (): Promise<StrangerMatchResult> => {
  // 匹配没有界面之外的反馈，出问题时只能靠日志定位，这里记下服务端的原始答复
  neteaseLog.info("[一起听] 发起双人匹配");
  const response = await callNetease("listen_together_song_match_start", {
    matchType: "match_start",
  });
  const body = obj(obj(response)?.body) ?? {};
  const data = obj(body.data) ?? {};
  const roomId = str(data.existedRoomId);
  const roomType = str(data.existedRoomType);
  const failedType = str(data.failedType);
  // ALREADY_IN_MATCH 是"已在匹配队列里"，属于重复查询的正常状态：
  // 抛错会让轮询直接中断，界面上还会弹一个看不懂的错误
  if (!roomId && failedType === "ALREADY_IN_MATCH") {
    return { maxWaitMs: Number(data.maxWaitTimeMills) || 0, roomId: "", roomType, waiting: true };
  }
  if (!roomId && data.success !== true) {
    throw new Error(str(data.failedMsg) || failedType || "开始匹配失败");
  }
  return {
    maxWaitMs: Number(data.maxWaitTimeMills) || 0,
    roomId,
    roomType,
    waiting: !roomId,
  };
};

/**
 * 确认配对结果。
 *
 * 配对成功后必须回一次 ack 才算真正进房，否则服务端按 ACK 等待超时把人踢出去
 * （常量表里的 MULTI_MATCH_WAIT_ACK_TIMEOUT 就是这条超时）。
 * 官方靠 IM 点对点推送拿到 roomId；匹配等待发生在进房前、聊天室尚未连上，
 * 所以我们沿用轮询 start 接口带回的 existedRoomId，进房后同步即切 IM 推送
 */
/** 多人配对确认：同上，配对成功后必须回一次 ack 才算进房 */
export const ackMultiMatch = async (roomId: string): Promise<void> => {
  if (!roomId) return;
  // 配对确认同样要 checkToken：实测缺它服务端直接 400
  const response = await callNetease("listen_together_multi_ack", {
    roomId,
    agree: true,
    checkToken: await fetchCheckToken(),
  });
  const body = obj(obj(response)?.body) ?? {};
  neteaseLog.info(`[一起听] 已确认多人配对 room=${roomId.slice(0, 18)} code=${body.code}`);
};

/**
 * 处理配对通知（type=20022）。
 *
 * 官方的陌生人匹配是"服务端推配对 → 客户端立刻 ack"：
 * 服务端等 ACK 的窗口很短，等下一轮轮询再 ack 会直接报 488（房间已失效），
 * 表现就是"匹配到了但进不去"。这里收到就 ack，窗口内完成握手。
 * APPLY 是"有人申请"，AGREE 才是"对方已同意"，只有后者要进房
 */
const handleMatchLock = async (event: { matchType: string; roomId: string }): Promise<void> => {
  if (event.matchType !== "AGREE" || !event.roomId) {
    neteaseLog.info(`[一起听] 配对申请 room=${event.roomId.slice(0, 18)}`);
    return;
  }
  neteaseLog.info(`[一起听] 收到配对通知，立即确认 room=${event.roomId.slice(0, 18)}`);
  await ackStrangerMatch(event.roomId).catch((error: unknown) => {
    neteaseLog.warn(`一起听配对确认失败：${String(error)}`);
  });
};

/**
 * 挂上个人通道。
 *
 * 陌生人匹配的配对通知（type=20022）发生在还没有房间的阶段，只能从个人通道收到；
 * 官方客户端登录时就挂着它。只靠轮询发现房间会错过服务端的 ACK 等待窗口，
 * 表现为"匹配到了但进不去"
 */
export const openPersonalChannel = async (): Promise<void> => {
  if (personalChannelIssuing) return;
  const response = await callNetease("middle_im_token_get", { bizName: "music_listenTogether" });
  const data = obj(obj((response as { body?: unknown })?.body)?.data);
  const accId = str(data?.accId);
  const token = str(data?.token);
  if (!accId || !token) throw new Error("未取到云信凭据");
  const { join } = await import("node:path");
  const { tmpdir } = await import("node:os");
  await connectPersonalChannel({
    accId,
    token,
    dataDir: join(tmpdir(), `splayer-nim-personal-${process.pid}`),
  });
  personalChannelIssuing = true;
  neteaseLog.info("[一起听] 个人通道已连接（用于接收匹配配对通知）");
};

export const closePersonalChannel = (): void => {
  if (!personalChannelIssuing) return;
  disconnectPersonalChannel();
  personalChannelIssuing = false;
};

let personalChannelIssuing = false;

export const ackStrangerMatch = async (roomId: string): Promise<void> => {
  if (!roomId) return;
  const response = await callNetease("listen_together_song_match_ack", {
    roomId,
    agree: true,
  });
  const body = obj(obj(response)?.body) ?? {};
  neteaseLog.info(`[一起听] 已确认配对 room=${roomId.slice(0, 18)} code=${body.code}`);
};

export const cancelStrangerMatch = async (): Promise<void> => {
  await callNetease("listen_together_song_match_cancel", {});
};

export interface MultiMatchState {
  matching: boolean;
  maxWaitMs: number;
  roomId: string;
}

/**
 * 多人匹配。实测参数是 { songId, checkToken: "null" }，
 * 与双人匹配（song/match/start 的 matchType）是两套
 */
export const startMultiMatch = async (songId: string): Promise<MultiMatchState> => {
  neteaseLog.info(`[一起听] 发起多人匹配 song=${songId || "-"}`);
  const response = await callNetease("listen_together_multi_match", {
    songId: songId || "0",
    checkToken: "null",
  });
  const body = obj(obj(response)?.body) ?? {};
  const data = obj(body.data) ?? {};
  const roomId = str(data.existedRoomId);
  // success:false 是服务端的拒绝（如 ALREADY_IN_MATCH，两种匹配共用同一份匹配状态），
  // 只判 code 会把它当成"还没匹配到"，界面白轮询三分钟才报没找到人
  if (!roomId && data.success !== true) {
    throw new Error(str(data.failedMsg) || str(data.failedType) || "开始多人匹配失败");
  }
  return {
    matching: true,
    maxWaitMs: Number(data.maxWaitTimeMills) || 0,
    roomId,
  };
};

export const cancelMultiMatch = async (): Promise<void> => {
  await callNetease("listen_together_multi_match_cancel", {});
};

/**
 * 加入多人房。multi/room/create 端点确实存在，但参数未知（试遍常见组合都是 400），
 * 所以目前只能走接受邀请这条已验证的路
 * 分享链接里的 inviterUid 是服务端校验项，缺了会被拒
 */
export const joinMultiRoom = async (
  roomId: string,
  inviterUid: string,
  userId: string,
  deviceId: string,
): Promise<TogetherMultiRoom> => {
  const issuing = claimGeneration();
  // checkToken 是必需的且一次性：每次加入都要现取，复用会被判重（491）
  const response = await callNetease("listen_together_multi_ack", {
    roomId,
    inviterUid,
    deviceId,
    checkToken: await fetchCheckToken(),
  });
  assertCurrent(issuing);
  const body = obj(obj(response)?.body) ?? {};
  const data = obj(body.data) ?? {};
  if (body.code !== 200 || data.success === false) {
    throw new Error(failWith(response, "加入多人群房失败"));
  }
  const next = roomFromResponse(response);
  if (!next) throw new Error("加入多人群房失败：未返回房间信息");
  return enterMultiRoom({ ...next, roomId: next.roomId || roomId }, userId);
};

/** 应用重启后服务端仍在多人房里时恢复，房间状态交给第一次心跳拉取 */
export const restoreMultiRoom = async (userId: string): Promise<TogetherMultiRoom | null> => {
  const issuing = claimGeneration();
  const response = await callNetease("listen_together_multi_status_get", {});
  assertCurrent(issuing);
  if (codeOf(response) !== 200) return null;
  const next = roomFromResponse(response);
  if (!next) return null;
  const room = enterMultiRoom(next, userId);
  // 快照里的 playSong 可能为空，当前歌曲要等心跳。不立即拉一次的话，
  // 恢复后要等一个心跳周期（8 秒）才开始跟随
  void tick();
  return room;
};

/**
 * 账号对陌生人的可见性开关。实测 privacyKey 只接受 listening_entrance，
 * 值域 0/1：0 对应 visibleStatus=0（隐藏），1 对应 visibleStatus=2（公开）
 */
export const getStrangerVisible = async (): Promise<boolean> => {
  const response = await callNetease("listen_together_listening_privacy_get", {});
  const body = obj(obj(response)?.body) ?? {};
  const data = obj(body.data) ?? {};
  const status = Number(data.visibleStatus);
  // 字段缺失时不能当成"公开"：这是账号级隐私开关，宁可显示为关闭
  return Number.isFinite(status) && status !== 0;
};

export const setStrangerVisible = async (visible: boolean): Promise<void> => {
  const response = await callNetease("listen_together_listening_privacy_update", {
    privacyKey: "listening_entrance",
    value: visible ? 1 : 0,
  });
  const body = obj(obj(response)?.body) ?? {};
  if (body.code !== 200) throw new Error(str(body.message) || "修改可见性失败");
};

/** 多人房站内邀请。实测 {roomId, inviteUids, groupIds} 是正确参数组合 */
export const inviteToMultiRoom = async (uids: readonly string[]): Promise<void> => {
  if (uids.length === 0) return;
  // 静默返回会让上层的"已邀请 N 位好友"变成假成功
  if (!session) throw new Error("已不在房间里，无法邀请");
  const response = await callNetease("listen_together_multi_invite", {
    roomId: session.roomId,
    inviteUids: [...uids],
    groupIds: "",
  });
  const body = obj(obj(response)?.body) ?? {};
  if (body.code !== 200) {
    throw new Error(str(body.message) || "邀请失败");
  }
};

export const exitMultiRoom = async (): Promise<void> => {
  const current = session;
  if (!current) return;
  stop("left");
  await callNetease("listen_together_multi_exit", {
    roomId: current.roomId,
    exitType: "NORMAL_END",
  });
};

export const endMultiOnLogout = (): void => {
  stop("logout");
};

const operate = async (
  songId: string,
  songBizId: number,
  action: number,
): Promise<TogetherRoomOperateResult> => {
  // 不是"被服务端否决"：请求可能压根没发出去，别让界面弹出与事实相反的原因
  if (!session) return { room: null, message: "", rejected: false };
  const issuing = generation;
  const response = await callNetease("listen_together_multi_song_operate", {
    roomId: session.roomId,
    songId,
    bizId: songBizId,
    operate: action,
  });
  if (generation !== issuing) return { room: null, message: "", rejected: false };
  const body = obj(obj(response)?.body) ?? {};
  const data = obj(body.data) ?? {};
  // 官方失败码（LTMultiSongOperateResultCode）：服务端文案不可控，
  // 这几类"点太快/切换中/点的是已播完"要用自己的措辞，
  // 否则用户看到"已是完播歌曲"会以为界面状态错了
  const failedCode = Number(data.failedCode) || 0;
  const message = OPERATE_FAILED_HINT[failedCode] || str(data.failedMsg);
  // 服务端否决（歌已播完、太频繁、不是自己加的等）是正常业务结果而非异常：
  // 抛异常会变成 IPC handler 错误，界面拿不到原因，用户只看到"点了没反应"
  const rejected = data.result === false;
  // operate 的响应没有 roomInfo/multiLtRoomSnapshot，只有 roomSongInfo。
  // 之前只看前者会解析成 null，于是加歌成功但界面不更新
  // 即使操作被拒，响应里的房间状态仍是权威的：它告诉我们"服务端此刻认为在播哪首"。
  // 只在不被拒时更新的话，本地 playSong 会停在旧值——用户再点切歌就是对旧歌投票，
  // 服务端回"已播完"，界面与房间越来越偏
  const next = applyOperateResult(response);
  if (next) publish(next, issuing);
  // 文案一律透出：投票可能是"记了一票"、"太频繁"或"切歌成功"，都要让用户看到
  return { room: next, message, rejected };
};

/**
 * operate 系列只回 roomSongInfo（当前曲 + 待播），没有房间快照。
 * 把它合并进缓存里的房间，让界面立刻反映加歌/删歌/置顶的结果
 */
const applyOperateResult = (response: unknown): TogetherMultiRoom | null => {
  const fromSnapshot = roomFromResponse(response);
  if (fromSnapshot) return fromSnapshot;
  const body = obj(obj(response)?.body) ?? {};
  const data = obj(body.data) ?? {};
  const songInfo = obj(data.roomSongInfo);
  if (!songInfo || !room) return null;
  // 不能走 roomFromResponse：它要求 roomId，而 roomSongInfo 里没有
  const playSong = obj(songInfo.playSong);
  return {
    ...room,
    playSong: playSong ? toRoomSong(playSong) : null,
    nextSongs: list(songInfo.nextSongs).map(toRoomSong),
    playProgress: Number(songInfo.playedTime) || room.playProgress,
    sampledAt: Date.now(),
    playDuration: Number(songInfo.songDuration) || room.playDuration,
    forceSync: songInfo.forceSync === true,
    playVersion: Number(songInfo.version) || room.playVersion,
  };
};

export const addMultiSong = (songId: string, songBizId = 0): Promise<TogetherRoomOperateResult> =>
  operate(songId, songBizId, OPERATE_ADD);

/** 投票切歌。人数够时服务端直接切走，不够时记一票 */
export const voteSkipMultiSong = (
  songId: string,
  songBizId = 0,
): Promise<TogetherRoomOperateResult> => operate(songId, songBizId, OPERATE_VOTE_SKIP);

/** 删除只对「待播」状态的歌曲生效，正在播的那首会被服务端拒绝 */
export const removeMultiSong = (
  songId: string,
  songBizId = 0,
): Promise<TogetherRoomOperateResult> => operate(songId, songBizId, OPERATE_DELETE);

export const topMultiSong = (songId: string, songBizId = 0): Promise<TogetherRoomOperateResult> =>
  operate(songId, songBizId, OPERATE_TOP);
