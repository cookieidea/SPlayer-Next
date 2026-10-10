import { createOption } from "../core/option";
import type { NeteaseModule } from "../core/types";

/** 站内私信：一起听多人邀请用它投递 multishare 链接（官方 N1 分享同语义） */
const msgPrivateSend: NeteaseModule = (query, request) => {
  // 官方 j30/c.java：卡片私信 type="general" + generalInfo（JSON 字符串），
  // 纯文本 type="text" + msg。两者都走这一个端点
  const data: Record<string, unknown> = {
    type: query.type ?? "text",
    userIds: query.userIds,
  };
  if (query.msg !== undefined) data.msg = query.msg;
  if (query.generalInfo !== undefined) data.generalInfo = query.generalInfo;
  return request("/api/msg/private/send", data, createOption(query, "eapi"));
};

export default msgPrivateSend;
