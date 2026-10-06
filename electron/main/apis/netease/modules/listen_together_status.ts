import { createOption } from "../core/option";
import type { NeteaseModule } from "../core/types";

const listenTogetherStatus: NeteaseModule = (query, request) => {
  return request("/api/listen/together/status/get", {}, createOption(query, "weapi"));
};

export default listenTogetherStatus;
