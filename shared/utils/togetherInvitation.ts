/**
 * 一起听邀请链接
 *
 * 官方 App 的分享文本里带的是一条短链（163cn.tv），roomId 只存在于短链跳转后的
 * 目标地址里；其它渠道还会把链接再包一层。因此这里分两步：先按文本直接找参数，
 * 找不到时把文本里的链接挑出来交给调用方去跟跳转。
 */

const PARAM_PATTERN = /(?:[?&]|\b)(roomid|inviterid|inviteruid|inviter)=([^&#\s]+)/gi;

/** 文本中的 http(s) 链接，含常见中文标点与引号包裹的情况 */
const URL_PATTERN = /https?:\/\/[^\s"'<>()（）【】]+/i;

const ROOM_ID_PATTERN = /^[A-Za-z0-9_-]{1,128}$/;
const USER_ID_PATTERN = /^\d{1,24}$/;

export interface TogetherInvitation {
  /** 房间 ID */
  roomId: string;
  /** 邀请者用户 ID，可为空串 */
  inviterId: string;
}

export interface InvitationParseResult {
  /** 解析出的邀请信息，命中不了参数时为 null */
  invitation: TogetherInvitation | null;
  /** 文本里待解析的链接，需要跟一次跳转才能拿到参数 */
  link: string;
  /** 失败原因，成功时为空串 */
  error: string;
}

/** 从任意文本中挑出第一个链接 */
const firstLink = (text: string): string => URL_PATTERN.exec(text)?.[0] ?? "";

/**
 * 解析邀请链接或裸房间 ID
 *
 * 文本里直接带 `roomId=` 时一步到位；只有短链（或短链被包在分享文案里）时返回
 * `link`，由调用方解析跳转后再调一次。裸房间 ID 仍然接受。
 * @param input - 用户粘贴的文本
 * @returns 邀请信息、待跟进的链接或失败原因
 */
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
    // 只有整串都符合房间 ID 字符集时才当作裸 ID，否则纯文案会被误判成格式错误
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

/**
 * 生成邀请链接
 * @param roomId - 房间 ID
 * @param inviterId - 本机用户 ID
 * @returns 可分享给好友的链接
 */
export const buildInvitation = (roomId: string, inviterId: string): string =>
  `https://st.music.163.com/listen-together/share/?roomId=${encodeURIComponent(roomId)}` +
  `&inviterId=${encodeURIComponent(inviterId)}`;
