/**
 * 一起听：房间状态机的响应解析
 *
 * 服务端的字段命名在不同接口间并不统一（roomInfo/users、playCommand/commandInfo），
 * 这里统一归一化，避免状态机里重复写字面量。
 */

import type {
  TogetherCommand,
  TogetherCommandType,
  TogetherMember,
  TogetherRoom,
  TogetherSnapshot,
} from "@shared/types/listenTogether";

type Json = Record<string, unknown>;

export const obj = (value: unknown): Json | null =>
  value && typeof value === "object" && !Array.isArray(value) ? (value as Json) : null;

const list = (value: unknown): unknown[] => (Array.isArray(value) ? value : []);

export const str = (value: unknown): string => (value == null ? "" : String(value));

const num = (value: unknown): number => {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : 0;
};

/**
 * 取响应体
 *
 * `callNetease` 返回的是 `{ status, body }` 包装，取包后的字段必须从这里读；
 * 只在包装层看不出来时才把入参当成响应体本身，便于单测直接传 body。
 * @param value - callNetease 返回值或裸响应体
 * @returns 响应体
 */
const unwrap = (value: unknown): unknown => {
  const root = obj(value);
  if (root && obj(root.body)) return root.body;
  return value;
};

const toMember = (raw: unknown): TogetherMember => {
  const item = obj(raw) ?? {};
  return {
    userId: str(item.userId),
    nickname: str(item.nickname),
    avatarUrl: str(item.avatarUrl),
  };
};

/**
 * 归一化房间信息
 * @param raw - roomInfo 或 data 本体
 * @returns 房间信息，缺 roomId 时返回 null
 */
export const toRoom = (raw: unknown): TogetherRoom | null => {
  const room = obj(raw);
  if (!room) return null;
  const roomId = str(room.roomId);
  if (!roomId) return null;
  const users = list(room.roomUsers).length ? list(room.roomUsers) : list(room.users);
  return {
    roomId,
    creatorId: str(room.creatorId),
    members: users.map(toMember).filter((member) => member.userId),
  };
};

/**
 * 从接口响应解析房间
 * @param value - callNetease 返回值
 * @returns 房间信息，缺失时为 null
 */
export const roomFromBody = (value: unknown): TogetherRoom | null => {
  const root = obj(unwrap(value));
  const data = obj(root?.data) ?? root;
  return toRoom(data?.roomInfo) ?? toRoom(data);
};

/**
 * 归一化播放命令
 *
 * 服务端会把发起方的 playStatus 一并放进命令里，即使是只描述时间轴的 PROGRESS。
 * 这里先按类型判定语义，再让显式的 PAUSE 覆盖：PROGRESS 恒为「不改播放态」，
 * 其余命令只有在对端明确处于暂停时才不跟随播放。
 * @param raw - playCommand / commandInfo
 * @returns 播放命令，缺 commandType 时返回 null
 */
export const toCommand = (raw: unknown): TogetherCommand | null => {
  const command = obj(raw);
  if (!command) return null;
  const type = str(command.commandType).toUpperCase() as TogetherCommandType;
  if (!type) return null;
  const playStatus = str(command.playStatus).toUpperCase();
  const targetSongId = str(command.targetSongId);
  const paused = type === "PAUSE" || playStatus === "PAUSE";
  return {
    userId: str(command.userId),
    type,
    formerSongId: str(command.formerSongId),
    targetSongId: targetSongId === "0" ? "" : targetSongId,
    progressMs: Math.max(0, num(command.progress)),
    playing: type !== "PROGRESS" && !paused,
    serverSeq: num(command.serverSeq),
  };
};

/**
 * 解析房间快照
 * @param value - callNetease 返回值
 * @returns 共享队列与最近一条播放命令
 */
export const snapshotFromBody = (value: unknown): TogetherSnapshot => {
  const data = obj(obj(unwrap(value))?.data);
  if (!data) return { songIds: [], command: null };
  const playlist = obj(data.playlist) ?? {};
  const mode = str(playlist.playMode).toUpperCase();
  const shuffled = mode.includes("RANDOM") || mode.includes("SHUFFLE");
  const source = (shuffled ? obj(playlist.randomList) : null) ?? obj(playlist.displayList) ?? {};
  return {
    songIds: list(source.result)
      .map((id) => str(id))
      .filter((id) => id !== "" && id !== "0"),
    command: toCommand(data.playCommand ?? data.commandInfo),
  };
};

/**
 * 解析房间状态
 * @param value - callNetease 返回值
 * @returns 是否在房间内与房间信息
 */
export const statusFromBody = (value: unknown): { inRoom: boolean; room: TogetherRoom | null } => {
  const data = obj(obj(unwrap(value))?.data);
  if (!data) return { inRoom: false, room: null };
  return { inRoom: Boolean(data.inRoom), room: toRoom(data.roomInfo) };
};

/**
 * 判断房间是否可加入
 * @param value - callNetease 返回值
 * @returns 可加入时返回 true
 */
export const joinableFromBody = (value: unknown): boolean =>
  Boolean(obj(obj(unwrap(value))?.data)?.joinable);
