import { callNetease } from "@main/apis/netease";
import { multiRoomFromBody, obj, str } from "@main/utils/togetherParse";
import type {
  TogetherMultiEndReason,
  TogetherMultiRoom,
  TogetherMultiSession,
  TogetherRoomOperateResult,
  TogetherRoomSongList,
} from "@shared/types/listenTogether";

// 多人群房的心跳是「拉取」：房间当前歌曲与队列来自响应，不像双人那样靠心跳上报。
// 跟随完全依赖它，所以间隔比双人短
export const MULTI_HEARTBEAT_MS = 8000;

const ROOM_GONE_CODE = 488;

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
let roomKey = "";
let generation = 0;
let timer: ReturnType<typeof setInterval> | null = null;
let ticking = false;

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

const songKeyOf = (room: TogetherMultiRoom): string =>
  [room.playSong?.songId ?? "", ...room.nextSongs.map((song) => song.songId)].join(",");

const publish = (next: TogetherMultiRoom, issuing: number): void => {
  if (generation !== issuing) return;
  room = next;
  roomKey = songKeyOf(next);
  roomListener?.(next, issuing);
};

// 房间队列没变时不重复推给渲染端：8 秒一次心跳，每次都推会让播放器反复重建队列
const publishIfChanged = (next: TogetherMultiRoom, issuing: number): void => {
  if (songKeyOf(next) === roomKey) return;
  publish(next, issuing);
};

const stop = (reason: TogetherMultiEndReason): void => {
  if (!session) return;
  const ended = session;
  generation += 1;
  session = null;
  room = null;
  roomKey = "";
  if (timer) clearInterval(timer);
  timer = null;
  endListener?.(reason, ended.generation);
};

const roomFromResponse = (value: unknown): TogetherMultiRoom | null => multiRoomFromBody(value);

const codeOf = (value: unknown): number => {
  const body = obj(obj(value)?.body) ?? {};
  return Number(body.code) || 0;
};

const isRoomGone = (error: unknown): boolean => {
  if (codeOf(obj(error)) === ROOM_GONE_CODE) return true;
  const message = str(obj(error)?.message);
  return message.includes("房间") && message.includes("失效");
};

const failWith = (value: unknown, fallback: string): string => {
  const body = obj(obj(value)?.body) ?? {};
  const data = obj(body.data) ?? {};
  return str(data.failedMessage) || str(body.message) || fallback;
};

export const startMultiTick = (): void => {
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
    if (next) publishIfChanged(next, issuing);
  } catch (error) {
    if (generation !== issuing) return;
    if (isRoomGone(error)) {
      stop("server");
      return;
    }
    errorListener?.(str(obj(error)?.message) || "一起听心跳失败");
  } finally {
    ticking = false;
  }
};

export interface StrangerMatchResult {
  maxWaitMs: number;
  /** 已匹配到房间时直接给出：实测重复调用会返回 existedRoomId，无需推送通道 */
  roomId: string;
  roomType: string;
}

/**
 * 开始（或查询）陌生人匹配。实测该接口可重复调用：
 * 未匹配到时返回 success=true；已匹配到房间时返回 failedType=ALREADY_IN_ROOM
 * 并带上 existedRoomId，因此轮询它即可代替官方推送
 */
