import { createOption } from "../core/option";
import type { NeteaseModule } from "../core/types";

// 实测只有 listening_entrance 是合法 key，值域 0/1；
// 它决定账号对陌生人的可见性（读回时体现为 visibleStatus / entranceStatus）
const listenTogetherListeningPrivacyUpdate: NeteaseModule = (query, request) => {
  return request(
    "/api/listen/together/listening/privacy/update",
    {
      privacyKey: typeof query.privacyKey === "string" ? query.privacyKey : "listening_entrance",
      value: Number(query.value) ? 1 : 0,
    },
    createOption(query, "eapi"),
  );
};

export default listenTogetherListeningPrivacyUpdate;
