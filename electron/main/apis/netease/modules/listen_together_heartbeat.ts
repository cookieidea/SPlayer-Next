/**
 * 一起听：心跳
 *
 * params:
 * - roomId      房间 ID
 * - songId      当前歌曲 ID
 * - playing     是否播放中
 * - progressMs  播放位置（毫秒）
 *
 * 心跳同时承担"房间还在不在"的探活职责。
 */

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
