import { createOption } from "../core/option";
import type { NeteaseModule } from "../core/types";

const listenTogetherPlayCommandReport: NeteaseModule = (query, request) => {
  const commandInfo = {
    commandType: String(query.type ?? ""),
    progress: Math.max(0, Number(query.progressMs) || 0),
    playStatus: query.playing ? "PLAY" : "PAUSE",
    formerSongId: String(query.formerSongId ?? "0"),
    targetSongId: String(query.targetSongId ?? "0"),
    clientSeq: Number(query.clientSeq) || 0,
  };
  const data = {
    roomId: query.roomId,
    commandInfo: JSON.stringify(commandInfo),
  };
  return request("/api/listen/together/play/command/report", data, createOption(query, "eapi"));
};

export default listenTogetherPlayCommandReport;
