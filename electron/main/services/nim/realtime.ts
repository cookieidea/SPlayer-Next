/**
 * 一起听实时通道（云信聊天室）。
 *
 * 官方客户端的播放指令走云信长连接推送，HTTP 只有房间生命周期与低频校准。
 * 这里接入长连接，把聊天室里的播放事件解出来交给上层；连不上时由调用方
 * 回落 HTTP 轮询，所以本模块的所有失败都只是 throw，不改变房间状态。
 *
 * 两个必须遵守的实测约束：
 * - `ChatRoom` 实例全局只初始化一次；重复 init 会破坏原生运行时
 * - 换票必须放子进程（见 ticket.ts）：原生 SDK 在 Linux 上退出不可靠
 */

import { requestNimTicket } from "./ticket";

/** 聊天室里的播放事件（event_type=20000），字段与官方命令一一对应 */
export interface NimPlaybackEvent {
  commandType: string;
  targetSongId: string;
  formerSongId: string;
  progressMs: number;
  playing: boolean;
  serverSeq: number;
  clientSeq: number;
  senderId: string;
}

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

const asRecord = (value: unknown): Record<string, unknown> =>
  value && typeof value === "object" ? (value as Record<string, unknown>) : {};

const readString = (value: unknown): string =>
  typeof value === "string" ? value : typeof value === "number" ? String(value) : "";

const readNumber = (value: unknown): number => (Number.isFinite(Number(value)) ? Number(value) : 0);

/** 消息体可能是 JSON 字符串、数组或已解析对象，逐层找 event_type=20000 */
const findPlaybackEnvelope = (value: unknown, depth = 0): Record<string, unknown> | null => {
  if (depth > 7) return null;
  let parsed: unknown = value;
  if (typeof value === "string") {
    try {
      parsed = JSON.parse(value);
    } catch {
      return null;
    }
  }
  if (Array.isArray(parsed)) {
    for (const item of parsed) {
      const found = findPlaybackEnvelope(item, depth + 1);
      if (found) return found;
    }
    return null;
  }
  const object = asRecord(parsed);
  if (Object.keys(object).length === 0) return null;
  if (readNumber(object.event_type) === 20_000) return object;
  for (const nested of Object.values(object)) {
    const found = findPlaybackEnvelope(nested, depth + 1);
    if (found) return found;
  }
  return null;
};

/** 从 envelope 里取出命令体：可能直接是 command，也可能在 config/content/data 里 */
const extractCommand = (envelope: Record<string, unknown>): Record<string, unknown> => {
  const direct = asRecord(envelope.command);
  if (Object.keys(direct).length > 0) return direct;
  for (const key of ["config", "content", "data", "commandInfo"]) {
    const nested = asRecord(envelope[key]);
    if (Object.keys(nested).length > 0) return nested;
  }
  return envelope;
};

export const decodeNimPlayback = (raw: unknown): NimPlaybackEvent | null => {
  const envelope = findPlaybackEnvelope(raw);
  if (!envelope) return null;
  const command = extractCommand(envelope);
  const commandType = readString(command.commandType).toUpperCase();
  const targetSongId = readString(command.targetSongId);
  if (!commandType || !targetSongId) return null;
  const playStatus = readString(command.playStatus).toUpperCase();
  return {
    commandType,
    targetSongId,
    formerSongId: readString(command.formerSongId),
    progressMs: Math.max(0, readNumber(command.progress)),
    playing: playStatus === "PLAY",
    serverSeq: readNumber(command.serverSeq) || readNumber(envelope.serverSeq),
    clientSeq: readNumber(command.clientSeq),
    senderId: readString(asRecord(raw).from_id_),
  };
};

let chatroom: ChatRoomLike | null = null;
let currentRoom = 0;
let listener: ((event: NimPlaybackEvent) => void) | null = null;
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
    const event = decodeNimPlayback(args[1]);
    if (event) listener?.(event);
  });
  chatroom = instance;
  return instance;
};

export const setNimPlaybackListener = (next: ((event: NimPlaybackEvent) => void) | null): void => {
  listener = next;
};

export const isNimAvailable = (): boolean => !unavailable;

/**
 * 进入某个多人房的聊天室。
 *
 * 失败一律向外抛，由调用方决定是否回落 HTTP —— 本模块不持有房间会话，
 * 只负责把长连接接起来并把事件转出去
 */
export const connectNimRoom = async (options: {
  roomId: string;
  chatRoomId: string;
  accId: string;
  token: string;
  nickname?: string;
  avatar?: string;
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
