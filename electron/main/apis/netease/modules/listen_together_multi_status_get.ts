import { createOption } from "../core/option";
import type { NeteaseModule } from "../core/types";

const listenTogetherMultiStatusGet: NeteaseModule = (query, request) => {
  return request("/api/listen/together/multi/match/status/get", {}, createOption(query, "eapi"));
};

export default listenTogetherMultiStatusGet;
