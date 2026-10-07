import { createOption } from "../core/option";
import type { NeteaseModule } from "../core/types";

const listenTogetherSongMatchCancel: NeteaseModule = (query, request) => {
  return request("/api/listen/together/song/match/cancel", {}, createOption(query, "eapi"));
};

export default listenTogetherSongMatchCancel;
