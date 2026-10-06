import type {
  TogetherCommand,
  TogetherLocalState,
  TogetherSnapshot,
} from "@shared/types/listenTogether";

export const REPORT_SUPPRESS_MS = 1800;

export const ADVANCE_HANDOVER_MS = 3500;

export const SYNC_INTERVAL_MS = 1000;

export const HEARTBEAT_TICKS = 5;

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
}

export type LocalChange = "queue" | "track" | "progress" | "playState" | "ended";

export const baselineOf = (state: TogetherLocalState): LocalBaseline => ({
  queueSignature: songIdsSignature(state.queueSongIds),
  songId: state.songId,
  playing: state.playing,
  seekRevision: state.seekRevision,
  endRevision: state.endRevision,
});

export interface LocalDelta {
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
  if (next.endRevision !== baseline.endRevision) changes.push("ended");
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
