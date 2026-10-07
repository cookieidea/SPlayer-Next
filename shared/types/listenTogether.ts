export interface TogetherMember {
  userId: string;
  nickname: string;
  avatarUrl: string;
}

export interface TogetherRoom {
  roomId: string;
  creatorId: string;
  members: TogetherMember[];
}

export interface TogetherRoomSong {
  songId: string;
  songBizId: number;
}

export interface TogetherMultiRoom {
  roomId: string;
  creatorId: string;
  chatRoomId: string;
  members: TogetherMember[];
  playSong: TogetherRoomSong | null;
  nextSongs: TogetherRoomSong[];
}

export interface TogetherMultiSession {
  roomId: string;
  userId: string;
  generation: number;
}

export type TogetherMultiEndReason = "left" | "server" | "logout";

export type TogetherMultiEvent =
  | { type: "session"; session: TogetherMultiSession; room: TogetherMultiRoom }
  | { type: "room"; room: TogetherMultiRoom; generation: number }
  | { type: "session-end"; reason: TogetherMultiEndReason; generation: number }
  | { type: "error"; message: string };

export interface TogetherMultiApi {
  getSession: () => Promise<TogetherMultiSession | null>;
  join: (roomId: string, inviterUid: string, userId: string) => Promise<TogetherMultiRoom>;
  restore: (userId: string) => Promise<TogetherMultiRoom | null>;
  leave: () => Promise<void>;
  addSong: (songId: string, songBizId: number) => Promise<void>;
  topSong: (songId: string, songBizId: number) => Promise<void>;
  removeSong: (songId: string, songBizId: number) => Promise<void>;
  onEvent: (callback: (event: TogetherMultiEvent) => void) => () => void;
}

export type TogetherCommandType =
  "GOTO" | "NEXT" | "PREV" | "PLAY" | "PAUSE" | "PROGRESS" | "ADD" | "REPLACE" | "PLAYMODE_CHANGE";

export interface TogetherCommand {
  userId: string;
  type: TogetherCommandType;
  formerSongId: string;
  targetSongId: string;
  progressMs: number;
  playing: boolean;
  serverSeq: number;
}

export interface TogetherSnapshot {
  songIds: string[];
  playMode: string;
  command: TogetherCommand | null;
}

export interface TogetherLocalState {
  songId: string;
  queueSongIds: string[];
  /** 当前曲目在共享队列中的下标，-1 表示不在队列里 */
  currentIndex: number;
  positionMs: number;
  playing: boolean;
  transitioning: boolean;
  seekRevision: number;
  endRevision: number;
  /** 本机播放模式，随状态上报以便对端跟随 */
  playMode: string;
}

export interface TogetherSession {
  roomId: string;
  userId: string;
  generation: number;
}

export type TogetherSyncEvent =
  | {
      type: "session";
      session: TogetherSession;
      room: TogetherRoom;
    }
  | {
      type: "session-end";
      reason: "left" | "server" | "logout";
      generation: number;
    }
  | {
      type: "room";
      room: TogetherRoom;
      generation: number;
    }
  | {
      type: "command";
      session: TogetherSession;
      command: TogetherCommand | null;
      songIds: string[];
      playMode: string;
      initial: boolean;
      /** 入场采纳（加入房间）时是否直接开始播放：仅改索引不会触碰播放器 */
      autoPlay: boolean;
    }
  | {
      type: "advance";
      session: TogetherSession;
    }
  | {
      type: "error";
      message: string;
    };

export interface TogetherFriend {
  userId: string;
  nickname: string;
  avatarUrl: string;
  joined: boolean;
}

export interface TogetherInviteCard {
  roomId: string;
  inviterId: string;
  inviterName: string;
  inviterAvatarUrl: string;
  title: string;
  receivedAt: number;
}

export interface TogetherApi {
  getSession: () => Promise<TogetherSession | null>;
  create: (userId: string) => Promise<TogetherRoom>;
  join: (roomId: string, inviterId: string, userId: string) => Promise<TogetherRoom>;
  restore: (userId: string) => Promise<TogetherRoom | null>;
  resolveLink: (url: string) => Promise<string>;
  pendingInvites: () => Promise<TogetherInviteCard[]>;
  friends: (userId: string) => Promise<TogetherFriend[]>;
  invite: (acceptorId: string) => Promise<void>;
  leave: () => Promise<void>;
  sync: (state: TogetherLocalState) => void;
  onEvent: (callback: (event: TogetherSyncEvent) => void) => () => void;
}
