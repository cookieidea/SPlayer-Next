import { createOption } from "../core/option";
import type { NeteaseModule } from "../core/types";

// 只建双人房。多人房在本项目里只支持加入：官方路径是
// 双人房 → 加人 → change-multi/check 通过 → 转多人，
// 而该检查要求房内有支持多人的客户端，PC 端不满足
const listenTogetherRoomCreate: NeteaseModule = (query, request) => {
  return request(
    "/api/listen/together/room/create",
    { refer: "songplay_more" },
    createOption(query, "eapi"),
  );
};

export default listenTogetherRoomCreate;
