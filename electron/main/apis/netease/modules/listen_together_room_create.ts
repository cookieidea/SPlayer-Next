import { createOption } from "../core/option";
import type { NeteaseModule } from "../core/types";

const listenTogetherRoomCreate: NeteaseModule = (query, request) => {
  const data: Record<string, unknown> = { refer: "songplay_more" };
  // 注意：roomType 对房型的作用尚未证实——此前"能看到 MULTI_MATCH_SONG"是因为
  // 当时人已在多人房里，room/create 直接返回了现有房间。待不在任何房间时复测
  if (typeof query.roomType === "string" && query.roomType) data.roomType = query.roomType;
  return request("/api/listen/together/room/create", data, createOption(query, "eapi"));
};

export default listenTogetherRoomCreate;
