/**
 * 一起听同步判定
 *
 * 房间协议是「轮询快照 + 上报命令」：两台客户端各自每秒拉一次服务端状态，
 * 同一条命令会被反复看到，自己上报的动作也会随快照回来。这里集中处理去重、
 * 回声抑制与本地变化识别，保持与网络、播放器无关。
 */

import type {
  TogetherCommand,
  TogetherLocalState,
  TogetherSnapshot,
} from "@shared/types/listenTogether";

/** 应用远端命令后暂停上报的时长（毫秒），避免把自己的照做当成新动作回传 */
export const REPORT_SUPPRESS_MS = 1800;

/** 自然播完后等待对端推进的时长（毫秒），超时由本机接管 */
export const ADVANCE_HANDOVER_MS = 3500;

/** 轮询间隔（毫秒），与官方客户端同步节奏一致 */
export const SYNC_INTERVAL_MS = 1000;

/** 心跳节拍数 */
export const HEARTBEAT_TICKS = 5;

/** 队列签名，顺序敏感 */
export const songIdsSignature = (ids: readonly (string | number)[]): string => ids.join(",");

/**
 * 命令指纹
 * @param command - 服务端命令
 * @returns 足以区分两条命令的字符串，无命令时为空串
 */
export const commandSignature = (command: TogetherCommand | null): string => {
  if (!command) return "";
  return [
    command.userId,
    command.serverSeq,
    command.type,
    command.targetSongId,
    command.progressMs,
    command.playing,
  ].join("|");
};

/**
 * 判断远端命令是否需要本机响应
 * @param command - 服务端命令
 * @param lastSignature - 上次已应用的命令指纹
 * @param lastSeq - 上次已应用的服务端序号
 * @param selfUserId - 本机用户 ID
 * @returns 需要响应时返回 true
 */
export const isFreshCommand = (
  command: TogetherCommand | null,
  lastSignature: string,
  lastSeq: number,
  selfUserId: string,
): boolean => {
  if (!command || !command.userId || command.userId === selfUserId) return false;
  if (commandSignature(command) === lastSignature) return false;
  if (command.serverSeq && command.serverSeq < lastSeq) return false;
  return true;
};

/** 上一次已上报的本地基线 */
export interface LocalBaseline {
  queueSignature: string;
  songId: string;
  playing: boolean;
  seekRevision: number;
  endRevision: number;
}

/** 本地相对基线的变化 */
export type LocalChange = "queue" | "track" | "progress" | "playState" | "ended";

/**
 * 生成本地基线
 * @param state - 渲染端上报的播放状态
 * @returns 供下一轮比较的基线
 */
export const baselineOf = (state: TogetherLocalState): LocalBaseline => ({
  queueSignature: songIdsSignature(state.queueSongIds),
  songId: state.songId,
  playing: state.playing,
  seekRevision: state.seekRevision,
  endRevision: state.endRevision,
});

export interface LocalDelta {
  /** 更新后的基线 */
  baseline: LocalBaseline;
  /** 需要上报的变化，空数组表示无事发生 */
  changes: LocalChange[];
}

/**
 * 识别本地相对基线的变化
 *
 * 队列与切歌可能同时出现：对端换了一批歌并且选中的那首也变了。此时以切歌为主，
 * 队列上报由调用方另行处理。
 * @param state - 渲染端上报的播放状态
 * @param baseline - 上一次的基线
 * @returns 新基线与变化列表
 */
export const detectLocalChanges = (
  state: TogetherLocalState,
  baseline: LocalBaseline,
): LocalDelta => {
  const next = baselineOf(state);
  const changes: LocalChange[] = [];
  if (next.queueSignature !== baseline.queueSignature && state.queueSongIds.length > 0) {
    changes.push("queue");
  }
  if (next.endRevision !== baseline.endRevision) changes.push("ended");
  if (!next.songId) return { baseline: next, changes };
  if (next.songId !== baseline.songId) changes.push("track");
  else if (next.seekRevision !== baseline.seekRevision) changes.push("progress");
  else if (next.playing !== baseline.playing) changes.push("playState");
  return { baseline: next, changes };
};

/**
 * 判断快照里的共享队列是否与本机不同
 * @param snapshot - 服务端快照
 * @param localQueueIds - 本机队列歌曲 ID
 * @returns 需要整体替换队列时返回 true
 */
export const needsQueueReplace = (
  snapshot: TogetherSnapshot,
  localQueueIds: readonly string[],
): boolean =>
  snapshot.songIds.length > 0 &&
  songIdsSignature(snapshot.songIds) !== songIdsSignature(localQueueIds);
