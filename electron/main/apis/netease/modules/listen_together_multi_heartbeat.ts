import { createOption } from "../core/option";
import type { NeteaseModule } from "../core/types";

const listenTogetherMultiHeartbeat: NeteaseModule = (query, request) => {
  return request(
    "/api/listen/together/multi/match/heartbeat",
    { roomId: query.roomId },
    createOption(query, "eapi"),
  );
};

export default listenTogetherMultiHeartbeat;
