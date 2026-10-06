/**
 * 一起听：接受邀请加入房间
 *
 * params:
 * - roomId     房间 ID
 * - inviterId  邀请者用户 ID
 *
 * 响应：`{ code, data: { roomInfo } }`
 */

import { createOption } from "../core/option";
import type { NeteaseModule } from "../core/types";

const listenTogetherInvitationAccept: NeteaseModule = (query, request) => {
  const data = {
    refer: "inbox_invite",
    roomId: query.roomId,
    inviterId: query.inviterId ?? "0",
  };
  return request("/api/listen/together/play/invitation/accept", data, createOption(query, "eapi"));
};

export default listenTogetherInvitationAccept;
