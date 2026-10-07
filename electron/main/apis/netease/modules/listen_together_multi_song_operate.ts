import { createOption } from "../core/option";
import type { NeteaseModule } from "../core/types";

const listenTogetherMultiSongOperate: NeteaseModule = (query, request) => {
  return request(
    "/api/listen/together/multi/match/song/operate",
    {
      roomId: query.roomId,
      songId: String(query.songId ?? ""),
      bizId: Number(query.bizId) || 0,
      operate: Number(query.operate) || 0,
    },
    createOption(query, "eapi"),
  );
};

export default listenTogetherMultiSongOperate;
