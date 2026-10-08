import { createOption } from "../core/option";
import type { NeteaseModule } from "../core/types";

/** 告知服务端"本设备已接管这个房间"：确认重连后才调用 */
const listenTogetherDeviceReconnectNotice: NeteaseModule = (query, request) => {
  return request(
    "/api/listen/together/device/reconnect/notice",
    { roomId: query.roomId },
    createOption(query, "eapi"),
  );
};

export default listenTogetherDeviceReconnectNotice;
