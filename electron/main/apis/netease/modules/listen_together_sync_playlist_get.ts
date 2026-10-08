import { createOption } from "../core/option";
import type { NeteaseModule } from "../core/types";

/**
 * 拉取房间快照：共享队列与最近一条播放命令。
 *
 * 响应形如 { data: { playlist: { playMode, randomList, displayList }, playCommand } }，
 * 其中 displayList 是对象形态（{changed,result,rcmdSongIds}），取 .result
 */
const listenTogetherSyncPlaylistGet: NeteaseModule = (query, request) => {
  return request(
    "/api/listen/together/sync/playlist/get",
    { roomId: query.roomId },
    createOption(query, "eapi"),
  );
};

export default listenTogetherSyncPlaylistGet;
