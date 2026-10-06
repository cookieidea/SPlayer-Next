/**
 * 一起听：上报播放命令
 *
 * params:
 * - roomId        房间 ID
 * - type          GOTO / NEXT / PREV / PLAY / PAUSE / PROGRESS
 * - progressMs    目标进度（毫秒）
 * - playing       发起者是否为播放态
 * - formerSongId  切歌前的歌曲 ID
 * - targetSongId  目标歌曲 ID
 * - clientSeq     本地序号
 *
 * playStatus 由 playing 推导；服务端把 progress 与 playStatus 一并保存，
 * 对端收到 PROGRESS 命令时忽略其中的 playStatus，只取进度。
 */

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
