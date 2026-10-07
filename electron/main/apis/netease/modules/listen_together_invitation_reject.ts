import { createOption } from "../core/option";
import type { NeteaseModule } from "../core/types";

const listenTogetherInvitationReject: NeteaseModule = (query, request) => {
  return request(
    "/api/listen/together/invitation/reject",
    { roomId: query.roomId },
    createOption(query, "eapi"),
  );
};

export default listenTogetherInvitationReject;
