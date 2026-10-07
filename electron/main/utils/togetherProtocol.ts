import type {
  TogetherCommand,
  TogetherLocalState,
  TogetherSnapshot,
} from "@shared/types/listenTogether";

export const ADVANCE_HANDOVER_MS = 3500;

/** 本地状态检测周期：只做本地比对，不产生 HTTP 请求 */
export const SYNC_INTERVAL_MS = 1000;

/** 拉取房间播放列表（sync/playlist/get）的间隔：每 4 个 tick 一次。
 *  1 秒一次是每秒一个请求，参考实现用的是 4 秒——这是延迟与风控的取舍点 */
export const SNAPSHOT_POLL_TICKS = 4;

/** 心跳 + 房间存活性探测间隔：参考实现用 20s 心跳 / 15s 状态，这里统一 15s */
export const HEARTBEAT_TICKS = 15;

export const songIdsSignature = (ids: readonly (string | number)[]): string => ids.join(",");

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

export interface LocalBaseline {
  queueSignature: string;
  songId: string;
  playing: boolean;
  seekRevision: number;
  endRevision: number;
  playMode: string;
}

type LocalChange = "queue" | "track" | "progress" | "playState" | "ended" | "playMode";

export const baselineOf = (state: TogetherLocalState): LocalBaseline => ({
  queueSignature: songIdsSignature(state.queueSongIds),
  songId: state.songId,
  playing: state.playing,
  seekRevision: state.seekRevision,
  endRevision: state.endRevision,
  playMode: state.playMode,
});

interface LocalDelta {
  baseline: LocalBaseline;
  changes: LocalChange[];
}

export const detectLocalChanges = (
  state: TogetherLocalState,
  baseline: LocalBaseline,
): LocalDelta => {
  const next = baselineOf(state);
  const changes: LocalChange[] = [];
  if (next.queueSignature !== baseline.queueSignature && state.queueSongIds.length > 0) {
    changes.push("queue");
  }
  // 整曲播完时歌曲往往已被自动切走：那个 track 变化是播放器的结果而非用户操作，
  // 不能当成 GOTO 上报（推进权由 handleEnded 决定）。播放模式变化与它无关，仍要检出。
  if (next.endRevision !== baseline.endRevision) {
    changes.push("ended");
    if (next.playMode !== baseline.playMode) changes.push("playMode");
    return { baseline: next, changes };
  }
  if (next.playMode !== baseline.playMode) changes.push("playMode");
  if (!next.songId) return { baseline: next, changes };
  if (next.songId !== baseline.songId) changes.push("track");
  else if (next.seekRevision !== baseline.seekRevision) changes.push("progress");
  else if (next.playing !== baseline.playing) changes.push("playState");
  return { baseline: next, changes };
};

export const needsQueueReplace = (
  snapshot: TogetherSnapshot,
  localQueueIds: readonly string[],
): boolean =>
  snapshot.songIds.length > 0 &&
  songIdsSignature(snapshot.songIds) !== songIdsSignature(localQueueIds);
