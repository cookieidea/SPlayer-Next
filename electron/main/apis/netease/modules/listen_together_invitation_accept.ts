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
