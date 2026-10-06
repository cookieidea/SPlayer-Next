import { createOption } from "../core/option";
import type { NeteaseModule } from "../core/types";

const listenTogetherRoomCheck: NeteaseModule = (query, request) => {
  return request(
    "/api/listen/together/room/check",
    { roomId: query.roomId },
    createOption(query, "eapi"),
  );
};

export default listenTogetherRoomCheck;
