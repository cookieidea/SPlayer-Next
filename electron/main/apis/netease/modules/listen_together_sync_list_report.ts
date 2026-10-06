/**
 * 一起听：上报共享队列
 *
 * params:
 * - roomId    房间 ID
 * - userId    本机用户 ID
 * - version   队列版本号，每次替换自增
 * - songIds   歌曲 ID 数组（顺序即播放顺序）
 *
 * 服务端把队列整体替换，因此每次都要提交完整列表；两份列表同时下发，
 * 随机模式与顺序模式各读一份。
 */

import { createOption } from "../core/option";
import type { NeteaseModule } from "../core/types";

const listenTogetherSyncListReport: NeteaseModule = (query, request) => {
  const songIds: string[] = Array.isArray(query.songIds)
    ? query.songIds.map((id) => String(id))
    : [];
  const playlist = {
    commandType: "REPLACE",
    version: [{ userId: Number(query.userId) || 0, version: Number(query.version) || 0 }],
    anchorSongId: "",
    anchorPosition: -1,
    randomList: songIds,
    displayList: songIds,
  };
  const data = {
    roomId: query.roomId,
    playlistParam: JSON.stringify(playlist),
  };
  return request(
    "/api/listen/together/sync/list/command/report",
    data,
    createOption(query, "eapi"),
  );
};

export default listenTogetherSyncListReport;
