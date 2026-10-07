import { createOption } from "../core/option";
import type { NeteaseModule } from "../core/types";

const listenTogetherRoomCreate: NeteaseModule = (query, request) => {
  const data: Record<string, unknown> = { refer: "songplay_more" };
  // 实测：带 roomType=MULTI_MATCH_SONG 建出的是多人房（响应 roomType 随之改变），
  // 不传或传其他值都是双人房 FRIEND
  if (typeof query.roomType === "string" && query.roomType) data.roomType = query.roomType;
  return request("/api/listen/together/room/create", data, createOption(query, "eapi"));
};

export default listenTogetherRoomCreate;
