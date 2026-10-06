const PARAM_PATTERN = /(?:[?&]|\b)(roomid|inviterid|inviteruid|inviter)=([^&#\s]+)/gi;

const URL_PATTERN = /https?:\/\/[^\s"'<>()（）【】]+/i;

const ROOM_ID_PATTERN = /^[A-Za-z0-9_-]{1,128}$/;
const USER_ID_PATTERN = /^\d{1,24}$/;

export interface TogetherInvitation {
  roomId: string;
  inviterId: string;
}

export interface InvitationParseResult {
  invitation: TogetherInvitation | null;
  link: string;
  error: string;
}

const firstLink = (text: string): string => URL_PATTERN.exec(text)?.[0] ?? "";

export const parseInvitation = (input: string): InvitationParseResult => {
  const raw = (input ?? "").trim();
  if (!raw) return { invitation: null, link: "", error: "请输入邀请链接或房间 ID" };
  if (raw.length > 1024) return { invitation: null, link: "", error: "邀请内容过长" };

  let roomId = "";
  let inviterId = "";
  PARAM_PATTERN.lastIndex = 0;
  for (let match = PARAM_PATTERN.exec(raw); match; match = PARAM_PATTERN.exec(raw)) {
    const key = match[1].toLowerCase();
    let value = match[2];
    try {
      value = decodeURIComponent(value);
    } catch {
      return { invitation: null, link: "", error: "邀请链接编码无效" };
    }
    if (key === "roomid") roomId = value.trim();
    else inviterId = value.trim();
  }

  if (!roomId && !raw.includes("=") && !raw.includes("/")) {
    if (ROOM_ID_PATTERN.test(raw)) roomId = raw;
  }
  if (!roomId) {
    const link = firstLink(raw);
    if (!link) return { invitation: null, link: "", error: "没有找到邀请链接或房间 ID" };
    return { invitation: null, link, error: "" };
  }
  if (!ROOM_ID_PATTERN.test(roomId)) {
    return { invitation: null, link: "", error: "邀请链接或房间 ID 格式无效" };
  }
  if (inviterId && !USER_ID_PATTERN.test(inviterId)) {
    return { invitation: null, link: "", error: "邀请者 ID 格式无效" };
  }
  return { invitation: { roomId, inviterId }, link: "", error: "" };
};

export const buildInvitation = (roomId: string, inviterId: string): string =>
  `https://st.music.163.com/listen-together/share/?roomId=${encodeURIComponent(roomId)}` +
  `&inviterId=${encodeURIComponent(inviterId)}`;
