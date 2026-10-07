import { createOption } from "../core/option";
import type { NeteaseModule } from "../core/types";

// 实测：多人匹配必须带 checkToken，且它要传字符串 "null"（空串会被拒并返回 token校验失败[2020]）
const listenTogetherMultiMatch: NeteaseModule = (query, request) => {
  return request(
    "/api/listen/together/multi/match",
    {
      songId: String(query.songId ?? "0"),
      checkToken: typeof query.checkToken === "string" ? query.checkToken : "null",
    },
    createOption(query, "eapi"),
  );
};

export default listenTogetherMultiMatch;
