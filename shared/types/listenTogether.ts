export interface TogetherMember {
  userId: string;
  nickname: string;
  avatarUrl: string;
}

export interface TogetherRoom {
  roomId: string;
  creatorId: string;
  /** FRIEND=双人，MATCH_SONG=匹配房，MULTI_* =多人。服务端在有人加入时会自动把 FRIEND 转成多人 */
  roomType: string;
  members: TogetherMember[];
}

export interface TogetherRoomSong {
  songId: string;
  songBizId: number;
  /** 推荐这首歌的人。实测 nextSongs 里 rcmdType=3 的是自己加的，0 表示系统 */
  songRcmdUid: string;
}

export interface TogetherMultiRoom {
  roomId: string;
  creatorId: string;
  chatRoomId: string;
  members: TogetherMember[];
  playSong: TogetherRoomSong | null;
  nextSongs: TogetherRoomSong[];
  /** 当前曲的起播时刻（毫秒时间戳）。进度 = Date.now() - startTime，
   *  用它可以推算准确位置，不受心跳间隔影响 */
  playStartTime: number;
  /** 当前曲总时长（毫秒） */
  playDuration: number;
}

export interface TogetherRoomOperateResult {
  room: TogetherMultiRoom | null;
  /** 服务端对本次操作的说明（成功也有文案，如投票是否够数） */
  message: string;
  /** 服务端是否否决了本次操作（歌已播完、太频繁、非本人添加等） */
  rejected: boolean;
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
  /** 本地脱离房间，不通知服务端（房型升级时给多人侧让位） */
  detach: () => Promise<void>;
  inviteFriends: (uids: string[]) => Promise<void>;
  refresh: () => Promise<void>;
  getStrangerVisible: () => Promise<boolean>;
  setStrangerVisible: (visible: boolean) => Promise<void>;
  createRoom: (songId: string, userId: string) => Promise<TogetherMultiRoom>;
  startMatch: () => Promise<{
    maxWaitMs: number;
    roomId: string;
    roomType: string;
    waiting: boolean;
  }>;
  ackMatch: (roomId: string) => Promise<void>;
  ackMultiMatch: (roomId: string) => Promise<void>;
  cancelMatch: () => Promise<void>;
  startMultiMatch: (songId: string) => Promise<{
    matching: boolean;
    maxWaitMs: number;
    roomId: string;
  }>;
  cancelMultiMatch: () => Promise<void>;
  addSong: (songId: string, songBizId: number) => Promise<TogetherRoomOperateResult>;
  topSong: (songId: string, songBizId: number) => Promise<TogetherRoomOperateResult>;
  removeSong: (songId: string, songBizId: number) => Promise<TogetherRoomOperateResult>;
  voteSkip: (songId: string, songBizId: number) => Promise<TogetherRoomOperateResult>;
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
      /** 有新听友进房，names 是他们的昵称 */
      type: "arrive";
      names: string;
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
  /** 多人大厅的邀请：接收时要走多人协议，不能按双人加入 */
  multi: boolean;
}

export interface TogetherApi {
  getSession: () => Promise<TogetherSession | null>;
  create: (userId: string) => Promise<TogetherRoom>;
  join: (roomId: string, inviterId: string, userId: string) => Promise<TogetherRoom>;
  restore: (userId: string, entering?: boolean) => Promise<TogetherRoom | null>;
  resolveLink: (url: string) => Promise<string>;
  pendingInvites: () => Promise<TogetherInviteCard[]>;
  fetchInvitation: () => Promise<{
    display: boolean;
    roomId: string;
    inviterId: string;
    nickname: string;
    avatarUrl: string;
    hadAutoChangeMulti: boolean;
  } | null>;
  resetInvitationVersion: () => Promise<void>;
  friends: (userId: string) => Promise<TogetherFriend[]>;
  invite: (acceptorId: string) => Promise<void>;
  rejectInvitation: (roomId: string) => Promise<void>;
  leave: () => Promise<void>;
  /** 本地脱离房间，不通知服务端（房型升级时给多人侧让位） */
  detach: () => Promise<void>;
  sync: (state: TogetherLocalState) => void;
  onEvent: (callback: (event: TogetherSyncEvent) => void) => () => void;
}
