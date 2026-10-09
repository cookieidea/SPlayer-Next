export interface TogetherMember {
  userId: string;
  nickname: string;
  avatarUrl: string;
}

export interface TogetherRoom {
  roomId: string;
  creatorId: string;
  /** 该房间对应的云信聊天室 ID。实时同步走它，房间本身的状态仍由服务端接口提供 */
  chatRoomId: string;
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
  /** 采样瞬间已播的毫秒数（服务端下发）。当前进度 = playProgress + (now - sampledAt) */
  playProgress: number;
  /** 该进度值的采样时刻（本地收到响应的时刻），用来推算心跳之间的真实位置 */
  sampledAt: number;
  /** 当前曲总时长（毫秒） */
  playDuration: number;
  /** 服务端要求强制对齐（切歌/顶歌等破坏性操作后）。此时忽略容差直接 seek */
  forceSync: boolean;
  /** 房间歌曲版本号（单调递增）。用它丢弃乱序到达的旧快照 */
  playVersion: number;
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
  /** 发这条私信的人：与自己相同说明是"我发出去的邀请"，不该出现在待处理里 */
  fromUserId: string;
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
  /** 查是否需要多设备接管（同一账号在另一台设备进房） */
  fetchReconnectInfo: () => Promise<{
    roomId: string;
    canReconnect: boolean;
    needConfirm: boolean;
    deviceName: string;
  } | null>;
  /** 告知服务端本设备已接管房间 */
  notifyDeviceReconnect: (roomId: string) => Promise<void>;
  sync: (state: TogetherLocalState) => void;
  onEvent: (callback: (event: TogetherSyncEvent) => void) => () => void;
}
