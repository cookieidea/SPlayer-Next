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

import { requestNimTicket } from "./ticket";

/** 播放命令事件（type=20000） */
export interface NimPlaybackEvent {
  kind: "playback";
  /** 发送者 uid。服务端会把命令也推给发送者本人，用它过滤回声 */
  senderId: string;
  commandType: string;
  targetSongId: string;
  formerSongId: string;
  progressMs: number;
  playStatus: string;
  serverSeq: number;
  clientSeq: number;
  /** 服务端准备好的可读提示，如「对方刚刚切歌了」 */
  hint: string;
}

/** 播放列表变更（type=20001）：只带版本号，队列内容需重新拉取 */
export interface NimQueueEvent {
  kind: "queue";
  senderId: string;
  serverSeq: number;
  hint: string;
}

/** 成员进入 / 退出（msg_type_=5） */
export interface NimMemberEvent {
  kind: "member";
  userId: string;
  joined: boolean;
}

export type NimRoomEvent = NimPlaybackEvent | NimQueueEvent | NimMemberEvent;

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
}

interface NodeNimModule {
  ChatRoom: new () => ChatRoomLike;
}

const ENTER_TIMEOUT_MS = 15_000;
const EVENT_PLAYBACK = 20_000;
const EVENT_QUEUE = 20_001;
const MSG_TYPE_NOTIFICATION = 5;
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

/**
 * 取服务端配好的可读提示。
 *
 * `operateMsg` 是「谁看到什么」的映射（键是观看者 uid），同一条消息对每个
 * 成员给的文案一样，所以取第一个非发送者的条目即可
 */
const pickHint = (operateMsg: unknown, senderId: string): string => {
  const map = asRecord(operateMsg);
  for (const [uid, text] of Object.entries(map)) {
    if (uid !== senderId) return readString(text);
  }
  return "";
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
  const hint = pickHint(body.operateMsg, senderId);

  if (eventType === EVENT_PLAYBACK) {
    const commandType = readString(body.commandType).toUpperCase();
    if (!commandType) return null;
    return {
      kind: "playback",
      senderId: readString(body.sendUid) || senderId,
      commandType,
      targetSongId: readString(body.targetSongId),
      formerSongId: readString(body.formerSongId),
      progressMs: Math.max(0, readNumber(body.progress)),
      playStatus: readString(body.playStatus).toUpperCase(),
      serverSeq: readNumber(body.serverSeq),
      clientSeq: readNumber(body.clientSeq),
      hint,
    };
  }

  if (eventType === EVENT_QUEUE) {
    return {
      kind: "queue",
      senderId: readString(body.sendUid) || senderId,
      serverSeq: readNumber(body.serverSeq),
      hint,
    };
  }

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

export const disconnectNimRoom = (): void => {
  if (!chatroom || !currentRoom) return;
  try {
    chatroom.exit(currentRoom, "");
  } catch {
    void 0;
  }
  currentRoom = 0;
};