export const startStrangerMatch = async (): Promise<StrangerMatchResult> => {
  const response = await callNetease("listen_together_song_match_start", {
    matchType: "match_start",
  });
  const body = obj(obj(response)?.body) ?? {};
  const data = obj(body.data) ?? {};
  const roomId = str(data.existedRoomId);
  const roomType = str(data.existedRoomType);
  if (!roomId && data.success !== true) {
    throw new Error(str(data.failedMsg) || str(data.failedType) || "开始匹配失败");
  }
  return { maxWaitMs: Number(data.maxWaitTimeMills) || 0, roomId, roomType };
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
  const response = await callNetease("listen_together_multi_match", {
    songId: songId || "0",
    checkToken: "null",
  });
  const body = obj(obj(response)?.body) ?? {};
  const data = obj(body.data) ?? {};
  if (body.code !== 200) {
    throw new Error(str(body.message) || "开始多人匹配失败");
  }
  return {
    matching: data.success === true,
    maxWaitMs: Number(data.maxWaitTimeMills) || 0,
    roomId: str(data.existedRoomId),
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
  if (session) stop("left");
  const issuing = generation + 1;
  generation = issuing;
  const response = await callNetease("listen_together_multi_ack", {
    roomId,
    inviterUid,
    deviceId,
  });
  const body = obj(obj(response)?.body) ?? {};
  const data = obj(body.data) ?? {};
  if (body.code !== 200 || data.success === false) {
    generation = issuing + 1;
    throw new Error(failWith(response, "加入多人群房失败"));
  }
  const next = roomFromResponse(response);
  if (!next) {
    generation = issuing + 1;
    throw new Error("加入多人群房失败：未返回房间信息");
  }
  session = { roomId: next.roomId || roomId, userId, generation: issuing };
  publish(next, issuing);
  startMultiTick();
  return next;
};

/** 应用重启后服务端仍在多人房里时恢复，房间状态交给第一次心跳拉取 */
export const restoreMultiRoom = async (userId: string): Promise<TogetherMultiRoom | null> => {
  const response = await callNetease("listen_together_multi_status_get", {});
  if (codeOf(response) !== 200) return null;
  const next = roomFromResponse(response);
  if (!next) return null;
  const issuing = generation + 1;
  generation = issuing;
  session = { roomId: next.roomId, userId, generation: issuing };
  publish(next, issuing);
  startMultiTick();
  return next;
};

/**
 * 房间完整歌曲列表。比 heartbeat 的 playSong+nextSongs（短窗口）权威：
 * 后者只给当前曲与接下来几首。追随者字段可看出每首歌是谁加的
 */
export const roomSongsList = async (): Promise<TogetherRoomSongList> => {
  if (!session) return { songIds: [], followers: [] };
  const response = await callNetease("listen_together_room_songs_list", {
    roomId: session.roomId,
  });
  const body = obj(obj(response)?.body) ?? {};
  const data = obj(body.data) ?? {};
  const songIds = Array.isArray(data.songIds) ? data.songIds.map((id) => str(id)) : [];
  const followers = (Array.isArray(data.followers) ? data.followers : [])
    .map((item) => {
      const raw = obj(item) ?? {};
      return {
        userId: str(raw.userId ?? raw.uid),
        nickname: str(raw.nickname),
        avatarUrl: str(raw.avatarUrl || raw.avatar),
      };
    })
    .filter((member) => member.userId);
  return { songIds, followers };
};

export const exitMultiRoom = async (): Promise<void> => {
  const current = session;
  if (!current) return;
  stop("left");
  await callNetease("listen_together_multi_exit", { roomId: current.roomId });
};

export const endMultiOnLogout = (): void => {
  stop("logout");
};

const operate = async (
  songId: string,
  songBizId: number,
  action: number,
): Promise<TogetherRoomOperateResult> => {
  if (!session) return { room: null, message: "" };
  const issuing = generation;
  const response = await callNetease("listen_together_multi_song_operate", {
    roomId: session.roomId,
    songId,
    bizId: songBizId,
    operate: action,
  });
  if (generation !== issuing) return { room: null, message: "" };
  const body = obj(obj(response)?.body) ?? {};
  const data = obj(body.data) ?? {};
  const message = str(data.failedMsg);
  // 服务端有权否决（歌不可播、房间策略等），原因必须透出去而不是静默失败
  if (data.result === false) throw new Error(message || "操作失败");
  const next = roomFromResponse(response);
  if (next) publish(next, issuing);
  // 成功的文案也要带出去：投票可能是"记了一票"而非"已切歌"，
  // 用户需要知道自己这一票的效果（如"有足够多的人不想听，切歌成功！"）
  return { room: next, message };
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
