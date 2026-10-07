import { createOption } from "../core/option";
import type { NeteaseModule } from "../core/types";

// 官方载荷含 playlistVersion：心跳是双人侧唯一带队列版本的上报点，
// 少了它服务端无法判断本地队列是否已过期
const listenTogetherHeartbeat: NeteaseModule = (query, request) => {
  const data: Record<string, unknown> = {
    roomId: query.roomId,
    songId: String(query.songId ?? "0"),
    playStatus: query.playing ? "PLAY" : "PAUSE",
    progress: Math.max(0, Number(query.progressMs) || 0),
  };
  if (Number.isFinite(Number(query.playlistVersion))) {
    data.playlistVersion = Number(query.playlistVersion);
  }
  return request("/api/listen/together/heartbeat", data, createOption(query, "eapi"));
};

export default listenTogetherHeartbeat;
