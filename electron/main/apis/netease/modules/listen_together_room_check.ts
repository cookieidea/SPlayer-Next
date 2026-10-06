/**
 * 一起听：检查房间是否可加入
 *
 * params:
 * - roomId  房间 ID
 *
 * 响应：`{ code, data: { joinable } }`
 */

import { createOption } from "../core/option";
import type { NeteaseModule } from "../core/types";

const listenTogetherRoomCheck: NeteaseModule = (query, request) => {
  return request(
    "/api/listen/together/room/check",
    { roomId: query.roomId },
    createOption(query, "eapi"),
  );
};

export default listenTogetherRoomCheck;
