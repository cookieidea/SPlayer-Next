import { createOption } from "../core/option";
import type { NeteaseModule } from "../core/types";

const listenTogetherRoomCreate: NeteaseModule = (query, request) => {
  const data = { refer: "songplay_more" };
  return request("/api/listen/together/room/create", data, createOption(query, "eapi"));
};

export default listenTogetherRoomCreate;
