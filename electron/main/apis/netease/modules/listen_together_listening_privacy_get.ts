import { createOption } from "../core/option";
import type { NeteaseModule } from "../core/types";

const listenTogetherListeningPrivacyGet: NeteaseModule = (query, request) => {
  return request("/api/listen/together/listening/privacy/get", {}, createOption(query, "eapi"));
};

export default listenTogetherListeningPrivacyGet;
