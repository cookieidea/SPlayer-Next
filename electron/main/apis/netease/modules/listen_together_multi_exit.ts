import { createOption } from "../core/option";
import type { NeteaseModule } from "../core/types";

// 官方载荷含 exitType；实测带上它服务端才回结果页链接（orpheus）
const listenTogetherMultiExit: NeteaseModule = (query, request) => {
  return request(
    "/api/listen/together/multi/match/exit",
    {
      roomId: query.roomId,
      exitType:
        typeof query.exitType === "string" && query.exitType ? query.exitType : "NORMAL_END",
    },
    createOption(query, "eapi"),
  );
};

export default listenTogetherMultiExit;
