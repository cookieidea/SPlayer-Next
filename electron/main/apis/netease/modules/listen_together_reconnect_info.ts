import { createOption } from "../core/option";
import type { NeteaseModule } from "../core/types";

/**
 * 查询是否需要"多设备接管"。
 *
 * 同一账号在另一台设备进房时，服务端会在这里给出 LTReconnectInfo
 * （roomId / canReconnect / reconnectDeviceName 等），当前设备据此提示用户接管。
 * 没有重连需求时返回空对象
 */
const listenTogetherReconnectInfo: NeteaseModule = (query, request) => {
  return request("/api/listen/together/restore/reconnect/info", {}, createOption(query, "eapi"));
};

export default listenTogetherReconnectInfo;
