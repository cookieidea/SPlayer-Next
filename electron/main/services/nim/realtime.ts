/**
 * 一起听实时通道（云信聊天室）。
 *
 * 官方客户端把房间事件全部走云信长连接推送，实测覆盖：
 *   type=20000  播放命令（PLAY / PAUSE / GOTO / PROGRESS / PLAYMODE_CHANGE …）
 *   type=20001  播放列表变更（只带 version，队列内容要再拉一次）
 *   type=20010  一起听时长统计
 *   msg_type_=5 成员进入 / 退出（msg_attach_.id：301 进入、302 退出）
 *
 * 消息外层是 NIM 的 `msg_attach_` JSON 字符串，形如
 *   { msgType: 120, content: { type: 20000, bizType: 3, content: { …命令… } } }
 * 所以判断事件类型要看 `content.type`，不是 outer 的字段名。
 *
 * 两个必须遵守的实测约束：
 * - `ChatRoom` 实例全局只初始化一次；重复 init 会破坏原生运行时
 * - 换票必须放子进程（见 ticket.ts）：原生 SDK 在 Linux 上退出不可靠
 */

import { NIM_APP_KEY, requestNimTicket } from "./ticket";

/** 播放命令事件（type=20000） */
export interface NimPlaybackEvent {
  kind: "playback";
  /** 发送者 uid。服务端会把命令也推给发送者本人，用它过滤回声 */
  senderId: string;
  commandType: string;
  targetSongId: string;
  progressMs: number;
  playStatus: string;
  serverSeq: number;
  clientSeq: number;
}

/** 播放列表变更（type=20001）：只带版本号，队列内容需重新拉取 */
export interface NimQueueEvent {
  kind: "queue";
  senderId: string;
  serverSeq: number;
}

/** 成员进入 / 退出（msg_type_=5） */
export interface NimMemberEvent {
  kind: "member";
  userId: string;
  joined: boolean;
}

/**
 * 服务端推送的房间状态全量（type=30000）。
 *
 * 载荷与心跳响应的 roomPlaySongInfo 同构，可直接交给多人房解析；
 * 房间每次变化都会推一条，是"播完自动跟下一首"的可靠来源
 */
export interface NimStateEvent {
  kind: "state";
  roomId: string;
  /** 未解析的 songInfo：交给 togetherParse 的解析器，避免两处结构知识分叉 */
  songInfo: Record<string, unknown>;
}

/** 服务端推送的成员与文案（type=30005） */
export interface NimMembersEvent {
  kind: "members";
  roomId: string;
  members: NimRoomMember[];
}

/**
 * 陌生人匹配解锁（type=20022）。
 *
 * 匹配期间没有房间，事件里的 roomId 是"配对后将要进入的房间"，
 * 此时客户端要做的是尽快回 ack，慢了服务端会按 ACK 超时把账号移出房间
 */
export interface NimMatchLockEvent {
  kind: "matchLock";
  /** APPLY=有人申请；AGREE=对方已同意 */
  matchType: string;
  roomId: string;
  /** 触发方 uid：官方只处理"不是自己"的那一条 */
  userId: string;
  eventId: string;
}

export type NimRoomEvent =
  | NimPlaybackEvent
  | NimQueueEvent
  | NimMemberEvent
  | NimStateEvent
  | NimMembersEvent
  | NimMatchLockEvent;

type EventHandler = (...args: unknown[]) => void;

interface ChatRoomLike {
  init(appInstallDir: string, extension: string): boolean;
  initEventHandlers(): void;
  enter(
    roomId: number,
    requestLoginData: string,
    info: Record<string, unknown>,
    extension: string,
  ): boolean;
  exit(roomId: number, extension: string): void;
  on(event: string, handler: EventHandler): unknown;
  sendMsg(roomId: number, message: Record<string, unknown>, extension: string): unknown;
  getMembersOnlineAsync(
    roomId: number,
    parameters: Record<string, unknown>,
    callback: unknown,
    extension: string,
  ): Promise<unknown[]>;
  getMembersCountByTagOnlineAsync(
    roomId: number,
    tag: string,
    callback: unknown,
    extension: string,
  ): Promise<unknown[]>;
}

