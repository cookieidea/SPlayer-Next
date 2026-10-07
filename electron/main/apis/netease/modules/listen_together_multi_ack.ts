import { createOption } from "../core/option";
import type { NeteaseModule } from "../core/types";

const listenTogetherMultiAck: NeteaseModule = (query, request) => {
  return request(
    "/api/listen/together/multi/match/ack",
    {
      roomId: query.roomId,
      inviterUid: String(query.inviterUid ?? ""),
      deviceId: String(query.deviceId ?? ""),
    },
    createOption(query, "eapi"),
  );
};

export default listenTogetherMultiAck;
