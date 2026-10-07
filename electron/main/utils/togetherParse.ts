import type {
  TogetherCommand,
  TogetherCommandType,
  TogetherInviteCard,
  TogetherMember,
  TogetherMultiRoom,
  TogetherRoom,
  TogetherRoomSong,
  TogetherSnapshot,
} from "@shared/types/listenTogether";

type Json = Record<string, unknown>;

export const obj = (value: unknown): Json | null =>
  value && typeof value === "object" && !Array.isArray(value) ? (value as Json) : null;

const list = (value: unknown): unknown[] => (Array.isArray(value) ? value : []);

const parseJson = (value: unknown): Json | null => {
  if (typeof value === "string") {
    try {
      return obj(JSON.parse(value));
    } catch {
      return null;
    }
  }
  return obj(value);
};

export const str = (value: unknown): string => (value == null ? "" : String(value));

const safeDecode = (value: string): string => {
  try {
    return decodeURIComponent(value);
  } catch {
    return value;
  }
};

const num = (value: unknown): number => {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : 0;
};

const unwrap = (value: unknown): unknown => {
  const root = obj(value);
  if (root && typeof root.status === "number" && obj(root.body)) return root.body;
  return value;
};

const toMember = (raw: unknown): TogetherMember => {
  const item = obj(raw) ?? {};
  // 多人房用 uid / avatar，双人房用 userId / avatarUrl
  return {
    userId: str(item.userId ?? item.uid),
    nickname: str(item.nickname),
    avatarUrl: str(item.avatarUrl || item.avatar),
  };
};

const toRoomSong = (raw: unknown): TogetherRoomSong => {
  const item = obj(raw) ?? {};
  return { songId: str(item.songId), songBizId: num(item.songBizId) };
};

const toRoom = (raw: unknown): TogetherRoom | null => {
  const room = obj(raw);
  if (!room) return null;
  const roomId = str(room.roomId);
  if (!roomId) return null;
  const users = list(room.roomUsers).length ? list(room.roomUsers) : list(room.users);
  return {
    roomId,
    creatorId: str(room.creatorId),
    roomType: str(room.roomType).toUpperCase(),
    members: users.map(toMember).filter((member) => member.userId),
  };
};

export const roomFromBody = (value: unknown): TogetherRoom | null => {
  const root = obj(unwrap(value));
  const data = obj(root?.data) ?? root;
  return toRoom(data?.roomInfo) ?? toRoom(data);
};

const toCommand = (raw: unknown): TogetherCommand | null => {
  const command = obj(raw);
  if (!command) return null;
  const type = str(command.commandType).toUpperCase() as TogetherCommandType;
  if (!type) return null;
  const playStatus = str(command.playStatus).toUpperCase();
  const targetSongId = str(command.targetSongId);
  const paused = type === "PAUSE" || playStatus === "PAUSE";
  // 只描述时间轴或队列构成的命令不改变本机播放态
  const neutral =
    type === "PROGRESS" || type === "ADD" || type === "REPLACE" || type === "PLAYMODE_CHANGE";
  return {
    userId: str(command.userId),
    type,
    formerSongId: str(command.formerSongId),
    targetSongId: targetSongId === "0" ? "" : targetSongId,
    progressMs: Math.max(0, num(command.progress)),
    playing: !neutral && !paused,
    serverSeq: num(command.serverSeq),
  };
};

export const invitesFromInbox = (value: unknown): TogetherInviteCard[] => {
  const body = obj(unwrap(value));
  const conversations = Array.isArray(body?.msgs) ? body.msgs : [];
  const cards: TogetherInviteCard[] = [];
  for (const raw of conversations) {
    const conversation = obj(raw);
    const user = obj(conversation?.user);
    const source = conversation?.lastMsg ?? conversation?.msg ?? user?.lastMsg ?? user?.msg;
    const payload = parseJson(source);
    const message = obj(payload?.msg);
    const general = obj(payload?.generalMsg) ?? obj(message?.generalMsg);
    const nativeUrl = str(general?.nativeUrl);
    if (!nativeUrl.includes("listenTogether")) continue;
    const outer = new URLSearchParams(nativeUrl.slice(nativeUrl.indexOf("?") + 1));
    const inner = safeDecode(outer.get("url1") ?? "");
    const query = inner.slice(inner.indexOf("?") + 1);
    if (!query) continue;
    const params = new URLSearchParams(query);
    const roomId = str(params.get("roomId"));
    if (!roomId) continue;
    cards.push({
      roomId,
      inviterId: str(params.get("inviterId") || user?.fromUserId),
      inviterName: str(params.get("inviterName") || user?.nickname),
      inviterAvatarUrl: safeDecode(str(params.get("inviterAvatarUrl"))),
      title: str(general?.title) || "加入一起听",
      receivedAt: num(conversation?.lastMsgTime ?? user?.lastMsgTime),
    });
  }
  return cards.sort((left, right) => right.receivedAt - left.receivedAt);
};

