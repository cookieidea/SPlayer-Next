import { createOption } from "../core/option";
import type { NeteaseModule } from "../core/types";

const listenTogetherMultiAck: NeteaseModule = (query, request) => {
  return request(
    "/api/listen/together/multi/match/ack",
    {
      roomId: query.roomId,
      inviterUid: String(query.inviterUid ?? ""),
      deviceId: String(query.deviceId ?? ""),
      // 配对确认才需要 agree；按邀请链接加入时服务端不看这个字段，
      // 所以只在显式给出时带上，避免改变已验证过的加入流程
      ...(typeof query.agree === "boolean" ? { agree: query.agree } : {}),
    },
    createOption(query, "eapi"),
  );
};

export default listenTogetherMultiAck;
