/**
 * 一起听：当前房间状态
 *
 * 响应：`{ code, data: { inRoom, status, roomInfo } }`
 * 只有 web 端也认这条接口，因此走 weapi。
 */

import { createOption } from "../core/option";
import type { NeteaseModule } from "../core/types";

const listenTogetherStatus: NeteaseModule = (query, request) => {
  return request("/api/listen/together/status/get", {}, createOption(query, "weapi"));
};

export default listenTogetherStatus;
