import { callNetease } from "@main/apis/netease";
import {
  connectNimRoom,
  disconnectNimRoom,
  setNimPlaybackListener,
} from "@main/services/nim/realtime";
import { setMultiRoomActive } from "@main/services/togetherPresence";
import { neteaseLog } from "@main/utils/logger";
import { list, multiRoomFromBody, obj, str, toRoomSong } from "@main/utils/togetherParse";
import type {
  TogetherMultiEndReason,
  TogetherMultiRoom,
  TogetherMultiSession,
  TogetherRoomOperateResult,
} from "@shared/types/listenTogether";

// 多人群房的心跳是「拉取」：房间当前歌曲与队列来自响应，不像双人那样靠心跳上报。
// 跟随完全依赖它，所以间隔比双人短
export const MULTI_HEARTBEAT_MS = 8000;

const ROOM_GONE_CODE = 488;

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

export const getMultiRoom = (): TogetherMultiRoom | null => room;

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
  void openRealtime(next, issuing);
  return next;
};

/**
 * 尝试把房间的实时通道接起来。
 *
 * 播放指令走云信长连接，接上后能立即收到对端操作；接不上就继续用心跳轮询，
 * 所以这里任何失败都只记日志，不改房间状态
 */
const openRealtime = async (room: TogetherMultiRoom, issuing: number): Promise<void> => {
  try {
    const credentials = await fetchImCredentials();
    if (!credentials || generation !== issuing || !session) return;
    await connectNimRoom({
      roomId: room.roomId,
      chatRoomId: room.chatRoomId,
      accId: credentials.accId,
      token: credentials.token,
    });
    if (generation !== issuing) return;
    // 对端操作立刻到了：直接刷新一次心跳拿到权威队列与播放态，
    // 不必等下一个心跳周期，这样切歌/暂停的延迟从数秒降到几乎无感
    setNimPlaybackListener((event) => {
      if (!session || generation !== issuing) return;
      if (event.senderId && event.senderId === session.userId) return;
      void refreshMultiRoom();
    });
    neteaseLog.info("[一起听] 实时通道已连接");
  } catch (error) {
    neteaseLog.info(`[一起听] 实时通道不可用，继续用轮询：${str(obj(error)?.message)}`);
  }
};

/** 取云信凭据：失败返回 null，调用方按"没有实时通道"处理 */
const fetchImCredentials = async (): Promise<{ accId: string; token: string } | null> => {
  const response = await callNetease("middle_im_token_get", { bizName: "music_listenTogether" });
  const data = obj(obj((response as { body?: unknown })?.body)?.data);
  const accId = str(data?.accId);
  const token = str(data?.token);
  return accId && token ? { accId, token } : null;
};

const startMultiTick = (): void => {
  if (timer) clearInterval(timer);
  timer = setInterval(() => void tick(), MULTI_HEARTBEAT_MS);
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
 * 官方靠 IM 推送拿到 roomId 后调用，我们没接 IM，改用轮询 start 接口带回的 existedRoomId
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
  const message = str(data.failedMsg);
  // 服务端否决（歌已播完、太频繁、不是自己加的等）是正常业务结果而非异常：
  // 抛异常会变成 IPC handler 错误，界面拿不到原因，用户只看到"点了没反应"
  const rejected = data.result === false;
  // operate 的响应没有 roomInfo/multiLtRoomSnapshot，只有 roomSongInfo。
  // 之前只看前者会解析成 null，于是加歌成功但界面不更新
  const next = applyOperateResult(response);
  if (!rejected && next) publish(next, issuing);
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