/** 聊天室在线成员 */
export interface NimRoomMember {
  userId: string;
  nickname: string;
  avatarUrl: string;
}

interface NodeNimModule {
  ChatRoom: new () => ChatRoomLike;
}

const ENTER_TIMEOUT_MS = 15_000;
const EVENT_PLAYBACK = 20_000;
const EVENT_QUEUE = 20_001;
// 陌生人匹配解锁（官方 LtMatchLockApplyMsg）：
// matchType=APPLY 表示有人申请配对，=AGREE 表示对方已同意、可以进房。
// 匹配期间还没有房间，所以这条只能从个人通道收到
const EVENT_MATCH_LOCK = 20_022;
const MATCH_LOCK_APPLY = "APPLY";
const MATCH_LOCK_AGREE = "AGREE";
// 官方客户端（APK 9.6.05）双人房实际用的是 40001 FLTPlaySyncMsg，
// 载荷为 { operation, playingInfo:{ playingSongId, progress, playing, mode } }。
// 20000 是我们早期按抓包推断的自定义格式，服务端两者都原样透传，
// 所以发送用官方格式（对方官方客户端也能解析），接收两种都认
const EVENT_PLAY_SYNC = 40_001;
// 服务端在房间状态变化时主动推送（实测加歌/顶歌/切歌/成员进出都会触发）：
//   30000 房间播放状态全量（与心跳响应的 roomPlaySongInfo 结构一致）
//   30005 成员与文案，30006 标签
// 这三条把"等 8 秒心跳"变成"零延迟跟随"，是多人房跟随的权威来源
const EVENT_ROOM_STATE = 30_000;
const EVENT_ROOM_MEMBERS = 30_005;
const EVENT_ROOM_TAGS = 30_006;
const MSG_TYPE_NOTIFICATION = 5;
// 业务消息统一用 msgType=120 包一层 content.type，与官方客户端一致
const MSG_TYPE_BUSINESS = 100;
const WRAPPER_MSG_TYPE = 120;
const BIZ_TYPE_TOGETHER = 3;
const NOTIFY_ENTER = 301;
const NOTIFY_EXIT = 302;

const asRecord = (value: unknown): Record<string, unknown> =>
  value && typeof value === "object" ? (value as Record<string, unknown>) : {};

const readString = (value: unknown): string =>
  typeof value === "string" ? value : typeof value === "number" ? String(value) : "";

const readNumber = (value: unknown): number => (Number.isFinite(Number(value)) ? Number(value) : 0);

/** msg_attach_ 是 JSON 字符串，偶尔可能已被 SDK 解析成对象 */
const parseAttach = (value: unknown): Record<string, unknown> => {
  if (typeof value === "string") {
    try {
      return asRecord(JSON.parse(value));
    } catch {
      return {};
    }
  }
  return asRecord(value);
};

/** 从通知里取被操作用户的 uid：进入/退出的 target 就是那个人 */
const notifyUserId = (data: Record<string, unknown>): string => {
  const target = data.target;
  if (Array.isArray(target) && target.length) return readString(target[0]);
  return readString(data.operator);
};

/**
 * 解析一条聊天室消息。
 *
 * 非房间事件（普通聊天文本、表情等）返回 null，由调用方忽略
 */
