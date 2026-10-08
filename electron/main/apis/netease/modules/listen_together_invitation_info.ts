import { createOption } from "../core/option";
import type { NeteaseModule } from "../core/types";

/**
 * 拉取"有没有人邀请我"。
 *
 * 实测是增量轮询设计：传入已知的 invitationVersion，服务端每次把它 +1 返回，
 * 有新邀请时带 display:true 与 roomId。官方靠云信 IM 推送获知，我们没接 IM，
 * 用这个端点轮询即可拿到同样的信息
 */
const listenTogetherInvitationInfo: NeteaseModule = (query, request) => {
  return request(
    "/api/listen/together/invitation-info/get",
    { invitationVersion: Number(query.invitationVersion) || 0 },
    createOption(query, "eapi"),
  );
};

export default listenTogetherInvitationInfo;
