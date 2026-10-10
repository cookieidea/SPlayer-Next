import { createOption } from "../core/option";
import type { NeteaseModule } from "../core/types";

/** 站内私信：一起听多人邀请用它投递 multishare 链接（官方 N1 分享同语义） */
const msgPrivateSend: NeteaseModule = (query, request) => {
  return request(
    "/api/msg/private/send",
    {
      type: "text",
      msg: query.msg,
      userIds: query.userIds,
    },
    createOption(query, "eapi"),
  );
};

export default msgPrivateSend;