export const decodeNimMessage = (raw: unknown): NimRoomEvent | null => {
  const message = asRecord(raw);
  const msgType = readNumber(message.msg_type_);
  if (msgType === MSG_TYPE_NOTIFICATION) {
    // 通知的 id 在外层，data 里才是被操作用户
    const attach = parseAttach(message.msg_attach_);
    const notifyId = readNumber(attach.id);
    if (notifyId !== NOTIFY_ENTER && notifyId !== NOTIFY_EXIT) return null;
    return {
      kind: "member",
      userId: notifyUserId(asRecord(attach.data)),
      joined: notifyId === NOTIFY_ENTER,
    };
  }

  const attach = parseAttach(message.msg_attach_);
  const content = asRecord(attach.content);
  const eventType = readNumber(content.type);
  const body = asRecord(content.content);
  const senderId = readString(message.from_id_);

  if (eventType === EVENT_PLAYBACK) {
    const commandType = readString(body.commandType).toUpperCase();
    if (!commandType) return null;
    return {
      kind: "playback",
      senderId: readString(body.sendUid) || senderId,
      commandType,
      targetSongId: readString(body.targetSongId),
      progressMs: Math.max(0, readNumber(body.progress)),
      playStatus: readString(body.playStatus).toUpperCase(),
      serverSeq: readNumber(body.serverSeq),
      clientSeq: readNumber(body.clientSeq),
    };
  }

  if (eventType === EVENT_PLAY_SYNC) {
    const info = asRecord(body.playingInfo);
    const operation = readString(body.operation).toUpperCase();
    if (!operation) return null;
    return {
      kind: "playback",
      senderId: readString(body.operator) || senderId,
      commandType: operation,
      targetSongId: readString(info.playingSongId),
      progressMs: Math.max(0, readNumber(info.progress)),
      playStatus: info.playing === true ? "PLAY" : "PAUSE",
      serverSeq: readNumber(info.operateSeq) || readNumber(body.seq),
      clientSeq: readNumber(body.seq),
    };
  }

  if (eventType === EVENT_QUEUE) {
    return {
      kind: "queue",
      senderId: readString(body.sendUid) || senderId,
      serverSeq: readNumber(body.serverSeq),
    };
  }

  if (eventType === EVENT_MATCH_LOCK) {
    const matchType = readString(body.matchType).toUpperCase();
    if (matchType !== MATCH_LOCK_APPLY && matchType !== MATCH_LOCK_AGREE) return null;
    return {
      kind: "matchLock",
      matchType,
      roomId: readString(body.roomId),
      userId: readString(body.userId),
      eventId: readString(body.eventId),
    };
  }

  if (eventType === EVENT_ROOM_STATE) {
    return { kind: "state", roomId: readString(body.roomId), songInfo: body };
  }

  if (eventType === EVENT_ROOM_MEMBERS) {
    const raw = Array.isArray(body.onlineUserInfos) ? body.onlineUserInfos : [];
    return {
      kind: "members",
      roomId: readString(body.roomId),
      members: raw.map((item) => ({
        userId: readString(asRecord(item).uid),
        nickname: readString(asRecord(item).nickname),
        avatarUrl: readString(asRecord(item).avatar),
      })),
    };
  }

  // 标签变更（30006）不影响跟随，明确忽略而不是落到默认分支
  if (eventType === EVENT_ROOM_TAGS) return null;

  return null;
};

let chatroom: ChatRoomLike | null = null;
let currentRoom = 0;
let listener: ((event: NimRoomEvent) => void) | null = null;
let unavailable = false;

const loadRuntime = async (): Promise<NodeNimModule> => {
  if (unavailable) throw new Error("云信运行时不可用");
  try {
    const imported = (await import("node-nim")) as { default?: unknown };
    const module = (imported.default ?? imported) as Partial<NodeNimModule>;
    if (typeof module.ChatRoom !== "function") throw new Error("node-nim 未导出 ChatRoom");
    return module as NodeNimModule;
  } catch (error) {
    // 装不上二进制或平台不支持时不再重试：省掉每轮进房一次的失败开销
    unavailable = true;
    throw error instanceof Error ? error : new Error(String(error));
  }
};

