import { createOption } from "../core/option";
import type { NeteaseModule } from "../core/types";

// 官方载荷含 exitType。对照实测：带与不带响应完全相同（都含结果页 orpheus），
// 所以它只是让意图显式（用户主动退出），不影响返回内容
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
