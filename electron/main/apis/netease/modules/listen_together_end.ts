import { createOption } from "../core/option";
import type { NeteaseModule } from "../core/types";

const listenTogetherEnd: NeteaseModule = (query, request) => {
  return request(
    "/api/listen/together/end/v2",
    { roomId: query.roomId },
    createOption(query, "eapi"),
  );
};

export default listenTogetherEnd;
