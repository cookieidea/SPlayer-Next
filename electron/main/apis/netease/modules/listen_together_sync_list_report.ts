import { createOption } from "../core/option";
import type { NeteaseModule } from "../core/types";

/**
 * 上报房间共享队列（整表替换）。
 *
 * 两个实测要点：
 * - displayList/randomList 必须是**纯数组**。对象形态（{changed,result,rcmdSongIds}）
 *   会被服务端整条拒收（result=false，队列不落地），表现为"进房后什么都不同步"。
 *   服务端返回时给的是对象形态，但上报必须用数组——两边不对称。
 * - playMode 必须随列表一起上报，否则对端拿不到当前播放模式
 */
const listenTogetherSyncListReport: NeteaseModule = (query, request) => {
  const songIds: string[] = Array.isArray(query.songIds)
    ? query.songIds.map((id) => String(id))
    : [];
  const randomIds: string[] = Array.isArray(query.randomSongIds)
    ? query.randomSongIds.map((id) => String(id))
    : [];
  const playlist = {
    commandType: "REPLACE",
    version: [{ userId: Number(query.userId) || 0, version: Number(query.version) || 0 }],
    displayList: songIds,
    randomList: randomIds.length ? randomIds : songIds,
    playMode: typeof query.playMode === "string" ? query.playMode : "",
  };
  return request(
    "/api/listen/together/sync/list/command/report",
    {
      roomId: query.roomId,
      playlistParam: JSON.stringify(playlist),
      clientSeq: Number(query.clientSeq) || 0,
    },
    createOption(query, "eapi"),
  );
};

export default listenTogetherSyncListReport;
