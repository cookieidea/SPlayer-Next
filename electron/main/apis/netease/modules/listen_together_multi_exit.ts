import { createOption } from "../core/option";
import type { NeteaseModule } from "../core/types";

const listenTogetherMultiExit: NeteaseModule = (query, request) => {
  return request(
    "/api/listen/together/multi/match/exit",
    { roomId: query.roomId },
    createOption(query, "eapi"),
  );
};

export default listenTogetherMultiExit;
