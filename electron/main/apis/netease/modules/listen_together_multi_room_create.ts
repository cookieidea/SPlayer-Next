import { createOption } from "../core/option";
import type { NeteaseModule } from "../core/types";

/**
 * 多人房建房。实测只要两个参数：
 *   type=1 + songId 必须是真实可播的歌曲
 * 传 songId=0 会返回 failedType=MULTI_SONG_NOT_SATISFIED（歌曲条件不满足）。
 * 成功后响应同时兼容 roomInfo 与 multiLtRoomSnapshot 两种包裹
 */
const listenTogetherMultiRoomCreate: NeteaseModule = (query, request) => {
  const data: Record<string, unknown> = {
    type: Number(query.type) || 1,
    songId: String(query.songId ?? "0"),
  };
  if (typeof query.from === "string" && query.from) data.from = query.from;
  return request("/api/listen/together/multi/room/create", data, createOption(query, "eapi"));
};

export default listenTogetherMultiRoomCreate;
