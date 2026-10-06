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
