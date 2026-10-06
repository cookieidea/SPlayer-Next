import { createOption } from "../core/option";
import type { NeteaseModule } from "../core/types";

const listenTogetherInviteSend: NeteaseModule = (query, request) => {
  const data = {
    roomId: query.roomId,
    acceptorId: query.acceptorId,
  };
  return request("/api/listen/together/invite/message/send", data, createOption(query, "eapi"));
};

export default listenTogetherInviteSend;