export const snapshotFromBody = (value: unknown): TogetherSnapshot => {
  const data = obj(obj(unwrap(value))?.data);
  if (!data) {
    return { songIds: [], playMode: "", command: null };
  }
  const playlist = obj(data.playlist) ?? {};
  const mode = str(playlist.playMode).toUpperCase();
  const shuffled = mode === "RANDOM" || mode === "SHUFFLE" || mode.endsWith("_RANDOM");
  const source = (shuffled ? obj(playlist.randomList) : null) ?? obj(playlist.displayList) ?? {};
  return {
    songIds: list(source.result)
      .map((id) => str(id))
      .filter((id) => id !== "" && id !== "0"),
    playMode: mode,
    command: toCommand(data.playCommand ?? data.commandInfo),
  };
};

export const statusFromBody = (value: unknown): { inRoom: boolean; room: TogetherRoom | null } => {
  const data = obj(obj(unwrap(value))?.data);
  if (!data) return { inRoom: false, room: null };
  return { inRoom: Boolean(data.inRoom), room: toRoom(data.roomInfo) };
};

/**
 * room/check 的结果：joinable 之外还带服务端自己的原因。
 * copywriting 是服务端文案（人数已满等策略由它决定），
 * status 是枚举（已观测 AVAILABLE / EXPIRED）。
 * 人数上限不在客户端协议里，不能由我们编造措辞
 */
export const roomCheckFromBody = (
  value: unknown,
): {
  joinable: boolean;
  copywriting: string;
  status: string;
  type: string;
} => {
  const data = obj(obj(unwrap(value))?.data);
  if (!data) return { joinable: false, copywriting: "", status: "", type: "" };
  return {
    joinable: Boolean(data.joinable),
    copywriting: str(data.copywriting),
    status: str(data.status).toUpperCase(),
    // 实测双人房为 NORMAL；多人房类型待实测，加入前要靠它决定走哪套协议
    type: str(data.type).toUpperCase(),
  };
};

export const joinableFromBody = (value: unknown): boolean => roomCheckFromBody(value).joinable;

/**
 * 多人房快照：ack 与 status/get 的响应结构一致，
 * 房间信息、成员、房间当前歌曲都裹在 multiLtRoomSnapshot 里，
 * 与双人的 roomUsers / playCommand 是两套结构
 */
export const multiRoomFromBody = (value: unknown): TogetherMultiRoom | null => {
  const body = obj(unwrap(value)) ?? {};
  const data = obj(body.data) ?? body;
  const root =
    obj(data.multiLtRoomSnapshot) ?? obj(data.multiRoomInfo) ?? obj(data.multiLtRoomInfo) ?? data;
  const dto = obj(root.multiRoomInfoDTO) ?? root;
  const roomId = str(root.roomId) || str(dto.roomId);
  if (!roomId) return null;

  const agg = obj(root.multiLtRoomUserAgg) ?? obj(root.roomUserList);
  const users = Array.isArray(agg)
    ? agg
    : agg
      ? list(agg.onlineUserInfos ?? agg.userList ?? agg.list)
      : list(root.roomUsers);
  // 实测 multiLtRoomUserAgg 在 snapshot 顶层，不在 multiRoomInfoDTO 里

  const songInfo = obj(root.roomPlaySongInfo);
  const playSong = obj(songInfo?.playSong);
  return {
    roomId,
    creatorId: str(dto.creatorId) || str(root.creatorId) || str(root.creatorUid),
    chatRoomId: str(dto.chatRoomId) || str(root.chatRoomId) || str(obj(root.imRoomInfo)?.roomId),
    members: users.map(toMember).filter((member) => member.userId),
    playSong: playSong ? toRoomSong(playSong) : null,
    nextSongs: list(songInfo?.nextSongs)
      .map(toRoomSong)
      .filter((song) => song.songId),
  };
};
