import { createOption } from "../core/option";
import type { NeteaseModule } from "../core/types";

const listenTogetherSyncListReport: NeteaseModule = (query, request) => {
  const songIds: string[] = Array.isArray(query.songIds)
    ? query.songIds.map((id) => String(id))
    : [];
  const randomIds: string[] = Array.isArray(query.randomSongIds)
    ? query.randomSongIds.map((id) => String(id))
    : [];
  const asList = (ids: string[]) => ({ changed: true, result: ids, rcmdSongIds: [] });
  const playlist = {
    commandType: "REPLACE",
    version: [{ userId: Number(query.userId) || 0, version: Number(query.version) || 0 }],
    displayList: asList(songIds),
    randomList: randomIds.length ? asList(randomIds) : null,
    playMode: typeof query.playMode === "string" ? query.playMode : "",
    listMode: "",
    listModeParam: null,
    replace: true,
  };
  return request(
    "/api/listen/together/sync/list/command/report",
    { roomId: query.roomId, playlistParam: JSON.stringify(playlist) },
    createOption(query, "eapi"),
  );
};

export default listenTogetherSyncListReport;