/** ChatRoom 实例全局复用：原生运行时只能初始化一次 */
const ensureChatroom = async (): Promise<ChatRoomLike> => {
  if (chatroom) return chatroom;
  const nim = await loadRuntime();
  const instance = new nim.ChatRoom();
  if (!instance.init("", "")) throw new Error("云信聊天室初始化失败");
  instance.initEventHandlers();
  instance.on("receiveMsg", (...args: unknown[]) => {
    const room = readNumber(args[0]);
    if (currentRoom && room !== currentRoom) return;
    const event = decodeNimMessage(args[1]);
    if (event) listener?.(event);
  });
  chatroom = instance;
  return instance;
};

export const setNimListener = (next: ((event: NimRoomEvent) => void) | null): void => {
  listener = next;
};

interface NimClientLike2 {
  init(appKey: string, dataDir: string, installDir: string, config?: unknown): boolean;
  initEventHandlers(): void;
  login(
    appKey: string,
    account: string,
    password: string,
    cb: null,
    extension: string,
  ): Promise<unknown[]>;
}

interface NimTalkLike {
  initEventHandlers(): void;
  on(event: string, handler: EventHandler): unknown;
}

interface NimPersonalModule {
  NIMClient?: new () => NimClientLike2;
  NIMTalk?: new () => NimTalkLike;
}

let personalTalk: NimTalkLike | null = null;

/**
 * 建立个人通道（不进聊天室）。
 *
 * 陌生人匹配的配对通知（type=20022）发生在"还没有房间"的阶段，
 * 走的是个人通道而非聊天室。官方客户端在登录时就挂着它，配对通知一到就回 ack；
 * 只靠轮询的话，服务端等 ACK 的窗口很短——实测轮询发现房间后再 ack 会报 488
 */
export const connectPersonalChannel = async (options: {
  accId: string;
  token: string;
  dataDir: string;
}): Promise<void> => {
  if (personalTalk) return;
  const imported = (await import("node-nim")) as { default?: unknown };
  const module = (imported.default ?? imported) as NimPersonalModule;
  if (typeof module.NIMClient !== "function" || typeof module.NIMTalk !== "function") {
    throw new Error("node-nim 未导出 NIMClient/NIMTalk");
  }
  const client = new module.NIMClient();
  const ok = client.init(NIM_APP_KEY, `${options.dataDir}/`, "", {
    database_encrypt_key_: NIM_APP_KEY,
    use_https_: true,
    sdk_log_level_: 4,
  });
  if (!ok) throw new Error("云信个人通道初始化失败");
  client.initEventHandlers();
  const login = await client.login(NIM_APP_KEY, options.accId, options.token, null, "");
  const first = (Array.isArray(login) ? login[0] : login) as { res_code_?: number };
  if (Number(first?.res_code_) !== 200) throw new Error("云信个人通道登录失败");

  const talk = new module.NIMTalk();
  talk.initEventHandlers();
  talk.on("receiveMsg", (...args: unknown[]) => {
    const event = decodeNimMessage(args[0]);
    if (event) listener?.(event);
  });
  personalTalk = talk;
};

export const disconnectPersonalChannel = (): void => {
  personalTalk = null;
};

/**
 * 进入房间的聊天室。
 *
 * 失败一律向外抛：本模块不持有房间会话，只负责把长连接接起来并转出事件
 */
