import { callNetease } from "@main/apis/netease";
import { multiRoomFromBody, obj, str } from "@main/utils/togetherParse";
import type { TogetherMultiRoom } from "@shared/types/listenTogether";

// 多人群房的心跳是「拉取」：房间当前歌曲与队列来自响应，不像双人那样靠心跳上报。
// 跟随完全依赖它，所以间隔比双人短
export const MULTI_HEARTBEAT_MS = 8000;

const ROOM_GONE_CODE = 488;

const OPERATE_ADD = 1;

const OPERATE_TOP = 2;

const OPERATE_SWITCH = 4;

export interface TogetherMultiSession {
  roomId: string;
  userId: string;
  generation: number;
}

type RoomListener = (room: TogetherMultiRoom, generation: number) => void;

type EndListener = (reason: "left" | "server" | "logout", generation: number) => void;

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

const stop = (reason: "left" | "server" | "logout"): void => {
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

/**
 * 多人房没有建房接口，只能靠接受邀请进入。
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
): Promise<TogetherMultiRoom | null> => {
  if (!session) return null;
  const issuing = generation;
  const response = await callNetease("listen_together_multi_song_operate", {
    roomId: session.roomId,
    songId,
    bizId: songBizId,
    operate: action,
  });
  if (generation !== issuing) return null;
  const body = obj(obj(response)?.body) ?? {};
  const data = obj(body.data) ?? {};
  // 服务端有权否决（歌不可播、房间策略等），原因必须透出去而不是静默失败
  if (data.result === false) throw new Error(str(data.failedMsg) || "操作失败");
  const next = roomFromResponse(response);
  if (next) publish(next, issuing);
  return next;
};

export const addMultiSong = (songId: string, songBizId = 0): Promise<TogetherMultiRoom | null> =>
  operate(songId, songBizId, OPERATE_ADD);

export const topMultiSong = (songId: string, songBizId = 0): Promise<TogetherMultiRoom | null> =>
  operate(songId, songBizId, OPERATE_TOP);

export const switchMultiSong = (songId: string, songBizId = 0): Promise<TogetherMultiRoom | null> =>
  operate(songId, songBizId, OPERATE_SWITCH);
