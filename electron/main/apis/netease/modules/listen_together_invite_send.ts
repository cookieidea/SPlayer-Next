/**
 * 一起听：向指定用户发送邀请
 *
 * params:
 * - roomId      房间 ID
 * - acceptorId  被邀请人用户 ID
 *
 * 响应：`{ code: 200, data: { result: true, message } }`
 *
 * 该接口不出现在任何公开 API 包装里（api-enhanced 的 440 个 module 中 `invite` 命中 0），
 * 路径与参数名来自官方客户端 bundle 的 `apiListenTogetherInviteMessageSend`，并已实测通过。
 * 只需 roomId + acceptorId 两个字段，传其它参数名会返回「参数错误」。
 */

import { createOption } from "../core/option";
import type { NeteaseModule } from "../core/types";

const listenTogetherInviteSend: NeteaseModule = (query, request) => {
  const data = {
    roomId: query.roomId,
    acceptorId: query.acceptorId,
  };
  return request("/api/listen/together/invite/message/send", data, createOption(query, "eapi"));
};

export default listenTogetherInviteSend;