export const connectNimRoom = async (options: {
  chatRoomId: string;
  accId: string;
  token: string;
  nickname?: string;
}): Promise<void> => {
  const roomNumber = Number(options.chatRoomId);
  if (!Number.isFinite(roomNumber) || roomNumber <= 0) throw new Error("聊天室 ID 非法");
  const instance = await ensureChatroom();

  if (currentRoom && currentRoom !== roomNumber) {
    try {
      instance.exit(currentRoom, "");
    } catch {
      void 0;
    }
  }

  const { ticket, code } = await requestNimTicket({
    accId: options.accId,
    token: options.token,
    chatRoomId: String(roomNumber),
  });
  if (code !== 200 || !ticket) throw new Error(`云信换票失败 code=${code}`);

  await new Promise<void>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error("进入云信聊天室超时")), ENTER_TIMEOUT_MS);
    const onEnter = (...args: unknown[]): void => {
      const room = readNumber(args[0]);
      const step = readNumber(args[1]);
      const enterCode = readNumber(args[2]);
      if (room !== roomNumber || step !== 5) return;
      clearTimeout(timer);
      if (enterCode === 200) resolve();
      else reject(new Error(`进入云信聊天室失败 code=${enterCode}`));
    };
    instance.on("enter", onEnter);
    const started = instance.enter(roomNumber, ticket, { nick: options.nickname ?? "" }, "");
    if (!started) {
      clearTimeout(timer);
      reject(new Error("云信聊天室进房请求被本地拒绝"));
    }
  });

  currentRoom = roomNumber;
};

/**
 * 直发一条播放命令。
 *
 * 实测服务端对 msg_attach_ 内容不做校验，原样透传给房间成员；
 * 客户端直发的送达延迟约 0.2 秒，而 HTTP 上报要等一轮同步周期（1 秒）
 * 再加服务端转发，所以这条路才是官方"秒同步"的来源。
 * 未进房（无聊天室连接）时返回 false，调用方回退到 HTTP
 */
export const sendPlaybackCommand = (payload: {
  roomId: string;
  userId: string;
  commandType: string;
  targetSongId: string;
  progressMs: number;
  playing: boolean;
  mode: string;
  seq: number;
}): boolean => {
  if (!chatroom || !currentRoom) return false;
  // 用官方客户端的 40001 载荷：对方若是官方客户端也能正确解析这条同步
  const attach = JSON.stringify({
    msgType: WRAPPER_MSG_TYPE,
    content: {
      type: EVENT_PLAY_SYNC,
      bizType: BIZ_TYPE_TOGETHER,
      content: {
        operator: Number(payload.userId) || 0,
        operation: payload.commandType,
        trigger: "user",
        currentRoomId: payload.roomId,
        seq: payload.seq,
        ts: Date.now(),
        playingInfo: {
          roomId: payload.roomId,
          playing: payload.playing,
          playingSongId: Number(payload.targetSongId) || 0,
          progress: Math.max(0, Math.round(payload.progressMs)),
          mode: payload.mode,
          operateSeq: payload.seq,
          listOperateSeq: 0,
        },
      },
    },
  });
  try {
    chatroom.sendMsg(
      currentRoom,
      {
        msg_type_: MSG_TYPE_BUSINESS,
        msg_attach_: attach,
        client_msg_id_: `${Date.now()}-${Math.floor(Math.random() * 1000)}`,
      },
      "",
    );
    return true;
  } catch {
    return false;
  }
};

/**
 * 拉聊天室在线成员。
 *
 * 比心跳响应里的成员聚合更新（心跳 8 秒一轮），进房与成员变动时用它即时刷新
 */
export const fetchRoomMembers = async (): Promise<NimRoomMember[]> => {
  if (!chatroom || !currentRoom) return [];
  try {
    const result = await chatroom.getMembersOnlineAsync(
      currentRoom,
      { type_: "0", limit_: 100, time_tag_: 0 },
      null,
      "",
    );
    const list = Array.isArray(result?.[2]) ? (result[2] as Record<string, unknown>[]) : [];
    return list.map((item) => ({
      userId: readString(item.account_id_),
      nickname: readString(item.nick_),
      avatarUrl: readString(item.avatar_),
    }));
  } catch {
    return [];
  }
};

export const disconnectNimRoom = (): void => {
  if (!chatroom || !currentRoom) return;
  try {
    chatroom.exit(currentRoom, "");
  } catch {
    void 0;
  }
  currentRoom = 0;
};
