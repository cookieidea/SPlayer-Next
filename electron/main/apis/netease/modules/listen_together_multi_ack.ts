import { createOption } from "../core/option";
import type { NeteaseModule } from "../core/types";

/**
 * 加入多人房 / 确认配对。
 *
 * payload 里的 checkToken（易盾风控令牌）是**必需**的：实测缺它一律 400，
 * 且同一枚令牌只能用一次（复用返回 491）。它由调用方每次现取现用
 */
const listenTogetherMultiAck: NeteaseModule = (query, request) => {
  return request(
    "/api/listen/together/multi/match/ack",
    {
      roomId: query.roomId,
      inviterUid: String(query.inviterUid ?? ""),
      deviceId: String(query.deviceId ?? ""),
      checkToken: String(query.checkToken ?? ""),
      // 配对确认才需要 agree；按邀请链接加入时服务端不看这个字段，
      // 所以只在显式给出时带上，避免改变已验证过的加入流程
      ...(typeof query.agree === "boolean" ? { agree: query.agree } : {}),
    },
    createOption(query, "eapi"),
  );
};

export default listenTogetherMultiAck;
