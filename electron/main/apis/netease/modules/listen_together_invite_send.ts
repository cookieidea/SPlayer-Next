import { createOption } from "../core/option";
import type { NeteaseModule } from "../core/types";

const listenTogetherInviteSend: NeteaseModule = (query, request) => {
  // 官方 w(roomId, acceptorId, roomInfo.ltType)：多人大厅传 2。
  // 双人邀请不传（服务端按房型默认投递），只有多人显式带上，
  // 否则同一条链路会把双人邀请错标成多人
  const data: Record<string, unknown> = {
    roomId: query.roomId,
    acceptorId: query.acceptorId,
  };
  if (query.ltType !== undefined) data.ltType = query.ltType;
  return request("/api/listen/together/invite/message/send", data, createOption(query, "eapi"));
};

export default listenTogetherInviteSend;
