/**
 * 一起听：未读的一起听邀请（私信）
 *
 * 官方客户端靠私信投递邀请：`invite/message/send` 给被邀请人发一条 `resType: 23` 的
 * 私信，`generalMsg.nativeUrl` 里带 `orpheus://nm/play/listenTogether?roomId=…&inviterId=…`。
 * 这里把最近会话里的一起听私信取出来，供被邀请方直接接受——对方的分享链接未必存在，
 * 私信才是官方的投递通道。
 */

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
