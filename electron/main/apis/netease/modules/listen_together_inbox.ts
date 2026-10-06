import { createOption } from "../core/option";
import type { NeteaseModule } from "../core/types";

const listenTogetherInbox: NeteaseModule = (query, request) => {
  const data = {
    limit: query.limit ?? 20,
    offset: query.offset ?? 0,
  };
  return request("/api/msg/private/users", data, createOption(query, "eapi"));
};

export default listenTogetherInbox;
