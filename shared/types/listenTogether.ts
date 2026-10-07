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
  anchorSongId: string;
  anchorPosition: number;
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
      anchorSongId: string;
      anchorPosition: number;
      initial: boolean;
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
