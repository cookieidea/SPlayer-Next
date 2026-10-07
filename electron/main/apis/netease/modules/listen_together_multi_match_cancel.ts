import { createOption } from "../core/option";
import type { NeteaseModule } from "../core/types";

const listenTogetherMultiMatchCancel: NeteaseModule = (query, request) => {
  return request("/api/listen/together/multi/match/cancel", {}, createOption(query, "eapi"));
};

export default listenTogetherMultiMatchCancel;
