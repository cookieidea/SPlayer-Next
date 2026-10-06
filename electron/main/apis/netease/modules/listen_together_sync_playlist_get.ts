import { createOption } from "../core/option";
import type { NeteaseModule } from "../core/types";

const listenTogetherSyncPlaylistGet: NeteaseModule = (query, request) => {
  return request(
    "/api/listen/together/sync/playlist/get",
    { roomId: query.roomId },
    createOption(query, "eapi"),
  );
};

export default listenTogetherSyncPlaylistGet;
