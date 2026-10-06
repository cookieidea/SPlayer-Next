import type {
  TogetherCommand,
  TogetherCommandType,
  TogetherInviteCard,
  TogetherMember,
  TogetherRoom,
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

const num = (value: unknown): number => {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : 0;
};

const unwrap = (value: unknown): unknown => {
  const root = obj(value);
  if (root && obj(root.body)) return root.body;
  return value;
};

const toMember = (raw: unknown): TogetherMember => {
  const item = obj(raw) ?? {};
  return {
    userId: str(item.userId),
    nickname: str(item.nickname),
    avatarUrl: str(item.avatarUrl),
  };
};

export const toRoom = (raw: unknown): TogetherRoom | null => {
  const room = obj(raw);
  if (!room) return null;
  const roomId = str(room.roomId);
  if (!roomId) return null;
  const users = list(room.roomUsers).length ? list(room.roomUsers) : list(room.users);
  return {
    roomId,
    creatorId: str(room.creatorId),
    members: users.map(toMember).filter((member) => member.userId),
  };
};

export const roomFromBody = (value: unknown): TogetherRoom | null => {
  const root = obj(unwrap(value));
  const data = obj(root?.data) ?? root;
  return toRoom(data?.roomInfo) ?? toRoom(data);
};

export const toCommand = (raw: unknown): TogetherCommand | null => {
  const command = obj(raw);
  if (!command) return null;
  const type = str(command.commandType).toUpperCase() as TogetherCommandType;
  if (!type) return null;
  const playStatus = str(command.playStatus).toUpperCase();
  const targetSongId = str(command.targetSongId);
  const paused = type === "PAUSE" || playStatus === "PAUSE";
  return {
    userId: str(command.userId),
    type,
    formerSongId: str(command.formerSongId),
    targetSongId: targetSongId === "0" ? "" : targetSongId,
    progressMs: Math.max(0, num(command.progress)),
    playing: type !== "PROGRESS" && !paused,
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
    const inner = decodeURIComponent(outer.get("url1") ?? "");
    const query = inner.slice(inner.indexOf("?") + 1);
    if (!query) continue;
    const params = new URLSearchParams(query);
    const roomId = str(params.get("roomId"));
    if (!roomId) continue;
    cards.push({
      roomId,
      inviterId: str(params.get("inviterId") || user?.fromUserId),
      inviterName: str(params.get("inviterName") || user?.nickname),
      inviterAvatarUrl: decodeURIComponent(str(params.get("inviterAvatarUrl"))),
      title: str(general?.title) || "加入一起听",
      receivedAt: num(conversation?.lastMsgTime ?? user?.lastMsgTime),
    });
  }
  return cards.sort((left, right) => right.receivedAt - left.receivedAt);
};

export const snapshotFromBody = (value: unknown): TogetherSnapshot => {
  const data = obj(obj(unwrap(value))?.data);
  if (!data) return { songIds: [], command: null };
  const playlist = obj(data.playlist) ?? {};
  const mode = str(playlist.playMode).toUpperCase();
  const shuffled = mode.includes("RANDOM") || mode.includes("SHUFFLE");
  const source = (shuffled ? obj(playlist.randomList) : null) ?? obj(playlist.displayList) ?? {};
  return {
    songIds: list(source.result)
      .map((id) => str(id))
      .filter((id) => id !== "" && id !== "0"),
    command: toCommand(data.playCommand ?? data.commandInfo),
  };
};

export const statusFromBody = (value: unknown): { inRoom: boolean; room: TogetherRoom | null } => {
  const data = obj(obj(unwrap(value))?.data);
  if (!data) return { inRoom: false, room: null };
  return { inRoom: Boolean(data.inRoom), room: toRoom(data.roomInfo) };
};

export const joinableFromBody = (value: unknown): boolean =>
  Boolean(obj(obj(unwrap(value))?.data)?.joinable);
