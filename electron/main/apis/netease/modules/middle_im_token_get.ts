import { createOption } from "../core/option";
import type { NeteaseModule } from "../core/types";

/**
 * 取云信（NIM）实时通道凭据。
 *
 * 一起听的播放指令在官方客户端里走云信聊天室推送；进聊天室需要 accId 与 token，
 * 这对凭据由这个未加密的 GET 端点下发（bizName 指明用途，实测 music_listenTogether 可用）。
 * 返回 { uid, accId, token }，其中 accId 就是当前账号的 userId。
 * 走 api 模式：实测该端点就是普通 GET + Cookie，没有 weapi/eapi 那层加密
 */
const middleImTokenGet: NeteaseModule = (query, request) => {
  return request(
    "/api/middle/im/token/get",
    { bizName: typeof query.bizName === "string" && query.bizName ? query.bizName : "" },
    createOption(query, "api"),
  );
};

export default middleImTokenGet;
