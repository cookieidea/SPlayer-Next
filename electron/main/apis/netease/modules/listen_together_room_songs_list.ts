import { createOption } from "../core/option";
import type { NeteaseModule } from "../core/types";

const listenTogetherRoomSongsList: NeteaseModule = (query, request) => {
  return request(
    "/api/listen/together/room/songs/list",
    { roomId: query.roomId },
    createOption(query, "eapi"),
  );
};

export default listenTogetherRoomSongsList;
