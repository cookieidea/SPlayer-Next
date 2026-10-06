/**
 * 一起听：拉取房间快照
 *
 * params:
 * - roomId  房间 ID
 *
 * 响应：`{ code, data: { playlist: { playMode, randomList, displayList }, playCommand } }`
 * playMode 为随机模式时以 randomList 为准，否则取 displayList。
 */

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
