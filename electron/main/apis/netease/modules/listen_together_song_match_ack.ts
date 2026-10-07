import { createOption } from "../core/option";
import type { NeteaseModule } from "../core/types";

const listenTogetherSongMatchAck: NeteaseModule = (query, request) => {
  return request(
    "/api/listen/together/song/match/ack",
    { roomId: query.roomId, agree: query.agree !== false },
    createOption(query, "eapi"),
  );
};

export default listenTogetherSongMatchAck;
