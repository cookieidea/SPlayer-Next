/**
 * 一起听邀请链接
 *
 * 官方 App 分享的是 share 页链接，查询串里带 roomId 与 inviterId；QQ 等渠道还会把
 * 链接再包一层，因此解析时只在整串里找参数，不假设它是一个合法 URL。
 */

const PARAM_PATTERN = /(?:[?&]|\b)(roomid|inviterid|inviteruid|inviter)=([^&#\s]+)/gi;

const ROOM_ID_PATTERN = /^[A-Za-z0-9_-]{1,128}$/;
const USER_ID_PATTERN = /^\d{1,24}$/;

export interface TogetherInvitation {
  /** 房间 ID */
  roomId: string;
  /** 邀请者用户 ID，可为空串 */
  inviterId: string;
}

export interface InvitationParseResult {
  /** 解析出的邀请信息，失败时为 null */
  invitation: TogetherInvitation | null;
  /** 失败原因，成功时为空串 */
  error: string;
}

/**
 * 解析邀请链接或裸房间 ID
 * @param input - 用户粘贴的文本
 * @returns 邀请信息或失败原因
 */
export const parseInvitation = (input: string): InvitationParseResult => {
  const raw = (input ?? "").trim();
  if (!raw) return { invitation: null, error: "请输入邀请链接或房间 ID" };
  if (raw.length > 1024) return { invitation: null, error: "邀请内容过长" };

  let roomId = "";
  let inviterId = "";
  PARAM_PATTERN.lastIndex = 0;
  for (let match = PARAM_PATTERN.exec(raw); match; match = PARAM_PATTERN.exec(raw)) {
    const key = match[1].toLowerCase();
    let value = match[2];
    try {
      value = decodeURIComponent(value);
    } catch {
      return { invitation: null, error: "邀请链接编码无效" };
    }
    if (key === "roomid") roomId = value.trim();
    else inviterId = value.trim();
  }

  if (!roomId && !raw.includes("=") && !raw.includes("/")) roomId = raw;
  if (!ROOM_ID_PATTERN.test(roomId))
    return { invitation: null, error: "邀请链接或房间 ID 格式无效" };
  if (inviterId && !USER_ID_PATTERN.test(inviterId)) {
    return { invitation: null, error: "邀请者 ID 格式无效" };
  }
  return { invitation: { roomId, inviterId }, error: "" };
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
