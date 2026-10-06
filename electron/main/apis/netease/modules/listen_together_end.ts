/**
 * 一起听：结束房间
 *
 * params:
 * - roomId  房间 ID
 *
 * 响应：`{ code }`
 */

import { createOption } from "../core/option";
import type { NeteaseModule } from "../core/types";

const listenTogetherEnd: NeteaseModule = (query, request) => {
  return request(
    "/api/listen/together/end/v2",
    { roomId: query.roomId },
    createOption(query, "eapi"),
  );
};

export default listenTogetherEnd;
