import { createOption } from "../core/option";
import type { NeteaseModule } from "../core/types";

const listenTogetherHeartbeat: NeteaseModule = (query, request) => {
  const data = {
    roomId: query.roomId,
    songId: String(query.songId ?? "0"),
    playStatus: query.playing ? "PLAY" : "PAUSE",
    progress: Math.max(0, Number(query.progressMs) || 0),
  };
  return request("/api/listen/together/heartbeat", data, createOption(query, "eapi"));
};

export default listenTogetherHeartbeat;
