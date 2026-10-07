import { createOption } from "../core/option";
import type { NeteaseModule } from "../core/types";

// 实测：缺 inviteUids 会 400，带上（哪怕是空数组串）就 200。
// groupIds 同族，没有群时传空串
const listenTogetherMultiInvite: NeteaseModule = (query, request) => {
  const uids: string[] = Array.isArray(query.inviteUids)
    ? query.inviteUids.map((id) => String(id))
    : [];
  return request(
    "/api/listen/together/multi/invite",
    {
      roomId: query.roomId,
      inviteUids: uids.length ? `[${uids.join(",")}]` : "",
      groupIds: typeof query.groupIds === "string" ? query.groupIds : "",
    },
    createOption(query, "eapi"),
  );
};

export default listenTogetherMultiInvite;
