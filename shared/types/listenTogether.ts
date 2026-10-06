/**
 * 网易云「一起听」跨进程类型
 *
 * 协议来自官方客户端的 listen/together 私有接口：房间由服务端保存共享队列与
 * 「最近一条播放命令」，两个客户端各自每秒轮询快照、上报本地变化。
 */

/** 房间成员 */
export interface TogetherMember {
  /** 用户 ID */
  userId: string;
  /** 昵称 */
  nickname: string;
  /** 头像 */
  avatarUrl: string;
}

/** 房间信息 */
export interface TogetherRoom {
  /** 房间 ID */
  roomId: string;
  /** 房主用户 ID */
  creatorId: string;
  members: TogetherMember[];
}

/** 服务端保存的播放命令类型 */
export type TogetherCommandType = "GOTO" | "NEXT" | "PREV" | "PLAY" | "PAUSE" | "PROGRESS";

/** 最近一条播放命令 */
export interface TogetherCommand {
  /** 发起者用户 ID */
  userId: string;
  type: TogetherCommandType;
  /** 切歌前的歌曲 ID */
  formerSongId: string;
  /** 目标歌曲 ID */
  targetSongId: string;
  /** 目标进度（毫秒） */
  progressMs: number;
  /** 发起者是否为播放态 */
  playing: boolean;
  /** 服务端序号，用于单调去重 */
  serverSeq: number;
}

/** 房间快照 */
export interface TogetherSnapshot {
  /** 共享队列（歌曲 ID 顺序） */
  songIds: string[];
  /** 最近一条播放命令，无命令时为 null */
  command: TogetherCommand | null;
}

/**
 * 渲染端上报的本地播放状态
 *
 * `seekRevision` / `endRevision` 是单调计数器而非位置本身：播放位置每秒都在
 * 漂移，只有用户真正拖动进度或整曲播完才该被当成一次需要上报的动作。
 */
export interface TogetherLocalState {
  /** 当前歌曲 ID，非网易云音源时为空串 */
  songId: string;
  /** 当前队列（歌曲 ID 顺序） */
  queueSongIds: string[];
  /** 播放位置（毫秒） */
  positionMs: number;
  /** 是否播放中 */
  playing: boolean;
  /** 挂起中的加载（切歌尚未落定），此时本地状态不代表用户意图 */
  transitioning: boolean;
  /** seek 次数计数器 */
  seekRevision: number;
  /** 整曲自然播完计数器 */
  endRevision: number;
}

/** 会话状态，标识一次房间在线周期 */
export interface TogetherSession {
  /** 当前房间 ID */
  roomId: string;
  /** 递增的在线代次，离开房间后旧代次的下发被丢弃 */
  generation: number;
  /** 本机用户 ID */
  userId: string;
}

/** 主进程推送给渲染端的同步事件 */
export type TogetherSyncEvent =
  | {
      /** 会话建立 */
      type: "session";
      session: TogetherSession;
      room: TogetherRoom;
    }
  | {
      /** 会话结束 */
      type: "session-end";
      reason: "left" | "server" | "logout";
    }
  | {
      /** 成员或房间信息更新 */
      type: "room";
      room: TogetherRoom;
    }
  | {
      /** 需要对端命令作出播放响应 */
      type: "command";
      session: TogetherSession;
      /** 对端命令，仅共享队列变化时为 null */
      command: TogetherCommand | null;
      /** 命令携带的共享队列，非空时需整体替换 */
      songIds: string[];
      /** 是否是进入房间后的首次对齐 */
      initial: boolean;
    }
  | {
      /** 轮到本机推进队列（自然播完后主控权归属本机） */
      type: "advance";
      session: TogetherSession;
    }
  | {
      /** 同步失败，渲染端据此提示 */
      type: "error";
      message: string;
    };

/** 携带会话的事件，其余事件与会话无关 */
export type TogetherSessionEvent = Extract<
  TogetherSyncEvent,
  { type: "session" | "command" | "advance" }
>;

/** 一起听 IPC 接口 */
export interface TogetherApi {
  /** 查询当前会话，未加入时返回 null */
  getSession: () => Promise<TogetherSession | null>;
  /** 创建房间 */
  create: (userId: string) => Promise<TogetherRoom>;
  /**
   * 加入房间
   * @param roomId - 房间 ID
   * @param inviterId - 邀请者用户 ID
   * @param userId - 本机用户 ID
   */
  join: (roomId: string, inviterId: string, userId: string) => Promise<TogetherRoom>;
  /** 恢复服务端上尚未结束的房间 */
  restore: (userId: string) => Promise<TogetherRoom | null>;
  /**
   * 展开分享短链，取出带 roomId 的最终地址
   * @param url - 用户粘贴文本里的链接
   */
  resolveLink: (url: string) => Promise<string>;
  /** 退出房间 */
  leave: () => Promise<void>;
  /** 上报本地播放状态，由服务端决定下一步 */
  sync: (state: TogetherLocalState) => void;
  /** 订阅同步事件 */
  onEvent: (callback: (event: TogetherSyncEvent) => void) => () => void;
}
